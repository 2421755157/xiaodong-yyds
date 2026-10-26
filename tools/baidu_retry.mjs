#!/usr/bin/env node
// ═══ 百度百科 HTML 通道低频重试 ═══
//
// 为什么单独一个脚本：
//   百科的 openapi 一直通（tools/fetch_baike_api.py 走的就是它），
//   但 HTML 页面被 IP 级风控挡着（403「百度安全验证」）。
//   风控是临时的，解封后 HTML 通道能补齐 openapi 拿不到的那部分（正文更长、图组更全）。
//   定时任务每小时跑一次本脚本即可，不用人盯。
//
// 流程：探活 → 拉起无头 Edge（CDP）→ 跑 fetch_baike.mjs --missing → 关浏览器 → 报告新增
//
// 用法：
//   node tools/baidu_retry.mjs              # 探活 + 抓取
//   node tools/baidu_retry.mjs --probe-only # 只探活，不抓
//
// 退出码：0=正常（含"仍然被风控"），1=环境异常（找不到浏览器/CDP 起不来）

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DB = path.join(ROOT, 'data', 'baike_db.json');
const PORT = process.env.CDP_PORT || 9555;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const argv = process.argv.slice(2);
const PROBE_ONLY = argv.includes('--probe-only');

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function countMissing() {
  try {
    const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
    const all = Object.keys(db).length;
    const ok = Object.values(db).filter(v => v.ok).length;
    return { all, ok, missing: all - ok };
  } catch (e) {
    return { all: 0, ok: 0, missing: 0 };
  }
}

// ─── 1) 探活：直接用平时抓到的词条探，避免误判 ───
async function probe() {
  const url = 'https://baike.baidu.com/item/' + encodeURIComponent('故宫');
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36' },
      signal: AbortSignal.timeout(15000),
    });
    const html = r.status === 200 ? await r.text() : '';
    const blocked = /百度安全验证|请输入验证码/.test(html);
    return { status: r.status, blocked, ok: r.status === 200 && html.length > 5000 && !blocked };
  } catch (e) {
    return { status: 0, blocked: false, ok: false, err: e.message };
  }
}

async function waitCdp() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch (e) { /* 还没起来 */ }
    await sleep(500);
  }
  return false;
}

function run(cmd, args) {
  return new Promise(res => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
    p.on('close', code => res(code));
    p.on('error', () => res(-1));
  });
}

async function main() {
  const before = countMissing();
  console.log(`百科库：${before.all} 条记录，${before.ok} 条成功，待补 ${before.missing} 条`);

  const p = await probe();
  console.log(`探活：HTTP ${p.status}${p.blocked ? ' · 命中「百度安全验证」' : ''}${p.ok ? ' · 通道可用' : ' · 通道不可用'}`);

  if (!p.ok) {
    console.log('仍在风控中，本轮跳过。');
    return 0;
  }
  if (PROBE_ONLY) return 0;

  const exe = BROWSERS.find(f => fs.existsSync(f));
  if (!exe) {
    console.error('找不到 Edge/Chrome，无法走 HTML 通道。');
    return 1;
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'baike-cdp-'));
  console.log('启动无头浏览器：' + path.basename(exe));
  const browser = spawn(exe, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-extensions', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  try {
    if (!await waitCdp()) {
      console.error('CDP 端口未就绪。');
      return 1;
    }
    await run(process.execPath, [path.join(ROOT, 'tools', 'fetch_baike.mjs'),
      '--all', '--missing', '--conc', '2', '--gap', '600']);
  } finally {
    try { browser.kill(); } catch (e) { /* 忽略 */ }
    await sleep(800);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }

  const after = countMissing();
  const gained = after.ok - before.ok;
  console.log(`\n本轮新增 ${gained} 条；累计 ${after.ok}/${after.all}`);
  if (gained > 0) {
    console.log('CHAIN: 需要继续执行 download_baike_img.py → merge_baike.py → export_db.py');
  }
  return 0;
}

process.exit(await main());
