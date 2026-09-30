/* タブを開かずに判定する道（fetchしたHTMLからの抜き出し）のテスト */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadServiceWorker } from './load.mjs';

const sw = loadServiceWorker();
// vm の中で作られた配列・オブジェクトはこちらの prototype と別物なので、素の値に直して比べる
const items = (html) => JSON.parse(JSON.stringify(sw.extractEntryItems(html)));

test('共通ボタンの settings からコードを拾う', () => {
  const html = `<div class="rcEntryButton" settings='{"campaignCode": "/ic/marathon/20260919efhmz/pointup", "ekey": "ABC-123"}'></div>`;
  assert.deepEqual(items(html), [{ code: '/ic/marathon/20260919efhmz/pointup', ekey: 'ABC-123' }]);
});

test('ページのJSON（\\" で逃がした形）からも拾い、同じコードは1つにまとめる', () => {
  const html = `<script>window.__DATA__={\\"campaignCode\\":\\"/ic/x/pointup\\"};</script>
    <div class="rcEntryButton" settings='{"campaignCode": "/ic/x/pointup"}'></div>`;
  assert.deepEqual(items(html), [{ code: '/ic/x/pointup', ekey: '' }]);
});

test('別のキャンペーンの ekey を混ぜない', () => {
  const html = `{"campaignCode":"/ic/a"}{"campaignCode":"/ic/b","ekey":"KEY-B"}`;
  assert.deepEqual(items(html), [
    { code: '/ic/a', ekey: '' },
    { code: '/ic/b', ekey: 'KEY-B' }
  ]);
});

test('応募ページへのリンクからも拾う（買いまわりの事前エントリー）', () => {
  const html = `<a href="https://oubo.rakuten.co.jp/apply/ic/marathon/pre?ekey=Z%2F9">事前エントリーする</a>`;
  assert.deepEqual(items(html), [{ code: '/ic/marathon/pre', ekey: 'Z/9' }]);
});

test('campaignCodeList のような別の語をコードにしない', () => {
  assert.deepEqual(items('{"campaignCodeList":[]}'), []);
});

test('トップページのHTMLからリンクを拾う（rd包み・\\/ 逃がし・%2F 包み）', () => {
  const html = `<a href="https://event.rakuten.co.jp/campaign/a/?l-id=top">a</a>
    <a href="https://rd.rakuten.co.jp/rat?R2=https%3A%2F%2Fevent.rakuten.co.jp%2Fb%2F&acc=1">b</a>
    <script>{"url":"https:\\/\\/event.rakuten.co.jp\\/c\\/"}</script>`;
  const links = sw.extractCampaignLinks(html);
  const norm = [...new Set(links.map((l) => sw.normalizeCampaignUrl(l)).filter(Boolean))].sort();
  assert.deepEqual(norm, [
    'https://event.rakuten.co.jp/b/',
    'https://event.rakuten.co.jp/c/',
    'https://event.rakuten.co.jp/campaign/a/'
  ].sort());
});

test('ページ名はタイトルから。エラーページならURLを使う', () => {
  assert.equal(
    sw.extractTitle('<title>【楽天市場】お買い物マラソン│大特価SALE | 楽天市場</title>', 'https://event.rakuten.co.jp/x/'),
    '【楽天市場】お買い物マラソン│大特価SALE'
  );
  assert.equal(
    sw.extractTitle('<title>404 Not Found</title>', 'https://event.rakuten.co.jp/campaign/y/'),
    'campaign/y'
  );
});

test('説明文やほかのページへの案内は「要確認」にしない', () => {
  const url = 'https://event.rakuten.co.jp/family/';
  // 説明文（ママ割・マラソンのガイド）
  assert.equal(sw.looksEnterable('<p>キャンペーンページからエントリーすると参加できます。</p>', url), false);
  // ほかのキャンペーンへの案内バナー（ファミリー割にマラソンのカードが並ぶ）
  assert.equal(sw.looksEnterable(
    '<a href="https://event.rakuten.co.jp/campaign/point-up/marathon/"><span>エントリーする</span></a>', url), false);
  // 別サイトへの案内（SPUから楽天モバイルへ）
  assert.equal(sw.looksEnterable(
    '<a href="https://network.mobile.rakuten.co.jp/spu/">エントリーはこちら</a>', url), false);
});

test('このページで押せるエントリーは「要確認」にする', () => {
  const url = 'https://event.rakuten.co.jp/family/';
  assert.equal(sw.looksEnterable('<button class="entry">エントリーする</button>', url), true);
  assert.equal(sw.looksEnterable('<a href="#entry">今すぐエントリーする</a>', url), true);
  assert.equal(sw.looksEnterable('<div class="rcEntryButton"></div>', url), true);
});
