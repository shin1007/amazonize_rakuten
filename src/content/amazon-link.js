/* Amazonize Rakuten - Amazonの商品ページに、楽天の同じ商品へのリンクと価格を出す
 * （旧「楽天比較リンク for Amazon」を統合したもの。検索は service worker 経由） */
(async () => {
    if (!document.getElementById('productTitle')) return;
    const AZR = (window.AZR = window.AZR || {});
    await AZR.loadSettings();
    if (!AZR.settings.enabled || !AZR.settings.rakutenLink) return;
  const tr = AZR.t;
    
    const title = document.getElementById('productTitle').innerText.trim();
    const detailText = [...document.querySelectorAll(
        '#productDetails_techSpec_section_1, #productDetails_detailBullets_sections1, #detailBullets_feature_div, #rpi-attribute-book_details-isbn13, #rpi-attribute-book_details-isbn10'
    )].map(el => el.textContent).join('\n');

    // 登録情報・商品概要を「項目名 → 値」で収集
    const clean = (s) => (s || '').replace(/[‎‏]/g, '').replace(/\s+/g, ' ').replace(/^[\s:：]+|[\s:：]+$/g, '');
    const details = {};
    document.querySelectorAll('#productOverview_feature_div tr, #productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr, #prodDetails tr')
        .forEach(tr => { const c = tr.querySelectorAll('th, td'); if (c.length >= 2) details[clean(c[0].textContent)] ??= clean(c[c.length - 1].textContent); });
    document.querySelectorAll('#detailBullets_feature_div li')
        .forEach(li => { const s = li.querySelectorAll('span > span'); if (s.length >= 2) details[clean(s[0].textContent)] ??= clean(s[1].textContent); });
    const detail = (...labels) => {
        const key = Object.keys(details).find(k => labels.includes(k));
        return key ? details[key] : '';
    };

    // bylineは書籍だと著者名等が入るので、ブランド表記の形のときだけ採用
    const bylineText = clean(document.getElementById('bylineInfo')?.textContent);
    const byline = (bylineText.match(/^ブランド[:：]\s*(.+)$/) || bylineText.match(/^(.+)のストアを表示$/) || bylineText.match(/^Visit the (.+) Store$/) || [])[1] || '';
    const brand = (detail('ブランド', 'ブランド名', 'メーカー', 'メーカー名') || byline).replace(/[（(][^）)]*[）)]/g, '').trim();

    const model = detail('型番', 'メーカー型番', '製品型番', 'モデル番号', '商品モデル番号', 'モデル名');
    const validModel = /^[\w./+-]{3,30}$/.test(model.replace(/\s/g, '')) && /\d/.test(model) && !/^\d{13}$/.test(model) ? model : '';

    // 商品名から検索語を作る
    const NOISE = /送料無料|国内正規品|日本正規代理店品|正規代理店品|正規品|公式|新品|純正|限定|Amazon\.co\.jp|メーカー保証|(?:ブラック|ホワイト|グレー|シルバー|ゴールド|ネイビー|ブルー|レッド|ピンク|グリーン|ベージュ|ブラウン)(?:色)?/gi;
    const titleKeyword = () => {
        let t = title
            .replace(/[【\[「『][^】\]」』]*[】\]」』]|[（(][^）)]*[）)]/g, ' ')
            .split(/\s[|｜\/／]\s|[|｜、,，]|\s-\s/)[0]
            .replace(NOISE, ' ');
        if (brand) t = t.replace(new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
        const words = t.replace(/\s+/g, ' ').trim().split(' ').filter(w => w.length > 1 || /\d/.test(w)).slice(0, 5);
        return [brand, ...words].filter(Boolean).join(' ');
    };

    const isbn10to13 = (isbn10) => {
        const body = '978' + isbn10.slice(0, 9);
        const sum = [...body].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
        return body + (10 - sum % 10) % 10;
    };

    // 検索候補を優先順に並べる
    const candidates = [];
    const jan = detailText.match(/(?:JAN|EAN)[^0-9]{0,10}(\d{13})/);
    const isbn13 = detailText.match(/ISBN-13[^0-9]{0,10}(97[89][\d-]{10,14})/);
    const isbn10 = detailText.match(/ISBN-10[^0-9]{0,10}(\d[\d-]{8,11}[\dXx])/);
    if (jan) candidates.push({ type: 'JAN', value: jan[1] });
    if (isbn13 && isbn13[1].replace(/-/g, '').length === 13) candidates.push({ type: 'ISBN', value: isbn13[1].replace(/-/g, '') });
    else if (isbn10 && isbn10[1].replace(/-/g, '').length === 10) candidates.push({ type: 'ISBN', value: isbn10to13(isbn10[1].replace(/-/g, '')) });
    // 型番: 短い型番は誤ヒットしやすいのでブランド名を付ける
    if (validModel) candidates.push({ type: '型番', value: validModel.length < 6 && brand ? `${brand} ${validModel}` : validModel });
    const titleKw = titleKeyword();

    candidates.push({ type: null, value: titleKw });

    const findPrice = () => [...document.querySelectorAll(
        '#centerCol .priceToPay, #centerCol #apex_desktop .a-price, #centerCol .a-price:not(.a-text-price)'
    )].find(el => el.offsetParent !== null);
    const amazonPrice = Number((findPrice()?.querySelector('.a-offscreen')?.textContent || '').replace(/[^\d]/g, '')) || 0;

    // 楽天APIで検索（background経由）
    // 検索結果ページ: 中継サーバーが返すアフィリエイト付きURLを優先
    const affiliateSearchUrls = new Map();
    const searchUrl = (kw) => affiliateSearchUrls.get(kw) || `https://search.rakuten.co.jp/search/mall/${encodeURIComponent(kw)}/`;
    const apiSearch = (kw) => new Promise(resolve => {
        try {
            chrome.runtime.sendMessage({ type: 'azr:rakutenSearch', keyword: kw }, (res) => {
                resolve(chrome.runtime.lastError ? { error: 'runtime' } : res);
            });
        } catch { resolve({ error: 'runtime' }); }
    });

    // 商品名の類似度（文字bigramのDice係数）
    const bigrams = (s) => {
        const t = s.toLowerCase().replace(/[【\[（(][^】\])）]*[】\])）]/g, '').replace(/[\s\-_/・|｜,、]+/g, '');
        const set = new Set();
        for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
        return set;
    };
    const amazonBigrams = bigrams(title);
    const similarity = (name) => {
        const b = bigrams(name);
        let hit = 0;
        b.forEach(g => { if (amazonBigrams.has(g)) hit++; });
        return b.size + amazonBigrams.size ? (2 * hit) / (b.size + amazonBigrams.size) : 0;
    };
    // 数量・規格（4入力 / 2台 / 256GB / 3個セット 等）が食い違う商品は別物とみなす
    const toHalf = (s) => s.replace(/[０-９．]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    const specsOf = (s) => {
        const m = new Map();
        for (const [, n, unit] of toHalf(s).matchAll(/(\d+(?:\.\d+)?)\s*(入力|出力|台|ポート|口|個|枚|本|袋|箱|セット|GB|TB|mAh|W|ml|L|kg|g|cm|mm|インチ|型)/gi)) {
            const u = unit.toLowerCase();
            if (!m.has(u)) m.set(u, new Set());
            m.get(u).add(Number(n));
        }
        return m;
    };
    const amazonSpecs = specsOf(title);
    const specMismatch = (name) => {
        for (const [u, nums] of specsOf(name)) {
            const a = amazonSpecs.get(u);
            if (a && ![...nums].some(n => a.has(n))) return true;
        }
        return false;
    };

    const rankItems = (items) => items
        .map(it => {
            const priceGap = amazonPrice ? Math.min(Math.abs(it.itemPrice - amazonPrice) / amazonPrice, 1) : 0;
            const sim = similarity(it.itemName);
            return { it, sim, mismatch: specMismatch(it.itemName), score: sim - 0.3 * priceGap };
        })
        .sort((a, b) => b.score - a.score);

    let code = null;
    let keyword = titleKw;
    let ranked = [];       // 候補商品（良い順）。先頭がリンク先
    let apiError = null;
    const resolveKeyword = async () => {
        for (const c of candidates) {
            const res = await apiSearch(c.value);
            if (res?.searchUrl) affiliateSearchUrls.set(c.value, res.searchUrl);
            if (res?.error) { apiError = res.error; return; }
            if (!res?.items?.length) continue;
            const all = rankItems(res.items);
            const matched = all.filter(r => !r.mismatch);
            // 商品名検索: 規格違い・類似度が低いものを除外
            // コード検索: 一致が保証されるので、規格違い（まとめ売り等）は他が無いときだけ残す
            ranked = (c.type ? (matched.length ? matched : all) : matched.filter(r => r.sim >= 0.25)).map(r => r.it);
            code = c; keyword = c.value;
            return;
        }
    };

    // 閉店・改装中の店舗を除外する（ボタン表示後に上位5店舗をまとめて確認）
    const shopOf = (it) => it.shopCode || (() => {
        try { return new URL(new URL(it.itemUrl).searchParams.get('pc') || it.itemUrl).pathname.split('/')[1]; } catch { return ''; }
    })();
    const checkShops = (shops) => new Promise(resolve => {
        try {
            chrome.runtime.sendMessage({ type: 'azr:rakutenCheckShops', shops }, (res) => {
                resolve(chrome.runtime.lastError ? {} : res || {});
            });
        } catch { resolve({}); }
    });
    const verifyBest = async () => {
        const shops = [...new Set(ranked.map(shopOf).filter(Boolean))].slice(0, 5);
        if (!shops.length) return;
        const status = await checkShops(shops);
        const before = ranked[0];
        ranked = ranked.filter(it => status[shopOf(it)] !== false);
        if (ranked[0] !== before) {
            document.getElementById('rakuten-link-btn')?.remove();
            createBtn();
        }
    };

    const createBtn = () => {
        if (document.getElementById('rakuten-link-btn')) return;

        const link = (href, text, style) => {
            const el = document.createElement('a');
            el.href = href;
            el.target = '_blank';
            el.rel = 'noopener noreferrer';
            el.innerText = text;
            Object.assign(el.style, {
                color: '#fff', fontWeight: 'bold', padding: '8px 16px', borderRadius: '8px',
                display: 'inline-block', textDecoration: 'none', verticalAlign: 'middle', ...style
            });
            return el;
        };

        const wrap = document.createElement('span');
        wrap.id = 'rakuten-link-btn';
        Object.assign(wrap.style, { display: 'inline-flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', margin: '8px 0' });

        const via = code?.type ? ` (${tr(code.type)})` : '';
        const best = ranked[0];
        if (best) {
            const main = link(best.affiliateUrl || best.itemUrl, tr('楽天 ￥{p}{via}', { p: best.itemPrice.toLocaleString(), via }), { background: '#bf0000' });
            main.title = `${best.itemName}
${best.shopName}`;
            wrap.appendChild(main);
            // 一致商品があっても他の出品と比べられるよう検索結果へのリンクも出す
            wrap.appendChild(link(searchUrl(keyword), tr('検索結果'), {
                color: '#bf0000', background: '#fff', border: '1px solid #bf0000', padding: '7px 12px'
            }));
        } else {
            const main = link(searchUrl(keyword), tr('楽天市場で探す{via}', { via }), { background: '#bf0000' });
            if (apiError) main.title = tr('楽天API エラー: {e}', { e: apiError });
            wrap.appendChild(main);
        }

        const price = findPrice();
        const priceRow = price && price.closest('div');
        if (priceRow) {
            Object.assign(wrap.style, { margin: '0 0 0 12px', verticalAlign: 'middle' });
            priceRow.appendChild(wrap);
            return;
        }
        const anchor = document.getElementById('titleSection') || document.getElementById('productTitle');
        if (!anchor) return;
        anchor.insertAdjacentElement('afterend', wrap);
    };

    resolveKeyword().then(() => {
        createBtn();
        verifyBest();
        let timer;
        new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(createBtn, 500);
        }).observe(document.body, { childList: true, subtree: true });
    });
})();
