/* Amazonize Rakuten - 商品ページの左ペイン: ギャラリーと拡大表示 */
(() => {
  const AZR = window.AZR;
  const tr = AZR.t;
  const { h } = AZR;
  const { setSrc, imageAt, mainUrl, fullUrl } = AZR.itemImages;

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
        type: 'button', 'aria-label': tr('閉じる'), title: tr('閉じる (Esc)'), text: '✕', onclick: () => close()
      }),
      nav('is-prev', tr('前の画像 (←)'), -1),
      stage,
      nav('is-next', tr('次の画像 (→)'), 1),
      counter
    );

    const current = () => items[index];

    function render() {
      const it = current();
      setSrc(img, fullUrl(it), it.src);
      img.classList.toggle('is-tall', it.tall);
      stage.classList.toggle('is-tall', it.tall);
      stage.classList.toggle('is-video', Boolean(it.video));
      img.title = it.video ? tr('クリックで動画に戻る') : '';
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
      'aria-label': tr('画像を拡大'),
      title: tr('クリックで拡大'),
      onclick: () => lightbox.open(index)
    }, main, h('span.azr-zoom-hint', { text: tr('クリックで拡大') }));
    const video = items.find((it) => it.video)?.video;
    const videoSlot = video
      ? h('div.azr-gallery-video', { hidden: 'hidden' },
        h('img.azr-gallery-video-still', { src: video.still, alt: video.name }),
        h('span.azr-gallery-video-status', { text: tr('動画を読み込み中…') }))
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
        return h('span.azr-thumb.is-video', { title: it.video.name || tr('動画'), onclick: () => select(i) },
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

  AZR.itemGallery = { buildGallery };
})();
