(function() {
  /* global WebSocket, document, window, location */
  var PROBE_PORT = __PROBE_PORT__;
  var ws = new WebSocket('ws://localhost:' + PROBE_PORT);

  ws.onopen = function() {
    ws.send(JSON.stringify({ type: 'probe_ready' }));
  };

  ws.onmessage = function(evt) {
    var msg;
    try {
      msg = JSON.parse(evt.data);
    } catch (_e) {
      return;
    }
    if (!msg || !msg.id || !msg.cmd) return;

    var id = msg.id;

    try {
      switch (msg.cmd) {
        case 'click': {
          var el = document.querySelector(msg.selector);
          if (!el) {
            ws.send(JSON.stringify({ id: id, ok: false, error: 'Element not found: ' + msg.selector }));
            return;
          }
          el.click();
          ws.send(JSON.stringify({ id: id, ok: true }));
          break;
        }

        case 'type': {
          var input = document.querySelector(msg.selector);
          if (!input) {
            ws.send(JSON.stringify({ id: id, ok: false, error: 'Element not found: ' + msg.selector }));
            return;
          }
          input.value = msg.text;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          ws.send(JSON.stringify({ id: id, ok: true }));
          break;
        }

        case 'read-text': {
          var target = document.querySelector(msg.selector);
          if (!target) {
            ws.send(JSON.stringify({ id: id, ok: false, error: 'Element not found: ' + msg.selector }));
            return;
          }
          ws.send(JSON.stringify({ id: id, ok: true, data: target.textContent }));
          break;
        }

        case 'read-state': {
          var state = window.__dashboardState || null;
          ws.send(JSON.stringify({ id: id, ok: true, data: state }));
          break;
        }

        case 'wait-for': {
          var timeout = msg.timeout || 5000;
          var interval = 100;
          var elapsed = 0;
          var selector = msg.selector;

          function check() {
            if (document.querySelector(selector)) {
              ws.send(JSON.stringify({ id: id, ok: true }));
              return;
            }
            elapsed += interval;
            if (elapsed >= timeout) {
              ws.send(JSON.stringify({ id: id, ok: false, error: 'timeout' }));
              return;
            }
            setTimeout(check, interval);
          }
          check();
          break;
        }

        case 'count': {
          var all = document.querySelectorAll(msg.selector);
          ws.send(JSON.stringify({ id: id, ok: true, data: all.length }));
          break;
        }

        default:
          ws.send(JSON.stringify({ id: id, ok: false, error: 'Unknown command: ' + msg.cmd }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ id: id, ok: false, error: String(err) }));
    }
  };

  ws.onclose = function() {
    // Attempt reconnect after 2s
    setTimeout(function() {
      // Only reconnect if page is still open
      if (document.visibilityState !== 'hidden') {
        var retry = new WebSocket('ws://localhost:' + PROBE_PORT);
        // Swap reference — but since this is in an IIFE, just re-run would be cleaner.
        // For simplicity, we don't auto-reconnect in test context.
      }
    }, 2000);
  };
})();
