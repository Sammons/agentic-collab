# RFC-010: AI Sketch Canvas (tldraw, vendored — Option A)

**Status:** Draft — needs operator decision on the license tier (§1: free hobby-watermark vs paid commercial)
**Author:** agentic-collab-lead
**Created:** 2026-06-23
**Depends on:** existing file-upload pipeline (`POST /api/files`, `GET /api/files/:id`), the merged-chat renderer (`src/dashboard/chat.ts`), the dashboard asset server (`src/orchestrator/routes.ts` `/dashboard/assets/:path+`).

---

## 1. LICENSE FINDING — THE GATE (read this first)

**Verdict: Option A is VIABLE. tldraw can be self-hosted and vendored for this internal tool. The one operator decision is whether to accept a "made with tldraw" watermark (free) or pay to remove it ($6,000/yr).**

The tldraw SDK (4.x, the current line) is **source-available, NOT permissively licensed** (not MIT/Apache). The relevant terms, verbatim from the canonical license, are:

- **Bundling and modifying are explicitly PERMITTED.** The license grants the right to *"Use the Software in Development Environments,"* *"Modify the Software to suit your needs,"* and *"Bundle the Software with your own projects."* The only redistribution limit is you *"cannot distribute the Software … as a standalone product, but only as part of another application."* Vendoring a built bundle into our dashboard is exactly "as part of another application." ([LICENSE.md](https://github.com/tldraw/tldraw/blob/main/LICENSE.md))
- **Development use is free and needs no key.** The SDK self-detects "development" and runs unrestricted when **any** of these hold: protocol is **HTTP** (not HTTPS), hostname is **`localhost`**, or **`NODE_ENV !== 'production'`**. ([License key docs](https://tldraw.dev/sdk-features/license-key))
- **Production use requires a license key.** "Production" = HTTPS on a non-localhost domain. Without a key in production you get *"console errors about the missing or invalid license"* and the watermark; the SDK does not hard-fail to a blank screen, but running unlicensed in production is a license violation, so we do not rely on that. ([License key docs](https://tldraw.dev/sdk-features/license-key))
- **A FREE "hobby" license exists** for non-commercial projects. It is granted on request (discretionary review). It keeps the **"made with tldraw" watermark** visible on the canvas. ([License page](https://tldraw.dev/community/license))
- **Removing the watermark requires a paid commercial license: $6,000 USD / year per team.** ([Community debate on the $6k fee](https://biggo.com/news/202509190115_tldraw_SDK_4.0_Licensing_Debate), [License updates](https://tldraw.substack.com/p/license-updates-for-the-tldraw-sdk))
- **License keys are safe to ship in the bundle.** Keys are validated client-side and are domain-restricted, so embedding the key in the vendored bundle (or passing it via the iframe host page) is sanctioned by tldraw. ([License key docs](https://tldraw.dev/sdk-features/license-key))

### What this means for agentic-collab specifically

The dashboard is served by the orchestrator (Docker `:3000`) and reached over the tailnet. **Detection turns on the URL the browser uses, not on where the server runs.**

- If operators reach the dashboard at `http://<host>:3000/...` (HTTP) or via `localhost`, the SDK is in **development mode → free, no key, no watermark, no violation.** This is the common case today.
- If the dashboard is fronted by HTTPS on a non-localhost tailnet hostname, the SDK is in **production mode** and needs a key. For an **internal, non-commercial** tool the **free hobby license** covers this — it costs nothing and only adds the watermark.

### The operator decision (the only gate)

1. **Free hobby license, accept the watermark.** $0. A small "made with tldraw" mark sits on the sketch canvas. Recommended default for an internal tool. The agent requests a hobby key, we set it via env/iframe-host config, done.
2. **Paid commercial license, no watermark.** $6,000/yr. Only worth it if the watermark is unacceptable on shared/recorded sketches.

Either way **the architecture is identical** — the license key is one config value passed to the `<Tldraw licenseKey=...>` component inside the iframe (or omitted in HTTP/localhost dev). **There is no architectural blocker. Build proceeds.** This RFC assumes option (1) unless the operator picks (2).

> Why this is not the same as the zero-runtime-dep stance being violated: see §4. The bundler is a dev-only build tool (like `typescript` already is in this repo); the committed bundle is a static asset, not an npm runtime dependency.

---

## 2. Problem

Agents communicate in text + attached files. They cannot communicate **spatial / diagrammatic** intent: an architecture sketch, a box-and-arrow flow, a wireframe, a "here's the layout I mean." The operator equally has no way to **draw back** at an agent. Today the closest path is an agent describing a diagram in prose or ASCII, which is lossy and slow to iterate on.

We want a first-class **sketch** message type: an agent emits a drawing, it renders as an **interactive canvas inline in the chat**, the operator **edits it in place** with changes **staged** (nothing leaves the browser until they choose), and **Send** shares the edited result back as a **rasterized PNG** through the existing file pipeline — so the agent (and the rest of the system) sees it exactly the way it already sees any uploaded image.

## 3. Goals / Non-Goals

**Goals**
- An agent can produce a sketch that renders as an **interactive tldraw canvas** inline in a chat message.
- The operator edits that canvas with tldraw's own editing UI; edits are **staged in the browser**, never auto-sent.
- A **Send** control rasterizes the edited canvas to a **PNG** and posts it back via the existing `POST /api/files` → message-with-`fileIds` flow.
- **Zero runtime npm dependency** in the orchestrator/dashboard: tldraw ships as a **pre-built, committed, vendored bundle**, served by the existing static-asset path, **lazy-loaded only for sketch messages**.
- **iframe isolation**: tldraw + React run inside a same-origin sandboxed iframe; the dashboard talks to it only over a typed `postMessage` protocol. The dashboard's vanilla-TS world never imports React.

**Non-Goals**
- No multiplayer / real-time collaborative editing (no `tldraw sync`, no server-side store).
- No round-trip of the **editable** document back to the agent in v1 — the agent receives the **rasterized PNG** (matching how it consumes any image). (Optional future: also attach the source DSL/snapshot JSON as a sidecar file.)
- No tldraw plugins, custom shapes, or asset uploads inside the canvas in v1.
- No change to the agent engines/adapters — agents emit sketches via a text convention in their normal message stream (§7).

---

## 4. Decision: Option A — vendored tldraw + React, iframe-isolated, lazy-loaded, PNG on Send

### 4.1 The zero-runtime-dep justification (the part the adversarial reviewer will attack)

The repo's north-star constraint is **zero runtime npm dependencies** — `node --test`, no `npm install`, `.ts` served type-stripped to the browser. tldraw is a React SDK. Reconciling these:

- **The orchestrator and dashboard runtime gain ZERO new dependencies.** No entry is added to any `package.json` `dependencies`. `npm install` is still not part of running the app. The orchestrator still serves static files and type-strips `.ts`; it never imports React or tldraw.
- **tldraw is built ONCE, OFFLINE, into a single self-contained ESM bundle (JS + CSS), and the OUTPUT is committed** under `src/dashboard/vendor/tldraw/`. This is identical in spirit to how `typescript` is already a dev-only tool in this repo: a developer runs a tool offline to produce an artifact the runtime consumes. The runtime consumes the **artifact** (a `.js` file), not the tool.
- **The build is NOT in CI and NOT at runtime.** No CI step builds the bundle; no container build step runs a bundler. The committed bundle is the source of truth. Rebuilding only happens when a human deliberately upgrades tldraw (§4.3), as a one-off, off the critical path.
- **Supply-chain posture is BETTER than a live dep, not worse.** Per the user-level rule `assume_risk_from_all_supply_chain`: a vendored, pinned, committed bundle is reviewed once and frozen — it cannot silently update under us. A live `dependencies` entry can pull a compromised patch on any reinstall. The bundle's provenance (tldraw version, build command, checksums) is recorded next to it (§4.2).
- **It is iframe-isolated.** Even though the bundle is large and React-based, it never enters the dashboard's module graph. The dashboard stays vanilla TS; the React world is sealed behind an iframe boundary and a `postMessage` wire.

This is the same call RFC-008 makes for Telegram ("no new runtime dependency; custom HTTP polling stays") applied to a UI dependency: we take the capability without taking the dependency into the runtime.

### 4.2 The vendored bundle — build, location, serving

**Build (offline, one-off, by a human upgrading tldraw):**

A tiny build dir lives at `tools/tldraw-bundle/` (a top-level dev tool, per `top_level_tools_for_cross_skill_dev_tools`), NOT under `src/`. It has its **own** `package.json` (the ONLY place tldraw + react + react-dom + esbuild appear — and it is never installed by the app, never referenced by the runtime). The build:

```
tools/tldraw-bundle/
  package.json          # tldraw, react, react-dom, esbuild — dev-only, NOT the app's
  entry.tsx             # imports { Tldraw, toRichText } from 'tldraw' + 'tldraw/tldraw.css';
                        # implements the iframe-side runtime (postMessage handler, DSL→shape
                        # translation, export-to-PNG) — see §6/§7
  build.mjs             # esbuild: bundle entry.tsx → ESM, minify, bundle CSS, inline assets
  README.md            # exact build command + how to upgrade + checksum-record steps
```

`build.mjs` runs esbuild with: `bundle: true`, `format: 'esm'`, `minify: true`, `define: { 'process.env.NODE_ENV': '"production"' }` (so React's dev code is dropped), `loader` entries to **inline** tldraw's fonts/icons as data URIs (tldraw's self-hosted assets — `getAssetUrls` from `@tldraw/assets/selfHosted` — so there is **no runtime CDN fetch**), and CSS bundled into the JS (or emitted as a sibling `tldraw.bundle.css`). Output:

```
src/dashboard/vendor/tldraw/
  tldraw.bundle.js       # self-contained ESM: tldraw + react + react-dom + iframe runtime
  tldraw.bundle.css      # tldraw.css (+ any extracted CSS)
  VENDOR.md              # tldraw version, build command, esbuild version, sha256 of each output,
                         # build date, the licenseKey-injection note
```

- tldraw ships **ESM** and is designed to be bundled (`import { Tldraw } from 'tldraw'`), so a single-file ESM output is the supported path. ([Installation docs](https://tldraw.dev/installation))
- **No runtime CDN dependency**: fonts/icons are inlined or emitted as local sibling assets and served from `/dashboard/vendor/tldraw/...`. The browser fetches nothing from `tldraw.com`/`unpkg`/`jsdelivr`. (The one exception, if option-2 paid is NOT chosen and a hobby/trial key is in play: a trial key sends a hashed key + deploy URL to tldraw for analytics — no canvas data. A hobby/commercial key validates client-side and works fully offline.)

**Approximate size:** the full tldraw editor + React + react-dom minified is large — on the order of **~1.5–2.5 MB minified (~400–700 KB gzipped)** (tldraw's full UI is heavy; tldraw's own tracker notes the editor pulls ~30% it does not strictly need, and v5 trimmed deps — [issue #5256](https://github.com/tldraw/tldraw/issues/5256)). **The exact number is measured at build time and recorded in `VENDOR.md`; Q1's check asserts the committed bundle is a single self-contained file and records its measured size.** Because it is **lazy-loaded only when a sketch message is present** (§8), it costs nothing on the normal text-chat path.

**Serving — the concrete gap to close.** The existing asset server (`routes.ts`) whitelists only `.js`, `.ts`, `.css` in `ASSET_TYPES` and serves from `/dashboard/assets/:path+` and `/dashboard/shared/:path+`. Two facts make vendoring clean and one needs a small change:

1. `.js` is already whitelisted and is served **as-is** (only `.ts` is type-stripped — `loadAssetEntry` strips only when `ext === '.ts'`). So `tldraw.bundle.js` and `tldraw.bundle.css` serve correctly with **no server change** if we expose `src/dashboard/vendor/` through a route.
2. `warmDashboardAssets()` walks `src/dashboard` recursively at boot and pre-caches supported extensions. It would try to **read+cache** `tldraw.bundle.js` (fine — `.js` is not stripped) but the multi-MB read at boot is wasteful. **Q1 adds an exclusion**: `warmDashboardAssets` skips `vendor/` (the bundle is loaded lazily on first sketch, cached on demand by `loadAssetEntry`, mtime-keyed like everything else).
3. **The iframe host page is `.html`, which is NOT in `ASSET_TYPES`.** Q1 adds a **dedicated route** `GET /dashboard/sketch-frame` that returns the host HTML directly (mirroring the existing `/dashboard` and `/filter-test` routes), rather than widening the asset whitelist to `.html` (narrower blast radius). The host page `<script type="module" src="/dashboard/vendor/tldraw/tldraw.bundle.js">` + `<link rel="stylesheet" href="/dashboard/vendor/tldraw/tldraw.bundle.css">`.
4. A vendor route `GET /dashboard/vendor/:path+` (same shape as `/dashboard/assets/:path+`, same `..` guard, same content-type whitelist, same etag/mtime caching) serves the bundle files.

### 4.3 Rebuild on upgrade

Upgrading tldraw is a deliberate human action, never automatic:

1. Bump the tldraw version in `tools/tldraw-bundle/package.json`, `pnpm install` **inside that dir only**.
2. Run `pnpm --dir tools/tldraw-bundle build` → regenerates `src/dashboard/vendor/tldraw/*`.
3. Update `VENDOR.md` with the new version, build command, esbuild version, and fresh sha256s.
4. Manually open a sketch in the dashboard, verify render + edit + export still work; run the Q4 tests.
5. Commit the regenerated bundle in a dedicated `chore(deps): bump vendored tldraw to X.Y.Z` PR so the diff is reviewable as "binary-ish blob changed, here's why."

### 4.4 Architecture at a glance

```
 Dashboard (vanilla TS, no React)            Sandboxed iframe (same-origin)
 ┌─────────────────────────────┐             ┌──────────────────────────────────┐
 │ chat.ts renderMessageBody    │  init ───▶  │ /dashboard/sketch-frame (host .html)│
 │  detects ```sketch``` block  │  load-doc ─▶│  loads tldraw.bundle.js/.css       │
 │  mounts <iframe sandbox>     │             │  <Tldraw licenseKey=…> (or none in │
 │                              │  ◀── ready  │     HTTP/localhost dev)            │
 │  Greenroom chrome around it: │             │  DSL → editor.createShapes(...)    │
 │   header + Send + Reset      │  ◀─ dirty   │  staged edits live in tldraw store │
 │                              │ export-req ▶│                                    │
 │  on Send: postMessage        │◀ export-res │  editor.toImage([],{format:'png'}) │
 │   export-request             │   (PNG)     │   → Blob → dataURL                 │
 │  → upload PNG to /api/files  │             │                                    │
 │  → POST /api/dashboard/send  │             │                                    │
 └─────────────────────────────┘             └──────────────────────────────────┘
```

---

## 5. The iframe host page + postMessage protocol

### 5.1 The iframe element (dashboard side)

The dashboard mounts:

```html
<iframe
  src="/dashboard/sketch-frame"
  sandbox="allow-scripts allow-same-origin"
  referrerpolicy="no-referrer"
  title="sketch canvas"></iframe>
```

- **Same-origin** (served by the orchestrator), so the dashboard can address it and the iframe can fetch the vendored bundle. `allow-same-origin` is required for tldraw (it uses storage / blob URLs) **and** for the dev-mode detection (`localhost`/HTTP read from the same origin).
- **`allow-scripts`** is required (React runs). We do **not** grant `allow-top-navigation`, `allow-popups`, `allow-forms`, or `allow-modals`. The combination `allow-scripts allow-same-origin` is the documented minimum for an interactive same-origin embed; we add nothing more.
- Note: `allow-scripts allow-same-origin` together does technically let the frame reach back into same-origin context — acceptable here because **we author and vendor the bundle ourselves** (it is trusted code we built, pinned by checksum), and the **data it processes is validated** (§9). The sandbox's job here is defense-in-depth + a clean message boundary, not isolating hostile code.

### 5.2 Protocol

All messages are JSON objects with a `kind` discriminator (matching the repo's `kind_is_the_discriminator` convention) and a `v: 1` version field. **Both sides validate `event.origin === window.location.origin`** before processing, and the parent validates `event.source === iframe.contentWindow`.

**Parent → iframe:**

| `kind`          | payload                                  | meaning |
|-----------------|------------------------------------------|---------|
| `sketch:init`   | `{ v, licenseKey?: string, readOnly?: boolean, theme: 'greenroom-light' }` | sent once after the iframe posts `ready`; carries the (optional) license key and display prefs. |
| `sketch:load`   | `{ v, shapes: SketchShape[] }`           | the agent's sketch DSL (§7) to render. The iframe translates → `editor.createShapes(...)`. |
| `sketch:export-request` | `{ v, requestId: string, format: 'png', scale?: number, background?: boolean }` | ask the iframe to rasterize the current (edited) canvas. |
| `sketch:reset`  | `{ v }`                                  | discard staged edits, re-render the original `sketch:load` shapes. |

**iframe → parent:**

| `kind`          | payload                                  | meaning |
|-----------------|------------------------------------------|---------|
| `sketch:ready`  | `{ v }`                                  | bundle loaded, editor mounted; parent may now `init` + `load`. |
| `sketch:dirty`  | `{ v, dirty: boolean }`                  | the operator has (or hasn't) edited since load; drives the Send button's enabled state + a "edited" marker. Debounced on the editor's store-change event. |
| `sketch:export-response` | `{ v, requestId, ok: true, dataUrl: string, width: number, height: number }` or `{ v, requestId, ok: false, error: string }` | the rasterized PNG as a data URL (matching the `requestId` from the request). `toImage` returns `undefined` on failure → `ok:false`. |
| `sketch:error`  | `{ v, where: string, message: string }`  | a parse/render/export failure the iframe wants surfaced (e.g. invalid DSL). |

- The PNG comes back as a **data URL** (simplest cross-frame transfer; no `MessageChannel`/transferable needed for a one-shot blob). The parent converts it to a `File`/`Blob` for upload. For very large canvases a transferable `ArrayBuffer` is a future optimization; v1 uses the data URL.
- **`requestId`** correlates request↔response so a second export can't be mistaken for the first.
- The protocol type definitions live in **`src/shared/sketch-protocol.ts`** so both the dashboard (`.ts`) and the iframe runtime (built from `tools/tldraw-bundle/entry.tsx`) reference one source of truth.

---

## 6. Export to PNG (the Send result)

Inside the iframe, on `sketch:export-request`:

```ts
// editor is the tldraw Editor instance captured from <Tldraw onMount={(e) => editor = e}>
const result = await editor.toImage([], { format: 'png', background: true, scale: 1 });
// [] = all shapes on the current page; result is undefined on failure
if (!result) { postBack({ kind: 'sketch:export-response', v: 1, requestId, ok: false, error: 'export failed' }); return; }
const dataUrl = await blobToDataUrl(result.blob);   // FileReader.readAsDataURL
postBack({ kind: 'sketch:export-response', v: 1, requestId, ok: true, dataUrl, width: result.width, height: result.height });
```

- `Editor.toImage(shapes, options)` is the current, supported raster export; it returns `{ blob, width, height }` (or `undefined` on failure). `exportToBlob` is deprecated in favor of it. ([Image export docs](https://tldraw.dev/sdk-features/image-export), [exportToBlob reference](https://tldraw.dev/reference/tldraw/exportToBlob))
- Options used: `format: 'png'`, `background: true` (so the PNG has the Greenroom paper background, not transparency that looks broken in chat), `scale`/`pixelRatio` default to a crisp 2× — recorded as a constant.

---

## 7. The agent → sketch DSL (the LLM-friendly format)

### 7.1 Recommendation: a constrained shape-descriptor DSL, NOT raw snapshot JSON

An LLM asked to emit a **raw tldraw store snapshot** (the full document JSON) will produce brittle, frequently-invalid output: the snapshot format carries internal record types, schema versions, fractional `index` ordering keys, binding records, and `richText` ProseMirror nodes — exactly the kind of structure LLMs corrupt. **We do NOT ask the agent for snapshot JSON.**

Instead, the agent emits a **small, flat, LLM-friendly shape-descriptor list**, and the **iframe translates it** into tldraw shapes via `editor.createShapes(...)`. This is robust because: the agent only ever names primitives it understands (rect, ellipse, text, arrow, line) with plain coordinates/colors; the iframe owns all the brittle bits (`toRichText()`, IDs, indices, props defaults, bindings); and an invalid descriptor fails **one shape**, not the whole document.

### 7.2 The DSL

A fenced code block with the info-string `sketch` containing a JSON array of descriptors. Coordinates are an abstract canvas space (the iframe fits-to-content on load). Colors are tldraw's named palette (`black blue green red orange yellow violet light-blue light-green light-red light-violet grey white`).

````markdown
```sketch
[
  { "type": "rect",    "x": 40,  "y": 40,  "w": 200, "h": 100, "text": "Orchestrator", "color": "blue" },
  { "type": "rect",    "x": 40,  "y": 240, "w": 200, "h": 100, "text": "Proxy",        "color": "green" },
  { "type": "ellipse", "x": 360, "y": 60,  "w": 160, "h": 80,  "text": "SQLite",       "color": "violet" },
  { "type": "arrow",   "x1": 240, "y1": 90,  "x2": 360, "y2": 100, "text": "HTTP",     "color": "black" },
  { "type": "line",    "points": [[40,400],[300,400],[300,520]], "color": "grey" },
  { "type": "text",    "x": 40,  "y": 560, "text": "RFC-010 sketch", "color": "black" }
]
```
````

**Descriptor schema (each item):**

| `type`    | required fields | optional fields | maps to |
|-----------|-----------------|-----------------|---------|
| `rect`    | `x, y, w, h`    | `text, color, fill` | `geo` w/ `geo:'rectangle'`, `richText: toRichText(text)` |
| `ellipse` | `x, y, w, h`    | `text, color, fill` | `geo` w/ `geo:'ellipse'` |
| `text`    | `x, y, text`    | `color, w`      | `text` shape, `richText: toRichText(text)` |
| `arrow`   | `x1, y1, x2, y2`| `text, color`   | `arrow` w/ `start:{x:x1,y:y1}, end:{x:x2,y:y2}` |
| `line`    | `points: [[x,y],…]` | `color, dash` | `line` w/ points map |
| `note`    | `x, y, text`    | `color`         | `note` (sticky) |

The iframe's translator is a `Record<descriptorType, (d) => TLShapePartial>` lookup (per `dispatch_is_a_lookup_not_a_chain`). Defaults fill anything omitted; `color` defaults to `black`, `fill` to `none`, `size` to `m`. Shape `props` are exactly the tldraw partials confirmed in the docs ([default shapes](https://tldraw.dev/sdk-features/default-shapes), [createShapes example](https://tldraw.dev/examples/api)):

```ts
// rect/ellipse → geo
{ type: 'geo', x, y, props: { geo, w, h, color, fill, dash: 'solid', size: 'm', richText: toRichText(text ?? '') } }
// text
{ type: 'text', x, y, props: { richText: toRichText(text), color, size: 'm', autoSize: true } }
// arrow
{ type: 'arrow', x: x1, y: y1, props: { start: { x: 0, y: 0 }, end: { x: x2 - x1, y: y2 - y1 }, color, richText: toRichText(text ?? '') } }
// line
{ type: 'line', x: points[0][0], y: points[0][1], props: { color, dash, points: toPointsMap(points) } }
```

### 7.3 How the agent is told to emit it

The DSL spec is documented in a docs page (`/docs/sketch-dsl`, rendered by the existing docs route) and referenced from the agent-facing system context. Agents are instructed: *"To draw a diagram, emit a fenced `sketch` code block containing a JSON array of shape descriptors (see /docs/sketch-dsl). The operator will see it as an interactive, editable canvas."* This is a **prompt/docs convention only** — no engine/adapter change. An agent that does not know the convention simply never emits a sketch block; everything is backward compatible.

### 7.4 How the renderer detects a sketch and mounts the iframe

In `chat.ts`, `renderMessageBody` already runs the message through `renderMarkdown`. We add a **pre-pass**: detect a fenced block with info-string `sketch`, extract + `JSON.parse` + validate the descriptor array (the same hand-rolled validator the iframe will trust, in `src/shared/sketch-dsl.ts` — `parseSketchDsl(raw: unknown): SketchShape[] | SketchDslFailure`). On a valid block:

- Replace the code block in the rendered HTML with a **placeholder mount node** carrying a `data-sketch-id` and the validated shapes (stashed by id, not inlined as a giant attribute).
- After the feed renders, a `wireSketches(root)` pass (sibling to `wireCollapsibleMessages`/`wireCopyOnClick`) finds mount nodes, lazily creates the iframe + Greenroom chrome (§8), and on the iframe's `sketch:ready` posts `sketch:init` + `sketch:load`.
- An **invalid** `sketch` block renders as a normal fenced code block (graceful fallback) plus an inline ink-3 note "unparseable sketch — showing source."

---

## 8. Greenroom integration (the message-canvas chrome)

The **editing UI inside the iframe is tldraw's own** (its toolbar, color picker, shape tools) — we do not restyle tldraw's internals in v1. What we own is the **chrome around the canvas** in the chat message, and it follows Greenroom (per the `ui-theme` skill, `REFERENCE.md`).

- **Container**: the canvas sits in the message `.body` as a bordered block — `1px solid var(--rule)`, `--radius-lg`, NO card shadow (it is inline content, not a floating overlay). A 3px left identity-color border already marks the message as from an agent (Greenroom §9.2); the sketch block sits inside it.
- **Header strip** (above the iframe): a mono eyebrow `SKETCH` (10.5px, uppercase, ink-4) on the left; on the right, two controls. The **canvas itself** gets a fixed inline height (e.g. 360px) with the iframe filling the width.
- **Controls** (Greenroom §7 buttons):
  - **Send** — the single **clay `.btn.primary`** (the one clay moment for this block). Disabled until the iframe reports `dirty: true` (no point sending an unedited copy of what the agent already sent) OR always-enabled if the operator wants to send the agent's original as a PNG — operator open question §12. Label: `Send sketch`.
  - **Reset** — a default `.btn` (or `.btn.ghost`) that posts `sketch:reset` to discard staged edits.
- **Edited marker**: when `dirty`, a small mono ink-3 `· edited` note next to the eyebrow (no badge, per §8 status-as-text rule).
- **Status while loading**: an italic ink-3 "loading canvas…" empty-state line (Greenroom empty-state voice) until `sketch:ready`.
- **No ambient motion**, transitions ≤200ms, one clay moment (Send). All consistent with the hard rules.

The "made with tldraw" watermark (if on the hobby license) renders inside the iframe canvas — out of our control and acceptable.

---

## 9. Security

- **Origin validation both ways.** Parent checks `event.origin === location.origin && event.source === iframe.contentWindow`. Iframe checks `event.origin === location.origin`. Messages failing the check are dropped silently.
- **Sandbox**: `sandbox="allow-scripts allow-same-origin"` and nothing else (no top-nav, popups, forms, modals, pointer-lock, downloads). `referrerpolicy="no-referrer"`.
- **The sketch payload is DATA, never code.** The DSL is `JSON.parse`d and run through a **hand-rolled validator** (`parseSketchDsl`, per `handroll_validation_at_boundaries`) on **both** sides: the dashboard validates before mounting; the iframe re-validates before `createShapes`. Validation: array length cap, per-shape `type` is one of the known set, numeric fields are finite numbers within sane bounds, `text` is a string capped in length and only ever passed to `toRichText()` (tldraw treats it as text content, never HTML/markup), `color` is one of the allowed palette names (reject unknown). No `eval`, no `Function`, no dynamic import of payload-derived paths.
- **No HTML injection path**: text from the DSL goes to `toRichText()` inside tldraw (text node), not to `innerHTML`. The chat renderer continues to `escapeHtml` before markdown as it does today; the sketch placeholder node carries only a numeric/uuid `data-sketch-id`, never raw payload.
- **Size / rate limits**:
  - DSL: **max N shapes** (e.g. 500) and **max raw block size** (e.g. 64 KB) — over-cap blocks render as plain code with a note.
  - Export PNG: bounded by the existing `FILE_MAX_BYTES` ceiling on `POST /api/files` (the upload simply 413s if the rasterized PNG is too large; the operator gets a toast via the existing path). A `scale` cap keeps normal exports well under it.
  - The iframe is created **lazily and at most once per sketch message**; a feed with many sketch messages mounts iframes only for those actually rendered in the virtualized window (chat.ts already virtualizes to ~50–100 nodes).
- **License key exposure** is sanctioned by tldraw (client-validated, domain-restricted) — but we still inject it via the `sketch:init` message / host-page config rather than committing it into the bundle source, so rotating the key does not require a rebuild.

---

## 10. Bundle-size / performance

- **Normal text chat pays nothing.** The vendored bundle is excluded from `warmDashboardAssets` and is fetched **only** when the first sketch message is wired. No React, no tldraw on the critical path.
- **Lazy, cached, shared.** The iframe `src` (`/dashboard/sketch-frame`) loads the bundle once; the browser caches it (etag/mtime, like every asset). Multiple sketch messages each get their own iframe but reuse the cached bundle bytes.
- **Measured at build time.** `VENDOR.md` records the exact minified + gzipped size. Estimate ~1.5–2.5 MB min / ~400–700 KB gzip for the full editor; acceptable because it is off the default path and behind a deliberate "this message has a drawing" gate.
- **Per-iframe cost** is one React tree; for a feed with many sketches we cap concurrently-mounted iframes to the virtualized window and could add an "click to load canvas" deferral if profiling shows pressure (open question §12).

---

## 11. Rejected alternatives

- **Option B — tldraw from a CDN (ESM via esm.sh / unpkg / jsdelivr).** Rejected. A runtime third-party fetch is a live supply-chain dependency that can change or vanish under us, violates the repo ethos (`assume_risk_from_all_supply_chain`, zero-runtime-dep), and adds a hard network dependency for an internal tool that may run on an isolated tailnet. Vendoring is strictly safer and self-contained.
- **Option C — vanilla canvas, no tldraw (hand-rolled drawing).** Rejected. Building an interactive, editable, multi-shape canvas with selection, transforms, text, arrows, undo/redo, and PNG export is a large, bug-prone effort that re-implements exactly what tldraw already does well. The vendoring path takes tldraw's capability without taking it into the runtime — strictly better than rebuilding a worse editor. (If the license gate had killed Option A, C would be the fallback — but the gate is clear, §1.)
- **Sub-rejected — round-trip the editable tldraw document back to the agent.** v1 sends a PNG only, because (a) it matches how agents already consume images (the file pipeline), with zero engine changes, and (b) feeding snapshot JSON to an agent is the brittle path we rejected in §7. A future RFC can attach the source DSL as a sidecar file alongside the PNG.

---

## 12. Risks + mitigations

| Risk | Mitigation |
|------|------------|
| **License tier choice** (watermark vs $6k). | §1 surfaces it as the single operator decision; architecture is identical either way; default = free hobby + watermark. |
| **Bundle is large.** | Lazy-load, off the default path, cached; excluded from boot warm-up; size recorded + checked. |
| **tldraw upgrade breaks the bundle / DSL translation.** | Upgrades are deliberate, human-run, behind a checksum-recorded rebuild (§4.3) + Q4 tests + manual verify; never automatic. |
| **iframe message spoofing.** | Strict origin + source validation both ways; minimal sandbox; payload validated as data, never executed (§9). |
| **Invalid agent DSL.** | Hand-rolled validator both sides; invalid block degrades to plain code with an inline note; one bad shape doesn't kill the doc. |
| **`allow-same-origin`+`allow-scripts` weakens sandbox.** | The bundle is our own vendored, checksum-pinned code, not hostile; sandbox is defense-in-depth + clean boundary; data is validated. |
| **Asset server can't serve `.html`/large `.js`.** | Q1: dedicated `/dashboard/sketch-frame` route for the host HTML; `/dashboard/vendor/:path+` route for the bundle; `warmDashboardAssets` skips `vendor/` (§4.2). |
| **PNG export fails on edge shapes** (known historic tldraw bug on some text exports — [#3868](https://github.com/tldraw/tldraw/issues/3868)). | `toImage` returns `undefined` → `ok:false` → parent toasts "export failed, try again"; pinned tldraw version is verified at vendor time. |

---

## 13. Decomposition — quantum DAG (each check-bound)

Four quanta. Q1 is the foundation; Q2 and Q3 depend on it; Q4 proves the whole.

### Q1 — Vendored bundle + iframe host + postMessage skeleton
**Scope:** `tools/tldraw-bundle/` (package.json, entry.tsx, build.mjs, README); committed `src/dashboard/vendor/tldraw/*` + `VENDOR.md`; `src/shared/sketch-protocol.ts` (message types); routes: `GET /dashboard/sketch-frame` (host HTML) + `GET /dashboard/vendor/:path+` (bundle); `warmDashboardAssets` skips `vendor/`. The iframe runtime posts `sketch:ready`, accepts `sketch:init`, mounts `<Tldraw>` (with optional `licenseKey`).
**Checks (build the substrate first):**
- `node --test`: a route test asserts `GET /dashboard/sketch-frame` returns 200 `text/html` and references the vendor bundle URLs.
- `node --test`: a route test asserts `GET /dashboard/vendor/tldraw/tldraw.bundle.js` returns 200 `application/javascript`, served un-stripped, with an etag; and that `..`-traversal is rejected 400.
- `node --test`: `warmDashboardAssets` does NOT cache anything under `vendor/` (assert the cache has no `vendor/` key after a warm).
- A committed `VENDOR.md` records tldraw version + build command + sha256 of each output + measured size; a test asserts the bundle file exists, is a single file, and is non-empty.

### Q2 — Agent→sketch DSL + message-renderer detection + interactive mount
**Scope:** `src/shared/sketch-dsl.ts` (`parseSketchDsl` validator + `SketchShape` type, shared by both sides); the iframe translator (`descriptor → TLShapePartial` lookup, `editor.createShapes`); `chat.ts` pre-pass that detects ` ```sketch ` blocks, validates, emits a placeholder mount node, and `wireSketches(root)` that lazily mounts the iframe and posts `sketch:init`+`sketch:load`; `/docs/sketch-dsl` docs page.
**Checks:**
- `node --test`: `parseSketchDsl` — valid array → typed shapes; each invalid case (non-array, unknown `type`, non-finite coord, bad `color`, over-cap length/size, oversized `text`) → the right `SketchDslFailure` variant. Single `assert.deepEqual` per shape case.
- `node --test`: the chat pre-pass turns a valid `sketch` block into a mount-node placeholder (assert the rendered HTML contains the placeholder + `data-sketch-id`, not the raw JSON) and turns an invalid block into a plain code block + note.
- Manual + Q4 visual: a known DSL renders the expected shapes in the canvas.

### Q3 — Edit-staging + Send → export → upload → post-back
**Scope:** the `dirty` tracking (iframe posts `sketch:dirty` on store change, debounced); Greenroom chrome (header eyebrow, `· edited` marker, Send clay-primary, Reset); Send flow: parent posts `sketch:export-request` → receives `sketch:export-response` (PNG dataURL) → converts to a `File` → `POST /api/files` (reusing `uploadFileToStorage` shape from `chat.ts`) → `POST /api/dashboard/send` with the resulting `fileId` (so it lands as an image attachment exactly like any uploaded file); `sketch:reset` discards staged edits.
**Checks:**
- `node --test`: a unit test of the export-response→upload glue (mock the `fetch` to `/api/files`, assert a PNG `File` is posted and the returned `fileId` flows into the `/api/dashboard/send` body) — pure dashboard logic, no real iframe needed (the postMessage boundary is stubbed).
- `node --test`: Send button disabled until `dirty:true`; Reset clears dirty; `requestId` correlation (a stale export-response for an old `requestId` is ignored).
- Manual verify: draw → Send → the message appears in chat with a `📎` PNG attachment that opens to the edited drawing.

### Q4 — Tests + visual proof
**Scope:** end-to-end coverage tying it together; a Playwright (ui-testing skill / playwright-workbench) flow that loads the dashboard with a seeded sketch message, asserts the iframe mounts and the canvas renders, edits a shape, clicks Send, and asserts a PNG attachment lands in the feed; a visual screenshot for the design record.
**Checks:**
- Playwright: sketch message → iframe present → `sketch:ready` observed → canvas non-empty → Send → feed gains an image attachment. Green, non-flaky.
- A committed screenshot (via visual-verify-html / playwright-workbench) of the rendered sketch block in Greenroom chrome, reviewed against the `ui-theme` rules (one clay moment = Send; bordered block; no card shadow; mono eyebrow).
- Full `node --test` suite green; `pnpm typecheck` shows no new errors (judge by per-file delta per the repo's tsc-baseline note).

**DAG:** `Q1 → {Q2, Q3} → Q4`. Q2 and Q3 are independent after Q1 (Q2 = render/mount/DSL; Q3 = staging/Send/export) and can run in parallel; Q4 depends on both.

---

## 14. Open questions for the operator

1. **License tier (§1):** free hobby license + "made with tldraw" watermark ($0, recommended), or paid commercial ($6,000/yr, no watermark)? Architecture is identical; this only changes which key we request.
2. **Send-when-unedited:** should **Send** be enabled even when the operator hasn't touched the canvas (i.e. "send the agent's original sketch back as a PNG"), or only after an edit (`dirty`)? Default proposed: enabled only when `dirty`, with a separate affordance if you want to forward the original.
3. **Round-trip the source DSL?** v1 sends a PNG only. Do you also want the source `sketch` DSL attached as a sidecar file (so an agent could re-edit), now or in a later RFC? Default: later RFC.
4. **Inline canvas height + "click to load" deferral:** fixed 360px inline canvas with eager mount (proposed), or a "click to load canvas" placeholder for feeds with many sketches to avoid mounting many React trees? Default: eager mount within the virtualized window, revisit if profiling shows pressure.
5. **Where does the agent learn the DSL?** A `/docs/sketch-dsl` page + a line in the agent-facing system context (proposed). Confirm you want the convention injected into agent context, or kept opt-in/documented-only.
