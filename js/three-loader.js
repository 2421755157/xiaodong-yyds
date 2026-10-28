// ═══ 3D 运行时按需加载器 ═══
// 为什么需要它：three.js（gzip 257KB）+ scenes.js/textures.js/roam.js 原本被 app.js
// 顶端静态 import，于是「看一眼景点卡片」也得先把整个 3D 引擎下完。
// 现在首屏只引 scenes-meta.js 的纯数据，真正进 3D 时才走这里。

let threePromise = null;
let panoPromise = null;

/**
 * 加载 3D 漫游所需的一切（three 内核 + 后期处理 + 场景生成器 + 漫游控制器）。
 * 重复调用复用同一个 Promise；失败后清空缓存，允许用户重试。
 * @returns {Promise<{THREE, EffectComposer, RenderPass, UnrealBloomPass, buildScene, Roamer}>}
 */
export function loadThreeRuntime() {
  if (!threePromise) {
    threePromise = Promise.all([
      import('three'),
      import('three/addons/postprocessing/EffectComposer.js'),
      import('three/addons/postprocessing/RenderPass.js'),
      import('three/addons/postprocessing/UnrealBloomPass.js'),
      import('./scenes.js'),
      import('./roam.js'),
    ]).then(([three, ec, rp, ub, scenes, roam]) => ({
      THREE: three,
      EffectComposer: ec.EffectComposer,
      RenderPass: rp.RenderPass,
      UnrealBloomPass: ub.UnrealBloomPass,
      buildScene: scenes.buildScene,
      Roamer: roam.Roamer,
    })).catch(err => {
      threePromise = null;          // 网络抖动后还能再试一次
      throw err;
    });
  }
  return threePromise;
}

/**
 * 全景查看器单独一条链：只需要 three + panorama.js，
 * 不必为了看一张全景图把 scenes.js（场景生成器）也拖下来。
 */
export function loadPanorama() {
  if (!panoPromise) {
    panoPromise = import('./panorama.js').catch(err => {
      panoPromise = null;
      throw err;
    });
  }
  return panoPromise;
}

/**
 * 是否值得空闲预热：3D 运行时合计约 1MB（gzip 约 300KB），
 * 用户开了「省流量」或者在 2G/3G 上时，这笔下载纯属浪费——
 * 等他真点进 3D 再下，反正那时也是要下的，只是不再替没兴趣的人预支。
 * @param {Navigator.connection|null} conn
 */
export function shouldWarmUp(conn) {
  if (!conn) return true;                       // 没有 Network Information API（Safari/Firefox）→ 照常预热
  if (conn.saveData) return false;              // 用户明确要求省流量
  return !/^(slow-)?2g$|^3g$/.test(conn.effectiveType || '');
}

/**
 * 空闲时段预热 3D 运行时。
 * 首屏渲染完之后调用：既不吃关键路径，又能让「进入 3D 漫游」点下去立刻有反应。
 * 用 requestIdleCallback（Safari 不支持则退回 setTimeout）。
 */
export function warmUpThree(delay = 1200) {
  if (!shouldWarmUp(navigator.connection)) return;
  const idle = window.requestIdleCallback || (fn => setTimeout(fn, delay));
  idle(() => { loadThreeRuntime().catch(() => {}); }, { timeout: 4000 });
}
