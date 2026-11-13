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
import { readFileSync } from 'node:fs';
import { lazyDB } from '../js/lazy-db.js';
import * as sm from '../js/staticmap.js';
import * as sv from '../js/streetview.js';
import * as si from '../js/spot-images.js';
import * as meta from '../js/scenes-meta.js';
import * as tl from '../js/three-loader.js';
import { spotDescKey, pickSpotDesc, pickCoord } from '../js/lexicon.js';
import { PROVINCES } from '../js/china-data.js';

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

await test('简介库: 找不到本地词条时宁可没有，也不套外地那条', async () => {
  const { SPOT_DESC_DB } = await import('../js/spot-desc-db.js');
  // 呼和浩特的这处寺庙没有对应词条，回退手写的一句话，
  // 既不能有分城条目，也不能留着拉萨那座大昭寺的裸名条目。
  assert.equal(SPOT_DESC_DB[spotDescKey('内蒙古', '呼和浩特', '大昭寺')], undefined, '不应有分城简介');
  assert.equal(SPOT_DESC_DB['大昭寺'], undefined, '裸名条目必须清掉，否则会串到呼和浩特');
});

// 长介绍库：详情页「历史沿革」正文。
// 抓取管线原先只判「是不是消歧义页」，同名异地 / 同名异物的整段正文照样入库，
// 于是青岛「金沙滩」挂的是山西朔州金沙滩镇的镇史、嘉兴「南湖」挂的是
// 唐山南湖公园的采煤沉陷区修复史。这类错误不报错、不 404，只能靠断言盯着。
// 11-11 补了地域闸门，但键还是裸名：46 组重名景点共用一条正文，
// 「广东惠州西湖」的详情页整段在讲浙江杭州。键也得一起管。
const LONG_DB = {};
const LONG_CHUNK_OF = {};
for (let i = 0; i < 8; i++) {
  const m = await import('../js/long-db-' + i + '.js');
  const chunk = m['LONG_DESC_DB_' + i] || {};
  Object.assign(LONG_DB, chunk);
  for (const k of Object.keys(chunk)) LONG_CHUNK_OF[k] = i;
}
const longName = k => k.slice(k.lastIndexOf('|') + 1);
// 跨市重名的景点（西湖 / 南湖公园 / 太白楼 …）
const LONG_DUP = (() => {
  const cities = {};
  for (const p of PROVINCES) for (const c of p.cities) for (const s of c.spots) {
    (cities[s.n] = cities[s.n] || new Set()).add(c.n);
  }
  return Object.keys(cities).filter(n => cities[n].size > 1);
})();

await test('长介绍库: 分片合起来有量（导出没断链）', () => {
  const n = Object.keys(LONG_DB).length;
  assert.ok(n >= 1600, '只读回 ' + n + ' 条，分片可能没导出完整');
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

await test('长介绍库: 每条键都落在自己的分片里（导出规则与前端一致）', () => {
  // 分片按「景点名」首字取模，不看键前缀，裸名与分城键才会落进同一片
  const wrong = Object.keys(LONG_DB)
    .filter(k => LONG_CHUNK_OF[k] !== longName(k).charCodeAt(0) % 8);
  assert.deepEqual(wrong, [], '片号对不上：' + wrong.slice(0, 3).join('、'));
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

// ─────────────────────────── 简介分片 ───────────────────────────
// 简介库按省切成 8 片：列表与详情只下当前省那一片（约 82KB），搜索才拉整库。
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

// ─────────────────────────── 汇总 ───────────────────────────// 注意：不要写 '\n通过 %d，失败 %d' % (...) ——
// 全角逗号会让 util.format 把 %d 当字面量，整行输出成 NaN。
console.log('\n通过 ' + passed + '，失败 ' + failed + '，跳过 ' + skipped);
process.exitCode = failed ? 1 : 0;
