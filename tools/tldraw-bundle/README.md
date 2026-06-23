# tools/tldraw-bundle — the offline tldraw bundler (RFC-010)

This is a **dev-only, human-run, offline** build tool. It vendors tldraw + React
into a single self-contained ESM bundle for the dashboard's AI sketch canvas. It
is the ONLY place `tldraw` / `react` / `react-dom` / `esbuild` appear — they MUST
NOT enter the repo-root `package.json` (the app stays zero-runtime-dep).

- The runtime **never** runs this. CI **never** runs this. The container **never**
  runs this. A human runs it on a deliberate tldraw upgrade.
- The **committed bundle** at `src/dashboard/vendor/tldraw/` is the artifact the
  app serves. CI verifies that bundle's sha256 against `VENDOR.md`
  (`src/dashboard/vendor/tldraw/vendor.sha256.test.ts`) — it does NOT rebuild.

Justification for the offline build step (the repo otherwise forbids a build step
for the live app): the bundler is dev-only, exactly like `typescript` is already a
dev-only tool here. See RFC-010 §4.1.

## Files

- `package.json` — pins the exact tldraw / react / react-dom / @tldraw/assets /
  esbuild versions. The only place these deps live.
- `entry.tsx` — the iframe-side runtime: mounts `<Tldraw>`, runs the postMessage
  protocol (`src/shared/sketch-protocol.ts`), exports to PNG with the raster
  ceiling (`src/shared/sketch-raster.ts`).
- `build.mjs` — the esbuild bundler. Emits `tldraw.bundle.js` + `tldraw.bundle.css`
  + `build-provenance.json` to `src/dashboard/vendor/tldraw/`.

## Build / rebuild ritual (RFC §4.4)

Run from the repo root:

```
pnpm --dir tools/tldraw-bundle install   # only on first build / version bump
pnpm --dir tools/tldraw-bundle build
```

On a version bump:

1. Bump the version(s) in `package.json`, `pnpm install` **inside this dir only**.
2. `pnpm --dir tools/tldraw-bundle build` → regenerates the vendor dir.
3. Update `src/dashboard/vendor/tldraw/VENDOR.md`: new versions, build command,
   fresh sha256s + sizes (copy from the build output / `build-provenance.json`),
   re-measure the `style-src` requirement (§9.2), re-measure srcdoc opaque-origin
   (§5.1). Append a CVE-rot review-log row.
4. Manually open a sketch in the dashboard; verify render + edit + export; run the
   Playwright suite (incl. the production-mode license path).
5. Commit the regenerated bundle in a dedicated
   `chore(deps): bump vendored tldraw to X.Y.Z` PR so the diff is reviewable. CI's
   `vendor.sha256.test.ts` re-verifies the committed sha256 against VENDOR.md.

## Reproducible build (the stronger guarantee)

CI's cheap proxy for "frozen" is the sha256 match (catches tampering / an
un-recorded rebuild without making CI build React). The stronger guarantee —
re-running esbuild and getting byte-identical output — is run **here, manually, on
upgrade**: after `pnpm --dir tools/tldraw-bundle build`, the printed sha256 must
equal the one in `VENDOR.md`. esbuild output is deterministic for a fixed input +
flags + version, so a clean rebuild of an unchanged `entry.tsx` against the pinned
deps reproduces the committed bytes.

## CVE-rot ownership (RFC §4.6)

- **Owner:** `agentic-collab-lead`.
- **Cadence:** quarterly manual review + on-disclosure trigger (any CVE against
  tldraw / react / react-dom at or below the pinned version → review immediately).
- A committed bundle has NO `npm audit` signal — that is the gap this ritual owns.
- Record each review (date + outcome) in `VENDOR.md`'s review-log table.

## Security notes carried from vendor-time measurement

- The iframe runs in an **opaque origin** (srcdoc, `sandbox="allow-scripts"`, NO
  `allow-same-origin`). tldraw mounts there; `localStorage` throws (degrades
  gracefully).
- The vendor route MUST send `Access-Control-Allow-Origin: *` (an opaque-origin
  frame fetches the bundle script as a CORS request). The bundle has no secrets.
- The sketch surfaces' CSP needs `style-src 'self' 'unsafe-inline'` (tldraw
  injects runtime inline styles); `script-src` stays `'self'`.
