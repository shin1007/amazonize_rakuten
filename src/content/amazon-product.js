/* Amazonize Rakuten - Amazonの商品ページを使いやすくする（左右キーでの画像送り・レビュー検索欄の移設）
 *
 * 1. 左右キーで商品画像とレビューの写真・動画を送る
 *    商品画像: 左のサムネイル列（#altImages）を、Amazon自身がマウスを乗せたときと同じ動き（mouseover）で切り替える。
 *    画像だけでなく、文字の付いたサムネイル（「2+」の残りの画像、「2 ビデオ」の動画）も順に回る。
 *    レビュー: 写真・動画を開いた画面（ポップオーバー）の ‹ › ボタンを押す。「お客様の写真とビデオ」から開いた画面では
 *    › が次の人のレビューへ進むので、そのまま他の人のレビューにも移れる。
 * 2. レビューの検索欄・ルーファスへの質問欄をレビューの左ペインへ移す
 *    元の場所（#nile-inline-btf_feature_div）はレビューのずっと上にあり、レビューを読みながら探せない。
 *    欄の要素そのものを移すので、Amazonが付けた入力・候補・送信の動きはそのまま使える。
 */
(async () => {
    const AZR = (window.AZR = window.AZR || {});
    await AZR.loadSettings();
    if (!AZR.settings.enabled) return;

    /* 1. 左右キー ---------------------------------------------------------- */

    /** 入力中の矢印キーは奪わない（検索欄、数量のプルダウン）。動画の早送りはレビューの画面の外でだけ譲る */
    const isTypingTarget = (el, media = true) => Boolean(el) && (el.isContentEditable
        || /^(INPUT|SELECT|TEXTAREA|OPTION)$/.test(el.tagName) || (media && /^(VIDEO|AUDIO)$/.test(el.tagName)));
    const shown = (el) => el.getBoundingClientRect().width > 0;
    const openPopover = () => [...document.querySelectorAll('.a-popover-modal')].filter(shown).pop() || null;

    /** レビューの写真・動画の画面。前後ボタンのクラス名は left-icon-container_xxxx の形（後ろは変わる） */
    function stepReview(popover, delta) {
        const sel = delta < 0 ? '[class*="left-icon-container"]' : '[class*="right-icon-container"]';
        const btn = [...popover.querySelectorAll(`button${sel}`)].find(shown);
        // 端では片方のボタンが無いのが正常。どちらも無いのに写真・動画の画面なら、形が変わった
        const media = popover.querySelector('[class*="media-popover"]');
        if (media) {
            const any = [...popover.querySelectorAll('button[class*="left-icon-container"], button[class*="right-icon-container"]')].some(shown);
            const many = popover.querySelectorAll('[class*="thumbnail-image-button"]').length > 1;
            if (any) AZR.health.check('amazon.reviewMediaNav', true);
            else if (many) AZR.health.check('amazon.reviewMediaNav', false, '写真・動画が複数あるのに前後ボタン（[class*="left/right-icon-container"]）が無い');
        }
        if (!btn) return false;
        btn.click();
        return true;
    }

    const thumbs = () => [...document.querySelectorAll('#altImages li.item')]
        .filter((li) => li.offsetParent !== null && li.querySelector('.a-button-thumbnail'));

    function step(delta) {
        const list = thumbs();
        if (list.length < 2) return false;
        const at = list.findIndex((li) => li.querySelector('.a-button-selected'));
        const next = list[((at < 0 ? 0 : at) + delta + list.length) % list.length];
        next.querySelector('.a-button-thumbnail').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        // 選択の印（.a-button-selected）が移らなければ、Amazonが mouseover で切り替えなくなった
        if (AZR.health.dev) {
            setTimeout(() => AZR.health.check('amazon.galleryStep', next.querySelector('.a-button-selected'),
                'サムネイルに mouseover を送っても .a-button-selected が移らない'), 500);
        }
        return true;
    }

    if (document.getElementById('productTitle')) {
        AZR.health.expect('amazon.galleryThumbs', () => thumbs().length, { detail: '#altImages li.item .a-button-thumbnail が無い' });
    }

    // 捕捉フェーズで取る（レビューの動画にフォーカスがあっても、早送りより先に次の写真・動画へ送る）
    document.addEventListener('keydown', (e) => {
        if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const delta = e.key === 'ArrowLeft' ? -1 : 1;
        const popover = openPopover();
        // 商品画像の拡大表示など、前後ボタンの無いポップオーバーはAmazonの操作に任せる
        const done = popover
            ? !isTypingTarget(e.target, false) && stepReview(popover, delta)
            : !isTypingTarget(e.target) && step(delta);
        if (done) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    /* 2. レビュー検索欄の移設 -------------------------------------------------- */
    if (document.getElementById('productTitle')) moveReviewSearch();

    function moveReviewSearch() {
        const find = () => ({
            box: document.getElementById('dpx-rex-nice-widget-container'),
            // 左ペインは星の分布の欄が入っている列
            col: document.querySelector('#reviewsMedley .a-col-left')
        });

        const move = () => {
            const { box, col } = find();
            if (!box || !col) return false;
            if (col.contains(box)) return true;
            const anchor = col.querySelector('.cr-widget-TitleRatingsHistogram');
            if (anchor) anchor.after(box); else col.prepend(box); // 上が縮んだぶんのずれはブラウザのスクロールアンカーが戻す
            return true;
        };

        // どちらも遅れて差し込まれることがあるので、揃うまで待つ（いつまでも揃わないページでは諦める）
        if (move()) return AZR.health.check('amazon.reviewSearchMove', true);
        // 変化のたびには探さず、描画1回ぶんにまとめる（Amazonのページは変化が多い）
        let queued = false;
        const obs = new MutationObserver(() => {
            if (queued) return;
            queued = true;
            requestAnimationFrame(() => {
                queued = false;
                if (move()) { obs.disconnect(); AZR.health.check('amazon.reviewSearchMove', true); }
            });
        });
        obs.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => {
            obs.disconnect();
            if (move()) return AZR.health.check('amazon.reviewSearchMove', true);
            // レビューが無い商品・ルーファスの欄が無い商品もあるので、元の場所の枠があるのに見つからないときだけ失敗とする
            const { box, col } = find();
            if (document.getElementById('reviewsMedley') && !col) AZR.health.check('amazon.reviewSearchMove', false, '#reviewsMedley .a-col-left が無い');
            else if (!box && document.getElementById('nile-inline-btf_feature_div')) AZR.health.check('amazon.reviewSearchMove', false, '#nile-inline-btf_feature_div はあるのに #dpx-rex-nice-widget-container が無い');
        }, 30000);
    }
})();
