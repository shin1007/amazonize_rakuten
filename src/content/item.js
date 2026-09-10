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
    // 店舗のクーポンバナーは「販売説明文」(.sale_desc) の中にある。商品説明だけでは取りこぼす。
    descriptions: '.sale_desc, .item_desc, #item_desc, [class*="ItemDescription"]',
    couponLink: 'a[href*="coupon.rakuten.co.jp"]',
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

  /** 楽天の画像URLは ?_ex=WxH で配信サイズを指定できる。既存のクエリは捨てる。 */
  const imageAt = (url, px) => (url || '').replace(/\?.*$/, '') + `?_ex=${px}x${px}`;
  const upscale = (url) => imageAt(url, 600);

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
      variants: (sku.variantSelectors || []).map((v) => v.label).filter(Boolean),
      review: reviewFromAppData(sku)
    };
  }

  /** レビューの件数・評価もJSONに入っている。DOMから数字を拾うより確実。 */
  function reviewFromAppData(sku) {
    const summary = sku?.itemReviewInfo?.summary;
    if (!summary) return null;
    const count = Number.isFinite(summary.itemReviewCount) ? summary.itemReviewCount : null;
    // float32で埋め込まれるので 4.699999809265137 のような値で来る
    const raw = summary.itemReviewRating;
    const score = Number.isFinite(raw) && raw > 0 ? Math.round(raw * 100) / 100 : null;
    if (!count && !score) return null;
    return {
      href: sku.shopId && sku.itemId
        ? `https://review.rakuten.co.jp/item/1/${sku.shopId}_${sku.itemId}/1.1/`
        : null,
      count,
      score
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
      variants: [],
      review: null
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

  /** 件数・評価はJSONを優先し、リンク先だけは実物のhrefを優先する。 */
  function mergeReview(fromJson, fromLink) {
    if (!fromJson && !fromLink) return null;
    const merged = {
      href: fromLink?.href || fromJson?.href || null,
      count: fromJson?.count ?? fromLink?.count ?? null,
      score: fromJson?.score ?? fromLink?.score ?? null
    };
    return merged.href || merged.count || merged.score ? merged : null;
  }

  /**
   * バナー画像のファイル名から割引を読む。
   * 例: 260904_alo_500off.jpg → 500円OFF / 260904_alo_10poff.jpg → 10%OFF
   */
  function labelFromImageName(src) {
    const file = (src || '').split('/').pop().split('?')[0];
    const pct = file.match(/(\d+)\s*(?:p|per|percent)[-_]?off/i);
    if (pct) return `${pct[1]}%OFFクーポン`;
    const off = file.match(/(\d+)\s*(?:yen|en)?[-_]?off/i);
    if (!off) return null;
    // 100円未満のクーポンはまず出回らないので、その桁は率の書き落としとみなす
    const n = Number(off[1]);
    return n < 100 ? `${n}%OFFクーポン` : `${n}円OFFクーポン`;
  }

  /** 店舗のクーポンは画像バナーだけのことが多い。文言 → alt → title → ファイル名の順に諦める。 */
  function couponLabelFrom(a) {
    const img = a.querySelector('img');
    const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
    const candidate = text || (img?.alt || '').trim() || (a.title || img?.title || '').trim();
    return (candidate || labelFromImageName(img?.src) || 'クーポンを獲得').slice(0, 60);
  }

  /** 同じクーポンを二重に出さないための鍵。getkeyがあればそれが一意。 */
  function couponKey(href) {
    const key = href.match(/[?&]getkey=([^&]+)/);
    return key ? `getkey:${key[1]}` : href.split('#')[0];
  }

  function harvestCoupons() {
    const out = [];
    const seen = new Set();
    const add = (key, coupon) => {
      if (!key || seen.has(key) || out.length >= 8) return;
      seen.add(key);
      out.push(coupon);
    };

    // 1) クーポンページへのリンク。文言が無いバナーもあるので、リンク先を手がかりにする。
    for (const a of document.querySelectorAll(SEL.couponLink)) {
      // ヘッダーの「myクーポン」は自分の保有一覧であって、この商品のクーポンではない
      if (/\/myCoupon/i.test(a.href)) continue;
      const label = couponLabelFrom(a);
      add(couponKey(a.href), {
        ...AZR.coupons.parseCoupon(label, { source: 'item-link' }),
        href: a.href,
        image: a.querySelector('img')?.src || null
      });
    }

    // 2) 文字で書かれたクーポン（楽天公式のクーポン枠など）
    for (const el of document.querySelectorAll('a, li, span, p')) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 60 || !/クーポン/.test(t)) continue;
      if (!/(OFF|オフ|円引|%|％|送料無料)/i.test(t)) continue;
      const c = AZR.coupons.parseCoupon(t, { source: 'item' });
      if (c.type === 'unknown') continue;
      add(`text:${t}`, { ...c, href: el.closest('a')?.href || null, image: null });
    }

    return out;
  }

  /**
   * 販売説明文と商品説明。どちらも店舗が自由に書くHTMLで、
   * クーポンバナーやセール告知は前者に入っていることが多い。
   */
  function harvestDescriptions() {
    const nodes = [];
    for (const el of document.querySelectorAll(SEL.descriptions)) {
      // 入れ子は親だけを移設する（同じ中身を二度出さない）
      if (nodes.some((n) => n.contains(el))) continue;
      nodes.push(el);
    }
    return nodes;
  }

  function priceLabel(data) {
    if (data.minPrice && data.maxPrice && data.maxPrice !== data.minPrice) {
      return `${yen(data.minPrice)}〜${yen(data.maxPrice)}`;
    }
    return yen(data.minPrice);
  }

  /** 4.7 なら星5つ分の94%を塗る。四捨五入せず半端な点も見た目に出す。 */
  function stars(score) {
    if (!score) return null;
    const pct = Math.max(0, Math.min(100, (score / 5) * 100));
    return h('span.azr-stars', { title: `5段階評価で ${score.toFixed(2)}` },
      h('span.azr-stars-fill', { style: { width: `${pct}%` }, text: '★★★★★' })
    );
  }

  /** 拡大表示。左右キー・ホイール・クリックで操作する。 */
  function buildLightbox(images, alt, onIndexChange) {
    let index = 0;
    let zoomed = false;

    const img = h('img.azr-lb-img', { alt });
    const counter = h('div.azr-lb-counter');
    const stage = h('div.azr-lb-stage', {
      // 画像そのものはズームの切り替え、周りの余白は閉じる
      onclick: (e) => (e.target === img ? toggleZoom(e) : close())
    }, img);

    const nav = (cls, label, delta) => h(`button.azr-lb-nav.${cls}`, {
      type: 'button',
      'aria-label': label,
      title: label,
      text: delta < 0 ? '‹' : '›',
      onclick: (e) => { e.stopPropagation(); step(delta); }
    });

    const multi = images.length > 1;
    const root = h('div.azr-lightbox', { hidden: 'hidden', role: 'dialog', 'aria-modal': 'true' },
      h('button.azr-lb-close', {
        type: 'button', 'aria-label': '閉じる', title: '閉じる (Esc)', text: '✕', onclick: () => close()
      }),
      multi ? nav('is-prev', '前の画像 (←)', -1) : '',
      stage,
      multi ? nav('is-next', '次の画像 (→)', 1) : '',
      multi ? counter : ''
    );

    function render() {
      img.src = imageAt(images[index], 1200);
      counter.textContent = `${index + 1} / ${images.length}`;
      setZoom(false);
      // 隣を先読みしておくと、左右キーを連打しても白いままにならない
      for (const i of [index + 1, index - 1]) {
        const src = images[(i + images.length) % images.length];
        if (src) new Image().src = imageAt(src, 1200);
      }
    }

    function setZoom(on, origin) {
      zoomed = on;
      img.classList.toggle('is-zoomed', on);
      img.style.transformOrigin = on && origin ? origin : '';
    }

    /** クリックした点を原点にして拡大する（見たい所が画面外へ逃げないように） */
    function toggleZoom(e) {
      if (zoomed) return setZoom(false);
      const r = img.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * 100;
      const y = ((e.clientY - r.top) / r.height) * 100;
      setZoom(true, `${x}% ${y}%`);
    }

    function step(delta) {
      if (!multi) return;
      index = (index + delta + images.length) % images.length;
      render();
      onIndexChange?.(index);
    }

    function open(at = 0) {
      index = Math.max(0, Math.min(images.length - 1, at));
      render();
      root.hidden = false;
      document.documentElement.classList.add('azr-lb-open');
      root.querySelector('.azr-lb-close').focus();
    }

    function close() {
      root.hidden = true;
      setZoom(false);
      document.documentElement.classList.remove('azr-lb-open');
    }

    root.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.deltaY < 0) toggleZoom(e);
      else setZoom(false);
    }, { passive: false });

    return { node: root, open, close, step, isOpen: () => !root.hidden, at: () => index };
  }

  /** 入力中の矢印キーは奪わない（購入エリアの数量欄やプルダウン） */
  function isTypingTarget(el) {
    if (!el) return false;
    return el.isContentEditable || /^(INPUT|SELECT|TEXTAREA|OPTION)$/.test(el.tagName);
  }

  function buildGallery(data) {
    const images = data.images.filter(Boolean);
    const gallery = h('div.azr-gallery');
    if (!images.length) return gallery;

    let index = 0;
    const main = h('img.azr-gallery-main', {
      src: upscale(images[0]), alt: data.title, loading: 'eager'
    });
    gallery.append(h('button.azr-gallery-frame', {
      type: 'button',
      'aria-label': '画像を拡大',
      title: 'クリックで拡大',
      onclick: () => lightbox.open(index)
    }, main, h('span.azr-zoom-hint', { text: 'クリックで拡大' })));

    const thumbs = images.slice(0, 9).map((src, i) => h('img.azr-thumb', {
      src: imageAt(src, 128),
      alt: '',
      class: i === 0 ? 'is-active' : '',
      onclick: () => select(i)
    }));
    if (thumbs.length > 1) gallery.append(h('div.azr-thumbs', thumbs));

    const lightbox = buildLightbox(images, data.title, (i) => select(i, true));
    gallery.append(lightbox.node);

    function select(i, fromLightbox = false) {
      index = (i + images.length) % images.length;
      main.src = upscale(images[index]);
      thumbs.forEach((t, n) => t.classList.toggle('is-active', n === index));
      // ライトボックス側から来た通知でまた開き直さない
      if (!fromLightbox && lightbox.isOpen() && lightbox.at() !== index) lightbox.open(index);
    }

    // 左右キー: 開いていれば拡大表示を、閉じていればメイン画像を送る
    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (!document.documentElement.classList.contains('azr-simplified')) return;

      if (lightbox.isOpen()) {
        if (e.key === 'Escape') lightbox.close();
        else if (e.key === 'ArrowLeft') lightbox.step(-1);
        else if (e.key === 'ArrowRight') lightbox.step(1);
        else return;
        return e.preventDefault();
      }
      if (isTypingTarget(e.target) || images.length < 2) return;
      if (e.key === 'ArrowLeft') select(index - 1);
      else if (e.key === 'ArrowRight') select(index + 1);
      else return;
      e.preventDefault();
    });

    return gallery;
  }

  // 獲得の結果を、そのまま行の文言にする
  const GRAB_LABEL = {
    acquired: '獲得しました',
    already: '獲得済みです',
    login: 'ログインしてください',
    rejected: '獲得できません',
    closed: '中止しました',
    timeout: '結果を確認できません',
    unknown: '結果を確認できません',
    error: '獲得できません'
  };

  // APIが返す理由コード。クーポン側の文言に寄せる。載っていないものは「獲得できません」。
  const REJECT_LABEL = {
    COUPON_NOT_FOUND: 'クーポンが見つかりません',
    COUPON_VALIDITY_PERIOD_OVER: '期間が終了しています',
    CAMPAIGN_VALIDITY_PERIOD_OVER: '期間が終了しています',
    COUPON_STATUS_FINISHED: '配布が終了しています',
    NOT_REGISTERED_MEMBER: '会員登録が必要です',
    PURCHASE_HISTORY_EXISTS: '対象外です'
  };

  const GRAB_TIMEOUT_MS = 50000; // service worker 側の打ち切りより必ず後にする

  /**
   * 獲得ページへ遷移せず、その場で獲得する。
   * 実際の獲得は service worker が行う（獲得ページと同じAPIを呼ぶ。
   * このAPIは商品ページのオリジンからは呼べないので、content script では代行できない）。
   */
  async function grabInPlace(link, status, url) {
    if (link.dataset.azrGrab === 'busy' || link.dataset.azrGrab === 'done') return;
    link.dataset.azrGrab = 'busy';
    status.textContent = '獲得中…';

    let res = null;
    try {
      res = await Promise.race([
        chrome.runtime.sendMessage({ type: 'azr:grabCoupon', url }),
        // service worker が落ちた場合に、行が「獲得中…」のまま固まらないようにする
        new Promise((r) => setTimeout(() => r({ ok: false, status: 'timeout' }), GRAB_TIMEOUT_MS))
      ]);
    } catch (e) {
      AZR.warn('クーポン獲得の依頼に失敗:', e);
    }

    const ok = Boolean(res?.ok);
    // 失敗した行は押し直せるようにしておく（ログイン後にもう一度など）
    link.dataset.azrGrab = ok ? 'done' : 'failed';
    status.textContent = res?.status === 'rejected'
      ? (REJECT_LABEL[res.reason] || GRAB_LABEL.rejected)
      : (GRAB_LABEL[res?.status] || GRAB_LABEL.error);
    // 訳し切れない理由コードは、確認できるようにマウスオーバーへ逃がす
    if (res?.reason) link.title = res.reason;
  }

  /**
   * クーポンの正式な内容をAPIから取り、行の文言を差し替える。
   * バナー画像のファイル名から推測した文言より、こちらが正しい。
   * 表示を待たせないため、行を出したあとに非同期で上書きする。
   */
  async function refineCoupon(link, textEl, status, url) {
    let d = null;
    try {
      d = await chrome.runtime.sendMessage({ type: 'azr:couponDetails', url });
    } catch (e) {
      AZR.warn('クーポン内容の取得に失敗:', e);
    }
    if (!d) return;

    if (d.name) {
      textEl.textContent = d.name;
      // 正式名称が取れたなら、裏取り用のバナーは要らない。名前に幅を回す。
      link.querySelector('.azr-coupon-thumb')?.remove();
    }
    if (d.acquired && link.dataset.azrGrab !== 'busy') {
      link.dataset.azrGrab = 'done';
      status.textContent = '獲得済みです';
    }
  }

  /** Amazon風のクーポン表示。押した場所から離れずに獲得できるようにする。 */
  function buildCoupons(coupons) {
    const row = (c) => {
      const textEl = h('span.azr-coupon-text', { text: c.label });
      const parts = [
        h('span.azr-coupon-badge', { text: 'クーポン' }),
        textEl,
        c.minSpend ? h('span.azr-coupon-cond', { text: `${yen(c.minSpend)}以上で利用可` }) : ''
      ];
      if (!c.href) return h('div.azr-coupon-link', parts);

      const status = h('span.azr-coupon-get', { text: '獲得する' });
      // hrefは残す。中クリックや「新しいタブで開く」を潰さないため。
      const link = h('a.azr-coupon-link', {
        href: c.href,
        target: '_blank',
        rel: 'noopener',
        title: 'このページのまま獲得します',
        onclick: (e) => {
          // 修飾キー付きのクリックは、本来の「別タブで開く」に任せる
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          grabInPlace(link, status, c.href);
        }
      },
        parts,
        // 文言をファイル名から推測した場合もあるので、現物のバナーも小さく添える
        c.image ? h('img.azr-coupon-thumb', { src: c.image, alt: '', loading: 'lazy' }) : '',
        status
      );
      refineCoupon(link, textEl, status, c.href);
      return link;
    };
    return h('section.azr-item-coupons',
      h('div.azr-section-label', { text: 'クーポン' }),
      h('ul', coupons.map((c) => h('li', row(c))))
    );
  }

  function buildLayout(data) {
    const gallery = buildGallery(data);

    const info = h('div.azr-info',
      h('h1.azr-title', { text: data.title }),
      h('a.azr-shop', { href: data.shop.url, text: data.shop.name }),
      data.review && h('a.azr-review', { href: data.review.href, target: '_blank', rel: 'noopener' },
        stars(data.review.score),
        data.review.score ? h('span.azr-score', { text: data.review.score.toFixed(2) }) : '',
        data.review.count ? h('span.azr-count', { text: `${data.review.count.toLocaleString('ja-JP')}件のレビュー` }) : ''
      ),
      h('div.azr-price-block', h('span.azr-price', { text: priceLabel(data) })),
      data.coupons.length ? buildCoupons(data.coupons) : '',
      data.variants.length ? h('div.azr-variants', {
        text: `選択項目: ${data.variants.join(' / ')}（右のボックスで選択）`
      }) : ''
    );

    const buybox = h('aside.azr-buybox',
      h('div.azr-buybox-price', { text: priceLabel(data) }),
      h('div.azr-buybox-slot')
    );

    // 商品説明は真ん中のペイン（商品情報）の末尾に置く
    if (data.descriptionNodes.length) {
      info.append(h('section.azr-detail',
        h('h2.azr-h2', { text: '商品説明' }),
        h('div.azr-detail-body')
      ));
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
      h('div.azr-grid', gallery, info, buybox)
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
      review: mergeReview(base.review, harvestReview()),
      coupons: AZR.settings.couponList ? harvestCoupons() : [],
      descriptionNodes: harvestDescriptions()
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
    const detailBody = root.querySelector('.azr-detail-body');
    for (const node of data.descriptionNodes) detailBody?.append(node);

    document.documentElement.classList.add('azr-simplified');
    AZR.unhide();
  });
})();
