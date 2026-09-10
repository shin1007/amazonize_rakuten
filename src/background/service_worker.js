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
// 裏のタブはブラウザに実行を絞られるため、獲得ページの遷移が数十秒かかることがある。
// 早すぎる打ち切りで「失敗」と言わないよう、長めに待つ（成功時は数秒で返る）。
const COUPON_TIMEOUT_MS = 45000;

const COUPON_PAGE = /^https:\/\/coupon\.rakuten\.co\.jp\//;
const COUPON_API = 'https://coupon.rakuten.co.jp/api/v2/coupons/';
// ログインや結果不明は本人に見てもらうしかない。それ以外は裏で閉じる。
const KEEP_TAB = new Set(['login', 'unknown', 'timeout']);

/** 獲得ページのURLから getkey を取り出す */
function couponGetKey(url) {
  const m = String(url).match(/[?&]getkey=([^&#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/*
 * 獲得ページ（Next.js製）が実際に叩いているのと同じAPIを、そのまま呼ぶ。
 *
 *   PUT /api/v2/coupons/{getkey}/acquire
 *     200        → 本文の is_already_acquired で「獲得」と「獲得済み」を分ける
 *     401        → 未ログイン
 *     400/404/410→ 本文の reason に COUPON_STATUS_INVALID 等の理由コード
 *
 * ここから呼べる理由（実機で確認済み）:
 *   - host_permissions があるので service worker からの fetch はCORSの対象外。
 *     商品ページの content script から直接呼ぶと、このAPIは 403 で弾く。
 *   - 拡張からの fetch には Origin が付かず、SameSite付きのCookieも送られる。
 */
async function acquireByApi(key) {
  const res = await fetch(`${COUPON_API}${encodeURIComponent(key)}/acquire`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  if (res.status === 401) return { ok: false, status: 'login' };

  const data = await res.json().catch(() => null);
  if (res.ok) return { ok: true, status: data?.is_already_acquired ? 'already' : 'acquired' };
  if ([400, 404, 410].includes(res.status)) {
    return { ok: false, status: 'rejected', reason: typeof data?.reason === 'string' ? data.reason : '' };
  }
  return null; // 想定外の応答。呼び出し側でタブ方式に落とす。
}

/** クーポンの内容。認証不要で、名前・割引・獲得済みかどうかが取れる。 */
async function couponDetails(key) {
  const res = await fetch(`${COUPON_API}${encodeURIComponent(key)}/details`, { credentials: 'include' });
  if (!res.ok) return null;
  const d = await res.json();
  return {
    name: d?.coupon_name || '',
    discountType: d?.discount_type ?? null,
    discountFactor: d?.discount_factor ?? null,
    acquired: d?.acquire_status === 'ACQUIRED',
    endDate: d?.coupon_end_date || null
  };
}

/* APIが使えない場合の保険。
 * 裏のタブで本物の獲得ページを開き、結果を受け取ってから閉じる。 */
const couponWaiters = new Map(); // tabId -> (result) => void

function grabByTab(url) {
  return new Promise((resolve) => {
    chrome.tabs.create({ url, active: false }).then((tab) => {
      const tabId = tab.id;
      let settled = false;

      const finish = async (result) => {
        if (settled) return;
        settled = true;
        couponWaiters.delete(tabId);
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);

        if (result.status === 'closed') return resolve(result);
        // 本人の操作や確認が要るものだけ前面に出す。
        // 結果がはっきりしている失敗（配布終了など）は、行の文言で足りるので閉じる。
        if (KEEP_TAB.has(result.status)) await chrome.tabs.update(tabId, { active: true }).catch(() => {});
        else await chrome.tabs.remove(tabId).catch(() => {});
        resolve(result);
      };

      const onUpdated = (id, info, t) => {
        if (id !== tabId || info.status !== 'complete') return;
        // 権限のある *.rakuten.co.jp を出るとURLが読めなくなる = SSOログインへ飛ばされた
        if (!t.url) return finish({ ok: false, status: 'login' });
        // 獲得後は rd= の戻り先へ遷移する。獲得ページを離れていれば獲得できたとみなす。
        if (!COUPON_PAGE.test(t.url)) return finish({ ok: true, status: 'acquired' });
        // 獲得ページに留まっている間は、そのページのcontent scriptの報告を待つ
      };
      const onRemoved = (id) => { if (id === tabId) finish({ ok: false, status: 'closed' }); };
      const timer = setTimeout(() => finish({ ok: false, status: 'timeout' }), COUPON_TIMEOUT_MS);

      couponWaiters.set(tabId, finish);
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.onRemoved.addListener(onRemoved);
    }).catch((e) => resolve({ ok: false, status: 'error', error: String(e) }));
  });
}

/**
 * まず獲得ページと同じAPIを叩き、それで決着が付かない場合だけタブ方式に落とす。
 * 未ログインもタブに落とす。ログインすれば獲得ページがそのまま獲得まで進むので、
 * ここでただ「ログインしてください」と言うより手数が少ない。
 */
async function grabCoupon(url) {
  const key = couponGetKey(url);
  if (key) {
    try {
      const viaApi = await acquireByApi(key);
      if (viaApi && viaApi.status !== 'login') return viaApi;
    } catch (e) {
      console.warn('[AZR] 獲得APIが使えないのでタブで開きます:', e);
    }
  }
  return grabByTab(url);
}

/* キャンペーンの発見と一括エントリー ----------------------------------------
 *
 * 楽天には「エントリーできるキャンペーンの一覧」も「エントリー済みの一覧」も無い。
 * そこでトップページから event.rakuten.co.jp へのリンクを集め、1ページずつ裏タブで
 * 開いて「エントリーボタンがあるか / もう済んでいるか / そもそも特集ページか」を
 * 判定し、結果をこちらで記録する。記録がそのまま「エントリー済み一覧」になる。
 */
const TOP_PAGE = 'https://www.rakuten.co.jp/';
const CAMPAIGN_HOST = 'event.rakuten.co.jp';
const SCAN_CONCURRENCY = 3;        // 同時に開く裏タブの数
const SCAN_TAB_TIMEOUT_MS = 45000; // 1ページあたりの待ち時間（裏タブは実行を絞られるので長め）
const MAX_CAMPAIGNS = 80;
// 「エントリーするものが無いページ」は何度も開き直さない
const SKIP_NONE_MS = 7 * 24 * 60 * 60 * 1000;

/** このタブに何をさせたいか。content script が起動時に聞きに来る。 */
const scanTasks = new Map(); // tabId -> { task: 'links' | 'campaign', entry: boolean }
const scanWaiters = new Map(); // tabId -> (result) => void

let scanState = { running: false, phase: '', done: 0, total: 0, startedAt: 0 };

/** 計測用のパラメータを落として、同じページを1つに寄せる */
function normalizeCampaignUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  // トップページのバナーは rd.rakuten.co.jp/rat/?R2=<本来のURL> で包まれている
  if (url.hostname === 'rd.rakuten.co.jp') {
    const inner = url.searchParams.get('R2');
    if (!inner) return null;
    return normalizeCampaignUrl(inner);
  }
  if (url.hostname !== CAMPAIGN_HOST) return null;
  // l-id / scid などは同じページの計測違いでしかない
  return `${url.origin}${url.pathname}`;
}

/** 1つのタブに仕事をさせて、結果を受け取ってから閉じる */
function runInTab(url, task, entry) {
  return new Promise((resolve) => {
    chrome.tabs.create({ url, active: false }).then((tab) => {
      const tabId = tab.id;
      let settled = false;
      const finish = async (result) => {
        if (settled) return;
        settled = true;
        scanTasks.delete(tabId);
        scanWaiters.delete(tabId);
        clearTimeout(timer);
        chrome.tabs.onRemoved.removeListener(onRemoved);
        await chrome.tabs.remove(tabId).catch(() => {});
        resolve(result);
      };
      const onRemoved = (id) => { if (id === tabId) finish({ status: 'closed' }); };
      const timer = setTimeout(() => finish({ status: 'timeout' }), SCAN_TAB_TIMEOUT_MS);

      scanTasks.set(tabId, { task, entry });
      scanWaiters.set(tabId, finish);
      chrome.tabs.onRemoved.addListener(onRemoved);
    }).catch((e) => resolve({ status: 'error', error: String(e) }));
  });
}

/** 保存してある結果（= エントリー済み一覧の元データ） */
async function loadCampaigns() {
  const stored = await chrome.storage.local.get('azrCampaigns');
  return stored.azrCampaigns || { updatedAt: 0, items: {} };
}

async function saveCampaign(url, patch) {
  const data = await loadCampaigns();
  data.items[url] = { url, ...(data.items[url] || {}), ...patch };
  data.updatedAt = Date.now();
  await chrome.storage.local.set({ azrCampaigns: data });
}

/** まとめて実行。並びは保ちつつ、数タブずつ同時に開く。 */
async function eachLimited(list, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (index < list.length) {
      const i = index++;
      await worker(list[i], i);
    }
  });
  await Promise.all(runners);
}

async function scanCampaigns({ entry }) {
  if (scanState.running) return { ok: false, error: 'すでに実行中です' };
  scanState = { running: true, phase: 'トップページを読み込み中', done: 0, total: 0, startedAt: Date.now() };
  try {
    const found = await runInTab(TOP_PAGE, 'links', false);
    const rawLinks = Array.isArray(found?.links) ? found.links : [];
    if (!rawLinks.length) return { ok: false, error: 'トップページからリンクを取れませんでした' };

    const urls = [];
    const seen = new Set();
    for (const raw of rawLinks) {
      const url = normalizeCampaignUrl(raw);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }

    // 前回「エントリーするものが無い」と分かったページは、しばらく開き直さない
    const stored = await loadCampaigns();
    const now = Date.now();
    const targets = urls.filter((u) => {
      const prev = stored.items[u];
      return !(prev && prev.status === 'none' && now - (prev.checkedAt || 0) < SKIP_NONE_MS);
    }).slice(0, MAX_CAMPAIGNS);

    scanState.phase = entry ? 'エントリー中' : '確認中';
    scanState.total = targets.length;

    const results = [];
    await eachLimited(targets, SCAN_CONCURRENCY, async (url) => {
      const r = await runInTab(url, 'campaign', entry);
      const item = {
        url,
        title: r?.title || '',
        status: r?.status || 'unknown',
        entered: Boolean(r?.entered),
        checkedAt: Date.now()
      };
      await saveCampaign(url, item);
      results.push(item);
      scanState.done = results.length;
    });

    const count = (s) => results.filter((r) => r.status === s).length;
    return {
      ok: true,
      scanned: urls.length,
      checked: results.length,
      entered: count('entered'),
      alreadyEntered: count('already'),
      none: count('none'),
      failed: results.filter((r) => ['timeout', 'error', 'unknown', 'closed'].includes(r.status)).length
    };
  } finally {
    scanState = { ...scanState, running: false, phase: '' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 裏タブから: 自分は何をすべきタブか
  if (msg?.type === 'azr:scanTask') {
    sendResponse(sender.tab?.id != null ? (scanTasks.get(sender.tab.id) || null) : null);
    return false;
  }

  // トップページの裏タブから: 集めたリンク
  if (msg?.type === 'azr:campaignLinks') {
    scanWaiters.get(sender.tab?.id)?.({ links: msg.links || [] });
    return false;
  }

  // キャンペーンページの裏タブから: 判定とエントリーの結果
  if (msg?.type === 'azr:campaignResult') {
    scanWaiters.get(sender.tab?.id)?.({
      status: msg.status || 'unknown',
      title: msg.title || '',
      entered: Boolean(msg.entered)
    });
    return false;
  }

  // ポップアップから: 探して（必要なら）エントリーする
  if (msg?.type === 'azr:scanCampaigns') {
    scanCampaigns({ entry: msg.entry !== false }).then(sendResponse);
    return true; // 非同期応答
  }

  // ポップアップから: 進み具合
  if (msg?.type === 'azr:scanStatus') {
    sendResponse(scanState);
    return false;
  }

  // ポップアップから: 記録してある一覧
  if (msg?.type === 'azr:campaignList') {
    loadCampaigns().then((d) => sendResponse(Object.values(d.items).sort((a, b) => (b.checkedAt || 0) - (a.checkedAt || 0))));
    return true; // 非同期応答
  }

  if (msg?.type === 'azr:closeTab') {
    if (sender.tab?.id) chrome.tabs.remove(sender.tab.id).catch(() => {});
    return false;
  }

  // 商品ページから: このクーポンを裏で獲得してほしい
  if (msg?.type === 'azr:grabCoupon') {
    const url = String(msg.url || '');
    if (!COUPON_PAGE.test(url)) {
      sendResponse({ ok: false, status: 'error', error: '対象外のURLです' });
      return false;
    }
    grabCoupon(url).then(sendResponse);
    return true; // 非同期応答
  }

  // 商品ページから: クーポンの内容（名前・割引・獲得済みか）
  if (msg?.type === 'azr:couponDetails') {
    const key = couponGetKey(msg.url || '');
    if (!key) {
      sendResponse(null);
      return false;
    }
    couponDetails(key).then(sendResponse).catch(() => sendResponse(null));
    return true; // 非同期応答
  }

  // 獲得ページから: 自分は裏で開かれたタブか？（そうならパネルを出さずに結果だけ返す）
  if (msg?.type === 'azr:isGrabTab') {
    sendResponse({ grab: sender.tab?.id != null && couponWaiters.has(sender.tab.id) });
    return false;
  }

  // 獲得ページから: 獲得の結果
  if (msg?.type === 'azr:couponResult') {
    const done = sender.tab?.id != null && couponWaiters.get(sender.tab.id);
    if (done) done({ ok: Boolean(msg.ok), status: msg.status || 'unknown', message: msg.message || '' });
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
