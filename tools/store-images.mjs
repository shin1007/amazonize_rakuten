/* Chrome ウェブストアに載せる画像を作る
 *
 *   node tools/store-images.mjs          撮影と組版の両方（日本語・英語）
 *   node tools/store-images.mjs compose  撮影は済んでいるものとして、組版だけやり直す
 *   STORE_LANG=en node tools/store-images.mjs   片方の言語だけ
 *
 * 出力は store/assets/（ch-uploader の入稿データの置き方）。
 *   locales/<ja|en>/screenshots/01〜05.jpg  スクリーンショット（1280x800）
 *   promo-tile-440x280.jpg                  小さいプロモーションタイル（既定の言語＝日本語の1組だけ）
 *   marquee-1400x560.jpg                    マーキープロモーションタイル（同上）
 *   icon.png                                ストア用アイコン（96pxの絵に16pxの余白）
 * 英語版は、ブラウザの表示言語を英語にして撮る（拡張の文言が英語になる）。
 * Amazon側の画面は fixtures/amazon_careme.har（harness.mjs record）。楽天の検索は中継Workerの応答を差し替える。
 *
 * - 商品ページは fixtures/ に保存したページ（harness.mjs record）に拡張を当てて撮る。
 *   STORE_ITEM で使うページを変えられる（既定は hoyuhaircare_cm-shtr-set）。
 * - かご・注文確認はログインが要るので撮らない。パネルは拡張と同じCSSで、見本の金額を入れて組む。
 *   金額は README の「実機での検証状況」で実際に出た数字を使っている。
 * - ストアは透過のあるPNGを受け付けないので、スクリーンショットとタイルはJPEGで出す。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PW_DIR = process.env.PLAYWRIGHT_DIR || join(process.env.USERPROFILE || process.env.HOME, '.claude/tools/browser');
const { chromium } = createRequire(join(PW_DIR, 'package.json'))('playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'fixtures');
const ASSETS = join(ROOT, 'store/assets');
// 撮影したままの画像。組版の素材で、ストアには出さない（.gitignore 済み）
const RAW = join(ROOT, 'store/raw');
const ITEM = process.env.STORE_ITEM || 'hoyuhaircare_cm-shtr-set';
const AMAZON_ITEM = process.env.STORE_AMAZON_ITEM || 'amazon_careme';
const LANGS = process.env.STORE_LANG ? [process.env.STORE_LANG] : ['ja', 'en'];
const BCP47 = { ja: 'ja-JP', en: 'en-US' };

/** 拡張を ASCII のみのパスへ写す（非ASCIIのパスからは読み込めない） */
function stageExtension() {
  const dir = join(tmpdir(), 'azr-store-ext');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(ROOT, 'manifest.json'), join(dir, 'manifest.json'));
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(ROOT, 'icons'), join(dir, 'icons'), { recursive: true });
  cpSync(join(ROOT, '_locales'), join(dir, '_locales'), { recursive: true });
  return dir;
}

async function launch(lang) {
  const ext = stageExtension();
  const profile = join(tmpdir(), `azr-store-profile-${process.pid}`);
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2, // 縮めて組むので、倍の解像度で撮っておく
    locale: BCP47[lang],
    timezoneId: 'Asia/Tokyo',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, `--lang=${BCP47[lang]}`]
  });
  return { ctx, cleanup: () => rmSync(profile, { recursive: true, force: true }) };
}

async function openItem(ctx, name = ITEM) {
  const url = readFileSync(join(FIXTURES, `${name}.url`), 'utf8').trim();
  const page = await ctx.newPage();
  await page.routeFromHAR(join(FIXTURES, `${name}.har`), { notFound: 'fallback' });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return page;
}

// エントリー済み一覧の見本。README の検証で実際に判定したキャンペーン。
const SAMPLE_CAMPAIGNS = (() => {
  const now = Date.now();
  const rows = [
    ['campaign/mama/', '楽天ママ割', 'entered'],
    ['campaign/point-up/everyday/point/', '5と0のつく日', 'already'],
    ['campaign/supersale/', '楽天スーパーSALE', 'already'],
    ['campaign/supersale/shop/', 'スーパーSALE ショップ買いまわり', 'already'],
    ['campaign/supersale/item/', 'スーパーSALE 半額商品', 'already'],
    ['campaign/supersale/pointup/', 'スーパーSALE ポイントアップ', 'already'],
    ['campaign/special/', 'お買い物特集', 'none']
  ];
  const items = {};
  for (const [path, title, status] of rows) {
    const url = `https://event.rakuten.co.jp/${path}`;
    items[url] = { url, title, status, checkedAt: now };
  }
  return { updatedAt: now, items };
})();

