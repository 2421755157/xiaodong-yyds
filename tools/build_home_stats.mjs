#!/usr/bin/env node
// ═══ 生成首页数据条统计（构建期）⭐
//
// 为什么不在运行时算：
//   首页那 4 个数字（实景照片 / 景点专属图 / 多图景点 / 真实简介）原来是在
//   renderHomeStats 里 load 三个懒加载库再数出来的——为了 4 个数字，
//   首屏要白拉 spot-images-db（118KB）、spot-gallery-db（100KB+）、
//   spot-desc-db（596KB，gzip 后 250KB），而它们真正用上要等用户点进景点层。
//
//   所以改成构建期直接导入这三个库数一遍，写成一个几十字节的常量文件。
//   走 import 而不是自己解析文件，保证口径与运行时完全一致（同一份数据、同一段逻辑）。
//
// 用法：node tools/build_home_stats.mjs
// 时机：export_db.py / fetch_descriptions.py 导出之后跑（CI 或发布前）

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const JS = path.join(ROOT, 'js');
const imp = f => import(pathToFileURL(path.join(JS, f)).href);

const [{ SPOT_IMAGES_DB }, { SPOT_GALLERY_DB }, { SPOT_DESC_DB }] = await Promise.all([
  imp('spot-images-db.js'), imp('spot-gallery-db.js'), imp('spot-desc-db.js'),
]);

const vals = Object.values(SPOT_IMAGES_DB);
const stats = {
  photos: vals.length,                      // 有主图的景点
  exclusive: vals.filter(v => v[1] >= 3).length,   // 景点专属图（置信 3）
  gallery: Object.keys(SPOT_GALLERY_DB).length,    // 有多图的景点
  desc: Object.keys(SPOT_DESC_DB).length,          // 有真实简介的景点
};

const body = '// ═══ 首页数据条统计（构建期生成，勿手改）═══\n' +
  '// 生成：tools/build_home_stats.mjs（口径 = 运行时 imageStats/DESC_DB 的同一份数据）\n' +
  '// 放在这里是为了让首屏不必为了 4 个数字去拉 800KB 的图库与简介库。\n' +
  'export const HOME_STATS = ' + JSON.stringify(stats) + ';\n';

writeFileSync(path.join(JS, 'home-stats.js'), body);
console.log('首页统计：' + JSON.stringify(stats) + ' → js/home-stats.js');
