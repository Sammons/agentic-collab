/**
 * Agentic Collab Pages SDK — lightweight client library for interactive pages.
 *
 * Published pages can include this script to:
 * 1. Send messages to agents via the dashboard API
 * 2. Query data stores for dynamic content rendering
 * 3. Poll for store updates on an interval
 *
 * Usage in a published page:
 *   <script src="/dashboard/assets/pages-sdk.ts"></script>
 *   <script>
 *     const sdk = new CollabPages({ token: 'optional-bearer-token' });
 *
 *     // Query a data store
 *     const rows = await sdk.query('my-store', 'SELECT * FROM tasks WHERE done = 0');
 *
 *     // Send a message to an agent
 *     await sdk.sendMessage('my-agent', 'Please update the task list');
 *
 *     // Poll a store every 5s and call a render function
 *     sdk.poll('my-store', 'SELECT * FROM tasks ORDER BY created_at DESC', 5000, (rows) => {
 *       document.getElementById('tasks').innerHTML = rows.map(r => `<li>${r.title}</li>`).join('');
 *     });
 *   </script>
 */

class CollabPages {
  _baseUrl = '';
  _token = '';
  _pollTimers = [];

  constructor(opts = {}) {
    this._baseUrl = opts.baseUrl || window.location.origin;
    this._token = opts.token || '';
  }

  _headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this._token) h['Authorization'] = `Bearer ${this._token}`;
    return h;
  }

  /** Query a data store. Returns array of row objects. */
  async query(storeName, sql, params = []) {
    const res = await fetch(`${this._baseUrl}/api/stores/${encodeURIComponent(storeName)}/query`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ sql, params }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error || `Query failed: ${res.status}`);
    }
    const data = await res.json();
    return data.rows || data;
  }

  /** Get store schema (tables + columns). */
  async schema(storeName) {
    const res = await fetch(`${this._baseUrl}/api/stores/${encodeURIComponent(storeName)}/schema`, {
      headers: this._headers(),
    });
    if (!res.ok) throw new Error(`Schema fetch failed: ${res.status}`);
    return res.json();
  }

  /** Send a message to an agent. */
  async sendMessage(agentName, message, topic = 'page-interaction') {
    const res = await fetch(`${this._baseUrl}/api/dashboard/send`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ agent: agentName, message, topic }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error || `Send failed: ${res.status}`);
    }
    return res.json();
  }

  /** Poll a store query on an interval. Calls callback(rows) each time. */
  poll(storeName, sql, intervalMs, callback) {
    let lastJson = '';
    const run = async () => {
      try {
        const rows = await this.query(storeName, sql);
        const json = JSON.stringify(rows);
        if (json !== lastJson) {
          lastJson = json;
          callback(rows);
        }
      } catch (err) {
        console.error('[collab-pages] Poll error:', err.message);
      }
    };
    run(); // immediate first run
    const timer = setInterval(run, intervalMs);
    this._pollTimers.push(timer);
    return timer;
  }

  /** Stop a specific poll timer. */
  stopPoll(timer) {
    clearInterval(timer);
    this._pollTimers = this._pollTimers.filter(t => t !== timer);
  }

  /** Stop all poll timers. */
  stopAll() {
    for (const t of this._pollTimers) clearInterval(t);
    this._pollTimers = [];
  }
}

// Expose globally for <script> tag usage
if (typeof window !== 'undefined') {
  window.CollabPages = CollabPages;
}
