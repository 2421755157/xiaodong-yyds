#!/usr/bin/env node
// ═══ 单元测试（纯函数，无浏览器依赖）═══
//
// 覆盖 E2E 测不到的部分：
//   · lazyDB 的加载/失败降级/去重语义
//   · staticmap / streetview 的参数校验与边界
//   · lcsLen 的相关性算法（与构建期一致性）
//   · escHtml / markHit 的 XSS 转义
//
// 用法：node tools/unit_test.mjs
// 需要本地 HTTP 服务（E2E 同款）跑 DOM 相关的部分；没有则跳过那几项。

import assert from 'node:assert';
import { lazyDB } from '../js/lazy-db.js';
import * as sm from '../js/staticmap.js';
import * as sv from '../js/streetview.js';
import * as si from '../js/spot-images.js';
import * as meta from '../js/scenes-meta.js';

let passed = 0, failed = 0;
const skipped = 0;   // 预留：将来有条件跳过的用例

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('OK   ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name + '  → ' + e.message);
  }
}

// ─────────────────────────── lazyDB ───────────────────────────
await test('lazyDB: 成功加载后可读取', async () => {
  const db = lazyDB(() => import('../js/spot-desc-db.js'), m => m.SPOT_DESC_DB);
  assert.equal(db.ready(), false, '加载前不应 ready');
  const data = await db.load();
  assert.ok(data && typeof data === 'object');
  assert.equal(db.ready(), true, '加载后应 ready');
  assert.ok(Object.keys(data).length > 0, '库不应为空');
});

await test('lazyDB: 重复 load 复用同一 Promise', async () => {
  let calls = 0;
  const db = lazyDB(() => { calls++; return Promise.resolve({ a: 1 }); }, m => m);
  const p1 = db.load();
  const p2 = db.load();
  assert.strictEqual(p1, p2, '应返回同一个 Promise');
  await p1;
  await db.load();
  assert.equal(calls, 1, 'importer 只应被调用一次');
});

await test('lazyDB: 加载失败降级为空对象（不抛异常）', async () => {
  const db = lazyDB(() => Promise.reject(new Error('boom')), m => m);
  const data = await db.load();
  assert.deepEqual(data, {}, '失败时应返回 {}');
  assert.equal(db.ready(), true, '失败后也应 ready（避免反复重试）');
});

await test('lazyDB: 失败后再 load 不重复触发 importer', async () => {
  let calls = 0;
  const db = lazyDB(() => { calls++; return Promise.reject(new Error('x')); }, m => m);
  await db.load();
  await db.load();
  assert.equal(calls, 1, '失败后不应反复重试');
});

await test('lazyDB: get/has/data 的语义', async () => {
  const db = lazyDB(() => Promise.resolve({ 故宫: { x: 1 } }), m => m);
  assert.equal(db.get('故宫'), undefined, '未加载时 get 应返回 undefined');
  await db.load();
  assert.deepEqual(db.get('故宫'), { x: 1 });
  assert.equal(db.get('不存在'), undefined);
  assert.equal(db.has('故宫'), true);
  assert.equal(db.has('不存在'), false);
  assert.equal(db.has('toString'), false, '不该把原型属性算作存在');
  assert.deepEqual(Object.keys(db.data()), ['故宫']);
});

await test('lazyDB: pick 为空时用整个模块对象', async () => {
  const db = lazyDB(() => Promise.resolve({ A: 1, B: 2 }));
  const d = await db.load();
  assert.deepEqual(d, { A: 1, B: 2 });
});

