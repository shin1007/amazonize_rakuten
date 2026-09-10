/* Amazonize Rakuten - エントリポイント / ページ種別ディスパッチ */
(() => {
  const AZR = (window.AZR = window.AZR || {});
  const modules = [];

  /** 各コンテンツモジュールはここに登録する */
  AZR.register = (kinds, name, run) => {
    modules.push({ kinds: [].concat(kinds), name, run });
  };

  const kind = AZR.pageKind();
  const root = document.documentElement;

  // ちらつき防止: 再構成するページは一旦隠す。失敗しても必ず表示に戻す。
  let unhidden = false;
  const unhide = () => {
    if (unhidden) return;
    unhidden = true;
    root.classList.remove('azr-preload');
  };
  if (kind === 'item') {
    root.classList.add('azr-preload');
    setTimeout(unhide, 10000); // フェイルセーフ
  }
  AZR.unhide = unhide;

  async function runModules(currentKind) {
    root.dataset.azrPage = currentKind;
    AZR.log('run', currentKind);
    for (const m of modules) {
      if (!m.kinds.includes(currentKind)) continue;
      try {
        await m.run();
      } catch (e) {
        AZR.warn(`module "${m.name}" failed:`, e);
      }
    }
  }

  async function main() {
    await AZR.loadSettings();
    root.dataset.azrPage = kind;
    if (!AZR.settings.enabled) return unhide();
    if (kind === 'item' && !AZR.settings.simplifyItem) unhide();

    AZR.log('boot', kind, AZR.settings);

    await runModules(kind);
    unhide();

    // かご→購入手続きはSPA内の経路変更で、ページは読み込み直されない。
    // 種別が変わったら自分のパネルを片付けて、その画面のモジュールを動かし直す。
    if (location.host === 'cart.step.rakuten.co.jp') {
      let lastKind = kind;
      AZR.onRouteChange(() => {
        const next = AZR.pageKind();
        if (next === lastKind) return;
        lastKind = next;
        for (const p of document.querySelectorAll('.azr-panel')) p.remove();
        runModules(next);
      });
    }
  }

  // 全モジュールの register が済んでから実行する
  const start = () => queueMicrotask(() => main().catch((e) => { AZR.warn(e); unhide(); }));
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  AZR.onSettingsChanged?.(() => {
    // 設定変更は再読み込みで反映（部分的な巻き戻しは行わない）
    document.getElementById('azr-reload-hint')?.remove();
  });
})();
