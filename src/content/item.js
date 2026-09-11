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
    // 商品レビューに限る。店舗ヘッダーのショップレビュー（/shop/）を拾うと、店舗の評価を商品の評価として出してしまう。
    reviewLink: ['a[href*="review.rakuten.co.jp/item/"]']
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

  /**
   * 楽天の画像は同じファイルを複数のホストから配っている。
   *   image.rakuten.co.jp/<店>/cabinet/…  = tshop.r10s.jp/<店>/cabinet/…
   *   www.rakuten.ne.jp/gold/<店>/…       = tshop.r10s.jp/gold/<店>/…
   *   thumbnail.image.rakuten.co.jp/@0_mall/… , /@0_gold/… も同じ
   * このうち縮小配信（?_ex=WxH）とCORSに応じるのは tshop.r10s.jp だけなので、そこへ寄せる。
   * 楽天以外のホストは null（縮小も比較もできない）。
   */
  function cdnPath(url) {
    let u;
    try { u = new URL(url, location.href); } catch { return null; }
    switch (u.host) {
      case 'tshop.r10s.jp':
      case 'image.rakuten.co.jp':
        return u.pathname;
      case 'thumbnail.image.rakuten.co.jp':
        return u.pathname.replace(/^\/@0_mall\//, '/').replace(/^\/@0_gold\//, '/gold/');
      case 'www.rakuten.ne.jp':
        return u.pathname.startsWith('/gold/') ? u.pathname : null;
      default:
        return null;
    }
  }

  /** 同じ画像かどうかの鍵。ホストとクエリの違いは同じ画像とみなす。 */
  const imageKey = (url) => cdnPath(url) || (url || '').split(/[?#]/)[0];

  /** 指定の大きさ（正方形の枠に収める。拡大はしない）で配信させる */
  const imageAt = (url, px) => {
    const path = cdnPath(url);
    return path ? `https://tshop.r10s.jp${path}?_ex=${px}x${px}` : url;
  };

  /**
   * 縮小配信は縦に極端に長い画像だと失敗する（780x10810 などで 597 が返る）。
   * 失敗の本文は 1x1 のSVG（「404.gif から作った」と書いてある）で、画像としては
   * 読み込めてしまうので onerror は来ない。1x1 に見えたら失敗とみなす。
   */
  const isPlaceholder = (img) => img.naturalWidth <= 1 && img.naturalHeight <= 1;

  /** 縮小版を出し、失敗したら原寸を読む。原寸のホストはCORSを返さないので crossorigin は外す。 */
  function setSrc(img, url, original) {
    const fallback = () => {
      img.onerror = img.onload = null;
      img.removeAttribute('crossorigin');
      img.src = original;
    };
    img.onerror = url === original ? null : fallback;
    img.onload = url === original ? null : () => { if (isPlaceholder(img)) fallback(); };
    img.src = url;
  }

  // 縦長の説明画像（LPを1枚にしたもの）。正方形に縮めると読めないので扱いを変える。
  const TALL_RATIO = 2;

  /** ギャラリーの1枚。縦長（tall）は縮小版ではなく原寸で見せる。 */
  const galleryItem = (src) => ({ src, tall: false });
  const mainUrl = (it) => (it.tall ? it.src : imageAt(it.src, 600));
  const fullUrl = (it) => (it.tall ? it.src : imageAt(it.src, 1200));

  function fromAppData(app) {
    const sku = app?.api?.data?.itemInfoSku ?? app?.newApi?.itemInfoSku;
    if (!sku) return null;

    const priceInfo = sku.purchaseInfo?.purchaseBySellType?.normalPurchase?.price;
    const images = (sku.media?.images ?? sku.pcFields?.images ?? [])
      .map((im) => (typeof im === 'string' ? im : im.location))
      .filter(Boolean);

    return {
      // 商品名に <br> を入れる店舗がある（textContent で出すので、そのまま文字で見えてしまう）
      title: (sku.title || '').replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim(),
      minPrice: priceInfo?.minPrice ?? null,
      maxPrice: priceInfo?.maxPrice ?? null,
      // フローティングクーポンの問い合わせに使う（定期購入の無い商品では定期購入専用クーポンを除く）
      // 楽天のバンドルと同じく、空のオブジェクトは「無い」とみなす
      hasSubscription: Object.keys(sku.purchaseInfo?.purchaseBySellType?.subscriptionPurchase || {}).length > 0,
      images,
      video: videoFromAppData(sku),
      itemId: sku.itemId || null,
      shop: {
        id: sku.shopId || null,
        code: app.shop?.shopUrl || '',
        name: app.shop?.shopName || '',
        url: `https://www.rakuten.co.jp/${app.shop?.shopUrl || ''}/`
      },
      variants: (sku.variantSelectors || []).map((v) => v.label).filter(Boolean),
      review: reviewFromAppData(sku),
      // 商品説明文 → 販売説明文 の順（元のページと同じ並び）
      descriptionHtml: [
        sku.pcFields?.productDescription || sku.newProductDescription,
        sku.salesDescription
      ].filter((s) => typeof s === 'string' && s.trim())
    };
  }

  /**
   * 商品動画。JSONにあるのは静止画と縦横比だけで、プレーヤーは楽天の動画スクリプトが
   * 元のページの画像欄（.item-pc-movie-<番号>）に後から描く。それを移設して使う（mountVideo）。
   */
  function videoFromAppData(sku) {
    const p = sku?.video?.parameters;
    if (!p) return null;
    const [w, hgt] = String(p.aspectRatioStr || '').split(':').map(Number);
    return {
      still: p.stillUrl || p.thumbnailUrl || '',
      name: p.name || '',
      ratio: w > 0 && hgt > 0 ? `${w} / ${hgt}` : '16 / 9'
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
    const code = location.pathname.split('/').filter(Boolean)[0] || '';

    return {
      title: nameArea?.textContent?.trim()
        || document.querySelector('meta[itemprop="name"]')?.content
        || document.title.replace(/^【楽天市場】/, '').split('：')[0].trim(),
      minPrice: parseYen(priceEl?.textContent)
        || parseYen(document.querySelector('[itemprop="price"]')?.getAttribute('content')),
      maxPrice: null,
      images: metaImages,
      video: null,
      itemId: null,
      shop: { id: null, code, name: code, url: `https://www.rakuten.co.jp/${code}/` },
      variants: [],
      review: null,
      descriptionHtml: []
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
    // 自分で出したクーポン欄は拾わない（拾い直すときにはもうページにある）
    const ours = (el) => el.closest('.azr-item-coupons');

    for (const a of document.querySelectorAll(SEL.couponLink)) {
      // ヘッダーの「myクーポン」は自分の保有一覧であって、この商品のクーポンではない
      if (/\/myCoupon/i.test(a.href) || ours(a)) continue;
      const label = couponLabelFrom(a);
      add(couponKey(a.href), {
        ...AZR.coupons.parseCoupon(label, { source: 'item-link' }),
        href: a.href,
        image: a.querySelector('img')?.src || null
      });
    }

    // 2) 文字で書かれたクーポン（楽天公式のクーポン枠など）
    for (const el of document.querySelectorAll('a, li, span, p')) {
      if (ours(el)) continue;
      // 店舗のお知らせは末尾に掲載日が付く（「3日前」「2026/07/23」）
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim()
        .replace(/\s*(\d+(分|時間|日)前|\d{4}\/\d{1,2}\/\d{1,2})$/, '');
      if (!t || t.length > 60 || !/クーポン/.test(t)) continue;
      if (!/(OFF|オフ|円引|%|％|送料無料)/i.test(t)) continue;
      const c = AZR.coupons.parseCoupon(t, { source: 'item' });
      if (c.type === 'unknown') continue;
      const href = el.closest('a')?.href || null;
      // 同じリンクの中の div と span（日付の有無だけ違う）を2行に数えない
      add(href ? couponKey(href) : `text:${t}`, { ...c, href, image: null });
    }

    return out;
  }

  /**
   * 商品説明文と販売説明文。どちらも店舗が自由に書くHTML。
   *
   * DOMの .sale_desc / .item_desc からは取らない。店舗のHTMLには
   * 「閉じタグ」（楽天のテンプレートの span/td を先に閉じるもの）が入っていることがあり、
   * 中身の大半が入れ物の外へこぼれる。実際に .sale_desc には <style> しか残らず、
   * LPの画像17枚は隣の div にあった。JSONの文字列から組み立てれば、この崩れを受けない。
   * scriptは実行されないが、念のため取り除く。
   */
  function descriptionFromHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const s of doc.querySelectorAll('script')) s.remove();
    return h('div.azr-desc-part', Array.from(doc.body.childNodes));
  }

  /** 店舗が説明に貼った動画も勝手に再生させない（YouTube などの埋め込みは autoplay=1 を落とす） */
  function disarmAutoplay(root) {
    for (const m of root.querySelectorAll('video[autoplay], audio[autoplay]')) {
      m.removeAttribute('autoplay');
      m.pause();
      m.controls = true; // 自動再生まかせで操作バーを付けていないことがある
    }
    for (const f of root.querySelectorAll('iframe[src*="autoplay=1"]')) {
      f.setAttribute('src', f.getAttribute('src').replace(/([?&])autoplay=1/g, '$1autoplay=0'));
    }
  }

  /** JSONに説明が無いページ用。DOMのものを移設する。 */
  function harvestDescriptions() {
    const nodes = [];
    for (const el of document.querySelectorAll(SEL.descriptions)) {
      // 入れ子は親だけを移設する（同じ中身を二度出さない）
      if (nodes.some((n) => n.contains(el))) continue;
      nodes.push(el);
    }
    return nodes;
  }

  /* 説明の画像を左のギャラリーへ -------------------------------------------------
   * 店舗は商品説明にも画像を並べる（LPを分割したもの）。これを左に寄せ、
   * 同じ画像はまとめて1枚にする。同じかどうかは2段階で見る。
   *   1. URL: ホストとクエリを除いたパスが同じ（説明文と販売説明文に同じバナー、など）
   *   2. 見た目: 縮小版から作った指紋（dHash）が近く、縦横比も同じ
   *      （同じ画像を別名で上げ直したもの。ファイル名だけでは分からない）
   * 残すもの: リンクの付いた画像（他の商品やクーポンへの導線）、細長い帯（ボタン・見出しバナー）、
   *           小さい画像（アイコン）、楽天以外のホストの画像。これらは説明に置いたままにする。
   */
  const PROBE_PX = 300;         // 選別用に読む大きさ。これより小さければ原寸も小さい。
  const MIN_SIDE = 200;         // 長辺がこれ未満はアイコンとみなす
  const MAX_WIDE_RATIO = 3;     // 横/縦がこれを超える帯はボタンや見出し
  const HASH_DISTANCE = 6;      // 64bit中この数までの違いは同じ画像
  const PROBE_TIMEOUT_MS = 8000;

  /** 画像の指紋（dHash）。9x8 に縮めて、横に隣り合う画素の明暗を64bitにする。 */
  function dHash(img) {
    // 一気に 9x8 へ縮めると間引きで揺れるので、36x32 で読んでから 4x4 ずつ平均する
    const W = 36, H = 32;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, W, H);
    let data;
    try {
      data = ctx.getImageData(0, 0, W, H).data;
    } catch {
      return null; // CORSで読めない（楽天以外のホスト）
    }
    const gray = [];
    for (let by = 0; by < 8; by++) {
      for (let bx = 0; bx < 9; bx++) {
        let sum = 0;
        for (let y = by * 4; y < by * 4 + 4; y++) {
          for (let x = bx * 4; x < bx * 4 + 4; x++) {
            const i = (y * W + x) * 4;
            sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
          }
        }
        gray.push(sum);
      }
    }
    let bits = '';
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) bits += gray[y * 9 + x] < gray[y * 9 + x + 1] ? '1' : '0';
    }
    // 無地に近い画像は指紋が似通うので比べない
    const ones = bits.split('1').length - 1;
    return ones < 4 || ones > 60 ? null : bits;
  }

  const hamming = (a, b) => {
    let d = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
    return d;
  };

  /**
   * 縮小版を読んで、大きさと指紋を取る。
   * 縮小に失敗する巨大な画像は原寸で大きさだけ取る（CORSが無いので指紋は無し）。
   */
  function probe(url, px) {
    return new Promise((resolve) => {
      const img = new Image();
      const resized = imageAt(url, px);
      let original = resized === url;
      const timer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS);
      img.onload = () => {
        if (isPlaceholder(img)) return img.onerror();
        clearTimeout(timer);
        const w = img.naturalWidth;
        const hgt = img.naturalHeight;
        // 縮小版は枠(px)に収めただけで拡大はしないので、長辺が MIN_SIDE(<px) 未満なら原寸も小さい
        resolve({ w, h: hgt, big: Math.max(w, hgt) >= MIN_SIDE, hash: original ? null : dHash(img) });
      };
      img.onerror = () => {
        if (original) { clearTimeout(timer); return resolve(null); }
        original = true;
        img.removeAttribute('crossorigin');
        img.src = url;
      };
      // tshop.r10s.jp は商品ページのオリジンにCORSを返すので、画素を読める
      if (!original) img.crossOrigin = 'anonymous';
      img.src = resized;
    });
  }

  /** 画像の実際のURL。遅延読み込みの店舗HTMLは data-src に本物を置いている。 */
  const imgSource = (img) =>
    img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('src') || '';

  /**
   * 説明の画像のうち、ギャラリーへ移す候補を選び、読み込みを止めておく。
   * 見えないまま原寸（1枚で1MBを超えるものもある）を読ませないため、src を外す。
   */
  function takeCandidates(parts) {
    const out = [];
    for (const part of parts) {
      for (const img of part.querySelectorAll('img')) {
        const src = imgSource(img);
        if (!src || !cdnPath(src) || img.closest('a[href]')) continue;
        img.dataset.azrSrc = src;
        img.removeAttribute('src');
        img.removeAttribute('srcset');
        img.classList.add('azr-desc-pending');
        out.push({ img, src });
      }
    }
    return out;
  }

  /** 候補を説明に戻す（ギャラリーに向かないと分かったもの） */
  function restore(img) {
    img.src = img.dataset.azrSrc;
    img.classList.remove('azr-desc-pending');
  }

  /** 説明から画像を抜いたあと、画像の直後の改行が縦の空白として残らないようにする */
  function removeImage(img) {
    let next = img.nextSibling;
    while (next && next.nodeType === Node.TEXT_NODE && !next.textContent.trim()) next = next.nextSibling;
    if (next?.nodeName === 'BR') next.remove();
    img.remove();
  }

  /**
   * ギャラリーの画像と説明の候補を突き合わせ、候補を「移す / 同じなので消す / 残す」に分ける。
   * 並びはギャラリー（楽天に登録された商品画像）が先。重複したら先にあるほうを残す。
   */
  async function sortDescriptionImages(galleryItems, candidates) {
    const [galleryProbes, candidateProbes] = await Promise.all([
      // 動画の静止画は説明の画像と重なることが無いので読まない
      Promise.all(galleryItems.map((it) => (it.video ? null : probe(it.src, 120)))),
      Promise.all(candidates.map((c) => probe(c.src, PROBE_PX)))
    ]);

    const kept = []; // { key, hash, ratio }
    const seen = (key, p) => kept.find((k) => k.key === key
      || (p?.hash && k.hash && Math.abs(k.ratio / (p.w / p.h) - 1) < 0.05 && hamming(k.hash, p.hash) <= HASH_DISTANCE));
    const remember = (key, p) => kept.push({ key, hash: p?.hash || null, ratio: p ? p.w / p.h : 1 });

    galleryItems.forEach((it, i) => {
      const p = galleryProbes[i];
      if (p) it.tall = p.h / p.w > TALL_RATIO;
      remember(imageKey(it.src), p);
    });

    const moved = [];
    const dropped = [];
    const left = [];
    candidates.forEach((c, i) => {
      const p = candidateProbes[i];
      const key = imageKey(c.src);
      const same = seen(key, p);
      if (same) {
        dropped.push({ src: c.src, sameAs: same.key });
        return removeImage(c.img);
      }
      const why = !p ? '読めない' : !p.big ? '小さい' : p.w / p.h > MAX_WIDE_RATIO ? '横長の帯' : null;
      if (why) {
        left.push({ src: c.src, why });
        return restore(c.img);
      }
      remember(key, p);
      moved.push({ src: c.src, tall: p.h / p.w > TALL_RATIO });
      removeImage(c.img);
    });
    return { moved, dropped, left };
  }

  /** 画像を抜いた結果、文字も画像も無くなった説明は見出しごと隠す */
  function isEmptyDescription(body) {
    const clone = body.cloneNode(true);
    for (const s of clone.querySelectorAll('style, link')) s.remove();
    return !clone.textContent.trim() && !clone.querySelector('img, iframe, video, table');
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

  /**
   * 拡大表示。左右キー・ホイール・クリックで操作する。
   * items はギャラリーと共有する配列で、説明の画像があとから足される。
   * 縦長の画像は幅に合わせて縦にスクロールさせる（ホイールはズームではなくスクロール）。
   * 動画は静止画だけを出し、押すと閉じる（ギャラリーはもう動画を選んでいるので、そこで再生する）。
   */
  function buildLightbox(items, alt, onIndexChange) {
    let index = 0;
    let zoomed = false;

    const img = h('img.azr-lb-img', { alt });
    const counter = h('div.azr-lb-counter');
    const stage = h('div.azr-lb-stage', {
      // 画像そのものはズームの切り替え、周りの余白は閉じる
      onclick: (e) => (e.target === img && !current().video ? toggleZoom(e) : close())
    }, img);

    const nav = (cls, label, delta) => h(`button.azr-lb-nav.${cls}`, {
      type: 'button',
      'aria-label': label,
      title: label,
      text: delta < 0 ? '‹' : '›',
      onclick: (e) => { e.stopPropagation(); step(delta); }
    });

    const root = h('div.azr-lightbox', { hidden: 'hidden', role: 'dialog', 'aria-modal': 'true' },
      h('button.azr-lb-close', {
        type: 'button', 'aria-label': '閉じる', title: '閉じる (Esc)', text: '✕', onclick: () => close()
      }),
      nav('is-prev', '前の画像 (←)', -1),
      stage,
      nav('is-next', '次の画像 (→)', 1),
      counter
    );

    const current = () => items[index];

    function render() {
      const it = current();
      setSrc(img, fullUrl(it), it.src);
      img.classList.toggle('is-tall', it.tall);
      stage.classList.toggle('is-tall', it.tall);
      stage.classList.toggle('is-video', Boolean(it.video));
      img.title = it.video ? 'クリックで動画に戻る' : '';
      stage.scrollTop = 0;
      counter.textContent = `${index + 1} / ${items.length}`;
      root.classList.toggle('is-single', items.length < 2);
      setZoom(false);
      // 隣を先読みしておくと、左右キーを連打しても白いままにならない
      for (const i of [index + 1, index - 1]) {
        const next = items[(i + items.length) % items.length];
        if (next && !next.tall) new Image().src = fullUrl(next);
      }
    }

    function setZoom(on, origin) {
      zoomed = on;
      img.classList.toggle('is-zoomed', on);
      img.style.transformOrigin = on && origin ? origin : '';
    }

    /** クリックした点を原点にして拡大する（見たい所が画面外へ逃げないように） */
    function toggleZoom(e) {
      if (current().tall || current().video) return; // 縦長は原寸を幅いっぱいで出しているので、拡大は要らない
      if (zoomed) return setZoom(false);
      const r = img.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * 100;
      const y = ((e.clientY - r.top) / r.height) * 100;
      setZoom(true, `${x}% ${y}%`);
    }

    function step(delta) {
      if (items.length < 2) return;
      index = (index + delta + items.length) % items.length;
      render();
      onIndexChange?.(index);
    }

    function open(at = 0) {
      index = Math.max(0, Math.min(items.length - 1, at));
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
      if (current()?.tall) return; // 縦長はスクロールさせる
      e.preventDefault();
      if (e.deltaY < 0) toggleZoom(e);
      else setZoom(false);
    }, { passive: false });

    return {
      node: root, open, close, step,
      isOpen: () => !root.hidden,
      at: () => index,
      // 画像が足されたら枚数の表示と前後ボタンだけ合わせる（見ている画像はそのまま）
      refresh: () => {
        counter.textContent = `${index + 1} / ${items.length}`;
        root.classList.toggle('is-single', items.length < 2);
      }
    };
  }

  /** 入力中の矢印キーは奪わない（購入エリアの数量欄やプルダウン、動画の操作バーの早送り） */
  function isTypingTarget(el) {
    if (!el) return false;
    return el.isContentEditable || /^(INPUT|SELECT|TEXTAREA|OPTION|VIDEO|AUDIO)$/.test(el.tagName);
  }

  /**
   * 左ペイン。items は楽天に登録された商品画像で始まり、
   * 商品説明から移した画像があとから add() で足される。
   * 動画（it.video）を選ぶと、画像の枠の代わりに動画の枠（videoSlot）を出す。
   * プレーヤーは後から mountVideo が入れる。それまでは静止画を出しておく。
   */
  function buildGallery(items, title) {
    const gallery = h('div.azr-gallery');
    if (!items.length) return { node: gallery, overlay: '', items, add: () => {}, videoSlot: null };

    let index = 0;
    const main = h('img.azr-gallery-main', { alt: title, loading: 'eager' });
    const frame = h('button.azr-gallery-frame', {
      type: 'button',
      'aria-label': '画像を拡大',
      title: 'クリックで拡大',
      onclick: () => lightbox.open(index)
    }, main, h('span.azr-zoom-hint', { text: 'クリックで拡大' }));
    const video = items.find((it) => it.video)?.video;
    const videoSlot = video
      ? h('div.azr-gallery-video', { hidden: 'hidden' },
        h('img.azr-gallery-video-still', { src: video.still, alt: video.name }),
        h('span.azr-gallery-video-status', { text: '動画を読み込み中…' }))
      : null;
    // カスタムプロパティは style への代入では入らない
    videoSlot?.style.setProperty('--azr-video-ratio', video.ratio);
    gallery.append(frame, videoSlot || '');

    // 枚数が多い（説明の画像を足すと40枚を超える）ので、全部並べて枠の中でスクロールさせる
    const thumbBox = h('div.azr-thumbs');
    const thumbs = [];
    gallery.append(thumbBox);

    function thumb(it, i) {
      if (it.video) {
        return h('span.azr-thumb.is-video', { title: it.video.name || '動画', onclick: () => select(i) },
          h('img', { src: it.src, alt: '', loading: 'lazy' }));
      }
      const t = h('img.azr-thumb', { alt: '', loading: 'lazy', onclick: () => select(i) });
      t.classList.toggle('is-tall', it.tall);
      setSrc(t, imageAt(it.src, 128), it.src);
      return t;
    }

    function renderThumbs(from) {
      for (let i = from; i < items.length; i++) thumbs.push(thumb(items[i], i));
      thumbBox.append(...thumbs.slice(from));
      thumbBox.hidden = items.length < 2;
      thumbs.forEach((t, n) => t.classList.toggle('is-active', n === index));
    }

    // ライトボックスはギャラリーの外（ルート直下）に置く。左ペインは sticky で重なりの文脈を作るので、
    // 中に置くと z-index が閉じ込められ、移設した購入エリアのボタンが上に透けて出る。
    const lightbox = buildLightbox(items, title, (i) => select(i, true));

    function select(i, fromLightbox = false) {
      index = (i + items.length) % items.length;
      const it = items[index];
      // 動画の枠を隠すと、プレーヤーは見えなくなったとみなして自分で止まる
      frame.hidden = Boolean(it.video);
      if (videoSlot) videoSlot.hidden = !it.video;
      main.classList.toggle('is-tall', it.tall);
      if (!it.video) setSrc(main, mainUrl(it), it.src);
      thumbs.forEach((t, n) => t.classList.toggle('is-active', n === index));
      revealThumb(thumbs[index]);
      // ライトボックス側から来た通知でまた開き直さない
      if (!fromLightbox && lightbox.isOpen() && lightbox.at() !== index) lightbox.open(index);
    }

    /** 選んだサムネイルを枠の中で見える位置へ。scrollIntoView はページごと動かすので使わない。 */
    function revealThumb(t) {
      if (!t) return;
      const top = t.offsetTop; // .azr-thumbs が基準（position: relative）
      if (top < thumbBox.scrollTop) thumbBox.scrollTop = top;
      else if (top + t.offsetHeight > thumbBox.scrollTop + thumbBox.clientHeight) {
        thumbBox.scrollTop = top + t.offsetHeight - thumbBox.clientHeight;
      }
    }

    function add(more) {
      const from = items.length;
      items.push(...more);
      renderThumbs(from);
      lightbox.refresh();
      // 最初からある画像も、縦長かどうかは読んでみて初めて分かる
      thumbs.forEach((t, n) => t.classList.toggle('is-tall', items[n].tall));
      if (items[index].tall !== main.classList.contains('is-tall')) select(index);
    }

    renderThumbs(0);
    select(0);

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
      if (isTypingTarget(e.target) || items.length < 2) return;
      if (e.key === 'ArrowLeft') select(index - 1);
      else if (e.key === 'ArrowRight') select(index + 1);
      else return;
      e.preventDefault();
    });

    return { node: gallery, overlay: lightbox.node, items, add, videoSlot };
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

  // 獲得したクーポンの履歴（ポップアップに出す）に添える、どの商品ページで獲得したか
  let grabContext = { shop: '', item: '', url: '' };

  /**
   * 獲得ページへ遷移せず、その場で獲得する。
   * 実際の獲得は service worker が行う（獲得ページと同じAPIを呼ぶ。
   * このAPIは商品ページのオリジンからは呼べないので、content script では代行できない）。
   * auto は、押されずに自動で獲得したもの（履歴で見分けるため）。
   */
  async function grabInPlace(link, status, request, { auto = false } = {}) {
    if (link.dataset.azrGrab === 'busy' || link.dataset.azrGrab === 'done') return null;
    link.dataset.azrGrab = 'busy';
    status.textContent = '獲得中…';

    // 名前は押した時点のもの（APIから正式名称が取れていれば、それに差し替わっている）
    const name = link.querySelector('.azr-coupon-text')?.textContent || '';
    const record = { ...grabContext, name, auto };

    let res = null;
    try {
      res = await Promise.race([
        chrome.runtime.sendMessage({ ...request, record }),
        // service worker が落ちた場合に、行が「獲得中…」のまま固まらないようにする
        new Promise((r) => setTimeout(() => r({ ok: false, status: 'timeout' }), GRAB_TIMEOUT_MS))
      ]);
    } catch (e) {
      AZR.warn('クーポン獲得の依頼に失敗:', e);
    }

    showGrabResult(link, status, res);
    return res;
  }

  /** 獲得の結果を行に書く。行を作り直したときにも、同じ結果をそのまま写せるように分けてある。 */
  function showGrabResult(link, status, res) {
    // 失敗した行は押し直せるようにしておく（ログイン後にもう一度など）
    link.dataset.azrGrab = res?.ok ? 'done' : 'failed';
    status.textContent = res?.status === 'rejected'
      ? (REJECT_LABEL[res.reason] || GRAB_LABEL.rejected)
      : (GRAB_LABEL[res?.status] || GRAB_LABEL.error);
    // 訳し切れない理由コードは、確認できるようにマウスオーバーへ逃がす
    if (res?.reason) link.title = res.reason;
  }

  /* 自動獲得 ----------------------------------------------------------------
   * 押さなくても、商品ページを開いた時点で獲得する。
   * 押したときと違って裏タブは開かない（apiOnly）。ページを開いただけでタブが増えたり、
   * ログイン画面が勝手に前へ出たりしないようにする。APIで決着しない分は行に「獲得する」が残る。
   */
  const autoGrabbed = new Map(); // クーポンの鍵 → 獲得の約束。同じクーポンを二度は獲得しない。
  let autoGrabStopped = false;

  async function autoGrab(rows) {
    if (!AZR.settings.couponAutoGrab) return;
    for (const { key, link, status, run } of rows) {
      const already = autoGrabbed.get(key);
      if (already) {
        // クーポンを拾い直して行を作り直した場合。獲得はもう済んでいるので、結果だけ写す。
        already.then((res) => { if (res) showGrabResult(link, status, res); });
        continue;
      }
      if (autoGrabStopped) return;
      // 楽天の獲得APIを一度に叩かないよう、1枚ずつ順に獲得する
      const grabbing = run();
      autoGrabbed.set(key, grabbing);
      const res = await grabbing;
      if (res?.status !== 'login') continue;
      // 未ログインなら残りも同じ結果になる。押せば獲得ページ（＝ログイン）へ進めるので、
      // 行は「獲得する」に戻したうえで、自動での獲得はここで止める。
      autoGrabStopped = true;
      autoGrabbed.delete(key);
      link.dataset.azrGrab = '';
      status.textContent = '獲得する';
      link.title = 'このページのまま獲得します';
      return;
    }
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
    if (d.acquired && !link.dataset.azrGrab) {
      link.dataset.azrGrab = 'done';
      status.textContent = '獲得済みです';
    }
  }

  /** service worker が返したフローティングクーポンを、クーポン欄の1行の形にする */
  function fromFloating(f) {
    const cond = [
      f.discount,
      f.minSpend ? `${yen(f.minSpend)}以上` : '',
      f.minUnits ? `${f.minUnits}個以上` : '',
      f.salesMethod === 'normal' ? '通常購入限定' : f.salesMethod === 'subscription' ? '定期購入限定' : ''
    ].filter(Boolean).join('・');
    return { floating: true, getKey: f.getKey, label: f.name || f.discount, cond, acquired: f.acquired };
  }

  /**
   * フローティングクーポンの行。獲得ページのURLが無いので、元のページの枠と同じAPIで獲得する。
   * リンク先が無いため a[href] にはせず、キーボードでも押せるボタンとして作る。
   */
  function floatingRow(c, auto) {
    const status = h('span.azr-coupon-get', { text: c.acquired ? '獲得済みです' : '獲得する' });
    const grab = (opts) => grabInPlace(link, status, { type: 'azr:grabFloatingCoupon', getKey: c.getKey }, opts);
    const link = h('a.azr-coupon-link', {
      role: 'button',
      tabindex: '0',
      title: 'このページのまま獲得します',
      onclick: (e) => { e.preventDefault(); grab(); },
      onkeydown: (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        grab();
      }
    },
      h('span.azr-coupon-badge', { text: 'クーポン' }),
      h('span.azr-coupon-text', { text: c.label, title: c.label }),
      c.cond ? h('span.azr-coupon-cond', { text: c.cond }) : '',
      status
    );
    if (c.acquired) link.dataset.azrGrab = 'done';
    else auto.push({ key: `getkey:${c.getKey}`, link, status, run: () => grab({ auto: true }) });
    return link;
  }

  /** Amazon風のクーポン表示。押した場所から離れずに獲得できるようにする。 */
  function buildCoupons(coupons) {
    const auto = []; // 自動で獲得する行（作った順に、1枚ずつ獲得する）
    const row = (c) => {
      if (c.floating) return floatingRow(c, auto);
      const textEl = h('span.azr-coupon-text', { text: c.label });
      const parts = [
        h('span.azr-coupon-badge', { text: 'クーポン' }),
        textEl,
        c.minSpend ? h('span.azr-coupon-cond', { text: `${yen(c.minSpend)}以上で利用可` }) : ''
      ];
      if (!c.href) return h('div.azr-coupon-link', parts);

      // 獲得ページ（getkey付き）でなければ、ここでは獲得できない。
      // 店舗のお知らせ（「レビュー投稿でクーポン」「SALE×クーポンで最大40%OFF」など）は
      // 店舗のページへのリンクで、押しても獲得は起きない。「獲得する」と見せずに、そのページを開く。
      if (!/[?&]getkey=/.test(c.href)) {
        return h('a.azr-coupon-link', { href: c.href, target: '_blank', rel: 'noopener' },
          parts,
          h('span.azr-coupon-get', { text: '詳しく見る' })
        );
      }

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
          grabInPlace(link, status, { type: 'azr:grabCoupon', url: c.href });
        }
      },
        parts,
        // 文言をファイル名から推測した場合もあるので、現物のバナーも小さく添える
        c.image ? h('img.azr-coupon-thumb', { src: c.image, alt: '', loading: 'lazy' }) : '',
        status
      );
      refineCoupon(link, textEl, status, c.href);
      auto.push({ key: couponKey(c.href), link, status, run: () => grabInPlace(link, status, { type: 'azr:grabCoupon', url: c.href, apiOnly: true }, { auto: true }) });
      return link;
    };
    const section = h('section.azr-item-coupons',
      h('div.azr-section-label', { text: 'クーポン' }),
      h('ul', coupons.map((c) => h('li', row(c))))
    );
    autoGrab(auto);
    return section;
  }

  /*
   * 右ペインのショップ欄。店舗は決まった場所にロゴを2種類置いている（楽天自身もここを読む）。
   *   /<店>/logo/logo1.jpg  正方形のアイコン（960x960）
   *   /<店>/logo/logo2.jpg  横長のロゴ（960x160）
   * 無い店舗は 404 になるので、読めなかったものは消して店舗名の文字で代える。
   */
  const shopLogoUrl = (code, n) => `https://tshop.r10s.jp/${code}/logo/logo${n}.jpg`;
  const shopReviewUrl = (id) => `https://review.rakuten.co.jp/shop/4/${id}_${id}/1.1/`;

  function loadOrDrop(img, url, px, onFail) {
    img.onerror = () => {
      img.onerror = img.onload = null;
      img.remove();
      onFail?.();
    };
    img.onload = () => { if (isPlaceholder(img)) img.onerror(); };
    img.src = imageAt(url, px);
  }

  /**
   * 商品の評価点とショップの評価は、商品ページのどこにも無い（JSONは件数だけ）。
   * service worker に商品レビューのページから両方まとめて取ってもらう。
   */
  async function fetchRatings(data) {
    if (!data.shop.id) return null;
    try {
      return await chrome.runtime.sendMessage({ type: 'azr:reviewRatings', shopId: data.shop.id, itemId: data.itemId });
    } catch (e) {
      AZR.warn('評価の取得に失敗:', e);
      return null;
    }
  }

  function fillShopRating(link, r) {
    if (!r?.score) return;
    link.append(
      h('span.azr-shop-rating-label', { text: 'ショップ評価' }),
      stars(r.score),
      h('span.azr-score', { text: r.score.toFixed(2) }),
      r.count ? h('span.azr-count', { text: `(${r.count.toLocaleString('ja-JP')})` }) : ''
    );
    link.hidden = false;
  }

  /** 商品名の下の評価。レビューのページの点が正なので、ページから拾った点があっても差し替える。 */
  function fillItemRating(link, r) {
    if (!link || !r?.score) return;
    for (const el of link.querySelectorAll('.azr-stars, .azr-score')) el.remove();
    link.prepend(stars(r.score), h('span.azr-score', { text: r.score.toFixed(2) }));
    // JSONの件数が無いページでも、件数は出す
    if (!link.querySelector('.azr-count') && r.count) {
      link.append(h('span.azr-count', { text: `${r.count.toLocaleString('ja-JP')}件のレビュー` }));
    }
  }

  function buildShopCard(shop) {
    const name = h('span.azr-shop-card-name', { text: shop.name, hidden: 'hidden' });
    const icon = h('img.azr-shop-icon', { alt: '' });
    const logo = h('img.azr-shop-logo', { alt: shop.name });
    const rating = h('a.azr-shop-rating', {
      href: shop.id ? shopReviewUrl(shop.id) : null,
      target: '_blank',
      rel: 'noopener',
      title: 'ショップレビューを見る',
      hidden: 'hidden'
    });
    const card = h('div.azr-shop-card',
      // アイコンとロゴは同じ行き先。読み上げでは1つのリンクに見えるよう、アイコン側は隠す。
      h('a.azr-shop-icon-link', { href: shop.url, tabindex: '-1', 'aria-hidden': 'true' }, icon),
      h('a.azr-shop-card-main', { href: shop.url, title: `${shop.name} のトップへ` }, logo, name),
      rating
    );

    if (shop.code) {
      loadOrDrop(icon, shopLogoUrl(shop.code, 1), 96, () => card.classList.add('no-icon'));
      loadOrDrop(logo, shopLogoUrl(shop.code, 2), 600, () => { name.hidden = false; });
    } else {
      icon.remove();
      logo.remove();
      card.classList.add('no-icon');
      name.hidden = false;
    }
    return card;
  }

  function buildLayout(data, gallery) {
    const info = h('div.azr-info',
      h('h1.azr-title', { text: data.title }),
      h('a.azr-shop', { href: data.shop.url, text: data.shop.name }),
      data.review && h('a.azr-review', { href: data.review.href, target: '_blank', rel: 'noopener' },
        stars(data.review.score),
        data.review.score ? h('span.azr-score', { text: data.review.score.toFixed(2) }) : '',
        data.review.count ? h('span.azr-count', { text: `${data.review.count.toLocaleString('ja-JP')}件のレビュー` }) : ''
      ),
      h('div.azr-price-block', h('span.azr-price', { text: priceLabel(data) })),
      h('div.azr-coupons-slot', data.coupons.length ? buildCoupons(data.coupons) : ''),
      data.variants.length ? h('div.azr-variants', {
        text: `選択項目: ${data.variants.join(' / ')}（右のボックスで選択）`
      }) : ''
    );

    const buybox = h('aside.azr-buybox',
      h('div.azr-buybox-price', { text: priceLabel(data) }),
      h('div.azr-buybox-slot', h('div.azr-buybox-loading', { text: '購入エリアを読み込み中…' }))
    );

    // 右ペインはショップ欄と購入ボックス。購入エリアはお届け先や販売期間まで入って縦に長く、
    // 下に置くと画面の外に沈むので、ショップ欄を上に置く
    const side = h('div.azr-side', buildShopCard(data.shop), buybox);

    // 商品説明は真ん中のペイン（商品情報）の末尾に置く
    if (data.descriptionNodes.length) {
      info.append(h('section.azr-detail',
        h('h2.azr-h2', { text: '商品説明' }),
        h('div.azr-detail-body')
      ));
    }

    return h('div.azr-item-root', { id: 'azr-item-root' },
      h('div.azr-grid', gallery.node, info, side),
      gallery.overlay
    );
  }

  /** 「Amazonized」の印。押すと元のページと切り替わる。 */
  const brandBadge = () => h('button.azr-brand', {
    type: 'button',
    title: 'クリックで元のページと切り替え',
    onclick: () => document.documentElement.classList.toggle('azr-simplified')
  }, h('span', { text: 'Amazon' }), 'ized');

  /**
   * ヘッダーは楽天市場の共通ヘッダー（.riShopHdrWrap）をそのまま使う。
   * 検索の候補や Language の吹き出しもこの中で完結しているので、移設せず元の場所で見せ、
   * 左端に印を足すだけにする（中の irc="Header" はReactが描くので触らない）。
   * 共通ヘッダーが無いページは、最低限の自前バーで代える。
   */
  function mountHeader(root) {
    const header = document.querySelector('body > .riShopHdrWrap');
    if (header) {
      header.classList.add('azr-header');
      header.prepend(brandBadge());
      return;
    }
    root.prepend(h('div.azr-topbar',
      brandBadge(),
      h('span.azr-topbar-links',
        h('a', { href: 'https://www.rakuten.co.jp/', text: '楽天市場' }),
        h('a', { href: 'https://basket.step.rakuten.co.jp/rms/mall/bs/cartall/', text: '買い物かご' })
      )
    ));
  }

  /** 説明の画像を選り分け、移すものをギャラリーへ足す。終わったら印を付ける（検証用の目印にもなる）。 */
  async function moveDescriptionImages(root, gallery, candidates) {
    try {
      const { moved, dropped, left } = await sortDescriptionImages(gallery.items, candidates);
      gallery.add(moved);
      const detail = root.querySelector('.azr-detail');
      if (detail && isEmptyDescription(detail.querySelector('.azr-detail-body'))) detail.hidden = true;
      AZR.log('gallery', JSON.stringify({ moved: moved.length, dropped, left }));
    } catch (e) {
      // 途中で落ちても、隠したままの画像を説明に戻す
      AZR.warn('説明の画像の整理に失敗:', e);
      for (const c of candidates) if (c.img.classList.contains('azr-desc-pending')) restore(c.img);
    }
    document.documentElement.dataset.azrGallery = 'settled';
  }

  /**
   * 楽天の動画プレーヤーを動画の枠へ移設する。プレーヤーは楽天の動画スクリプトが
   * 元のページの画像欄（.item-pc-movie-<番号>）に後から描く。購入エリアと同じく、
   * 移設しても再生ボタンや操作バーは動く。勝手に再生させないのは video-guard.js の役目。
   * 元のページに戻すときのために、元の位置に印を残して moved に積む。
   */
  const VIDEO_WAIT_MS = 15000;

  async function mountVideo(slot, moved) {
    await AZR.domReady;
    const player = await waitFor(
      () => document.querySelector('[class*="item-pc-movie-"]:has(video)'),
      { timeout: VIDEO_WAIT_MS }
    );
    if (!slot.isConnected) return; // 待つあいだに元のページへ戻した
    if (!player) {
      slot.querySelector('.azr-gallery-video-status').textContent = '動画を読み込めませんでした';
      document.documentElement.dataset.azrVideo = 'failed'; // 検証用の目印
      return;
    }
    const mark = document.createComment('azr-video');
    player.replaceWith(mark);
    moved.push([mark, player]);
    slot.replaceChildren(player);
    document.documentElement.dataset.azrVideo = 'mounted';
  }

  /**
   * 購入エリアの枠（#rakutenLimitedId_aroundCart）はHTMLに入っていて、
   * 中の irc="Quantity" / irc="AddToCartPurchaseButtonFixed" などにReactのバンドルが後から描き込む。
   * 再構成はバンドルより先に始まるので、枠を先に移設しておき、中身はその場で描かれるのに任せる。
   * 枠が無いページ（形が変わった等）は元のページに戻す。いつまでも「読み込み中」にしないよう、
   * バンドルが走り終わって（DOMContentLoaded）から少し待って、それでも無ければ諦める。
   */
  const BUYBOX_GRACE_MS = 3000;

  async function mountBuybox(root, revert) {
    let buyboxNode = pick(document, SEL.buybox);
    if (!buyboxNode) {
      await AZR.domReady;
      buyboxNode = await waitFor(() => pick(document, SEL.buybox), { timeout: BUYBOX_GRACE_MS });
    }
    if (!buyboxNode) {
      AZR.warn('購入エリアが見つからないため、元のページに戻します');
      return revert();
    }
    // 複製ではなく移設する。Reactのハンドラは移設後も動くことを確認済み。
    const slot = root.querySelector('.azr-buybox-slot');
    slot.replaceChildren(buyboxNode);
    document.documentElement.dataset.azrBuybox = 'mounted'; // 検証用の目印
  }

  AZR.register('item', 'item-simplify', async () => {
    if (!AZR.settings.simplifyItem) return;

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
      descriptionNodes: base.descriptionHtml.length
        ? base.descriptionHtml.map(descriptionFromHtml)
        : harvestDescriptions()
    };
    AZR.log('harvested', data);

    if (!data.title || !data.minPrice) {
      AZR.warn('商品名か価格を取得できないため、元のページを表示します');
      return AZR.unhide();
    }

    grabContext = { shop: data.shop.name || '', item: data.title, url: location.origin + location.pathname };

    const items = data.images.filter(Boolean).map(galleryItem);
    // 動画は1枚目の画像の隣に置く（後ろにすると、説明から足す数十枚に埋もれる）
    if (data.video?.still) {
      items.splice(Math.min(1, items.length), 0, { src: data.video.still, tall: false, video: data.video });
    }
    const gallery = buildGallery(items, data.title);
    // 説明に入れる前に、ギャラリーへ移す候補の読み込みを止めておく
    const candidates = takeCandidates(data.descriptionNodes);
    for (const node of data.descriptionNodes) disarmAutoplay(node);
    const root = buildLayout(data, gallery);
    document.body.append(root);
    mountHeader(root);

    // DOMから移設する説明（JSONに説明が無いページ）は、元のページに戻すときのために元の位置を覚えておく
    const detailBody = root.querySelector('.azr-detail-body');
    const moved = [];
    for (const node of data.descriptionNodes) {
      if (node.parentNode) {
        const mark = document.createComment('azr-desc');
        node.replaceWith(mark);
        moved.push([mark, node]);
      }
      detailBody?.append(node);
    }

    document.documentElement.classList.add('azr-simplified');
    // 楽天の動画プレーヤーの自動再生を video-guard.js（MAINワールド）に止めさせる
    document.documentElement.setAttribute('data-azr-no-autoplay', '');
    AZR.unhide();

    mountBuybox(root, () => {
      for (const [mark, node] of moved) mark.replaceWith(node);
      document.documentElement.classList.remove('azr-simplified');
      document.documentElement.removeAttribute('data-azr-no-autoplay');
      document.querySelector('.azr-header > .azr-brand')?.remove();
      document.querySelector('.azr-header')?.classList.remove('azr-header');
      root.remove();
    });

    // 画像の選り分けは数十枚を読むので、購入エリアを描くバンドルの取得と帯域を取り合わないよう後に回す
    AZR.domReady.then(() => moveDescriptionImages(root, gallery, candidates));
    if (gallery.videoSlot) mountVideo(gallery.videoSlot, moved);

    if (AZR.settings.couponList) {
      // フローティングクーポン（元のページで右下に出る枠）を先頭に、ページから拾ったものを後ろに並べる。
      // 同じクーポンへのリンクがページにもあれば、フローティングの方だけを残す。
      let floating = [];
      const paintCoupons = () => {
        const taken = new Set(floating.map((c) => `getkey:${c.getKey}`));
        const list = [...floating, ...data.coupons.filter((c) => !c.href || !taken.has(couponKey(c.href)))];
        root.querySelector('.azr-coupons-slot').replaceChildren(list.length ? buildCoupons(list) : '');
      };

      // 元のページと同じく、通常購入の価格で問い合わせる。ログインしていないと何も返らない。
      if (data.itemId && data.shop.id && data.minPrice) {
        chrome.runtime.sendMessage({
          type: 'azr:floatingCoupons',
          itemId: data.itemId,
          shopId: data.shop.id,
          price: data.minPrice,
          hasSubscription: data.hasSubscription
        }).then((r) => {
          AZR.log('floating coupons', r);
          if (!r?.coupons?.length) return;
          floating = r.coupons.map(fromFloating);
          paintCoupons();
        }).catch((e) => AZR.warn('フローティングクーポンの問い合わせに失敗:', e));
      }

      // クーポンの一部（トピックス欄など）はReactが描くので、バンドルが走り終わってから拾い直す
      AZR.domReady.then(() => {
        const later = harvestCoupons();
        const keys = (list) => list.map((c) => c.href || c.label).join('\n');
        if (keys(later) === keys(data.coupons)) return;
        data.coupons = later;
        paintCoupons();
      });
    }

    fetchRatings(data).then((r) => {
      fillItemRating(root.querySelector('.azr-review'), r?.item);
      fillShopRating(root.querySelector('.azr-shop-rating'), r?.shop);
      document.documentElement.dataset.azrRatings = 'settled'; // 検証用の目印
    });
  });
})();
