/* Amazonize Rakuten - この商品はAmazonではいくらか
 *
 * 楽天の価格の下に、Amazonの同じ商品の価格を並べる。探すのは service worker
 * （Amazonの検索結果を1枚読む。JAN（無ければ商品名・説明から拾った型番）と、商品名から宣伝を落とした語の両方で引き、2行で並べる）。
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

  // Amazonのリンクは開発者のアソシエイトのタグ付き（中継ページ経由）。その旨を小さく添える
  const disclosure = () => h('div.azr-amazon-pr', { text: tr('※ Amazonアソシエイトのリンクを含みます') });

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

  const MESSAGE = () => ({
    none: tr('Amazonでは見つかりませんでした'),
    // 検索結果が空で返った（読み直しても空）。無いとは限らないので、そう言い切らない。
    empty: tr('Amazonの検索結果を読めませんでした'),
    blocked: tr('Amazonが応答しませんでした'),
    error: tr('Amazonの価格を調べられませんでした')
  });

  /*
   * 楽天→Amazon の見た目は、Amazon→楽天（amazon-link.js）と同じ。型番（JANがあればJAN）と商品名の2行を
   * 固定の高さで並べ、取得中も結果表示後も同じ高さにして、他の要素が動かないようにする。
   */
  const pulse = (el) => { try { el.animate([{ opacity: 1 }, { opacity: 0.4 }, { opacity: 1 }], { duration: 1200, iterations: Infinity }); } catch {} };

  function itemRow(kind, r, code, data) {
    const label = kind === 'code' ? tr(code.type || '型番') : tr('商品名');
    if (r === undefined) return loadingRow();
    // 型番も JAN も取れない商品は、商品名の行だけが引ける
    if (r === null) return h('div.azr-amz-row.azr-amz-empty', { text: tr('この商品は型番・JANが取得できません') });

    const searchBtn = r.searchUrl
      ? h('a.azr-amz-search', { href: r.searchUrl, target: '_blank', rel: 'noopener noreferrer', text: tr('{t}検索', { t: label }),
          title: tr('この検索語でAmazonを検索します（上の商品が上位に出るとは限りません）') })
      : '';

    if (r.status === 'ok' && r.item) {
      const { sure, badge } = matchLabel({ byJan: r.byJan, byModel: r.byModel, score: r.item.score, variants: data.variants?.length || 0 });
      const how = r.byJan ? tr('JANコード {jan} で検索した結果', { jan: data.jan })
        : r.byModel ? tr('型番「{q}」で検索した結果', { q: r.query })
        : tr('商品名「{q}」で検索した結果（商品名の一致度 {score}）', { q: r.query, score: r.item.score });
      const tag = r.byModel || r.byJan ? tr(r.byModel ? '型番が一致' : badge) : sure ? label : `${label}・${tr('参考')}`;
      const meta = r.item.rating ? `★ ${r.item.rating.toFixed(1)}${r.item.count ? ` (${r.item.count.toLocaleString('ja-JP')})` : ''}` : '';
      return h('div.azr-amz-row', { 'data-state': 'ok' },
        h('a.azr-amazon-item.azr-amz-main', { href: r.item.url, target: '_blank', rel: 'noopener noreferrer', title: `${r.item.title}
${how}` },
          r.item.image ? h('img.azr-amz-thumb', { src: r.item.image, alt: '', loading: 'lazy' }) : h('span.azr-amz-thumb'),
          h('span.azr-amz-body',
            h('span.azr-amz-price', { text: `amazon ${r.item.price ? yen(r.item.price) : tr('価格不明')} (${tag})${meta ? '  ' + meta : ''}` }),
            h('span.azr-amz-name', { text: r.item.title })
          )
        ),
        searchBtn
      );
    }
    const msg = (r.empty ? MESSAGE().empty : MESSAGE()[r.status]) || MESSAGE().error;
    return h('div.azr-amz-row.azr-amz-empty', { 'data-state': r.status || 'error' }, h('span.azr-amz-main', { text: `${msg} (${label})` }), searchBtn);
  }

  function loadingRow() {
    const row = h('div.azr-amz-row.azr-amz-loading', { text: tr('Amazonの商品情報を取得中…') });
    pulse(row);
    return row;
  }

  // results: { code: 型番/JANの結果, title: 商品名の結果 }。undefined は取得中、code が null は引く手がかりが無い
  function paint(box, results, data, code) {
    const done = Object.values(results).every((r) => r !== undefined);
    box.dataset.state = done ? (results.code?.status === 'ok' || results.title?.status === 'ok' ? 'ok' : (results.title?.status || 'error')) : 'loading';

    // 値差は、当たりの確かな方（型番/JAN → 商品名の順）で1つだけ出す
    const pick = [results.code, results.title].find((r) => r?.status === 'ok' && r.item);
    let diff = '';
    if (pick) {
      const { sure } = matchLabel({ byJan: pick.byJan, byModel: pick.byModel, score: pick.item.score, variants: data.variants?.length || 0 });
      diff = diffLine(data, pick.item.price, sure);
    }
    box.replaceChildren(
      itemRow('code', results.code, code, data),
      itemRow('title', results.title, code, data),
      h('div.azr-amz-diff-slot', diff),   // 値差の1行ぶんは最初から確保する
      disclosure()
    );
  }

  AZR.register('item', 'item-amazon', async () => {
    if (!AZR.settings.amazonPrice) return;
    const data = AZR.itemData;
    const anchor = document.querySelector('.azr-item-root .azr-price-block');
    if (!data?.title || !anchor) return;

    // 引く手がかり: JANがあればJAN、無ければ商品名や説明から拾った型番
    const model = AZR.amazon.isJan(data.jan) ? '' : AZR.amazon.extractModel(data.title, data.descriptionHtml || []);
    const code = AZR.amazon.isJan(data.jan) ? { type: 'JAN' } : model ? { type: '型番' } : { type: '' };
    const results = { code: code.type ? undefined : null, title: undefined };

    const box = h('section.azr-amazon', { 'data-state': 'loading' });
    anchor.after(box);
    paint(box, results, data, code);

    const ask = async (msg) => {
      try {
        return await chrome.runtime.sendMessage({ type: 'azr:amazonPrice', title: data.title, ...msg });
      } catch (e) {
        AZR.warn('Amazonの価格の問い合わせに失敗:', e);
        return { status: 'error' };
      }
    };
    const settle = (key, res) => {
      AZR.log('amazon', key, res);
      results[key] = res;
      if (box.isConnected) paint(box, results, data, code);
    };
    await Promise.all([
      code.type ? ask({ jan: data.jan || '', model }).then((r) => settle('code', r)) : null,
      ask({ jan: '', model: '' }).then((r) => settle('title', r))
    ]);
    if (!box.isConnected) return; // 待つあいだに元のページへ戻した
    document.documentElement.dataset.azrAmazon = box.dataset.state; // 検証用の目印

    // クーポンは後から増える（フローティングの応答・内容の確認）。適用後の価格が変わったら値差を出し直す。
    AZR.itemPricing?.watchers.push(() => {
      if (box.isConnected) paint(box, results, data, code);
    });
  });
})();
