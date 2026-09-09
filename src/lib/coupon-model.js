/* Amazonize Rakuten - クーポン文言の解析と最良クーポン選択 */
(() => {
  const AZR = (window.AZR = window.AZR || {});
  const { parseYen } = AZR;

  const toHalf = (s) => String(s || '')
    .replace(/[０-９％]/g, (c) => (c === '％' ? '%' : String.fromCharCode(c.charCodeAt(0) - 0xfee0)))
    .replace(/[,，]/g, '');

  /**
   * クーポンの表示テキストから構造化データを作る。
   * 例: "5,000円以上で1,000円OFF" / "10%OFF(最大2,000円)" / "送料無料"
   */
  function parseCoupon(rawText, extra = {}) {
    const text = toHalf(rawText).replace(/\s+/g, ' ').trim();
    const c = {
      label: String(rawText || '').replace(/\s+/g, ' ').trim(),
      type: 'unknown',
      amount: 0,      // 固定額OFF
      percent: 0,     // 率OFF
      cap: null,      // 率OFFの上限額
      minSpend: 0,    // 利用条件（最低購入金額）
      raw: text,
      ...extra
    };

    // 利用条件: "5000円以上"
    const min = text.match(/(\d+)\s*円\s*(?:\(税込\)|税込)?\s*以上/);
    if (min) c.minSpend = Number(min[1]);

    // 率OFF
    const pct = text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:OFF|オフ|引き?)/i);
    if (pct) {
      c.type = 'percent';
      c.percent = Number(pct[1]);
      const cap = text.match(/(?:最大|上限)\s*(\d+)\s*円/);
      if (cap) c.cap = Number(cap[1]);
    }

    // 固定額OFF: 「以上」条件の金額と取り違えないよう、OFF直前の金額のみ拾う
    if (c.type === 'unknown') {
      const fixed = text.match(/(\d+)\s*円\s*(?:分)?\s*(?:OFF|オフ|引き?|割引|クーポン)/i);
      if (fixed) {
        c.type = 'fixed';
        c.amount = Number(fixed[1]);
      }
    }

    // 送料無料
    if (c.type === 'unknown' && /送料\s*(無料|込み?|0円)/.test(text)) {
      c.type = 'shipping';
    }

    // 最後の手段: 数値が1つだけならそれを固定額とみなす
    if (c.type === 'unknown') {
      const only = parseYen(text);
      if (only && !c.minSpend) { c.type = 'fixed'; c.amount = only; }
    }

    return c;
  }

  /** このクーポンを小計 subtotal に適用したときの割引額（適用不可なら 0） */
  function discountFor(coupon, subtotal, shippingFee = 0) {
    if (!coupon) return 0;
    if (coupon.minSpend && subtotal < coupon.minSpend) return 0;
    switch (coupon.type) {
      case 'fixed':
        return Math.min(coupon.amount, subtotal);
      case 'percent': {
        const raw = Math.floor(subtotal * coupon.percent / 100);
        return Math.min(coupon.cap ?? Infinity, raw, subtotal);
      }
      case 'shipping':
        return Math.max(0, shippingFee);
      default:
        return 0;
    }
  }

  /**
   * 適用可能なクーポンのうち割引額が最大のものを返す。
   * 同額なら「条件が緩い（minSpendが小さい）」ものを優先。
   */
  function pickBest(coupons, subtotal, shippingFee = 0) {
    let best = null;
    let bestValue = 0;
    for (const c of coupons || []) {
      const v = discountFor(c, subtotal, shippingFee);
      if (v <= 0) continue;
      if (v > bestValue || (v === bestValue && best && c.minSpend < best.minSpend)) {
        best = c;
        bestValue = v;
      }
    }
    return best ? { coupon: best, discount: bestValue } : null;
  }

  /** 割引額つきで降順ソートした一覧（一覧表示用） */
  function rank(coupons, subtotal, shippingFee = 0) {
    return (coupons || [])
      .map((c) => ({ coupon: c, discount: discountFor(c, subtotal, shippingFee) }))
      .sort((a, b) => b.discount - a.discount || a.coupon.minSpend - b.coupon.minSpend);
  }

  AZR.coupons = { parseCoupon, discountFor, pickBest, rank };
})();
