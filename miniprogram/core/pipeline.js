/**
 * core/pipeline.js —— 处理流水线编排（文档 §2「核心处理流程」）
 *
 * 严格按文档 §2 的时序执行：
 *   像素化 → [增强] → [去背景] → 色号匹配 → [杂色合并] → 孤立块检测 → 体检 → 渲染 → 统计
 *
 * ⚠️ 时序约束（文档 §2.1 明确要求）：
 *   去背景必须在用量统计之前完成，否则清单数量虚高。
 *   本模块在 removeBg 后才做 matchCodes 与 countUsage，保证统计口径正确。
 *
 * 纯逻辑层：输入 imageData（像素缓冲）+ params，输出图纸数据对象。
 * 不触碰 wx / Canvas，因此可在 Node 中完整单测。
 */

const { pixelate, deriveGrid, checkNoiseRisk } = require('./pixelate');
const { enhance } = require('./enhance');
const { aggregate, applyDither } = require('./algorithm');
const { removeBackground } = require('./background');
const { mergeSimilar } = require('./merge');
const { detectIsolated } = require('./isolated');
const { checkPalette, annotateHueGroups } = require('./check');

const { matchCodes, limitColorCount } = require('../color/match');
const { getPalette } = require('../color/palette-loader');

const { DEFAULT_PARAMS, BEAD_SPECS, MERGE_DEFAULT_DELTA, PALETTE_VERSION } = require('../utils/config');

/**
 * 主入口：执行完整处理链。
 *
 * @param {object} input {
 *     imageData: { width, height, data },   原图像素缓冲
 *     params:   用户参数（缺省用 DEFAULT_PARAMS）
 *     onlyCodes: 库存限定色集（null = 不限制）
 *     deltaMethod: 覆盖默认 ΔE 算法
 *   }
 * @returns {object} 图纸数据对象（结构见 §3.2 图纸模型）
 */
