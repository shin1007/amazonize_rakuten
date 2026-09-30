/* Amazonize Rakuten - 購入履歴: 「配送状況を確認する」を最初から開いておく */
(() => {
  const AZR = window.AZR;
  const LABEL = '配送状況を確認';
  const SELECTOR = 'summary, button, [role="button"], [aria-expanded]';

  /** 開いていない折りたたみだけ開く。ページ移動するリンクは押さない */
  function expand(el) {
    if (el.dataset.azrOpened) return;
    if (!(el.textContent || '').includes(LABEL)) return;
    const details = el.tagName === 'SUMMARY' ? el.parentElement : null;
    if (details?.tagName === 'DETAILS') {
      if (!details.open) details.open = true;
    } else if (el.getAttribute('aria-expanded') === 'false') {
      // 楽天の折りたたみは aria-expanded を持つ外側ではなく、見出し(header)側がクリックを受ける
      (el.querySelector('[class*="header--"], [class*="pointer--"]') || el).click();
    } else {
      return;
    }
    el.dataset.azrOpened = '1';
  }

  const sweep = () => {
    for (const el of document.querySelectorAll(SELECTOR)) {
      // 入れ子の外側（ページ全体を包む要素など）は文言が一致しても対象外
      if (el.querySelector(SELECTOR)) continue;
      expand(el);
    }
  };

  AZR.register('orders', 'orders-expand-delivery', async () => {
    sweep();
    // 履歴は後から描画・追加読み込みされるので、少し見張る
    let timer;
    const obs = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(sweep, 200);
    });
    obs.observe(document.body, { childList: true, subtree: true });
  });
})();