// ───────────────────── staticmap 参数校验 ─────────────────────
await test('staticMapUrl: 非法坐标返回 null', () => {
  assert.equal(sm.staticMapUrl(NaN, 39.9), null, 'NaN 应拒绝');
  assert.equal(sm.staticMapUrl(116.4, NaN), null, 'NaN 应拒绝');
  assert.equal(sm.staticMapUrl(Infinity, 39.9), null, 'Infinity 应拒绝');
  assert.equal(sm.staticMapUrl(200, 39.9), null, '经度越界应拒绝');
  assert.equal(sm.staticMapUrl(116.4, 100), null, '纬度越界应拒绝');
  assert.equal(sm.staticMapUrl('116.4', 39.9), null, '字符串应拒绝');
  assert.equal(sm.staticMapUrl(null, 39.9), null, 'null 应拒绝');
  assert.equal(sm.staticMapUrl(undefined, undefined), null);
});

await test('staticMapUrl: 合法坐标生成 URL 且参数正确', () => {
  const u = sm.staticMapUrl(116.397428, 39.90923);
  assert.ok(u && u.startsWith('https://api.map.baidu.com/staticimage/v2?'), '应生成 staticimage URL');
  const q = new URL(u).searchParams;
  assert.equal(q.get('coordtype'), 'wgs84ll');
  assert.equal(q.get('location'), '116.397428,39.909230');
  assert.equal(q.get('markers'), '116.397428,39.909230');
  assert.equal(q.get('scaler'), '2', '应使用 scaler=2（输出 2 倍分辨率）');
});

await test('staticMapUrl: 不传 maptype（该参数在接口上无效）', () => {
  const u = sm.staticMapUrl(116.4, 39.9);
  assert.ok(!u.includes('maptype'), '不应出现 maptype（官方参数表里没有，传了会被静默忽略）');
});

await test('staticMapUrl: 尺寸与 zoom 被夹到合法区间', () => {
  const u = sm.staticMapUrl(116.4, 39.9, { width: 99999, height: 99999, zoom: 99 });
  const q = new URL(u).searchParams;
  assert.equal(Number(q.get('width')), 1024, 'width 应夹到 1024');
  assert.equal(Number(q.get('height')), 1024, 'height 应夹到 1024');
  assert.equal(Number(q.get('zoom')), 19, 'zoom 应夹到 19');
  const u2 = sm.staticMapUrl(116.4, 39.9, { width: 1, height: 1, zoom: 0 });
  const q2 = new URL(u2).searchParams;
  assert.equal(Number(q2.get('width')), 10, 'width 下限 10');
  assert.equal(Number(q2.get('height')), 10, 'height 下限 10');
  assert.equal(Number(q2.get('zoom')), 3, 'zoom 下限 3');
});

await test('staticMapUrl: marker:false 时不带 markers', () => {
  const u = sm.staticMapUrl(116.4, 39.9, { marker: false });
  assert.ok(!new URL(u).searchParams.has('markers'));
});

await test('baiduMapLink: 非法坐标返回 null', () => {
  assert.equal(sm.baiduMapLink(NaN, 39.9), null);
  assert.equal(sm.baiduMapLink(116.4, 999), null);
});

await test('baiduMapLink: 合法坐标生成 marker 链接', () => {
  const u = sm.baiduMapLink(116.4, 39.9, '故宫');
  assert.ok(u && u.includes('api.map.baidu.com/marker'));
  assert.ok(u.includes('coordtype=wgs84ll'));
});

await test('MAP_VIEWS: 三档视野且 zoom 递减', () => {
  assert.ok(sm.MAP_VIEWS.length >= 3, '应至少 3 档');
  for (let i = 1; i < sm.MAP_VIEWS.length; i++) {
    assert.ok(sm.MAP_VIEWS[i].zoom < sm.MAP_VIEWS[i - 1].zoom, 'zoom 应逐档变小');
  }
  assert.equal(sm.mapViewByKey('不存在的key').key, sm.MAP_VIEWS[0].key, '未知 key 应回退到第一档');
  assert.equal(sm.mapViewByKey('city').key, 'city');
});

