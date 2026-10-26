# 数据管线 · Tools

站内所有「真实资料」（景点照片、景点简介、省市简介）都不是手写的，而是由这套脚本
从 Wikimedia（中文维基百科 / Wikimedia Commons）抓取后生成静态库。
**脚本与原始缓存（`data/`）都在仓库里，任何时候都能重跑、断点续跑、增量更新。**

## 环境要求

- Python 3.9+（**只用标准库**，无需 pip 安装）
- Node.js 16+（仅 `build-spot-index.mjs` 需要，用来读 `js/china-data.js`）
- 网络：需要能访问 `zh.wikipedia.org` / `commons.wikimedia.org`
  - 国内直连不通时，走本地代理：`set PROXY=http://127.0.0.1:7890`（默认就是它）

## 目录

```
tools/
├── common.py              公共模块：代理、清洗、相关性判定、敏感词过滤
├── build-spot-index.mjs   从 js/china-data.js 生成景点/省市索引
├── fetch_descriptions.py  抓简介（景点 + 省市）→ spot-desc-db.js / region-desc-db.js
├── fetch_images.py        抓照片（主图 / 补充图组）→ data/img_db.json
├── export_db.py           导出图片库（去重 + 敏感过滤）→ spot-images-db.js / spot-gallery-db.js
├── fetch_long_desc.py    抓历史沿革长介绍 → js/long-db-0..7.js（8 片按需加载）
├── fetch_panorama.py     抓真实全景图 → js/panorama-db.js（sphere/wide）
├── fetch_coords.py       抓景点坐标 → js/coords-db.js（维基 + Wikidata，无需密钥）
├── resolve_disambig.py   消歧义词条重定向（「盘山可以指：…」→ 正确条目）
├── check_integrity.py    静态集成检查（DOM id / import 路径 / 导出名）
└── e2e_check.mjs         端到端测试（CDP 直连浏览器，20 项交互断言）

data/                     原始缓存（断点续跑用，可直接提交进仓库）
├── spots_uniq.json        1779 个景点索引
├── regions_uniq.json      388 个省市索引
├── desc_db.json           景点简介原始数据
├── region_db.json         省市简介原始数据
└── img_db.json            图片原始数据（含补充图组）
```

## 提交前自检

```bash
python tools/check_integrity.py    # 0 个问题才提交
node tools/e2e_check.mjs           # 20/20 才提交（需先起服务与浏览器调试端口）
```
它会检查：JS 里引用的每个 `$('#id')` 在 index.html 里是否存在、
每条 `import` 路径是否有对应文件、每个具名导入在目标文件里是否真的被导出
（`export const/function/class` 与 `export { a, b }` 两种形式都认）。
改完 UI 记得跑一次——这类问题肉眼很难发现。

## 典型流程

```bash
# 0) 重建索引（改了 js/data/*.js 之后跑）
node tools/build-spot-index.mjs

# 1) 补简介（会跳过已有的，只抓缺失的；断点续跑）
python tools/fetch_descriptions.py --spots 100      # 本轮最多补 100 个景点
python tools/fetch_descriptions.py                   # 全量补齐

# 2) 补照片
python tools/fetch_images.py --mode main --limit 200    # 主图（严格相关性）
python tools/fetch_images.py --mode gallery --limit 500  # 补充图组

# 3) 导出前端库
python tools/export_db.py
```

`fetch_descriptions.py --export-only` 只用 `data/` 里的缓存重新生成前端库，不联网。

## 关键设计（踩过的坑，别改错）

**1. 图片相关性只能严格，不能放宽。**
放宽阈值会引入大量错图：实测 419 条候选里「宽松匹配」换上 123 张图，
严格复验后 **129 张是错图**——「东方山」配成上海的东方明珠、「张澜故居」配成范文澜故居、
「碛口古镇」配成高速公路。冷门景点在维基没有词条，搜索只能返回同城「沾亲带故」的条目，
字符重合 + 城市命中**不足以**证明正确性。
→ 宁可保留城市实景兜底，也不要错配。`fetch_images.py --mode main` 的判定是：
词条标题直接含景点名，或词条首段含景点名且城市命中。

