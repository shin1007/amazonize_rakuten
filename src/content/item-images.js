/* Amazonize Rakuten - 商品ページの画像: 楽天の画像URLの扱いと、説明の画像の選り分け */
(() => {
  const AZR = window.AZR;

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

  AZR.itemImages = {
    cdnPath, imageKey, imageAt, isPlaceholder, setSrc, galleryItem, mainUrl, fullUrl,
    takeCandidates, restore, sortDescriptionImages, isEmptyDescription
  };
})();
