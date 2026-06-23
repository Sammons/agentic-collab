# Vendored tldraw bundle — provenance (RFC-010 §4.2)

This directory holds a **pre-built, committed, frozen** bundle of tldraw + React,
the iframe-side runtime for the AI sketch canvas. The runtime serves these files
as static assets; it NEVER builds them. The bundler lives at
`tools/tldraw-bundle/` and is run offline, by hand, on a deliberate upgrade only
(RFC §4.1, §4.4). The repo-root `package.json` has ZERO runtime dependencies; the
bundle is an artifact, not an npm dependency.

## Exact versions (pinned in `tools/tldraw-bundle/package.json`)

| Package | Version |
|---|---|
| `tldraw` | 5.1.1 |
| `react` | 19.2.7 |
| `react-dom` | 19.2.7 |
| `@tldraw/assets` | 5.1.1 |
| `esbuild` | 0.28.1 |
| `typescript` (dev-only, for `entry.tsx` typecheck) | 5.8.3 |
| `@types/node` / `@types/react` / `@types/react-dom` (dev-only) | 24.13.2 / 19.2.17 / 19.2.3 |

> RFC-010 was authored when tldraw 4.x was current and refers to "tldraw (4.x)".
> The current stable line is 5.1.1 (with React 19); the license terms, the
> `<Tldraw licenseKey>` prop, `Editor.toImage`, the named color palette, and
> `getAssetUrlsByImport` are unchanged across 4 → 5. The operator approved
> "full Option A, free hobby tier + watermark"; the major version is the
> vendor-time choice the RFC explicitly defers to this file. Pinned exact.

## Build command

Run from the repo root (after `pnpm install` inside the tools dir on a version bump):

```
pnpm --dir tools/tldraw-bundle install   # first time / on a version bump
pnpm --dir tools/tldraw-bundle build     # → regenerates this directory
```

`tools/tldraw-bundle/build.mjs` runs esbuild with: `bundle: true`,
`format: 'esm'`, `minify: true`, `platform: 'browser'`, `target: es2022`,
`define: { 'process.env.NODE_ENV': '"production"' }` (drops React dev code), and
the `.svg / .woff2 / .woff / .png / .gif / .json` loaders set to `dataurl` so
every tldraw font/icon/translation inlines as a data URI — **no runtime CDN
fetch** (see "No runtime CDN" below). CSS is emitted to a sibling
`tldraw.bundle.css`.

## Committed output files — sha256 + size (asserted by `vendor.sha256.test.ts`)

| File | sha256 | minified bytes | gzipped bytes |
|---|---|---|---|
| `tldraw.bundle.js` | `014dd39c46e2499160ea9d402393f229a50c14813fbe716114f6c4fac691a7ef` | 5787960 (5.52 MB) | 2305631 (2.20 MB) |
| `tldraw.bundle.css` | `073c17a72f279691acbe3ae79609f26a99fbe5cebf36e4e19fa05a99ea5f216c` | 77119 (75.3 KB) | 14396 (14.1 KB) |

The JS is larger than the RFC's ~1.5–2.5 MB estimate because all fonts + the
merged icon SVG + all locale JSON inline as base64 data URIs (base64 inflates
binary ~33%), the price of the zero-CDN posture. It is lazy-loaded only on a
deliberate "open canvas" click and excluded from the boot asset warm-up
(`warmDashboardAssets` skips `vendor/`), so it costs nothing on the normal chat
path (RFC §10).

`build-provenance.json` in this directory is the machine-readable copy of the
build's sha256s + sizes + versions (emitted by `build.mjs`); it is NOT consumed by
the runtime.

## `style-src` measurement (RFC §9.2) — `'unsafe-inline'` IS required for style-src

Measured at vendor time (Playwright, opaque-origin srcdoc frame with a strict
`Content-Security-Policy`): under `style-src 'self'` the editor DOM mounts but the
browser logs **"Refused to apply inline style ... style-src 'self'"** — tldraw
injects `<style>` blocks and element styles at runtime, which a strict
`style-src 'self'` blocks (breaking visual styling). **Conclusion: the sketch
surfaces' CSP uses `style-src 'self' 'unsafe-inline'`.** This relaxation is for
`style-src` ONLY — `script-src` stays `'self'` (no inline script is allowed).

Two further CSP findings from running against the real route:

- **`connect-src` needs `data:`.** tldraw lazily `fetch`es its inlined translation
  JSON via `data:` URLs at runtime; under `connect-src 'self'` the browser logs
  "Refused to connect to 'data:application/json...'" (tldraw still mounts, falls
  back to default strings). The CSP therefore uses `connect-src 'self' data:`. A
  `data:` URL is self-contained and has no network destination, so this does NOT
  weaken the exfil net — a 0-day still cannot phone home to a third party.
