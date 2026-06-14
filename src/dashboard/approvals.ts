/**
 * Approvals — master-detail review surface.
 *
 * Loads /api/approvals into the master list, sorted with pending sticky on
 * top and recent (terminal) underneath. Clicking a row loads its detail
 * pane on the right. Approve / Reject / Amend / Withdraw call the existing
 * /api/approvals/:id/set and /api/approvals/:id/withdraw endpoints.
 *
 * Amend opens a side-by-side payload editor as an overlay; submitting POSTs
 * { state: 'amended', payload } and broadcasts via WS. Amending IS the
 * decision: 'amended' is a terminal state (approved with the modified
 * payload), so there is no follow-up approve step — the server 409s any
 * further setState.
 *
 * Subscribes to `ws:approval_changed` (existing WS event) so live updates
 * reflect on both master and detail panes.
 */
import type { ApprovalRow, ApprovalState } from '../shared/types.ts';
import { state, on, authHeaders } from './state.ts';
import { registerRoute } from './routing.ts';
import { escapeHtml, toast } from './util.ts';

let approvals: ApprovalRow[] = [];
let selectedId: string | null = null;
const detachers: Array<() => void> = [];

export function setupApprovals(): void {
  registerRoute('approvals', render);
}

function render(root: HTMLElement): void {
  root.innerHTML = `
    <div class="ap-page" style="height: 100vh;">
      <div class="ap-master">
        <div class="ap-master-hdr">
          <h1 class="title">Approvals <span class="ct" data-summary>—</span></h1>
        </div>
        <div class="ap-chips">
          <span class="row-label">State</span>
          <span class="chip on urgent" data-fstate="pending">Pending <span class="ct" data-c-pending>0</span></span>
          <span class="chip" data-fstate="approved">Approved <span class="ct" data-c-approved>0</span></span>
          <span class="chip" data-fstate="rejected">Rejected <span class="ct" data-c-rejected>0</span></span>
          <span class="chip" data-fstate="amended">Amended <span class="ct" data-c-amended>0</span></span>
          <span class="chip" data-fstate="all">All <span class="ct" data-c-all>0</span></span>
        </div>
        <div class="ap-list" data-list>Loading…</div>
        <div class="ap-master-foot" data-foot>—</div>
      </div>
      <div class="ap-detail" data-detail>
        <div style="padding: 40px 32px; color: var(--ink-3); font-size: 13px; font-style: italic;">
          Select an approval on the left to review it.
        </div>
      </div>
    </div>
  `;

  void loadAll();

  detachers.push(on('ws:approval_changed', () => void loadAll()));
  detachers.push(on('route-changed', (r) => {
    if ((r as { kind?: string })?.kind !== 'approvals') teardown();
  }));
}

function teardown(): void {
  while (detachers.length) {
    const fn = detachers.pop();
    try { fn?.(); } catch {}
  }
  approvals = [];
  selectedId = null;
  document.body.classList.remove('ap-show-detail');
}

/* ── master ───────────────────────────────────────────────────────── */

let activeFilter: ApprovalState | 'all' = 'pending';

async function loadAll(): Promise<void> {
  try {
    const res = await fetch('/api/approvals', { headers: authHeaders() });
    if (!res.ok) {
      const list = document.querySelector<HTMLElement>('[data-list]');
      if (list) list.innerHTML = `<div class="ap-empty" style="padding:24px;color:var(--ink-3);font-style:italic;">Failed to load approvals.</div>`;
      return;
    }
    approvals = await res.json() as ApprovalRow[];
    renderMaster();
    if (selectedId) {
      void loadDetail(selectedId);
    }
  } catch {
    const list = document.querySelector<HTMLElement>('[data-list]');
    if (list) list.innerHTML = `<div style="padding:24px;color:var(--ink-3);font-style:italic;">Network error.</div>`;
  }
}

