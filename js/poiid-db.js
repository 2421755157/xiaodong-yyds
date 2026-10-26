// ═══ 百度地图 POI 检索结果（构建期批量采集）═══
// 生成：tools/fetch_poiid.py。格式：{ 景点名: { uid, name, lng, lat, addr } }
// uid 即 poiid，传给 panorama/v2 可取"景点本身的全景点"而非附近气泡。
//
// 当前为空：百度控制台的「地点检索」服务未开通（接口返回 240 APP服务被禁用），
// 采集脚本会先做前置探测并快速失败，不会产出一库空值。
//
// 开通步骤：
//   1) https://lbsyun.baidu.com/ → 应用管理 → 服务管理 → 勾选「地点检索」
//   2) python tools/fetch_poiid.py
//
// 前端对此有兜底：库为空时「实景街景」按钮只用坐标取附近街景，不受影响。
export const POIID_DB = {};
