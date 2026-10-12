/**
 * tools/build-palette.js
 * 色库构建工具（文档 §3.1 / D-08 校色规范 · 项目关键路径）
 *
 * 用法：
 *   node tools/build-palette.js
 *
 * 数据来源与优先级：
 *   1. 若存在 miniprogram/data/colors/raw/mard-measured.csv，
 *      则以实测值为准（该文件由取色器导出，见 D-08）。
 *   2. 否则回退到本文件内的占位色表，并输出告警：
 *      占位值仅用于打通流程，不能直接用于生产。
 *
 * CSV 格式（实测表）：
 *   code,name,r,g,b
 *   H1,纯白,252,251,248
 *
 * 产出：
 *   miniprogram/color/palette/mard.js    —— 221 色，小程序运行时加载
 *   miniprogram/color/palette/brands.js  —— 品牌索引，小程序运行时加载
 *   miniprogram/data/colors/mard.json    —— 同一份数据的 JSON 形态
 *   miniprogram/data/colors/brands.json  —— 供 Node 单测与人工查阅校色结果
 *
 * 为何 JS 与 JSON 双份产出：
 *   小程序 require 只支持 .js；但 Node 单测直接 require .json 更直观，
 *   且人工查阅校色结果时 JSON 更易读。两者内容由本脚本保证一致。
 */

const fs = require('fs');
const path = require('path');

const COLORS_DIR = path.join(__dirname, '..', 'miniprogram', 'data', 'colors');
const RAW_CSV = path.join(COLORS_DIR, 'raw', 'mard-measured.csv');
/** JS 模块输出目录：与 color/palette-loader.js 同级，确保在工具的模块扫描热区 */
const JS_DIR = path.join(__dirname, '..', 'miniprogram', 'color', 'palette');

/* ============================================================
 * 占位色表（221 色）
 * ⚠️ 警告：以下 rgb 为按色名推算的占位值，色卡打印后必须以实测值覆盖。
 * 字段顺序：code, name, hex
 * ============================================================ */

