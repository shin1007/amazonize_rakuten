/* Amazonize Rakuten - 表示文言の切り替え
 *
 * 文言は日本語の原文をそのままキーにして呼ぶ: AZR.t('かごの合計')。
 * 日本語以外のブラウザでは、原文から決まるID（下の messageId）で _locales/<言語>/messages.json を引く。
 * 訳が無ければ、英語の訳（i18n-en.js）、それも無ければ原文が出る。差し込みは {名前} で書く: AZR.t('{n}件', { n: 3 })。
 * 訳は tools/translations/<言語>.json に置き、node tools/build-locales.mjs で messages.json にする。
 * 表示言語の取得に失敗したとき（テストなど）は日本語のまま。
 */
(() => {
  const AZR = (window.AZR = window.AZR || {});
  if (AZR.t) return;

  let ui = 'ja';
  try {
    ui = chrome.i18n.getUILanguage() || 'ja';
  } catch { /* chrome API が無い */ }

  AZR.isJa = /^ja/i.test(ui);
  AZR.lang = ui.split('-')[0].toLowerCase();
  AZR.numberLocale = AZR.isJa ? 'ja-JP' : ui;

  // tools/build-locales.mjs と同じ計算（FNV-1a）。変えるなら両方
  const messageId = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
    return 'm' + h.toString(16).padStart(8, '0');
  };

  AZR.t = (ja, params) => {
    let s = ja;
    if (!AZR.isJa) {
      try {
        s = chrome.i18n.getMessage(messageId(ja)) || (AZR.enFallback && AZR.enFallback[ja]) || ja;
      } catch { /* extension context invalidated */ }
    }
    if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? params[k] : m));
    return s;
  };
})();
