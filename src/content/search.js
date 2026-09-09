/* Amazonize Rakuten - 検索結果ページの整理 */
(() => {
  const AZR = window.AZR;

  const AD_PATTERNS = [
    'PR', 'スポンサー', '広告'
  ];

  AZR.register('search', 'search-clean', async () => {
    if (!AZR.settings.simplifySearch) return;
    document.documentElement.classList.add('azr-search');

    const markAds = () => {
      for (const el of document.querySelectorAll('[class*="searchresultitem"], [class*="item-card"], li')) {
        if (el.dataset.azrChecked) continue;
        el.dataset.azrChecked = '1';
        const badge = el.querySelector('[class*="ad"], [class*="pr-"], [class*="sponsor"]');
        const text = (badge?.textContent || '').trim();
        if (text && AD_PATTERNS.some((p) => text === p || text.startsWith(p))) {
          el.classList.add('azr-ad-item');
        }
      }
    };

    markAds();
    // 無限スクロールで追加された分にも適用する
    const obs = new MutationObserver(() => markAds());
    obs.observe(document.body, { childList: true, subtree: true });
  });
})();
