/* 状態ブリッジ: 一部の店舗だけの応答で、他店舗の金額が消えないこと。
 *   node --test tests/*.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function boot(initial) {
  const posted = [];
  const window = {
    __INITIAL_STATE__: initial,
    postMessage: (m) => posted.push(m.data),
    addEventListener() {}
  };
  const ctx = vm.createContext({
    window, location: { pathname: '/cart', origin: 'https://x.invalid' },
    setInterval() {}, console
  });
  window.XMLHttpRequest = undefined;
  vm.runInContext(readFileSync(new URL('../src/content/state-bridge.js', import.meta.url), 'utf8'), ctx);
  return { window, posted };
}

const sub = (n) => ({ itemCount: 1, itemTotalPrice: n, paymentAmount: n });

test('1店舗だけの応答で他店舗の小計が消えない', async () => {
  let fetchBody;
  const { window, posted } = boot({
    shops: { a: { shopName: 'A' }, b: { shopName: 'B' } },
    shopDisplayOrder: { cart: ['a', 'b'] },
    shopItemSubtotals: { a: sub(1000), b: sub(2000) }
  });
  window.fetch = async () => ({
    ok: true, headers: { get: () => 'application/json' },
    clone: () => ({ text: async () => JSON.stringify({ shopItemSubtotals: { a: sub(1500) } }) })
  });
  // 再度読み込んで fetch を差し替えた状態でパッチを当てる
  const { window: w2, posted: p2 } = (() => {
    const posted = [];
    const w = {
      __INITIAL_STATE__: window.__INITIAL_STATE__, postMessage: (m) => posted.push(m.data),
      addEventListener() {}, fetch: window.fetch
    };
    const ctx = vm.createContext({ window: w, location: { pathname: '/cart', origin: 'https://x.invalid' }, setInterval() {}, console });
    vm.runInContext(readFileSync(new URL('../src/content/state-bridge.js', import.meta.url), 'utf8'), ctx);
    return { window: w, posted };
  })();
  await w2.fetch('/api');
  await new Promise((r) => setTimeout(r, 20));
  const last = p2.at(-1);
  assert.equal(last.subtotals.a.itemTotalPrice, 1500);
  assert.equal(last.subtotals.b.itemTotalPrice, 2000);
});
