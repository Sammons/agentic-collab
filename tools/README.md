# tools/

Self-contained, **dev-only** tooling that is NOT part of the running app and is
NOT a runtime dependency. Each tool has its own `package.json`; nothing here is
referenced by the orchestrator, the proxy, the dashboard runtime, CI, or the
container. The app stays zero-runtime-dep.

| Tool | Purpose |
|---|---|
| `tldraw-bundle/` | Offline, human-run esbuild bundler that vendors tldraw + React into the committed bundle at `src/dashboard/vendor/tldraw/` for the AI sketch canvas (RFC-010). The ONLY place `tldraw` / `react` / `react-dom` / `esbuild` appear. Run on a deliberate tldraw upgrade only. |