// Amazonの商品ページに出す楽天の候補。中継Workerの応答の形（worker/src/index.js）
const RAKUTEN_STUB = {
  count: 1,
  items: [{
    itemName: '【公式】ケアミー シャンプー ＆ トリートメント [ hoyu ホーユー Ungrid アングリッド care me オーガニック ボトル セット アミノ酸 ケラチン ノンシリコン ウッディハーブ ]',
    itemPrice: 3960,
    itemUrl: 'https://item.rakuten.co.jp/hoyuhaircare/cm-shtr-set/',
    affiliateUrl: 'https://item.rakuten.co.jp/hoyuhaircare/cm-shtr-set/',
    shopName: 'ホーユーヘアケア楽天市場店',
    shopCode: 'hoyuhaircare'
  }],
  searchUrl: 'https://search.rakuten.co.jp/search/mall/care%20me/'
};

async function shoot(lang) {
  for (const name of [ITEM, AMAZON_ITEM]) {
    if (!existsSync(join(FIXTURES, `${name}.har`))) {
      throw new Error(`fixtures/${name}.har が無い。先に node tools/harness.mjs record <URL> ${name}`);
    }
  }
  const rawDir = join(RAW, lang);
  mkdirSync(rawDir, { recursive: true });

  const { ctx, cleanup } = await launch(lang);
  try {
    const [sw] = ctx.serviceWorkers().length ? ctx.serviceWorkers() : [await ctx.waitForEvent('serviceworker')];
    const extId = new URL(sw.url()).host;
    await sw.evaluate((data) => chrome.storage.local.set({ azrCampaigns: data }), SAMPLE_CAMPAIGNS);
    // Amazon側の楽天候補は、公開中のWorkerに問い合わせず見本の応答を返す
    await sw.evaluate((stub) => {
      const real = globalThis.fetch;
      globalThis.fetch = (url, opts) => String(url).startsWith('https://amazon-rakuten-link.shin1007.workers.dev/search')
        ? Promise.resolve(new Response(JSON.stringify(stub), { status: 200, headers: { 'content-type': 'application/json' } }))
        : real(url, opts);
    }, RAKUTEN_STUB);

    // 商品ページ（拡張あり）
    const page = await openItem(ctx);
    const ready = (flag, value) => page.waitForFunction(
      ([f, v]) => (v ? document.documentElement.dataset[f] === v : Boolean(document.documentElement.dataset[f])),
      [flag, value], { timeout: 20000 }
    ).catch(() => console.warn(`  ${flag} が ${value ?? '立た'}ない`));
    await page.waitForSelector('#azr-item-root', { timeout: 20000 });
    await ready('azrBuybox', 'mounted');
    await ready('azrGallery', 'settled');
    await ready('azrRatings', 'settled');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: join(rawDir, 'item.png') });
    console.log(`raw/${lang}/item.png`);
    await page.close();

    // Amazonの商品ページ（楽天へのリンクと価格）
    const amazon = await openItem(ctx, AMAZON_ITEM);
    await amazon.waitForSelector('#rakuten-link-btn', { timeout: 30000 }).catch(() => console.warn('  楽天のボタンが出ない'));
    await amazon.waitForTimeout(800);
    await amazon.screenshot({ path: join(rawDir, 'amazon.png') });
    console.log(`raw/${lang}/amazon.png`);
    await amazon.close();

    // ポップアップ（エントリー済み一覧を開いた状態）
    const popup = await ctx.newPage();
    await popup.setViewportSize({ width: 400, height: 900 });
    await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);
    await popup.waitForSelector('#campaignList li', { state: 'attached' }); // 閉じた details の中なので見えてはいない
    await popup.evaluate((text) => {
      document.querySelector('.campaigns').open = true;
      document.getElementById('scanStatus').textContent = text;
    }, TEXT[lang].scanStatus);
    // 全部だとスライドに収まらないので、キャンペーンの欄だけ切り出す
    // body は幅300pxに左右の余白が付く（content-box）ので、幅は body から取る
    const body = await popup.locator('body').boundingBox();
    const box = await popup.locator('section:nth-of-type(3)').boundingBox();
    await popup.screenshot({ path: join(rawDir, 'popup.png'), clip: { x: 0, y: box.y - 4, width: body.width, height: box.height + 14 } });
    console.log(`raw/${lang}/popup.png`);
  } finally {
    await ctx.close();
    cleanup();
  }
}

