/* Amazonize Rakuten - 買い物かごの合計金額パネル */
(() => {
  const AZR = window.AZR;
  const tr = AZR.t;
  const { h, yen, onState, waitForState } = AZR;

  const PANEL_ID = 'azr-cart-panel';

  /**
   * ブリッジから届いた状態を、表示用の数字にまとめる。
   *
   * 楽天のかごは店舗ごとに小計・送料・ポイントが別々に出るうえ、
   * 全店舗を足した「今いくら払うのか」がどこにも出ない。ここで足す。
   */
  function summarize(state) {
    if (!state) return null;
    const order = state.shopDisplayOrder?.cart?.length
      ? state.shopDisplayOrder.cart
      : Object.keys(state.subtotals || {});

    const shops = [];
    for (const id of order) {
      const t = state.subtotals?.[id];
      if (!t) continue;
      shops.push({
        id,
        name: state.shops?.[id]?.shopName || tr('ショップ{n}', { n: shops.length + 1 }),
        url: state.shops?.[id]?.shopUrl || '',
        itemCount: t.itemCount,
        itemTotal: t.itemTotalPrice,
        // 送料はかご段階では金額が出ず、無料かどうかだけ分かることが多い
        fee: t.fee,
        shippingFree: t.shippingFeeType === 'free',
        coupon: t.couponUsage,
        payment: t.paymentAmount || t.itemTotalPrice,
        points: t.pointValue,
        pointRate: t.pointRate
      });
    }
    if (!shops.length) return null;
    // かごの下のほうのショップは、スクロールするまで金額が届かない。
    // 届いていない分は合計に入らないので、そのことを表示に出す。
    const pending = order.filter((id) => !state.subtotals?.[id]).length;

    const sum = (key) => shops.reduce((s, x) => s + (x[key] || 0), 0);
    const payment = sum('payment');
    const points = sum('points');
    const fee = sum('fee');
    return {
      shops,
      pending,
      itemCount: sum('itemCount'),
      itemTotal: sum('itemTotal'),
      fee,
      // 送料の金額が分からず、無料でもない店がある。合計には送料が入っていない。
      feeUnknown: !fee && shops.some((s) => !s.shippingFree),
      coupon: sum('coupon'),
      payment,
      points,
      // Amazonのように「結局いくら得なのか」を一行で見せる
      effective: Math.max(0, payment - points)
    };
  }

  function render(data) {
    const panel = h('div.azr-panel.azr-cart-panel', { id: PANEL_ID },
      h('div.azr-panel-head',
        h('span.azr-panel-title', { text: tr('かご合計') }),
        h('button.azr-panel-close', {
          type: 'button', text: '×', title: tr('閉じる'),
          onclick: () => { closed = true; panel.remove(); }
        })
      ),
      h('div.azr-panel-body',
        h('div.azr-total-row.is-main',
          h('span', { text: tr('商品合計（{items}点 / {shops}ショップ）', { items: data.itemCount, shops: data.shops.length }) }),
          h('strong', { text: yen(data.itemTotal) })
        ),
        data.fee ? h('div.azr-total-row',
          h('span', { text: tr('送料') }), h('span', { text: yen(data.fee) })
        ) : h('div.azr-total-row',
          h('span', { text: tr('送料') }),
          h('span', { text: data.feeUnknown ? tr('購入手続きで確定') : tr('無料') })
        ),
        data.coupon ? h('div.azr-total-row',
          h('span', { text: tr('クーポン割引') }),
          h('span.azr-discount', { text: `-${yen(data.coupon)}` })
        ) : '',
        h('div.azr-total-row.is-grand',
          h('span',
            tr('お支払い予定'),
            data.feeUnknown ? h('small.azr-fee-note', { text: tr('（送料がある場合は別）') }) : ''
          ),
          h('strong', { text: yen(data.payment) })
        ),
        data.pending ? h('div.azr-total-row.is-note',
          h('small.azr-fee-note', { text: tr('あと{n}ショップは未読み込み。下へスクロールすると合計に入ります', { n: data.pending }) })
        ) : '',
        data.points ? h('div.azr-total-row.is-point',
          h('span', { text: tr('獲得予定ポイント') }),
          h('span', { text: `${data.points.toLocaleString(AZR.numberLocale)}pt` })
        ) : '',
        data.points ? h('div.azr-total-row.is-effective',
          h('span', { text: tr('ポイント差引後') }),
          h('strong', { text: yen(data.effective) })
        ) : '',
        data.shops.length > 1 || data.shops[0].itemCount > 1
          ? h('details.azr-breakdown',
              h('summary', { text: tr('ショップ別内訳') }),
              h('ul', data.shops.map((s) => h('li',
                h('span.azr-shop-name', { text: s.name, title: s.name }),
                h('span.azr-shop-amount', {
                  text: (s.points ? `${yen(s.payment)} / ${s.points.toLocaleString(AZR.numberLocale)}pt` : yen(s.payment))
                    + (s.shippingFree || s.fee ? '' : tr(' ＋送料'))
                })
              )))
            )
          : ''
      )
    );
    return panel;
  }

  // 中身が同じなら描き直さない。状態は数百msごとに流れてくるので、
  // そのたびに作り直すと閉じるボタンを押した瞬間に差し替わってしまう。
  let lastSignature = '';
  // 閉じるボタンで閉じた。その画面にいる間は出し直さない。
  let closed = false;

  /*
   * 下のほうのショップは、画面に入るまで金額が届かない。合計に欠けが出るので、
   * 届いていない間は一瞬だけ最下部へ飛んで元の位置に戻し、読み込みを促す。
   * 何度やっても届かないもの（消えたショップの残り）で延々と繰り返さない。
   */
  const LOAD_TRIES = 4;
  let loadTries = 0;
  let lastPending = 0;
  let loading = false;
  async function loadLazyShops() {
    if (loading || loadTries >= LOAD_TRIES) return;
    loading = true;
    loadTries++;
    const y = window.scrollY;
    try {
      const root = document.documentElement;
      // スクロール位置がなめらかに動く設定でも、見えないうちに済ませる
      root.style.scrollBehavior = 'auto';
      // 一気に飛ぶと途中のショップが画面に入らず読み込まれない。画面の高さずつ降りる。
      const step = Math.max(300, window.innerHeight * 0.8);
      for (let pos = y, i = 0; i < 40; i++) {
        pos += step;
        window.scrollTo(0, pos);
        await new Promise((r) => setTimeout(r, 300));
        if (pos + window.innerHeight >= document.documentElement.scrollHeight) break;
      }
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      window.scrollTo(0, y);
      document.documentElement.style.scrollBehavior = '';
      loading = false;
    }
  }

  function paint(state) {
    const data = summarize(state);
    const pending = data?.pending || 0;
    // 進んでいるうちは試行を数え直す（届くたびに残りが減る）
    if (pending < lastPending) loadTries = 0;
    lastPending = pending;
    if (pending) loadLazyShops();
    else loadTries = 0;
    if (!data) {
      // 全部消されたら古い合計を残さない
      document.getElementById(PANEL_ID)?.remove();
      lastSignature = '';
      return false;
    }
    const signature = JSON.stringify([
      data.pending, data.itemCount, data.itemTotal, data.fee, data.coupon, data.payment, data.points,
      data.shops.map((s) => [s.id, s.payment, s.points, s.shippingFree])
    ]);
    const existing = document.getElementById(PANEL_ID);
    if (existing && signature === lastSignature) return true;
    lastSignature = signature;

    if (existing) existing.replaceWith(render(data));
    else document.body.append(render(data));
    AZR.log('cart totals', data);
    return true;
  }

  // SPAの経路変更で同じモジュールが動き直すので、前回の購読は必ず切る
  let unsubscribe = null;

  AZR.register('cart', 'cart-total', async () => {
    if (!AZR.settings.cartTotal) return;
    unsubscribe?.();
    unsubscribe = null;
    closed = false;
    lastSignature = '';
    loadTries = 0;

    const state = await waitForState({ timeout: 10000 });
    if (!state) {
      AZR.warn('かごの状態を受け取れなかった（__INITIAL_STATE__ が読めない）');
      return;
    }
    // 空に見えても購読はやめない。中身は後から届く状態で分かることがある。
    if (!paint(state)) AZR.log('かごが空（状態の続きを待つ）');

    // 数量変更・削除・ショップ選択でそのつど状態が流れてくる
    unsubscribe = onState((next) => {
      if (AZR.pageKind() !== 'cart' || closed) return;
      paint(next);
    });
  });
})();