function run(input) {
  const params = { ...DEFAULT_PARAMS, ...(input.params || {}) };
  const imageData = input.imageData;
  if (!imageData || !imageData.width || !imageData.height) {
    throw new Error('run(): 缺少有效的 imageData');
  }

  const t0 = now();
  const timing = {};

  /* ---------- 0. 预检（M1） ---------- */
  /*
   * ⚠️ v0.9 修复板数链路丢失：
   *   原来传的是 (params.boardCount, 1) —— 即把「单板格数」当成 gridSize、
   *   把横向板数写死为 1。于是 cols = gridSize × 1 恒为单板宽度，
   *   checklist 算出的块数恒为 1，分板线与分板施工单全部失效。
   *   现在 boardCols 来自 index 页的成品规格档位（双板=2、四板=2×2）。
   */
  const gridSize = params.boardCount || 29;
  const boardCols = Math.max(1, params.boardCols || 1);
  const gridSpec = deriveGrid(imageData.width, imageData.height, gridSize, boardCols);
  const risk = checkNoiseRisk(imageData.width, imageData.height, gridSize, boardCols);
  timing.precheck = now() - t0;

  /* ---------- 1. 像素化（高采样） ---------- */
  let mark = now();
  const sampleScale = params.sampleScale || 3;
  const hiCols = gridSpec.cols * sampleScale;
  const hiRows = gridSpec.rows * sampleScale;
  let grid = pixelate(imageData, hiCols, hiRows);
  timing.pixelate = now() - mark;

  /* ---------- 2. 区域聚合（主导色 / 均值） ---------- */
  mark = now();
  grid = aggregate(grid, {
    mode: params.mode,
    sampleScale,
    quantizeStep: params.quantizeStep,
    minPixels: params.minPixels,
  });
  timing.aggregate = now() - mark;

  /* ---------- 3. 增强（可选） ---------- */
  mark = now();
  if (params.enhance) {
    grid = enhance(grid, {
      contrast: params.contrast || 0.15,
      saturation: params.saturation || 0.1,
      brightness: params.brightness || 0,
    });
  }
  timing.enhance = now() - mark;

  /* ---------- 4. 去背景（可选，必须在统计前） ---------- */
  mark = now();
  let bgMask = null;
  let bgRatio = 0;
  if (params.removeBg) {
    const bg = removeBackground(grid, { tolerance: params.bgTolerance });
    grid = bg.grid;
    bgMask = bg.mask;
    bgRatio = bg.ratio;
  }
  timing.removeBg = now() - mark;

  const { cols, rows, cells } = grid;

  /* ---------- 5. 抖动（可选，默认关闭） ---------- */
  mark = now();
  const palette = getPalette(params.brand);
  if (params.dither) {
    grid = applyDither(grid, palette, { beadSize: params.beadSize, onlyCodes: input.onlyCodes });
    timing.dither = now() - mark;
  }

  /* ---------- 6. 色号匹配 ---------- */
  mark = now();
  let match = matchCodes(grid, palette, {
    brand: params.brand,
    beadSize: params.beadSize,
    onlyCodes: input.onlyCodes,
    deltaMethod: input.deltaMethod,
    huePruneAngle: params.huePruneAngle,
  });
  timing.match = now() - mark;

  /* ---------- 7. 颜色数上限 ---------- */
  mark = now();
  let reducedFrom = 0;
  if (params.colorLimit && match.details.size > params.colorLimit) {
    const limited = limitColorCount(match, grid, params.colorLimit, palette);
    reducedFrom = limited.reducedFrom;
    match = limited;
  }
  timing.limit = now() - mark;

  /* ---------- 8. 杂色合并（可选） ---------- */
  mark = now();
  let mergeInfo = null;
  if (params.mergeSimilar) {
    mergeInfo = mergeSimilar(match.codes, cols, rows, {
      delta: params.mergeDelta || MERGE_DEFAULT_DELTA,
      palette,
      beadType: params.beadType,
      deltaMethod: input.deltaMethod,
    });
    match.codes = mergeInfo.codes;
    // 合并后重算用量明细
    match.details = recountDetails(match.codes, match.details);
  }
  timing.merge = now() - mark;

  /* ---------- 9. 孤立块检测 ---------- */
  mark = now();
  const isolated = detectIsolated(match.codes, cols, rows, {});
  timing.isolated = now() - mark;

  /* ---------- 10. 体检报告 ---------- */
  mark = now();
  annotateHueGroups(match.details);
  const report = checkPalette({
    codes: match.codes,
    cols,
    rows,
    details: match.details,
    deltaStats: match.deltaStats,
    isolated,
    bgRatio,
    params,
  });
  timing.check = now() - mark;

  /* ---------- 11. 用量统计（去背景后） ---------- */
  mark = now();
  const usage = countUsage(match.codes, cols, rows, match.details, bgMask);
  timing.count = now() - mark;

  timing.total = now() - t0;

  /* ---------- 12. 组装图纸模型（§3.2） ---------- */
  const pattern = buildPattern({
    params, cols, rows, codes: match.codes, details: match.details,
    usage, isolated, report, bgMask, palette,
    // 板数信息：buildPattern 拿不到 run 的局部变量，必须显式传入
    boardCols, gridSpec,
  });

  return {
    pattern,
    grid,
    codes: match.codes,
    details: match.details,
    usage,
    isolated,
    report,
    deltaStats: match.deltaStats,
    risk,
    meta: {
      reducedFrom,
      mergeInfo,
      bgRatio,
      timing,
      paletteVersion: PALETTE_VERSION,
      paletteCount: palette.colors.length,
      gridSpec,
    },
  };
}

/**
 * 用量统计（文档 §4.1 `countUsage`）
 *
 * @param {string[]} codes
 * @param {number} cols
 * @param {number} rows
 * @param {Map} details
 * @param {Uint8Array|null} mask 背景掩码，1 = 背景（不计入用量）
 * @returns {{ list, totalCount, totalWithLoss, beadSpec, physical }}
 */
function countUsage(codes, cols, rows, details, mask) {
  const counts = new Map();

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (!code) continue;
    // S-02 / 文档 §2.1：统计口径为「去背景后」
    if (mask && mask[i]) continue;
    counts.set(code, (counts.get(code) || 0) + 1);
  }

  const list = [];
  let totalCount = 0;
  for (const [code, count] of counts) {
    const d = details ? details.get(code) : null;
    list.push({
      code,
      name: d ? d.name : code,
      hex: d ? d.hex : '#cccccc',
      rgb: d ? d.rgb : [200, 200, 200],
      count,
    });
    totalCount += count;
  }

  // 按用量降序，用量相同的按色号排序，保证结果稳定
  list.sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : 1));

  return list;
}

