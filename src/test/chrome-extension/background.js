/**
 * Service worker for the test probe extension.
 * - Programmatically injects content.js into localhost dashboard tabs
 * - Handles captureVisibleTab for screenshots
 * - Handles window resize
 */

// Inject content script into matching tabs on navigation
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.includes('localhost') && tab.url.includes('probePort')) {
    chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    }).catch(err => console.error('[probe-ext] inject failed:', err));
  }
});

// Also inject on startup into any existing matching tabs
chrome.tabs.query({ url: '*://localhost/*' }, (tabs) => {
  for (const tab of tabs) {
    if (tab.url && tab.url.includes('probePort') && tab.id) {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      }).catch(err => console.error('[probe-ext] startup inject failed:', err));
    }
  }
});

// Handle messages from content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.cmd === 'captureScreenshot') {
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
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
