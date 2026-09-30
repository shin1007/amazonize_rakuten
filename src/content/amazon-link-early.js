/* Amazonize Rakuten - 楽天の候補エリアの枠だけを、ページの読み込み完了を待たずに先に置く
 * （結果の取得・表示は amazon-link.js。ここで置いた枠を、そちらが結果で置き換える） */
(async () => {
    const AZR = (window.AZR = window.AZR || {});
    await AZR.loadSettings();
    if (!AZR.settings.enabled || !AZR.settings.rakutenLink) return;
    const { findPrice, newWrap, loadingRow, disclosure, place } = AZR.slot;

    const ready = () => document.getElementById('productTitle') && findPrice();
    const put = () => {
        if (document.getElementById('rakuten-link-btn') || !document.getElementById('productTitle')) return;
        const wrap = newWrap();
        const text = AZR.t('楽天の商品情報を取得中…');
        wrap.append(loadingRow(text), loadingRow(text), disclosure());
        place(wrap);
    };

    // 商品名と価格が出たらすぐ置く。価格が出ないページでも、DOMの読み込みが終わったら置く
    if (ready()) return put();
    const obs = new MutationObserver(() => { if (ready()) { obs.disconnect(); put(); } });
    obs.observe(document, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', () => { obs.disconnect(); put(); }, { once: true });
})();
