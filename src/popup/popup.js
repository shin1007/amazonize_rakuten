/* Amazonize Rakuten - ポップアップ設定 */

// 既定値は content script と同じ settings.js のものを使う（2か所に書くとずれる）
const { DEFAULTS } = window.AZR;

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

  /* 実行と進み具合 -----------------------------------------------------------
   * スキャンは数分かかり、その間にポップアップは閉じられる。閉じると sendMessage の応答は
   * 受け取れないので、進み具合は service worker に聞き、結果は session storage から読む。
   * 開き直したときも同じ道筋で、実行中なら進み具合を、終わっていれば前回の結果を出す。 */

  const batchButton = $('#batchEntry');
  const runButtons = [scanButton, batchButton];

  function describe(res) {
    if (!res?.ok) return `失敗しました: ${res?.error ?? '不明なエラー'}`;
    return `${res.checked}件を確認 / 新たに${res.entered}件エントリー / 既にエントリー済み${res.alreadyEntered}件`
      + (res.failed ? ` / 判定できず${res.failed}件` : '')
      + (res.skipped ? ` / 対象外のURL ${res.skipped}件` : '');
  }

  async function showLastResult({ withTime }) {
    let res = null;
    try {
      res = (await chrome.storage.session.get('azrScanResult')).azrScanResult;
    } catch { /* session storage 不可 */ }
    if (!res) return;
    const at = withTime && res.finishedAt
      ? `前回（${new Date(res.finishedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}）: `
      : '';
    scanStatus.textContent = at + describe(res);
  }

  let pollTimer = null;
  function setRunning(on) {
    for (const b of runButtons) b.disabled = on;
    if (on && !pollTimer) {
      pollTimer = setInterval(pollScan, 800);
    } else if (!on && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function pollScan() {
    const s = await chrome.runtime.sendMessage({ type: 'azr:scanStatus' }).catch(() => null);
    if (!s?.running) {
      setRunning(false);
      await showLastResult({ withTime: false });
      await renderCampaignList();
      return;
    }
    scanStatus.textContent = s.total ? `${s.phase}… ${s.done}/${s.total}` : `${s.phase}…`;
  }

  async function start(message, firstText) {
    setRunning(true);
    scanStatus.textContent = firstText;
    const res = await chrome.runtime.sendMessage(message).catch((e) => ({ ok: false, error: String(e?.message || e) }));
    if (res?.ok) return pollScan();
    // 別の実行がすでに走っていたなら、そちらの進み具合をそのまま追う
    const s = await chrome.runtime.sendMessage({ type: 'azr:scanStatus' }).catch(() => null);
    if (s?.running) return;
    // 対象のURLが無かったなど、始まらずに終わったものは保存されないので、ここで出す
    setRunning(false);
    scanStatus.textContent = describe(res);
    await renderCampaignList();
  }

  scanButton.addEventListener('click', () => {
    const entry = $('input[data-key="campaignScanEntry"]').checked;
    start({ type: 'azr:scanCampaigns', entry }, 'トップページを読み込み中…');
  });

  batchButton.addEventListener('click', () => {
    const list = urls.value.split('\n').map((v) => v.trim()).filter(Boolean);
    if (!list.length) {
      status.textContent = 'URLを1行以上入力してください';
      return;
    }
    status.textContent = '';
    start({ type: 'azr:enterCampaignUrls', urls: list }, 'エントリー中…');
  });

  renderCampaignList();

  // 開いた時点で実行中なら進み具合を追い、終わっていれば前回の結果を出す
  const now = await chrome.runtime.sendMessage({ type: 'azr:scanStatus' }).catch(() => null);
  if (now?.running) {
    setRunning(true);
    pollScan();
  } else {
    showLastResult({ withTime: true });
  }
}

init();