// H 系列 · 基础色（140 色）
const H_SERIES = [
  ['H1', '纯白', '#fcfbf8'], ['H2', '象牙白', '#f7f3e8'], ['H3', '米白', '#f2ece0'],
  ['H4', '珍珠白', '#ece6dc'], ['H5', '浅灰白', '#e3dfd8'], ['H6', '银灰', '#d2cec7'],
  ['H7', '正黑', '#0a0a0a'], ['H8', '深灰', '#3a3a3a'], ['H9', '中灰', '#6e6e6e'],
  ['H10', '浅灰', '#a8a6a4'], ['H11', '银灰白', '#c9c6c1'], ['H12', '暖白', '#f8f4ec'],
  ['H13', '米灰', '#b9b2a6'], ['H14', '深暖灰', '#4a4643'], ['H15', '石墨灰', '#5c5c5e'],
  ['H16', '雾灰', '#9c9b99'], ['H17', '雪白', '#fdfefc'], ['H18', '炭灰', '#2b2b2b'],
  ['H19', '灰白', '#e8e6e2'], ['H20', '奶油白', '#f4efe3'],
  // 红
  ['H21', '正红', '#d9252a'], ['H22', '大红', '#e02b20'], ['H23', '朱红', '#e8402a'],
  ['H24', '深红', '#a01c22'], ['H25', '酒红', '#7b1e2b'], ['H26', '玫红', '#e8395b'],
  ['H27', '粉红', '#f28ba8'], ['H28', '浅粉', '#f7b6c4'], ['H29', '桃红', '#f0607f'],
  ['H30', '砖红', '#c0392b'], ['H31', '橘红', '#f05a28'], ['H32', '珊瑚红', '#f47b5f'],
  ['H33', '浅珊瑚', '#f8a48c'], ['H34', '玫紫红', '#c9386b'], ['H35', '西瓜红', '#e8424f'],
  ['H36', '暗红', '#7a1f24'], ['H37', '莓果红', '#c2263e'], ['H38', '樱花粉', '#f5a6b8'],
  ['H39', '胭脂红', '#a02c4a'], ['H40', '铁锈红', '#b74a2c'],
  // 橙 / 黄
  ['H41', '正橙', '#f2801d'], ['H42', '橘黄', '#f79c1c'], ['H43', '南瓜橙', '#e8762a'],
  ['H44', '浅橙', '#f9b96e'], ['H45', '杏色', '#f3c08a'], ['H46', '金橙', '#f0932b'],
  ['H47', '蜜橙', '#f2a24a'], ['H48', '深橙', '#d1651a'], ['H49', '焦橙', '#bf5a1e'],
  ['H50', '柠檬黄', '#f6e04a'], ['H51', '正黄', '#f5d322'], ['H52', '鹅黄', '#fbe08c'],
  ['H53', '奶黄', '#f6dfae'], ['H54', '米黄', '#e8d49a'], ['H55', '芥末黄', '#c9a93c'],
  ['H56', '土黄', '#b8913a'], ['H57', '姜黄', '#dfa82c'], ['H58', '香槟黄', '#f0e0b8'],
  ['H59', '明黄', '#ffd400'], ['H60', '金黄', '#eab308'],
  // 绿
  ['H61', '正绿', '#2e9e4f'], ['H62', '翠绿', '#22a95a'], ['H63', '草绿', '#6bbd3e'],
  ['H64', '嫩绿', '#a8d86a'], ['H65', '浅绿', '#c8e6a0'], ['H66', '墨绿', '#1e5c3a'],
  ['H67', '军绿', '#5a6b3c'], ['H68', '橄榄绿', '#7a8340'], ['H69', '豆绿', '#8fae56'],
  ['H70', '薄荷绿', '#a8ddc0'], ['H71', '浅豆绿', '#c9e3c0'], ['H72', '深豆绿', '#4c7a4e'],
  ['H73', '青柠绿', '#8dc63f'], ['H74', '苔绿', '#6e8b4c'], ['H75', '森林绿', '#2f6b3a'],
  ['H76', '祖母绿', '#1f8a5f'], ['H77', '碧绿', '#3fb59a'], ['H78', '浅碧绿', '#8fd6c8'],
  ['H79', '松石绿', '#2ba39a'], ['H80', '深松石', '#1c7a72'],
  // 青 / 蓝
  ['H81', '青色', '#28a8b8'], ['H82', '天蓝', '#5bbcd6'], ['H83', '湖蓝', '#2b95b8'],
  ['H84', '浅湖蓝', '#8fd0e0'], ['H85', '深蓝', '#1c3f7a'], ['H86', '正蓝', '#1f5fbf'],
  ['H87', '宝蓝', '#2456b0'], ['H88', '天蓝蓝', '#7fb8e0'], ['H89', '浅蓝', '#a8cde8'],
  ['H90', '藏青', '#1b2a4a'], ['H91', '藏蓝', '#2a3f6b'], ['H92', '牛仔蓝', '#4a6b96'],
  ['H93', '雾霾蓝', '#8fa4bb'], ['H94', '浅灰蓝', '#b9c8d8'], ['H95', '深蓝黑', '#182742'],
  ['H96', '克莱因蓝', '#2b3fd4'], ['H97', '孔雀蓝', '#1a7f9e'], ['H98', '钢蓝', '#5a7a96'],
  ['H99', '粉蓝', '#bcd6e8'], ['H100', '冰蓝', '#d6e8f2'],
  // 紫
  ['H101', '正紫', '#7b3fa0'], ['H102', '深紫', '#4a2270'], ['H103', '浅紫', '#c4a3dc'],
  ['H104', '薰衣草', '#cfc0e0'], ['H105', '藕紫', '#c9a8c4'], ['H106', '葡萄紫', '#5c2d6e'],
  ['H107', '紫罗兰', '#8a5fbf'], ['H108', '淡紫', '#e2d4ee'], ['H109', '丁香紫', '#b894c8'],
  ['H110', '茄紫', '#5a3a6b'], ['H111', '梅子紫', '#6b3a5c'], ['H112', '雾紫', '#a894b8'],
  // 棕 / 肤色
  ['H113', '浅棕', '#c9a37a'], ['H114', '棕色', '#96603a'], ['H115', '深棕', '#5c3a22'],
  ['H116', '咖啡', '#6b4630'], ['H117', '焦糖', '#a8763f'], ['H118', '浅驼', '#d6b28c'],
  ['H119', '驼色', '#b08a5c'], ['H120', '奶茶', '#c9a382'], ['H121', '深驼', '#8a6842'],
  ['H122', '巧克力', '#4f3222'], ['H123', '肤色', '#f0c9a8'], ['H124', '浅肤', '#f7ddc4'],
  ['H125', '深肤', '#c9946b'], ['H126', '蜜色', '#d9a878'], ['H127', '古铜', '#8a5a34'],
  ['H128', '浅褐', '#d9c2a0'], ['H129', '深褐', '#5f4a33'], ['H130', '沙色', '#ddc9a8'],
  // 补充过渡色与常用缺口色，补齐至 221 色总量
  ['H131', '暖灰', '#8c8378'], ['H132', '冷灰', '#7c8288'], ['H133', '浅青灰', '#a8b8bc'],
  ['H134', '深青灰', '#46565c'], ['H135', '暗橄榄', '#4a5238'], ['H136', '芥末褐', '#8a7440'],
  ['H137', '藕荷', '#c8a8b8'], ['H138', '黛蓝', '#2c3c56'], ['H139', '绛紫', '#5c2c4c'],
  ['H140', '鸭血红', '#8a3a3a'],
];

