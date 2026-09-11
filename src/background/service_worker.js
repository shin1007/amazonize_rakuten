/* Amazonize Rakuten - service worker */

// content script から chrome.storage.session を読めるようにする
chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
  } catch (e) {
    console.warn('[AZR] session storage access level:', e);
  }
});

// 裏のタブはブラウザに実行を絞られるため、獲得ページの遷移が数十秒かかることがある。
// 早すぎる打ち切りで「失敗」と言わないよう、長めに待つ（成功時は数秒で返る）。
const COUPON_TIMEOUT_MS = 45000;

/*
 * service worker は、拡張のイベントもAPIの呼び出しも30秒ほど無いと止められる。
 * 止まるとメモリにある待ち（裏タブの結果・打ち切りのタイマー・スキャンの進み具合）が消え、
 * 裏タブが開いたまま残り、スキャンは途中で終わる。裏タブの1ページは45秒まで待つので、
 * その間にイベントが途切れることがありうる。裏タブを待っている間だけ、20秒ごとに
 * 拡張のAPIを呼んで起こしておく（Chrome 110 以降、APIの呼び出しで止めるまでの時間が延びる）。
 */
const KEEP_ALIVE_MS = 20000;
let awakeHolders = 0;
let keepAliveTimer = null;

async function holdAwake(work) {
  if (awakeHolders++ === 0) {
    keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), KEEP_ALIVE_MS);
  }
  try {
    return await work();
  } finally {
    if (--awakeHolders === 0) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  }
}

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

/* 商品ページのフローティングクーポン -------------------------------------------
 * 元の商品ページで右下に出る「100円OFF … クーポンを獲得する」の枠。
 * 商品ページのバンドル（item-pc の pc.bundle.js、fetchFloatingCoupon / acquireFloatingCoupon）が
 * 呼んでいるのと同じAPIを、同じ引数で呼ぶ。どちらもJSONP。
 *   GET api.coupon.rakuten.co.jp/search?items=["itemId=…&price=…&shopId=…"]&locId=101&options=["incAcqCond=true"]
 *     → { code, items: [{ coupons: [{ getKey, couponName, discountType, discountFactor, otherConds, acquired, … }] }] }
 *     未ログインだと { code: 2 } だけが返り、クーポンは出ない。
 *   GET api.coupon.rakuten.co.jp/acquireCoupon/json?getKey=…&key=<商品ページ用のキー>
 *     → { code, alreadyAcquired }  code: 1 成功 / 2 未ログイン / 3 期限切れ / 4 配布終了 / 0 失敗 / 9 メンテナンス
 * 商品ページのオリジンから呼ぶと Cookie の扱いがページ次第になるので、service worker から呼ぶ。
 *
 * **このAPIは Referer が商品ページでないと、ログインしていても {"code":2}（未ログイン）を返す。**
 * Cookie は届いていても駄目だった（実機で Referer の有無だけを変えて確認）。拡張からの fetch には
 * Referer が付かず、fetch の referrer 指定も別オリジンは効かないので、ヘッダーの書き換え規則で付ける。
 * 対象はタブに属さない通信（= この service worker からの通信）だけにし、ページの通信には触らない。
 */
const REFERER_RULE_ID = 1;
async function installCouponRefererRule() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [REFERER_RULE_ID],
      addRules: [{
        id: REFERER_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'referer', operation: 'set', value: 'https://item.rakuten.co.jp/' }]
        },
        condition: {
          urlFilter: '||api.coupon.rakuten.co.jp/',
          tabIds: [chrome.tabs.TAB_ID_NONE],
          resourceTypes: ['xmlhttprequest']
        }
      }]
    });
  } catch (e) {
    console.warn('[AZR] Referer の規則を入れられない:', e);
  }
}
// 規則はブラウザを閉じると消えるので、service worker が起きるたびに入れ直す
const refererRuleReady = installCouponRefererRule();

