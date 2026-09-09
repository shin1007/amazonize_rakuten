/* Amazonize Rakuten - service worker */

// content script から chrome.storage.session を読めるようにする
chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
  } catch (e) {
    console.warn('[AZR] session storage access level:', e);
  }
});

const BATCH_WINDOW_MS = 3 * 60 * 1000;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'azr:closeTab') {
    if (sender.tab?.id) chrome.tabs.remove(sender.tab.id).catch(() => {});
    return false;
  }

  if (msg?.type === 'azr:batchEntry') {
    (async () => {
      const urls = Array.isArray(msg.urls) ? msg.urls.filter((u) => /^https:\/\/[\w.-]*rakuten\.co\.jp\//.test(u)) : [];
      if (!urls.length) return sendResponse({ ok: false, error: 'URLがありません' });

      await chrome.storage.session.set({
        azrBatchEntry: { until: Date.now() + BATCH_WINDOW_MS, closeTab: msg.closeTab !== false }
      });
      for (const url of urls) {
        await chrome.tabs.create({ url, active: false });
      }
      sendResponse({ ok: true, opened: urls.length });
    })();
    return true; // 非同期応答
  }

  return false;
});
