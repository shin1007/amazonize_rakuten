/* Amazonize Rakuten - この商品はAmazonではいくらか
 *
 * 楽天の価格の下に、Amazonの同じ商品の価格を並べる。探すのは service worker
 * （Amazonの検索結果を1枚読む。JANがあればJANで、無ければ商品名から宣伝を落とした語で引く）。
 *
 * 突き合わせを外すことはあるので、当てた商品名・評価・検索結果へのリンクを必ず一緒に出し、
 * 本人が「これは違う」と分かるようにする。楽天のポイント還元は考えに入れていないので、
 * 値差はあくまで表示価格どうしの比較として出す。
 *
 * 楽天側は、上の価格欄と同じ「クーポン適用後の価格」で比べる（item.js の AZR.itemPricing）。
 * 欄に 1,180円 と出ているのに 1,680円 で比べては、同じ画面の中で数字が食い違う。
 * クーポンは後から増えるので、適用後の価格が変わったら値差も出し直す。
 */
(() => {
  const AZR = window.AZR;
  const tr = AZR.t;
  const { h, yen } = AZR;

  // 見出し（「同じJANコードの商品」か「似た商品」か）の判断は amazon-match.js にある
  const { matchLabel } = AZR.amazon;

  const mark = () => h('span.azr-amazon-mark', { text: 'amazon', title: tr('Amazonでの価格') });

  /**
   * 検索結果への導線。
   *
   * ここを「検索結果」とだけ書いていたら、飛んだ先にこの商品が見当たらない、という声があった。
   * 実際、拾った商品が検索結果の6〜7番目ということはふつうにあり、ブラウザで開いた検索結果には
   * 拡張が読むHTMLには無い広告が10件以上差し込まれる（同じURLで、拡張側48件・ブラウザ側60件のうち広告12件）。
   * 商品そのものへはカードの行から飛べるので、こちらは「他の候補」と書いて期待をずらす。
   */
  function searchLink(searchUrl, text = tr('他の候補')) {
    if (!searchUrl) return '';
    return h('a.azr-amazon-search', {
      href: searchUrl,
      target: '_blank',
      rel: 'noopener noreferrer',
      title: tr('この検索語でAmazonを検索します（上の商品が上位に出るとは限りません）'),
      text
    });
  }

  const note = (text) => h('div.azr-amazon-diff', h('span.azr-amazon-note', { text }));

  /**
   * 楽天の価格との差。ポイントは含まない、表示価格どうしの比較。
   *
   * **同じ商品だと言い切れないときは、差を出さない。** 楽天24の「温泡 5個セット（20錠×5個入）4,880円」に
   * Amazonの「温泡 こだわりローズ 20錠入×2 1,198円」が当たり、「Amazonが3,682円安い」と出た。
   * 中身の量が5倍違う別の商品で、この一行だけが独り歩きすると嘘になる。両方の値段は並べて出ているので、
   * 見比べるのは本人に任せる。
   *
   * 選択肢で値段が変わる商品（1,540円〜3,300円）も、どの選択肢と突き合わせたのか決められないので
   * 差は出さない。ただし楽天側の幅は事実なので添える（Amazonの値段と並べて本人が見比べられる）。
   */
  function diffLine(data, amazon, sure) {
    // 使えるクーポンがあれば適用後の価格で比べる（条件を満たさないクーポンは効いていない）
    const pricing = AZR.itemPricing?.value || null;
    const rakuten = pricing ? pricing.min : data.minPrice;
    const high = pricing ? pricing.max : (data.maxPrice > data.minPrice ? data.maxPrice : null);
    const applied = pricing ? tr('クーポン適用後、') : '';
    if (!(rakuten > 0) || !(amazon > 0)) return '';
    if (high > rakuten) return note(tr('{applied}楽天は選択によって {lo}〜{hi}', { applied, lo: yen(rakuten), hi: yen(high) }));
    if (!sure) return note(tr('同じ商品とは限らないので、値段は比べていません'));
    const d = Math.abs(rakuten - amazon);
    if (d === 0) return h('div.azr-amazon-diff.same', { text: tr('{applied}楽天と同じ価格', { applied }) });
    const cheaper = amazon < rakuten ? 'amazon' : 'rakuten';
    return h('div.azr-amazon-diff', { 'data-cheaper': cheaper },
      h('strong', { text: tr('{who}が{d}安い', { who: cheaper === 'amazon' ? 'Amazon' : tr('楽天'), d: yen(d) }) }),
      h('span.azr-amazon-note', {
        text: pricing
          ? tr('（楽天はクーポン適用後の価格。ポイント還元は含みません）')
          : tr('（表示価格の比較。楽天のポイント還元は含みません）')
      })
    );
  }

  function itemRow(item) {
    const meta = [];
    if (item.rating) {
      meta.push(h('span.azr-amazon-rating', { text: `★ ${item.rating.toFixed(1)}` }));
      if (item.count) meta.push(h('span.azr-amazon-count', { text: `(${item.count.toLocaleString('ja-JP')})` }));
    }

    // 行そのものがAmazonの商品ページへのリンク。押せると分かるよう「Amazonで見る」を添える
    return h('a.azr-amazon-item', {
      href: item.url, target: '_blank', rel: 'noopener noreferrer',
      title: `${item.title}\n${tr('Amazonの商品ページを開く')}`
    },
      item.image ? h('img.azr-amazon-thumb', { src: item.image, alt: '', loading: 'lazy' }) : '',
      h('span.azr-amazon-body',
        h('span.azr-amazon-name', { text: item.title }),
        meta.length ? h('span.azr-amazon-meta', meta) : ''
      ),
      h('span.azr-amazon-buy',
        h('span.azr-amazon-price', { text: item.price ? yen(item.price) : tr('価格不明') }),
        h('span.azr-amazon-open', { text: tr('Amazonで見る ›') })
      )
    );
  }

  const MESSAGE = {
    none: tr('Amazonでは見つかりませんでした'),
    // 検索結果が空で返った（読み直しても空）。無いとは限らないので、そう言い切らない。
    empty: tr('Amazonの検索結果を読めませんでした'),
    blocked: tr('Amazonが応答しませんでした'),
    error: tr('Amazonの価格を調べられませんでした')
  };

  function paint(box, res, data) {
    box.dataset.state = res?.status || 'error';

    if (res?.status === 'ok' && res.item) {
      const { label, badge, sure } = matchLabel({
        byJan: res.byJan,
        score: res.item.score,
        variants: data.variants?.length || 0
      });
      const how = res.byJan
        ? tr('JANコード {jan} で検索した結果', { jan: data.jan })
        : tr('商品名「{q}」で検索した結果（商品名の一致度 {score}）', { q: res.query, score: res.item.score });
      box.replaceChildren(
        h('div.azr-amazon-head',
          mark(),
          h('span.azr-amazon-label', { text: tr(label), title: how }),
          badge ? h('span.azr-amazon-badge', { 'data-kind': res.byJan ? 'jan' : 'guess', text: tr(badge), title: how }) : '',
          searchLink(res.searchUrl)
        ),
        itemRow(res.item),
        diffLine(data, res.item.price, sure)
      );
      box.dataset.azrScore = String(res.item.score ?? '');
      return;
    }

    box.replaceChildren(
      h('div.azr-amazon-head',
        mark(),
        h('span.azr-amazon-label', { text: (res?.empty ? MESSAGE.empty : MESSAGE[res?.status]) || MESSAGE.error }),
        searchLink(res?.searchUrl, tr('Amazonで探す'))
      )
    );
  }

  AZR.register('item', 'item-amazon', async () => {
    if (!AZR.settings.amazonPrice) return;
    const data = AZR.itemData;
    const anchor = document.querySelector('.azr-item-root .azr-price-block');
    if (!data?.title || !anchor) return;

    const box = h('section.azr-amazon', { 'data-state': 'loading' },
      h('div.azr-amazon-head', mark(), h('span.azr-amazon-label', { text: tr('での価格を調べています…') }))
    );
    anchor.after(box);

    let res = null;
    try {
      res = await chrome.runtime.sendMessage({ type: 'azr:amazonPrice', title: data.title, jan: data.jan || '' });
    } catch (e) {
      AZR.warn('Amazonの価格の問い合わせに失敗:', e);
    }
    AZR.log('amazon', res);
    if (!box.isConnected) return; // 待つあいだに元のページへ戻した
    paint(box, res, data);
    document.documentElement.dataset.azrAmazon = res?.status || 'error'; // 検証用の目印

    // クーポンは後から増える（フローティングの応答・内容の確認）。適用後の価格が変わったら値差を出し直す。
    AZR.itemPricing?.watchers.push(() => {
      if (box.isConnected) paint(box, res, data);
    });
  });
})();
