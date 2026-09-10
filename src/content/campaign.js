/* Amazonize Rakuten - ポイントアップキャンペーンの自動エントリー */
(() => {
  const AZR = window.AZR;
  const { h, waitSettled } = AZR;

  const ENTRY_TEXT = /^(エントリー(する)?|今すぐエントリー|エントリーはこちら)$/;
  const DONE_TEXT = /エントリー(済|完了|ずみ)/;
  const ENTRY_INTERVAL_MS = 1200;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 未エントリーのボタンを集める */
  function findEntryButtons() {
    const out = [];
    for (const el of document.querySelectorAll('a, button, input[type="submit"], input[type="image"], [role="button"]')) {
      const text = (el.value || el.alt || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 16) continue;
      if (DONE_TEXT.test(text)) continue;
      if (!ENTRY_TEXT.test(text)) continue;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      if (!el.offsetParent) continue;
      out.push(el);
    }
    return out;
  }

  /** すでにエントリー済みの表示があるか */
  function alreadyEntered() {
    return Array.from(document.querySelectorAll('a, button, p, span, div'))
      .some((el) => el.offsetParent && DONE_TEXT.test((el.textContent || '').trim()) &&
        (el.textContent || '').trim().length <= 16);
  }

  async function entryAll(buttons, onProgress) {
    let ok = 0;
    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons[i];
      if (!btn.isConnected) continue;
      try {
        // 別タブに飛ばず、その場でエントリーさせる
        if (btn.tagName === 'A' && btn.target === '_blank') btn.removeAttribute('target');
        btn.click();
        ok++;
      } catch (e) {
        AZR.warn('エントリーに失敗:', e);
      }
      onProgress?.(i + 1, buttons.length);
      await sleep(ENTRY_INTERVAL_MS);
    }
    return ok;
  }

  function render(buttons) {
    const status = h('div.azr-coupon-status', {
      text: buttons.length
        ? `未エントリーのボタン ${buttons.length}件`
        : (alreadyEntered() ? 'エントリー済みです' : 'エントリーボタンは見つかりませんでした')
    });

    const panel = h('div.azr-panel.azr-campaign-panel', { id: 'azr-campaign-panel' },
      h('div.azr-panel-head',
        h('span.azr-panel-title', { text: 'キャンペーン' }),
        h('button.azr-panel-close', { type: 'button', text: '×', onclick: () => panel.remove() })
      ),
      h('div.azr-panel-body',
        status,
        h('button.azr-btn-primary', {
          type: 'button',
          text: 'このページを一括エントリー',
          disabled: buttons.length === 0,
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            const ok = await entryAll(buttons, (done, total) => {
              status.textContent = `エントリー中… ${done}/${total}`;
            });
            status.textContent = `${ok}件エントリーしました`;
          }
        })
      )
    );
    return panel;
  }

  /* 一括スキャンで裏から開かれたとき ---------------------------------------- */

  /** ページの見出し。一覧に出すので、キャンペーン名らしいものを選ぶ。 */
  function pageTitle() {
    const h1 = document.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim();
    const title = document.title.replace(/\s*[|｜]\s*楽天市場.*$/, '').replace(/\s+/g, ' ').trim();
    const name = (h1 && h1.length <= 60 ? h1 : title).slice(0, 60);
    // 計測用のクエリを落とすと開けなくなるページがあり、そのままだとエラーページの
    // 見出しが名前になってしまう。一覧で見分けが付かないのでURLを使う。
    if (!name || /^\d{3}\s|Bad Request|Not Found|Forbidden/i.test(name)) {
      return location.pathname.replace(/^\/|\/$/g, '') || location.host;
    }
    return name;
  }

  /**
   * このページの状態を返す。
   *   entry   … 未エントリーのボタンがある
   *   already … エントリー済みの表示がある
   *   none    … そもそもエントリーするものが無い（ただの特集ページ）
   */
  function pageStatus() {
    if (findEntryButtons().length) return 'entry';
    if (alreadyEntered()) return 'already';
    return 'none';
  }

  /** 裏タブとしての仕事。エントリーして、結果を確かめてから返す。 */
  async function reportForScan(task) {
    await waitSettled({ quiet: 700, timeout: 9000 });

    let status = pageStatus();
    let entered = false;

    if (status === 'entry' && task.entry) {
      const buttons = findEntryButtons();
      await entryAll(buttons);
      // 押しただけで「エントリーした」と言わない。表示が変わるのを確かめる。
      await sleep(2000);
      const after = pageStatus();
      entered = after === 'already';
      status = entered ? 'entered' : after;
    }

    AZR.log('スキャン結果', { status, entered });
    try {
      await chrome.runtime.sendMessage({
        type: 'azr:campaignResult', status, entered, title: pageTitle()
      });
    } catch (e) {
      AZR.warn('結果の返信に失敗:', e);
    }
  }

  AZR.register('campaign', 'campaign-entry', async () => {
    if (!/(^|\.)event\.rakuten\.co\.jp$/.test(location.host)) return;

    // 一括スキャンで開かれたタブは、パネルを出さずに結果だけ返して閉じてもらう
    let task = null;
    try {
      task = await chrome.runtime.sendMessage({ type: 'azr:scanTask' });
    } catch { /* service worker が落ちている */ }
    if (task?.task === 'campaign') return reportForScan(task);

    if (!AZR.settings.campaignEntry) return;

    await waitSettled({ quiet: 700, timeout: 9000 });
    const buttons = findEntryButtons();

    document.getElementById('azr-campaign-panel')?.remove();
    document.body.append(render(buttons));

    // ポップアップからの一括実行で開かれたタブは、自動でエントリーして閉じる
    let batch = null;
    try {
      batch = (await chrome.storage.session.get('azrBatchEntry')).azrBatchEntry;
    } catch { /* session storage 不可 */ }

    // エントリーボタンを押すとページが再読み込みされることがある。
    // 何度も押し続けないよう、このURLで一度実行したことを記録しておく。
    const doneKey = 'azrEntered:' + location.href.split('?')[0];
    let alreadyRun = false;
    try {
      alreadyRun = Boolean((await chrome.storage.session.get(doneKey))[doneKey]);
    } catch { /* session storage 不可 */ }

    const autoRun = AZR.settings.campaignAutoEntry || (batch && batch.until > Date.now());
    if (autoRun && buttons.length && !alreadyRun) {
      try { await chrome.storage.session.set({ [doneKey]: Date.now() }); } catch { /* noop */ }
      AZR.log(`自動エントリー: ${buttons.length}件`);
      await entryAll(buttons);
    }
    if (batch && batch.until > Date.now() && batch.closeTab) {
      await sleep(1500);
      try { chrome.runtime.sendMessage({ type: 'azr:closeTab' }); } catch { /* noop */ }
    }
  });
})();
