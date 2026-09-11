/* クーポン文言の解析と、注文確認で切り替えるクーポンの判断。
 *
 * 注文確認の自動切り替えは既定でON・確認なしで、本人の注文に直接効く。
 * 画面の操作はログインが要るので自動では回せないが、「どれに切り替えるか」は
 * 状態（state-bridge.js の slim() を通した形）だけで決まるので、ここで確かめる。
 * データは README の「実機での検証状況」で実際に出たクーポンを、実物の項目名で書いたもの。
 *
 *   node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAZR } from './load.mjs';

const AZR = loadAZR(['src/lib/settings.js', 'src/lib/dom.js', 'src/lib/coupon-model.js']);
const { parseCoupon, discountFor, normalizeCoupon, collect, chooseSwitch } = AZR.coupons;

/** 注文確認の shopCoupons の1件（実物の項目名） */
const raw = (couponName, discountPrice, extra = {}) => ({
  couponName,
  description: `商品の合計金額から${discountPrice}`,
  conditions: '利用条件：対象ショップ｜併用不可',
  discountPrice,
  couponCode: couponName,
  selected: false,
  usable: true,
  alerts: [],
  ...extra
});

/** slim() を通した後の状態。1ショップ分。 */
const state = (coupons, { subtotal, applied = 0, fee = 0, shopId = '400001' } = {}) => ({
  shops: { [shopId]: { shopName: 'テスト店', shopUrl: '' } },
  subtotals: { [shopId]: { itemTotalPrice: subtotal, fee, couponUsage: applied } },
  shopCoupons: { [shopId]: coupons }
});

const decide = (s) => chooseSwitch(collect(s));

/* 文言の解析 ------------------------------------------------------------------ */

test('条件つきの円引き: 条件の金額を割引額と取り違えない', () => {
  const c = parseCoupon('5,000円以上で1,000円OFF');
  assert.equal(c.type, 'fixed');
  assert.equal(c.amount, 1000);
  assert.equal(c.minSpend, 5000);
});

test('率引きと上限', () => {
  const c = parseCoupon('10%OFF(最大2,000円)');
  assert.equal(c.type, 'percent');
  assert.equal(c.percent, 10);
  assert.equal(c.cap, 2000);
});

test('送料無料クーポン', () => {
  assert.equal(parseCoupon('送料無料クーポン').type, 'shipping');
});

test('全角の数字・記号・括弧でも読める', () => {
  const pct = parseCoupon('全品１０％ＯＦＦ（最大５００円）');
  assert.equal(pct.type, 'percent');
  assert.equal(pct.percent, 10);
  assert.equal(pct.cap, 500);

  // 「（税込）以上」の条件を読み落とすと、条件を満たさない注文でも使えると判断してしまう
  const fixed = parseCoupon('【楽天スーパーSALE】対象ショップで1注文合計1,500円（税込）以上で100円OFF');
  assert.equal(fixed.type, 'fixed');
  assert.equal(fixed.amount, 100);
  assert.equal(fixed.minSpend, 1500);
});

test('割引額: 条件未達は0、率引きは切り捨て、上限で頭打ち', () => {
  const c = parseCoupon('4,000円以上で700円OFF');
  assert.equal(discountFor(c, 3999), 0);
  assert.equal(discountFor(c, 4000), 700);

  const pct = parseCoupon('21%OFF');
  assert.equal(discountFor(pct, 1680), 352); // 352.8 → 352

  const capped = parseCoupon('10%OFF(最大2,000円)');
  assert.equal(discountFor(capped, 50000), 2000);
});

test('実物の1件（楽天24の700円OFF・4,000円以上）', () => {
  const c = normalizeCoupon(raw('【楽天24】全商品対象税込4000円以上で700円OFFクーポン', '700円OFF', {
    conditions: '利用条件：対象ショップ｜4,000円以上の購入｜併用不可'
  }), '400001');
  assert.equal(c.type, 'fixed');
  assert.equal(c.amount, 700);
  assert.equal(c.minSpend, 4000);
  assert.equal(c.label, '【楽天24】全商品対象税込4000円以上で700円OFFクーポン');
  assert.equal(c.selected, false);
});

