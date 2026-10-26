#!/usr/bin/env node
// ═══ 构建景点 / 省市索引（供 Python 抓取管线使用）═══
// 用法：node tools/build-spot-index.mjs
// 产出：data/spots_uniq.json   [{name, city, prov, t}]      去重后的景点
//       data/regions_uniq.json [{key, name, alt, prov, city}] 省 / 市
import { PROVINCES } from '../js/china-data.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const spots = [];
const seen = new Set();
const regions = [];

for (const p of PROVINCES) {
  regions.push({ key: 'p:' + p.n, name: p.n, alt: [p.n + '省', p.n + '市', p.n + '自治区'], level: 'prov' });
  for (const c of p.cities) {
    regions.push({ key: 'c:' + p.n + '|' + c.n, name: c.n, alt: [c.n + '市', p.n + c.n], level: 'city', prov: p.n, city: c.n });
    for (const s of c.spots) {
      if (seen.has(s.n)) continue;
      seen.add(s.n);
      spots.push({ name: s.n, city: c.n, prov: p.n, t: s.t });
    }
  }
}

fs.writeFileSync(path.join(dataDir, 'spots_uniq.json'), JSON.stringify(spots));
fs.writeFileSync(path.join(dataDir, 'regions_uniq.json'), JSON.stringify(regions));
console.log('景点', spots.length, '条；省/市', regions.length, '条 → data/');
