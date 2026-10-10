/* Amazonize Rakuten - Yahoo!ショッピングの商品ページ（左右キーでの画像送り・Amazonと楽天の価格）
 *
 * 1. 左右キーで商品画像を送る
 *    ページ上: サムネイル列のボタンに、Yahoo!自身がマウスを乗せたときと同じ動き（mouseover）を送る（click では切り替わらない）。
 *    拡大表示（画像を押すと開く画面）: 画面の ‹ › ボタンを押す。Yahoo!の拡大表示は矢印キーに応えない。
 *    Esc でも閉じられるようにする（Yahoo!の拡大表示は Esc で閉じない）。
 * 2. 価格の下に、同じ商品のAmazon・楽天での価格を並べる（楽天の商品ページと同じ欄。描くのは item-amazon.js）
 *    商品データはページに埋め込まれた __NEXT_DATA__ から読む（商品名・価格・JAN）。
 */
(async () => {
    const AZR = (window.AZR = window.AZR || {});
    // 商品ページは /<ストア>/<商品>.html。ストアのトップや一覧では何もしない
    if (!/^\/[\w-]+\/[\w-]+\.html$/.test(location.pathname)) return;
    await AZR.loadSettings();
    if (!AZR.settings.enabled) return;

    /* 1. 左右キー ---------------------------------------------------------- */

    const isTypingTarget = (el) => Boolean(el) && (el.isContentEditable || /^(INPUT|SELECT|TEXTAREA|OPTION|VIDEO|AUDIO)$/.test(el.tagName));
    const shown = (el) => el.getBoundingClientRect().width > 0;
    // 拡大表示は閉じてもしばらく（閉じる動きのあいだ）残るので、開いている印（ModalView--open）のあるものだけを見る
    const modalButton = (cls) => [...document.querySelectorAll(`.ModalView--open .ModalView__contents button[class*="${cls}"]`)].find(shown);
    const thumbs = () => [...document.querySelectorAll('button[class*="thumbnailButton"]')]
        .filter((b) => shown(b) && !b.closest('.ModalView__contents'));

    function step(delta) {
        const list = thumbs();
        if (list.length < 2) return false;
        const at = list.findIndex((b) => /isCurrent/.test(b.className));
        const next = list[((at < 0 ? 0 : at) + delta + list.length) % list.length];
        next.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        // 選択の印（isCurrent）が移らなければ、Yahoo!が mouseover で切り替えなくなった
        if (AZR.health.dev) {
            setTimeout(() => AZR.health.check('yahoo.galleryStep', /isCurrent/.test(next.className),
                'サムネイルに mouseover を送っても isCurrent が移らない'), 500);
        }
        return true;
    }

    AZR.health.expect('yahoo.galleryThumbs', () => thumbs().length, { detail: 'button[class*="thumbnailButton"] が無い' });

    document.addEventListener('keydown', (e) => {
        if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (e.key === 'Escape') {
            const close = modalButton('closeButton');
            if (!close) return;
            close.click();
            return e.preventDefault();
        }
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        if (isTypingTarget(e.target)) return;
        const delta = e.key === 'ArrowLeft' ? -1 : 1;
        const nav = modalButton(delta < 0 ? 'leftArrowButton' : 'rightArrowButton');
        if (nav) nav.click();
        else if (!step(delta)) return;
        e.preventDefault();
        e.stopPropagation();
    }, true);

    /* 2. Amazon・楽天の価格 -------------------------------------------------- */
    if (!AZR.settings.yahooItem) return;

    let item = null;
    try {
        item = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || 'null')?.props?.pageProps?.item || null;
    } catch { /* 下で失敗として記録する */ }
    AZR.health.check('yahoo.itemData', item?.name, '__NEXT_DATA__ の props.pageProps.item.name が無い');
    if (!item?.name) return;

    const data = {
        title: String(item.name).replace(/\s+/g, ' ').trim(),
        minPrice: Number(item.applicablePrice) || null,
        maxPrice: null,
        jan: item.isJanCodeActive === false ? '' : String(item.janCode || ''),
        variants: [],
        // 型番を拾う手がかり（item-amazon.js が extractModel に渡す）
        descriptionHtml: [item.caption, item.information].filter((s) => typeof s === 'string' && s)
    };

    const { SITES, HOMES, mount } = AZR.priceCompare;
    const anchor = document.getElementById('prcdsp'); // 中央の列の価格の欄
    AZR.health.check('yahoo.pricePlace', anchor, '#prcdsp（価格の欄）が無い');
    if (!anchor) return;
    const { boxes, done } = mount(anchor, data, [SITES.amazon, SITES.rakuten], HOMES.yahoo);

    // ページの描き直し（Reactの読み込み直後など）で外れたら、価格の欄の下へ置き直す
    let queued = false;
    const obs = new MutationObserver(() => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
            queued = false;
            if (boxes.every((b) => b.isConnected)) return;
            document.getElementById('prcdsp')?.after(...boxes);
        });
    });
    obs.observe(document.body, { childList: true, subtree: true });
    await done;
    setTimeout(() => obs.disconnect(), 10000);
})();
