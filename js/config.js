// ═══ 可选服务配置 ═══
//
// 【百度地图 · 服务开通状态】
//   ⚠ 关键：AK 存在 ≠ 接口可用。百度控制台的「服务」要逐个申请，
//     未开通的接口一律返回 240「APP 服务被禁用」。
//     所以下面 BAIDU_CAPS 是 tools/probe_baidu_api.py 实测出来的真实状态，
//     前端靠它决定按钮显隐 —— 否则会显示一个点了必炸的按钮。
//
//   已开通（实测 200）：
//     · staticimage/v2 静态图 → 详情页「位置小地图」
//   未开通（实测 240 APP服务被禁用）：
//     · panorama/v2        全景静态图 → 实景街景按钮暂时不显示
//     · place/v2/search    地点检索   → poiid 采集脚本会直接报错退出
//     · reverse_geocoding  逆地理编码
//
//   开通后重跑一次即可自动更新：
//     python tools/probe_baidu_api.py --write
//
// 【百度地图 · 静态图 · 申请步骤】
//   1) 注册 https://lbsyun.baidu.com/ → 控制台创建应用 → 选「浏览器端 AK」
//   2) 在「安全设置」里把 Referer 白名单加上本站域名：
//        2421755157.github.io
//        （本地调试可加 http://localhost:8765）
//   3) 把 AK 粘到下面。注意：浏览器端 AK 会出现在页面源码里，
//      请务必设置域名白名单 + 合理配额（个人认证一般 10 万次/天）。
//
// 【百度地图 · 全景静态图 / 地点检索 · 需额外申请】
//   在控制台应用详情页的「服务管理」里勾选开通：
//     · 全景静态图 → 实景街景（360° 环视）
//     · 地点检索   → poiid（取景点正门视角，比只传坐标准得多）
//   poiid 采集：python tools/fetch_poiid.py
//
// 【高德地图 · 静态街景】（可选，单视角图，用于对照）
//   高德 Web 服务 API Key：https://console.amap.com/dev/key/app
export const BAIDU_AK = 'xfdsKWLyQGGNtY02i054FcXTqGmmw7CF';
export const AMAP_KEY = '';

// 由 tools/probe_baidu_api.py 生成：控制台各服务的真实开通状态
export const BAIDU_CAPS = { "staticImage": true, "panorama": false, "placeSearch": false, "geocoding": false, "checkedAt": "2026-10-24" };
