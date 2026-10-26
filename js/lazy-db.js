// ═══ 静态数据库懒加载器 ═══
//
// 站内有多份构建期生成的静态库（简介 / 坐标 / 全景 / POI / 图集 …），
// 每份都是「一个 ES Module 导出一个大对象」。它们共同的诉求完全一样：
//   · 按需加载，不能阻塞首屏
//   · 同一份库只 import 一次（多次 import 同一 URL 浏览器虽有缓存，
//     但仍会各自创建 Promise，且缓存未命中时会重复发起请求）
//   · 加载失败要静默降级到空对象，不能让整页崩掉
//
// 之前这四件事在 app.js / streetview.js / spot-images.js 里各写了一遍，
// 行为还 subtly 不一致（例如简介库多一个 descDBReady 标志，
// 坐标库失败时返回 DB 而简介库返回 {}）。这里统一成一份实现。
//
// 用法：
//   import { lazyDB } from './lazy-db.js';
//   const COORD = lazyDB(() => import('./coords-db.js'), m => m.COORD_DB);
//   const db = await COORD.load();      // 始终 resolve（失败时为 {}）
//   COORD.get('北京故宫');               // 同步读，未加载完返回 undefined
//
// 【对外行为保持不变】
//   · 加载失败 → resolve({})，调用方无需处理异常
//   · 重复调用 load() → 复用同一个 Promise
//   · 加载成功后 get() 立即可用
export function lazyDB(importer, pick) {
  let db = null;          // 已加载的数据（null = 还没加载完）
  let promise = null;     // 加载中的 Promise
  let failed = false;     // 是否加载失败过

  function load() {
    if (db) return Promise.resolve(db);
    if (failed) return Promise.resolve({});
    if (!promise) {
      promise = importer()
        .then(m => {
          db = (pick ? pick(m) : m) || {};
          return db;
        })
        .catch(() => {
          // 静默降级：库缺失不应影响页面其余部分
          failed = true;
          db = {};
          return db;
        });
    }
    return promise;
  }

  // 同步读取：库没加载完时返回 undefined，调用方需自行判断
  function get(key) {
    return db ? db[key] : undefined;
  }

  // 取整份库（未加载完成时返回 {}）
  function data() {
    return db || {};
  }

  function has(key) {
    return !!(db && Object.prototype.hasOwnProperty.call(db, key));
  }

  // 已加载完成（无论成功失败）
  function ready() {
    return !!db;
  }

  return { load, get, data, has, ready };
}
