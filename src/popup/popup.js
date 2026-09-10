/* Amazonize Rakuten - ポップアップ設定 */

const DEFAULTS = {
  enabled: true,
  simplifyItem: true,
  simplifySearch: true,
  cartTotal: true,
  couponList: true,
  couponAutoGrab: false,
  couponAutoApply: true,
  couponAutoApplyConfirm: false,
  campaignEntry: true,
  campaignAutoEntry: false,
  campaignScanEntry: true,
  campaignUrls: [
    'https://event.rakuten.co.jp/card/pointday/',
    'https://event.rakuten.co.jp/campaign/sports/',
    'https://event.rakuten.co.jp/campaign/point-up/everyday/point/'
  ],
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

  /* キャンペーンの一括スキャン ---------------------------------------------- */

  const scanStatus = $('#scanStatus');
  const scanButton = $('#scanCampaigns');

  // 一覧に出す文言。status はキャンペーンページを実際に見て決めたもの。
  const STATUS_LABEL = {
    entered: 'エントリーした',
    already: 'エントリー済み',
    entry: '未エントリー',
    none: 'エントリー不要',
    timeout: '時間切れ',
    error: '失敗',
    closed: '中断',
    unknown: '不明'
  };
  const ORDER = ['entered', 'already', 'entry', 'timeout', 'error', 'closed', 'unknown', 'none'];

  const day = (ms) => (ms ? new Date(ms).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' }) : '');

  async function renderCampaignList() {
    const items = (await chrome.runtime.sendMessage({ type: 'azr:campaignList' })) || [];
    const list = $('#campaignList');
    list.textContent = '';

    // 分母は「エントリーするものがあったページ」。特集ページまで数えても意味がない。
    const done = items.filter((i) => i.status === 'entered' || i.status === 'already');
    const target = items.filter((i) => ['entered', 'already', 'entry'].includes(i.status));
    $('#enteredCount').textContent = target.length ? `(${done.length}/${target.length})` : '';

    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'まだ調べていません';
      list.append(li);
      return;
    }

    for (const item of [...items].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status))) {
      const li = document.createElement('li');
      li.className = `campaign is-${item.status}`;

      const a = document.createElement('a');
      a.href = item.url;
      a.target = '_blank';
      a.textContent = item.title || item.url.replace('https://event.rakuten.co.jp/', '');
      a.title = item.url;

      const state = document.createElement('span');
      state.className = 'campaign-state';
      state.textContent = `${STATUS_LABEL[item.status] || item.status}${item.checkedAt ? ` ${day(item.checkedAt)}` : ''}`;

      li.append(a, state);
      list.append(li);
    }
  }

  let pollTimer = null;
  async function pollScan() {
    const s = await chrome.runtime.sendMessage({ type: 'azr:scanStatus' });
    if (!s?.running) {
      clearInterval(pollTimer);
      pollTimer = null;
      return;
    }
    scanStatus.textContent = s.total
      ? `${s.phase}… ${s.done}/${s.total}`
      : `${s.phase}…`;
  }

  scanButton.addEventListener('click', async () => {
    scanButton.disabled = true;
    scanStatus.textContent = 'トップページを読み込み中…';
    pollTimer = setInterval(pollScan, 800);

    const entry = $('input[data-key="campaignScanEntry"]').checked;
    const res = await chrome.runtime.sendMessage({ type: 'azr:scanCampaigns', entry });

    clearInterval(pollTimer);
    pollTimer = null;
    scanButton.disabled = false;
    scanStatus.textContent = res?.ok
      ? `${res.checked}件を確認 / 新たに${res.entered}件エントリー / 既にエントリー済み${res.alreadyEntered}件`
        + (res.failed ? ` / 判定できず${res.failed}件` : '')
      : `失敗しました: ${res?.error ?? '不明なエラー'}`;
    await renderCampaignList();
  });

  renderCampaignList();

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
