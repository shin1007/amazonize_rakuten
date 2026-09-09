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
    setTimeout(unhide, 3000); // フェイルセーフ
  }
  AZR.unhide = unhide;

  async function main() {
    await AZR.loadSettings();
    root.dataset.azrPage = kind;
    if (!AZR.settings.enabled) return unhide();
    if (kind === 'item' && !AZR.settings.simplifyItem) unhide();

    AZR.log('boot', kind, AZR.settings);

    for (const m of modules) {
      if (!m.kinds.includes(kind)) continue;
      try {
        await m.run();
      } catch (e) {
        AZR.warn(`module "${m.name}" failed:`, e);
      }
    }
    unhide();
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