/* S 系列 · 闪粉 / 特殊（60 色） */
const S_SERIES = [
  ['S1', '闪白', '#f5f5f0'], ['S2', '闪银', '#c8ccd0'], ['S3', '闪金', '#d4af5c'],
  ['S4', '闪金铜', '#b8894c'], ['S5', '闪红', '#c8303c'], ['S6', '闪粉红', '#e06a90'],
  ['S7', '闪橙', '#e8842e'], ['S8', '闪黄', '#e8c832'], ['S9', '闪绿', '#4aa85c'],
  ['S10', '闪青', '#3fa8b0'], ['S11', '闪蓝', '#3a6ab5'], ['S12', '闪紫', '#8a5ab0'],
  ['S13', '闪粉', '#f0b8c8'], ['S14', '香槟闪', '#e0cfa8'], ['S15', '古铜闪', '#9a6a3c'],
  ['S16', '玫瑰金', '#d4a08c'], ['S17', '夜光绿', '#c8f0d0'], ['S18', '夜光蓝', '#c0e4f0'],
  ['S19', '夜光粉', '#f4d0dc'], ['S20', '夜光黄', '#f0ecc0'],
  ['S21', '珠光白', '#f8f4ec'], ['S22', '珠光米', '#efe4cf'], ['S23', '珠光蓝', '#c8d8e8'],
  ['S24', '珠光紫', '#d0c4e0'], ['S25', '珠光粉', '#f0d4dc'],
  ['S26', '金属金', '#b8962e'], ['S27', '金属银', '#a8aeb4'], ['S28', '古铜金', '#8a6428'],
  ['S29', '镭射红', '#e0483c'], ['S30', '镭射蓝', '#3c6ad0'], ['S31', '镭射紫', '#8a4ad0'],
  ['S32', '镭射绿', '#3cad70'], ['S33', '镭射粉', '#e87ab0'], ['S34', '镭射橙', '#e8842c'],
  ['S35', '渐变粉', '#f4b4c8'], ['S36', '渐变蓝', '#a8c4e8'], ['S37', '渐变紫', '#c4b0e4'],
  ['S38', '渐变绿', '#b0e0bc'], ['S39', '猫眼紫', '#6a4a9c'], ['S40', '猫眼蓝', '#3a5a9c'],
  ['S41', '猫眼绿', '#3a8a5c'], ['S42', '猫眼红', '#a83a3a'], ['S43', '猫眼金', '#b8862c'],
  ['S44', '磨砂白', '#f0f0ec'], ['S45', '磨砂黑', '#1c1c1c'], ['S46', '磨砂灰', '#8a8a8a'],
  ['S47', '磨砂红', '#b03a3a'], ['S48', '磨砂蓝', '#3a5a8a'], ['S49', '大理石白', '#eeeae4'],
  ['S50', '大理石灰', '#9c9c9c'], ['S51', '冰块蓝', '#a4ccdc'], ['S52', '冰块粉', '#e8c0cc'],
  ['S53', '云朵白', '#f8f6f2'], ['S54', '薄荷闪', '#a8e0d0'], ['S55', '樱花闪', '#f4c0cc'],
  ['S56', '星河蓝', '#2a4a8a'], ['S57', '星河紫', '#4a2a8a'], ['S58', '极光绿', '#6ac89a'],
  ['S59', '极光紫', '#a87ad0'], ['S60', '极光金', '#d0b05a'],
];