**2. 同一文件的不同尺寸缩略图是同一张照片。**
`.../960px-Xxx.jpg` 与 `.../1200px-Xxx.jpg` 是同一张图，必须**按文件名去重**（`base_of()`），
按 URL 去重会漏。

**3. 导出会过滤政治敏感内容。**
涉独/分裂类图像一律剔除（`common.BLOCK`）；主图若命中则回退到上一版干净主图，
没有干净替代就剔除该条交由前端占位图。

**4. 抓取要「打乱 + 断点续跑」。**
代理不稳时批量请求会成片失败；若不随机打乱待查顺序，失败的那批会被反复重试，
吞吐接近 0。`fetch_descriptions.py` 每次运行都会 shuffle 待查集合，
`data/*.json` 记录已抓到的条目，中断后重跑自动接着来。

**5. 缓存为空时禁止覆盖前端库。**
`export_db.py` 与 `fetch_descriptions.py` 都有保护：缓存为空直接退出，
避免一次误操作把线上库清空。

**6. 消歧义页不能直接当简介用。**
维基里「盘山」「磁器口」「外八庙」这类词条是消歧义页，导语是「XX可以指：…」的候选列表，
直接显示在卡片上很糟（曾有 106 条中招）。`resolve_disambig.py` 会从消歧义页的链接里
按「标题含景点名 + 含本市名 + 地标后缀 + 出现顺序」打分选出正确条目再重抓；
实在定不了（如「直隶总督署」保定天津两处都有）就清空并回退手写文案。

**7. 全景图有三种「看起来像全景」的东西，要分开。**
- **sphere**（等距柱状，宽高比 ≈ 2:1）→ 能做球面贴图，真正 360° 环视
- **wide**（宽幅拼接，宽高比 > 2.4）→ 只能横向拖拽
- **假的**：清代绢本长卷（故宫博物院藏）宽高比能到 33:1，容易被误判成全景 →
  必须用「非照片黑名单」（绢本/设色/拓片/舆图/painting/scroll…）拦掉
- **城市冲突**：搜「天坛 全景」会搜到「塔顶鸟瞰汕头全景」→ 用标题里出现的
  城市名（取自自己的城市清单）做交叉校验，别名景点一律不收

**8. 运行时（浏览器端）的图片搜索也必须有相关性门槛。**
构建期再严格，浏览器端 `searchCommons` 也可能搜进错图——当初「台独旗帜」就是这么
混进来的（它还绕过了构建期的敏感词过滤）。现在运行期与构建期用同一套规则：
文件名相关性 + 敏感词拦截，宁可不换。

**9. 别用 `git add -A` 提交导出结果前先核对条数。**
曾出现过：抓取脚本被中断后把缓存覆盖成旧快照，随后的 `git add -A` 把缩水版一起提交，
丢了 99 条简介。**提交前务必核对「缓存条数 == 导出条数」。**

**10. 地图服务的「AK 存在 ≠ 接口可用」。**
百度控制台的应用要逐个申请服务，未开通的接口一律返回 `240 APP 服务被禁用`。
曾按「AK 非空就显示按钮」的思路写前端，结果静态图接口能用、实景街景接口不能用，
用户点下去只会看到一张报错破图。
现在改为**构建期实测**：`probe_baidu_api.py` 逐个探测各服务，把结果写进
`js/config.js` 的 `BAIDU_CAPS`，前端据此决定按钮显隐。
开通服务后重跑 `python tools/probe_baidu_api.py --write` 即可自动更新。
同理 `fetch_poiid.py` 也加了前置探测，服务没开通就快速失败退出，
而不是跑完 773 条得到一库空值。

