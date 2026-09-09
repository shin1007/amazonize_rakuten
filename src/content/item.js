/* Amazonize Rakuten - 商品ページをAmazon風に再構成
 *
 * 楽天の商品ページは #item-page-app-data に商品データ一式をJSONで埋め込んでいる。
 * DOMを漁るより桁違いに安定するので、そちらを第一の情報源とし、
 * 取れなかった項目だけDOMから拾う。
 *
 * 購入エリア（#rakutenLimitedId_aroundCart）はReactが描画しているが、
 * 別の場所へ移設してもクリックハンドラは生きたままであることを実機で確認済み。
 * したがって複製ではなく移設する。
 */
(() => {
  const AZR = window.AZR;
  const { pick, pickAll, h, waitFor, parseYen, yen } = AZR;

  const SEL = {
    // 実ページで確認したID。ハッシュ付きクラス名より安定している。
    buybox: ['#rakutenLimitedId_aroundCart'],
    nameArea: ['#item-name-area'],
    price: ['#itemPrice', '[class*="item-price--"]', '[class*="price--"]'],
    description: ['.item_desc', '#item_desc', '[class*="ItemDescription"]'],
    reviewLink: ['a[href*="review.rakuten.co.jp"]']
  };

  /** 楽天が埋め込む商品データJSON。ページの心臓部。 */
  function readAppData() {
    const el = document.getElementById('item-page-app-data');
    if (!el) return null;
    try {
      return JSON.parse(el.textContent);
    } catch (e) {
      AZR.warn('item-page-app-data の解析に失敗:', e);
      return null;
    }
  }

  const upscale = (url) => (url || '').replace(/\?.*$/, '') + '?_ex=600x600';

  function fromAppData(app) {
    const sku = app?.api?.data?.itemInfoSku ?? app?.newApi?.itemInfoSku;
    if (!sku) return null;

    const priceInfo = sku.purchaseInfo?.purchaseBySellType?.normalPurchase?.price;
    const images = (sku.media?.images ?? sku.pcFields?.images ?? [])
      .map((im) => (typeof im === 'string' ? im : im.location))
      .filter(Boolean);

    return {
      title: sku.title || '',
      minPrice: priceInfo?.minPrice ?? null,
      maxPrice: priceInfo?.maxPrice ?? null,
      images,
      shop: {
        name: app.shop?.shopName || '',
        url: `https://www.rakuten.co.jp/${app.shop?.shopUrl || ''}/`
      },
      variants: (sku.variantSelectors || []).map((v) => v.label).filter(Boolean)
    };
  }

  /** JSONが無い/欠けている場合のDOMフォールバック */
  function fromDom() {
    const nameArea = pick(document, SEL.nameArea);
    const priceEl = pick(document, SEL.price);
    const metaImages = Array.from(document.querySelectorAll('meta[itemprop="image"]'))
      .map((m) => m.content).filter(Boolean);

    return {
      title: nameArea?.textContent?.trim()
        || document.querySelector('meta[itemprop="name"]')?.content
        || document.title.replace(/^【楽天市場】/, '').split('：')[0].trim(),
      minPrice: parseYen(priceEl?.textContent)
        || parseYen(document.querySelector('[itemprop="price"]')?.getAttribute('content')),
      maxPrice: null,
      images: metaImages,
      shop: {
        name: location.pathname.split('/').filter(Boolean)[0] || '',
        url: `https://www.rakuten.co.jp/${location.pathname.split('/').filter(Boolean)[0]}/`
      },
      variants: []
    };
  }

  function harvestReview() {
    // 「レビューを書く」等ではなく、件数が書かれたリンクを選ぶ
    const links = pickAll(document, SEL.reviewLink);
    const link = links.find((a) => /\d+\s*件/.test(a.textContent || '')) || links[0];
    if (!link) return null;
    const text = (link.textContent || '').replace(/[,，\s]/g, '');
    const count = text.match(/(\d+)件/);
    // 評価点はレビューリンク周辺の「4.52」形式を探す
    const near = (link.closest('div, td, section')?.textContent || '').replace(/\s+/g, ' ');
    const score = near.match(/([0-5]\.\d{1,2})/);
    return {
      href: link.href,
      count: count ? Number(count[1]) : null,
      score: score ? Number(score[1]) : null
    };
  }

  function harvestCoupons() {
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('a, li, span')) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 60 || !/クーポン/.test(t)) continue;
      if (!/(OFF|オフ|円引|%|％|送料無料)/i.test(t)) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      const c = AZR.coupons.parseCoupon(t, { source: 'item' });
      if (c.type !== 'unknown') out.push(c);
      if (out.length >= 6) break;
    }
    return out;
  }

  function priceLabel(data) {
    if (data.minPrice && data.maxPrice && data.maxPrice !== data.minPrice) {
      return `${yen(data.minPrice)}〜${yen(data.maxPrice)}`;
    }
    return yen(data.minPrice);
  }

  function stars(score) {
    if (!score) return null;
    const n = Math.round(score);
    return h('span.azr-stars', {
      title: `${score} / 5`,
      text: '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n)
    });
  }

  function buildLayout(data) {
    const gallery = h('div.azr-gallery');
    const main = h('img.azr-gallery-main', {
      src: upscale(data.images[0]), alt: data.title, loading: 'eager'
    });
    gallery.append(main);
    if (data.images.length > 1) {
      gallery.append(h('div.azr-thumbs',
        data.images.slice(0, 9).map((src, i) => h('img.azr-thumb', {
          src: (src || '').replace(/\?.*$/, '') + '?_ex=128x128',
          alt: '',
          class: i === 0 ? 'is-active' : '',
          onclick: (e) => {
            main.src = upscale(src);
            gallery.querySelectorAll('.azr-thumb').forEach((t) => t.classList.remove('is-active'));
            e.currentTarget.classList.add('is-active');
          }
        }))
      ));
    }

    const info = h('div.azr-info',
      h('h1.azr-title', { text: data.title }),
      h('a.azr-shop', { href: data.shop.url, text: data.shop.name }),
      data.review && h('a.azr-review', { href: data.review.href },
        stars(data.review.score),
        data.review.score ? h('span.azr-score', { text: data.review.score.toFixed(2) }) : '',
        data.review.count ? h('span.azr-count', { text: `${data.review.count.toLocaleString('ja-JP')}件のレビュー` }) : ''
      ),
      h('div.azr-price-block', h('span.azr-price', { text: priceLabel(data) })),
      data.variants.length ? h('div.azr-variants', {
        text: `選択項目: ${data.variants.join(' / ')}（右のボックスで選択）`
      }) : '',
      data.coupons.length ? h('div.azr-item-coupons',
        h('div.azr-section-label', { text: 'このページで見つかったクーポン' }),
        h('ul', data.coupons.map((c) => h('li', { text: c.label })))
      ) : ''
    );

    const buybox = h('aside.azr-buybox',
      h('div.azr-buybox-price', { text: priceLabel(data) }),
      h('div.azr-buybox-slot')
    );

    const detail = h('section.azr-detail');
    if (data.descriptionNode) {
      detail.append(h('h2.azr-h2', { text: '商品説明' }), h('div.azr-detail-body'));
    }

    return h('div.azr-item-root', { id: 'azr-item-root' },
      h('div.azr-topbar',
        h('span.azr-brand', { text: 'Amazonize Rakuten' }),
        h('span.azr-topbar-links',
          h('a', { href: 'https://www.rakuten.co.jp/', text: '楽天市場' }),
          h('a', { href: 'https://basket.step.rakuten.co.jp/rms/mall/basket/vc', text: '買い物かご' }),
          h('button.azr-toggle', {
            type: 'button',
            text: '元のページ',
            onclick: () => document.documentElement.classList.toggle('azr-simplified')
          })
        )
      ),
      h('div.azr-grid', gallery, info, buybox),
      detail
    );
  }

  AZR.register('item', 'item-simplify', async () => {
    if (!AZR.settings.simplifyItem) return;

    // 購入エリアはJSで後から描画されるので待つ
    const buyboxNode = await waitFor(() => pick(document, SEL.buybox), { timeout: 12000 });

    const app = readAppData();
    const base = fromAppData(app) || fromDom();
    // JSONで欠けた項目はDOMで補う
    if (!base.title || !base.minPrice || !base.images.length) {
      const dom = fromDom();
      base.title = base.title || dom.title;
      base.minPrice = base.minPrice || dom.minPrice;
      if (!base.images.length) base.images = dom.images;
      if (!base.shop.name) base.shop = dom.shop;
    }

    const data = {
      ...base,
      review: harvestReview(),
      coupons: AZR.settings.couponList ? harvestCoupons() : [],
      descriptionNode: pick(document, SEL.description)
    };
    AZR.log('harvested', data);

    if (!data.title || !data.minPrice) {
      AZR.warn('商品名か価格を取得できないため、元のページを表示します');
      return AZR.unhide();
    }
    if (!buyboxNode) {
      AZR.warn('購入エリアが見つからないため、元のページを表示します');
      return AZR.unhide();
    }

    const root = buildLayout(data);
    document.body.append(root);

    // 複製ではなく移設する。Reactのハンドラは移設後も動くことを確認済み。
    root.querySelector('.azr-buybox-slot').append(buyboxNode);
    if (data.descriptionNode) root.querySelector('.azr-detail-body')?.append(data.descriptionNode);

    document.documentElement.classList.add('azr-simplified');
    AZR.unhide();
  });
})();