/* T 系列 · 透明（21 色） */
const T_SERIES = [
  ['T1', '透明红', '#e06a6a'], ['T2', '透明橙', '#e8a05a'], ['T3', '透明黄', '#e8d070'],
  ['T4', '透明绿', '#70c090'], ['T5', '透明蓝', '#7090d0'], ['T6', '透明紫', '#a070d0'],
  ['T7', '透明粉', '#e8a0c0'], ['T8', '透明白', '#f0f0f0'], ['T9', '透明灰', '#b0b0b0'],
  ['T10', '透明黑', '#40404a'], ['T11', '透明青', '#70c0c8'], ['T12', '透明棕', '#b08860'],
  ['T13', '透明米', '#e0d0b8'], ['T14', '透明酒红', '#a05060'], ['T15', '透明深蓝', '#4058a0'],
  ['T16', '透明草绿', '#a0d070'], ['T17', '透明柠檬', '#e8e890'], ['T18', '透明湖蓝', '#70b8d0'],
  ['T19', '透明藕荷', '#c0a0c8'], ['T20', '透明浅蓝', '#b0d0e8'], ['T21', '透明奶白', '#f4efe4'],
];

/* ============================================================
 * 实测 CSV 加载
 * ============================================================ */
function loadMeasured() {
  if (!fs.existsSync(RAW_CSV)) return null;
  const text = fs.readFileSync(RAW_CSV, 'utf8');
  const map = new Map();
  const lines = text.split(/\r?\n/);
  let header = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split(',').map((s) => s.trim());
    if (!header) {
      header = cols;
      continue;
    }
    if (cols.length < 5) continue;
    const [code, name, r, g, b] = cols;
    const rgb = [Number(r), Number(g), Number(b)];
    if (rgb.some((v) => Number.isNaN(v) || v < 0 || v > 255)) continue;
    map.set(code, { name, rgb });
  }
  return map.size > 0 ? map : null;
}

/* ============================================================
 * 构建
 * ============================================================ */
