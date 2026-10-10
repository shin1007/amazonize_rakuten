/* 楽天の商品ページに出す Yahoo!ショッピングの価格（service worker の yahooPrice）。
 *
 * 中継Workerの /yahoo は、楽天検索と同じ形（itemName / itemPrice / …）で返す。ここではその応答を差し替えて、
 * どの商品を「同じ商品」として選ぶかと、リンクの扱いを確かめる。
 *
 *   node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadServiceWorker } from './load.mjs';

const vc = (u) => `https://ck.jp.ap.valuecommerce.com/servlet/referral?sid=1&pid=2&vc_url=${encodeURIComponent(u)}`;
const ITEMS = [
  { itemName: 'スカルプD 薬用スカルプシャンプー オイリー 350ml', itemPrice: 3480, itemUrl: 'https://store.shopping.yahoo.co.jp/a/1.html', imageUrl: '', rating: 4.5, reviewCount: 12 },
  { itemName: 'h&s 薬用シャンプー 370ml', itemPrice: 698, itemUrl: 'https://store.shopping.yahoo.co.jp/b/2.html', imageUrl: '' }
].map((it) => ({ ...it, affiliateUrl: vc(it.itemUrl) }));

const stubFetch = (body, calls = [], status = 200) => async (url) => {
  calls.push(String(url));
  return { ok: status === 200, status, json: async () => body };
};

test('JANで引いたときは先頭（安い順の最安）を同じ商品として出し、リンクはバリューコマースのもの', async () => {
  const calls = [];
  const s = loadServiceWorker({ fetch: stubFetch({ count: 2, items: ITEMS, searchUrl: vc('https://shopping.yahoo.co.jp/search?p=4580688635054') }, calls) });
  const res = await s.yahooPrice({ title: 'スカルプD 薬用スカルプシャンプー 350ml', jan: '4580688635054', model: '' });
  assert.equal(res.status, 'ok');
  assert.equal(res.byJan, true);
  assert.equal(res.item.price, 3480);
  assert.ok(res.item.url.startsWith('https://ck.jp.ap.valuecommerce.com/'));
  assert.match(calls[0], /\/yahoo\?jan=4580688635054$/);
});

test('JANが無いときは商品名がいちばん重なるものを選ぶ（別ブランドの安い方を選ばない）', async () => {
  const s = loadServiceWorker({ fetch: stubFetch({ count: 2, items: ITEMS }) });
  const res = await s.yahooPrice({ title: 'スカルプD シャンプー オイリー 350ml', jan: '', model: '' });
  assert.equal(res.status, 'ok');
  assert.equal(res.byJan, false);
  assert.equal(res.item.price, 3480);
});

test('どれも似ていなければ「見つからない」', async () => {
  const s = loadServiceWorker({ fetch: stubFetch({ count: 2, items: ITEMS }) });
  const res = await s.yahooPrice({ title: 'ソニー ワイヤレスイヤホン WF-1000XM5 ブラック', jan: '', model: '' });
  assert.equal(res.status, 'none');
});

test('中継サーバーが答えないとき（Client ID 未設定など）は error', async () => {
  const s = loadServiceWorker({ fetch: stubFetch({ error: 'not_configured' }, [], 503) });
  const res = await s.yahooPrice({ title: 'スカルプD シャンプー 350ml', jan: '', model: '' });
  assert.equal(res.status, 'error');
});

test('開発用の noAffiliate では、バリューコマースのリンクを外して元のURLにする', () => {
  const s = loadServiceWorker();
  assert.equal(s.unwrapVc(vc('https://shopping.yahoo.co.jp/search?p=a b')), 'https://shopping.yahoo.co.jp/search?p=a b');
  assert.equal(s.unwrapVc('https://shopping.yahoo.co.jp/'), 'https://shopping.yahoo.co.jp/');
});

test('商品名の長い検索語で0件なら、先頭の3語で引き直す（Yahoo!は語をすべて含む商品しか返さない）', async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(decodeURIComponent(String(url)));
    const words = new URL(url).searchParams.get('keyword').split(' ').length;
    return { ok: true, status: 200, json: async () => ({ count: words > 3 ? 0 : 2, items: words > 3 ? [] : ITEMS }) };
  };
  const s = loadServiceWorker({ fetch });
  const res = await s.yahooPrice({ title: 'スカルプD 薬用スカルプシャンプー オイリー 350ml 頭皮タイプ別3種 ニオイ かゆみ', jan: '', model: '' });
  assert.equal(res.status, 'ok');
  assert.equal(res.item.price, 3480);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /keyword=スカルプD 薬用スカルプシャンプー オイリー$/);
});
