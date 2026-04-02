// Service worker: polls test runner for screenshot/resize commands via HTTP.
// MV3 service workers kill WebSocket connections on idle, so we use fetch polling.

var runnerBase = null;
var targetTabId = null;
var polling = false;

chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  try {
    var url = new URL(tab.url);
    var extPort = url.searchParams.get('extPort');
    if (!extPort) return;
    var base = 'http://localhost:' + extPort;
    if (runnerBase === base && polling) return;
    runnerBase = base;
    targetTabId = tabId;
    console.log('[probe-ext] Runner at ' + base + ', tab ' + tabId);
    // Signal ready
    fetch(base + '/ext/ready', { method: 'POST' }).catch(function() {});
    startPolling();
  } catch (e) {}
});

function startPolling() {
  if (polling) return;
  polling = true;
  poll();
}

function poll() {
  if (!runnerBase) { polling = false; return; }
  fetch(runnerBase + '/ext/poll', { method: 'POST' })
    .then(function(res) { return res.json(); })
    .then(function(msg) {
      if (msg && msg.id && msg.cmd) {
        handleCommand(msg);
      }
      // Continue polling
      setTimeout(poll, 300);
    })
    .catch(function() {
      // Runner gone, stop polling
      console.log('[probe-ext] Runner gone, stopping');
      polling = false;
      runnerBase = null;
    });
}

function handleCommand(msg) {
  var id = msg.id;

  if (msg.cmd === 'screenshot') {
    chrome.debugger.attach({ tabId: targetTabId }, '1.3', function() {
      if (chrome.runtime.lastError) {
        console.log('[probe-ext] attach:', chrome.runtime.lastError.message);
      }
      chrome.debugger.sendCommand({ tabId: targetTabId }, 'Page.captureScreenshot', { format: 'png' }, function(result) {
        chrome.debugger.detach({ tabId: targetTabId }, function() {});
        if (chrome.runtime.lastError || !result) {
          respond(id, false, (chrome.runtime.lastError || {}).message || 'capture failed');
        } else {
          respond(id, true, { base64: result.data });
        }
      });
    });
    return;
  }

  if (msg.cmd === 'resize') {
    chrome.windows.getCurrent(function(win) {
      chrome.windows.update(win.id, {
        width: msg.width || 1280,
        height: msg.height || 800
      }, function() {
        var err = chrome.runtime.lastError;
        respond(id, err ? false : true, err ? err.message : undefined);
      });
    });
    return;
  }

  respond(id, false, 'Unknown: ' + msg.cmd);
}

function respond(id, ok, data) {
  if (!runnerBase) return;
  var body = { id: id, ok: ok };
  if (ok && data !== undefined) body.data = data;
  if (!ok && data !== undefined) body.error = data;
  fetch(runnerBase + '/ext/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).catch(function(e) { console.log('[probe-ext] respond error:', e); });
}