**11. 百度静态图的参数边界（与文档不符，必须实测）。**
- 官方参数表**没有 `maptype`**，传 `maptype=2` 取卫星图会被静默忽略，
  四种取值返回完全相同的图（md5 一致）；瓦片服务 `maponline*.bdimg.com/tile/`
  现已 404，静态图接口做不出卫星图 → 不要做假的「卫星图」按钮
- `markers` 一旦带样式后缀（`|color:red|label:xx`）整图退化成 **1×1 像素**
  → 只能传纯坐标；`markerStyles` 作为独立参数反而正常
- `scale=2` 时 width/height 上限只有 **512**，且 zoom 会自动 +1；
  改用 `scaler=2` 可放到 1024（输出 2048px 高清）且 zoom 不变
- 接口不返回 CORS 头 → 只能用 `<img>` 加载，不能 fetch 取字节
- 失败时返回 JSON（`status` 220/240/502/503…）而非 PNG，前端靠 `onerror` 兜底
复现命令：`python tools/probe_staticmap_params.py`

**12. E2E 里要模拟生产域名的 Referer，别用 setExtraHTTPHeaders。**
百度静态图要求 Referer 在白名单内（线上是 `2421755157.github.io`），
本地 localhost 必然被拒。但用 `Network.setExtraHTTPHeaders` 注入 Referer 会给
**所有**请求都加上该头，包括本地 index.html 本身 → 导航直接失败成
`chrome-error://chromewebdata/`。
正确做法是用 Fetch 域按 URL 匹配拦截：
```js
await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*api.map.baidu.com*', requestStage: 'Request' }] });
// 收到 Fetch.requestPaused 时 continueRequest 并补上 Referer 头
```
另外复用浏览器已有标签页做测试要小心：可能连到 `edge://` 弹窗页这类 opaque origin，
`localStorage` 会抛 SecurityError。应当用 `PUT /json/new` 显式新建 target。

**13. 冷门景点的中文名 ≠ 维基词条名，必须先搜索反查。**
抽样 60 个「短简介里已有、但没长介绍」的景点，按原名直接查词条：
43 个**根本不存在**（404）、9 个是消歧义页、只有 5 个真有正文 → 命中率不到 10%。
原因：冷门景点的中文名常与维基词条名不一致（「清名桥古运河」的词条叫「清名桥」，
「淹城春秋」叫「淹城」）。
解决：`common.search_title(name, city, prov)` 先按「城市+名 / 名+城市 / 省+名 / 名」
四种组合搜，取标题里包含景点名且长度差 ≤4 的那条，再抓正文。
加进 `fetch_long_desc.py` 的**阶段B**后，151 个候选命中 90 个（60%）。

**14. 消歧义判定要看「可能是指」，不能只查「可以指」。**
`is_disambig` 原实现只查开头 40 字里的「可以指」，
但「南湖公园，可能是指：…」这种带逗号的写法会漏过 →
43 条消歧义内容直接混进长介绍，用户能看到「南湖公园 (南宁) 南湖公园 (天津) …」。
已改为全正则匹配（`可以指|可能指|指下列|消歧义|是指[:：]|或指`），
并加 `tools/clean_long_disambig.py` 清洗历史数据。
**判定规则要统一**：`common.is_disambig()` 是唯一实现，
`resolve_disambig.py` 原本有一份自己的副本，已改为 import 公共版本。

**15. JS 里 `console.log('…%d…' % x)` 遇到全角标点会输出 NaN。**
`'\n通过 %d，失败 %d' % (24, 0)` 实测输出 `NaN` ——
`util.format` 把 `%d` 后的**全角逗号**当成格式串的一部分，
整行格式化失败退回 NaN。Python 的 `%` 格式化没这个问题（只在 JS 里）。
写测试汇总行时用字符串拼接，别用 `%` + 全角标点。

