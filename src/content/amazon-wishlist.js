/* Amazonize Rakuten - Amazonのほしい物リストで、値下げ通知サービス nesage.party（開発者が運営）への登録を案内する
 * リストのページを開いたときと、商品ページでほしい物リストに追加したときに、右下に小さな案内を出す。
 * 拡張機能から nesage.party へは通信しない（リンクを押したときにブラウザが開くだけ） */
(async () => {
    const AZR = (window.AZR = window.AZR || {});
    await AZR.loadSettings();
    if (!AZR.settings.enabled || !AZR.settings.nesagePromo) return;
    const tr = AZR.t;

    const LIST_PATH = /\/hz\/wishlist\/(?:ls|genericItemsPage)(?:\/([A-Z0-9]{8,20}))?(?=[/?#]|$)/i;
    const listIdOf = (href) => {
        try { return new URL(href, location.href).pathname.match(LIST_PATH)?.[1] || null; } catch { return null; }
    };
    // ×で閉じたリストは、このタブでは出さない
    const closedKey = (id) => `azr-nesage-closed:${id || ''}`;
    const isClosed = (id) => { try { return sessionStorage.getItem(closedKey(id)) === '1'; } catch { return false; } };

    const show = (listId, added) => {
        if (!added && isClosed(listId)) return;
        document.getElementById('azr-nesage')?.remove();
        const url = listId
            ? `https://nesage.party/?wishlist_url=${encodeURIComponent(`https://www.amazon.co.jp/hz/wishlist/ls/${listId}`)}`
            : 'https://nesage.party/';

        const box = document.createElement('div');
        box.id = 'azr-nesage';
        Object.assign(box.style, {
            position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483000', width: '300px', boxSizing: 'border-box',
            padding: '12px 14px', background: '#fff', border: '1px solid #ddd', borderRadius: '8px',
            boxShadow: '0 4px 16px rgba(0,0,0,.15)', fontSize: '13px', color: '#333', lineHeight: '1.5'
        });
        const el = (tag, text, style) => {
            const e = document.createElement(tag);
            if (text) e.textContent = text;
            Object.assign(e.style, style);
            return e;
        };
        const linkBtn = { background: 'none', border: 'none', padding: '0', cursor: 'pointer', color: '#888', font: 'inherit' };

        const close = el('button', '×', { ...linkBtn, position: 'absolute', top: '4px', right: '8px', fontSize: '18px' });
        close.title = tr('閉じる');
        close.onclick = () => { try { sessionStorage.setItem(closedKey(listId), '1'); } catch {} box.remove(); };

        const head = el('div', added ? tr('ほしい物リストに追加しました') : tr('このリストの値下げをメールで受け取る'), { fontWeight: 'bold', paddingRight: '16px' });
        const body = el('div', tr('nesage.party に登録すると、リストの商品が値下げされたときに毎朝メールでお知らせします（無料）。'), { margin: '4px 0 8px' });
        const cta = el('a', tr('nesage.party で値下げ通知を受け取る'), {
            display: 'block', textAlign: 'center', padding: '6px 10px', borderRadius: '8px',
            background: '#ffd814', border: '1px solid #fcd200', color: '#0f1111', textDecoration: 'none', fontWeight: 'bold'
        });
        cta.href = url;
        cta.target = '_blank';
        cta.rel = 'noopener';
        const note = el('div', tr('リストを「公開」か「共有」にすると登録できます。'), { fontSize: '11px', color: '#666', marginTop: '6px' });
        const never = el('button', tr('今後表示しない'), { ...linkBtn, fontSize: '11px', marginTop: '4px', textDecoration: 'underline' });
        never.onclick = () => { box.remove(); try { chrome.storage.sync.set({ nesagePromo: false }); } catch {} };

        box.append(close, head, body, cta, note, never);
        document.body.appendChild(box);
    };

    // ほしい物リストのページ（URLにリストIDが無いとき＝既定のリストは、ページ内から探す）
    if (LIST_PATH.test(location.pathname)) {
        const id = listIdOf(location.href)
            || listIdOf(document.querySelector('link[rel="canonical"]')?.href || '')
            || document.querySelector('input[name="listId"]')?.value?.match(/^[A-Z0-9]{8,20}$/i)?.[0]
            || null;
        show(id, false);
        return;
    }

    // 商品ページ: ほしい物リストのボタンが押されてから少しの間に、追加完了のポップオーバー（リストへのリンク付き）が出たら案内する
    let armedUntil = 0;
    document.addEventListener('click', (e) => {
        if (e.target.closest?.('[id*="wishlist" i], [id^="atwl"], [id^="huc-"]')) armedUntil = Date.now() + 15000;
    }, true);
    let shownFor = null;
    new MutationObserver(() => {
        if (Date.now() > armedUntil) return;
        for (const a of document.querySelectorAll('.a-popover a[href*="/hz/wishlist/"], [id^="huc-"] a[href*="/hz/wishlist/"], [id^="WLHUC"] a[href*="/hz/wishlist/"]')) {
            const pop = a.closest('.a-popover, [id^="huc-"], [id^="WLHUC"]');
            if (!/追加|added/i.test(pop.textContent)) continue;
            const id = listIdOf(a.href);
            if (!id || id === shownFor) continue;
            shownFor = id;
            armedUntil = 0;
            show(id, true);
            return;
        }
    }).observe(document.body, { childList: true, subtree: true });
})();
