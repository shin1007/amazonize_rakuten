/* Amazonize Rakuten - 商品ページから裏で開いたクーポン獲得タブの処理
 *
 * 商品ページの「獲得する」は、まず service worker が獲得APIを呼ぶ。
 * APIで決着が付かないときだけ、本物の獲得ページ（getCoupon?getkey=…）を裏タブで開き、
 * ここでその結果を読んで service worker に返す。
 * クーポンのページを普通に開いたときは何もしない。
 */
(() => {
  const AZR = window.AZR;
  const { waitSettled } = AZR;

  const GRAB_TEXT = /クーポンを?(獲得|取得)|獲得する|取得する|GET/i;
  const DONE_TEXT = /獲得済|取得済|利用可能|使用済/;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * ページ内の「獲得」ボタン。
   * 有効なクーポンの獲得ページは開いた時点で獲得まで進むのでボタンは出ない（実機で確認）。
   * 期限切れのときは「このクーポンを獲得する」が押せない状態で出るので、それは除く。
   */
  function findGrabButtons() {
    const out = [];
    for (const el of document.querySelectorAll('button, a[role="button"], input[type="submit"], [class*="btn"]')) {
      const text = (el.value || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 20) continue;
      if (DONE_TEXT.test(text)) continue;
      if (!GRAB_TEXT.test(text)) continue;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      if (!el.offsetParent) continue; // 非表示要素は除く
      out.push(el);
    }
    return out;
  }

  // 断定できる表示だけを並べる。読めない場合に「獲得できた」と嘘をつかないため。
  const RESULT_PATTERNS = [
    { status: 'acquired', ok: true, re: /クーポンを(獲得|取得)しました|獲得(が)?完了|ゲットしました/ },
    { status: 'already', ok: true, re: /(すでに|既に)[^。]{0,8}(獲得|取得)|獲得済み/ },
    { status: 'expired', ok: false, re: /(配布(は)?終了|期限(切れ|が過ぎ)|上限に達|なくなり次第|対象外です)/ },
    { status: 'login', ok: false, re: /ログイン(して|が必要)/ }
  ];

  /**
   * 獲得ページの表示から結果を読む。判断できなければ unknown（成功と決めつけない）。
   *
   * ページ全体の文字をまとめて見ると、注意書きや一覧の一節を結果と読み違える
   * （クーポン一覧の「上限に達しました」を拾ってしまう例を確認済み）。
   * campaign.js の判定と同じく、短い文言の要素だけを見る。
   */
  function readGrabResult() {
    // 獲得ページ以外へ流れ着いた場合は判断しない（一覧に戻された等）
    if (!/getCoupon/i.test(location.pathname + location.search)) {
      return { ok: false, status: 'unknown', message: '' };
    }
    const nodes = document.querySelectorAll('h1, h2, h3, p, span, div, li, strong, em');
    for (const p of RESULT_PATTERNS) {
      for (const el of nodes) {
        if (!el.offsetParent) continue; // 非表示の要素は無視
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 40) continue;
        if (p.re.test(t)) return { ok: p.ok, status: p.status, message: t.slice(0, 40) };
      }
    }
    return { ok: false, status: 'unknown', message: '' };
  }

  async function isGrabTab() {
    try {
      return Boolean((await chrome.runtime.sendMessage({ type: 'azr:isGrabTab' }))?.grab);
    } catch {
      return false; // service worker が落ちている場合は普通のページとして扱う
    }
  }

  /** 結果を service worker に返す。タブを閉じるかどうかは向こうが決める。 */
  async function reportGrabResult() {
    await waitSettled({ quiet: 700, timeout: 9000 });

    // ページによっては「獲得する」を1回押す必要がある
    const buttons = findGrabButtons();
    if (buttons.length) {
      buttons[0].click();
      await waitSettled({ quiet: 700, timeout: 6000 });
    }

    // 判定できないうちは急いで返さない。獲得後に rd= の戻り先へ遷移するクーポンでは、
    // 遷移の直前に「不明」を返すと、獲得できているのに失敗扱いになってしまう。
    // 遷移した場合はこのスクリプトごと消えるので、service worker 側が離脱を見て成功と判定する。
    let result = readGrabResult();
    for (let i = 0; i < 5 && result.status === 'unknown'; i++) {
      await sleep(1500);
      result = readGrabResult();
    }

    AZR.log('獲得ページの結果', result);
    try {
      await chrome.runtime.sendMessage({ type: 'azr:couponResult', ...result });
    } catch (e) {
      AZR.warn('結果の返信に失敗:', e);
    }
  }

  AZR.register('coupon', 'coupon-grab-tab', async () => {
    if (await isGrabTab()) await reportGrabResult();
  });
})();
