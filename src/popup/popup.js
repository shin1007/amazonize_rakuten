/* Amazonize Rakuten - ポップアップ設定 */

const DEFAULTS = {
  enabled: true,
  simplifyItem: true,
  simplifySearch: true,
  cartTotal: true,
  couponList: true,
  couponAutoGrab: false,
  couponAutoApply: true,
  couponAutoApplyConfirm: true,
  campaignEntry: true,
  campaignAutoEntry: false,
  campaignUrls: ['https://event.rakuten.co.jp/campaign/'],
  debug: false
};

const $ = (sel) => document.querySelector(sel);
const status = $('#status');

async function init() {
  const s = await chrome.storage.sync.get(DEFAULTS);

  $('#enabled').checked = s.enabled;
  $('#enabled').addEventListener('change', (e) =>
    chrome.storage.sync.set({ enabled: e.target.checked }));

  for (const input of document.querySelectorAll('input[data-key]')) {
    const key = input.dataset.key;
    input.checked = Boolean(s[key]);
    input.addEventListener('change', () =>
      chrome.storage.sync.set({ [key]: input.checked }));
  }

  const urls = $('#campaignUrls');
  urls.value = (s.campaignUrls || []).join('\n');
  urls.addEventListener('change', () => {
    const list = urls.value.split('\n').map((v) => v.trim()).filter(Boolean);
    chrome.storage.sync.set({ campaignUrls: list });
  });

  $('#batchEntry').addEventListener('click', async () => {
    const list = urls.value.split('\n').map((v) => v.trim()).filter(Boolean);
    if (!list.length) {
      status.textContent = 'URLを1行以上入力してください';
      return;
    }
    status.textContent = 'タブを開いています…';
    const res = await chrome.runtime.sendMessage({ type: 'azr:batchEntry', urls: list, closeTab: true });
    status.textContent = res?.ok
      ? `${res.opened}件のページでエントリーを実行中です`
      : `失敗しました: ${res?.error ?? '不明なエラー'}`;
  });
}

init();