function renderMaster(): void {
  // counts
  const counts: Record<string, number> = { pending: 0, approved: 0, rejected: 0, amended: 0, withdrawn: 0 };
  for (const a of approvals) counts[a.state] = (counts[a.state] ?? 0) + 1;
  setText('[data-c-pending]', String(counts['pending'] ?? 0));
  setText('[data-c-approved]', String(counts['approved'] ?? 0));
  setText('[data-c-rejected]', String(counts['rejected'] ?? 0));
  setText('[data-c-amended]', String(counts['amended'] ?? 0));
  setText('[data-c-all]', String(approvals.length));
  setText('[data-summary]', `${approvals.length} · ${counts['pending'] ?? 0} pending`);
  setText('[data-foot]', `${approvals.length} total · ${counts['pending'] ?? 0} pending`);

  // chips
  document.querySelectorAll<HTMLElement>('[data-fstate]').forEach((el) => {
    el.classList.toggle('on', el.dataset['fstate'] === activeFilter);
    el.onclick = () => {
      activeFilter = (el.dataset['fstate'] as ApprovalState | 'all') ?? 'pending';
      renderMaster();
    };
  });

  // list
  const list = document.querySelector<HTMLElement>('[data-list]');
  if (!list) return;
  const visible = approvals.filter((a) => activeFilter === 'all' ? true : a.state === activeFilter);
  visible.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (visible.length === 0) {
    list.innerHTML = `<div style="padding:24px;color:var(--ink-3);font-style:italic;">No approvals match this filter.</div>`;
    return;
  }
  list.innerHTML = visible.map(itemHtml).join('');
  list.querySelectorAll<HTMLElement>('[data-id]').forEach((el) => {
    el.addEventListener('click', () => {
      selectedId = el.dataset['id']!;
      // Refresh selection styling
      list.querySelectorAll('.ap-item').forEach((n) => n.classList.remove('active'));
      el.classList.add('active');
      // On mobile, switch to detail-only view.
      document.body.classList.add('ap-show-detail');
      void loadDetail(selectedId);
    });
  });
}

function itemHtml(a: ApprovalRow): string {
  const short = a.id.length > 10 ? `${a.id.slice(0, 6)}…${a.id.slice(-2)}` : a.id;
  const fromAgent = a.requesterAddr.replace(/^agent:/, '');
  return `
    <div class="ap-item ${a.state} ${a.id === selectedId ? 'active' : ''}" data-id="${escapeHtml(a.id)}">
      <span class="dot"></span>
      <div class="main">
        <div class="id">${escapeHtml(short)}</div>
        <div class="channel">${escapeHtml(a.channel)}</div>
        <div class="req">
          ${a.state === 'pending' ? `from <span class="agent">${escapeHtml(fromAgent)}</span>` : `<span class="state-tag">${a.state}</span> · <span class="agent">${escapeHtml(fromAgent)}</span>`}
        </div>
      </div>
      <div class="age">${ago(a.updatedAt || a.createdAt)}</div>
    </div>
  `;
}

/* ── detail ────────────────────────────────────────────────────────── */

async function loadDetail(id: string): Promise<void> {
  const pane = document.querySelector<HTMLElement>('[data-detail]');
  if (!pane) return;
  pane.innerHTML = `<div style="padding:40px 32px;color:var(--ink-3);font-style:italic;">Loading…</div>`;

  try {
    const res = await fetch(`/api/approvals/${encodeURIComponent(id)}`, { headers: authHeaders() });
    if (!res.ok) {
      pane.innerHTML = `<div style="padding:40px 32px;color:var(--brick);">Failed to load.</div>`;
      return;
    }
    const a = await res.json() as ApprovalRow;
    renderDetail(a);
  } catch {
    pane.innerHTML = `<div style="padding:40px 32px;color:var(--brick);">Network error.</div>`;
  }
}

