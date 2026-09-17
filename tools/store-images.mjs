/* Chrome ウェブストアに載せる画像を作る
 *
 *   node tools/store-images.mjs          撮影と組版の両方
 *   node tools/store-images.mjs compose  撮影は済んでいるものとして、組版だけやり直す
 *
 * 出力は store/images/。
 *   screenshot-1〜5.jpg  スクリーンショット（1280x800）
 *   promo-small.jpg      小さいプロモーションタイル（440x280）
 *   promo-marquee.jpg    マーキープロモーションタイル（1400x560）
 *   store-icon-128.png   ストア用アイコン（96pxの絵に16pxの余白）
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
const OUT = join(ROOT, 'store/images');
// 撮影したままの画像。組版の素材で、ストアには出さない（.gitignore 済み）
const RAW = join(ROOT, 'store/raw');
const ITEM = process.env.STORE_ITEM || 'hoyuhaircare_cm-shtr-set';

/** 拡張を ASCII のみのパスへ写す（非ASCIIのパスからは読み込めない） */
function stageExtension() {
  const dir = join(tmpdir(), 'azr-store-ext');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(ROOT, 'manifest.json'), join(dir, 'manifest.json'));
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(ROOT, 'icons'), join(dir, 'icons'), { recursive: true });
  return dir;
}

async function launch() {
  const ext = stageExtension();
  const profile = join(tmpdir(), `azr-store-profile-${process.pid}`);
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2, // 縮めて組むので、倍の解像度で撮っておく
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]
  });
  return { ctx, cleanup: () => rmSync(profile, { recursive: true, force: true }) };
}

async function openItem(ctx) {
  const url = readFileSync(join(FIXTURES, `${ITEM}.url`), 'utf8').trim();
  const page = await ctx.newPage();
  await page.routeFromHAR(join(FIXTURES, `${ITEM}.har`), { notFound: 'fallback' });
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

async function shoot() {
  if (!existsSync(join(FIXTURES, `${ITEM}.har`))) {
    throw new Error(`fixtures/${ITEM}.har が無い。先に node tools/harness.mjs record <URL> ${ITEM}`);
  }
  mkdirSync(RAW, { recursive: true });

  const { ctx, cleanup } = await launch();
  try {
    const [sw] = ctx.serviceWorkers().length ? ctx.serviceWorkers() : [await ctx.waitForEvent('serviceworker')];
    const extId = new URL(sw.url()).host;
    await sw.evaluate((data) => chrome.storage.local.set({ azrCampaigns: data }), SAMPLE_CAMPAIGNS);

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
    await page.screenshot({ path: join(RAW, 'item.png') });
    console.log('raw/item.png');

    // 拡大表示。1枚目はスクリーンショット1と同じ画像なので、2枚送る
    await page.click('.azr-gallery-frame');
    await page.waitForSelector('.azr-lightbox:not([hidden])');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('.azr-lb-img')?.complete);
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(RAW, 'lightbox.png') });
    console.log('raw/lightbox.png');
    await page.close();

    // ポップアップ（エントリー済み一覧を開いた状態）
    const popup = await ctx.newPage();
    await popup.setViewportSize({ width: 400, height: 900 });
    await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);
    await popup.waitForSelector('#campaignList li', { state: 'attached' }); // 閉じた details の中なので見えてはいない
    await popup.evaluate(() => {
      document.querySelector('.campaigns').open = true;
      document.getElementById('scanStatus').textContent = '77件を確認 / 新たに1件エントリー / 既にエントリー済み5件';
    });
    // 全部だとスライドに収まらないので、キャンペーンの欄だけ切り出す
    // body は幅300pxに左右の余白が付く（content-box）ので、幅は body から取る
    const body = await popup.locator('body').boundingBox();
    const box = await popup.locator('section:nth-of-type(3)').boundingBox();
    await popup.screenshot({ path: join(RAW, 'popup.png'), clip: { x: 0, y: box.y - 4, width: body.width, height: box.height + 14 } });
    console.log('raw/popup.png');
  } finally {
    await ctx.close();
    cleanup();
  }
}

