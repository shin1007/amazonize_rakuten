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

    const { findPrice } = AZR.slot;
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
    // 型番などで一致した商品が別物のことがあるので、商品名検索の上位も必ず並べて出す
    let titleTop = null;
    let phase = 'search';   // search: 楽天を検索中 / title: 商品名検索の上位を取得中 / done
        const resolveTitleTop = async () => {
        if (!code?.type) { titleTop = ranked[0] || null; return; }
        const res = await apiSearch(titleKw);
        if (res?.searchUrl) affiliateSearchUrls.set(titleKw, res.searchUrl);
        const top = res?.items?.length && rankItems(res.items).filter(r => !r.mismatch && r.sim >= 0.25)[0];
        titleTop = top ? top.it : null;
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

    // 商品画像が無い・読めないときの代わり画像（赤地に白: 上は丸にR、下はNo Image）
    const NO_IMAGE = 'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 104 104"><rect width="104" height="104" fill="#bf0000"/>' +
        '<circle cx="52" cy="38" r="22" fill="none" stroke="#fff" stroke-width="4"/>' +
        '<text x="52" y="47" text-anchor="middle" font-family="Arial,sans-serif" font-weight="bold" font-size="28" fill="#fff">R</text>' +
        '<text x="52" y="86" text-anchor="middle" font-family="Arial,sans-serif" font-weight="bold" font-size="16" fill="#fff">No Image</text></svg>');

    // 表示用に、楽天の商品名に多い宣伝カッコ（【送料無料】[公式] ≪新作≫ など）を中身ごと落とす。
    // 丸カッコは容量・色などの規格が入るので残す。全部消えてしまうときは元の名前のまま
    const PROMO_BRACKETS = /【[^】]*】|[\[［][^\]］]*[\]］]|≪[^≫]*≫|《[^》]*》|〔[^〕]*〕|[＜<][^＞>]*[＞>]/g;
    const displayName = (name) => name.replace(PROMO_BRACKETS, ' ').replace(/\s+/g, ' ').trim() || name;

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

        const wrap = AZR.slot.newWrap();

        const { pulse, rowStyle } = AZR.slot;
        // 型番検索・商品名検索の結果を、画像・価格・タイトル付きの1行ずつで並べる（行の大きさは固定）
        const rows = [];
        // 結果が揃ったあとに他の要素が動かないよう、2行は常に確保する（見つからないときも同じ高さの行を出す）
        const codeCand = candidates.find(c => c.type);
        rows.push({ label: tr(codeCand?.type || '型番'), hit: codeCand?.type === '型番' ? tr('型番が一致') : null, it: code?.type ? ranked[0] : null, kw: codeCand?.value, done: phase !== 'search', none: codeCand ? null : tr('この商品は型番・JANが取得できません') });
        rows.push({ label: tr('商品名'), it: code?.type ? titleTop : ranked[0], kw: titleKw, done: phase === 'done' || (!code?.type && phase !== 'search') });
        for (const r of rows) {
            const row = document.createElement('div');
            Object.assign(row.style, rowStyle);
            if (!r.done) {
                Object.assign(row.style, { background: '#eee', color: '#888', fontSize: '12px' });
                row.textContent = tr('楽天の商品情報を取得中…');
                pulse(row);
                wrap.appendChild(row);
                continue;
            }
            const tag = ` (${r.it && r.hit || r.label})`;
            const it = r.it;
            const box = document.createElement(it ? 'a' : 'div');
            Object.assign(box.style, { display: 'flex', gap: '8px', alignItems: 'center', flex: '1', minWidth: '0', color: '#333', textDecoration: 'none', fontSize: '12px' });
            if (it) { box.href = it.affiliateUrl || it.itemUrl; box.target = '_blank'; box.rel = 'noopener noreferrer'; }
            const img = document.createElement('div');
            Object.assign(img.style, { width: '52px', height: '52px', flex: 'none', background: '#f5f5f5' });
            const im = document.createElement('img');
            im.src = it?.imageUrl || NO_IMAGE;
            im.onerror = () => { im.onerror = null; im.src = NO_IMAGE; };
            Object.assign(im.style, { width: '100%', height: '100%', objectFit: 'contain' });
            img.replaceChildren(im);
            box.appendChild(img);
            const body = document.createElement('div');
            Object.assign(body.style, { minWidth: '0' });
            if (it) {
                const pr = document.createElement('div');
                Object.assign(pr.style, { color: '#bf0000', fontWeight: 'bold', fontSize: '14px' });
                pr.textContent = tr('楽天 ￥{p}{via}', { p: it.itemPrice.toLocaleString(), via: tag });
                const nm = document.createElement('div');
                Object.assign(nm.style, { display: '-webkit-box', WebkitLineClamp: '2', WebkitBoxOrient: 'vertical', overflow: 'hidden' });
                nm.textContent = displayName(it.itemName);
                nm.title = `${it.itemName}\n${it.shopName}`;
                body.append(pr, nm);
            } else {
                body.textContent = r.none || tr('一致する商品が見つかりませんでした{via}', { via: tag });
                if (apiError) body.title = tr('楽天API エラー: {e}', { e: apiError });
            }
            box.appendChild(body);
            row.appendChild(box);
            if (r.kw) {
                row.appendChild(link(searchUrl(r.kw), tr('{t}検索', { t: r.label }), {
                    color: '#bf0000', background: '#fff', border: '1px solid #bf0000', padding: '6px 10px',
                    fontSize: '12px', flex: 'none', whiteSpace: 'nowrap'
                }));
            }
            wrap.appendChild(row);
        }
        // 楽天へのリンクは開発者のアフィリエイトID付き。その旨を小さく添える
        wrap.appendChild(AZR.slot.disclosure());

        AZR.slot.place(wrap);
    };

    const rebuild = () => { document.getElementById('rakuten-link-btn')?.remove(); createBtn(); };
    createBtn();   // 検索中の枠を先に出す
    resolveKeyword().then(() => {
        phase = 'title';
        rebuild();
        resolveTitleTop().then(() => { phase = 'done'; rebuild(); });
        verifyBest();
        let timer;
        new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(createBtn, 500);
        }).observe(document.body, { childList: true, subtree: true });
    });
})();