const FLOATING_SEARCH = 'https://api.coupon.rakuten.co.jp/search';
const FLOATING_ACQUIRE = 'https://api.coupon.rakuten.co.jp/acquireCoupon/json';
const FLOATING_ITEM_PAGE_KEY = 'wIIcsUeYctybYOMyuJn8V040KBPNF5ee'; // 商品ページのバンドルに埋め込まれている ITEM_PAGE_KEY
const FLOATING_LOC_ID = '101'; // 同じく COUPON_LOC_ID（PCの商品ページ）

/** JSONPの応答 cb({...}) から中身を取り出す */
async function fetchJsonp(url) {
  await refererRuleReady;
  const u = new URL(url);
  u.searchParams.set('callback', 'azr');
  const res = await fetch(u.href, { credentials: 'include', cache: 'no-cache' });
  if (!res.ok) return null;
  const text = await res.text();
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  if (start < 0 || end <= start) return null;
  return JSON.parse(text.slice(start + 1, end));
}

async function floatingCoupons({ itemId, shopId, price, hasSubscription }) {
  const u = new URL(FLOATING_SEARCH);
  u.searchParams.set('items', `["itemId=${itemId}&price=${price}&shopId=${shopId}"]`);
  u.searchParams.set('locId', FLOATING_LOC_ID);
  u.searchParams.set('options', '["incAcqCond=true"]');
  // 定期購入の無い商品では、定期購入専用のクーポンを除く（商品ページと同じ）
  if (!hasSubscription) {
    u.searchParams.set('otherCondFilters', '[{"typeCode": "RS002","startValue": "1","isExcluded": true}]');
  }
  const data = await fetchJsonp(u.href);
  if (!data) return null;
  if (Number(data.code) === 2) return { login: true, coupons: [] };
  const list = Array.isArray(data.items) && Array.isArray(data.items[0]?.coupons) ? data.items[0].coupons : [];
  return {
    login: false,
    coupons: list.filter((c) => c?.getKey).map((c) => {
      const conds = Array.isArray(c.otherConds) ? c.otherConds : [];
      const amount = conds.find((o) => o?.otherCondTypeCd === 'RS003' || o?.otherCondTypeCd === 'RS004');
      const sales = conds.find((o) => o?.otherCondTypeCd === 'RS002')?.startValue;
      return {
        getKey: String(c.getKey),
        name: String(c.couponName || ''),
        // 1: 円引き / 2: %引き
        discount: Number(c.discountType) === 1 ? `${Number(c.discountFactor).toLocaleString('ja-JP')}円OFF` : `${c.discountFactor}%OFF`,
        minSpend: amount?.otherCondTypeCd === 'RS003' ? Number(amount.startValue) || null : null,
        minUnits: amount?.otherCondTypeCd === 'RS004' ? Number(amount.startValue) || null : null,
        salesMethod: sales === '0' ? 'normal' : sales === '1' ? 'subscription' : null,
        endDate: c.couponEndDate || null,
        acquired: Boolean(c.acquired)
      };
    })
  };
}

async function acquireFloatingCoupon(getKey) {
  const u = new URL(FLOATING_ACQUIRE);
  u.searchParams.set('getKey', getKey);
  u.searchParams.set('key', FLOATING_ITEM_PAGE_KEY);
  const data = await fetchJsonp(u.href);
  const code = Number(data?.code);
  if (code === 1) return { ok: true, status: data.alreadyAcquired ? 'already' : 'acquired' };
  if (code === 2) return { ok: false, status: 'login' };
  if (code === 3) return { ok: false, status: 'rejected', reason: 'COUPON_VALIDITY_PERIOD_OVER' };
  if (code === 4) return { ok: false, status: 'rejected', reason: 'COUPON_STATUS_FINISHED' };
  return { ok: false, status: 'error', reason: Number.isFinite(code) ? `CODE_${code}` : '' };
}