- The frame isolation (`frame-src 'self'`, `frame-ancestors 'self'`) is unaffected.
- **The existing dashboard loads Google Fonts** (Bricolage Grotesque + Geist Mono
  from `fonts.googleapis.com` CSS + `fonts.gstatic.com` woff2). Adding a strict CSP
  broke that typography until those origins were allowed: `style-src` includes
  `https://fonts.googleapis.com` and `font-src` includes `https://fonts.gstatic.com`.
  This does not weaken the sketch iframe's isolation (it executes no third-party
  script and cannot exfiltrate; font origins only permit static font fetches it
  doesn't even use). Verified: the dashboard renders with ZERO CSP violations.

### Final CSP (both /dashboard and /dashboard/sketch-frame)

```
default-src 'self'; script-src 'self'; frame-src 'self'; frame-ancestors 'self';
connect-src 'self' data:; img-src 'self' data: blob:;
font-src 'self' data: https://fonts.gstatic.com;
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com
```

## Sandbox / origin measurement (RFC §5.1) — srcdoc OPAQUE-ORIGIN WORKS (default path taken)

Measured at vendor time (Playwright):

- tldraw mounts and renders cleanly inside an **opaque-origin srcdoc iframe**
  (`sandbox="allow-scripts"`, NO `allow-same-origin`; `document.origin === "null"`),
  with zero console/page errors and the dev/hobby watermark visible.
- In the opaque origin `localStorage` **throws `SecurityError`** and `indexedDB`
  is unavailable/partitioned. tldraw **degrades gracefully** — it does not crash
  and does not require persistent storage to mount + render. (We don't need
  persistence: the sketch is loaded from the DSL each time and exported on Send.)
- **One load-bearing detail:** an opaque-origin frame fetches the bundle
  `<script src>` as a CORS request. The vendor route therefore sends
  `Access-Control-Allow-Origin: *` (the bundle is a public static asset with no
  secrets) — without it the browser blocks the script with a CORS error and
  tldraw never loads. This is implemented in `GET /dashboard/vendor/:path+`.
- **Decision: the secure default (srcdoc opaque-origin, no `allow-same-origin`)
  is used.** The same-origin fallback (RFC §5.1) was also verified to mount but
  is NOT needed and is not used.

## No runtime CDN

Fonts (16 woff2), the merged icon SVG, embed icons, and locale JSON are inlined
as data URIs by the `dataurl` esbuild loaders. The browser fetches nothing from
`tldraw.com` / `unpkg` / `jsdelivr` for the editor's own assets. One residual
string constant `https://cdn.tldraw.com` (tldraw's `defaultBaseUrl`) survives in
the bundle but is only reached by features v1 does not use (bookmark unfurling,
embeds); even if reached, the CSP `connect-src 'self'` + `img-src 'self' data:
blob:` blocks any such fetch at the browser. Verified: 16 `data:font/woff2`
inlines + 1 `data:image/svg+xml` inline; the CSS contains no non-`data:` `url()`
except in-document SVG-filter fragment refs.

> **Known cosmetic limitation (Q2/Q3 follow-up):** the merged icon spritesheet is
> inlined as a single `data:` SVG referenced by `#fragment` (e.g.
> `…0_merged.svg#zoom-in`). Browsers do not resolve fragment identifiers on
> `data:` URIs, so toolbar icons render as filled squares (the color palette and
> all functional UI render correctly). The fix (serve `0_merged.svg` as a real
> vendored file so `#fragment` resolves, or split the sprite) is deferred to the
> interactive-canvas quanta (Q2/Q3) — it does not gate Q1's no-op mount.

## License — free hobby tier + watermark (RFC §1)

- **Dev (HTTP / `localhost` / `NODE_ENV !== 'production'`):** free, NO key, no
  watermark violation. `sketch:init` omits `licenseKey`.
- **Production (HTTPS, non-localhost):** requires a **free hobby license key**,
  injected at runtime via the `sketch:init` postMessage config (§1.0) — NEVER
  committed. The key is domain-restricted and client-validated, so it is safe to
  ship over the wire.
- **DEPLOY PREREQUISITE (operator action before production):** register a free
  hobby key at tldraw.dev for the production HTTPS tailnet domain, then set it as
  an orchestrator config value. Until that key exists, production renders with
  console errors + the "made with tldraw" watermark; dev is unaffected. (Q4
  exercises the production-mode path; key wiring lands in a later quantum.)

## CVE-rot ownership (RFC §4.6)

A committed bundle gets NO `npm audit` / Dependabot signal. That gap is owned:

- **Owner:** `agentic-collab-lead` (the persona that authored RFC-010).
- **Cadence:** a **quarterly** manual review (tldraw + react + react-dom release
  notes / GitHub Security Advisories for the pinned versions) **plus** an
  **on-disclosure** trigger (any CVE published against tldraw / react / react-dom
  at or below the pinned version → review immediately).
- **Outcome:** either "no action" (recorded with date below) or run the rebuild
  ritual in `tools/tldraw-bundle/README.md` to pull the patched version.

### Review log

| Date | Reviewer | Outcome |
|---|---|---|
| 2026-06-23 | agentic-collab-lead | Initial vendor (tldraw 5.1.1, react 19.2.7). No known advisories at pin. |
