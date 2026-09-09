/* Amazonize Rakuten - 商品ページをAmazon風に再構成 */
(() => {
  const AZR = window.AZR;
  const { pick, pickAll, h, waitFor, parseYen, yen } = AZR;

  // --- セレクタ候補（楽天のDOM変更に備えて複数用意する） ---------------------
  const SEL = {
    title: ['h1[class*="normal_reserve_item_name"]', '.item_name', '[class*="ItemName"] h1', 'h1'],
    price: [
      '[class*="price--"]', '.price2', '.price',
      '[class*="ItemPrice"]', '[itemprop="price"]'
    ],
    points: ['[class*="point"]', '#points', '.pointBox'],
    shopLink: ['#shopName a', '[class*="shopName"] a', 'a[href^="https://www.rakuten.co.jp/"]'],
    reviewLink: ['a[href*="review.rakuten.co.jp"]', 'a[href*="/review/"]'],
    cartForm: [
      'form[action*="basket.step.rakuten.co.jp"]',
      'form[action*="basket"]',
      'form[name="ItemForm"]',
      '#rakutenLimitedId_aroundCart form',
      'form[action*="step.item.rakuten.co.jp"]'
    ],
    description: [
      '#item_desc', '.item_desc', '[class*="ItemDescription"]',
      '#RakutenLimitedId_ItemInfo', '.sale_desc', '#itemDescription'
    ],
    images: ['img[src*="image.rakuten.co.jp"], img[src*="tshop.r10s.jp"], img[src*="shop.r10s.jp"]']
  };

  const upscale = (url) => {
    if (!url) return url;
    return url.replace(/_ex=\d+x\d+/, '_ex=600x600').replace(/^\/\//, 'https://');
  };

  function harvestImages() {
    const seen = new Set();
    const out = [];
    for (const img of pickAll(document, SEL.images)) {
      const src = img.currentSrc || img.src;
      if (!src) continue;
      const rect = img.getBoundingClientRect();
      // アイコン・バナー類を除外
      if (rect.width && rect.width < 60) continue;
      if (/banner|logo|icon|spacer|footer/i.test(src)) continue;
      const key = src.replace(/\?.*$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(upscale(src));
      if (out.length >= 12) break;
    }
    return out;
  }

  function harvestPrice() {
    // 「円」を含み、かつ price らしいクラスを持つ要素から最初の妥当な金額を拾う
    for (const el of pickAll(document, SEL.price)) {
      const v = parseYen(el.textContent);
      if (v && v >= 10 && v < 100000000) return v;
    }
    const meta = document.querySelector('meta[itemprop="price"], meta[property="product:price:amount"]');
    if (meta) return parseYen(meta.content);
    return null;
  }

  function harvestPoints() {
    for (const el of pickAll(document, SEL.points)) {
      const m = (el.textContent || '').replace(/[,，]/g, '').match(/(\d+)\s*ポイント/);
      if (m) return Number(m[1]);
    }
    return null;
  }

  function harvestShop() {
    const shopCode = location.pathname.split('/').filter(Boolean)[0] || '';
    const link = pick(document, SEL.shopLink);
    const name = link?.textContent?.trim();
    return {
      code: shopCode,
      name: name && name.length < 60 ? name : shopCode,
      url: `https://www.rakuten.co.jp/${shopCode}/`
    };
  }

  function harvestReview() {
    const link = pick(document, SEL.reviewLink);
    if (!link) return null;
    const text = (link.closest('[class*="review"]') || link).textContent.replace(/\s+/g, ' ');
    const score = text.match(/([0-5](?:\.\d+)?)\s*(?:点|\/\s*5)/);
    const count = text.replace(/[,，]/g, '').match(/(\d+)\s*件/);
    return {
      href: link.href,
      score: score ? Number(score[1]) : null,
      count: count ? Number(count[1]) : null
    };
  }

  /** ページ内に出ているショップクーポンを拾う */
  function harvestItemCoupons() {
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('a, li, div > span')) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 60) continue;
      if (!/クーポン/.test(t)) continue;
      if (!/(OFF|オフ|円引|%|％|送料無料)/i.test(t)) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      const c = AZR.coupons.parseCoupon(t, { source: 'item', href: el.href || null });
      if (c.type !== 'unknown') out.push(c);
      if (out.length >= 8) break;
    }
    return out;
  }

  function stars(score) {
    if (!score) return null;
    const filled = Math.round(score);
    return h('span.azr-stars', { title: `${score} / 5`, text: '★★★★★'.slice(0, filled) + '☆☆☆☆☆'.slice(0, 5 - filled) });
  }

  function buildLayout(data) {
    const gallery = h('div.azr-gallery');
    const main = h('img.azr-gallery-main', {
      src: data.images[0] || '', alt: data.title, loading: 'eager'
    });
    const thumbs = h('div.azr-thumbs',
      data.images.slice(0, 8).map((src, i) =>
        h('img.azr-thumb', {
          src,
          alt: '',
          class: i === 0 ? 'is-active' : '',
          onclick: (e) => {
            main.src = src;
            gallery.querySelectorAll('.azr-thumb').forEach((t) => t.classList.remove('is-active'));
            e.currentTarget.classList.add('is-active');
          }
        })
      )
    );
    gallery.append(main);
    if (data.images.length > 1) gallery.append(thumbs);

    const info = h('div.azr-info',
      h('h1.azr-title', { text: data.title }),
      h('a.azr-shop', { href: data.shop.url, text: data.shop.name }),
      data.review && h('a.azr-review', { href: data.review.href },
        stars(data.review.score),
        data.review.score ? h('span.azr-score', { text: data.review.score.toFixed(2) }) : '',
        data.review.count ? h('span.azr-count', { text: `${data.review.count.toLocaleString('ja-JP')}件のレビュー` }) : ''
      ),
      h('div.azr-price-block',
        h('span.azr-price', { text: yen(data.price) }),
        data.points ? h('span.azr-points', { text: `${data.points.toLocaleString('ja-JP')}ポイント還元` }) : ''
      ),
      data.coupons.length ? h('div.azr-item-coupons',
        h('div.azr-section-label', { text: 'このページで見つかったクーポン' }),
        h('ul', data.coupons.map((c) => h('li', { text: c.label })))
      ) : ''
    );

    const buybox = h('aside.azr-buybox',
      h('div.azr-buybox-price', { text: yen(data.price) }),
      data.points ? h('div.azr-buybox-points', { text: `${data.points.toLocaleString('ja-JP')}pt還元` }) : '',
      h('div.azr-buybox-slot')  // ここに元のカートフォームを移設する
    );

    const detail = h('section.azr-detail');
    if (data.descriptionNode) {
      detail.append(h('h2.azr-h2', { text: '商品説明' }), h('div.azr-detail-body'));
    }

    return h('div.azr-item-root', { id: 'azr-item-root' },
      h('div.azr-topbar',
        h('span.azr-brand', { text: 'Amazonize Rakuten' }),
        h('button.azr-toggle', {
          type: 'button',
          text: '元のページを表示 / 戻す',
          onclick: () => document.documentElement.classList.toggle('azr-simplified')
        })
      ),
      h('div.azr-grid', gallery, info, buybox),
      detail
    );
  }

  AZR.register('item', 'item-simplify', async () => {
    if (!AZR.settings.simplifyItem) return;

    // 価格が出るまで待つ（SPA的に後から描画されるため）
    await waitFor(() => harvestPrice(), { timeout: 6000 });

    const titleEl = pick(document, SEL.title);
    const price = harvestPrice();
    const title = titleEl?.textContent?.trim() || document.title.split('|')[0].trim();

    if (!title || !price) {
      AZR.warn('商品情報を取得できなかったため、元のページを表示します');
      AZR.unhide();
      return;
    }

    const data = {
      title,
      price,
      points: harvestPoints(),
      shop: harvestShop(),
      review: harvestReview(),
      images: harvestImages(),
      coupons: AZR.settings.couponList ? harvestItemCoupons() : [],
      cartForm: pick(document, SEL.cartForm),
      descriptionNode: pick(document, SEL.description)
    };
    AZR.log('harvested', data);

    const root = buildLayout(data);
    document.body.append(root);

    // 元のノードは「複製」ではなく「移設」する。イベントハンドラとトークンを壊さないため。
    const slot = root.querySelector('.azr-buybox-slot');
    if (data.cartForm) {
      slot.append(data.cartForm);
    } else {
      slot.append(h('button.azr-fallback-cart', {
        type: 'button',
        text: '購入エリアが見つかりません（元のページを表示）',
        onclick: () => document.documentElement.classList.remove('azr-simplified')
      }));
    }
    if (data.descriptionNode) {
      root.querySelector('.azr-detail-body')?.append(data.descriptionNode);
    }

    document.documentElement.classList.add('azr-simplified');
  });
})();
