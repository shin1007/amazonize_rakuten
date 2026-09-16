/* Amazonize Rakuten - トップページからキャンペーンのリンクを集める */
(() => {
  const AZR = window.AZR;
  const { waitSettled } = AZR;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * トップページは下へ送るまで読み込まれない部分がある。
   * SPU枠やセールのバナーはそこに出るので、いったん最後まで送ってから集める。
   */
  async function scrollThrough() {
    for (let i = 0; i < 8; i++) {
      window.scrollBy(0, window.innerHeight);
      await sleep(700);
    }
    window.scrollTo(0, 0);
    await sleep(400);
  }

  function collectLinks() {
    const out = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.href;
      // バナーは rd.rakuten.co.jp/rat/?R2=... で包まれている。判別は service worker 側でやる。
      if (!/event\.rakuten\.co\.jp|rd\.rakuten\.co\.jp\/rat/.test(href)) continue;
      out.push(href);
    }
    return out;
  }

  AZR.register('top', 'top-campaign-links', async () => {
    let task = null;
    try {
      task = await chrome.runtime.sendMessage({ type: 'azr:scanTask' });
    } catch { /* service worker が落ちている */ }
    // 裏で開かれたタブの仕事は、リンクを集めて返すこと。
    if (task?.task !== 'links') {
      // 自分で開いたトップページ。ここを起点に、裏でキャンペーンを探してエントリーする。
      // 走らせるかどうか（設定・前回からの間隔・実行中か）は service worker が決める。
      // トップそのものを開いたときだけ。カテゴリ等の下層ページでは起こさない。
      if (location.pathname !== '/' || !AZR.settings.campaignScanOnTop) return;
      try {
        const r = await chrome.runtime.sendMessage({ type: 'azr:autoScanCampaigns' });
        AZR.log('トップからの自動スキャン', r);
      } catch (e) {
        AZR.warn('自動スキャンを頼めませんでした:', e);
      }
      return;
    }

    await waitSettled({ quiet: 700, timeout: 9000 });
    await scrollThrough();

    const links = collectLinks();
    AZR.log(`トップページから ${links.length} 件のリンク`);
    try {
      await chrome.runtime.sendMessage({ type: 'azr:campaignLinks', links });
    } catch (e) {
      AZR.warn('リンクの返信に失敗:', e);
    }
  });
})();
