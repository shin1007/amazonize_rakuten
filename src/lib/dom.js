/* Amazonize Rakuten - DOM helpers */
(() => {
  const AZR = (window.AZR = window.AZR || {});

  /** 複数候補セレクタから最初に見つかった要素を返す */
  function pick(root, selectors) {
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch { /* 不正なセレクタは無視 */ }
    }
    return null;
  }

  function pickAll(root, selectors) {
    for (const sel of selectors) {
      try {
        const els = root.querySelectorAll(sel);
        if (els.length) return Array.from(els);
      } catch { /* noop */ }
    }
    return [];
  }

  /** 条件が満たされるまで待つ（MutationObserver + タイムアウト） */
  function waitFor(fn, { timeout = 8000, root = document } = {}) {
    return new Promise((resolve) => {
      const immediate = fn();
      if (immediate) return resolve(immediate);
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        obs.disconnect();
        clearTimeout(timer);
        resolve(v);
      };
      const obs = new MutationObserver(() => {
        const v = fn();
        if (v) finish(v);
      });
      obs.observe(root === document ? document.documentElement : root, {
        childList: true, subtree: true
      });
      const timer = setTimeout(() => finish(null), timeout);
    });
  }

  /** DOMが落ち着くまで（変化が quiet ms 止まるまで）待つ */
  function waitSettled({ quiet = 400, timeout = 6000 } = {}) {
    return new Promise((resolve) => {
      let timer = setTimeout(finish, quiet);
      const hard = setTimeout(finish, timeout);
      const obs = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(finish, quiet);
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      function finish() {
        obs.disconnect();
        clearTimeout(timer);
        clearTimeout(hard);
        resolve();
      }
    });
  }

  /** 属性オブジェクトか、それとも子要素か。Node や配列や文字列は子とみなす。 */
  function isAttrs(v) {
    return v !== null && typeof v === 'object' && !(v instanceof Node) && !Array.isArray(v);
  }

  /** 要素生成: h('div.foo', {attrs}, ...children) / h('div.foo', ...children) */
  function h(tagSpec, attrs, ...children) {
    if (!isAttrs(attrs)) {
      // 属性を省略した呼び出し。第2引数は最初の子。
      if (attrs !== undefined) children.unshift(attrs);
      attrs = {};
    }
    const [tag, ...classes] = String(tagSpec).split('.');
    const el = document.createElement(tag || 'div');
    if (classes.length) el.className = classes.join(' ');
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  /** "1,234円" / "￥1,234" / "1234" → 1234 (見つからなければ null) */
  function parseYen(text) {
    if (!text) return null;
    const normalized = String(text)
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[,，\s]/g, '');
    const m = normalized.match(/(\d+)\s*円|[¥￥]\s*(\d+)|(\d{3,})/);
    if (!m) return null;
    const n = Number(m[1] ?? m[2] ?? m[3]);
    return Number.isFinite(n) ? n : null;
  }

  const yen = (n) => (Number.isFinite(n) ? `${Math.round(n).toLocaleString('ja-JP')}円` : '—');

  /** 同じidのパネルを重複挿入しない */
  function mountOnce(id, build, parent = document.body) {
    if (!parent) return null;
    const existing = document.getElementById(id);
    if (existing) return existing;
    const el = build();
    if (!el) return null;
    el.id = id;
    parent.append(el);
    return el;
  }

  /** 現在のページ種別 */
  function pageKind() {
    const { host, pathname } = location;
    if (host === 'item.rakuten.co.jp') return 'item';
    if (host === 'search.rakuten.co.jp') return 'search';
    if (host === 'basket.step.rakuten.co.jp') return 'cart';
    if (host === 'step.item.rakuten.co.jp' || host === 'order.step.rakuten.co.jp') return 'checkout';
    if (host === 'coupon.rakuten.co.jp' || /coupon/i.test(pathname)) return 'coupon';
    if (host === 'event.rakuten.co.jp') return 'campaign';
    return 'other';
  }

  Object.assign(AZR, { pick, pickAll, waitFor, waitSettled, h, parseYen, yen, mountOnce, pageKind });
})();
