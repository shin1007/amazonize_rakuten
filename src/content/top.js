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

  // 自分で開いたトップページのバナー（下へ送って読み込む枠・後から差し込まれる枠）は、
  // HTMLを取り直しても入っていない。自動スキャンにはこのDOMのリンクも渡す（boot.js）。
  AZR.collectCampaignLinks = async () => {
    await waitSettled({ quiet: 700, timeout: 9000 });
    await scrollThrough();
    return collectLinks();
  };

  AZR.register('top', 'top-campaign-links', async () => {
    let task = null;
    try {
      task = await chrome.runtime.sendMessage({ type: 'azr:scanTask' });
    } catch { /* service worker が落ちている */ }
    // 裏で開かれたタブの仕事は、リンクを集めて返すこと。
    // 自分で開いたトップページでは何もしない（自動スキャンの起こし役は boot.js に移した）。
    if (task?.task !== 'links') return;

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
