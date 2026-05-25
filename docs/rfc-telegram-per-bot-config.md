# RFC: Per-Bot Telegram Configuration

**Status:** Draft  
**Author:** agentic-collab team  
**Created:** 2026-05-25  
**GitHub Issue:** #6

## Problem

Currently, Telegram destinations are configured platform-wide. The `destinations` table stores Telegram bot tokens and chat IDs, but the configuration model has several limitations:

1. **Single polling instance** — `TelegramDispatcher` maintains one `pollingAbort` controller. Starting polling for a new bot stops the previous one.

2. **No default agent routing** — Messages without `@agent` prefix go to a virtual "telegram" dashboard thread. Users want unprefixed messages routed to a specific agent automatically.

3. **No per-bot chat restrictions** — Any chat that messages the bot gets through. Users want to restrict which chats/users can interact.

4. **No custom routing rules** — All bots share the same `@agent-name` prefix convention. Users may want different parsing rules per bot.

## Proposed Solution

Each Telegram bot becomes its own destination entry with independent configuration. The `TelegramDispatcher` is refactored to support multiple concurrent polling loops.

### Per-Bot Config Fields

```typescript
type TelegramConfig = {
  botToken: string;
  chatId: string;            // primary outbound chat (existing)
  
  // New fields
  defaultAgent?: string;     // route unprefixed messages to this agent
  allowedChatIds?: string[]; // restrict inbound to these chats (empty = all)
  allowedUserIds?: string[]; // restrict inbound to these users (empty = all)
  inboundEnabled?: boolean;  // default: true; false = outbound-only
  routingMode?: 'prefix' | 'default-only' | 'passthrough';
  // prefix: @agent-name routing (current behavior), falls back to defaultAgent
  // default-only: all messages → defaultAgent, ignore prefixes
  // passthrough: no routing, all messages → virtual "telegram:<name>" thread
};
```

### Multi-Bot Polling

```typescript
class TelegramDispatcher {
  // Change: Map of destination name → polling state
  // NOTE: Keyed by name (not token) to handle token rotation via PATCH
  private pollingStates: Map<string, {
    abort: AbortController;
    promise: Promise<void>;
    lastUpdateId: number;
    botToken: string;  // track current token for this destination
  }> = new Map();

  startPolling(botToken: string, destName: string, onMessage: ...): void {
    // Stop any existing polling for this destination first
    this.stopPolling(destName);
    // Create independent polling loop per bot
    // Store botToken in state for logging/cleanup
    this.pollingStates.set(destName, {
      abort: new AbortController(),
      promise: this.poll(botToken, destName, onMessage),
      lastUpdateId: 0,
      botToken,
    });
  }

  stopPolling(destName: string): void {
    // Stop by destination name (handles token rotation)
    const state = this.pollingStates.get(destName);
    if (state) {
      state.abort.abort();
      this.pollingStates.delete(destName);
    }
  }

  stopAll(): void {
    // Stop all polling (shutdown)
    for (const [destName] of this.pollingStates) {
      this.stopPolling(destName);
    }
  }
}
```

## Schema Changes

### Migration

The `destinations` table already stores config as JSON. No schema migration needed — the new fields are added to the `config` object:

```sql
-- Existing schema (unchanged)
CREATE TABLE IF NOT EXISTS destinations (
  name       TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  config     TEXT NOT NULL,   -- JSON, gets new optional fields
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT ...,
  updated_at TEXT NOT NULL DEFAULT ...
);
```

Example stored config (old):
```json
{"botToken": "123:ABC", "chatId": "-100123456"}
```

Example stored config (new):
```json
{
  "botToken": "123:ABC",
  "chatId": "-100123456",
  "defaultAgent": "support-bot",
  "allowedChatIds": ["-100123456", "-100789012"],
  "routingMode": "prefix"
}
```

### TypeScript Types

```typescript
// src/shared/types.ts
export type TelegramDestinationConfig = {
  botToken: string;
  chatId: string;
  defaultAgent?: string;
  allowedChatIds?: string[];
  allowedUserIds?: string[];
  inboundEnabled?: boolean;
  routingMode?: 'prefix' | 'default-only' | 'passthrough';
};

// DestinationRecord.config becomes typed when type === 'telegram'
```