/* 組版 ---------------------------------------------------------------------- */

const css = (p) => readFileSync(join(ROOT, p), 'utf8');
const raw = (name) => pathToFileURL(join(RAW, name)).href;
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

const slides = {
  'screenshot-1': `
    <div class="slide">
      <div class="band">
        <h1>楽天の商品ページを、<em>見やすい3カラム</em>に</h1>
        <p>画像・商品情報・購入エリアを1画面に。長い商品説明をスクロールせずに買えます</p>
      </div>
      <div class="window"><img src="${raw('item.png')}"></div>
    </div>`,

  'screenshot-2': `
    <div class="slide">
      <div class="band">
        <h1>商品画像を<em>大きく</em>、まとめて見る</h1>
        <p>説明文に埋もれた画像もギャラリーへ集約。同じ画像は1枚に。←→キーで送れます</p>
      </div>
      <div class="window is-fit"><img src="${raw('lightbox.png')}"></div>
    </div>`,

  'screenshot-3': `
    <div class="slide">
      <div class="band">
        <h1>かごの<em>合計金額</em>と、ポイント差引後の実質価格</h1>
        <p>ショップごとにバラバラな小計・送料・ポイントを、ひとつのパネルに</p>
      </div>
      <div class="split">
        <ul class="points">
          <li>複数ショップの合計がひと目で<small>「結局いくら払うのか」を楽天のかご画面の上に表示</small></li>
          <li>ポイント差引後の実質価格<small>獲得予定ポイントを引いた金額も一緒に</small></li>
          <li>数量を変えるとすぐ追従<small>ショップ別の内訳もその場で確認できます</small></li>
        </ul>
        <div class="panel-stage">
          <div class="azr-panel azr-cart-panel">
            <div class="azr-panel-head"><span class="azr-panel-title">かご合計</span><button class="azr-panel-close">×</button></div>
            <div class="azr-panel-body">
              <div class="azr-total-row is-main"><span>商品合計（4点 / 3ショップ）</span><strong>7,604円</strong></div>
              <div class="azr-total-row"><span>送料</span><span>230円</span></div>
              <div class="azr-total-row is-grand"><span>お支払い予定</span><strong>7,834円</strong></div>
              <div class="azr-total-row is-point"><span>獲得予定ポイント</span><span>1,537pt</span></div>
              <div class="azr-total-row is-effective"><span>ポイント差引後</span><strong>6,297円</strong></div>
              <details class="azr-breakdown" open>
                <summary>ショップ別内訳</summary>
                <ul>
                  <li><span class="azr-shop-name">ショップA</span><span class="azr-shop-amount">3,980円 / 812pt</span></li>
                  <li><span class="azr-shop-name">ショップB</span><span class="azr-shop-amount">2,090円 / 418pt</span></li>
                  <li><span class="azr-shop-name">ショップC</span><span class="azr-shop-amount">1,764円 / 307pt</span></li>
                </ul>
              </details>
            </div>
          </div>
        </div>
      </div>
    </div>`,

  'screenshot-4': `
    <div class="slide">
      <div class="band">
        <h1>いちばん得な<em>クーポン</em>に自動で切り替え</h1>
        <p>注文確認画面で、使えるクーポンの割引額を比べて最良のものを適用</p>
      </div>
      <div class="split">
        <ul class="points">
          <li>割引率ではなく「割引額」で比較<small>21%OFFと300円OFF、この注文でどちらが得かを計算</small></li>
          <li>商品ページのクーポンもその場で獲得<small>クーポンページへ移動せずに「獲得する」を押すだけ</small></li>
          <li>注文の確定はしません<small>確定ボタンは必ずご自身で。適用前に確認する設定も</small></li>
        </ul>
        <div class="panel-stage">
          <div class="azr-panel azr-checkout-panel">
            <div class="azr-panel-head"><span class="azr-panel-title">クーポン最適化</span><button class="azr-panel-close">×</button></div>
            <div class="azr-panel-body">
              <div class="azr-total-row is-grand"><span>適用中の割引</span><strong>-352円</strong></div>
              <div class="azr-coupon-status">最良のクーポンが適用されています（-352円）</div>
              <details class="azr-breakdown" open>
                <summary>使えるクーポン 3件</summary>
                <ul>
                  <li><span class="azr-shop-name">21%OFFクーポン</span><span>-352円</span></li>
                  <li><span class="azr-shop-name">108円OFFクーポン</span><span>-108円</span></li>
                  <li><span class="azr-shop-name">1,500円以上で100円OFF</span><span>-100円</span></li>
                </ul>
              </details>
            </div>
          </div>
        </div>
      </div>
    </div>`,

  'screenshot-5': `
    <div class="slide">
      <div class="band">
        <h1>キャンペーンを探して<em>一括エントリー</em></h1>
        <p>ボタンひとつで、楽天トップに出ているキャンペーンを調べてエントリー</p>
      </div>
      <div class="split">
        <ul class="points">
          <li>エントリー漏れを防ぐ<small>キャンペーンページを1つずつ開いて押す手間を省きます</small></li>
          <li>エントリー済み一覧<small>楽天には無い「どれにエントリーしたか」の記録を残せます</small></li>
          <li>押せたことを確かめてから記録<small>表示が「エントリー済み」に変わったものだけを数えます</small></li>
        </ul>
        <div class="panel-stage"><img class="popup" src="${raw('popup.png')}"></div>
      </div>
    </div>`,

  'promo-small': `
    <div class="tile small">
      <img class="logo" src="${icon}">
      <div class="name">Amazonize Rakuten</div>
      <div class="tag">楽天市場を、見やすく・お得に</div>
    </div>`,

  'promo-marquee': `
    <div class="tile marquee">
      <div class="copy">
        <img class="logo" src="${icon}">
        <div class="name">Amazonize Rakuten</div>
        <div class="tag">楽天市場を、見やすく・お得に</div>
        <div class="chips"><span>3カラムの商品ページ</span><span>かご合計</span><span>クーポン自動適用</span><span>一括エントリー</span></div>
      </div>
      <div class="shot"><img src="${raw('item.png')}"></div>
    </div>`
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

async function compose() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const head = `<meta charset="utf-8">
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;600;700;800&display=block">
      <style>${PANEL_CSS}${BASE_CSS}${SLIDE_EXTRA_CSS}</style>`;
    for (const [name, body] of Object.entries(slides)) {
      const size = name === 'promo-small' ? [440, 280] : name === 'promo-marquee' ? [1400, 560] : [1280, 800];
      await page.setViewportSize({ width: size[0], height: size[1] });
      // 撮った画像を file: で読むので、setContent（about:blank）ではなくファイルとして開く
      const html = join(RAW, `${name}.html`);
      writeFileSync(html, `<!doctype html><html lang="ja"><head>${head}</head><body>${body}</body></html>`);
      await page.goto(pathToFileURL(html).href, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: join(OUT, `${name}.jpg`), type: 'jpeg', quality: 92, clip: { x: 0, y: 0, width: size[0], height: size[1] } });
      console.log(`store/images/${name}.jpg`);
    }

    // ストア用アイコン: 128pxのうち絵は96px、周りに16pxの透明な余白（ストアのガイドライン）
    await page.setViewportSize({ width: 128, height: 128 });
    const html = join(RAW, 'store-icon.html');
    writeFileSync(html, `<style>html,body{margin:0;background:transparent}img{display:block;width:96px;height:96px;margin:16px}</style><img src="${icon}">`);
    await page.goto(pathToFileURL(html).href);
    await page.waitForFunction(() => document.querySelector('img').complete);
    await page.screenshot({ path: join(OUT, 'store-icon-128.png'), omitBackground: true });
    console.log('store/images/store-icon-128.png');
  } finally {
    await browser.close();
  }
}

const [cmd] = process.argv.slice(2);
if (cmd !== 'compose') await shoot();
await compose();
