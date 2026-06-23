/**
 * RFC-010 §4.2 — the OFFLINE, dev-only, human-run bundler.
 *
 * Bundles `entry.tsx` (the iframe runtime: React + tldraw + the postMessage
 * handler + export-with-raster-ceiling) into a single self-contained ESM file
 * plus its CSS. The committed output (`src/dashboard/vendor/tldraw/`) is the
 * artifact the runtime serves; this script is NEVER run by the app, the
 * container, or CI (CI verifies the committed sha256 via vendor.sha256.test.ts).
 *
 * Run from the repo root:  pnpm --dir tools/tldraw-bundle build
 * (or:  cd tools/tldraw-bundle && pnpm install && node build.mjs)
 *
 * Key choices:
 *   - format: 'esm', minify, NODE_ENV=production (drops React dev code).
 *   - assets (svg/woff2/png/gif) → `dataurl` loader so fonts/icons inline as
 *     data URIs: the browser fetches NOTHING from tldraw.com / unpkg / jsdelivr.
 *   - CSS emitted to a sibling `tldraw.bundle.css` (out.css from the JS entry's
 *     `import 'tldraw/tldraw.css'`).
 *   - After building, the script measures sha256 + minified + gzipped sizes and
 *     prints them so VENDOR.md can be updated (step 4.4.3).
 */

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', '..', 'src', 'dashboard', 'vendor', 'tldraw');
const outJs = join(outDir, 'tldraw.bundle.js');
const outCss = join(outDir, 'tldraw.bundle.css');

mkdirSync(outDir, { recursive: true });

// esbuild emits CSS next to the JS as `<entryname>.css`. We point the JS output at
// a temp name so the CSS lands predictably, then rename to the canonical names.
const tmpJs = join(outDir, '__build.js');
const tmpCss = join(outDir, '__build.css');

console.log('[tldraw-bundle] building entry.tsx → ESM (minify, NODE_ENV=production, assets inlined)...');

await build({
  entryPoints: [join(here, 'entry.tsx')],
  outfile: tmpJs,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  jsx: 'automatic',
  loader: {
    // Inline every tldraw asset as a data URI — no runtime CDN (§4.2).
    // NOTE: translation `.json` files MUST be `dataurl`, not `json`:
    // getAssetUrlsByImport() treats every imported asset as a URL STRING (the
    // Vite `?url` convention). Loading `.json` as a parsed object makes
    // formatAssetUrl read `.src` off an object → undefined → crash. As data
    // URLs the translations are valid URLs tldraw fetches lazily per locale.
    '.svg': 'dataurl',
    '.woff2': 'dataurl',
    '.woff': 'dataurl',
    '.png': 'dataurl',
    '.gif': 'dataurl',
    '.json': 'dataurl',
  },
  logLevel: 'info',
});

// Move temp outputs to canonical names.
if (existsSync(tmpJs)) renameSync(tmpJs, outJs);
if (existsSync(tmpCss)) renameSync(tmpCss, outCss);
else {
  // No CSS was emitted — write an empty file so the vendor route + sha256 check
  // always have a target. (Should not happen: entry.tsx imports tldraw.css.)
  writeFileSync(outCss, '');
}

function report(label, path) {
  const bytes = readFileSync(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const gzipped = gzipSync(bytes).length;
  console.log(`[tldraw-bundle] ${label}`);
  console.log(`    file:    ${path}`);
  console.log(`    sha256:  ${sha256}`);
  console.log(`    minified: ${bytes.length} bytes (${(bytes.length / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`    gzipped:  ${gzipped} bytes (${(gzipped / 1024).toFixed(1)} KB)`);
  return { sha256, minified: bytes.length, gzipped };
}

console.log('');
const js = report('tldraw.bundle.js', outJs);
const css = report('tldraw.bundle.css', outCss);

// Emit a machine-readable provenance JSON next to VENDOR.md so the human-run
// update step (4.4.3) can copy the exact numbers. Not consumed by the runtime.
const provenance = {
  builtAt: new Date().toISOString(),
  versions: readVersions(),
  files: {
    'tldraw.bundle.js': { sha256: js.sha256, minified: js.minified, gzipped: js.gzipped },
    'tldraw.bundle.css': { sha256: css.sha256, minified: css.minified, gzipped: css.gzipped },
  },
};
writeFileSync(join(outDir, 'build-provenance.json'), JSON.stringify(provenance, null, 2) + '\n');

console.log('');
console.log('[tldraw-bundle] done. Update VENDOR.md with the sha256s + sizes above');
console.log('[tldraw-bundle] (build-provenance.json has the machine-readable copy).');

function readVersions() {
  const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf-8'));
  return pkg.devDependencies;
}