## API Changes

### POST /api/destinations

Validation updated:

```typescript
if (type === 'telegram') {
  if (!config.botToken || !config.chatId) {
    return json(res, 400, { error: 'telegram config requires botToken and chatId' });
  }
  // New: validate optional fields
  if (config.defaultAgent && !ctx.db.getAgent(config.defaultAgent)) {
    return json(res, 400, { error: `defaultAgent "${config.defaultAgent}" not found` });
  }
  if (config.routingMode && !['prefix', 'default-only', 'passthrough'].includes(config.routingMode)) {
    return json(res, 400, { error: 'routingMode must be prefix|default-only|passthrough' });
  }
}
```

### PATCH /api/destinations/:name (New Endpoint)

Partial update for config fields:

```typescript
route('PATCH', '/api/destinations/:name', async (req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const dest = ctx.db.getDestination(name);
  if (!dest) return json(res, 404, { error: 'Destination not found' });

  const body = await readJson(req);
  
  // Merge config updates
  const newConfig = { ...dest.config, ...body.config };
  
  // Validate telegram-specific fields
  if (dest.type === 'telegram') {
    if (newConfig.defaultAgent && !ctx.db.getAgent(newConfig.defaultAgent)) {
      return json(res, 400, { error: `defaultAgent "${newConfig.defaultAgent}" not found` });
    }
  }

  const updated = ctx.db.updateDestination(name, {
    config: newConfig,
    enabled: body.enabled ?? dest.enabled,
  });

  // Restart polling if telegram config changed
  // stopPolling uses destName (not token) so token rotation is safe
  if (dest.type === 'telegram' && updated?.enabled) {
    ctx.telegramDispatcher.stopPolling(dest.name);
    startTelegramPolling(ctx, updated);
  }

  ctx.wss.broadcast(JSON.stringify({ 
    type: 'destinations_update', 
    destinations: ctx.db.listDestinations() 
  }));
  json(res, 200, updated);
});
```

### Updated `startTelegramPolling`

```typescript
export function startTelegramPolling(ctx: RouteContext, dest: DestinationRecord): void {
  const config = dest.config as TelegramDestinationConfig;
  const { botToken, allowedChatIds, allowedUserIds, defaultAgent, routingMode } = config;

  if (config.inboundEnabled === false) {
    console.log(`[telegram] Inbound disabled for ${dest.name}`);
    return;
  }

  ctx.telegramDispatcher.startPolling(botToken, dest.name, (chatId, userId, text) => {
    // Access control
    if (allowedChatIds?.length && !allowedChatIds.includes(chatId)) {
      console.log(`[telegram:${dest.name}] Rejected: chat ${chatId} not in allowlist`);
      return;
    }
    if (allowedUserIds?.length && !allowedUserIds.includes(userId)) {
      console.log(`[telegram:${dest.name}] Rejected: user ${userId} not in allowlist`);
      return;
    }

    // Routing
    const mode = routingMode ?? 'prefix';
    
    if (mode === 'passthrough') {
      // All to dashboard thread
      const msg = ctx.db.addDashboardMessage(`telegram:${dest.name}`, 'from_agent', text, {
        sourceAgent: `telegram:${dest.name}`,
      });
      broadcastMessage(ctx, msg);
      return;
    }

    if (mode === 'default-only' && defaultAgent) {
      // All to default agent, ignore prefixes
      routeToAgent(ctx, dest, defaultAgent, text);
      return;
    }

    // mode === 'prefix' — existing behavior with fallback
    const tagMatch = text.match(/^((?:@[a-zA-Z0-9_-]+\s+)+)([\s\S]+)$/);
    if (tagMatch) {
      // Parse @agent prefixes (existing logic)
      ...
    } else if (defaultAgent) {
      // No prefix, route to default
      routeToAgent(ctx, dest, defaultAgent, text);
    } else {
      // Fallback to dashboard thread
      ...
    }
  });
}
```

## Dashboard UI

