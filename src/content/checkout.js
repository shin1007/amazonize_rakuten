/* Amazonize Rakuten - 購入手続きページで最良クーポンを自動適用 */
(() => {
  const AZR = window.AZR;
  const { h, yen, parseYen, waitSettled } = AZR;

  const APPLY_TEXT = /反映|適用|利用する|変更する|クーポンを使う/;
  const COUPON_HINT = /(OFF|オフ|円引|円割引|%|％|送料無料)/i;

  /** ページの注文小計を推定する */
  function findSubtotal() {
    let best = 0;
    for (const el of document.querySelectorAll('td, dd, span, div, p')) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length > 40) continue;
      if (!/(商品合計|小計|お支払い金額|合計金額)/.test(t)) continue;
      const row = el.closest('tr, li, div') || el;
      const v = parseYen(row.textContent);
      if (v && v > best && v < 100000000) best = v;
    }
    return best;
  }

  function findShipping() {
    for (const el of document.querySelectorAll('td, dd, span, div')) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length > 30 || !/送料/.test(t)) continue;
      if (/無料/.test(t)) return 0;
      const v = parseYen((el.closest('tr, li, div') || el).textContent);
      if (v && v < 50000) return v;
    }
    return 0;
  }

  /** クーポン選択用の input を集めて構造化する */
  function findCouponInputs() {
    const found = [];
    for (const input of document.querySelectorAll('input[type="checkbox"], input[type="radio"]')) {
      if (input.disabled) continue;
      const label = input.closest('label')
        || (input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`))
        || input.closest('li, tr, div');
      const text = (label?.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 120) continue;
      if (!/クーポン/.test(text) && !COUPON_HINT.test(text)) continue;
      const coupon = AZR.coupons.parseCoupon(text, { source: 'checkout' });
      if (coupon.type === 'unknown') continue;
      found.push({ input, coupon, group: input.name || '__default__', kind: input.type });
    }
    return found;
  }

  function applySelection(entries, subtotal, shipping) {
    // グループ（input name）ごとに最良の1件を選ぶ
    const groups = new Map();
    for (const e of entries) {
      if (!groups.has(e.group)) groups.set(e.group, []);
      groups.get(e.group).push(e);
    }

    const chosen = [];
    let remaining = subtotal;
    for (const list of groups.values()) {
      const best = AZR.coupons.pickBest(list.map((e) => e.coupon), remaining, shipping);
      if (!best) continue;
      const entry = list.find((e) => e.coupon === best.coupon);
      chosen.push({ entry, discount: best.discount });
      // 併用時は残額に対して次のクーポンを評価する
      if (best.coupon.type !== 'shipping') remaining = Math.max(0, remaining - best.discount);
    }

    for (const { entry } of chosen) {
      if (!entry.input.checked) {
        entry.input.checked = true;
        entry.input.dispatchEvent(new Event('input', { bubbles: true }));
        entry.input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    return chosen;
  }

  function clickApplyButton() {
    for (const el of document.querySelectorAll('button, input[type="submit"], a[role="button"]')) {
      const text = (el.value || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 20) continue;
      if (!APPLY_TEXT.test(text)) continue;
      if (/注文を確定|注文する|購入を確定/.test(text)) continue; // 確定操作は絶対に押さない
      if (!el.offsetParent) continue;
      el.click();
      return true;
    }
    return false;
  }

  function render(ranked, subtotal, chosen) {
    const panel = h('div.azr-panel.azr-checkout-panel', { id: 'azr-checkout-panel' },
      h('div.azr-panel-head',
        h('span.azr-panel-title', { text: 'クーポン最適化' }),
        h('button.azr-panel-close', { type: 'button', text: '×', onclick: () => panel.remove() })
      ),
      h('div.azr-panel-body',
        h('div.azr-total-row', h('span', { text: '対象小計' }), h('strong', { text: yen(subtotal) })),
        chosen.length
          ? h('div.azr-applied',
              h('div.azr-section-label', { text: '適用したクーポン' }),
              h('ul', chosen.map((c) => h('li',
                h('span', { text: c.entry.coupon.label.slice(0, 50) }),
                h('strong', { text: `-${yen(c.discount)}` })
              ))),
              h('div.azr-total-row.is-grand',
                h('span', { text: '割引合計' }),
                h('strong', { text: `-${yen(chosen.reduce((s, c) => s + c.discount, 0))}` })
              )
            )
          : h('div.azr-empty', { text: '適用できるクーポンは見つかりませんでした' }),
        ranked.length ? h('details.azr-breakdown',
          h('summary', { text: `検出したクーポン ${ranked.length}件` }),
          h('ul', ranked.map(({ coupon, discount }) => h('li',
            h('span', { text: coupon.label.slice(0, 50) }),
            h('span', { text: discount ? `-${yen(discount)}` : '条件未達' })
          )))
        ) : ''
      )
    );
    return panel;
  }

  AZR.register('checkout', 'checkout-coupon', async () => {
    if (!AZR.settings.couponAutoApply) return;
    await waitSettled({ quiet: 600, timeout: 8000 });

    const entries = findCouponInputs();
    if (!entries.length) {
      AZR.log('クーポン選択UIが見つかりません');
      return;
    }

    const subtotal = findSubtotal();
    const shipping = findShipping();
    const ranked = AZR.coupons.rank(entries.map((e) => e.coupon), subtotal, shipping);

    let chosen = [];
    const apply = () => {
      chosen = applySelection(entries, subtotal, shipping);
      if (chosen.length) clickApplyButton();
      document.getElementById('azr-checkout-panel')?.remove();
      document.body.append(render(ranked, subtotal, chosen));
    };

    if (AZR.settings.couponAutoApplyConfirm) {
      const best = ranked[0];
      const panel = h('div.azr-panel.azr-checkout-panel', { id: 'azr-checkout-panel' },
        h('div.azr-panel-head', h('span.azr-panel-title', { text: 'クーポン最適化' })),
        h('div.azr-panel-body',
          h('div.azr-empty', {
            text: best && best.discount
              ? `最大 ${yen(best.discount)} の割引が使えます`
              : `${entries.length}件のクーポンを検出しました`
          }),
          h('button.azr-btn-primary', {
            type: 'button', text: '最良クーポンを適用', onclick: apply
          })
        )
      );
      document.getElementById('azr-checkout-panel')?.remove();
      document.body.append(panel);
    } else {
      apply();
    }
  });
})();
