/**
 * color/palette-loader.js —— 色库加载与索引（文档 M7 / P-04 / S-03）
 *
 * 职责：
 *   1. 加载静态色库，做字段完整性校验（缺失/重复色号降级处理，不崩溃）
 *   2. 启动时预构建 Lab 索引与色相索引，避免每次匹配重复转换（文档 P-04）
 *   3. 提供按品牌 / 规格 / 限定色集的查询能力
 *
 * 纯逻辑层，不依赖 wx（数据通过构造参数注入），便于 Node 单测。
 */

const { rgbToLab, rgbToHue } = require('./lab');

/**
 * 内置色库，静态引入以获得确定的打包体积（文档 §1.1：静态数据打包）。
 *
 * ⚠️ 三条小程序环境约束（均为实测踩坑）：
 *
 *  1. 必须 require .js，不能 require .json
 *     小程序 require 遇到 .json 会去找 'xxx.json.js' 并报 module not defined。
 *
 *  2. 必须显式写 .js 扩展名
 *     部分开发者工具版本不会为省略扩展名的路径补全 .js，
 *     写全可避免 "module is not defined"。
 *
 *  3. 放在 color/palette/ 而非 data/colors/
 *     工具的模块扫描以 app.json 的 pages 与页面引用为起点，
 *     纯数据目录（data/）下的深层模块存在被漏扫的风险。
 *     移到 color/ 下与本加载器同级，路径短且落在扫描热区。
 *
 * 色库数据由 tools/build-palette.js 生成：
 *   mard.js   小程序运行时加载（本文件引用）
 *   mard.json 同一份数据的 JSON 形态，供 Node 单测与人工查阅校色结果
 */
const RAW_MARD = require('./palette/mard.js');

/** 校验并索引单个色库 */
function indexPalette(raw, options = {}) {
  const brand = options.brand || (raw && raw.brand) || 'UNKNOWN';
  const version = (raw && raw.version) || '0';

  if (!raw || !Array.isArray(raw.colors) || raw.colors.length === 0) {
    // S-03：色库缺失 → 降级为空索引，由调用方决定是否阻断流程
    console.warn(`[palette-loader] 色库 ${brand} 结构非法或为空，已降级为 0 色`);
    return { brand, version, colors: [], byCode: new Map(), labList: [], valid: false };
  }

  const colors = [];
  const byCode = new Map();
  let skipped = 0;

  for (const item of raw.colors) {
    // 字段完整性校验
    const code = item && item.code;
    if (!code || typeof code !== 'string') { skipped++; continue; }
    if (!Array.isArray(item.rgb) || item.rgb.length !== 3) { skipped++; continue; }
    if (item.rgb.some((v) => typeof v !== 'number' || v < 0 || v > 255)) { skipped++; continue; }

    // 重复色号降级：保留首条，跳过后续（S-03）
    if (byCode.has(code)) { skipped++; continue; }

    const entry = {
      brand: item.brand || brand,
      series: item.series || code.charAt(0),
      code,
      name: item.name || code,
      rgb: [item.rgb[0], item.rgb[1], item.rgb[2]],
      hex: item.hex || rgbHex(item.rgb),
      sizes: Array.isArray(item.sizes) && item.sizes.length ? item.sizes : ['5mm'],
      compatible: Array.isArray(item.compatible) ? item.compatible : [],
    };

    // P-04：预建 Lab 与色相索引
    const lab = rgbToLab(entry.rgb[0], entry.rgb[1], entry.rgb[2]);
    entry.lab = lab;
    entry.hue = rgbToHue(entry.rgb[0], entry.rgb[1], entry.rgb[2]);

    colors.push(entry);
    byCode.set(code, entry);
  }

  if (skipped > 0) {
    console.warn(`[palette-loader] 色库 ${brand} 跳过 ${skipped} 条非法/重复记录（已降级处理，未中断）`);
  }

  return { brand, version, colors, byCode, labList: colors, valid: colors.length > 0 };
}

function rgbHex(rgb) {
  const to2 = (v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
  return `#${to2(rgb[0])}${to2(rgb[1])}${to2(rgb[2])}`;
}

/**
 * 按筛选条件从色库中取候选集。
 *
 * @param {object} indexed        indexPalette 的返回值
 * @param {string} beadSize       豆子规格，如 '5mm'
 * @param {string[]|null} onlyCodes  限定色集（库存约束）；null 表示不限制
 * @returns {object[]} 候选颜色数组
 */
function selectCandidates(indexed, beadSize, onlyCodes) {
  let list = indexed.colors;
  if (beadSize) {
    const filtered = list.filter((c) => c.sizes.indexOf(beadSize) >= 0);
    // 规格过滤后为空说明数据异常，回退到全集，避免用户完全无法出图
    if (filtered.length) list = filtered;
    else console.warn(`[palette-loader] 规格 ${beadSize} 无匹配色号，回退使用全色库`);
  }
  if (Array.isArray(onlyCodes) && onlyCodes.length) {
    const allow = new Set(onlyCodes);
    const filtered = list.filter((c) => allow.has(c.code));
    if (filtered.length) return filtered;
    // Q-08 降级策略：库存色集与色库完全无交集时，退回全色库而不是报错，
    // 同时由体检模块给出「库存不足」的明确提示。
    console.warn('[palette-loader] 库存色集与色库无交集，已降级为全色库匹配');
  }
  return list;
}

/** 模块级缓存：启动时构建一次，全局复用 */
let _cache = null;

/**
 * 获取（并惰性构建）MARD 色库索引。
 * P-04：把 RGB→Lab 的开销从「每次匹配」前移到「启动一次」。
 */
function getPalette(brand = 'MARD') {
  if (_cache && _cache.brand === brand) return _cache;
  if (brand !== 'MARD') {
    // Q-09：其他品牌色库待导入，先回退到 MARD
    console.warn(`[palette-loader] 品牌 ${brand} 色库尚未导入，回退使用 MARD`);
    _cache = indexPalette(RAW_MARD, { brand: 'MARD' });
    return _cache;
  }
  _cache = indexPalette(RAW_MARD, { brand: 'MARD' });
  return _cache;
}

/** 清空缓存（校色数据热更新时使用） */
function clearCache() {
  _cache = null;
}

/** 供测试注入自定义色库 */
function setPalette(raw, brand = 'MARD') {
  _cache = indexPalette(raw, { brand });
  return _cache;
}

module.exports = {
  getPalette,
  clearCache,
  setPalette,
  indexPalette,
  selectCandidates,
};