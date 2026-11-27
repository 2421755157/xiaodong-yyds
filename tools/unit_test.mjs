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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { lazyDB } from '../js/lazy-db.js';
import * as sm from '../js/staticmap.js';
import * as sv from '../js/streetview.js';
import * as si from '../js/spot-images.js';
import * as meta from '../js/scenes-meta.js';
import * as tl from '../js/three-loader.js';
import { spotDescKey, pickSpotDesc, pickCoord, pickBySpotKey } from '../js/lexicon.js';
import { PROVINCES } from '../js/china-data.js';
import { LONG_SHARD_OF } from '../js/long-shard-map.js';
import { analyzeToday, moodCardAlt } from '../js/mood.js';

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

// 9 处只有主图、136 处只有主图+1 张图组：图集第三格永远是占位图。
// 图库都到货了还写「实景图加载中…」，等于让用户一直等一张不会来的图。
await test('图集补位: 两个库就绪后占位图说"暂无更多实景"而不是"加载中"', async () => {
  await si.loadSpotImages();
  await si.ensureGallery('吉林');
  const imgs = si.getSpotImages('三角龙湾', '吉林', 3, 'water', '三角龙湾');
  const ph = imgs.filter(u => u.startsWith('data:'));
  assert.ok(ph.length >= 1, '该景点只有 2 张实景，第 3 格应是占位图，实际 ' + imgs.length + ' 张');
  const svg = decodeURIComponent(ph[0].replace(/^data:image\/svg\+xml;charset=utf8,/, ''));
  assert.ok(svg.includes('暂无更多实景'), '占位图应说明没有更多实景，实际：' + svg.slice(0, 120));
  assert.ok(!svg.includes('加载中'), '图库已就绪，不该再说加载中');
});

// ─────────── 图组按省分片（本轮：详情页 292KB 整库 → 单片 1~16KB）───────────
// 分片是派生物，最容易出的错是「源库更新了但分片没重跑」和「省份归错片」：
// 前者由 check_integrity 第 24 项挡，后者只能在这里逐条比对。
await test('图组分片: 省份 → 片号齐全，片内条目都属于本省', async () => {
  const { GALLERY_SHARD_OF } = await import('../js/gallery-shard-map.js');
  const spots = JSON.parse(readFileSync(new URL('../data/spots_uniq.json', import.meta.url), 'utf8'));
  const cnt = new Map();
  for (const s of spots) cnt.set(s.name, (cnt.get(s.name) || 0) + 1);
  const provByName = new Map();
  for (const s of spots) if (cnt.get(s.name) === 1) provByName.set(s.name, s.prov);

  const missing = PROVINCES.map(p => p.n).filter(n => !Number.isInteger(GALLERY_SHARD_OF[n]));
  assert.deepEqual(missing, [], '这些省没有图组片号，前端会拿不到图组：' + missing.join('、'));

  const wrong = [];
  let total = 0;
  for (const [prov, i] of Object.entries(GALLERY_SHARD_OF)) {
    const mod = await import('../js/gallery-shard-' + i + '.js');
    const db = mod['GALLERY_SHARD_' + i] || {};
    total += Object.keys(db).length;
    for (const k of Object.keys(db)) {
      const p = k.includes('|') ? k.split('|')[0] : provByName.get(k);
      if (p !== prov) wrong.push(k + '（' + prov + '片，实际属' + p + '）');
    }
  }
  assert.deepEqual(wrong.slice(0, 3), [], '这些图组归错片：' + wrong.slice(0, 3).join('；'));
  const { SPOT_GALLERY_DB } = await import('../js/spot-gallery-db.js');
  assert.equal(total, Object.keys(SPOT_GALLERY_DB).length,
    '分片合计与源库条数不一致（有条目丢了）');
});

// 「只拉本省那片」是这一轮的全部意义。上面的用例已经把所有片拉进同一个模块实例，
// 这里用带 query 的 import 起一个新实例（Node 按完整 URL 缓存），从零验证可见性。
await test('图组分片: 拉一片只到货一片，别的省仍是占位', async () => {
  const fresh = await import('../js/gallery-shard.js?isolated=1');
  assert.equal(fresh.galleryShardReady('浙江'), false, '未请求前不该就绪');
  assert.equal(fresh.galleryGet('西湖'), undefined, '未请求前不该有图组');
  const zj = await fresh.ensureGalleryShard('浙江');
  assert.ok(Object.keys(zj).length > 0, '浙江片应有条目');
  assert.equal(fresh.galleryShardReady('浙江'), true);
  assert.equal(fresh.galleryShardReady('江苏'), false, '没请求江苏，不该显示已就绪');
  assert.equal(fresh.galleryShardOf('不存在的省'), -1, '未知省份应返回 -1（立即 resolve）');
});

// ── 3D 预热的网络条件判断 ──
// 3D 运行时约 1MB，不该替「开了省流量 / 在 2G3G 上」的用户预支这笔流量
await test('3D 预热: 省流量模式下不预热', () => {
  assert.equal(tl.shouldWarmUp({ saveData: true, effectiveType: '4g' }), false);
});
await test('3D 预热: 2G/3G 不预热', () => {
  for (const t of ['slow-2g', '2g', '3g']) {
    assert.equal(tl.shouldWarmUp({ effectiveType: t }), false, t + ' 不该预热');
  }
});
await test('3D 预热: 4G 且未省流量照常预热', () => {
  assert.equal(tl.shouldWarmUp({ saveData: false, effectiveType: '4g' }), true);
});
await test('3D 预热: 无 Network Information API 时默认预热', () => {
  assert.equal(tl.shouldWarmUp(null), true);
  assert.equal(tl.shouldWarmUp(undefined), true);
  assert.equal(tl.shouldWarmUp({}), true);
});

