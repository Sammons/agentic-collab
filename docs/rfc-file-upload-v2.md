# RFC: File Upload v2 — Orchestrator-Native File Handling

**Status:** Draft  
**Author:** agentic-collab-lead  
**Date:** 2026-05-24

## Problem

The current file upload implementation is fragile:

1. **Client-side staging is unreliable** — The dashboard tracks uploaded file paths in a JS Map, but this state is ephemeral (lost on refresh) and the synthetic event dispatch to update the UI doesn't fire reliably.

2. **Files land on proxy, not orchestrator** — Files are streamed directly to the proxy's filesystem (`agent.cwd`), which means:
   - Files aren't accessible to other agents
   - No centralized file registry
   - No way to list/manage uploaded files

3. **Text append is lossy** — Appending `\n\nAttached files:\n  /path/to/file` to the message body is fragile parsing and clutters the message.

4. **No feedback loop** — User doesn't know if upload succeeded, where files landed, or if the agent can access them.

## Proposal

### Option A: Orchestrator File Registry (Recommended)

Files upload to orchestrator storage, get assigned a stable URI, and become first-class message metadata.

```
POST /api/files
  ← { id: "file_abc123", uri: "file://abc123", name: "screenshot.png", size: 12345, mime: "image/png" }

POST /api/dashboard/send
  { agent: "agent:foo", message: "check this", files: ["file_abc123"] }
```

**Orchestrator changes:**
- New `files` table: `id, name, size, mime, path, created_at, expires_at`
- New `/api/files` POST (upload) and GET (download/metadata)
- Messages gain `file_ids: string[]` field
- Files stored in `$DATA_DIR/files/` with UUID names
- Optional: TTL-based cleanup (files expire after N days)

**Proxy changes:**
- New `/files/:id` GET endpoint to serve files to agents
- Or: orchestrator serves files directly, agents fetch via orchestrator URL

**Dashboard changes:**
- Upload button + drag/drop → POST to `/api/files`
- Show file chips below composer (removable before send)
- Messages render file attachments as clickable chips

**Agent experience:**
- Message includes `files: [{ id, name, uri }]`
- Agent reads file via `curl $ORCHESTRATOR_URL/api/files/:id` or local path if on same host

### Option B: Keep Proxy-Side, Fix Client State

Minimal change: fix the client-side staging to be reliable.

- Store staged files in localStorage (survives refresh)
- Use direct function calls instead of synthetic events
- Add visual file chips below composer
- Keep the text-append approach for agent delivery

**Pros:** Less orchestrator change  
**Cons:** Still no cross-agent file access, no file registry, fragile

### Option C: Inline Base64

For small files (<1MB), encode as base64 in the message body.

```json
{ "message": "check this", "attachments": [{ "name": "img.png", "data": "iVBOR..." }] }
```

**Pros:** Simple, no new storage  
**Cons:** Bloats messages, doesn't scale to large files, no streaming

## Recommendation

**Option A** — orchestrator-native file registry. It's more work but solves the root problems:
- Files are durable (survive restarts)
- Files are accessible to any agent
- Clean message metadata (not text hacks)
- Foundation for future features (file browser, search, quotas)

## Implementation DAG

```
1. Schema: files table + migration
2. API: POST /api/files (upload with streaming)
3. API: GET /api/files/:id (download + metadata)
4. Types: Add file_ids to DashboardMessage
5. Dashboard: Upload UI + file chips in composer
6. Dashboard: Render file attachments on messages
7. Delivery: Include file metadata in agent envelope
8. Proxy: Serve files to agents (or agents fetch from orchestrator)
9. Cleanup: TTL-based file expiration cron
```

## Open Questions

1. **Storage location** — Orchestrator runs in Docker. Mount a volume for `/data/files`?
2. **Size limits** — Cap at 100MB? 1GB? Per-file or total?
3. **Deduplication** — Hash files and dedup? Or keep simple?
4. **Access control** — Any file accessible to any agent, or scope to teams?
5. **Image preview** — Render thumbnails in dashboard, or just show chips?

## Alternatives Considered

- **S3 backend** — Overkill for single-node deployment, adds AWS dependency
- **Git LFS** — Wrong tool for ephemeral file sharing
- **Paste as data URL** — Works for tiny images, doesn't scale