/* 文言（スライドの見出しと、拡張のパネルの見本） ------------------------------- */

const TEXT = {
  ja: {
    scanStatus: '77件を確認 / 新たに1件エントリー / 既にエントリー済み5件',
    tag: '楽天市場を、見やすく・お得に',
    chips: ['3カラムの商品ページ', 'Amazon⇄楽天の価格比較', 'かご合計', 'クーポン自動適用', '一括エントリー'],
    s1: ['楽天の商品ページを、<em>見やすい3カラム</em>に', '画像・商品情報・購入エリアを1画面に。Amazonでの価格も、楽天の価格のすぐ下に'],
    s2: ['<em>Amazon</em>の商品ページに、楽天のリンクと価格', 'JAN・ISBN・型番で同じ商品を探し、楽天の価格へワンクリックで'],
    s3: ['かごの<em>合計金額</em>と、ポイント差引後の実質価格', 'ショップごとにバラバラな小計・送料・ポイントを、ひとつのパネルに'],
    s3p: [['複数ショップの合計がひと目で', '「結局いくら払うのか」を楽天のかご画面の上に表示'], ['ポイント差引後の実質価格', '獲得予定ポイントを引いた金額も一緒に'], ['数量を変えるとすぐ追従', 'ショップ別の内訳もその場で確認できます']],
    s4: ['いちばん得な<em>クーポン</em>に自動で切り替え', '注文確認画面で、使えるクーポンの割引額を比べて最良のものを適用'],
    s4p: [['割引率ではなく「割引額」で比較', '21%OFFと300円OFF、この注文でどちらが得かを計算'], ['商品ページのクーポンもその場で獲得', 'クーポンページへ移動せずに「獲得する」を押すだけ'], ['注文の確定はしません', '確定ボタンは必ずご自身で。適用前に確認する設定も']],
    s5: ['キャンペーンを探して<em>一括エントリー</em>', 'ボタンひとつで、楽天トップに出ているキャンペーンを調べてエントリー'],
    s5p: [['エントリー漏れを防ぐ', 'キャンペーンページを1つずつ開いて押す手間を省きます'], ['エントリー済み一覧', '楽天には無い「どれにエントリーしたか」の記録を残せます'], ['押せたことを確かめてから記録', '表示が「エントリー済み」に変わったものだけを数えます']],
    cart: { title: 'かご合計', items: '商品合計（4点 / 3ショップ）', v1: '7,604円', ship: '送料', v2: '230円', pay: 'お支払い予定', v3: '7,834円', pts: '獲得予定ポイント', after: 'ポイント差引後', v4: '6,297円', by: 'ショップ別内訳', shops: ['ショップA', 'ショップB', 'ショップC'], amounts: ['3,980円 / 812pt', '2,090円 / 418pt', '1,764円 / 307pt'] },
    co: { title: 'クーポン最適化', now: '適用中の割引', v1: '-352円', note: '最良のクーポンが適用されています（-352円）', usable: '使えるクーポン 3件', rows: [['21%OFFクーポン', '-352円'], ['108円OFFクーポン', '-108円'], ['1,500円以上で100円OFF', '-100円']] }
  },
  en: {
    scanStatus: '77 checked / 1 newly entered / 5 already entered',
    tag: 'Shop Rakuten smarter',
    chips: ['3-column item page', 'Amazon ⇄ Rakuten prices', 'Cart total', 'Best coupon, applied', 'Bulk entry'],
    s1: ['Rakuten item pages in a <em>clear 3-column layout</em>', 'Images, details and buy box on one screen — with the Amazon price right under the Rakuten price'],
    s2: ['Rakuten links and prices, right on <em>Amazon</em>', 'Finds the same item by JAN, ISBN or model number — one click to the Rakuten price'],
    s3: ['Your cart <em>total</em>, and the real price after points', 'Subtotals, shipping and points scattered across shops — in one panel'],
    s3p: [['All shops added up at a glance', 'Shown on top of the Rakuten cart: how much you actually pay'], ['The real price after points', 'Includes the points you are about to earn'], ['Follows quantity changes instantly', 'Per-shop breakdown right there']],
    s4: ['Automatically switch to the <em>best coupon</em>', 'On the order page, compares the discount each coupon gives and applies the best one'],
    s4p: [['Compares the amount, not the percentage', '21% OFF or ¥300 OFF — it works out which saves more on this order'], ['Get item-page coupons in place', 'Just press "Get" — no trip to the coupon page'], ['Never places your order', 'You always press the final button yourself. Optional confirmation before applying']],
    s5: ['Find campaigns and <em>enter them all</em>', 'One button checks the campaigns on the Rakuten top page and enters them'],
    s5p: [['Never miss an entry', 'No more opening campaign pages one by one'], ['A list of what you entered', 'A record Rakuten does not give you'], ['Recorded only after it worked', 'Counts only what switched to "Entered"']],
    cart: { title: 'Cart total', items: 'Items (4 / 3 shops)', v1: '¥7,604', ship: 'Shipping', v2: '¥230', pay: 'Amount to pay', v3: '¥7,834', pts: 'Points to earn', after: 'After points', v4: '¥6,297', by: 'By shop', shops: ['Shop A', 'Shop B', 'Shop C'], amounts: ['¥3,980 / 812pt', '¥2,090 / 418pt', '¥1,764 / 307pt'] },
    co: { title: 'Coupon optimizer', now: 'Current discount', v1: '-¥352', note: 'The best coupon is already applied (-¥352)', usable: '3 usable coupons', rows: [['21% OFF coupon', '-¥352'], ['¥108 OFF coupon', '-¥108'], ['¥100 OFF at ¥1,500 or more', '-¥100']] }
  }
};

