/* Amazonize Rakuten - settings store (content-script global) */
(() => {
  const DEFAULTS = {
    enabled: true,
    simplifyItem: true,       // 商品ページをAmazon風に再構成
    simplifySearch: true,     // 検索結果を整理
    cartTotal: true,          // カゴの合計金額パネル
    amazonPrice: true,        // 商品ページにAmazonでの価格を出す
    couponList: true,         // 商品ページにクーポンを並べる（その場で獲得できる）
    couponAutoGrab: true,     // 商品ページを開いた時点で、押さずに獲得する
    couponAutoApply: true,    // 購入手続きで最良クーポンを自動適用
    couponAutoApplyConfirm: false, // 自動適用の前に確認する（既定は確認なしで最良に切り替える）
    campaignEntry: true,          // キャンペーンページにエントリーパネルを出す
    campaignAutoEntry: false,
    campaignScanEntry: true,      // 一括スキャンで見つけたものをエントリーする
    campaignScanOnTop: true,      // トップページを開いたら、裏で探してエントリーする
    campaignUrls: [               // ポップアップの一括エントリー対象（編集可）
      'https://event.rakuten.co.jp/card/pointday/',
      'https://event.rakuten.co.jp/campaign/sports/',
      'https://event.rakuten.co.jp/campaign/point-up/everyday/point/'
    ],
    debug: false
  };

  const AZR = (window.AZR = window.AZR || {});
  AZR.DEFAULTS = DEFAULTS;
  AZR.settings = { ...DEFAULTS };

  AZR.loadSettings = async function loadSettings() {
    try {
      const stored = await chrome.storage.sync.get(DEFAULTS);
      AZR.settings = { ...DEFAULTS, ...stored };
    } catch {
      AZR.settings = { ...DEFAULTS };
    }
    return AZR.settings;
  };

  AZR.onSettingsChanged = function onSettingsChanged(cb) {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        for (const [k, v] of Object.entries(changes)) AZR.settings[k] = v.newValue;
        cb(AZR.settings, changes);
      });
    } catch { /* extension context invalidated */ }
  };

  AZR.log = (...args) => { if (AZR.settings.debug) console.log('%c[AZR]', 'color:#f60', ...args); };
  AZR.warn = (...args) => console.warn('[AZR]', ...args);
})();
