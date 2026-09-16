/* Amazonize Rakuten - クーポン文言の解析と最良クーポン選択 */
(() => {
  const AZR = (window.AZR = window.AZR || {});
  const { parseYen } = AZR;

  // 全角の英数字・記号（！〜～）をまとめて半角にする。数字と％だけだと、店舗が書く
  // 「１０％ＯＦＦ（最大５００円）」の ＯＦＦ や（税込）の括弧を読み落とし、率引きを500円引きと読んでいた。
  const toHalf = (s) => String(s || '')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/,/g, '');

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
   * このクーポンを「商品1個ぶん」の価格に効かせてよいか。
   * 持っているクーポンでも、条件を満たさないものは価格に出さない。
   *   minSpend    この価格では足りない（2個買えば届くとしても、出しているのは1個の価格）
   *   minUnits    2個以上でないと使えない
   *   salesMethod 定期購入限定（出しているのは通常購入の価格）
   * 送料無料クーポンは商品の価格を動かさないので効かない（discountFor が 0 を返す）。
   */
  function appliesToItem(coupon, price) {
    if (!coupon || !(price > 0)) return false;
    if (coupon.minUnits > 1) return false;
    if (coupon.salesMethod === 'subscription') return false;
    if (coupon.minSpend && price < coupon.minSpend) return false;
    return discountFor(coupon, price) > 0;
  }

  /**
   * 商品を1個買ったときに、いちばん安くなるクーポンと適用後の価格。
   * 使えるクーポンが1枚も無ければ null（＝価格はそのまま）。
   */
  function itemPrice(coupons, price) {
    const best = pickBest((coupons || []).filter((c) => appliesToItem(c, price)), price);
    return best ? { ...best, price: price - best.discount } : null;
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

  /* 注文確認の状態からクーポンを読む -------------------------------------------
   * shopCoupons は店舗ごとの配列。項目のキー名は店舗・クーポン種別で揺れるので、
   * 「それらしいキー」を順に見て、名前・割引額・利用条件を拾う。
   * 割引額が状態から取れないものは、文言から推定する。 */

  const firstNumber = (obj, keys) => {
    for (const k of keys) {
      const v = obj?.[k];
      const n = typeof v === 'string' ? Number(v.replace(/[,，]/g, '')) : v;
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
  };
  const firstString = (obj, keys) => {
    for (const k of keys) {
      const v = obj?.[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };

  /**
   * 実物の1件（楽天24の700円OFF）はこうなっていた:
   *   couponName  "【楽天24】全商品対象税込4000円以上で700円OFFクーポン"
   *   description "商品の合計金額から700円OFF"
   *   conditions  "利用条件：対象ショップ｜4,000円以上の購入｜…｜併用不可｜…"
   *   discountPrice "700円OFF"   ← 数値ではなく文字列
   *   couponCode / selected / usable / alerts / countStatus
   * 割引額も利用条件も数値では入っていないので、結局は文言から読むことになる。
   * 店舗やクーポン種別でキーが違っても拾えるよう、候補キーを順に見る。
   */
  function normalizeCoupon(rawEntry, shopId) {
    const name = firstString(rawEntry, ['couponName', 'name', 'title', 'displayName', 'couponTitle']);
    const detail = firstString(rawEntry, ['description', 'message', 'couponMessage', 'note']);
    const conditions = firstString(rawEntry, ['conditions', 'condition', 'usageConditions']);
    const priceText = firstString(rawEntry, ['discountPrice', 'discountText', 'benefitText']);
    const parsed = parseCoupon(
      [name, detail, priceText, conditions].filter(Boolean).join(' '),
      { source: 'checkout', shopId, raw: rawEntry }
    );
    parsed.label = name || parsed.label;

    // 数値で割引額が入っている形なら、そちらを優先する
    const amount = firstNumber(rawEntry, ['discountAmount', 'discount', 'couponPrice']);
    if (amount) {
      parsed.type = 'fixed';
      parsed.amount = amount;
    }
    const min = firstNumber(rawEntry, ['minPurchaseAmount', 'minimumAmount', 'lowerLimit', 'conditionAmount']);
    if (min) parsed.minSpend = min;

    parsed.id = firstString(rawEntry, ['couponCode', 'couponId', 'id', 'issueId']);
    parsed.selected = Boolean(
      rawEntry?.selected ?? rawEntry?.isSelected ?? rawEntry?.applied ?? rawEntry?.isApplied
    );
    parsed.usable = rawEntry?.usable ?? rawEntry?.canUse ?? rawEntry?.isAvailable ?? true;
    // 1枚選ぶと、他のクーポンは全部 usable:false になり、alerts に理由が付く。
    //   ["選択済みのクーポンと併用が出来ません。"]                       ← 選び直せば使える
    //   ["選択済みのクーポンと併用が出来ません。", "5,000円以上お買い上げの…"] ← 選び直しても使えない
    // 併用の理由だけで使えないものは、切り替えの候補に残す。
    const alerts = Array.isArray(rawEntry?.alerts) ? rawEntry.alerts.map(String) : [];
    parsed.blockedBySelection = parsed.usable === false && alerts.length > 0
      && alerts.every((a) => /併用/.test(a));
    return parsed;
  }

  /** 店舗ごとに「今の小計」と「使えるクーポン」を組にする */
  function collect(state) {
    const groups = [];
    for (const [shopId, list] of Object.entries(state?.shopCoupons || {})) {
      const coupons = (Array.isArray(list) ? list : [])
        .map((c) => normalizeCoupon(c, shopId))
        .filter((c) => c.usable !== false || c.blockedBySelection);
      const t = state.subtotals?.[shopId] || state.subtotals?.SUM || {};
      groups.push({
        shopId,
        shopName: state.shops?.[shopId]?.shopName || '',
        subtotal: t.itemTotalPrice || 0,
        shipping: t.fee || 0,
        applied: t.couponUsage || 0,
        coupons
      });
    }
    return groups;
  }

  const sameCoupon = (a, b) => (a.id && b.id ? a.id === b.id : a.label === b.label);

  /**
   * 注文確認でどのクーポンに切り替えるかを決める。
   *
   * 店舗ごとの最良を見て、いちばん得なものを1件だけ勧める。
   * 楽天のクーポンは店舗ごとに1枚しか選べないため、まとめて適用はしない
   * （そもそも注文確認は1回の手続きで1ショップ分しか出ない）。
   * 「得」は割引率ではなく実際に引かれる金額で比べる。10%OFFでも小計が小さければ200円OFFに負ける。
   *
   * 楽天はクーポンを1枚先に選んでおくことがある。それが最良とは限らない。
   * 今の割引額より多く引けるものがあるときだけ better を返す（同額なら切り替えない）。
   */
  function chooseSwitch(groups) {
    const appliedTotal = groups.reduce((s, g) => s + g.applied, 0);
    let best = null;
    for (const g of groups) {
      const b = pickBest(g.coupons, g.subtotal, g.shipping);
      if (b && (!best || b.discount > best.discount)) best = { ...b, shopId: g.shopId };
    }
    const selected = groups.flatMap((g) => g.coupons.filter((c) => c.selected));
    const bestSelected = Boolean(best && selected.some((c) => sameCoupon(c, best.coupon)));
    const better = best && !bestSelected && best.discount > appliedTotal ? best : null;
    return { appliedTotal, best, better, selected };
  }

  AZR.coupons = { parseCoupon, discountFor, appliesToItem, itemPrice, pickBest, rank, normalizeCoupon, collect, sameCoupon, chooseSwitch };
})();
