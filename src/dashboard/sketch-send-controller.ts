/**
 * RFC-010 §13 Q3 — the PURE (DOM-free) controller for the sketch canvas chrome:
 * dirty-state tracking, export `requestId` correlation, and reset semantics.
 *
 * `mountSketchCanvas` (the DOM layer) owns the iframe + the elements; it delegates
 * the STATE DECISIONS to this controller so they are unit-testable without a DOM or
 * a real iframe (the repo is zero-dep — no jsdom). The controller never touches the
 * DOM: it returns intents (e.g. "the edited marker should now be visible") that the
 * DOM layer applies.
 *
 * Invariants enforced here (the Q3 spec):
 *   - Send is ALWAYS actionable (§1.1a). `dirty` drives ONLY the `· edited` marker,
 *     never Send's enabled state. There is no API on this controller that gates Send.
 *   - `requestId` correlation (§13 Q3): a stale export-response for an old request is
 *     IGNORED; only the matching, still-pending request resolves.
 *   - `reset` discards staged edits → the marker clears.
 */

/** An export awaiting its `sketch:export-response`, correlated by `requestId`. */
export type PendingExport<T> = {
  readonly requestId: string;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
};

/**
 * Tracks dirty state + in-flight exports for one mounted canvas. Pure: no DOM, no
 * timers (the DOM layer owns the safety timeout). One instance per `mountSketchCanvas`.
 */
export class SketchSendController<T> {
  /** True once the operator has edited since the last load/reset. Drives the marker. */
  #dirty = false;
  /** In-flight exports by requestId (FIFO not assumed — keyed lookup). */
  readonly #pending = new Map<string, PendingExport<T>>();
  /** Monotonic sequence for fresh requestIds. */
  #seq = 0;

  /** Send is ALWAYS enabled (§1.1a). This is a constant, not state — it never gates. */
  readonly sendAlwaysEnabled = true as const;

  /** Current dirty state (drives the `· edited` marker visibility). */
  get dirty(): boolean {
    return this.#dirty;
  }

  /** Count of in-flight exports (for tests / assertions). */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /**
   * Apply an inbound `sketch:dirty` from the iframe. Returns whether the `· edited`
   * marker should be VISIBLE (= the new dirty state). The iframe is the source of
   * truth for dirtiness (real store-change events, not a guess).
   */
  applyDirty(dirty: boolean): { markerVisible: boolean } {
    this.#dirty = dirty;
    return { markerVisible: dirty };
  }

  /**
   * Reset: discard staged edits. The marker clears immediately on the parent side
   * (the iframe also re-renders the original doc and re-confirms dirty:false). Returns
   * the marker intent so the DOM layer hides it.
   */
  reset(): { markerVisible: boolean } {
    this.#dirty = false;
    return { markerVisible: false };
  }

  /**
   * Register a new export request. Returns the fresh `requestId` to put on the wire.
   * The promise resolves/rejects when (and only when) a response with THIS id arrives.
   */
  registerExport(resolve: (value: T) => void, reject: (error: Error) => void): string {
    const requestId = `exp-${this.#seq++}`;
    this.#pending.set(requestId, { requestId, resolve, reject });
    return requestId;
  }

  /**
   * Handle an export-response correlated by `requestId`. A STALE / unknown id (an old
   * request already settled, or one this controller never issued) is IGNORED — it
   * does NOT resolve the wrong promise (§13 Q3 requestId correlation). Returns
   * whether a pending request was matched + settled.
   */
  settleExport(requestId: string, outcome: { ok: true; value: T } | { ok: false; error: Error }): { matched: boolean } {
    const pending = this.#pending.get(requestId);
    if (!pending) {
      return { matched: false };
    }
    this.#pending.delete(requestId);
    if (outcome.ok) {
      pending.resolve(outcome.value);
    } else {
      pending.reject(outcome.error);
    }
    return { matched: true };
  }

  /** Time out + reject a still-pending request (the DOM layer's safety timeout). */
  timeoutExport(requestId: string, error: Error): { matched: boolean } {
    const pending = this.#pending.get(requestId);
    if (!pending) {
      return { matched: false };
    }
    this.#pending.delete(requestId);
    pending.reject(error);
    return { matched: true };
  }
}