/* 組版 ---------------------------------------------------------------------- */

const css = (p) => readFileSync(join(ROOT, p), 'utf8');
const icon = pathToFileURL(join(ROOT, 'icons/icon.svg')).href;

const BASE_CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    font-family: "Noto Sans JP", "Yu Gothic UI", "Yu Gothic", Meiryo, sans-serif;
    color: #0f1111;
    -webkit-font-smoothing: antialiased;
  }
  .slide {
    position: relative;
    width: 1280px; height: 800px; overflow: hidden;
    background: linear-gradient(180deg, #eef1f4 0%, #dfe4ea 100%);
  }
  .band {
    height: 168px; padding: 34px 64px 0;
    background: linear-gradient(180deg, #232f3e 0%, #131921 100%);
    color: #fff;
  }
  .band h1 { margin: 0; font-size: 44px; font-weight: 800; letter-spacing: .01em; line-height: 1.25; }
  .band h1 em { font-style: normal; color: #febd69; }
  .band p { margin: 10px 0 0; font-size: 21px; color: #c9d1d9; font-weight: 500; }
  .window {
    position: absolute; left: 64px; right: 64px; top: 200px; bottom: -8px;
    border-radius: 12px 12px 0 0; overflow: hidden; background: #fff;
    box-shadow: 0 18px 50px rgba(15, 17, 17, .28);
  }
  .window::before {
    content: ""; display: block; height: 28px; background: #e8eaed;
    background-image: radial-gradient(circle at 18px 14px, #ff5f57 5px, transparent 6px),
      radial-gradient(circle at 38px 14px, #febc2e 5px, transparent 6px),
      radial-gradient(circle at 58px 14px, #28c840 5px, transparent 6px);
  }
  .window img { display: block; width: 100%; }
  /* 画面全体を見せたいとき（拡大表示）は、切らずに縮めて中央に置く */
  .window.is-fit { left: calc(50% - 460px); right: auto; width: 920px; top: 192px; bottom: auto; border-radius: 12px; }
  .points { list-style: none; margin: 0; padding: 0; display: grid; gap: 22px; }
  .points li { position: relative; padding-left: 40px; font-size: 24px; line-height: 1.5; font-weight: 600; }
  .points li small { display: block; font-size: 17px; font-weight: 400; color: #565959; margin-top: 2px; }
  .points li::before {
    content: "✓"; position: absolute; left: 0; top: 3px;
    width: 28px; height: 28px; border-radius: 50%;
    background: #febd69; color: #131921; font-size: 17px; font-weight: 800;
    display: flex; align-items: center; justify-content: center;
  }
  .split { position: absolute; top: 168px; left: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: 56px; padding: 0 64px; }
  .split .points { flex: 1; }
  /* 拡張のパネルはページの右下に固定で出る。ここでは置き場所だけ変える */
  .panel-stage { flex: none; width: 520px; display: flex; justify-content: center; }
  .panel-stage .azr-panel { position: static; max-height: none; zoom: 1.45; box-shadow: 0 10px 36px rgba(15, 17, 17, .22); }
`;

const PANEL_CSS = css('src/styles/common.css') + css('src/styles/cart.css');

const points = (list) => `<ul class="points">${list.map(([a, b]) => `<li>${a}<small>${b}</small></li>`).join('')}</ul>`;
const band = ([h1, p]) => `<div class="band"><h1>${h1}</h1><p>${p}</p></div>`;

const slides = (lang) => {
  const T = TEXT[lang];
  const raw = (name) => pathToFileURL(join(RAW, lang, name)).href;
  const { cart, co } = T;
  return {
    'screenshot-1': `
    <div class="slide">
      ${band(T.s1)}
      <div class="window"><img src="${raw('item.png')}"></div>
    </div>`,

    'screenshot-2': `
    <div class="slide">
      ${band(T.s2)}
      <div class="window"><img src="${raw('amazon.png')}"></div>
    </div>`,

    'screenshot-3': `
    <div class="slide">
      ${band(T.s3)}
      <div class="split">
        ${points(T.s3p)}
        <div class="panel-stage">
          <div class="azr-panel azr-cart-panel">
            <div class="azr-panel-head"><span class="azr-panel-title">${cart.title}</span><button class="azr-panel-close">×</button></div>
            <div class="azr-panel-body">
              <div class="azr-total-row is-main"><span>${cart.items}</span><strong>${cart.v1}</strong></div>
              <div class="azr-total-row"><span>${cart.ship}</span><span>${cart.v2}</span></div>
              <div class="azr-total-row is-grand"><span>${cart.pay}</span><strong>${cart.v3}</strong></div>
              <div class="azr-total-row is-point"><span>${cart.pts}</span><span>1,537pt</span></div>
              <div class="azr-total-row is-effective"><span>${cart.after}</span><strong>${cart.v4}</strong></div>
              <details class="azr-breakdown" open>
                <summary>${cart.by}</summary>
                <ul>
                  ${cart.shops.map((n, i) => `<li><span class="azr-shop-name">${n}</span><span class="azr-shop-amount">${cart.amounts[i]}</span></li>`).join('')}
                </ul>
              </details>
            </div>
          </div>
        </div>
      </div>
    </div>`,

    'screenshot-4': `
    <div class="slide">
      ${band(T.s4)}
      <div class="split">
        ${points(T.s4p)}
        <div class="panel-stage">
          <div class="azr-panel azr-checkout-panel">
            <div class="azr-panel-head"><span class="azr-panel-title">${co.title}</span><button class="azr-panel-close">×</button></div>
            <div class="azr-panel-body">
              <div class="azr-total-row is-grand"><span>${co.now}</span><strong>${co.v1}</strong></div>
              <div class="azr-coupon-status">${co.note}</div>
              <details class="azr-breakdown" open>
                <summary>${co.usable}</summary>
                <ul>
                  ${co.rows.map(([n, v]) => `<li><span class="azr-shop-name">${n}</span><span>${v}</span></li>`).join('')}
                </ul>
              </details>
            </div>
          </div>
        </div>
      </div>
    </div>`,

    'screenshot-5': `
    <div class="slide">
      ${band(T.s5)}
      <div class="split">
        ${points(T.s5p)}
        <div class="panel-stage"><img class="popup" src="${raw('popup.png')}"></div>
      </div>
    </div>`,

    'promo-small': `
    <div class="tile small">
      <img class="logo" src="${icon}">
      <div class="name">Amazonize Rakuten</div>
      <div class="tag">${T.tag}</div>
    </div>`,

    'promo-marquee': `
    <div class="tile marquee">
      <div class="copy">
        <img class="logo" src="${icon}">
        <div class="name">Amazonize Rakuten</div>
        <div class="tag">${T.tag}</div>
        <div class="chips">${T.chips.map((c) => `<span>${c}</span>`).join('')}</div>
      </div>
      <div class="shot"><img src="${raw('item.png')}"></div>
    </div>`
  };
};

const SLIDE_EXTRA_CSS = `
  .popup { width: 400px; border-radius: 10px; box-shadow: 0 10px 36px rgba(15, 17, 17, .22); border: 1px solid #d5d9d9; }

  .tile { position: relative; overflow: hidden; color: #fff; background: radial-gradient(120% 140% at 0% 0%, #37475a 0%, #131921 62%); }
  .tile .name { font-weight: 800; letter-spacing: .01em; }
  .tile .tag { color: #febd69; font-weight: 700; }
  .small { width: 440px; height: 280px; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .small .logo { width: 104px; height: 104px; filter: drop-shadow(0 0 1px rgba(255,255,255,.5)) drop-shadow(0 6px 16px rgba(0,0,0,.45)); }
  .small .name { font-size: 34px; margin-top: 16px; }
  .small .tag { font-size: 19px; margin-top: 6px; }
  .marquee { width: 1400px; height: 560px; display: flex; align-items: center; }
  .marquee .copy { flex: none; width: 660px; padding-left: 80px; }
  .marquee .logo { width: 96px; height: 96px; filter: drop-shadow(0 0 1px rgba(255,255,255,.5)) drop-shadow(0 6px 16px rgba(0,0,0,.45)); }
  .marquee .name { font-size: 50px; margin-top: 18px; white-space: nowrap; }
  .marquee .tag { font-size: 28px; margin-top: 8px; }
  .marquee .chips { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 28px; }
  .marquee .chips span { font-size: 17px; font-weight: 600; padding: 6px 14px; border-radius: 999px; background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.22); }
  .marquee .shot { position: absolute; left: 700px; top: 64px; width: 820px; border-radius: 12px; overflow: hidden; box-shadow: 0 24px 60px rgba(0,0,0,.5); transform: rotate(-2deg); transform-origin: left top; }
  .marquee .shot img { display: block; width: 100%; }
`;

async function compose(lang) {
  const SHOTS = join(ASSETS, 'locales', lang, 'screenshots');
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(join(RAW, lang), { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const head = `<meta charset="utf-8">
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;600;700;800&display=block">
      <style>${PANEL_CSS}${BASE_CSS}${SLIDE_EXTRA_CSS}</style>`;
    for (const [name, body] of Object.entries(slides(lang))) {
      const promo = name.startsWith('promo-');
      if (promo && lang !== 'ja') continue; // タイルは既定の言語（日本語）の1組だけ
      const size = name === 'promo-small' ? [440, 280] : name === 'promo-marquee' ? [1400, 560] : [1280, 800];
      const file = name === 'promo-small' ? join(ASSETS, 'promo-tile-440x280.jpg')
        : name === 'promo-marquee' ? join(ASSETS, 'marquee-1400x560.jpg')
        : join(SHOTS, `0${name.slice(-1)}.jpg`);
      await page.setViewportSize({ width: size[0], height: size[1] });
      // 撮った画像を file: で読むので、setContent（about:blank）ではなくファイルとして開く
      const html = join(RAW, lang, `${name}.html`);
      writeFileSync(html, `<!doctype html><html lang="${lang}"><head>${head}</head><body>${body}</body></html>`);
      await page.goto(pathToFileURL(html).href, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: file, type: 'jpeg', quality: 92, clip: { x: 0, y: 0, width: size[0], height: size[1] } });
      console.log(file);
    }

    // ストア用アイコン: 128pxのうち絵は96px、周りに16pxの透明な余白（ストアのガイドライン）
    await page.setViewportSize({ width: 128, height: 128 });
    const html = join(RAW, lang, 'store-icon.html');
    writeFileSync(html, `<style>html,body{margin:0;background:transparent}img{display:block;width:96px;height:96px;margin:16px}</style><img src="${icon}">`);
    await page.goto(pathToFileURL(html).href);
    await page.waitForFunction(() => document.querySelector('img').complete);
    await page.screenshot({ path: join(ASSETS, 'icon.png'), omitBackground: true });
    console.log('store/assets/icon.png');
  } finally {
    await browser.close();
  }
}

const [cmd] = process.argv.slice(2);
for (const lang of LANGS) {
  if (cmd !== 'compose') await shoot(lang);
  await compose(lang);
}
