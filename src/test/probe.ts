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

        case 'screenshot': {
          var w = window.innerWidth;
          var h = window.innerHeight;
          // Clone the document and inline all computed styles for accurate rendering
          var clone = document.documentElement.cloneNode(true);
          // Build SVG with foreignObject containing the page HTML
          var svgXml = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
            '<foreignObject width="100%" height="100%">' +
            new XMLSerializer().serializeToString(document.documentElement) +
            '</foreignObject></svg>';
          var svgBlob = new Blob([svgXml], { type: 'image/svg+xml;charset=utf-8' });
          var svgUrl = URL.createObjectURL(svgBlob);
          var img = new Image();
          img.onload = function() {
            var canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            var ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            URL.revokeObjectURL(svgUrl);
            try {
              var dataUrl = canvas.toDataURL('image/png');
              // Strip the data:image/png;base64, prefix
              var base64 = dataUrl.split(',')[1] || '';
              ws.send(JSON.stringify({ id: id, ok: true, data: { base64: base64, width: w, height: h } }));
            } catch (canvasErr) {
              ws.send(JSON.stringify({ id: id, ok: false, error: 'Canvas tainted: ' + canvasErr }));
            }
          };
          img.onerror = function() {
            URL.revokeObjectURL(svgUrl);
            ws.send(JSON.stringify({ id: id, ok: false, error: 'SVG render failed' }));
          };
          img.src = svgUrl;
          break;
        }

        case 'snapshot': {
          var state = window.__dashboardState || {};

          var descriptor = {
            url: location.href,
            title: document.title,
            timestamp: new Date().toISOString(),
            viewport: { width: window.innerWidth, height: window.innerHeight },
            agentCards: Array.from(document.querySelectorAll('[data-agent]')).map(function(card) {
              return {
                name: card.dataset.agent,
                stateText: (function() { var b = card.querySelector('.state-badge'); return b ? b.textContent : ''; })(),
                hasUnread: !!card.querySelector('.unread-badge'),
                indicators: Array.from(card.querySelectorAll('.indicator-badge')).map(function(b) { return b.textContent; }),
                indicatorActions: Array.from(card.querySelectorAll('.indicator-action')).map(function(b) { return b.textContent; }),
                customButtons: Array.from(card.querySelectorAll('[data-action^="custom/"]')).map(function(b) { return b.textContent; }),
                hasTmuxCopy: !!card.querySelector('[data-copy-tmux]'),
                tmuxCommand: (function() { var b = card.querySelector('[data-copy-tmux]'); return b ? b.dataset.copyTmux : null; })(),
                visible: card.offsetParent !== null,
              };
            }),
            selectedAgent: state.selected || null,
            threadView: state.threadView || null,
            threadMessageCount: document.querySelectorAll('.msg').length,
            messageCopyButtons: document.querySelectorAll('.msg-copy').length,
            messageLinks: Array.from(document.querySelectorAll('.msg-body a[href]')).map(function(a) { return { href: a.getAttribute('href'), text: a.textContent }; }),
            filterChipsActive: Array.from(document.querySelectorAll('.filter-chip.active')).map(function(c) { return c.textContent; }),
            modalVisible: !!document.querySelector('.create-modal-overlay, .reminder-edit-overlay'),
            createFormVisible: !!document.querySelector('.create-agent-btn'),
            searchValue: document.getElementById('agentSearch') ? document.getElementById('agentSearch').value : '',
          };

          var html = document.documentElement.outerHTML;

          ws.send(JSON.stringify({ id: id, ok: true, data: { descriptor: descriptor, html: html } }));
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
