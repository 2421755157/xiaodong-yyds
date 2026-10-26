// ═══ 运行环境探测（零依赖，可被首屏静态引入）═══
// 单独成模块的原因：isMobile 原本定义在 roam.js 里，而 roam.js 顶层 import 了 three。
// app.js 首屏只是想知道"是不是手机"，却因此被迫加载整个 3D 引擎。

/** 移动/触屏设备判定：UA 命中移动端关键字，或触屏且视口较窄 */
export const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  || ('ontouchstart' in window && window.innerWidth < 1024);

/** 是否支持 WebGL（3D 入口按此决定是否显示，避免点了才发现跑不起来） */
export function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch (e) {
    return false;
  }
}
