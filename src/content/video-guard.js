/*
 * Amazonize Rakuten - 商品動画の自動再生を止める（MAINワールドで動く）
 *
 * 商品動画のプレーヤー（stream.cms.rakuten.co.jp の動画スクリプト）は、
 * 画面に6割見えた時点・読み込み終わった時点・マウスを載せた時点に、自分で video.play() を呼ぶ。
 * ギャラリーに動画を並べると、選んだだけで再生が始まってしまう。
 *
 * そこで play() を差し替え、そのプレーヤーの中を押した直後（再生ボタンや操作バー）以外は
 * ブラウザが自動再生を拒んだときと同じ NotAllowedError で断る。プレーヤーはこの拒否を
 * 想定していて、再生ボタンを出したまま待つ。
 *
 * play() はページ側の関数なので、コンテンツスクリプト（分離ワールド）からは差し替えられない。
 * 止めるのは item.js が再構成したときだけ（<html data-azr-no-autoplay>）。
 */
(() => {
  const USER_GRACE_MS = 1000;
  let lastInput = { target: null, at: 0 };

  const note = (e) => {
    if (e.isTrusted) lastInput = { target: e.target, at: performance.now() };
  };
  window.addEventListener('pointerdown', note, true);
  window.addEventListener('keydown', note, true);

  /** そのプレーヤーの中を、いま押したところか */
  function pressedInside(media) {
    const { target, at } = lastInput;
    if (!(target instanceof Node) || performance.now() - at > USER_GRACE_MS) return false;
    const box = media.closest('.video-player') || media.parentElement || media;
    return box.contains(target);
  }

  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function play(...args) {
    try {
      if (document.documentElement.hasAttribute('data-azr-no-autoplay') && !pressedInside(this)) {
        return Promise.reject(new DOMException('Amazonize Rakuten: 自動再生を止めました', 'NotAllowedError'));
      }
    } catch { /* ページ側の再生は絶対に壊さない */ }
    return nativePlay.apply(this, args);
  };
})();
