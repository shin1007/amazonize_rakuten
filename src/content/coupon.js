/* Amazonize Rakuten - クーポン一覧 / 一括取得 */
(() => {
  const AZR = window.AZR;
  const { h, yen, waitSettled } = AZR;

  const GRAB_TEXT = /クーポンを?(獲得|取得)|獲得する|取得する|GET/i;
  const DONE_TEXT = /獲得済|取得済|利用可能|使用済/;
  const GRAB_INTERVAL_MS = 900; // サーバに負荷をかけないよう間隔を空ける

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** ページ内の「獲得」ボタンを集める */
  function findGrabButtons() {
    const out = [];
    for (const el of document.querySelectorAll('button, a[role="button"], input[type="submit"], [class*="btn"]')) {
      const text = (el.value || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 20) continue;
      if (DONE_TEXT.test(text)) continue;
      if (!GRAB_TEXT.test(text)) continue;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      if (!el.offsetParent) continue; // 非表示要素は除く
      out.push(el);
    }
    return out;
  }

  /** ボタン周辺のテキストからクーポン内容を読む */
  function describe(btn) {
    const card = btn.closest('li, article, section, div[class*="coupon"], div[class*="card"]') || btn.parentElement;
    const text = (card?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return AZR.coupons.parseCoupon(text, { source: 'coupon-page' });
  }

  async function grabAll(buttons, onProgress) {
    let ok = 0;
    let failed = 0;
    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons[i];
      try {
        if (!btn.isConnected || btn.disabled) { failed++; continue; }
        btn.click();
        ok++;
      } catch (e) {
        AZR.warn('クーポン取得に失敗:', e);
        failed++;
      }
      onProgress?.(i + 1, buttons.length, ok, failed);
      await sleep(GRAB_INTERVAL_MS);
    }
    return { ok, failed };
  }

  function render(coupons, buttons) {
    const status = h('div.azr-coupon-status', { text: `${buttons.length}件の未取得クーポン` });
    const ranked = AZR.coupons.rank(coupons, 10000);

    const panel = h('div.azr-panel.azr-coupon-panel', { id: 'azr-coupon-panel' },
      h('div.azr-panel-head',
        h('span.azr-panel-title', { text: 'クーポン' }),
        h('button.azr-panel-close', { type: 'button', text: '×', onclick: () => panel.remove() })
      ),
      h('div.azr-panel-body',
        status,
        h('button.azr-btn-primary', {
          type: 'button',
          text: '未取得をすべて取得',
          disabled: buttons.length === 0,
          onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            const result = await grabAll(buttons, (done, total) => {
              status.textContent = `取得中… ${done}/${total}`;
            });
            status.textContent = `完了: ${result.ok}件取得 / 失敗 ${result.failed}件`;
          }
        }),
        h('ul.azr-coupon-list',
          ranked.slice(0, 30).map(({ coupon }) => h('li.azr-coupon-item',
            h('span.azr-coupon-label', { text: coupon.label.slice(0, 60) }),
            coupon.minSpend ? h('span.azr-coupon-cond', { text: `${yen(coupon.minSpend)}以上` }) : ''
          ))
        )
      )
    );
    return panel;
  }

  AZR.register('coupon', 'coupon-panel', async () => {
    if (!AZR.settings.couponList) return;

    await waitSettled({ quiet: 600, timeout: 8000 });
    const buttons = findGrabButtons();
    const coupons = buttons.map(describe).filter((c) => c.type !== 'unknown');

    document.getElementById('azr-coupon-panel')?.remove();
    document.body.append(render(coupons, buttons));

    if (AZR.settings.couponAutoGrab && buttons.length) {
      AZR.log(`自動取得: ${buttons.length}件`);
      await grabAll(buttons);
    }
  });
})();
