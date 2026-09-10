/* Amazonize Rakuten - 注文確認画面で最良クーポンを自動適用 */
(() => {
  const AZR = window.AZR;
  const { h, yen, onState, waitForState, waitFor } = AZR;

  const PANEL_ID = 'azr-checkout-panel';
  const COUPON_CARD = '#confirm-use-coupon-card'; // 楽天が付けている固定id
  const OPEN_TEXT = /^(変更|クーポンを選ぶ|選択)$/;
  const COMMIT_TEXT = /^(変更する|適用する|決定|OK)$/;
  const NEVER_CLICK = /注文を確定|同意して注文|注文する|購入を確定/;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* 状態からクーポンを読む ---------------------------------------------------
   * shopCoupons は店舗ごとの配列。項目のキー名は店舗・クーポン種別で揺れるので、
   * 「それらしいキー」を順に見て、名前・割引額・利用条件を拾う。
   * 割引額が状態から取れないものは、文言から coupon-model が推定する。 */

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
    const parsed = AZR.coupons.parseCoupon(
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
    return parsed;
  }

  /** 店舗ごとに「今の小計」と「使えるクーポン」を組にする */
  function collect(state) {
    const groups = [];
    for (const [shopId, list] of Object.entries(state?.shopCoupons || {})) {
      const coupons = (Array.isArray(list) ? list : [])
        .map((c) => normalizeCoupon(c, shopId))
        .filter((c) => c.usable !== false);
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

  /* 実際の画面を操作して適用する ---------------------------------------------
   * クーポンは「クーポン利用」カードの『変更』→モーダルで選択→『変更する』で確定する。
   * 状態を直接書き換えても楽天のサーバには伝わらないので、UIを押すしかない。
   * クラス名はハッシュ付きで当てにならないため、固定idと表示文言だけを頼りにする。 */

  /**
   * 目に見えて、実際に押せる大きさがあるか。
   *
   * 閉じたモーダルは 0x0 の要素としてDOMに残る。`getClientRects().length` は
   * そういう要素でも1を返すので、これを「見えている」と数えると、残骸の
   * 「変更する」を押して何も起きない（実機で踏んだ）。大きさで判断する。
   */
  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /**
   * 実際のマウス操作に近い形で押す。
   *
   * 楽天のボタンは `element.click()` では反応しないものがある（「変更する」で確認）。
   * pointerdown/mousedown から始まる一連のイベントを見ているためで、click だけでは
   * 押したことにならない。座標も要るので、要素の中心を渡す。
   */
  function realClick(el) {
    const r = el.getBoundingClientRect();
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true
    };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1 }));
      el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
      el.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }));
      el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
    } catch { /* PointerEventが無い環境では click だけで済ませる */ }
    el.click();
  }

  /** テキストが一致する押せる要素を探す。確定操作は絶対に返さない。 */
  function findClickable(root, re) {
    const nodes = root.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]');
    for (const el of nodes) {
      const text = (el.value || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 24) continue;
      if (NEVER_CLICK.test(text)) continue;
      if (!re.test(text)) continue;
      if (!visible(el)) continue;
      return el;
    }
    return null;
  }

  /**
   * クーポンの行と、その選択スイッチを探す。
   *
   * 注文確認の画面には、お届け日時・支払い方法など**複数のモーダルが同時にDOMへ
   * 置かれている**。「クーポン利用と変更するを含む要素」で探すと、いちばん外側の
   * 大きな入れ物に当たり、別のモーダルの「変更する」を押してしまう（実機で確認）。
   * そこで、クーポン名の行そのものを起点にする。
   */
  const SWITCH = '[role="checkbox"], [role="radio"], input[type="checkbox"], input[type="radio"]';
  const ROW_MAX_TEXT = 400; // 行に収まる長さ。これを超えるものはページの入れ物。

  function findCouponRow(label) {
    const key = label.replace(/\s+/g, ' ').trim().slice(0, 18);
    if (!key) return null;

    // クーポン名を含み、かつ「行」と呼べる短さの要素を探す。
    // スイッチ側から祖先を辿ると、ページ全体の入れ物までクーポン名を含むため、
    // ページ下部の無関係なチェックボックス（メルマガ等）を掴んでしまう（実機で踏んだ）。
    const rows = [];
    for (const el of document.querySelectorAll('div, li, label, tr, [role="button"]')) {
      const text = (el.textContent || '').replace(/\s+/g, ' ');
      if (text.length > ROW_MAX_TEXT || !text.includes(key)) continue;
      if (!el.querySelector(SWITCH)) continue;
      if (!visible(el)) continue;
      rows.push({ el, len: text.length });
    }
    if (!rows.length) return null;

    // いちばん内側（テキストがいちばん短い）ものが、その行そのもの
    rows.sort((a, b) => a.len - b.len);
    const row = rows[0].el;
    const box = row.querySelector(SWITCH);
    return box ? { box, row } : null;
  }

  /** その行と同じモーダルにある「変更する」を返す（別モーダルのものを掴まないため） */
  function findCommitNear(row) {
    let box = row;
    for (let i = 0; i < 14 && box; i++) {
      box = box.parentElement;
      if (!box) break;
      const btn = findClickable(box, COMMIT_TEXT);
      if (btn) return btn;
    }
    return null;
  }

  /**
   * その選択スイッチが今入っているか。
   * 見た目のチェックは `[role="checkbox"]` の aria-checked で、
   * その中にネイティブの input が隠れている作りだった。
   */
  function isChecked(box) {
    // aria があるならそれだけを信じる。中に隠れているネイティブの input は、
    // 選択を解除しても checked=true のまま残ることがあり、未選択なのに
    // 「選択済み」と読んでしまう（未選択のまま「変更する」を押していた）。
    const aria = box.matches('[role="checkbox"], [role="radio"]')
      ? box
      : box.querySelector('[role="checkbox"], [role="radio"]');
    if (aria) return aria.getAttribute('aria-checked') === 'true';
    const input = box.matches('input') ? box : box.querySelector('input[type="checkbox"], input[type="radio"]');
    return Boolean(input?.checked);
  }

  /**
   * クーポンの行を選ぶ。
   * 押した結果はReactの再描画を経てから反映されるので、同期で読まずに少し待つ。
   */
  async function select({ box, row }) {
    if (isChecked(box)) return true;
    for (const target of [box, row]) {
      if (!target) continue;
      realClick(target);
      for (let i = 0; i < 10; i++) {
        await sleep(200);
        if (isChecked(box)) return true;
      }
    }
    return isChecked(box);
  }

  /** クーポンを1枚適用する。「変更」→行を選ぶ→「変更する」の順に押す。 */
  async function applyCoupon(coupon) {
    const card = document.querySelector(COUPON_CARD);
    const open = card && findClickable(card, OPEN_TEXT);
    if (!open) return { ok: false, reason: 'クーポン欄の「変更」が見つからない' };
    realClick(open);

    const found = await waitFor(() => findCouponRow(coupon.label), { timeout: 8000 });
    if (!found) return { ok: false, reason: 'モーダルにそのクーポンの行が出てこない' };

    const rect = (el) => { const r = el.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`; };
    AZR.log('coupon row', { box: found.box.tagName, role: found.box.getAttribute('role'), boxRect: rect(found.box), rowRect: rect(found.row), checked: isChecked(found.box) });

    if (!(await select(found))) return { ok: false, reason: 'クーポンを選択できなかった' };
    await sleep(600); // 選択がReactに反映されてから確定を押す
    AZR.log('after select', { checked: isChecked(found.box) });

    const commit = findCommitNear(found.row);
    if (!commit) return { ok: false, reason: '「変更する」が見つからない' };
    realClick(commit);

    // 押しただけで成功と言わない。クーポン欄の表示が変わるのを確かめる。
    const key = coupon.label.replace(/\s+/g, ' ').trim().slice(0, 18);
    const done = await waitFor(() => {
      const text = (document.querySelector(COUPON_CARD)?.textContent || '').replace(/\s+/g, ' ');
      return text.includes(key) && !/利用なし/.test(text) ? true : null;
    }, { timeout: 10000 });
    if (done) return { ok: true };
    AZR.log('commit failed', { checked: isChecked(found.box), commit: commit.getBoundingClientRect() });
    return { ok: false, reason: '「変更する」を押したが、クーポン欄が変わらなかった' };
  }

  /* 表示 --------------------------------------------------------------------- */

  function render(groups, best, applied, note, onApply) {
    const total = groups.reduce((s, g) => s + g.applied, 0);
    const found = groups.reduce((s, g) => s + g.coupons.length, 0);

    const panel = h('div.azr-panel.azr-checkout-panel', { id: PANEL_ID },
      h('div.azr-panel-head',
        h('span.azr-panel-title', { text: 'クーポン最適化' }),
        h('button.azr-panel-close', {
          type: 'button', text: '×', title: '閉じる', onclick: () => panel.remove()
        })
      ),
      h('div.azr-panel-body',
        total ? h('div.azr-total-row.is-grand',
          h('span', { text: '適用中の割引' }),
          h('strong', { text: `-${yen(total)}` })
        ) : '',
        !found ? h('div.azr-empty', { text: 'この注文に使えるクーポンはありません' }) : '',
        note ? h('div.azr-coupon-status', { text: note }) : '',
        best && !applied ? h('button.azr-btn-primary', {
          type: 'button',
          text: `最良クーポンを適用（-${yen(best.discount)}）`,
          onclick: async (e) => {
            const button = e.currentTarget;
            button.disabled = true;
            button.textContent = '適用中…';
            const r = await onApply(best.coupon);
            if (r.ok) button.textContent = '適用しました';
            if (!r.ok) {
              button.disabled = false;
              button.textContent = '最良クーポンを適用';
              panel.querySelector('.azr-coupon-status')?.remove();
              panel.querySelector('.azr-panel-body')
                .append(h('div.azr-coupon-status', { text: `適用できなかった: ${r.reason}` }));
            }
          }
        }) : '',
        found ? h('details.azr-breakdown', { open: best ? 'open' : null },
          h('summary', { text: `使えるクーポン ${found}件` }),
          h('ul', groups.flatMap((g) => AZR.coupons
            .rank(g.coupons, g.subtotal, g.shipping)
            .map(({ coupon, discount }) => h('li',
              h('span.azr-shop-name', { text: coupon.label.slice(0, 40), title: coupon.label }),
              h('span', { text: discount ? `-${yen(discount)}` : '条件未達' })
            ))))
        ) : ''
      )
    );
    return panel;
  }

  /* 本体 --------------------------------------------------------------------- */

  let unsubscribe = null;

  AZR.register('checkout', 'checkout-coupon', async () => {
    if (!AZR.settings.couponAutoApply) return;
    unsubscribe?.();
    unsubscribe = null;

    const state = await waitForState({ timeout: 10000 });
    if (!state) {
      AZR.warn('注文確認の状態を受け取れなかった');
      return;
    }

    let autoApplied = false;
    // 状態は数百msごとに流れてくる。中身が同じなのに描き直すと、
    // 押そうとした瞬間にボタンが差し替わってクリックが消える（実機で踏んだ）。
    let lastSignature = '';
    let busy = false;

    // 適用の最中は描き直さない。押している最中にボタンごと差し替わってしまう。
    const runApply = async (coupon) => {
      busy = true;
      try {
        const r = await applyCoupon(coupon);
        if (!r.ok) AZR.warn('クーポンを適用できなかった:', r.reason);
        else lastSignature = ''; // 結果を反映するため、次の状態で描き直す
        return r;
      } catch (e) {
        // 途中で例外が出ても「適用中…」のまま固まらせない
        AZR.warn('クーポン適用中に例外:', e);
        return { ok: false, reason: String(e?.message || e) };
      } finally {
        busy = false;
      }
    };

    const paint = async (current) => {
      if (busy) return;
      const groups = collect(current);
      const applied = groups.some((g) => g.applied > 0);

      // 店舗ごとの最良を見て、いちばん得なものを1件だけ勧める。
      // 楽天のクーポンは店舗ごとに1枚しか選べないため、まとめて適用はしない。
      let best = null;
      for (const g of groups) {
        const b = AZR.coupons.pickBest(g.coupons, g.subtotal, g.shipping);
        if (b && (!best || b.discount > best.discount)) best = { ...b, shopId: g.shopId };
      }

      const note = applied
        ? 'すでにクーポンが適用されています'
        : (best ? null : (groups.some((g) => g.coupons.length) ? '条件を満たすクーポンがありません' : null));

      const signature = JSON.stringify([
        applied,
        groups.map((g) => [g.shopId, g.applied, g.subtotal, g.coupons.length]),
        best ? [best.coupon.id || best.coupon.label, best.discount] : null
      ]);
      if (signature === lastSignature && document.getElementById(PANEL_ID)) return;
      lastSignature = signature;

      document.getElementById(PANEL_ID)?.remove();
      document.body.append(render(groups, applied ? null : best, applied, note, runApply));
      AZR.log('checkout coupons', { groups, best, applied });

      // 確認なしの設定なら、いちばん得なものを1回だけ自分で適用する
      if (best && !applied && !autoApplied && !AZR.settings.couponAutoApplyConfirm) {
        autoApplied = true;
        const r = await runApply(best.coupon);
        AZR.log('auto apply', r);
      }
    };

    await paint(state);

    unsubscribe = onState((next) => {
      if (AZR.pageKind() !== 'checkout') return;
      if (!document.getElementById(PANEL_ID)) return; // 閉じられたら描き直さない
      paint(next);
    });
  });
})();