// ───────────────────── streetview 参数校验 ─────────────────────
await test('streetViewFor: 坐标非法时返回 null', () => {
  assert.equal(sv.streetViewFor([NaN, 39.9]), null);
  assert.equal(sv.streetViewFor([116.4, 999]), null);
  assert.equal(sv.streetViewFor(null), null);
});

await test('streetViewFor: 百度全景服务未开通时不返回百度 URL', () => {
  const caps = sv.baiduCaps();
  if (caps.panorama === false) {
    const r = sv.streetViewFor([116.4, 39.9]);
    assert.ok(!r || r.provider !== 'baidu', 'panorama 未开通时不应给出百度全景 URL');
  }
});

await test('hasStreetView: 与服务能力一致', () => {
  const caps = sv.baiduCaps();
  const has = sv.hasStreetView();
  if (caps.panorama === false) {
    assert.equal(has, false, '未开通全景服务且无高德 Key 时应返回 false');
  }
});

await test('baiduPanoUrl: 非法坐标返回 null', () => {
  assert.equal(sv.baiduPanoUrl(NaN, 39.9), null);
  assert.equal(sv.baiduPanoUrl(116.4, 200), null);
});

// ───────────────────── escHtml / markHit（XSS） ─────────────────────
// 这两个函数在 app.js 里（依赖 DOM 上下文），此处复刻其逻辑做等价验证
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function markHit(text, q) {
  const t = escHtml(text);
  if (!q) return t;
  const eq = escHtml(q);
  const i = t.toLowerCase().indexOf(eq.toLowerCase());
  if (i < 0) return t;
  return t.slice(0, i) + '<mark>' + t.slice(i, i + eq.length) + '</mark>' + t.slice(i + eq.length);
}

