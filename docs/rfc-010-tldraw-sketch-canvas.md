# RFC-010: AI Sketch Canvas (tldraw, vendored — Option A, FROZEN)

**Status:** FROZEN / build-ready. Operator approved FULL Option A (vendored tldraw + React, iframe-isolated) on the FREE hobby tier + "made with tldraw" watermark ($0). This revision folds in the operator's decisions and all dependency / security / LLM-feasibility adversarial-review findings. The Diamond DAG (§13) is final; every leaf binds to a named `node --test` or Playwright check.
**Author:** agentic-collab-lead
**Created:** 2026-06-23 · **Frozen:** 2026-06-23
**Depends on:** existing file-upload pipeline (`POST /api/files`, `GET /api/files/:id`), the merged-chat renderer (`src/dashboard/chat.ts`), the dashboard asset server (`src/orchestrator/routes.ts`, `/dashboard/assets/:path+`), the docs route (`src/orchestrator/routes.ts` `/docs/:page` + `DOC_PAGES` in `src/docs/render.ts`).

---

## 0. What changed in this freeze (review fold-in summary)

This RFC was reviewed by three adversarial lenses. Every binding finding is folded in here so executing quanta do not rediscover them.

- **Operator decisions** → §1 (license: free hobby + watermark, production must be tested), §1.1 (four baked UX defaults, each veto-able).
- **Dependency review** → §4.1 (honest offline-build-step admission), §4.2 + §4.5 (`VENDOR.md` carries versions/build-cmd/sha256/size **and** a CI reproducible-build check), §4.6 (named CVE-rot owner + quarterly/on-disclosure rebuild ritual), §11 Option C (zero-dep vanilla SVG/canvas renderer, properly **costed**).
- **Security review (BLOCKERS)** → §5.1 (sandbox via **srcdoc/blob, NOT `allow-same-origin allow-scripts`**), §9.2 (**CSP** for `/dashboard` + `/dashboard/sketch-frame`), §9.3 (path-traversal fix: `resolve()` + `startsWith`, not substring `..`), §9.4 (`parseSketchDsl`: reject `__proto__`/`constructor`/`prototype`, explicit field-copy, finite+bounded numerics, raster ceiling **inside** the iframe before `toImage`).
- **LLM-feasibility review** → §7.2 (DSL extended: `id`, connector-by-id, `frame`/container, z-order, relative/flow layout), §7.4 (**detection-before-escape** trap documented), §13 Q4 (**golden-corpus** human-reviewed gate), §7.3 + §13 Q2 (`/docs/sketch-dsl` needs a `DOC_PAGES` entry + `src/docs/sketch-dsl.md`).

---

## 1. License — DECIDED: free hobby tier + watermark ($0)

**The tldraw SDK (4.x) is source-available, not permissively licensed (not MIT/Apache).** The operator chose the **free hobby license** with the **"made with tldraw" watermark**. $0/yr. The terms, verbatim from the canonical license:

- **Bundling and modifying are explicitly PERMITTED.** The license grants *"Use the Software in Development Environments,"* *"Modify the Software to suit your needs,"* *"Bundle the Software with your own projects."* The only redistribution limit: you *"cannot distribute the Software … as a standalone product, but only as part of another application."* Vendoring a built bundle into our dashboard is exactly "as part of another application." ([LICENSE.md](https://github.com/tldraw/tldraw/blob/main/LICENSE.md))
- **Development use is free and needs no key.** The SDK self-detects "development" and runs unrestricted when **any** of: protocol is **HTTP** (not HTTPS), hostname is **`localhost`**, or **`NODE_ENV !== 'production'`**. ([License key docs](https://tldraw.dev/sdk-features/license-key))
- **Production use requires a license key.** "Production" = HTTPS on a non-localhost domain. Without a key in production you get console errors + the watermark; the SDK does not blank-screen, but running unlicensed in production is a license violation, so we do not rely on it. ([License key docs](https://tldraw.dev/sdk-features/license-key))
- **The free hobby license** is granted on request (discretionary review) for non-commercial projects and keeps the **"made with tldraw" watermark** visible. ([License page](https://tldraw.dev/community/license))
- **License keys are safe to ship.** Keys are validated client-side and domain-restricted, so passing the key via the iframe-host config is sanctioned. ([License key docs](https://tldraw.dev/sdk-features/license-key))

### 1.0 How the decision lands in the build (key injection, dev vs prod)

- **The license key is NEVER committed.** It is a free hobby key registered for the dashboard's production HTTPS tailnet domain. It is injected at runtime via the `sketch:init` postMessage config (§5.3) — the dashboard reads it from an orchestrator-provided runtime config value (env → `getDashboardHtml`/a config endpoint), passes it into `sketch:init`, and the iframe sets `<Tldraw licenseKey={key}>`. Rotating the key changes one config value, not the bundle.
- **Dev mode needs NO key.** When the browser reaches the dashboard over HTTP or via `localhost`, the SDK is in development mode → free, no key, no watermark, no violation. `sketch:init` simply omits `licenseKey` in that case.
- **Production mode (HTTPS non-localhost) MUST be tested, not assumed-localhost.** Q4's Playwright gate exercises the production path: the test serves the dashboard over HTTPS on a non-localhost host (or stubs the SDK's detection inputs to the production branch) and asserts (a) the canvas renders with a key injected, and (b) the key is present in `sketch:init` and absent from any committed source. We do not ship trusting that everyone reaches it via `localhost`.

> **Deploy prerequisite (operator action before production):** register a **free hobby key at tldraw.dev** for the production HTTPS tailnet domain, then set it as an orchestrator config value (see §9.5 for storage). Until that key exists, production renders with console errors + the watermark; dev (HTTP/localhost) is unaffected. This prerequisite is recorded in `VENDOR.md` and the deploy runbook.

> Why this is not a zero-runtime-dep violation: §4.1. The bundler is a dev-only build tool (like `typescript` already is here); the committed bundle is a static asset, not an npm runtime dependency.

### 1.1 Baked UX defaults (decisions, each veto-able by the operator)

These are stated as **decisions** so the quanta have a concrete target; each carries a one-line rationale and the operator can veto any of them (tracked in §14).

- **(a) Send always works, even when the canvas is unedited** — Send rasterizes the *current* canvas state (agent's original if untouched, the edit if touched). Rationale: forcing an edit before Send is a footgun; "forward the agent's diagram as a PNG" is a real use. (Supersedes the old "disabled until dirty" default; `dirty` now only drives the `· edited` marker, not Send's enabled state.)
- **(b) Send shares the PNG AND attaches the editable sketch DSL as a sidecar** — the PNG is the **primary deliverable** (matches how agents already consume images); the DSL sidecar is a near-free enhancement (the DSL already exists in the message text, so attaching it costs one extra small upload) that keeps the artifact iterable. Rationale: the operator asked for PNG; the sidecar makes the sketch re-editable later without rebuilding it from a raster.
- **(c) Inline rendering = a cheap static SVG preview from the DSL (zero-dep, no tldraw) + "click to open canvas"** — the chat feed shows a small server-of-nothing, dashboard-rendered SVG built directly from the validated DSL (pure vanilla TS, no React, no tldraw, no iframe). The heavy tldraw iframe is **lazy-loaded only on demand** when the operator clicks "open canvas." Rationale: most sketches are read, not edited; rendering a React tree per sketch on first paint is waste. The SVG preview also doubles as the graceful path when the iframe/bundle is unavailable.
- **(d) Agent adoption = docs-only + opt-in per persona initially** — the DSL convention lives in `/docs/sketch-dsl` and is referenced by personas that opt in (a line in their persona file). It is **NOT** injected into every agent's system context yet. Rationale: prove the premise (golden corpus, §13 Q4) on a few agents before paying the token cost + behavior change across the whole fleet; broad injection is a later, separate decision.

---

## 2. Problem

Agents communicate in text + attached files. They cannot communicate **spatial / diagrammatic** intent: an architecture sketch, a box-and-arrow flow, a wireframe, "here's the layout I mean." The operator equally has no way to **draw back** at an agent. Today the closest path is an agent describing a diagram in prose or ASCII, which is lossy and slow to iterate on.

We want a first-class **sketch** message type: an agent emits a drawing; it renders as a **cheap inline SVG preview** in chat; the operator can **click to open** an **interactive tldraw canvas**, edit it in place with changes **staged** (nothing leaves the browser until they choose), and **Send** shares the result back as a **rasterized PNG** (primary) plus the **editable DSL sidecar** (enhancement) through the existing file pipeline — so the agent sees it exactly the way it already sees any uploaded image, and can re-edit later.

## 3. Goals / Non-Goals

**Goals**
- An agent produces a sketch that renders inline as a **cheap static SVG preview** (zero-dep) and, on demand, as an **interactive tldraw canvas**.
- The operator edits that canvas with tldraw's own UI; edits are **staged in the browser**, never auto-sent.
- A **Send** control rasterizes the current canvas to a **PNG** and posts it back via `POST /api/files` → message-with-`fileIds`, **plus** attaches the source **DSL** as a sidecar file.
- **Zero runtime npm dependency** in orchestrator/dashboard: tldraw ships as a **pre-built, committed, vendored bundle**, served by the static-asset path, **lazy-loaded only when the operator opens a canvas**.
- **iframe isolation** that is a *real* boundary: tldraw + React run inside a sandboxed iframe whose script-execution context is **NOT same-origin with the dashboard** (§5.1); the dashboard talks to it only over a typed `postMessage` protocol and never imports React.

**Non-Goals**
- No multiplayer / real-time collaborative editing (no `tldraw sync`, no server store).
- No round-trip of a tldraw *snapshot* document to the agent — the agent receives the **PNG + the source DSL** (not the brittle snapshot JSON, §7.1).
- No tldraw plugins, custom shapes, or asset uploads inside the canvas in v1.
- No engine/adapter change; no global system-context injection of the DSL convention (§1.1d).

---

## 4. Decision: Option A — vendored tldraw + React, iframe-isolated, lazy-loaded, PNG + DSL sidecar on Send

### 4.1 Zero-runtime-dep justification — and the honest admission of an offline build step

The repo's north-star constraint is **zero runtime npm dependencies** (`node --test`, no `npm install`, `.ts` served type-stripped). tldraw is a React SDK. Reconciling these, honestly:

- **The orchestrator and dashboard runtime gain ZERO new runtime dependencies.** No entry is added to any app `package.json` `dependencies`. `npm install` is still not part of running the app. The orchestrator serves static files and type-strips `.ts`; it never imports React or tldraw.
- **Honest admission:** this **introduces an offline build step** — `tools/tldraw-bundle/` with its own `package.json` (tldraw + react + react-dom + esbuild) — and the base project's ethos forbids a build step **for the live app**. The justification, stated plainly so the reviewer does not have to extract it: the bundler is **dev-only, exactly like `typescript` is already a dev-only tool in this repo**. The **runtime never builds it**, **CI never builds it**, the container never builds it. A human runs the bundler offline on a deliberate upgrade; the **committed bundle is the artifact** the runtime consumes (a `.js` file), and the artifact — not the tool — is what ships. This is the one sanctioned exception and it is bounded by §4.5 (the committed bundle must match a reproducible build) and §4.6 (CVE-rot ownership).
- **Supply-chain posture is BETTER than a live dep, not worse** (per `assume_risk_from_all_supply_chain`): a vendored, pinned, committed bundle is reviewed once and frozen — it cannot silently update under us. A live `dependencies` entry can pull a compromised patch on any reinstall. Provenance (version, build command, checksums, size) is recorded next to it (§4.2) **and** verified in CI (§4.5).
- **iframe-isolated.** The bundle never enters the dashboard's module graph; the React world is sealed behind the iframe boundary (§5.1) and a `postMessage` wire.

This is the same call RFC-008 made for Telegram ("take the capability, not the runtime dependency") applied to a UI dependency.

### 4.2 The vendored bundle — build, location, serving

**Build dir (offline, one-off, human-run on upgrade):** `tools/tldraw-bundle/` — a top-level dev tool (per `top_level_tools_for_cross_skill_dev_tools`), NOT under `src/`. It has its **own** `package.json` (the ONLY place tldraw + react + react-dom + esbuild appear; never installed by the app, never referenced by the runtime).

```
tools/tldraw-bundle/
  package.json          # tldraw, react, react-dom, esbuild — dev-only, NOT the app's
  entry.tsx             # iframe-side runtime: postMessage handler, DSL→shape translation,
                        # connector-binding computation, export-to-PNG, raster-ceiling guard
  build.mjs             # esbuild: bundle entry.tsx → ESM, minify, bundle CSS, inline assets
  README.md             # exact build command, upgrade steps, checksum-record steps, CVE-rot ritual
  tools/README.md entry # one line in the top-level tools/README per top_level_tools rule
```

`build.mjs` runs esbuild with `bundle: true`, `format: 'esm'`, `minify: true`, `define: { 'process.env.NODE_ENV': '"production"' }` (drops React dev code), `loader` entries to **inline** tldraw's self-hosted fonts/icons as data URIs (`getAssetUrls` from `@tldraw/assets/selfHosted` — **no runtime CDN fetch**), and CSS emitted as a sibling `tldraw.bundle.css`. Output:

```
src/dashboard/vendor/tldraw/
  tldraw.bundle.js       # self-contained ESM: tldraw + react + react-dom + iframe runtime
  tldraw.bundle.css      # tldraw.css (+ extracted CSS)
  VENDOR.md              # REQUIRED contents — see below
```

**`VENDOR.md` REQUIRED contents (a leaf-bound deliverable, not prose):**
- exact `tldraw` version (e.g. `4.x.y`) and exact `react` + `react-dom` versions,
- exact `esbuild` version,
- the **exact build command** (`pnpm --dir tools/tldraw-bundle build` with any flags),
- the **sha256 of each output file** (`tldraw.bundle.js`, `tldraw.bundle.css`),
- the **measured size** (minified bytes + gzipped bytes) of each output,
- the `style-src` measurement result (§9.2 — whether tldraw needs `'unsafe-inline'`),
- the licenseKey-injection note + the **deploy prerequisite** (register a free hobby key for the prod domain, §1.0),
- the CVE-rot owner + review cadence (§4.6).

- tldraw ships **ESM** and is designed to be bundled, so single-file ESM output is the supported path. ([Installation docs](https://tldraw.dev/installation))
- **No runtime CDN dependency**: fonts/icons inlined; the browser fetches nothing from `tldraw.com`/`unpkg`/`jsdelivr`. (A *trial* key would send a hashed key + deploy URL to tldraw for analytics; a **hobby/commercial** key validates client-side and works fully offline — we use the hobby key, so offline.)

**Approximate size:** the full tldraw editor + React + react-dom minified is large — order of **~1.5–2.5 MB minified (~400–700 KB gzipped)** ([issue #5256](https://github.com/tldraw/tldraw/issues/5256)). The exact number is **measured at build time, recorded in `VENDOR.md`, and asserted by Q1's check**. Because the iframe loads only when the operator **clicks "open canvas"** (§1.1c), it costs nothing on the normal text-chat path **and** nothing on the inline-SVG-preview path.

### 4.3 Serving — the concrete gaps to close

The existing asset server (`routes.ts`) whitelists only `.js`, `.ts`, `.css` in `ASSET_TYPES`, serves from `/dashboard/assets/:path+` and `/dashboard/shared/:path+`, and serves `.js` **as-is** (only `.ts` is type-stripped). `warmDashboardAssets()` walks `src/dashboard` at boot and pre-caches supported extensions. Gaps:

1. **`warmDashboardAssets` would read+cache the multi-MB bundle at boot.** Q1 adds an exclusion: the boot walk **skips `vendor/`**; the bundle loads lazily on first canvas-open, cached on demand by `loadAssetEntry`, mtime-keyed like everything else.
2. **The iframe host page is `.html`, not in `ASSET_TYPES`.** Q1 adds a **dedicated route** `GET /dashboard/sketch-frame` returning the host HTML directly (mirroring `/dashboard` and `/filter-test`), rather than widening the asset whitelist to `.html` (narrower blast radius). **NOTE:** the host page is served as the iframe `src` only in the *fallback* same-origin path; the **default** sandbox path uses `srcdoc`/blob (§5.1) and serves the bundle bytes via the vendor route. The route exists either way (the blob/srcdoc HTML still `<script src>`-loads the bundle from the vendor route).
3. **A vendor route `GET /dashboard/vendor/:path+`** (same shape as `/dashboard/assets/:path+`, same content-type whitelist, same etag/mtime caching) serves the bundle files — **with the hardened path guard from §9.3, not the substring `..` check.**

### 4.4 Rebuild on upgrade

Upgrading tldraw is a deliberate human action, never automatic:

1. Bump the tldraw (and react/react-dom if needed) version in `tools/tldraw-bundle/package.json`; `pnpm install` **inside that dir only**.
2. Run `pnpm --dir tools/tldraw-bundle build` → regenerates `src/dashboard/vendor/tldraw/*`.
3. Update `VENDOR.md` with new versions, build command, esbuild version, fresh sha256s, fresh sizes, and the `style-src` re-measurement.
4. Manually open a sketch in the dashboard; verify render + edit + export still work; run the Q4 tests including the production-mode path.
5. Commit the regenerated bundle in a dedicated `chore(deps): bump vendored tldraw to X.Y.Z` PR so the diff is reviewable as "binary-ish blob changed, here's why," and the **CI reproducible-build check (§4.5) re-verifies the sha256**.

### 4.5 "Frozen" must be VERIFIABLE — CI reproducible-build check

"Frozen" is not "trust me." A CI check (a `node --test`, runs in the normal suite, **does not** itself run esbuild) asserts the committed bundle matches its recorded provenance:

- Recompute `sha256(src/dashboard/vendor/tldraw/tldraw.bundle.js)` and `.css` and assert each equals the value recorded in `VENDOR.md`. A drifted bundle (someone hand-edited it, or a rebuild was committed without updating `VENDOR.md`) fails CI.
- Assert each output is a single non-empty file and that the measured size in `VENDOR.md` is within a tolerance of the actual file size.
- The **fully reproducible build** (re-running esbuild and getting byte-identical output) is a stronger guarantee that requires installing the dev toolchain; it is run **manually on upgrade** (step 4.4.4) and documented in `tools/tldraw-bundle/README.md`. CI's cheap proxy is the sha256 match — it catches the realistic failure mode (post-hoc tampering / un-recorded rebuild) without making CI build React.

### 4.6 CVE-rot ownership — the vendored bundle has no `npm audit` signal

A committed bundle gets **no** `npm audit` / Dependabot alerting. That gap is owned, not ignored:

- **Owner:** `agentic-collab-lead` (the persona that authored this RFC) is the named CVE-rot owner of the vendored tldraw bundle, recorded in `VENDOR.md` and `tools/tldraw-bundle/README.md`.
- **Cadence:** a **quarterly** manual review (check tldraw + react release notes / GitHub Security Advisories for the pinned versions) **plus** an **on-disclosure** trigger (any CVE published against tldraw / react / react-dom at or below the pinned version → review immediately). The review either confirms "no action" (recorded with date in `VENDOR.md`) or runs the §4.4 rebuild ritual to pull the patched version.
- This ritual is documented in `tools/tldraw-bundle/README.md` as a checklist so any agent/operator can run it.

### 4.7 Architecture at a glance

```
 Dashboard (vanilla TS, no React)                  Sandboxed iframe (NOT same-origin — srcdoc/blob)
 ┌───────────────────────────────────────┐         ┌──────────────────────────────────────────┐
 │ chat.ts: detect ```sketch``` on RAW    │         │ host HTML (srcdoc/blob) loads             │
 │   text BEFORE escape+markdown (§7.4)   │         │   /dashboard/vendor/tldraw/*.js/.css       │
 │ render cheap inline SVG preview (DSL)  │         │  <Tldraw licenseKey=…> (or none in dev)    │
 │   + "click to open canvas" button      │         │  DSL → editor.createShapes(...)            │
 │                                        │  init ─▶ │  + connector bindings by id (§7.2)         │
 │ on click → mount <iframe sandbox=…>    │  load ─▶ │  staged edits live in tldraw store         │
 │   (allow-scripts only; cross-origin    │ ◀ ready  │                                            │
 │    via srcdoc/blob)                     │ ◀ dirty  │  raster-ceiling guard (§9.4) before        │
 │ Greenroom chrome: header + Send + Reset│ export ▶ │   editor.toImage([],{format:'png'})        │
 │ on Send: postMessage export-request    │◀ export  │   → Blob → dataURL                          │
 │   → upload PNG (primary) to /api/files  │  (PNG)   │                                            │
 │   → upload DSL sidecar to /api/files     │         │                                            │
 │   → POST /api/dashboard/send (fileIds)  │         │                                            │
 └───────────────────────────────────────┘         └──────────────────────────────────────────┘
```

---

## 5. The iframe host + postMessage protocol

### 5.1 Sandbox — the BLOCKER fix: do NOT ship `allow-same-origin allow-scripts`

**Adversarial security finding (binding):** shipping `sandbox="allow-scripts allow-same-origin"` makes the sandbox a **no-op** — with both flags, the framed document runs scripts *in the dashboard's own origin*, so an agent-DSL-triggered tldraw/React 0-day could read the dashboard's auth token / `localStorage` / cookies and exfiltrate them. The sandbox would isolate nothing.

**Resolution (concrete):** the iframe runs **cross-origin to the dashboard** so `postMessage` works **without** `allow-same-origin`, by serving the iframe document via **`srcdoc` (or a `blob:` URL)**:

- The dashboard mounts:
  ```html
  <iframe
    sandbox="allow-scripts"
    referrerpolicy="no-referrer"
    title="sketch canvas"
    srcdoc="<!doctype html>…host page that <script type=module src=/dashboard/vendor/tldraw/tldraw.bundle.js>…">
  </iframe>
  ```
  A `srcdoc` document with `sandbox="allow-scripts"` (and **without** `allow-same-origin`) runs in an **opaque origin** (`origin === "null"`). Scripts run (React works), but the frame has **no access to the dashboard's origin** — no shared `localStorage`, no cookies, no token. `postMessage` still works across the opaque-origin boundary; the message-channel design (§5.3) is the only contact surface.
- **Origin validation under opaque origin:** because the frame's origin is `"null"`, the parent validates `event.source === iframe.contentWindow` (identity check) and the parent posts to the frame with `targetOrigin: "*"` is **not** used — the parent uses the frame's window reference directly and validates the source on replies; the frame validates that messages come from `window.parent` and that its received `init` carries a one-time **handshake nonce** (§5.3) the parent generated, so a third party that somehow got a window handle cannot drive it. The frame replies with `event.source.postMessage(msg, "*")` only after the nonce handshake; payloads carry no secrets (the license key is the one config value, see below).
- **Why the bundle still loads under opaque origin:** the `<script src="/dashboard/vendor/tldraw/tldraw.bundle.js">` is a *subresource fetch* from the parent's origin, which an opaque-origin sandboxed frame is permitted to make (it is a normal same-site GET; the response just must not require credentials/CORS that the opaque origin can't satisfy — it doesn't, it's a static asset). The CSP (§9.2) `script-src 'self'` on the **frame document** must allow this; measured at vendor time.
- **License key under opaque origin:** the key is delivered in the `sketch:init` payload after the nonce handshake. tldraw validates it client-side against the **document's URL/domain**; for a `srcdoc` opaque-origin frame the effective host is the parent's host (the browser reports the embedding context for license purposes via the embedding URL). **This must be verified at vendor time** — if tldraw's license check rejects the opaque-origin/`srcdoc` host, the documented fallback is below.
- **Sandbox grants:** `allow-scripts` **only**. We do NOT grant `allow-same-origin`, `allow-top-navigation`, `allow-popups`, `allow-forms`, `allow-modals`, `allow-pointer-lock`, or `allow-downloads`.

**Documented fallback if `srcdoc`/opaque-origin breaks tldraw's storage or license check (justified in writing, bounded by CSP):** if vendor-time testing shows tldraw genuinely requires same-origin (it uses `IndexedDB`/`localStorage` for some features, and the license check may key off the document origin), the fallback is to serve the frame from a **dedicated, credential-free sub-path origin is not available on a single host** — so instead we keep it same-origin **but** strip the attack value: (a) the dashboard's auth token must **not** live in a storage surface a same-origin frame can read (move it to an `HttpOnly` cookie or keep it only in the top frame's closure, never `localStorage`/`sessionStorage`), and (b) the frame document is locked down with the strict CSP (§9.2) so even executing 0-day code can only `connect-src 'self'` (exfil to a third party is blocked) and cannot navigate top. This fallback is **only** taken if `srcdoc` provably fails, and the failure + the chosen mitigation are recorded in `VENDOR.md`. **Default is `srcdoc`/opaque-origin (no `allow-same-origin`).** Q1 tests the default; Q4 confirms it end-to-end before any fallback is considered.

### 5.2 Inline preview vs interactive canvas (UX default 1.1c)

- **Default render:** `chat.ts` renders a **static SVG** from the validated DSL (vanilla TS, no iframe) inside the Greenroom block, plus a **"open canvas"** button.
- **On click:** mount the sandboxed iframe (above), load the bundle, post `init` + `load`, swap the SVG preview for the live canvas. The heavy React tree exists only after a deliberate click.

### 5.3 Protocol

All messages are JSON objects with a `kind` discriminator (per `kind_is_the_discriminator`) and `v: 1`. Types live in **`src/shared/sketch-protocol.ts`**, referenced by both the dashboard (`.ts`) and the iframe runtime (built from `tools/tldraw-bundle/entry.tsx`).

A **handshake nonce** secures the opaque-origin channel: when the dashboard mounts the iframe it generates a `crypto.randomUUID()` nonce, includes it in `sketch:init`, and the iframe echoes it in every subsequent message; the parent drops any message whose nonce doesn't match.

**Parent → iframe:**

| `kind` | payload | meaning |
|---|---|---|
| `sketch:init` | `{ v, nonce, licenseKey?: string, readOnly?: boolean, theme: 'greenroom-light' }` | sent once after the iframe posts `ready`; carries the handshake nonce, the optional license key (omitted in HTTP/localhost dev), and display prefs. |
| `sketch:load` | `{ v, nonce, doc: SketchDoc }` | the validated DSL (§7) to render. The iframe translates → `editor.createShapes(...)` + computes connector bindings. |
| `sketch:export-request` | `{ v, nonce, requestId, format: 'png', scale?: number, background?: boolean }` | rasterize the current canvas. |
| `sketch:reset` | `{ v, nonce }` | discard staged edits; re-render the original `sketch:load` doc. |

**iframe → parent:**

| `kind` | payload | meaning |
|---|---|---|
| `sketch:ready` | `{ v }` | bundle loaded, editor mounted; parent may now `init` + `load`. (No nonce yet — this is the only pre-handshake message.) |
| `sketch:dirty` | `{ v, nonce, dirty }` | the operator has/hasn't edited since load; drives the `· edited` marker (NOT Send's enabled state, per §1.1a). Debounced on store-change. |
| `sketch:export-response` | `{ v, nonce, requestId, ok: true, dataUrl, width, height }` or `{ …, ok: false, error }` | rasterized PNG as a data URL, correlated by `requestId`. `toImage` returns `undefined` on failure → `ok:false`. |
| `sketch:error` | `{ v, nonce, where, message }` | a parse/render/export failure to surface. |

- The PNG returns as a **data URL** (simplest cross-frame transfer for a one-shot blob). The parent converts to a `File`/`Blob` for upload. A transferable `ArrayBuffer` is a future optimization.
- The DSL sidecar (§1.1b) is built **parent-side** from the original validated DSL the parent already holds — it does NOT round-trip through the iframe. (The PNG is what reflects edits; v1 ships the **original** DSL as the sidecar, with a §14 open question on whether to round-trip the *edited* DSL later.)

---

## 6. Export to PNG (the Send result)

Inside the iframe, on `sketch:export-request` (AFTER the raster-ceiling guard, §9.4):

```ts
// editor captured from <Tldraw onMount={(e) => editor = e}>
const result = await editor.toImage([], { format: 'png', background: true, scale: CLAMPED_SCALE });
if (!result) { postBack({ kind: 'sketch:export-response', v: 1, nonce, requestId, ok: false, error: 'export failed' }); return; }
const dataUrl = await blobToDataUrl(result.blob);   // FileReader.readAsDataURL
postBack({ kind: 'sketch:export-response', v: 1, nonce, requestId, ok: true, dataUrl, width: result.width, height: result.height });
```

- `Editor.toImage(shapes, options)` is the current supported raster export; returns `{ blob, width, height }` (or `undefined` on failure). `exportToBlob` is deprecated in favor of it. ([Image export docs](https://tldraw.dev/sdk-features/image-export))
- Options: `format: 'png'`, `background: true` (Greenroom paper background, not transparency), `scale` **clamped** (§9.4) — a fixed crisp default capped so a malicious/huge canvas can't request a multi-gigapixel raster.

---

## 7. The agent → sketch DSL (LLM-friendly format)

### 7.1 A constrained shape-descriptor DSL, NOT raw snapshot JSON

An LLM asked for a **raw tldraw store snapshot** produces brittle, frequently-invalid output (internal record types, schema versions, fractional `index` keys, binding records, ProseMirror `richText` nodes). **We do NOT ask the agent for snapshot JSON.** The agent emits a **small, flat, LLM-friendly descriptor list**; the **iframe translates** it via `editor.createShapes(...)`. Robust because: the agent only names primitives it understands; the iframe owns the brittle bits (`toRichText()`, IDs, indices, defaults, bindings); an invalid descriptor fails **one shape**, not the doc.

### 7.2 The DSL (extended per the LLM-feasibility review)

The LLM-feasibility review found that **absolute-coordinate-only descriptors produce mush** — an LLM cannot reliably hand-place boxes, and arrows drawn by raw coordinates **drift** when the operator moves a box. The DSL is extended so the agent declares **structure** and the iframe computes pixels + bindings.

A fenced block with info-string `sketch` containing a JSON object `{ "shapes": [...], "layout"?: {...} }` (an object, not a bare array, so we can carry doc-level `layout` and future fields). Colors are tldraw's named palette (`black blue green red orange yellow violet light-blue light-green light-red light-violet grey white`).

````markdown
```sketch
{
  "shapes": [
    { "id": "orch",  "type": "rect",    "text": "Orchestrator", "color": "blue",   "z": 1 },
    { "id": "proxy", "type": "rect",    "text": "Proxy",        "color": "green",  "z": 1 },
    { "id": "db",    "type": "ellipse", "text": "SQLite",       "color": "violet", "z": 1 },
    { "id": "grp",   "type": "frame",   "text": "Docker :3000", "children": ["orch","db"] },
    { "type": "arrow", "from": "orch", "to": "proxy", "text": "HTTP" },
    { "type": "arrow", "from": "orch", "to": "db" }
  ],
  "layout": { "mode": "flow", "direction": "row", "gap": 48 }
}
```
````

**Descriptor schema (each item):**

| `type` | required | optional | notes |
|---|---|---|---|
| `rect` | (size/pos optional under layout) | `id, x, y, w, h, text, color, fill, z` | `geo` w/ `geo:'rectangle'` |
| `ellipse` | — | `id, x, y, w, h, text, color, fill, z` | `geo` w/ `geo:'ellipse'` |
| `text` | `text` | `id, x, y, w, color, z` | `text` shape |
| `note` | `text` | `id, x, y, color, z` | sticky note |
| `frame` | — | `id, x, y, w, h, text, children: id[], z` | container; `children` are shape ids it groups |
| `arrow` | one of: (`from`+`to`) or (`x1,y1,x2,y2`) | `id, text, color, z` | **connector-by-id preferred**: `from`/`to` reference shape `id`s → the iframe computes endpoints AND creates tldraw **bindings** so the arrow follows the boxes when moved. Raw coords are the fallback. |
| `line` | `points: [[x,y],…]` | `id, color, dash, z` | polyline |

**New DSL features (all binding into Q2's checks):**
- **`id`** — every shape may carry a stable id; referenced by connectors and frames. Ids are validated (string, bounded length, charset) and namespaced internally so a malicious id can't collide with tldraw record ids.
- **Connector-by-id** — `arrow`/`line` with `from`/`to` referencing shape ids. The iframe resolves the referenced shapes, computes endpoints, and creates tldraw **arrow bindings** so connectors **don't drift** when the operator moves a box. Dangling refs (id not present) → that one connector is dropped with a `sketch:error`, not the whole doc.
- **`frame`/container** — a `frame` shape grouping `children` ids, so the agent can express "these boxes live in this container."
- **z-order** — optional `z` integer per shape; the iframe maps it to tldraw's fractional `index` ordering (the agent never touches fractional indices).
- **Relative / flow layout** — optional doc-level `layout: { mode: 'flow', direction: 'row'|'col', gap, ... }` (or per-shape layout hints). When present, the agent may **omit absolute coords**; the iframe computes positions (row/col with gaps, simple flow). Absolute coords still work and override layout for a given shape. This is the lever that lets the agent declare structure and the iframe compute pixels.

**Translation:** the iframe's translator is a `Record<descriptorType, (d, ctx) => TLShapePartial[]>` lookup (per `dispatch_is_a_lookup_not_a_chain`), where `ctx` carries the id→shape map (for connector resolution) and the computed layout positions. Defaults fill omissions (`color` → `black`, `fill` → `none`, `size` → `m`). Shape `props` are exactly the tldraw partials confirmed in the docs ([default shapes](https://tldraw.dev/sdk-features/default-shapes)).

### 7.3 How the agent learns the DSL (UX default 1.1d)

The DSL spec lives at **`/docs/sketch-dsl`**, rendered by the existing docs route. **Concrete wiring (from the codebase):** the docs route (`routes.ts` `/docs/:page`) reads `src/docs/<page>.md` and looks up the title in the **hardcoded `DOC_PAGES` array** in `src/docs/render.ts`. So `/docs/sketch-dsl` requires BOTH: a new file `src/docs/sketch-dsl.md` AND a new entry `{ slug: 'sketch-dsl', title: 'Sketch DSL' }` pushed into `DOC_PAGES`. **Without the `DOC_PAGES` entry the page renders with a fallback title and is missing from the docs nav** — Q2's check asserts both exist. Personas opt in by referencing `/docs/sketch-dsl` in their persona file; the convention is NOT injected into all agents' system context (§1.1d).

### 7.4 Detection BEFORE escape+markdown — the trap (documented so Q2 doesn't rediscover it)

**Binding LLM-feasibility/code finding.** In `chat.ts`, `renderMessageBody` (line ~584-588) does:
```ts
const normalized = text.replace(/\n{3,}/g, '\n\n').trim();
let html = escapeHtml(normalized);   // ← text is now HTML-escaped
html = renderMarkdown(html);          // ← runs on already-escaped text
```
And `renderMarkdown` (`src/shared/markdown.ts` line 14) extracts fences with:
```ts
escaped.replace(/```(?:\w*)\n([\s\S]*?)```/g, (_m, code) => { … })
```
**Two facts that bite if ignored:** (1) the info-string `(?:\w*)` is **non-capturing and DISCARDED** — by the time markdown runs, "is this a `sketch` fence?" is **unanswerable**; (2) the body is already **HTML-escaped**, so `"` is `&quot;`, breaking `JSON.parse`. **Therefore the sketch pre-pass MUST run on the RAW message text BEFORE `escapeHtml` and BEFORE `renderMarkdown`.** Q2's renderer change extracts ` ```sketch ` blocks from the raw `text` argument first (capturing the info-string and the raw, un-escaped body), validates with `parseSketchDsl`, replaces the block with a placeholder token, THEN runs the existing escape+markdown on the remaining text, THEN swaps the placeholder for the SVG-preview mount node. This ordering is non-negotiable and is asserted by a Q2 test that feeds a `sketch` block containing quotes/`<`/`&` and checks the JSON survived intact.

### 7.5 Renderer flow (chat.ts)

1. **Pre-pass on raw text** (§7.4): find ` ```sketch ` fences, `JSON.parse` + `parseSketchDsl` (§9.4) the un-escaped body.
2. **Valid** → replace with a placeholder; after escape+markdown, swap for a **mount node** carrying a `data-sketch-id` (shapes stashed by id, not inlined as a giant attribute) that renders the **static SVG preview** + "open canvas" button.
3. **Invalid** → render as a normal fenced code block (graceful fallback) + an inline ink-3 note "unparseable sketch — showing source."
4. A `wireSketches(root)` pass (sibling to `wireCollapsibleMessages`/`wireCopyOnClick`) wires the "open canvas" buttons → lazily mounts the iframe and posts `sketch:init` + `sketch:load` on `sketch:ready`.

---

## 8. Greenroom integration (the message-canvas chrome)

The editing UI **inside** the iframe is tldraw's own; we own the **chrome around the canvas** in the chat message, per the `ui-theme` skill (`REFERENCE.md`).

- **Inline preview state:** a bordered block (`1px solid var(--rule)`, `--radius-lg`, NO card shadow — inline content, not a floating overlay) containing the **static SVG** + a default `.btn` "Open canvas". The agent-identity 3px left border (Greenroom §9.2) already marks the message.
- **Opened (canvas) state:** a header strip — mono eyebrow `SKETCH` (10.5px, uppercase, ink-4) left; controls right. Canvas gets a fixed inline height (e.g. 360px), iframe fills width.
- **Controls** (Greenroom §7):
  - **Send** — the single **clay `.btn.primary`** (the one clay moment). **Always enabled** (§1.1a — rasterizes current canvas). Label: `Send sketch`.
  - **Reset** — a default `.btn`/`.btn.ghost`; posts `sketch:reset`.
- **Edited marker:** when `dirty`, a small mono ink-3 `· edited` note next to the eyebrow (status-as-text, no badge).
- **Loading:** italic ink-3 "loading canvas…" until `sketch:ready`.
- **No ambient motion**, transitions ≤200ms, one clay moment. Consistent with hard rules.
- The "made with tldraw" watermark renders inside the canvas (hobby license) — out of our control, acceptable.

---

## 9. Security

### 9.1 Origin / channel validation
- Opaque-origin frame (§5.1): parent validates `event.source === iframe.contentWindow` and the **handshake nonce** (§5.3) on every frame→parent message; pre-handshake only `sketch:ready` is accepted. The iframe validates messages come from `window.parent` and carry the matching nonce. Failing messages are dropped silently.
- Sandbox grants: `allow-scripts` **only** (NOT `allow-same-origin`); `referrerpolicy="no-referrer"`.

### 9.2 CSP — the app has NONE today; add it (BLOCKER fix)
The orchestrator sets only `content-type`/`etag`/`cache-control` headers — **no Content-Security-Policy anywhere**. Q1 adds CSP response headers on the dashboard surfaces:
- **`/dashboard`** and **`/dashboard/sketch-frame`** (and the `srcdoc` host document) get:
  `Content-Security-Policy: default-src 'self'; script-src 'self'; frame-src 'self'; frame-ancestors 'self'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:`
  - `connect-src 'self'` is the key exfil-blocker: even if a tldraw/React 0-day executes in the frame, it cannot phone home to a third party.
  - `img-src`/`font-src` include `data:`/`blob:` because the bundle inlines fonts/icons as data URIs and tldraw uses blob URLs for export.
- **`style-src`:** tldraw may inject inline styles at runtime; whether it needs `style-src 'unsafe-inline'` (vs `'self'`) is **measured at vendor time** and the result recorded in `VENDOR.md`. The RFC's default policy string uses `style-src 'self'`; if the measurement shows tldraw requires inline styles, the policy adds `'unsafe-inline'` for `style-src` ONLY (never for `script-src`), with the justification recorded. Q1's check asserts the CSP header is present on both surfaces; the exact `style-src` token is finalized by the §13 Q1 vendor-time measurement.

### 9.3 Path-traversal — fix the substring `..` check (BLOCKER fix)
The existing asset/shared routes guard with `filePath.includes('..')` (`routes.ts:294`, `:328`) — a **substring** check that **misses** URL-encoded `%2e%2e` (decoded by `URLPattern` before the handler sees it) and absolute paths (`/etc/passwd`). The new vendor route (and, as a hardening follow-on, the existing asset/shared routes) MUST instead:
```ts
import { resolve, join, sep } from 'node:path';
const root = resolve(import.meta.dirname!, '..', 'dashboard', 'vendor');
const full = resolve(root, filePath);
if (!(full === root || full.startsWith(root + sep))) { res.writeHead(400); res.end('Bad request'); return; }
```
Resolve the candidate path and assert it stays **under** the vendor root via `startsWith(root + sep)` (the `+ sep` prevents a `vendor-evil/` sibling from passing a bare `startsWith(root)`). Q1's check asserts `%2e%2e%2f…`, an absolute path, and a `vendor../`-style sibling are all rejected 400.

### 9.4 `parseSketchDsl` — the validator (BLOCKER fixes, both sides)
`parseSketchDsl(raw: unknown): SketchDoc | SketchDslFailure` lives in `src/shared/sketch-dsl.ts`, hand-rolled (per `handroll_validation_at_boundaries`), run on **both** sides (dashboard before SVG-preview/mount; iframe before `createShapes`). Required protections:
- **Prototype-pollution:** reject any object containing `__proto__`, `constructor`, or `prototype` as a key (at any depth) → `SketchDslFailure { kind: 'proto_key' }`. Parse with a guard that walks keys; do NOT trust `JSON.parse` to be safe against `{"__proto__": …}` reaching downstream object construction.
- **Explicit field-copy, never spread:** build each tldraw `TLShapePartial` by **copying named fields one-by-one** from the validated descriptor. NEVER `{ ...parsedDescriptor }` into `createShapes` — a parsed object must not smuggle unexpected keys into a tldraw record.
- **Numeric bounds:** every numeric field (`x,y,w,h,x1,y1,x2,y2,gap,z`, points) must be a **finite** number (reject `NaN`/`Infinity`/`-Infinity`) AND within a **concrete max magnitude** (e.g. `|value| ≤ MAX_COORD = 100_000`; `0 < w,h ≤ MAX_DIM = 50_000`). Out-of-bound → that shape's failure variant.
- **Caps:** `max N shapes` (e.g. 500), `max raw block size` (e.g. 64 KB), `text` length cap (e.g. 2 KB/shape), `id` length/charset cap, `points` count cap, `children` count cap. Over-cap → fail (block renders as plain code).
- **Palette/enum:** `color` ∈ allowed palette, `fill`/`dash` ∈ allowed sets, `type` ∈ known set. Unknown → reject that shape.
- **Export scale cap + raster ceiling INSIDE the iframe:** the `scale` in `sketch:export-request` is **clamped** to `[MIN_SCALE, MAX_SCALE]` (e.g. ≤ 2). **Before** calling `editor.toImage`, the iframe computes the would-be raster dimensions (canvas bounds × clamped scale) and enforces a **concrete raster ceiling** `width * height ≤ MAX_RASTER_PX` (e.g. 32 MP). Over-ceiling → `sketch:export-response { ok:false, error:'too large' }`, NOT an attempt. **We do NOT rely on the 100 MB `FILE_MAX_BYTES` upload backstop** (`routes.ts:1486`) to catch this — that is a last-resort net far above a sane image, and a 32 MP PNG can be well under 100 MB while still being an OOM/DoS risk to render. The ceiling lives at the rasterization point.
- `text` is only ever passed to `toRichText()` (tldraw text node, never HTML/markup). No `eval`, no `Function`, no payload-derived dynamic import.

### 9.5 License key handling
- The key is injected via `sketch:init` (§1.0), never committed. Stored as an orchestrator config value (env var → exposed to the dashboard via the existing config path / `getDashboardHtml`), read at runtime. Q4 asserts the key is in `sketch:init` and absent from any committed source/bundle. Rotating the key changes config only, not the bundle.

### 9.6 Lazy mount
The iframe is created **only on "open canvas" click**, at most once per sketch message; inline previews are static SVG. A feed of many sketches mounts zero iframes until clicked (`chat.ts` already virtualizes to ~50–100 nodes).

---

## 10. Bundle-size / performance

- **Normal text chat AND inline previews pay nothing** — no React/tldraw on those paths; previews are vanilla SVG.
- **Bundle excluded from `warmDashboardAssets`** (§4.3.1); fetched only on first canvas-open; cached (etag/mtime).
- **Measured at build time**, recorded in `VENDOR.md`, asserted by Q1. ~1.5–2.5 MB min / ~400–700 KB gzip for the full editor — acceptable behind a deliberate click.
- **Per-iframe cost** is one React tree, mounted only on click; the SVG-preview default keeps the feed light by construction.

---

## 11. Rejected alternatives

- **Option B — tldraw from a CDN (esm.sh / unpkg / jsdelivr).** Rejected. A runtime third-party fetch is a live supply-chain dependency that can change or vanish under us, violates the repo ethos (`assume_risk_from_all_supply_chain`, zero-runtime-dep), and adds a hard network dependency for a tool that may run on an isolated tailnet. Vendoring is strictly safer and self-contained.

- **Option C — zero-dep vanilla SVG/canvas renderer of the SAME DSL (COSTED, honest accounting).** **Rejected, but for cost reasons, not impossibility — recorded so the choice is honest.** Option C would build an interactive editor in vanilla TS that consumes the **identical** §7 DSL (so the agent side, the docs, and the inline SVG preview are shared work either way) and edits/exports it with **no tldraw, no React, no iframe, no license, no CVE-rot owner, no offline build step, no opaque-origin security dance.** What it would cost to reach feature-parity with what Option A gets for free:
  - **Inline static SVG preview from the DSL** — ~0.5–1 day. *(Shared with Option A — we build this either way, §1.1c.)*
  - **Selection + move + resize handles** for rects/ellipses/text/frames — ~3–4 days (hit-testing, drag math, multi-select, snapping).
  - **Arrow/line drawing + connector re-binding on move** (so connectors don't drift) — ~2–3 days (the binding/geometry that tldraw gives free).
  - **Inline text editing** in shapes — ~2 days (contenteditable overlay, caret, wrap).
  - **Undo/redo** — ~1–2 days (command stack).
  - **PNG export** of an SVG/canvas scene with the Greenroom background + raster ceiling — ~1 day (`SVG → canvas → toBlob`, mostly zero-dep).
  - **Color picker / palette / dash / fill UI** — ~1 day.
  - **Total ≈ 10–16 dev-days** for a **worse** editor than tldraw, with ongoing maintenance of every editor bug we'd re-introduce.
  - **What C avoids (the honest other side):** the ~1.5–2.5 MB blob, the source-available license + watermark, the no-`npm-audit` CVE-rot surface, the offline build step the base project otherwise forbids, the iframe/opaque-origin security complexity, and tldraw upgrade churn. These are **real** costs Option A carries.
  - **Why A was still chosen:** the operator approved A explicitly; tldraw's editing UX (selection, transforms, bindings, undo, text) is mature and would take ~2–3 weeks to half-replicate; the costs C avoids are all **bounded and owned** (license = $0 hobby; CVE-rot = §4.6; build step = dev-only like `typescript`; security = §5.1/§9). C remains the **documented fallback** if those owned costs ever turn unacceptable (e.g. tldraw changes its license), and because both options share the DSL + SVG-preview, switching A→C later is not a rewrite of the agent contract.

- **Sub-rejected — round-trip the editable tldraw *snapshot* JSON back to the agent.** Rejected for v1. We send PNG (primary) + **original DSL sidecar** (§1.1b), because (a) PNG matches how agents consume images with zero engine changes, and (b) snapshot JSON is the brittle path rejected in §7.1. Round-tripping the *edited* DSL (reconstructed from the tldraw store) is a §14 open question for a later RFC.

---

## 12. Risks + mitigations

| Risk | Mitigation |
|---|---|
| **`srcdoc`/opaque-origin breaks tldraw storage or license check.** | Tested at vendor time (Q1); documented same-origin fallback bounded by token-not-in-storage + strict CSP (§5.1); recorded in `VENDOR.md`. Default stays opaque-origin. |
| **CSP breaks tldraw rendering (inline styles).** | `style-src` measured at vendor time; `'unsafe-inline'` added for `style-src` ONLY if required, recorded in `VENDOR.md` (§9.2). |
| **Bundle is large.** | Lazy (click-to-open), off the default path, cached; excluded from boot warm-up; size recorded + checked (Q1). |
| **Vendored bundle has no `npm audit` signal (CVE rot).** | Named owner (`agentic-collab-lead`) + quarterly + on-disclosure rebuild ritual in `VENDOR.md`/README (§4.6). |
| **Committed "frozen" bundle silently tampered/rebuilt.** | CI sha256-match check vs `VENDOR.md` (§4.5); reproducible build on upgrade. |
| **tldraw upgrade breaks bundle / DSL translation.** | Deliberate human rebuild (§4.4) + Q4 tests (incl. production mode) + manual verify; never automatic. |
| **iframe message spoofing.** | Opaque origin + `event.source` identity + handshake nonce both ways; `allow-scripts` only; payload validated as data (§9). |
| **Prototype pollution via DSL.** | `parseSketchDsl` rejects `__proto__`/`constructor`/`prototype`; explicit field-copy, never spread (§9.4). |
| **Raster DoS / OOM via huge export.** | Scale clamp + raster ceiling INSIDE the iframe before `toImage`, not relying on the 100 MB upload net (§9.4). |
| **Path traversal on vendor route.** | `resolve()` + `startsWith(root + sep)`, not substring `..` (§9.3). |
| **Invalid agent DSL.** | Validator both sides; invalid block degrades to plain code + note; one bad shape/connector doesn't kill the doc. |
| **Connector drift when boxes move.** | Connector-by-id → tldraw bindings (§7.2); raw-coord arrows are fallback only. |
| **Detection-ordering trap (escaped text / discarded info-string).** | Pre-pass on RAW text before escape+markdown, documented + tested (§7.4). |
| **PNG export fails on edge shapes** ([#3868](https://github.com/tldraw/tldraw/issues/3868)). | `toImage` → `undefined` → `ok:false` → parent toasts "export failed"; pinned version verified at vendor time. |
| **LLM emits unusable sketches.** | Golden-corpus human-reviewed gate (Q4) validates the premise; green unit tests alone do not. |

---

## 13. Decomposition — Diamond DAG (each leaf check-bound)

Four quanta. **DAG: `Q1 → {Q2, Q3} → Q4`.** Q2 (render/preview/DSL/iframe-mount) and Q3 (staging/Send/export/upload) are independent after Q1 and run in parallel; Q4 proves the whole, including the golden-corpus gate and the production-mode license path. Every leaf below names a `node --test` or Playwright check; substrate (the iframe-boundary stub, the SVG-render helper, the Playwright seeded-message fixture) is in scope by construction.

### Q1 — Vendored bundle + opaque-origin iframe host + CSP + hardened routes + postMessage skeleton
**Scope:** `tools/tldraw-bundle/` (package.json, entry.tsx skeleton, build.mjs, README incl. CVE-rot ritual + reproducible-build steps); committed `src/dashboard/vendor/tldraw/{tldraw.bundle.js,tldraw.bundle.css,VENDOR.md}`; `src/shared/sketch-protocol.ts` (message types + nonce); routes: `GET /dashboard/sketch-frame` (host HTML) + `GET /dashboard/vendor/:path+` (bundle, **hardened path guard**); `warmDashboardAssets` skips `vendor/`; **CSP headers** on `/dashboard` + `/dashboard/sketch-frame`; the iframe runtime mounts `<Tldraw>` (optional `licenseKey`), posts `sketch:ready`, accepts `sketch:init` with nonce. **Vendor-time measurements** (recorded in `VENDOR.md`): bundle sha256 + size; whether `style-src 'unsafe-inline'` is needed; whether `srcdoc`/opaque-origin works with tldraw storage + license.
**Checks (build substrate first):**
- `node --test` — `GET /dashboard/sketch-frame` → 200 `text/html`, body references the vendor bundle URLs. *(check: `routes.sketch-frame.test.ts`)*
- `node --test` — `GET /dashboard/vendor/tldraw/tldraw.bundle.js` → 200 `application/javascript`, served un-stripped, with an etag. *(`routes.vendor-serve.test.ts`)*
- `node --test` — **path-traversal hardening**: `%2e%2e%2f`-encoded traversal, an absolute path, and a `vendor../` sibling are each rejected 400 via the `resolve()`+`startsWith(root+sep)` guard. *(`routes.vendor-traversal.test.ts`)*
- `node --test` — `warmDashboardAssets()` caches nothing under `vendor/` (assert no `vendor/` key in the asset cache after a warm). *(`routes.warm-skips-vendor.test.ts`)*
- `node --test` — **CSP present**: `GET /dashboard` and `GET /dashboard/sketch-frame` both return a `Content-Security-Policy` header containing `script-src 'self'`, `frame-ancestors 'self'`, and `connect-src 'self'`. *(`routes.csp.test.ts`)*
- `node --test` — **reproducible-build / frozen check**: recomputed sha256 of `tldraw.bundle.js` and `.css` equals the value in `VENDOR.md`; each output is a single non-empty file; recorded size within tolerance of actual. *(`vendor.sha256.test.ts`)*
- `node --test` — `VENDOR.md` parses and contains all REQUIRED fields (§4.2): tldraw/react/esbuild versions, build command, both sha256s, both sizes, the `style-src` measurement, the licenseKey/deploy-prereq note, the CVE-rot owner + cadence. *(`vendor.manifest.test.ts`)*
- `node --test` — `sketch-protocol.ts` round-trips: a sample of each `kind` validates against the type guards; the nonce handshake rejects a missing/mismatched nonce. *(`sketch-protocol.test.ts`)*

### Q2 — DSL validator + inline SVG preview + detection-before-escape + interactive iframe mount + docs page
**Scope:** `src/shared/sketch-dsl.ts` (`parseSketchDsl` per §9.4 + `SketchDoc`/`SketchShape`/`SketchDslFailure` types, shared both sides); the iframe translator (`descriptor → TLShapePartial[]` lookup with id-resolution, connector bindings, layout computation, z-order, field-copy); `chat.ts` **pre-pass on RAW text** (§7.4) → `parseSketchDsl` → placeholder → static-SVG-preview mount node + "open canvas"; `wireSketches(root)` lazily mounts the opaque-origin iframe and posts `sketch:init`+`sketch:load` on `sketch:ready`; `src/docs/sketch-dsl.md` + a `DOC_PAGES` entry `{ slug:'sketch-dsl', title:'Sketch DSL' }`.
**Checks:**
- `node --test` — `parseSketchDsl`: valid doc → typed shapes (single `assert.deepEqual` per shape case); each invalid case → the right `SketchDslFailure` variant: non-object/non-array `shapes`, unknown `type`, **`__proto__`/`constructor`/`prototype` key**, non-finite coord, **out-of-bound coord/dim**, bad `color`/`fill`/`dash`, over-cap shape count, over-cap raw size, oversized `text`, bad `id` charset/length, dangling connector `from`/`to`, over-cap `points`/`children`. *(`sketch-dsl.test.ts`)*
- `node --test` — **field-copy, never spread**: a descriptor carrying an extra unexpected key produces a `TLShapePartial` that does NOT contain that key (assert the translated partial's keys are exactly the allowed set). *(`sketch-dsl.field-copy.test.ts`)*
- `node --test` — **connector-by-id**: `arrow` with `from`/`to` referencing present ids resolves to endpoints + a binding intent; a dangling ref drops that one connector with a `sketch:error`, leaving other shapes intact. *(`sketch-translate.connectors.test.ts`)*
- `node --test` — **layout/z-order**: a `layout: {mode:'flow',direction:'row',gap}` doc with omitted coords yields monotonically increasing x positions; `z` maps to ordered indices. *(`sketch-translate.layout.test.ts`)*
- `node --test` — **detection-before-escape (the trap)**: a `sketch` block whose JSON contains `"`, `<`, `&`, and `__proto__`-adjacent text is detected on RAW text and `JSON.parse`s intact (assert the parsed doc equals expected); a NON-sketch fence is untouched and still renders as a normal code block. *(`chat.sketch-detect.test.ts`)*
- `node --test` — the pre-pass turns a valid `sketch` block into an SVG-preview mount node (assert rendered HTML contains the mount node + `data-sketch-id`, NOT the raw JSON, and contains an "open canvas" control) and turns an invalid block into a plain code block + "unparseable sketch" note. *(`chat.sketch-render.test.ts`)*
- `node --test` — **inline SVG preview**: the DSL→SVG helper renders the expected `<rect>/<ellipse>/<text>/<line>` elements for a known doc (single `assert` on the element set), with no React/tldraw import. *(`sketch-svg.test.ts`)*
- `node --test` — **docs wiring**: `DOC_PAGES` contains `{slug:'sketch-dsl'}` and `src/docs/sketch-dsl.md` exists and is non-empty; `GET /docs/sketch-dsl` returns 200 with the page title in the nav. *(`docs.sketch-dsl.test.ts`)*

### Q3 — Edit-staging + Send (always-on) → export → upload (PNG + DSL sidecar) → post-back
**Scope:** `dirty` tracking (iframe posts `sketch:dirty` on store change, debounced) driving ONLY the `· edited` marker (Send is always enabled, §1.1a); Greenroom chrome (eyebrow, `· edited`, Send clay-primary, Reset); Send flow — parent posts `sketch:export-request` (clamped scale) → receives `sketch:export-response` (PNG dataURL) → converts to a `File` → `POST /api/files` for the **PNG (primary)** AND a second `POST /api/files` for the **DSL sidecar** (the original validated DSL as a `.sketch.json`/`.txt` file, §1.1b) → `POST /api/dashboard/send` with BOTH `fileId`s (reusing the `uploadFileToStorage` shape from `chat.ts`); `sketch:reset` discards staged edits.
**Checks:**
- `node --test` — export-response→upload glue (stub the postMessage boundary; mock `fetch` to `/api/files`): a PNG `File` is posted as the primary, a DSL sidecar `File` is posted, and BOTH returned `fileId`s flow into the `/api/dashboard/send` body. *(`sketch-send.upload.test.ts`)*
- `node --test` — **Send is always enabled** (asserts the button is enabled before any `dirty`), `dirty:true` only toggles the `· edited` marker, `sketch:reset` clears it. *(`sketch-send.dirty.test.ts`)*
- `node --test` — **`requestId` correlation**: a stale export-response for an old `requestId` is ignored; only the matching response triggers upload. *(`sketch-send.requestid.test.ts`)*
- `node --test` — **raster-ceiling guard** (iframe-runtime logic, unit-tested in isolation): an export whose computed `width*height` exceeds `MAX_RASTER_PX`, or `scale` outside `[MIN,MAX]`, returns `ok:false` WITHOUT calling `toImage` (assert the `toImage` stub was not called). *(`sketch-export.ceiling.test.ts`)*

### Q4 — End-to-end Playwright + production-mode license path + golden-corpus gate + visual proof
**Scope:** an end-to-end Playwright flow (ui-testing skill / playwright-workbench) over a dashboard seeded with a sketch message; the production-mode license assertion (§1.0); the **golden-corpus** human-reviewed validation of the LLM premise; a committed screenshot for the design record; full-suite + typecheck gates.
**Checks:**
- **Playwright** — sketch message → inline SVG preview present → click "open canvas" → iframe mounts (sandbox `allow-scripts`, NO `allow-same-origin`) → `sketch:ready` observed → canvas non-empty → Send → feed gains a PNG image attachment AND a DSL sidecar attachment. Green, non-flaky. *(`e2e/mock/sketch.spec.ts`)*
- **Playwright** — **production mode**: served over HTTPS on a non-localhost host (or detection inputs forced to the production branch), assert the canvas renders with a `licenseKey` injected in `sketch:init` and that no committed source/bundle contains the key. *(`e2e/mock/sketch-production-license.spec.ts`)*
- **Golden-corpus gate** — 5–8 real prompts (e.g. "draw the orchestrator/proxy architecture", "wireframe the dashboard composer", "box-and-arrow the agent state machine") → an agent emits `sketch` DSL → each renders → a **human reviews each screenshot for non-garbage** (legible, structurally correct, not overlapping mush). Stored under `e2e/golden-corpus/` with the prompts, the emitted DSL, and the reviewed screenshots; the gate is a human sign-off recorded in the PR, NOT a pixel-diff. This validates the premise that LLMs can drive the DSL — **green unit tests alone do not.** *(`e2e/golden-corpus/` + PR sign-off)*
- **Visual proof** — a committed screenshot (visual-verify-html / playwright-workbench) of the rendered sketch block (inline preview + opened canvas) in Greenroom chrome, reviewed against `ui-theme` (one clay moment = Send; bordered block; no card shadow; mono eyebrow). *(committed PNG + design review)*
- **Suite gates** — full `node --test` green; `pnpm typecheck` shows no new errors (judge by per-file delta per the repo's tsc-baseline note). *(CI)*

---

## 14. Open questions for the operator (residual — defaults already chosen; flag any veto)

The license tier and the four UX defaults (§1.1) are **decided** (operator-approved). These remain genuinely open:

1. **Round-trip the EDITED DSL?** v1's sidecar is the agent's **original** DSL (§1.1b). Reconstructing the *edited* DSL from the tldraw store (so an agent re-edits exactly what the operator drew) is harder (it inverts the §7 translation). Default: ship original-DSL sidecar now, edited-DSL round-trip in a later RFC. **Confirm or veto.**
2. **`srcdoc`/opaque-origin vs same-origin fallback (§5.1):** the default is opaque-origin (no `allow-same-origin`). If vendor-time testing (Q1) shows tldraw's license check or storage genuinely needs same-origin, we take the documented fallback (token-not-in-storage + strict CSP). **Operator: confirm the fallback is acceptable if forced, or require a hard stop + escalation instead.**
3. **Golden-corpus reviewer + threshold (§13 Q4):** who signs off the 5–8 corpus screenshots, and what counts as "passing" (all 8 legible? 6/8?). Default: the operator (or a delegated agent) signs off; ≥ 6/8 non-garbage to ship, with the failures logged as DSL/translation follow-ups. **Confirm the reviewer + threshold.**
4. **Broader agent adoption (§1.1d):** when do we promote from opt-in-per-persona to injecting the DSL convention into all agents' system context? Default: after the golden corpus passes on 2–3 personas and the feature has run in production for a sprint. **Confirm the promotion trigger.**