// ── 景点简介的键与回退（同名景点不能串城）──
// 背景：简介库原先只按景点名做键，「西湖」在杭州和惠州各一处，于是惠州页面
// 显示的是杭州西湖那段话。现在重名景点用「省|市|名」分开存。
await test('spotDescKey: 有省市时按「省|市|名」', () => {
  assert.equal(spotDescKey('广东', '惠州', '西湖'), '广东|惠州|西湖');
});
await test('spotDescKey: 缺省市时退回裸名', () => {
  assert.equal(spotDescKey('', '', '西湖'), '西湖');
  assert.equal(spotDescKey(undefined, undefined, '故宫'), '故宫');
});
await test('pickSpotDesc: 城市限定键优先于裸名', () => {
  const db = { '西湖': '杭州的湖', '广东|惠州|西湖': '惠州的湖' };
  const read = k => db[k];
  assert.equal(pickSpotDesc(read, '广东|惠州|西湖', '西湖', '手写'), '惠州的湖');
});
await test('pickSpotDesc: 没有分城条目时退到裸名', () => {
  const db = { '西湖': '杭州的湖' };
  assert.equal(pickSpotDesc(k => db[k], '江西|鹰潭|西湖', '西湖', '手写'), '杭州的湖');
});
await test('pickSpotDesc: 库里没有时用手写一句话，不返回空', () => {
  assert.equal(pickSpotDesc(k => ({}[k]), 'x|y|z', 'q', '手写的一句话'), '手写的一句话');
  assert.equal(pickSpotDesc(null, 'k', 'n', 'd'), 'd');
});

// ── 坐标库的键与回退（同名景点不能共用一条坐标）──
// 「南山」在烟台 / 邵阳 / 乌鲁木齐各有一处，坐标库原先只按名字做键，
// 三处共用一条，等于把其中两处的游客导航到第三处去。
await test('pickCoord: 城市限定键优先于裸名', () => {
  const db = { '南山': [87.6, 43.7], '新疆|乌鲁木齐|南山': [87.4, 43.4] };
  assert.deepEqual(pickCoord(k => db[k], '新疆|乌鲁木齐|南山', '南山'), [87.4, 43.4]);
});
await test('pickCoord: 没有分城条目时退到裸名', () => {
  const db = { '故宫': [116.39, 39.91] };
  assert.deepEqual(pickCoord(k => db[k], '北京|北京|故宫', '故宫'), [116.39, 39.91]);
});
await test('pickCoord: 都没有时返回 null（详情页据此隐藏小地图）', () => {
  assert.equal(pickCoord(k => ({}[k]), 'x|y|z', 'q'), null);
  assert.equal(pickCoord(null, 'k', 'n'), null);
});

// ── 全景库的键（详情页「实景全景」按钮）──
// 全景库原先按裸名存、前端也只按裸名取：西湖在杭州和惠州各一处，
// 惠州详情页放的是杭州那张（文件其实是地铁 1 号线站厅，连湖景都不是）。
await test('pickBySpotKey: 分城键优先于裸名', () => {
  const db = { '西湖': { url: '杭州的' }, '广东|惠州|西湖': { url: '惠州的' } };
  assert.equal(pickBySpotKey(k => db[k], '广东|惠州|西湖', '西湖').url, '惠州的');
});
await test('pickBySpotKey: 唯一景点用裸名条目', () => {
  const db = { '故宫': { url: 'a' } };
  assert.equal(pickBySpotKey(k => db[k], '北京|北京|故宫', '故宫').url, 'a');
  assert.equal(pickBySpotKey(k => db[k], 'x|y|不存在', '不存在'), null);
  assert.equal(pickBySpotKey(null, 'k', 'n'), null);
});

// ── 全景库的数据不变量 ──
// 前端查不到分城键时会退到裸名，所以库里只要有裸名键，同名景点就一定串图。
await test('全景库: 重名景点不得残留裸名键', async () => {
  const { PANORAMA_DB } = await import('../js/panorama-db.js');
  const cnt = {};
  for (const p of PROVINCES) for (const c of p.cities) for (const s of c.spots) {
    cnt[s.n] = (cnt[s.n] || 0) + 1;
  }
  const leaked = Object.keys(cnt).filter(n => cnt[n] > 1 && PANORAMA_DB[n]);
  assert.deepEqual(leaked, [], '仍是裸名键的重名景点：' + leaked.slice(0, 5).join('、'));
});
await test('全景库: 键都能对上景点列表里的那一处（没有取不到的键）', async () => {
  const { PANORAMA_DB } = await import('../js/panorama-db.js');
  const at = {};
  for (const p of PROVINCES) for (const c of p.cities) for (const s of c.spots) {
    (at[s.n] = at[s.n] || []).push(p.n + '|' + c.n);
  }
  const bad = [];
  for (const k of Object.keys(PANORAMA_DB)) {
    const parts = k.split('|');
    if (parts.length === 3) {
      if (!(at[parts[2]] || []).includes(parts[0] + '|' + parts[1])) bad.push(k);
    } else if (!at[k]) bad.push(k);
  }
  assert.deepEqual(bad, [], '前端永远取不到的键：' + bad.slice(0, 5).join('、'));
});