### Settings > Destinations Panel

Current: Name, Type, Enabled toggle, Test button, Delete.

New columns/expandable config:
- **Default Agent** — dropdown of available agents + "None"
- **Routing Mode** — dropdown: "Prefix (@agent)", "Default Only", "Passthrough"
- **Allowed Chats** — comma-separated or expandable list
- **Inbound** — toggle (on/off)

### Agent Detail > Destinations Tab (Future)

Show which destinations have this agent as `defaultAgent`. Low priority.

## Migration Path

### Existing Destinations

No data migration needed. Missing fields use defaults:
- `defaultAgent`: undefined (current behavior: unprefixed → dashboard)
- `allowedChatIds`: undefined (current behavior: all chats allowed)
- `routingMode`: `'prefix'` (current behavior)
- `inboundEnabled`: `true` (current behavior)

### Multi-Bot Transition

1. On startup, `main.ts` loops over all enabled telegram destinations and calls `startTelegramPolling` for each.
2. Each bot gets its own polling loop.
3. Stopping one bot doesn't affect others.

```typescript
// main.ts startup
const telegramDests = db.listDestinations().filter(d => d.type === 'telegram' && d.enabled);
for (const dest of telegramDests) {
  startTelegramPolling(ctx, dest);
}
```

## Alternatives Considered

### 1. Separate `telegram_bots` Table

Pros:
- Cleaner schema, no JSON parsing
- Easier to query by specific fields

Cons:
- More migration complexity
- Duplicates the destination concept
- Have to keep two tables in sync

**Rejected:** The JSON config approach is flexible and already established.

### 2. Global `defaultAgent` Setting

Instead of per-bot, add a single global setting for unprefixed routing.

Cons:
- Doesn't solve multi-bot use case
- Users with multiple bots need different defaults

**Rejected:** Per-bot is more flexible with minimal extra complexity.

### 3. Webhook Instead of Polling

Replace long-polling with Telegram webhooks for efficiency.

Cons:
- Requires public HTTPS endpoint
- More infrastructure complexity
- Not requested by users

**Deferred:** Could be added later as `deliveryMode: 'poll' | 'webhook'`.

## Edge Cases and Mitigations

### Token Rotation
Polling state is keyed by destination name, not token. When a token is updated via PATCH, `stopPolling(destName)` stops the old polling loop regardless of which token it was using, then `startTelegramPolling` starts fresh with the new token.

### Multiple Bots with Same defaultAgent
This is valid and expected. Both bots route to the same agent, which receives messages from either source. The `sourceAgent` field (`telegram:<destName>`) distinguishes the origin.

### defaultAgent Deleted After Config
If `defaultAgent` references an agent that's later deleted, `routeToAgent` will fail at delivery time. The message falls through to the dashboard thread with a warning log. Consider: adding an `agents_deleted` event handler that clears `defaultAgent` from affected destinations.

### routingMode 'default-only' Without defaultAgent
If `routingMode` is `default-only` but `defaultAgent` is not set, messages have nowhere to go. This is a config error. Validation should reject this combination:
```typescript
if (config.routingMode === 'default-only' && !config.defaultAgent) {
  return json(res, 400, { error: 'default-only mode requires defaultAgent' });
}
```

### Access Control Logging
Rejected messages (chat/user not in allowlist) are logged but not acknowledged to the sender. This is intentional — silent rejection prevents enumeration attacks. Rate limiting at the Telegram API layer provides additional protection.

## Test Plan

1. **Unit: Config validation** — POST with invalid routingMode rejects
2. **Unit: Access control** — Messages from non-allowed chats are dropped
3. **Unit: Routing modes** — Each mode routes correctly
4. **Integration: Multi-bot** — Two bots poll simultaneously, independent message handling
5. **Integration: PATCH** — Config updates restart polling with new settings
6. **E2E: Dashboard** — Configure destination, send test, verify routing

## Rollout

1. Implement `TelegramDispatcher` multi-bot support
2. Add PATCH endpoint with config validation
3. Update `startTelegramPolling` for new config fields
4. Update dashboard settings UI
5. Document new config options
