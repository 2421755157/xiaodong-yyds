// ═══ 百度百科批量抓取：景点主图 + 简介（并发版）═══
//
// 为什么不用 curl：baike.baidu.com 对无浏览器指纹的请求直接 403。
// 为什么不用 Runtime.evaluate：百科页面主线程繁忙，evaluate 会长时间挂住（实测超时）。
// 最终方案：CDP 拦截主文档响应，直接 Network.getResponseBody 取 HTML 源码，
// 用正则从 <head> 里提取 og:image 与 description —— 这两项服务端渲染，不依赖页面 JS。
//
// 并发：单条顺序跑实测只有 0.15/s（时间几乎全耗在等待上），
// 改成 N 个独立 target 并行后约 2/s。
//
// 用法：
//   node tools/fetch_baike.mjs --limit 20
//   node tools/fetch_baike.mjs --all
//   node tools/fetch_baike.mjs --all --missing --conc 4
//
// 断点续跑：结果写 data/baike_db.json。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'data', 'baike_db.json');
const PORT = process.env.CDP_PORT || 9555;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const argv = process.argv.slice(2);
const argOf = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const LIMIT = Number(argOf('--limit', 0));
const CONC = Math.max(1, Number(argOf('--conc', 4)));
const ONLY_MISSING = argv.includes('--missing');
const GAP = Number(argOf('--gap', 40));
const TIMEOUT = Number(argOf('--timeout', 8000));
const REBUILD = Number(argOf('--rebuild', 60));   // 每 N 条换一个干净 target

// ─── 待抓列表 ───
const { PROVINCES } = await import('../js/china-data.js');
const spots = [];
for (const p of PROVINCES) {
  for (const c of p.cities) {
    for (const s of c.spots) spots.push({ name: s.n, prov: p.n, city: c.n });
  }
}

const db = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
let todo = ONLY_MISSING ? spots.filter(s => !(db[s.name] && db[s.name].ok)) : spots;
if (LIMIT) todo = todo.slice(0, LIMIT);

const doneBefore = Object.values(db).filter(v => v.ok).length;
console.log(`景点 ${spots.length}｜已成功 ${doneBefore}｜本轮 ${todo.length}｜并发 ${CONC}`);

// ─── 一个 worker = 一个独立 target ───
async function createSession() {
  const t = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
    .then(r => r.json());
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let seq = 0;
  const pending = new Map();
  let docReq = null;
  let resolveDoc = null;

  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      return;
    }
    if (m.method === 'Network.responseReceived' && m.params.type === 'Document') {
      docReq = m.params.requestId;
    } else if (m.method === 'Network.loadingFinished' && docReq && m.params.requestId === docReq) {
      if (resolveDoc) { resolveDoc(true); resolveDoc = null; }
    }
  };
  const send = (method, params = {}, t2 = 15000) => new Promise((res, rej) => {
    const i = ++seq;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => {
      if (pending.has(i)) { pending.delete(i); rej(new Error('timeout:' + method)); }
    }, t2);
  });

  await send('Page.enable');
  await send('Network.enable');
  // 只要 HTML：屏蔽图片/字体/媒体，否则每条都要等几十个资源加载完
  await send('Network.setBlockedURLs', {
    urls: ['*.png*', '*.jpg*', '*.jpeg*', '*.gif*', '*.webp*', '*.svg*', '*.ico*',
           '*.woff*', '*.ttf*', '*.otf*', '*.mp4*', '*.webm*', '*.mp3*'],
  });

  const OG = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
  ];
  const DESC = [
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i,
  ];
  const pick = (html, pats) => {
    for (const re of pats) {
      const m = html.match(re);
      if (m) return m[1].replace(/&amp;/g, '&').trim();
    }
    return '';
  };

  async function fetchOne(title) {
    docReq = null;
    const wait = new Promise(r => { resolveDoc = r; });
    await send('Page.navigate', { url: 'https://baike.baidu.com/item/' + encodeURIComponent(title) });
    await Promise.race([wait, sleep(TIMEOUT)]);
    if (!docReq) return { ok: false, err: 'no-document' };

    const body = await send('Network.getResponseBody', { requestId: docReq }, 15000);
    let html = body.body;
    if (body.base64Encoded) html = Buffer.from(html, 'base64').toString('utf8');

    const t = ((html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '').replace(/_百度百科$/, '').trim();
    const img = pick(html, OG);
    const desc = pick(html, DESC);
    if (!img && !desc) return { ok: false, err: 'not-found', title: t };
    if (/词条不存在|抱歉，没有找到/.test(html)) return { ok: false, err: 'not-found', title: t };
    return { ok: true, title: t, img, desc: desc.slice(0, 600) };
  }

  return {
    fetchOne,
    close: async () => {
      try { ws.close(); } catch (e) { /* 忽略 */ }
      try { await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`); } catch (e) { /* 忽略 */ }
    },
  };
}

// ─── 并发主循环 ───
let hit = 0, miss = 0, fail = 0, finished = 0;
const t0 = Date.now();

const checkpoint = () => {
  try { fs.writeFileSync(OUT, JSON.stringify(db)); } catch (e) { /* 忽略 */ }
};

async function worker() {
  let sess;
  try {
    sess = await createSession();
  } catch (e) {
    console.error('worker 初始化失败: ' + e.message);
    return;
  }

  let sinceRestart = 0;
  while (todo.length) {
    const s = todo.shift();
    if (!s) break;
    // 定期换一个干净的 target：长时间复用会累积状态，
    // 实测跑几分钟后 Page.navigate 会成批超时
    if (sinceRestart > 0 && sinceRestart % REBUILD === 0) {
      await sess.close();
      try { sess = await createSession(); } catch (e) { console.error('重建会话失败: ' + e.message); break; }
    }
    sinceRestart++;
    let r;
    try {
      r = await sess.fetchOne(s.name);
      // 语料名没命中时，用「城市+景点名」再试一次（同名歧义很常见）
      if (!r.ok && r.err === 'not-found' && s.city) {
        const r2 = await sess.fetchOne(s.city + s.name);
        if (r2.ok) r = r2;
      }
    } catch (e) {
      r = { ok: false, err: 'exception:' + e.message.slice(0, 40) };
    }

    db[s.name] = { ...r, city: s.city, prov: s.prov, ts: Date.now() };
    if (r.ok) hit++; else if (r.err === 'not-found') miss++; else fail++;
    finished++;

    if (finished % 25 === 0) {
      checkpoint();
      const el = (Date.now() - t0) / 1000;
      const speed = finished / Math.max(1, el);
      const eta = Math.round((finished + todo.length) / Math.max(0.1, speed) / 60);
      console.log(`  ${finished}/${finished + todo.length} 命中 ${hit} 无词条 ${miss} 失败 ${fail} · ${speed.toFixed(1)}/s · 约剩 ${eta} 分钟`);
    }
    await sleep(GAP);
  }
  await sess.close();
}

await Promise.all(Array.from({ length: CONC }, () => worker()));
checkpoint();

const okAll = Object.values(db).filter(v => v.ok).length;
console.log(`\n完成：本轮命中 ${hit}，无词条 ${miss}，失败 ${fail}`);
console.log(`累计 ${okAll}/${spots.length} 条 → ${OUT}`);
process.exit(0);