function renderDetail(a: ApprovalRow): void {
  const pane = document.querySelector<HTMLElement>('[data-detail]');
  if (!pane) return;
  const fromAgent = a.requesterAddr.replace(/^agent:/, '');
  const payloadFmt = formatPayload(a.payload);
  const isTerminal = a.state !== 'pending';
  pane.innerHTML = `
    <div class="ap-detail-hdr">
      <button class="ap-detail-back" data-back style="display:none;">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="10 3 5 8 10 13"/></svg>
        Back to list
      </button>
      <div class="crumb">
        <span class="chan">${escapeHtml(a.channel)}</span>
        <span class="sep">/</span>
        <span>request from ${escapeHtml(fromAgent)}</span>
      </div>
      <div class="id-row">
        <span class="id">${escapeHtml(a.id)}</span>
        <span class="state ${a.state}">● ${a.state}</span>
      </div>
      <div class="meta-row">
        <span class="item"><span class="lbl">Requester</span><span class="val"><span class="plum" style="color:var(--plum)">${escapeHtml(fromAgent)}</span></span></span>
        <span class="item"><span class="lbl">Created</span><span class="val">${ago(a.createdAt)}</span></span>
        <span class="item"><span class="lbl">Updated</span><span class="val">${a.updatedAt && a.updatedAt !== a.createdAt ? ago(a.updatedAt) : '—'}</span></span>
        ${a.decidedBy ? `<span class="item"><span class="lbl">Decided by</span><span class="val">${escapeHtml(a.decidedBy)}</span></span>` : ''}
      </div>
    </div>
    <div class="ap-detail-body">
      <div class="ap-section-hd">Payload <span class="meta">application/json</span></div>
      <div class="ap-payload" data-payload>${payloadFmt}</div>
      ${a.amendmentsJson ? `<div class="ap-section-hd" style="margin-top:18px;">Amendments</div><div class="ap-payload">${formatPayload(a.amendmentsJson)}</div>` : ''}
      <div class="ap-section-hd" style="margin-top:18px;">Decision</div>
      <div class="ap-actions">
        ${isTerminal ? `
          <span style="font-size:12.5px;color:var(--ink-3);font-style:italic;">This approval is in a terminal state (${a.state}).</span>
        ` : `
          <button class="btn primary" data-decide="approved">Approve</button>
          <button class="btn danger" data-decide="rejected">Reject</button>
          <button class="btn" data-decide="amended">Amend &amp; approve…</button>
          <button class="btn ghost" data-withdraw>Withdraw</button>
          <span style="margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:11.5px;color:var(--ink-3);">
            also notify
            <select data-notify-agent style="font-family:var(--mono);font-size:12px;background:transparent;border:1px solid var(--rule);padding:3px 8px;border-radius:3px;color:var(--ink-2);">
              <option value="">(none)</option>
              ${state.agents.map((ag) => `<option value="${escapeHtml(ag.name)}">${escapeHtml(ag.name)}</option>`).join('')}
            </select>
          </span>
        `}
      </div>
    </div>
  `;

  if (!isTerminal) {
    pane.querySelectorAll<HTMLElement>('[data-decide]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const newState = btn.dataset['decide'] as 'approved' | 'rejected' | 'amended';
        const notifyAgent = pane.querySelector<HTMLSelectElement>('[data-notify-agent]')?.value || null;
        if (newState === 'amended') openAmendModal(a, notifyAgent);
        else void decide(a.id, newState, undefined, notifyAgent);
      });
    });
    pane.querySelector<HTMLElement>('[data-withdraw]')?.addEventListener('click', () => {
      if (!window.confirm('Withdraw this approval?')) return;
      const notifyAgent = pane.querySelector<HTMLSelectElement>('[data-notify-agent]')?.value || null;
      void withdraw(a.id, notifyAgent);
    });
  }

  // Mobile-only back button — visible when in stacked-detail mode.
  const backBtn = pane.querySelector<HTMLElement>('[data-back]');
  if (backBtn) {
    const isMobile = () => window.matchMedia('(max-width: 768px)').matches;
    if (isMobile()) backBtn.style.display = 'inline-flex';
    backBtn.addEventListener('click', () => {
      document.body.classList.remove('ap-show-detail');
      selectedId = null;
    });
  }
}

