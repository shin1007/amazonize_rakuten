/* Yahoo!ショッピングの商品ページに出す楽天の価格（service worker の rakutenPrice）。
 *
 * 中継Workerの /search の応答と、店のトップ（閉店・改装中の判定）を差し替えて、
 * どの商品を「同じ商品」として選ぶかを確かめる。
 *
 *   node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadServiceWorker } from './load.mjs';

const ITEMS = [
  { itemName: 'スカルプD 薬用スカルプシャンプー オイリー 350ml 3本セット', itemPrice: 9800, itemUrl: 'https://item.rakuten.co.jp/a/1/', affiliateUrl: 'https://hb.afl.rakuten.co.jp/a1', shopCode: 'a', imageUrl: '' },
  { itemName: 'スカルプD 薬用スカルプシャンプー オイリー 350ml', itemPrice: 3300, itemUrl: 'https://item.rakuten.co.jp/closed/2/', affiliateUrl: 'https://hb.afl.rakuten.co.jp/c2', shopCode: 'closed', imageUrl: '' },
  { itemName: 'スカルプD 薬用スカルプシャンプー オイリー 350ml', itemPrice: 3480, itemUrl: 'https://item.rakuten.co.jp/b/3/', affiliateUrl: 'https://hb.afl.rakuten.co.jp/b3', shopCode: 'b', imageUrl: '' },
  { itemName: 'h&s 薬用シャンプー 370ml', itemPrice: 698, itemUrl: 'https://item.rakuten.co.jp/c/4/', affiliateUrl: 'https://hb.afl.rakuten.co.jp/c4', shopCode: 'c', imageUrl: '' }
];

/** 中継Workerは items を返し、店のトップは closed だけ改装中（リダイレクト）にする */
const stubFetch = (body, calls = [], status = 200) => async (url) => {
  calls.push(String(url));
  if (String(url).startsWith('https://www.rakuten.co.jp/')) {
    return /\/closed\/$/.test(url) ? { type: 'opaqueredirect', ok: false, status: 0 } : { type: 'basic', ok: true, status: 200 };
  }
  return { ok: status === 200, status, json: async () => body };
};

test('JANで引いたときは開いている店の最安を同じ商品として出す（改装中の店・まとめ売りは選ばない）', async () => {
  const calls = [];
  const s = loadServiceWorker({ fetch: stubFetch({ count: 4, items: ITEMS, searchUrl: 'https://hb.afl.rakuten.co.jp/s' }, calls) });
  const res = await s.rakutenPrice({ title: 'スカルプD 薬用スカルプシャンプー 350ml', jan: '4580688635054', model: '' });
  assert.equal(res.status, 'ok');
  assert.equal(res.byJan, true);
  assert.equal(res.item.price, 3480);
  assert.equal(res.item.url, 'https://hb.afl.rakuten.co.jp/b3');
  assert.equal(res.item.shop, undefined);
  assert.match(calls[0], /\/search\?keyword=4580688635054$/);
});

test('JANが無いときは商品名がいちばん重なるものを選ぶ', async () => {
  const s = loadServiceWorker({ fetch: stubFetch({ count: 4, items: ITEMS }) });
  const res = await s.rakutenPrice({ title: 'スカルプD 薬用スカルプシャンプー オイリー 350ml', jan: '', model: '' });
  assert.equal(res.status, 'ok');
  assert.equal(res.byJan, false);
  assert.match(res.item.title, /^スカルプD/);
  assert.notEqual(res.item.url, 'https://hb.afl.rakuten.co.jp/c2');
});

test('どれも似ていなければ「見つからない」', async () => {
  const s = loadServiceWorker({ fetch: stubFetch({ count: 4, items: ITEMS }) });
  const res = await s.rakutenPrice({ title: 'ソニー ワイヤレスイヤホン WF-1000XM5 ブラック', jan: '', model: '' });
  assert.equal(res.status, 'none');
});

test('中継サーバーが答えないときは error', async () => {
  const s = loadServiceWorker({ fetch: stubFetch({ error: 'upstream 500' }, [], 502) });
  const res = await s.rakutenPrice({ title: 'スカルプD シャンプー 350ml', jan: '', model: '' });
  assert.equal(res.status, 'error');
});