/**
 * 成品尺寸与豆量计算（文档 §2.2 计算公式）
 *
 *   成品边长(cm) ≈ 格数 × 直径(mm) ÷ 10
 *   总格数 ≈ 长 × 宽
 *   豆量     = 总格数 × (1 + 8%~15% 损耗)
 */
function calcPhysical(cols, rows, params) {
  const spec = BEAD_SPECS[params.beadSize] || BEAD_SPECS['5mm'];
  // 保留 2 位小数：2.6mm 豆 29 格 = 7.54cm，若按 1 位四舍五入会显示成 7.5cm，
  // 与实物误差达 0.4mm，对「照着图纸裁板材」的场景不可接受。
  const widthCm = round2((cols * spec.diameter) / 10);
  const heightCm = round2((rows * spec.diameter) / 10);

  // 损耗率：加热融合工艺在熨烫过程中损耗略高，取上限区间
  const lossRate = params.beadType === 'fusion' ? 0.15 : 0.1;

  return {
    width: widthCm,
    height: heightCm,
    unit: 'cm',
    totalCells: cols * rows,
    // 建议采购量向上取整到 50 的倍数，便于实际购买
    suggestedBeads: Math.ceil((cols * rows * (1 + lossRate)) / 50) * 50,
    lossRate,
    beadSpec: spec,
  };
}

/** 组装符合 §3.2 的图纸模型 */
function buildPattern(ctx) {
  const { params, cols, rows, codes, details, usage, isolated, report, palette } = ctx;

  // 稀疏 cells：仅存非空格（文档 §3.2）
  const cells = {};
  for (let i = 0; i < codes.length; i++) {
    if (!codes[i]) continue;
    const y = Math.floor(i / cols);
    const x = i - y * cols;
    cells[`${y},${x}`] = codes[i];
  }

  const totalCount = usage.reduce((s, u) => s + u.count, 0);
  const physical = calcPhysical(cols, rows, params);

  return {
    gridSize: 0, // 实际板格数由 cols/rows 表达，gridSize 保留给单板视图
    cols,
    rows,
    beadSize: params.beadSize,
    beadType: params.beadType,
    brand: params.brand,
    /** 单板格数（16/29/52/75）—— 分板线间隔与施工单切分都依赖它 */
    boardCount: params.boardCount || 29,
    /** 横向板数：成品由几块板横排拼成（v0.9 起真实参与计算） */
    boardCols: ctx.boardCols || 1,
    /** 纵向板数 */
    boardRows: (ctx.gridSpec && ctx.gridSpec.boardRows) || 1,
    mode: params.mode,
    colors: usage,
    totalCount,
    physicalSize: {
      width: physical.width,
      height: physical.height,
      unit: 'cm',
    },
    suggestedBeads: physical.suggestedBeads,
    cells,
    originMarker: 'top-left',
    // 以下为渲染与施工所需的派生数据
    render: {
      gridLine: params.gridLine,
      codeLabel: params.codeLabel,
    },
    health: {
      level: report.level,
      summary: report.summary,
    },
    isolatedCount: isolated.count,
    paletteVersion: PALETTE_VERSION,
  };
}

/** 合并后重算 details（用量变了，avgDelta 也要跟着重算） */
function recountDetails(codes, oldDetails) {
  const counts = new Map();
  const deltas = new Map();
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (!c) continue;
    counts.set(c, (counts.get(c) || 0) + 1);
  }

  const out = new Map();
  for (const [code, count] of counts) {
    const src = oldDetails.get(code);
    if (src) {
      out.set(code, { ...src, count, avgDelta: src.avgDelta || 0, maxDelta: src.maxDelta || 0 });
    } else {
      // 合并产生的簇主色可能是簇内任一色号；理论上都存在于 oldDetails
      out.set(code, { code, name: code, hex: '#cccccc', rgb: [204, 204, 204], count });
    }
  }
  return out;
}

function now() {
  return typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

module.exports = {
  run,
  countUsage,
  calcPhysical,
  buildPattern,
};