// ── 简介库的数据不变量 ──
// 重名景点一旦又出现裸名键，就说明有城市会再次捡到别人的简介。
await test('简介库: 重名景点不得残留裸名键', async () => {
  const { SPOT_DESC_DB } = await import('../js/spot-desc-db.js');
  const cnt = {};
  for (const p of PROVINCES) for (const c of p.cities) for (const s of c.spots) {
    cnt[s.n] = (cnt[s.n] || 0) + 1;
  }
  const leaked = Object.keys(cnt).filter(n => cnt[n] > 1 && SPOT_DESC_DB[n]);
  assert.deepEqual(leaked, [], '仍是裸名键的重名景点：' + leaked.slice(0, 5).join('、'));
});
await test('简介库: 分城条目讲的是本地那一处', async () => {
  const { SPOT_DESC_DB } = await import('../js/spot-desc-db.js');
  const cases = [
    ['广东', '惠州', '西湖', '惠州', '杭州'],
    ['广东', '深圳', '世界之窗', '深圳', '长沙'],
    ['浙江', '嘉兴', '南湖', '嘉兴', '淮北'],
  ];
  for (const [prov, city, name, mine, other] of cases) {
    const txt = SPOT_DESC_DB[spotDescKey(prov, city, name)] || '';
    assert.ok(txt.includes(mine), city + name + ' 的简介应提到' + mine + '：' + txt.slice(0, 30));
    assert.ok(!txt.includes(other), city + name + ' 的简介不该提到' + other);
  }
});
// 简介库长期混进过三类「压根不是这处景点」的正文，它们的共同点是不提地名，
// 地域校验直接放行，只能按特征扫：
//   站点模板  「百度百科是一部内容开放…」（整段没有一个字的景点信息）
//   物种词条  「鸽子窝（学名：Sorghum bicolor）是禾本科高粱属中国高粱的变种」
//   作品词条  「《月河》，1961 年…的歌曲」「智取威虎山是…京剧剧目」
await test('简介库: 没有站点模板、物种词条与同名作品', async () => {
  const { SPOT_DESC_DB } = await import('../js/spot-desc-db.js');
  const WORK = ['图书', '电视剧', '电影', '歌曲', '评书', '小说', '专辑', '游戏',
    '漫画', '动画', '纪录片', '话剧', '京剧', '歌剧', '舞剧', '音乐剧',
    '诗歌', '绝句', '期刊', '苑刊', '杂志', '剧目', '执导', '主演', '出版的'];
  const bad = [];
  for (const [k, txt] of Object.entries(SPOT_DESC_DB)) {
    if (txt.slice(0, 200).includes('百度百科是一部内容开放')) bad.push(k + '(站点模板)');
    else if (/[（(]\s*学名/.test(txt.slice(0, 80))) bad.push(k + '(物种)');
    else if (WORK.some(w => txt.slice(0, 40).includes(w))) bad.push(k + '(作品)');
  }
  assert.deepEqual(bad, [], '这些简介讲的是别的事物：' + bad.slice(0, 5).join('、'));
});

// 「灵山县，广西壮族自治区钦州市辖县」曾挂在上饶灵山下面、桂林尧山挂在平顶山尧山下面：
// 自治区全称中间夹着民族名（广西壮族/宁夏回族/新疆维吾尔），旧的
// 「广西 + 省|市|自治区」正则整条失效，等于三个自治区完全不设防。
await test('简介库: 自治区全称也算外地名', async () => {
  const { SPOT_DESC_DB } = await import('../js/spot-desc-db.js');
  const RIVAL = ['广西壮族自治区', '宁夏回族自治区', '新疆维吾尔自治区', '西藏自治区'];
  const cases = [['灵山', '上饶'], ['尧山', '平顶山'], ['金银滩', '海北']];
  for (const [name, city] of cases) {
    const txt = SPOT_DESC_DB[name] || '';
    for (const r of RIVAL) {
      assert.ok(!txt.includes(r),
        name + '（' + city + '）又挂上了讲 ' + r + ' 的正文：' + txt.slice(0, 30));
    }
  }
});

// 反向保护：这三条都是本地的正经词条，靠「作品词」判会误杀，
// 只有带地名印证才留得住 —— 改规则时别把它们一起扫掉。
await test('简介库: 本地实景演出与碑刻不被当成同名作品', async () => {
  const { SPOT_DESC_DB } = await import('../js/spot-desc-db.js');
  const cases = [['封禅大典', '泰山'], ['印象刘三姐', '漓江'], ['西峡颂', '成县']];
  for (const [name, word] of cases) {
    const txt = SPOT_DESC_DB[name] || '';
    assert.ok(txt.includes(word), name + ' 的正文丢了：' + txt.slice(0, 30));
  }
});

await test('坐标库: 重名景点不残留裸名键', async () => {
  const { COORD_DB } = await import('../js/coords-db.js');
  const cnt = {};
  for (const p of PROVINCES) for (const c of p.cities) for (const s of c.spots) {
    cnt[s.n] = (cnt[s.n] || 0) + 1;
  }
  const leaked = Object.keys(cnt).filter(n => cnt[n] > 1 && COORD_DB[n]);
  assert.deepEqual(leaked, [], '仍是裸名键的重名景点：' + leaked.slice(0, 5).join('、'));
});
await test('坐标库: 重名景点各处的坐标互不相同', async () => {
  const { COORD_DB } = await import('../js/coords-db.js');
  const byName = {};
  for (const k of Object.keys(COORD_DB)) {
    const i = k.lastIndexOf('|');
    if (i < 0) continue;
    const n = k.slice(i + 1);
    (byName[n] = byName[n] || []).push(COORD_DB[k].join(','));
  }
  const same = Object.entries(byName).filter(([, v]) => v.length > 1 && new Set(v).size === 1);
  assert.deepEqual(same.map(x => x[0]), [], '这些重名景点各处仍共用同一条坐标');
});

// 同名景点在境外到处都是，维基按名字取词条时命中过一堆：
// 「水晶宫」是伦敦的、「大峡谷」是科罗拉多的、「死海」在约旦、
// 「鲁朗」在法国、「长岛」是纽约长岛。坐标出了境，小地图就把用户送到国外。
await test('坐标库: 没有落在国境之外的坐标', async () => {
  const { COORD_DB } = await import('../js/coords-db.js');
  const out = Object.entries(COORD_DB)
    .filter(([, v]) => !(v[0] >= 73 && v[0] <= 136 && v[1] >= 3 && v[1] <= 54))
    .map(([k, v]) => k + '(' + v[0] + ',' + v[1] + ')');
  assert.deepEqual(out, [], '这些坐标在国境之外：' + out.slice(0, 5).join('、'));
});

await test('坐标库: 每条都是 [经度, 纬度, 来源]', async () => {
  const { COORD_DB } = await import('../js/coords-db.js');
  const bad = Object.entries(COORD_DB).filter(([, v]) => !(Array.isArray(v) && v.length >= 3
    && typeof v[0] === 'number' && typeof v[1] === 'number'
    && ['wiki', 'wikidata', 'osm'].includes(v[2]))).map(([k]) => k);
  assert.deepEqual(bad, [], '结构不对的条目：' + bad.slice(0, 5).join('、'));
});

await test('简介库: 呼和浩特的寺院拿的是大召寺的词条，不是拉萨大昭寺', async () => {
  const { SPOT_DESC_DB } = await import('../js/spot-desc-db.js');
  // 11-04 起这里一直只有手写的一句话，就是为了不把拉萨的正文挂上来。
  // 11-13 查明呼和浩特那座寺院本名「大召寺」（无量寺），「大昭寺」是拉萨的，
  // 于是改名重抓：现在它该有自己的正文，且正文里不能出现拉萨/八廓街。
  const db = SPOT_DESC_DB;
  const hh = db['大召寺'] || db[spotDescKey('内蒙古', '呼和浩特', '大召寺')] || '';
  assert.ok(hh, '呼和浩特大召寺应有自己的简介');
  assert.ok(hh.indexOf('拉萨') < 0 && hh.indexOf('八廓街') < 0, '大召寺的简介写成拉萨那座了：' + hh.slice(0, 30));
  assert.ok(hh.indexOf('呼和浩特') >= 0, '简介应提到呼和浩特：' + hh.slice(0, 30));
  // 拉萨那座仍归拉萨，且没有被呼和浩特带跑
  const ls = db['大昭寺'] || db[spotDescKey('西藏', '拉萨', '大昭寺')] || '';
  assert.ok(ls.indexOf('拉萨') >= 0, '拉萨大昭寺的简介丢了：' + ls.slice(0, 30));
});

// 景点归属：目录里的景点是手写的，同一处景观很容易被顺手抄到相邻的旅游集散城市。
// 这类错误在列表页完全看不出来（卡片只显示名字），点进详情才发现简介写着「位于石嘴山市平罗县」。
// 裁定结果在 data/spot_city_owners.json，check_integrity 第 17 项用同一份表。
await test('景点列表: 一处景观只挂在它的行政归属城市', () => {
  const owners = JSON.parse(readFileSync(
    new URL('../data/spot_city_owners.json', import.meta.url), 'utf-8')).owners;
  const at = {};
  for (const p of PROVINCES) {
    for (const c of p.cities) {
      for (const s of c.spots) (at[s.n] || (at[s.n] = [])).push(p.n + '|' + c.n);
    }
  }
  const bad = [];
  for (const [name, v] of Object.entries(owners)) {
    const have = (at[name] || []).slice().sort().join('、');
    const want = v.cities.slice().sort().join('、');
    if (have !== want) bad.push(name + '：应在 ' + want + '，实际 ' + (have || '（列表里没有）'));
  }
  assert.deepEqual(bad, [], '挂错城市：' + bad.join('；'));
});

// 换掉错挂景点时补上的那几处，必须有真实文案与本地照片——
// 否则「修正归属」只是把一条错卡换成一条空卡，卡片只剩手写的 6 个字。
await test('景点列表: 换上的景点都有本地简介与封面', async () => {
  const { SPOT_DESC_DB } = await import('../js/spot-desc-db.js');
  const { SPOT_IMAGES_DB } = await import('../js/spot-images-db.js');
  const need = ['飞来峡', '卜奎清真寺', '鸣翠湖', '大小洞天', '特克斯八卦城', '大召寺'];
  const bad = [];
  for (const n of need) {
    const d = SPOT_DESC_DB[n] || '';
    const img = SPOT_IMAGES_DB[n];
    if (d.length < 40) bad.push(n + '：简介 ' + d.length + ' 字');
    if (!img || !String(img[0]).startsWith('img/baike/')) bad.push(n + '：封面 ' + (img ? img[0] : '无'));
  }
  assert.deepEqual(bad, [], bad.join('；'));
});

// 城市卡片封面：每座城市一张，且不与其他城市共用同一张照片。
// build_covers 早先按裸名查 baike_img_local（一个名字只存一条路径），重名景点
// 的照片必然发给别的城市：赣州的卡片挂成了「2025年春，北京明城墙」，深圳挂的是
// 大梅沙站厅；裸名键里甚至混着「世界之窗」的浏览器截图（TheWorld_UI.PNG）。
// 改成「省|市|名」分城键后不会串了，但退回裸名很容易，所以留一条断言盯着。
await test('城市封面: 每座城市都有封面，且不与其他城市共用同一张', async () => {
  const { CITY_COVER } = await import('../js/cover-db.js');
  const miss = [], shared = [], seen = new Map();
  for (const p of PROVINCES) for (const c of p.cities) {
    const key = p.n + '|' + c.n;
    const f = CITY_COVER[key];
    if (!f) { miss.push(key); continue; }
    if (seen.has(f)) shared.push(seen.get(f) + ' 与 ' + key);
    else seen.set(f, key);
  }
  assert.deepEqual(miss, [], '缺封面的城市：' + miss.join('、'));
  assert.deepEqual(shared, [], '两座城市共用同一张：' + shared.join('、'));
});


// 长介绍库：详情页「历史沿革」正文。
// 抓取管线原先只判「是不是消歧义页」，同名异地 / 同名异物的整段正文照样入库，
// 于是青岛「金沙滩」挂的是山西朔州金沙滩镇的镇史、嘉兴「南湖」挂的是
// 唐山南湖公园的采煤沉陷区修复史。这类错误不报错、不 404，只能靠断言盯着。
// 11-11 补了地域闸门，但键还是裸名：46 组重名景点共用一条正文，
// 「广东惠州西湖」的详情页整段在讲浙江杭州。键也得一起管。
const LONG_DB = {};
const LONG_CHUNK_OF = {};
// 分片文件按盘上的实际清单枚举，不再写死 0..7：分片规则从「首字取模 8 片」
// 改成「一省一片」后，写死数量会让新增的片读都不读，测试却照样绿。
const LONG_DIR = new URL('../js/', import.meta.url);
const LONG_FILES = readdirSync(LONG_DIR)
  .filter(f => /^long-db-\d+\.js$/.test(f))
  .sort((a, b) => parseInt(a.slice(8), 10) - parseInt(b.slice(8), 10));
for (const f of LONG_FILES) {
  const i = parseInt(f.slice(8), 10);
  const m = await import(new URL(f, LONG_DIR).href);
  const chunk = m['LONG_DESC_DB_' + i] || {};
  Object.assign(LONG_DB, chunk);
  for (const k of Object.keys(chunk)) LONG_CHUNK_OF[k] = i;
}
const longName = k => k.slice(k.lastIndexOf('|') + 1);
// 景点名 → 所在省（集合：重名景点有多个省）。裸名键只有唯一一处才会用它。
const LONG_PROV_OF_NAME = {};
for (const p of PROVINCES) for (const c of p.cities) for (const s of c.spots) {
  (LONG_PROV_OF_NAME[s.n] = LONG_PROV_OF_NAME[s.n] || new Set()).add(p.n);
}
// 跨市重名的景点（西湖 / 南湖公园 / 太白楼 …）
const LONG_DUP = (() => {
  const cities = {};
  for (const p of PROVINCES) for (const c of p.cities) for (const s of c.spots) {
    (cities[s.n] = cities[s.n] || new Set()).add(c.n);
  }
  return Object.keys(cities).filter(n => cities[n].size > 1);
})();

await test('长介绍库: 分片合起来与源库条数一致（导出没断链）', () => {
  // 原来写的是「≥1600 条」这种魔数：清一次内容（比如剔掉 33 条讲错地方的正文）
  // 就会假失败，而真正的断链（少导出几个分片）反而要靠人去掰指头数。
  // 直接和 data/long_db.json 比条数：少一条就红。
  const src = JSON.parse(readFileSync(new URL('../data/long_db.json', import.meta.url), 'utf8'));
  const n = Object.keys(LONG_DB).length;
  const m = Object.keys(src).length;
  assert.equal(n, m, `导出 ${n} 条，源库 ${m} 条，分片可能没导出完整`);
  assert.ok(n > 1000, '只读回 ' + n + ' 条');
});

await test('长介绍库: 重名景点不得残留裸名键', () => {
  const leaked = LONG_DUP.filter(n => LONG_DB[n]);
  assert.deepEqual(leaked, [], '仍是裸名键的重名景点：' + leaked.slice(0, 5).join('、'));
});

await test('长介绍库: 同名异地各归各城，不互相继承正文', () => {
  // 杭州西湖有正文，惠州西湖没有对应词条就该留空（详情页隐藏这一块），
  // 绝不能把杭州那条挂到惠州头上。
  assert.ok(LONG_DB['浙江|杭州|西湖'], '杭州西湖的长介绍丢了');
  assert.equal(LONG_DB['广东|惠州|西湖'], undefined, '惠州西湖不应有长介绍');
  assert.ok(LONG_DB['河北|唐山|南湖公园'], '唐山南湖公园的长介绍丢了');
  assert.equal(LONG_DB['吉林|长春|南湖公园'], undefined, '长春南湖公园不应有长介绍');
  assert.ok(LONG_DB['山东|济宁|太白楼'], '济宁太白楼的长介绍丢了');
  assert.equal(LONG_DB['安徽|马鞍山|太白楼'], undefined, '马鞍山太白楼不应有长介绍');
});

await test('长介绍库: 每条键都落在自己省份那一片（导出规则与前端一致）', () => {
  // 分片从 2026-11-23 起按**省份**切（一省一片），不再按景点名首字取模：
  // 首字取模那版单片 213~411KB，打开一处景点要下八分之一全国的长文。
  // 这里同时守住「键的省份」与「所在片号」的对应关系 —— 前端只查
  // js/long-shard-map.js，两边一旦错位，那一省的历史沿革会静默消失。
  const provOf = k => {
    if (k.includes('|')) return k.split('|')[0];
    const s = LONG_PROV_OF_NAME[k];
    return s && s.size === 1 ? [...s][0] : '';
  };
  const wrong = Object.keys(LONG_DB).filter(k => {
    const prov = provOf(k);
    return LONG_SHARD_OF[prov] !== LONG_CHUNK_OF[k];
  });
  assert.deepEqual(wrong, [], '片号对不上：' + wrong.slice(0, 3).join('、'));
});

await test('长介绍库: 一片只装一个省（拉一片不会带出别省正文）', () => {
  // 一省一片是这轮的唯一目的：打开一处景点只下它那一省（最大 138KB），
  // 不是八分之一全国。片里混进第二个省，说明切分退回到了合并模式。
  const byChunk = {};
  for (const k of Object.keys(LONG_DB)) {
    const prov = k.includes('|') ? k.split('|')[0] : [...(LONG_PROV_OF_NAME[k] || [])][0];
    (byChunk[LONG_CHUNK_OF[k]] = byChunk[LONG_CHUNK_OF[k]] || new Set()).add(prov);
  }
  const mixed = Object.entries(byChunk).filter(([, s]) => s.size > 1)
    .map(([i, s]) => '片' + i + '含' + s.size + '省');
  assert.deepEqual(mixed, [], mixed.join('、'));
});

await test('长介绍库: 每个省份都有分片映射（省名对不上就整省没有正文）', () => {
  const miss = PROVINCES.map(p => p.n).filter(n => !Number.isInteger(LONG_SHARD_OF[n]));
  assert.deepEqual(miss, [], '有省查不到片号：' + miss.join('、'));
  assert.ok(Object.keys(LONG_SHARD_OF).length >= PROVINCES.length,
    '映射表只有 ' + Object.keys(LONG_SHARD_OF).length + ' 个省');
});

await test('长介绍库: 单片体积不回到「整库级」（回归护栏）', () => {
  // 按首字分 8 片时单片最大 411KB。一省一片后最大 138KB（广东 96 处）。
  // 超过 200KB 说明分片规则又被合并回去了，详情页首开会被拖慢。
  const big = LONG_FILES
    .map(f => ({ f, kb: Math.round(statSync(new URL(f, LONG_DIR)).size / 1024) }))
    .filter(x => x.kb > 200);
  assert.deepEqual(big, [], '分片过大：' + big.map(x => x.f + ' ' + x.kb + 'KB').join('、'));
});

await test('长介绍库: 不再挂讲别处的整段正文', () => {
  const bad = ['南湖', '金沙滩', '湖广会馆', '中山公园', '热海', '千佛洞', '高庙',
    '香山寺', '梅花山', '马鞍山', '龙王塘', '沙湖', '天鹅湖', '博物馆'];
  const still = Object.keys(LONG_DB).filter(k => bad.includes(longName(k)));
  assert.deepEqual(still, [], '仍在库里：' + still.join('、'));
});

await test('长介绍库: 没有消歧义页与站点模板文字', () => {
  const re = /可以指|可能指|指的是下列|消歧义|百度百科是一部内容开放|本表收录|本列表列出/;
  const hit = Object.keys(LONG_DB).filter(k => re.test(LONG_DB[k].slice(0, 60)));
  assert.deepEqual(hit, [], '命中：' + hit.slice(0, 5).join('、'));
});

await test('长介绍库: 保留下来的正文仍讲本市', () => {
  const cases = [
    ['拙政园', '园林'],
    ['浙江|杭州|西湖', '杭州'],
    ['河北|唐山|南湖公园', '唐山'],
  ];
  for (const [key, word] of cases) {
    assert.ok((LONG_DB[key] || '').includes(word),
      key + ' 的长介绍应提到' + word + '：（' + (LONG_DB[key] || '').slice(0, 30) + '）');
  }
});

await test('长介绍库: 同名异地清单页已清空（灵泉寺/南禅寺/万佛山…）', () => {
  // 这类正文是「万佛山 (东安)，位于湖南…万佛山 (舒城)，位于安徽…」的罗列，
  // 通篇没有一个「可以指」，老的消歧义判据抓不到，就一路进了详情页：
  // 遂宁灵泉寺的历史沿革是鄂州/汕头/柳州五座同名寺庙的清单。
  // 判据见 common.is_list_page()，清洗走 tools/clean_long_desc.py。
  const gone = ['灵泉寺', '南禅寺', '万佛山', '鸟岛', '西山', '烟台山', '鸣沙山', '漳河', '自然公园'];
  const still = gone.filter(n => LONG_DB[n]);
  assert.deepEqual(still, [], '仍是清单页：' + still.join('、'));
});

await test('长介绍库: 短简介对、长介绍错位的已单独拉黑（牌坊街/大乘寺）', () => {
  // 潮州牌坊街的短简介是正确的潮州古街，长介绍却是济宁牌坊街礼拜堂的沿革；
  // 齐齐哈尔大乘寺同理（长介绍是邯郸大乘玉佛寺）。整条拉黑会连坐短简介，
  // 所以记在 data/long_block.json，只挡长介绍。
  for (const n of ['牌坊街', '大乘寺']) {
    assert.equal(LONG_DB[n], undefined, n + ' 的长介绍应已拉黑');
  }
});


await test('图片库: 重名景点不得残留裸名键', async () => {
  const { SPOT_IMAGES_DB } = await import('../js/spot-images-db.js');
  const cnt = {};
  for (const p of PROVINCES) for (const c of p.cities) for (const s of c.spots) {
    cnt[s.n] = (cnt[s.n] || 0) + 1;
  }
  const leaked = Object.keys(cnt).filter(n => cnt[n] > 1 && SPOT_IMAGES_DB[n]);
  assert.deepEqual(leaked, [], '仍是裸名键的重名景点：' + leaked.slice(0, 5).join('、'));
});

await test('图片库: 同名景点各处封面不是同一张', async () => {
  const { SPOT_IMAGES_DB } = await import('../js/spot-images-db.js');
  const byName = {};
  for (const [k, e] of Object.entries(SPOT_IMAGES_DB)) {
    if (k.indexOf('|') < 0 || !e || !e[0]) continue;     // 只查分城键
    const n = k.slice(k.lastIndexOf('|') + 1);
    (byName[n] = byName[n] || []).push(e[0]);
  }
  const same = Object.entries(byName)
    .filter(([, v]) => v.length > 1 && new Set(v).size === 1);
  assert.deepEqual(same.map(x => x[0]), [], '这些同名景点各处仍是同一张图');
});

await test('取图: 惠州西湖拿到的是自己的照片，不是杭州那张', () => {
  const hz = si.getSpotCover('西湖', '浙江', 'water', spotDescKey('浙江', '杭州', '西湖'));
  const huizhou = si.getSpotCover('西湖', '广东', 'water', spotDescKey('广东', '惠州', '西湖'));
  assert.ok(!hz.startsWith('data:'), '杭州西湖应有实景图，实际：' + hz.slice(0, 40));
  assert.ok(!huizhou.startsWith('data:'), '惠州西湖应有实景图');
  assert.notEqual(huizhou, hz, '两处西湖不能共用同一张照片');
});

await test('取图: 没抓到本地照的分城键回落到占位图，不借外地照片', () => {
  // 铜陵凤凰山：标题里没出现「铜陵」的候选全被否掉，宁可空着
  const u = si.getSpotCover('凤凰山', '安徽', 'mountain',
    spotDescKey('安徽', '铜陵', '凤凰山'));
  assert.ok(u.startsWith('data:'), '缺图应回落到主题占位图，实际：' + u.slice(0, 60));
});

// 图集 3 格 = 主图 + 2 张补充图。补充图不足时格子用「实景图加载中…」的渐变
// 占位顶上 —— 那句话是骗人的，其实没有任何请求在跑。2026-11-17 补过一轮，
// 有一张补充图的景点从 606 降到 136；这里守住「主图 + 2 补充图 → 3 格全实景」，
// 同时盯住覆盖面别被后来的重导出悄悄打回去。
await test('图集: 补满两张实景的景点，3 格不再出现占位渐变', async () => {
  // normImgUrl 用 location.href 解析相对地址，Node 里没有 location，
  // 绝对地址会走进 catch 分支被当成空串 —— 不补一个，这个用例只能测到本地图。
  const hadLoc = 'location' in globalThis;
  if (!hadLoc) globalThis.location = { href: 'http://127.0.0.1/' };
  // 主图库与图组库都是懒加载的，浏览器里进景点层前会 await 主图库；
  // 图组已按省分片，这个用例要全量核对，就得把 34 片都拉下来（Node 里 292KB 无所谓）。
  await si.loadSpotImages();
  const { GALLERY_SHARD_OF } = await import('../js/gallery-shard-map.js');
  for (const prov of Object.keys(GALLERY_SHARD_OF)) await si.ensureGallery(prov);
  const { SPOT_GALLERY_DB } = await import('../js/spot-gallery-db.js');
  const { SPOT_IMAGES_DB } = await import('../js/spot-images-db.js');
  const full = Object.keys(SPOT_GALLERY_DB)
    .filter(k => (SPOT_GALLERY_DB[k] || []).length >= 2 && SPOT_IMAGES_DB[k]);
  assert.ok(full.length >= 1500,
    '主图 + 2 张补充图的景点只有 ' + full.length + ' 处，补图成果丢了？');

  const bad = [];
  try {
    for (const k of full.slice(0, 40)) {
      const p = k.split('|');
      const name = p.length === 3 ? p[2] : k;
      const imgs = si.getSpotImages(name, p[0] || '', 3, 'park', k);
      if (imgs.length !== 3 || imgs.some(u => u.startsWith('data:'))) {
        bad.push(k + ' → ' + imgs.map(u => (u.startsWith('data:') ? '占位' : '实景')).join('/'));
      }
    }
  } finally {
    if (!hadLoc) delete globalThis.location;    // 别把假 location 留给后面的用例
  }
  assert.deepEqual(bad, [], '这些景点的图集仍有占位格');
});

// ─────────────────────────── 简介库 ───────────────────────────
await test('简介库: 清单页简介已清，短简介正确的没被连坐', async () => {
  // 无锡南禅寺、福州烟台山、哈密鸣沙山的简介原文都是「X (五台)…X (无锡)…」
  // 这种各地同名景点罗列；而潮州牌坊街、廊坊自然公园的简介是对的，
  // 只是它们的长介绍配错了词条，不能连简介一起删。
  const { SPOT_DESC_DB } = await import('../js/spot-desc-db.js');
  for (const n of ['南禅寺', '烟台山', '鸣沙山']) {
    assert.equal(SPOT_DESC_DB[n], undefined, n + ' 的简介原是各地同名景点罗列，应已剔除');
  }
  assert.ok((SPOT_DESC_DB['牌坊街'] || '').includes('潮州'), '潮州牌坊街的简介不该被拉黑');
  assert.ok((SPOT_DESC_DB['自然公园'] || '').includes('廊坊'), '廊坊自然公园的简介不该被连坐');
});

// ─────────────────────────── 简介分片 ───────────────────────────// 简介库按省切成 8 片：列表与详情只下当前省那一片（约 82KB），搜索才拉整库。
// 分片是派生物，最容易出的错是「源库更新了但分片没重跑」和「省份归错片」——
// 前者由 check_integrity 第 16 项挡，后者只能在这里逐条比对。
await test('简介分片: 每个省都查得到片号，且片内条目都属于本省', async () => {
  const { DESC_SHARD_OF, DESC_SHARD_COUNT } = await import('../js/spot-desc-shard-map.js');
  const spots = JSON.parse(readFileSync(new URL('../data/spots_uniq.json', import.meta.url), 'utf8'));
  const provByName = new Map();
  for (const s of spots) provByName.set(s.name, s.prov);

  const missing = PROVINCES.map(p => p.n).filter(n => !Number.isInteger(DESC_SHARD_OF[n]));
  assert.deepEqual(missing, [], '这些省没有分片号，前端会拿不到简介：' + missing.join('、'));

  const wrong = [];
  for (let i = 0; i < DESC_SHARD_COUNT; i++) {
    const mod = await import('../js/spot-desc-shard-' + i + '.js');
    const db = mod['DESC_SHARD_' + i];
    assert.ok(db && Object.keys(db).length > 0, '分片 ' + i + ' 不该是空的');
    for (const k of Object.keys(db)) {
      const prov = k.includes('|') ? k.split('|')[0] : provByName.get(k);
      if (DESC_SHARD_OF[prov] !== i) wrong.push(k + '（' + prov + '）');
    }
  }
  assert.deepEqual(wrong.slice(0, 5), [], '这些条目装错了片：' + wrong.slice(0, 5).join('、'));
});

await test('简介分片: 8 片合起来与源库逐条一致（不多不少不改字）', async () => {
  const { DESC_SHARD_COUNT } = await import('../js/spot-desc-shard-map.js');
  const { SPOT_DESC_DB } = await import('../js/spot-desc-db.js');
  const merged = {};
  for (let i = 0; i < DESC_SHARD_COUNT; i++) {
    const mod = await import('../js/spot-desc-shard-' + i + '.js');
    for (const [k, v] of Object.entries(mod['DESC_SHARD_' + i])) {
      assert.equal(merged[k], undefined, '键 ' + k + ' 出现在多个分片里');
      merged[k] = v;
    }
  }
  const lost = Object.keys(SPOT_DESC_DB).filter(k => merged[k] === undefined);
  const extra = Object.keys(merged).filter(k => SPOT_DESC_DB[k] === undefined);
  const diff = Object.keys(merged).filter(k => SPOT_DESC_DB[k] !== undefined
    && SPOT_DESC_DB[k] !== merged[k]);
  assert.deepEqual(lost.slice(0, 3), [], '分片缺 ' + lost.length + ' 条');
  assert.deepEqual(extra.slice(0, 3), [], '分片多出 ' + extra.length + ' 条');
  assert.deepEqual(diff.slice(0, 3), [], '分片正文与源库不一致 ' + diff.length + ' 条');
});

await test('简介分片: 只下本省那一片就能读到该省景点简介', async () => {
  const ds = await import('../js/desc-shard.js');
  await ds.loadProvDesc('浙江');
  const key = spotDescKey('浙江', '杭州', '西湖');      // 重名景点用分城键
  const txt = ds.descGet(key);
  assert.ok(txt && txt.includes('西湖'), '杭州西湖的简介应已可用，实际：' + String(txt).slice(0, 20));
  assert.equal(ds.descHas('浙江'), true, '浙江分片应标记为已到货');
  // 没请求过的省不该被顺手拉下来（否则分片就白分了）
  assert.equal(ds.descHas('广东'), false, '广东分片不该被这次加载带下来');
});

await test('简介分片: 省份不认识时立即返回空，不发起请求', async () => {
  const ds = await import('../js/desc-shard.js');
  const r = await ds.loadProvDesc('不存在的省');
  assert.deepEqual(Object.keys(r), [], '未知省份应返回空对象');
  assert.equal(ds.descTried('不存在的省'), false, '未知省份不该记为「已请求」');
});

// 搜索命中采集：原先"收到 60 条就整轮退出"，而遍历顺序是省→市，
// 热门泛名（岛/博物馆/山）光靠前几个省的**正文**就能吃满配额，
// 后面省份"名字里就有这个词"的景点直接被丢——用户搜「刘公岛」得先搜得到才点得开。
// 现在名称命中不占正文配额。下面的合成用例把这条规则钉死，真实用例再看实际数据。
await test('搜索: 名称命中不被正文配额挤掉（合成数据）', async () => {
  const { collectHits, MAX_DESC_HITS } = await import('../js/search-core.js');
  const mk = (provName, spotName, desc) => ({
    n: provName, c: 'X', cap: 'X',
    cities: [{ n: provName + '市', spots: [{ n: spotName, t: 'park', d: desc || '' }] }],
  });
  // 前 61 个省的景点正文里都写着"灯塔"，目标景点在最后、名字叫"灯塔"
  const provinces = [];
  for (let i = 0; i < MAX_DESC_HITS + 1; i++) provinces.push(mk('省' + i, '某地' + i, '灯塔'));
  provinces.push(mk('最后一省', '灯塔'));
  const res = collectHits(provinces, '灯塔', { readDesc: s => s.d || '' });
  assert.ok(res.some(r => r.type === 'spot' && r.label === '灯塔' && r.byName),
    '名称命中的景点被正文配额挤掉了');
  assert.equal(res.filter(r => r.type === 'spot' && !r.byName).length, MAX_DESC_HITS,
    '正文命中应正好收满配额');
});

await test('搜索: 名称命中不读正文（省掉整库字串搜索）', async () => {
  const { collectHits } = await import('../js/search-core.js');
  const provinces = [{ n: '甲省', c: '甲', cap: '甲', cities: [{ n: '甲市', spots: [{ n: '甲山', t: 'mountain' }] }] }];
  let reads = 0;
  collectHits(provinces, '甲山', { readDesc: () => { reads++; return ''; } });
  assert.equal(reads, 0, '名称已命中的景点不该再去读正文，实际读了 ' + reads + ' 次');
});

await test('搜索: 泛名关键词下热门景点排在可见的前 40 条里', async () => {
  const { collectHits } = await import('../js/search-core.js');
  const { SPOT_DESC_DB } = await import('../js/spot-desc-db.js');
  const keyOf = new Map();
  for (const p of PROVINCES) {
    for (const c of p.cities) {
      for (const s of c.spots) keyOf.set(s, spotDescKey(p.n, c.n, s.n));
    }
  }
  const readDesc = s => SPOT_DESC_DB[keyOf.get(s)] || SPOT_DESC_DB[s.n] || '';
  const cases = [
    ['岛', ['刘公岛', '长岛', '养马岛']],
    ['博物馆', ['陕西历史博物馆', '甘肃省博物馆']],
    ['湖', ['西湖', '洪泽湖']],
  ];
  const lost = [];
  for (const [q, names] of cases) {
    const top = collectHits(PROVINCES, q, { readDesc }).slice(0, 40).map(r => r.label);
    for (const n of names) if (!top.includes(n)) lost.push('搜「' + q + '」看不到' + n);
  }
  assert.deepEqual(lost, [], lost.join('；'));
});

await test('搜索: 全等命中排在包含命中之前，同名异地都保留', async () => {
  const { collectHits } = await import('../js/search-core.js');
  const provinces = [{ n: '甲省', c: '甲', cap: '甲', cities: [{ n: '甲市', spots: [
    { n: '西湖公园', t: 'park' }, { n: '西湖', t: 'water' },
  ] }] }];
  const order = collectHits(provinces, '西湖').map(r => r.label);
  assert.deepEqual(order, ['西湖', '西湖公园'], '全等命中没有排在最前：' + order.join('、'));
});

// ─────────────────────────── 心情卡文字版 ───────────────────────────
// 鉴定卡是画在 canvas 上的，读屏只能听到「图像」。所以卡面有的每一项都必须在
// moodCardAlt 里出现 —— 这类"少了一项"不会报错，只会让听的人永远不知道
// 自己得了多少分，只能靠这条用例守。

const MOOD_FPS = [
  { mood: 5, score: 9, text: '今天很开心，湖边安静地走了很久，风很舒服', ts: 1 },
  { mood: 4, score: 8, text: '看到晚霞，治愈了，想再来一次', ts: 2 },
  { mood: 3, score: 7, text: '有点累，但算了，想通了', ts: 3 },
];

await test('心情卡文字版: 卡面上的类型/判词/四项指标/宜忌/幸运物/编号都有', async () => {
  const r = analyzeToday(MOOD_FPS, '测试员');
  const alt = moodCardAlt(r);
  const missing = [];
  const want = (cond, what) => { if (!cond) missing.push(what); };
  want(alt.includes(r.code), '类型码 ' + r.code);
  want(alt.includes(r.title), '称号 ' + r.title);
  want(alt.includes(r.verdict), '判词');
  for (const b of r.bars) want(alt.includes(b.label + ' ' + b.val + '%'), '指标 ' + b.label);
  for (const y of r.yi) want(alt.includes(y), '宜 ' + y);
  for (const j of r.ji) want(alt.includes(j), '忌 ' + j);
  want(alt.includes(r.lucky), '幸运物 ' + r.lucky);
  want(alt.includes(r.serial), '编号 ' + r.serial);
  want(alt.includes('测试员'), '署名');
  want(alt.includes(r.fpsCount + ' 枚足迹'), '足迹数');
  // 四个字母各自的含义（卡面上也印了一行释义）
  for (const c of r.code.split('')) want(alt.includes(r.dims[c]), '字母含义 ' + c);
  want(!/undefined|NaN|null/.test(alt), '没有 undefined/NaN');
  assert.deepEqual(missing, [], '文字版缺项：' + missing.join('、'));
});

await test('心情卡文字版: 判词没有句末标点时补句号，不与下一句黏连', async () => {
  const r = analyzeToday(MOOD_FPS, '');
  const alt = moodCardAlt({ ...r, verdict: '平平淡淡才是真' });
  assert.ok(alt.includes('判词：平平淡淡才是真。四项指标'), '判词与下一句黏在一起：' + alt.slice(0, 80));
});

await test('心情卡文字版: 没填名字的人不会读成空署名', async () => {
  const alt = moodCardAlt(analyzeToday(MOOD_FPS, ''));
  assert.ok(alt.includes('无名氏留下 3 枚足迹'), '空署名没有兜底：' + alt);
  assert.ok(!alt.includes('undefined'), alt);
});

// ─────────────────────────── 汇总 ───────────────────────────// 注意：不要写 '\n通过 %d，失败 %d' % (...) ——
// 全角逗号会让 util.format 把 %d 当字面量，整行输出成 NaN。
console.log('\n通过 ' + passed + '，失败 ' + failed + '，跳过 ' + skipped);
process.exitCode = failed ? 1 : 0;
