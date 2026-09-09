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

  AZR.register('campaign', 'campaign-entry', async () => {
    if (!AZR.settings.campaignEntry) return;
    if (!/(^|\.)event\.rakuten\.co\.jp$/.test(location.host)) return;

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