/* どれに切り替えるか ---------------------------------------------------------- */

// みさき果樹園（1,680円）で使えた3枚
const MISAKI = {
  pct21: '21%OFFクーポン',
  yen108: '108円OFFクーポン',
  yen100: '1,500円以上で100円OFFクーポン'
};

test('何も選ばれていなければ、いちばん多く引ける21%OFF（-352円）を選ぶ', () => {
  const d = decide(state([
    raw(MISAKI.yen108, '108円OFF'),
    raw(MISAKI.pct21, '21%OFF'),
    raw(MISAKI.yen100, '100円OFF')
  ], { subtotal: 1680 }));
  assert.equal(d.better?.coupon.label, MISAKI.pct21);
  assert.equal(d.better?.discount, 352);
});

test('楽天が108円OFFを選んでいたら、併用の理由だけで使えない21%OFFへ切り替える', () => {
  const blocked = { usable: false, alerts: ['選択済みのクーポンと併用が出来ません。'] };
  const d = decide(state([
    raw(MISAKI.yen108, '108円OFF', { selected: true }),
    raw(MISAKI.pct21, '21%OFF', blocked),
    raw(MISAKI.yen100, '100円OFF', blocked)
  ], { subtotal: 1680, applied: 108 }));
  assert.equal(d.appliedTotal, 108);
  assert.equal(d.better?.coupon.label, MISAKI.pct21);
  assert.equal(d.selected.length, 1);
});

test('最良のものがもう選ばれていれば、切り替えない', () => {
  const blocked = { usable: false, alerts: ['選択済みのクーポンと併用が出来ません。'] };
  const d = decide(state([
    raw(MISAKI.yen108, '108円OFF', blocked),
    raw(MISAKI.pct21, '21%OFF', { selected: true })
  ], { subtotal: 1680, applied: 352 }));
  assert.equal(d.best?.coupon.label, MISAKI.pct21);
  assert.equal(d.better, null);
});

test('併用のほかに条件の理由も付いたものは、選び直しても使えないので候補にしない', () => {
  const d = decide(state([
    raw(MISAKI.yen108, '108円OFF', { selected: true }),
    raw('5,000円以上で1,000円OFFクーポン', '1,000円OFF', {
      usable: false,
      alerts: ['選択済みのクーポンと併用が出来ません。', '5,000円以上お買い上げの場合に利用できます。']
    })
  ], { subtotal: 1680, applied: 108 }));
  assert.equal(d.better, null);
});

test('条件の金額に届かないクーポンは選ばない', () => {
  const d = decide(state([
    raw('【楽天24】全商品対象税込4000円以上で700円OFFクーポン', '700円OFF', {
      conditions: '利用条件：対象ショップ｜4,000円以上の購入｜併用不可'
    })
  ], { subtotal: 3000 }));
  assert.equal(d.best, null);
  assert.equal(d.better, null);
});

test('割引率ではなく割引額で比べる（小計が小さいと300円OFFが21%OFFに勝つ）', () => {
  const d = decide(state([
    raw(MISAKI.pct21, '21%OFF'),
    raw('300円OFFクーポン', '300円OFF')
  ], { subtotal: 1000 }));
  assert.equal(d.better?.coupon.label, '300円OFFクーポン');
  assert.equal(d.better?.discount, 300);
});

test('今のクーポンと同額なら、わざわざ切り替えない', () => {
  const blocked = { usable: false, alerts: ['選択済みのクーポンと併用が出来ません。'] };
  const d = decide(state([
    raw('100円OFFクーポンA', '100円OFF', { selected: true }),
    raw('100円OFFクーポンB', '100円OFF', blocked)
  ], { subtotal: 1680, applied: 100 }));
  assert.equal(d.better, null);
});

test('クーポンが1枚も無い注文', () => {
  const d = decide(state([], { subtotal: 1680 }));
  assert.equal(d.best, null);
  assert.equal(d.better, null);
  assert.equal(d.appliedTotal, 0);
});