**16. `opts.zoom || 15` 这种写法会绕过下限检查。**
`0` 是 falsy → `zoom=0` 会被当成 15，正好绕过了 `[3,19]` 的下限校验。
要写成 `Number.isFinite(opts.zoom) ? opts.zoom : 15` 再夹取。
这是单元测试（`tools/unit_test.mjs`）当场抓出来的。

**17. 前端懒加载库要统一用一个实现，别各写一遍。**
原来 `ensureDescDB` / `ensureCoordDB` / `ensurePanoDB` / `ensurePoiid` / `ensureGallery`
是同一模式的五份拷贝，行为还不一致（简介库多一个 `descDBReady` 标志，
坐标库失败时返回 DB 而简介库返回 {}）。
统一到 `js/lazy-db.js` 的 `lazyDB(importer, pick)`：
加载失败 → resolve({}) 且不再重试；重复 load 复用同一 Promise。

**18. 静态 import 会把它「顺带需要」的东西全拖进首屏——包括 CDN 上的 257KB。**

症状：首屏只是渲染 34 张省份卡片，却要等 `three.module.js` 下载完。
根因：`app.js` 只为了拿 `PRO_SCENES`（4 条映射）和 `spotSeed`，
就静态 `import { ... } from './scenes.js'`，而 scenes.js 顶层 `import * as THREE from 'three'`。

排查方法（别靠猜）——从入口递归解析**静态** import，算 gzip 总和：

```python
STATIC = re.compile(r"^\s*(?:import\s+[^;]*?from\s+|import\s+)['\"]([^'\"]+)['\"]", re.M)
# 只跟相对路径；import('./x') 是动态的，不算关键路径
```

实测：改前 486 KB(gzip)，改后 124 KB，降 74%。

解法三件套：
1. **纯数据与引擎分离**：把 `PRO_SCENES`/时辰主题/种子抽成零依赖的 `scenes-meta.js`
2. **动态 import**：`loadThreeRuntime()` 里 `Promise.all([import('three'), ...])`
3. **空闲预热**：`requestIdleCallback` 里提前拉，用户点进去时已就绪，两头都不亏

**注意保留兼容再导出**：`scenes.js` 末尾 `export { ... } from './scenes-meta.js'`，
老写法 `import { PRO_SCENES } from './scenes.js'` 不至于当场炸。

**19. `check_integrity.py` 曾经只校验静态 import，动态 import 是盲区。**

原实现只匹配 `from './x.js'`。改成按需加载后，代码里出现大量 `import('./x.js')`，
路径写错不会在静态检查阶段暴露，要等用户真点到那个功能才 500。

已补上 `import\(['"](\./...)['"]\)` 的匹配，并做了负向验证
（故意把 `./scenes.js` 改成 `./scenes-WRONG.js`，确认能报出来）。

**这类检查一定要做负向验证**——"检查通过"并不等于"检查有效"。

**20. 批量脚本改 CRLF 文件时，用 `\n` 拼的多行模式一定匹配失败。**

本仓库 `core.autocrlf=true`，工作区文件是 CRLF。用
`io.open(p, encoding='utf-8', newline='').read()` 读到的是带 `\r` 的内容，
Python 里写的 `"...\n..."` 多行字面量对不上，`str.replace` 静默什么都不做。

稳妥写法：
```python
raw = io.open(p, 'rb').read().decode('utf-8')
crlf = '\r\n' in raw
d = raw.replace('\r\n', '\n')     # 先归一化再匹配
...                                # 处理
if crlf: d = d.replace('\n', '\r\n')   # 写回时还原
io.open(p, 'wb').write(d.encode('utf-8'))
```
并且每个 `replace` 都配 `assert d.count(old) == 1`——
批量改代码最怕"以为改了其实没改"。

**21. 断言写死绝对路径，在子路径部署下会变成"假阳性"。**

守首屏依赖的那条断言原来写 `fetch('/js/app.js')`——本地服务在根路径，
测试全绿；线上部署在 `/xiaodong-yyds/` 子路径，这个 fetch 直接 404。