/* 商品とショップの評価 -------------------------------------------------------
 * 商品ページのJSONにはレビューの件数しか無く（評価点が入らなくなった）、店舗の評価はどこにも無い。
 * 商品レビューのページは window.__INITIAL_STATE__ に両方を埋め込んでいるので、そこを読む。
 *   "itemInfo":{"itemId":…,"reviewRatings":{"average":4.32,"totalCount":78479,…}
 *   "shopInfo":{"reviewRatings":{"average":4.78,"totalCount":127449,…}
 * 状態全体はJSONとして解析できない形で書かれているので、必要な所だけ切り出す。
 * 1ページ300KB余りあるので、商品ごとに覚えておく。評価は日単位でしか動かない。
 */
const RATINGS_TTL_MS = 12 * 60 * 60 * 1000;

/** 'itemInfo' / 'shopInfo' の reviewRatings。楽天自身が出さないもの（shouldBeDisplayed:false）は null。 */
function parseRating(html, section) {
  // reviewRatings がその節の直下にあるものだけを拾う。ページには空の "itemInfo":{} も先に出てくるので、
  // 単に次の reviewRatings を探すと、後ろの shopInfo の評価を商品の評価と取り違える。
  const m = new RegExp(`"${section}":\\{[^{}]*"reviewRatings":\\{`).exec(html);
  if (!m) return undefined;
  // 評価の分布（distribution）が続くが、そこには average / totalCount の名前は出てこない
  const s = html.slice(m.index + m[0].length, m.index + m[0].length + 600);
  if (/"shouldBeDisplayed":false/.test(s)) return null;
  const avg = Number(s.match(/"average":([\d.]+)/)?.[1]);
  const count = Number(s.match(/"totalCount":(\d+)/)?.[1]);
  if (!Number.isFinite(avg) || avg <= 0) return null;
  return { score: Math.round(avg * 100) / 100, count: Number.isFinite(count) ? count : null };
}

/** 商品IDが無ければショップレビューのページで店舗の評価だけ取る */
async function reviewRatings(shopId, itemId) {
  const key = itemId ? `${shopId}_${itemId}` : `${shopId}_${shopId}`;
  const { azrRatings: cache = {} } = await chrome.storage.local.get('azrRatings');
  const now = Date.now();
  const hit = cache[key];
  if (hit && now - hit.at < RATINGS_TTL_MS) return hit.ratings;

  const url = itemId
    ? `https://review.rakuten.co.jp/item/1/${key}/1.1/`
    : `https://review.rakuten.co.jp/shop/4/${key}/1.1/`;
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) return null;
  const html = await res.text();
  const item = itemId ? parseRating(html, 'itemInfo') : null;
  const shop = parseRating(html, 'shopInfo');
  // どちらも見つからない = ページの形が変わった。覚えずに次も読みに行く。
  if (item === undefined && shop === undefined) return null;
  const ratings = { item: item ?? null, shop: shop ?? null };

  // 期限切れはここで捨てる（見た商品の数だけ溜まり続けないように）
  for (const [k, v] of Object.entries(cache)) if (now - v.at >= RATINGS_TTL_MS) delete cache[k];
  cache[key] = { at: now, ratings };
  await chrome.storage.local.set({ azrRatings: cache });
  return ratings;
}

/* 獲得したクーポンの履歴 -----------------------------------------------------
 * 自動獲得は既定でONで、押さなくても獲得が進む。何を獲得したのかをポップアップで
 * 見られるよう、新たに獲得できたもの（獲得済みだったものは除く）だけを残す。
 * 中身は商品ページに出ていたクーポン名・店舗名・商品名・ページのURLだけ。ブラウザの外へは出さない。
 */
const ACQUIRED_MAX = 100;

/** storage を読んで書くまでを1件ずつにする。並べて走らせると、後の書き込みが先の分を消す。 */
function serialized() {
  let queue = Promise.resolve();
  return (fn) => {
    queue = queue.then(fn).catch((e) => console.warn('[AZR] 保存に失敗:', e));
    return queue;
  };
}
const saveAcquiredSerially = serialized();

