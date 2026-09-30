/* Amazonize Rakuten - Amazon商品ページの「楽天の候補」エリア（枠の大きさ・置き場所・取得中の見た目）
 * 早い段階で枠だけ先に置く（amazon-link-early.js）ときと、結果で置き換える（amazon-link.js）ときで共有する */
(() => {
    const AZR = (window.AZR = window.AZR || {});

    const findPrice = () => [...document.querySelectorAll(
        '#centerCol .priceToPay, #centerCol #apex_desktop .a-price, #centerCol .a-price:not(.a-text-price)'
    )].find(el => el.offsetParent !== null);

    // 行の大きさは固定（取得中も結果表示後も同じ高さにして、他の要素が動かないようにする）
    const rowStyle = { display: 'flex', gap: '8px', alignItems: 'center', width: '100%', maxWidth: '520px', boxSizing: 'border-box', height: '64px', padding: '4px 8px', border: '1px solid #ddd', borderRadius: '8px', background: '#fff', overflow: 'hidden' };

    const pulse = (el) => { try { el.animate([{ opacity: 1 }, { opacity: 0.4 }, { opacity: 1 }], { duration: 1200, iterations: Infinity }); } catch {} };

    const newWrap = () => {
        const wrap = document.createElement('span');
        wrap.id = 'rakuten-link-btn';
        Object.assign(wrap.style, { display: 'flex', flexDirection: 'column', gap: '6px', margin: '8px 0' });
        return wrap;
    };

    // 取得中の行（2行分）
    const loadingRow = (text) => {
        const row = document.createElement('div');
        Object.assign(row.style, { ...rowStyle, background: '#eee', color: '#888', fontSize: '12px' });
        row.textContent = text;
        pulse(row);
        return row;
    };

    // 価格の下に置く。価格が見つからなければタイトルの後ろ
    const place = (wrap) => {
        const price = findPrice();
        const priceRow = price && price.closest('div');
        if (priceRow) {
            Object.assign(wrap.style, { margin: '6px 0 0' });
            priceRow.appendChild(wrap);
            return;
        }
        const anchor = document.getElementById('titleSection') || document.getElementById('productTitle');
        if (anchor) anchor.insertAdjacentElement('afterend', wrap);
    };

    AZR.slot = { findPrice, rowStyle, pulse, newWrap, loadingRow, place };
})();
