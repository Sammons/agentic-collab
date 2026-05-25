# RFC: WebSocket Subscription-Based Filtering

**Status:** Implemented  
**Author:** agentic-collab-lead  
**Created:** 2026-05-25

## Problem

Focus mode is client-side only — all messages broadcast to all WebSocket clients, and the dashboard JS filters locally. This causes "break through" bugs when:

1. State desyncs during WebSocket reconnect
2. Race conditions between selection change and incoming message
3. Stale `selectedAgents` set after route changes

## Solution

Server-side subscription filtering. Clients declare which agents they want to receive messages for; server only sends matching messages.

## Protocol Changes

### 1. Subscribe Message (Client → Server)

```json
{
  "type": "subscribe",
  "agents": ["agent-a", "agent-b"],
  "mode": "include"  // "include" = only these, "exclude" = all except these, "all" = everything
}
```

- Replaces any previous subscription for this connection
- Empty `agents` array with `mode: "include"` = receive nothing
- `mode: "all"` ignores `agents` array, receives everything (current behavior)

### 2. Server Filtering

On `type: "message"` broadcast, server checks each connection's subscription:

```typescript
function shouldDeliver(conn: WebSocket, msg: DashboardMessage): boolean {
  const sub = subscriptions.get(conn);
  if (!sub || sub.mode === 'all') return true;
  const agent = msg.agent;  // thread agent
  if (sub.mode === 'include') return sub.agents.has(agent);
  if (sub.mode === 'exclude') return !sub.agents.has(agent);
  return true;
}
```

### 3. Subscription Confirmation (Server → Client)

```json
{
  "type": "subscribed",
  "agents": ["agent-a", "agent-b"],
  "mode": "include"
}
```

Client waits for confirmation before considering focus mode active.

## Implementation

### Server (`src/shared/websocket-server.ts`)

1. Add `subscriptions: Map<WebSocket, Subscription>` to track per-connection state
2. Handle `type: "subscribe"` messages in the message handler
3. Modify `broadcast()` to check subscription before sending
4. Clean up subscription on connection close
5. Send `subscribed` confirmation

### Client (`src/dashboard/state.ts`)

1. On `toggleFocusMode()` or selection change, send `subscribe` message
2. Wait for `subscribed` confirmation
3. Remove client-side filtering from `renderThread()` — server handles it
4. On reconnect, re-send current subscription

### Migration

- Default subscription is `mode: "all"` (backwards compatible)
- Clients that don't send `subscribe` get all messages (current behavior)
- Dashboard sends `subscribe` on mount based on `state.selectedAgents`

## Edge Cases

1. **System messages** (agent spawning, lifecycle) — always delivered regardless of subscription
2. **Dashboard thread** — always included if user is viewing dashboard
3. **Reconnect** — client re-sends subscription; server replays any missed messages? (out of scope for v1)

## Testing

1. Unit test: subscription matching logic
2. Integration test: two clients with different subscriptions, verify correct filtering
3. E2E: focus mode in dashboard, verify no break-through

## Rollout

1. Ship server-side filtering (backwards compatible)
2. Update dashboard to use subscriptions
3. Remove client-side filtering code