/**
 * 'ok' = decision recorded; 'terminal' = a 409 said someone already decided
 * (pane is force-refreshed); 'failed' = validation/network error — the caller
 * may keep its UI (e.g. the amend modal) open so operator input isn't lost.
 */
type DecideResult = 'ok' | 'terminal' | 'failed';

async function decide(
  id: string,
  newState: 'approved' | 'rejected' | 'amended',
  payload?: string,
  notifyAgent?: string | null,
): Promise<DecideResult> {
  try {
    const body: Record<string, unknown> = { state: newState };
    if (payload !== undefined) body['payload'] = payload;
    const res = await fetch(`/api/approvals/${encodeURIComponent(id)}/set`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      if (res.status === 409) {
        // Approval states are one-shot terminal; a 409 means another decision
        // already landed. Refresh so the pane re-renders the terminal state.
        showToast('Already decided — refreshing', 'error');
        void loadAll();
        return 'terminal';
      }
      const b = await res.json().catch(() => null);
      showToast(b?.error ?? 'Decision failed', 'error');
      return 'failed';
    }
    if (notifyAgent) await notifyAgentOfDecision(notifyAgent, id, newState);
    void loadAll();
    return 'ok';
  } catch {
    showToast('Network error', 'error');
    return 'failed';
  }
}

async function withdraw(id: string, notifyAgent?: string | null): Promise<void> {
  try {
    const res = await fetch(`/api/approvals/${encodeURIComponent(id)}/withdraw`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => null);
      showToast(b?.error ?? 'Withdraw failed', 'error');
      return;
    }
    if (notifyAgent) await notifyAgentOfDecision(notifyAgent, id, 'withdrawn');
    void loadAll();
  } catch {
    showToast('Network error', 'error');
  }
}

/**
 * Send the agent a chat message + tmux paste announcing the decision.
 * Used when the operator picks "also notify <agent>" on the decision row,
 * so the agent learns about state changes for approvals whose requester
 * isn't itself.
 *
 * The dropdown defaults to "(none)": the orchestrator already auto-notifies
 * the requester on every state change (ApprovalService.notifyRequester), so
 * preselecting the requester here sent a second, dashboard-attributed copy
 * of the same decision. "Also notify" is an explicit extra, never a default.
 */
async function notifyAgentOfDecision(agentName: string, approvalId: string, newState: string): Promise<void> {
  const stateLabel: Record<string, string> = {
    approved: 'APPROVED (terminal — no further state changes)',
    rejected: 'REJECTED (terminal — no further state changes)',
    amended:  'APPROVED WITH AMENDMENTS (terminal — payload was modified; use the new payload, do not wait for a separate approval)',
    withdrawn: 'WITHDRAWN by requester (terminal — no action needed)',
  };
  const envelope = `Approval ${approvalId} ${stateLabel[newState] ?? newState}. Run \`collab approval get ${approvalId}\` for details.`;
  try {
    await fetch('/api/dashboard/send', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        agent: `agent:${agentName}`,
        message: envelope,
        topic: 'approval',
      }),
    });
  } catch {
    showToast(`Notify @${agentName} failed`, 'error');
  }
}

/* ── amend modal ───────────────────────────────────────────────────── */