**最坑的是它仍然"通过"了**：404 返回的是 HTML 错误页，
`/from\s+['"]three['"]/` 一条都不匹配 → `bad` 为空 → 断言判为干净。
同时那个 404 又污染了「无控制台错误」断言，两条互相打架，很难看出根因。

正确写法两件事一起做：
1. 路径改成相对页面 URL 的 `'./js/app.js'`
2. `fetch` 后**显式检查 `r.ok`**，非 2xx 直接抛错，别让错误页混进正则

教训：**测试跑绿不代表测试有效。** 换一个部署路径、做一次负向注入，
往往能暴露出「断言恒为真」这种更危险的问题。

**22. Wikimedia 图片域名在国内已不可达，而这一点很难被发现。**

`upload.wikimedia.org` 与 `thumb.wikimedia.org`（后者是 CNAME 到 dyna.wikimedia.org 的
合法域名）在浏览器里 `naturalWidth === 0`，**照片区域是空白**，
但页面本身不报错、`img.src` 看着完全正常。

**只有清缓存才能测出来**：
```js
await send('Network.clearBrowserCache');   // 关键
// 然后检查 img.naturalWidth > 0，而不是检查 img.src 有没有值
```
有缓存时图片能显示，会让人误以为一切正常。E2E 里那条
`景点封面图片真实解码` 就是为此加的——它断言的是 `naturalWidth`，
不是 `src` 非空。

**23. 百度百科：curl 403，Runtime.evaluate 会挂死，正确姿势是取 HTML 源码。**

- `curl baike.baidu.com/item/xxx` → **403**（无浏览器指纹）
- `Runtime.evaluate('document.title')` → **长时间不返回**（页面主线程繁忙）
- **正解**：`Network.getResponseBody` 直接拿主文档 HTML，正则解析 `<head>`：
  ```js
  Network.responseReceived (type==='Document') → 记 requestId
  Network.loadingFinished 同 id → Network.getResponseBody
  ```
  `og:image` 与 `name="description"` 都在服务端渲染的 head 里，不依赖 JS。
  单条约 0.3 秒，比 evaluate 快且不会挂。

**24. 抓取频率过高会被百度风控（403「百度安全验证」），而且恢复很慢。**

实测 8.6 条/秒跑了 1700 条后，**整批变成 not-found**——
不是词条不存在，是返回了「百度安全验证」页面（HTTP 403，HTML 里没有 og:image），
被脚本误判成 `not-found`。之后即使降到 1 条/2 秒、等 40 分钟仍未解封。

三条教训：
1. **判失败要区分「词条不存在」和「被风控」**——检查响应状态码与
   `百度安全验证` 关键字，否则会把风控误记成数据缺失，越抓越错
2. 并发抓百科控制在 **2-3 并发 + 200ms 间隔**以内
3. 跑几分钟后换一个干净 target（`--rebuild 60`），
   否则 `Page.navigate` 会成批超时

**25. 百度图片 CDN 有防盗链，且 Three.js 的 TextureLoader 绕不过去。**

`bkimg.cdn.bcebos.com`：
- 不带 Referer → 200
- 带任意 Referer（含本站域名）→ **403**

`<img>` 可以加 `referrerpolicy="no-referrer"` 绕过，
但 3D 场景里 `new THREE.TextureLoader().load(url)` 没有这个选项，
实景看板必然 403、控制台报错。

**所以最终选择下载到本地**（`img/baike/`）：同源请求，一劳永逸。
178 张共 12MB，用景点名的 md5 命名（避免中文路径在 Windows/GitHub Pages 上的编码问题）。

> 注意：不要为了绕防盗链给整站加 `<meta name="referrer" content="no-referrer">`。
> 百度**静态地图**反过来要求 Referer 在白名单内，全局关掉会让小地图直接挂掉。
