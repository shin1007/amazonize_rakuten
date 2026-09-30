// 楽天市場商品検索APIの中継（キーはWorkerのSecretにのみ保持）
import privacyHtml from './privacy.html';
const API = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701';
const CACHE_TTL = 3600;

const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra }
});

async function callRakuten(keyword, env) {
    const params = new URLSearchParams({
        applicationId: env.RAKUTEN_APP_ID, accessKey: env.RAKUTEN_ACCESS_KEY, keyword,
        format: 'json', formatVersion: '2', hits: '30', availability: '1'
    });
    if (env.RAKUTEN_AFFILIATE_ID) params.set('affiliateId', env.RAKUTEN_AFFILIATE_ID);
    // 楽天は「許可されたWebサイト」とOriginを照合する
    const headers = { Origin: env.ALLOWED_ORIGIN, Referer: env.ALLOWED_ORIGIN + '/' };
    for (let i = 0; i < 2; i++) {
        const r = await fetch(`${API}?${params}`, { headers });
        if (r.status === 429) { await new Promise(res => setTimeout(res, 1000)); continue; }
        if (r.status === 404) return { count: 0, items: [] };
        if (!r.ok) {
            const body = await r.json().catch(() => ({}));
            const e = body.errors || body;
            return { error: `upstream ${r.status}`, detail: e.errorMessage || e.error_description || e.error || null };
        }
        const j = await r.json();
        return {
            count: j.count ?? 0,
            items: (j.Items || j.items || []).map(x => x.Item || x.item || x).map(({ itemName, itemPrice, itemUrl, affiliateUrl, shopName, shopCode, mediumImageUrls }) =>
                ({ itemName, itemPrice, itemUrl, affiliateUrl, shopName, shopCode, imageUrl: mediumImageUrls?.[0]?.imageUrl || mediumImageUrls?.[0] || '' }))
        };
    }
    return { error: 'too_many_requests' };
}

// 検索結果ページのURL（アフィリエイトIDがあれば任意URL型のアフィリエイトリンクにする）
function searchPageUrl(keyword, env) {
    const url = `https://search.rakuten.co.jp/search/mall/${encodeURIComponent(keyword)}/`;
    if (!env.RAKUTEN_AFFILIATE_ID) return url;
    const enc = encodeURIComponent(url);
    return `https://hb.afl.rakuten.co.jp/hgc/${env.RAKUTEN_AFFILIATE_ID}/?pc=${enc}&m=${enc}`;
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (request.method === 'GET' && url.pathname === '/privacy') {
            return new Response(privacyHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } });
        }
        if (request.method !== 'GET' || url.pathname !== '/search') return json({ error: 'not_found' }, 404);

        if (env.LIMITER) {
            const { success } = await env.LIMITER.limit({ key: request.headers.get('cf-connecting-ip') || 'unknown' });
            if (!success) return json({ error: 'rate_limited' }, 429);
        }

        const keyword = (url.searchParams.get('keyword') || '').replace(/\s+/g, ' ').trim();
        if (keyword.length < 2 || keyword.length > 128) return json({ error: 'bad_keyword' }, 400);

        // 正規化したキーワードでキャッシュ
        const cacheKey = new Request(`${url.origin}/search?v=7&keyword=${encodeURIComponent(keyword)}`);
        const cached = await caches.default.match(cacheKey);
        if (cached) return cached;

        const result = await callRakuten(keyword, env);
        result.searchUrl = searchPageUrl(keyword, env);
        if (result.error) return json(result, 502);
        const res = json(result, 200, { 'cache-control': `public, max-age=${CACHE_TTL}` });
        ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
        return res;
    }
};
