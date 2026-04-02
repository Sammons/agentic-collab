/**
 * Content script — injected into dashboard pages.
 * Connects to the test runner via WebSocket (same as probe.ts)
 * but delegates screenshots to the background service worker
 * via chrome.runtime.sendMessage, which uses captureVisibleTab.
 *
 * The probe port is discovered from the URL query param ?probePort=NNNN
 * or defaults to scanning the page for the injected __PROBE_PORT__.
 */
(function () {
  const params = new URLSearchParams(location.search);
  const probePort = params.get('probePort');
  if (!probePort) {
    console.log('[test-probe-ext] No probePort in URL, inactive.');
    return;
  }

  let ws = null;

  function connect() {
    ws = new WebSocket('ws://localhost:' + probePort);

    ws.onopen = function () {
      console.log('[test-probe-ext] Connected to runner on port ' + probePort);
      ws.send(JSON.stringify({ type: 'probe_ready' }));
    };

    ws.onmessage = function (evt) {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      if (!msg || !msg.id || !msg.cmd) return;

      const id = msg.id;

      try {
        switch (msg.cmd) {
          case 'click': {
            const el = document.querySelector(msg.selector);
            if (!el) { reply(id, false, 'Element not found: ' + msg.selector); return; }
            el.click();
            reply(id, true);
            break;
          }

          case 'type': {
            const input = document.querySelector(msg.selector);
            if (!input) { reply(id, false, 'Element not found: ' + msg.selector); return; }
            input.value = msg.text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            reply(id, true);
            break;
          }

          case 'read-text': {
            const target = document.querySelector(msg.selector);
            if (!target) { reply(id, false, 'Element not found: ' + msg.selector); return; }
            reply(id, true, target.textContent);
            break;
          }

          case 'read-state': {
            reply(id, true, window.__dashboardState || null);
            break;
          }

          case 'wait-for': {
            const timeout = msg.timeout || 5000;
            const interval = 100;
            let elapsed = 0;
            function check() {
              if (document.querySelector(msg.selector)) { reply(id, true); return; }
              elapsed += interval;
              if (elapsed >= timeout) { reply(id, false, 'timeout'); return; }
              setTimeout(check, interval);
            }
            check();
            break;
          }

          case 'count': {
            const all = document.querySelectorAll(msg.selector);
            reply(id, true, all.length);
            break;
          }

          case 'screenshot': {
            // Delegate to background service worker — uses captureVisibleTab
            chrome.runtime.sendMessage({ cmd: 'captureScreenshot' }, (response) => {
              if (response && response.ok) {
                const data = response.data;
                data.width = window.innerWidth;
                data.height = window.innerHeight;
                reply(id, true, data);
              } else {
                reply(id, false, response?.error || 'captureScreenshot failed');
              }
            });
            break;
          }

          case 'resize': {
            chrome.runtime.sendMessage({
              cmd: 'resizeWindow',
              width: msg.width,
              height: msg.height,
            }, (response) => {
              if (response && response.ok) {
                // Wait for resize to settle
                setTimeout(() => reply(id, true), 500);
              } else {
                reply(id, false, response?.error || 'resize failed');
              }
            });
            break;
          }

          case 'snapshot': {
            const state = window.__dashboardState || {};
            const descriptor = {
              url: location.href,
              title: document.title,
              timestamp: new Date().toISOString(),
              viewport: { width: window.innerWidth, height: window.innerHeight },
              agentCards: Array.from(document.querySelectorAll('[data-agent]')).map(function (card) {
                return {
                  name: card.dataset.agent,
                  stateText: (function () { const b = card.querySelector('.state-badge'); return b ? b.textContent : ''; })(),
                  hasUnread: !!card.querySelector('.unread-badge'),
                  visible: card.offsetParent !== null,
                };
              }),
              selectedAgent: state.selected || null,
              threadMessageCount: document.querySelectorAll('.msg').length,
            };
            reply(id, true, { descriptor, html: document.documentElement.outerHTML });
            break;
          }

          default:
            reply(id, false, 'Unknown command: ' + msg.cmd);
        }
      } catch (err) {
        reply(id, false, String(err));
      }
    };

    ws.onclose = function () {
      console.log('[test-probe-ext] Disconnected, reconnecting in 2s...');
      setTimeout(connect, 2000);
    };
  }

  function reply(id, ok, data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const msg = { id, ok };
    if (ok && data !== undefined) msg.data = data;
    if (!ok && data !== undefined) msg.error = data;
    ws.send(JSON.stringify(msg));
  }

  connect();
})();