function recordAcquired(res, record) {
  if (res?.status !== 'acquired' || !record || typeof record !== 'object') return;
  const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
  const url = str(record.url, 300);
  const entry = {
    name: str(record.name, 120),
    shop: str(record.shop, 60),
    item: str(record.item, 120),
    url: /^https:\/\/item\.rakuten\.co\.jp\//.test(url) ? url : '',
    auto: Boolean(record.auto),
    at: Date.now()
  };
  saveAcquiredSerially(async () => {
    const { azrAcquired: list = [] } = await chrome.storage.local.get('azrAcquired');
    await chrome.storage.local.set({ azrAcquired: [entry, ...list].slice(0, ACQUIRED_MAX) });
  });
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
async function grabCoupon(url, { apiOnly = false } = {}) {
  const key = couponGetKey(url);
  // getkey の無いページは獲得ページではない。タブで開くと、クーポンのページを「離れた」ことを
  // 獲得できた印と読むため、何も獲得していないのに成功と返してしまう。
  if (!key) return { ok: false, status: 'error' };
  try {
    const viaApi = await acquireByApi(key);
    if (viaApi && viaApi.status !== 'login') return viaApi;
    // 自動獲得は押されていないので、裏タブを勝手に開かない。未ログイン等は行に返すだけにする。
    if (apiOnly) return viaApi || { ok: false, status: 'unknown' };
  } catch (e) {
    console.warn('[AZR] 獲得APIが使えないのでタブで開きます:', e);
    if (apiOnly) return { ok: false, status: 'error' };
  }
  return holdAwake(() => grabByTab(url));
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

// 3タブが同時に結果を返すので、読んで書くまでを1件ずつにする。
// 並べて走らせると、先に書いた分を後の書き込みが古い一覧で上書きして消す。
const saveCampaignSerially = serialized();
function saveCampaign(url, patch) {
  return saveCampaignSerially(async () => {
    const data = await loadCampaigns();
    data.items[url] = { url, ...(data.items[url] || {}), ...patch };
    data.updatedAt = Date.now();
    await chrome.storage.local.set({ azrCampaigns: data });
  });
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

/** 実行中はアイコンに残りの件数を出す。ポップアップを閉じても進み具合が分かるように。 */
function setBadge(text) {
  chrome.action.setBadgeBackgroundColor({ color: '#f08804' }).catch(() => {});
  chrome.action.setBadgeText({ text }).catch(() => {});
}

/**
 * スキャンとURL指定の実行を1つずつ走らせる。
 * 結果は session storage にも残す。ポップアップは実行中に閉じられることが多く、
 * 開き直したときにそこから読んで出す（sendMessage の応答は閉じた時点で受け取れなくなる）。
 */
async function runScan(phase, job) {
  if (scanState.running) return { ok: false, error: 'すでに実行中です' };
  scanState = { running: true, phase, done: 0, total: 0, startedAt: Date.now() };
  setBadge('…');
  let result;
  try {
    result = await holdAwake(job);
  } catch (e) {
    result = { ok: false, error: String(e?.message || e) };
  }
  // 結果を書いてから running を下ろす。ポップアップは running が下りたのを見て結果を読みに来る。
  await chrome.storage.session.set({ azrScanResult: { ...result, finishedAt: Date.now() } }).catch(() => {});
  setBadge('');
  scanState = { ...scanState, running: false, phase: '' };
  return result;
}

/**
 * キャンペーンのページを数タブずつ裏で開いて判定（とエントリー）し、結果を記録する。
 * targets は { url: 記録に使う正規化したURL, open: 実際に開くURL }。
 */
async function checkCampaigns(targets, entry) {
  scanState.phase = entry ? 'エントリー中' : '確認中';
  scanState.total = targets.length;

  const results = [];
  await eachLimited(targets, SCAN_CONCURRENCY, async ({ url, open }) => {
    const r = await runInTab(open, 'campaign', entry);
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
    setBadge(String(targets.length - results.length || ''));
  });

  const count = (s) => results.filter((r) => r.status === s).length;
  return {
    ok: true,
    checked: results.length,
    entered: count('entered'),
    alreadyEntered: count('already'),
    none: count('none'),
    failed: results.filter((r) => ['timeout', 'error', 'unknown', 'closed'].includes(r.status)).length
  };
}

/**
 * ポップアップの「URLを指定して実行」。スキャンと同じく、そのURLのために開いたタブだけで
 * エントリーし、表示が変わったことを確かめてから記録する。
 * （以前は「3分間はどのキャンペーンページでも自動エントリーして閉じる」印を立てていたため、
 * その間に自分で開いたキャンペーンページまでエントリーされて閉じていた。）
 */
function enterCampaignUrls(rawUrls) {
  const targets = [];
  const seen = new Set();
  let skipped = 0;
  for (const raw of rawUrls) {
    const url = normalizeCampaignUrl(raw);
    if (!url) { skipped++; continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    // クエリを落とすと開けなくなるページがあるので、書かれたURLのまま開く（rd.rakuten の包みは剥がす）
    targets.push({ url, open: new URL(raw).hostname === CAMPAIGN_HOST ? raw : url });
  }
  if (!targets.length) return Promise.resolve({ ok: false, error: `${CAMPAIGN_HOST} のURLがありません` });

  return runScan('エントリー中', async () => ({ ...(await checkCampaigns(targets, true)), skipped }));
}

function scanCampaigns({ entry }) {
  return runScan('トップページを読み込み中', async () => {
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

    const summary = await checkCampaigns(targets.map((url) => ({ url, open: url })), entry);
    return { ...summary, scanned: urls.length };
  });
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

  // 商品ページから: このクーポンを裏で獲得してほしい
  if (msg?.type === 'azr:grabCoupon') {
    const url = String(msg.url || '');
    if (!COUPON_PAGE.test(url)) {
      sendResponse({ ok: false, status: 'error', error: '対象外のURLです' });
      return false;
    }
    grabCoupon(url, { apiOnly: Boolean(msg.apiOnly) }).then((res) => {
      recordAcquired(res, msg.record);
      sendResponse(res);
    });
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

  // 商品ページから: フローティングクーポン（元のページで右下に出る枠）の一覧
  if (msg?.type === 'azr:floatingCoupons') {
    const itemId = String(msg.itemId || '');
    const shopId = String(msg.shopId || '');
    const price = Number(msg.price);
    if (!/^\d+$/.test(itemId) || !/^\d+$/.test(shopId) || !(price > 0)) {
      sendResponse(null);
      return false;
    }
    floatingCoupons({ itemId, shopId, price: Math.round(price), hasSubscription: Boolean(msg.hasSubscription) })
      .then(sendResponse)
      .catch((e) => { console.warn('[AZR] フローティングクーポンを取れない:', e); sendResponse(null); });
    return true; // 非同期応答
  }

  // 商品ページから: フローティングクーポンの獲得
  if (msg?.type === 'azr:grabFloatingCoupon') {
    const getKey = String(msg.getKey || '');
    if (!/^[A-Za-z0-9_=-]+$/.test(getKey)) {
      sendResponse({ ok: false, status: 'error' });
      return false;
    }
    acquireFloatingCoupon(getKey)
      .then((res) => {
        recordAcquired(res, msg.record);
        sendResponse(res);
      })
      .catch((e) => sendResponse({ ok: false, status: 'error', error: String(e) }));
    return true; // 非同期応答
  }

  // 商品ページから: 商品とショップの評価
  if (msg?.type === 'azr:reviewRatings') {
    const shopId = String(msg.shopId || '');
    const itemId = msg.itemId ? String(msg.itemId) : '';
    if (!/^\d+$/.test(shopId) || (itemId && !/^\d+$/.test(itemId))) {
      sendResponse(null);
      return false;
    }
    reviewRatings(shopId, itemId).then(sendResponse).catch(() => sendResponse(null));
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

  // ポップアップから: 指定したURLでエントリーする
  if (msg?.type === 'azr:enterCampaignUrls') {
    enterCampaignUrls(Array.isArray(msg.urls) ? msg.urls.map(String) : []).then(sendResponse);
    return true; // 非同期応答
  }

  return false;
});