function openAmendModal(a: ApprovalRow, notifyAgent?: string | null): void {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,24,28,0.18);z-index:50;display:flex;align-items:center;justify-content:center;padding:24px;';
  overlay.innerHTML = `
    <div class="amend-modal" style="position:static;width:880px;max-width:95vw;max-height:90vh;overflow:hidden;display:flex;flex-direction:column;">
      <div class="amh">
        <div class="ttl">Amend &amp; approve<span class="id">${escapeHtml(a.id)}</span></div>
        <div class="lead">
          Amending <em>is</em> the decision: submitting approves the request with the
          modified payload and the approval becomes terminal (<em>amended</em> = approved
          with amendments — no separate approve step follows). Edit the right side.
          JSON is preferred but any text is accepted.
        </div>
      </div>
      <div class="amb" style="overflow-y:auto;">
        <div class="pair">
          <div class="col">
            <div class="lbl">Original <span class="right" style="color: var(--ink-4); font-weight: 400; text-transform: none; letter-spacing: 0;">read-only</span></div>
            <div class="src" style="max-height:280px;overflow:auto;">
              <div class="line"><span class="ln">1</span><span class="sig"> </span><span class="text">${escapeHtml(pretty(a.payload))}</span></div>
            </div>
          </div>
          <div class="col">
            <div class="lbl">Amended <span class="right">edit me</span></div>
            <textarea data-amend-payload style="width:100%;min-height:240px;font-family:var(--mono);font-size:12px;padding:10px;border:1px solid var(--rule);border-radius:3px;background:var(--paper-card);outline:none;resize:vertical;">${escapeHtml(pretty(a.payload))}</textarea>
          </div>
        </div>
      </div>
      <div class="amf">
        <span class="hint"><kbd>⌘</kbd> <kbd>↵</kbd> submit · <kbd>esc</kbd> cancel</span>
        <span class="spacer"></span>
        <button class="btn" data-amend-cancel>Cancel</button>
        <button class="btn primary" data-amend-submit>Amend &amp; approve</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // close() tears down BOTH the overlay and the keydown listener so every close
  // route (Escape, Cancel, submit, overlay-click) removes the listener exactly
  // once. Without this the ⌘↵ handler would keep firing against a detached
  // submit button after the modal closed.
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      close();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      overlay.querySelector<HTMLElement>('[data-amend-submit]')?.click();
    }
  };
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKeydown);
  };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector<HTMLElement>('[data-amend-cancel]')?.addEventListener('click', close);
  const submitBtn = overlay.querySelector<HTMLButtonElement>('[data-amend-submit]');
  submitBtn?.addEventListener('click', async () => {
    if (submitBtn.disabled) {
      return;
    }
    const ta = overlay.querySelector<HTMLTextAreaElement>('[data-amend-payload]');
    const payload = ta?.value ?? '';
    if (!payload.trim()) {
      showToast('Payload required', 'error');
      return;
    }
    submitBtn.disabled = true;
    try {
      const result = await decide(a.id, 'amended', payload, notifyAgent);
      // Close on success (decide already refreshed the pane) and on 409
      // (already terminal — the stale editor must not stay up). Stay open on
      // validation/network failures so the operator's edits aren't lost.
      if (result !== 'failed') {
        close();
      }
    } finally {
      submitBtn.disabled = false;
    }
  });
  document.addEventListener('keydown', onKeydown);
}

/* ── helpers ───────────────────────────────────────────────────────── */

function formatPayload(p: string): string {
  try {
    const obj = JSON.parse(p);
    const lines = JSON.stringify(obj, null, 2).split('\n');
    return lines.map((line, i) =>
      `<span class="gutter">${String(i + 1).padStart(2, ' ')}</span>${colorizeJsonLine(line)}`
    ).join('\n');
  } catch {
    return `<span class="gutter"> 1</span>${escapeHtml(p)}`;
  }
}

function pretty(p: string): string {
  try { return JSON.stringify(JSON.parse(p), null, 2); }
  catch { return p; }
}

function colorizeJsonLine(line: string): string {
  // crude colorizer — keys steel, strings moss, numbers clay, booleans plum
  let s = escapeHtml(line);
  s = s.replace(/(&quot;[^&]+?&quot;)(?=:)/g, '<span class="key">$1</span>');
  s = s.replace(/: (&quot;[^&]*?&quot;)/g, ': <span class="str">$1</span>');
  s = s.replace(/: (-?\d+(?:\.\d+)?)/g, ': <span class="num">$1</span>');
  s = s.replace(/: (true|false)/g, ': <span class="bool">$1</span>');
  s = s.replace(/([{}[\],:])/g, '<span class="punc">$1</span>');
  return s;
}

function ago(iso: string): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

function setText(sel: string, text: string): void {
  const el = document.querySelector<HTMLElement>(sel);
  if (el) el.textContent = text;
}

// Use toast from util.ts, aliased as showToast for backward compat
const showToast = toast;
