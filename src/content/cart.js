/* Amazonize Rakuten - 買い物かごの合計金額パネル */
(() => {
  const AZR = window.AZR;
  const { h, yen, parseYen, waitSettled } = AZR;

  const LABEL_SUBTOTAL = /小計|商品合計/;
  const LABEL_SHIPPING = /送料/;
  const LABEL_POINT = /ポイント/;

  /**
   * かごページから金額を集計する。
   * ショップごとに「小計」が並ぶため、それらを合算して全体合計を出す。
   */
  function collect() {
    const shops = [];
    let shipping = 0;
    let points = 0;

    const nodes = document.querySelectorAll('td, dd, span, div, p');
    const usedRows = new Set();

    for (const el of nodes) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 40) continue;

      const row = el.closest('tr, li, section, div');
      if (!row) continue;

      if (LABEL_SUBTOTAL.test(text) && !/合計金額/.test(text)) {
        if (usedRows.has(row)) continue;
        const amount = parseYen(row.textContent);
        if (amount) {
          usedRows.add(row);
          const shopName = row.closest('[class*="shop"], table, section')
            ?.querySelector('a[href*="rakuten.co.jp/"]')?.textContent?.trim();
          shops.push({ name: shopName || `ショップ${shops.length + 1}`, subtotal: amount });
        }
      } else if (LABEL_SHIPPING.test(text) && !/無料/.test(text)) {
        const amount = parseYen(row.textContent);
        if (amount && amount < 50000) shipping = Math.max(shipping, amount);
      } else if (LABEL_POINT.test(text)) {
        const m = text.replace(/[,，]/g, '').match(/(\d+)\s*(?:ポイント|pt)/i);
        if (m) points = Math.max(points, Number(m[1]));
      }
    }

    const subtotal = shops.reduce((s, x) => s + x.subtotal, 0);
    return { shops, subtotal, shipping, points };
  }

  function render(data) {
    const panel = h('div.azr-panel.azr-cart-panel', { id: 'azr-cart-panel' },
      h('div.azr-panel-head',
        h('span.azr-panel-title', { text: 'かご合計' }),
        h('button.azr-panel-close', {
          type: 'button', text: '×', title: '閉じる',
          onclick: () => panel.remove()
        })
      ),
      h('div.azr-panel-body',
        h('div.azr-total-row.is-main',
          h('span', { text: `商品合計（${data.shops.length}ショップ）` }),
          h('strong', { text: yen(data.subtotal) })
        ),
        data.shipping ? h('div.azr-total-row',
          h('span', { text: '送料' }), h('span', { text: yen(data.shipping) })
        ) : '',
        h('div.azr-total-row.is-grand',
          h('span', { text: 'お支払い予定' }),
          h('strong', { text: yen(data.subtotal + data.shipping) })
        ),
        data.points ? h('div.azr-total-row.is-point',
          h('span', { text: '獲得予定ポイント' }),
          h('span', { text: `${data.points.toLocaleString('ja-JP')}pt` })
        ) : '',
        h('details.azr-breakdown',
          h('summary', { text: 'ショップ別内訳' }),
          h('ul', data.shops.map((s) => h('li',
            h('span.azr-shop-name', { text: s.name }),
            h('span.azr-shop-amount', { text: yen(s.subtotal) })
          )))
        )
      )
    );
    return panel;
  }

  AZR.register('cart', 'cart-total', async () => {
    if (!AZR.settings.cartTotal) return;
    await waitSettled({ quiet: 500, timeout: 8000 });

    const paint = () => {
      const data = collect();
      if (!data.shops.length) return;
      document.getElementById('azr-cart-panel')?.remove();
      document.body.append(render(data));
      AZR.log('cart totals', data);
    };

    paint();

    // 数量変更・削除などで再集計する（連打を抑えるためデバウンス）
    let timer = null;
    const obs = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(paint, 700);
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
})();