function build() {
  const measured = loadMeasured();
  const all = [...H_SERIES, ...S_SERIES, ...T_SERIES];

  // 去重校验（S-03：色号重复需降级处理而非崩溃）
  const seen = new Set();
  const dups = [];
  for (const [code] of all) {
    if (seen.has(code)) dups.push(code);
    seen.add(code);
  }
  if (dups.length) {
    console.warn('[build-palette] ⚠️ 存在重复色号，已保留首条：', dups.join(', '));
  }

  const colors = all.map(([code, name, hex]) => {
    const m = measured && measured.get(code);
    const rgb = m ? m.rgb : hexToRgb(hex);
    const finalName = m ? m.name : name;
    const series = code.charAt(0);
    return {
      brand: 'MARD',
      series: series === 'H' ? 'H' : series === 'S' ? 'S' : 'T',
      code,
      name: finalName,
      rgb,
      hex: rgbToHex(rgb[0], rgb[1], rgb[2]),
      sizes: ['5mm', '2.6mm'],
      compatible: ['Artkal'],
    };
  });

  const unique = [];
  const used = new Set();
  for (const c of colors) {
    if (used.has(c.code)) continue;
    used.add(c.code);
    unique.push(c);
  }

  fs.mkdirSync(COLORS_DIR, { recursive: true });
  fs.mkdirSync(JS_DIR, { recursive: true });

  const mardData = { version: '0.2.0', brand: 'MARD', count: unique.length, colors: unique };
  const brandsData = {
    brands: [
      { id: 'MARD', name: 'MARD', count: unique.length, available: true },
      { id: 'Artkal', name: 'Artkal 拼拼豆', count: 0, available: false, note: '色库待导入（Q-09 授权模式待定）' },
    ],
  };

  // 产出 1：JSON 形态。供 Node 单测直接 require 与人工查阅校色结果。
  fs.writeFileSync(path.join(COLORS_DIR, 'mard.json'), JSON.stringify(mardData, null, 0), 'utf8');
  fs.writeFileSync(path.join(COLORS_DIR, 'brands.json'), JSON.stringify(brandsData, null, 2), 'utf8');

  // 产出 2：JS 模块。小程序 require 只支持 .js，
  // 且需与 color/palette-loader.js 同处 color/ 目录才确保在工具的扫描热区。
  fs.writeFileSync(
    path.join(JS_DIR, 'mard.js'),
    '// 本文件由 tools/build-palette.js 自动生成，请勿手动编辑。\n'
    + '// 数据源：miniprogram/data/colors/raw/mard-measured.csv（实测校色）优先，\n'
    + '// 无实测数据时回退到占位色表 —— 占位值禁止用于生产发布。\n'
    + 'module.exports = ' + JSON.stringify(mardData, null, 0) + ';\n',
    'utf8'
  );

  fs.writeFileSync(
    path.join(JS_DIR, 'brands.js'),
    '// 本文件由 tools/build-palette.js 自动生成，请勿手动编辑。\n'
    + 'module.exports = ' + JSON.stringify(brandsData, null, 2) + ';\n',
    'utf8'
  );

  const bySeries = unique.reduce((m, c) => { m[c.series] = (m[c.series] || 0) + 1; return m; }, {});
  console.log(`[build-palette] ✅ 生成 ${unique.length} 色`);
  console.log(`[build-palette]    JS  : miniprogram/color/palette/{mard,brands}.js`);
  console.log(`[build-palette]    JSON: miniprogram/data/colors/{mard,brands}.json`);
  console.log(`[build-palette]    系列分布：H=${bySeries.H || 0} S=${bySeries.S || 0} T=${bySeries.T || 0}`);

  if (!measured) {
    console.warn('');
    console.warn('╔══════════════════════════════════════════════════════════╗');
    console.warn('║  ⚠️  未找到实测数据，当前使用占位色值                      ║');
    console.warn('║  占位值仅用于打通开发流程，禁止直接用于生产。             ║');
    console.warn('║  校色规范见 D-08：固定光照下取均值，避免色差漂移。          ║');
    console.warn(`║  将实测结果写入：${path.relative(process.cwd(), RAW_CSV)}`);
    console.warn('╚══════════════════════════════════════════════════════════╝');
  } else {
    console.log(`[build-palette] ✅ 已应用 ${measured.size} 条实测值（来自 mard-measured.csv）`);
  }
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r, g, b) {
  const to2 = (v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

build();