/**
 * Service worker for the test probe extension.
 * Handles screenshot requests via chrome.tabs.captureVisibleTab().
 * Communicates with content script via chrome.runtime messages.
 */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.cmd === 'captureScreenshot') {
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        // Strip data:image/png;base64, prefix
        const base64 = dataUrl.split(',')[1] || '';
        sendResponse({ ok: true, data: { base64 } });
      }
    });
    return true; // async sendResponse
  }

  if (msg.cmd === 'resizeWindow') {
    chrome.windows.update(sender.tab.windowId, {
      width: msg.width,
      height: msg.height,
    }, () => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ ok: true });
      }
    });
    return true;
  }
});