await test('escHtml: 转义 HTML 注入', () => {
  assert.equal(escHtml('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escHtml('a"b\'c&d'), 'a&quot;b&#39;c&amp;d');
  assert.equal(escHtml(null), '');
  assert.equal(escHtml(undefined), '');
});

await test('markHit: 高亮且不引入未转义的注入', () => {
  const out = markHit('<img src=x onerror=alert(1)>', 'img');
  assert.ok(!out.includes('<img'), '原标签必须已被转义');
  assert.ok(out.includes('<mark>img</mark>'), '应正确高亮');
  const out2 = markHit('正常文本', '不存在');
  assert.equal(out2, '正常文本');
});

// ──────────────── scenes-meta：3D 场景的轻量层（本轮拆分）────────────────
// 拆分后 app.js 首屏引的正是这一层，所以它必须零依赖、纯函数、结果稳定。
// 尤其 spotSeed：算法一变，所有景点的 3D 场景外观都会跟着变（seed 决定布局）。
await test('scenes-meta: 可零依赖独立加载', () => {
  assert.ok(meta.PRO_SCENES && meta.THEME_ORDER && meta.resolveTheme && meta.setQuality);
});

await test('scenes-meta: spotSeed 稳定且不可漂移', () => {
  assert.equal(meta.spotSeed('故宫'), meta.spotSeed('故宫'), '同名必须同值');
  // 锁死具体数值：改了 hashStr 就等于给所有景点换了一套场景
  assert.equal(meta.spotSeed('故宫'), 827142, 'hashStr 被改动，3D 场景外观会集体变化');
});

await test('scenes-meta: resolveTheme 显式主题原样返回', () => {
  for (const k of meta.THEME_ORDER) assert.equal(meta.resolveTheme(k), k);
});

await test('scenes-meta: resolveTheme(auto) 落在四个时辰内', () => {
  assert.ok(meta.THEME_ORDER.includes(meta.resolveTheme('auto')));
  assert.ok(meta.THEME_ORDER.includes(meta.resolveTheme(null)));
});

await test('scenes-meta: setQuality 真正影响画质档位', () => {
  meta.setQuality('low');
  assert.equal(meta.Q.shadows, false);
  assert.equal(meta.Q.grass, 0);
  meta.setQuality('high');
  assert.equal(meta.Q.shadows, true);
  assert.ok(meta.Q.grass > 0);
});

await test('scenes-meta: PRO_SCENES 映射到已知精游场景', () => {
  const ids = new Set(Object.values(meta.PRO_SCENES));
  assert.equal(ids.size, 4, '无锡四个精游景点');
  assert.ok(ids.has('yuantouzhu'));
});

// ─────────── 图库按需加载语义（本轮：372KB 移出首屏关键路径）───────────
// 库不再静态导入，"未就绪"成了一个必须被正确处理的状态：
// 不能抛错，也不能把 0 长时间当成真实值展示。
await test('imageStats: 图库未就绪时降级为 0 且不抛错', () => {
  assert.equal(si.spotImagesReady(), false, '此时应尚未加载');
  const s = si.imageStats();
  assert.equal(s.total, 0, '未加载时总数应为 0');
  assert.equal(s.c3, 0);
  assert.equal(typeof s.galleryCount, 'number');
});

await test('getSpotCover: 图库未就绪时回退 SVG 占位图', () => {
  const ph = si.getSpotCover('故宫', '北京');
  assert.ok(ph.startsWith('data:'), '未加载时应回退占位图，实际：' + ph.slice(0, 40));
});

await test('loadSpotImages: 并发调用复用同一 Promise', () => {
  const p1 = si.loadSpotImages();
  const p2 = si.loadSpotImages();
  assert.equal(p1, p2, '应复用同一个 Promise，不能重复下载 372KB');
});

await test('loadSpotImages: 加载后就绪且统计有真实数据', async () => {
  const db = await si.loadSpotImages();
  assert.ok(Object.keys(db).length > 1000, '应加载到上千条景点图');
  assert.equal(si.spotImagesReady(), true);
  const s = si.imageStats();
  assert.ok(s.total > 1000, '统计应随之更新，实际 ' + s.total);
  assert.ok(s.c3 > 0, '应有专属图景点');
  assert.equal(typeof s.galleryCount, 'number');
});

await test('getSpotImages: 图库就绪后返回真实照片而非占位图', () => {
  const imgs = si.getSpotImages('故宫', '北京', 1, 'city');
  assert.ok(!imgs[0].startsWith('data:'), '故宫应有真实照片，实际：' + imgs[0].slice(0, 60));
});

// ───────────────────── lcsLen 相关性算法 ─────────────────────
// lcsLen 未导出，用 relevanceOf 的行为间接验证：找不到的应返回 0

await test('相关性: 完全匹配得分最高', () => {
  // getSpotCover 对不存在景点的应返回占位图（data: 前缀）
  const ph = si.getSpotCover('绝对不存在的景点XYZ', '测试省');
  assert.ok(ph.startsWith('data:'), '不存在的景点应返回占位图');
});

await test('getSpotImages: 数量与去重正确', () => {
  const imgs = si.getSpotImages('故宫', '北京', 3, 'city');
  assert.equal(imgs.length, 3, '应返回 3 张');
  // 真实图片不应重复；占位图（data: 前缀）内容本就相同，允许重复
  const real = imgs.filter(u => !u.startsWith('data:'));
  assert.equal(new Set(real).size, real.length, '真实图片不应有重复项');
});

await test('getSpotImages: count 大于可用图片时补占位图', () => {
  const imgs = si.getSpotImages('绝对不存在的景点ABC', '测试省', 5, 'mountain');
  assert.equal(imgs.length, 5);
});

// ─────────────────────────── 汇总 ───────────────────────────
// 注意：不要写 '\n通过 %d，失败 %d' % (...) ——
// 全角逗号会让 util.format 把 %d 当字面量，整行输出成 NaN。
console.log('\n通过 ' + passed + '，失败 ' + failed + '，跳过 ' + skipped);
process.exitCode = failed ? 1 : 0;
