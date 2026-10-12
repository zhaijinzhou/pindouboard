/**
 * color/match.js —— 色号匹配（文档 M4 / §4.1 `matchCodes`）
 *
 * 契约（文档 §4.1）：
 *   输入：格点阵 + 色库 + 品牌 + 可选库存色集
 *   输出：色号矩阵
 *
 * 性能要点：
 *   P-03 色号匹配开销为 格数² × 色库大小（52 格约 2704 × 221 ≈ 60 万次，可接受）
 *   P-05 按色相预筛候选集再算 ΔE，减少全量比较
 *
 * 本模块为纯逻辑层，不依赖 wx / Canvas。
 */

const { rgbToLab, deltaE, rgbToHue, hueDistance } = require('./lab');
const { selectCandidates } = require('./palette-loader');
const { MATCH } = require('../utils/config');

/**
 * 匹配单个颜色到最近的色号。
 *
 * 剪枝策略（P-05）：先用 ΔE76 在「色相接近」的候选子集上粗筛，
 * 取粗筛前 N 名再做高精度 ΔE2000 精算。这样比全量 2000 精算快一个量级，
 * 而精度损失可忽略 —— 因为色相差 25° 以上的颜色，在 Lab 空间里的 L、a、b 差异
 * 必然已经被 ΔE76 反映出来，不可能成为最近邻。
 *
 * @param {number} r,g,b          目标颜色
 * @param {object[]} candidates   候选色库条目
 * @param {object} options        { deltaMethod, huePruneAngle, pruneTopN }
 * @returns {{ code, name, hex, rgb, delta, entry }}
 */
function matchOne(r, g, b, candidates, options = {}) {
  const method = options.deltaMethod || MATCH.deltaMethod;
  const pruneAngle = options.huePruneAngle != null ? options.huePruneAngle : MATCH.huePruneAngle;
  const topN = options.pruneTopN || 8;

  if (!candidates || candidates.length === 0) return null;

  const lab = rgbToLab(r, g, b);
  const hue = rgbToHue(r, g, b);

  // ---- 第一阶段：色相预筛 + ΔE76 粗筛 ----
  let pool = candidates;
  if (hue >= 0 && pruneAngle > 0) {
    const near = [];
    const far = [];
    for (const c of candidates) {
      const hd = hueDistance(hue, c.hue);
      // 灰色（hd === -1）不参与色相剪枝，保留在 near 中避免漏掉无彩色匹配
      if (hd < 0 || hd <= pruneAngle) near.push(c);
      else far.push(c);
    }
    // 预筛后为空（极端情况下所有色色相都远离）则退回全集，保证不漏色
    pool = near.length ? near : candidates;
  }

  let coarse = pool;
  if (pool.length > topN) {
    const scored = pool.map((c) => ({ c, d: deltaE(lab, c.lab, '76') }));
    scored.sort((x, y) => x.d - y.d);
    coarse = scored.slice(0, topN).map((x) => x.c);
  }

  // ---- 第二阶段：ΔE2000 精算 ----
  let best = null;
  let bestDelta = Infinity;
  for (const c of coarse) {
    const d = deltaE(lab, c.lab, method);
    if (d < bestDelta) {
      bestDelta = d;
      best = c;
    }
  }

  if (!best) return null;
  return {
    code: best.code,
    name: best.name,
    hex: best.hex,
    rgb: best.rgb,
    delta: bestDelta,
    entry: best,
    targetLab: lab,
  };
}

/**
 * 批量匹配：格点阵 → 色号矩阵（文档 §4.1 `matchCodes`）
 *
 * @param {Array} grid        像素化后的格点阵 { cols, rows, cells:[{r,g,b}] }
 * @param {object} palette    indexPalette 结果
 * @param {object} options    {
 *     brand, beadSize, onlyCodes,
 *     deltaMethod, huePruneAngle,
 *     collectQuality  是否收集逐格 ΔE 供体检使用
 *   }
 * @returns {{ codes, details, deltaStats, unmatched }}
 *   codes     : string[] 长度 cols*rows，'' 表示空/背景格
 *   details   : Map<code, {code,name,hex,rgb,count,avgDelta,maxDelta}>
 *   deltaStats: { avg, max, poorCount, poorRatio }  匹配质量
 */
function matchCodes(grid, palette, options = {}) {
  const cols = grid.cols;
  const rows = grid.rows;
  const total = cols * rows;

  const candidates = selectCandidates(palette, options.beadSize, options.onlyCodes);

  const codes = new Array(total).fill('');
  const details = new Map();
  const deltas = [];
  let unmatched = 0;

  for (let i = 0; i < total; i++) {
    const cell = grid.cells[i];
    // 空格子（已去背景）跳过匹配
    if (!cell || cell.empty) { codes[i] = ''; continue; }

    const m = matchOne(cell.r, cell.g, cell.b, candidates, options);
    if (!m) { unmatched++; continue; }

    codes[i] = m.code;
    deltas.push(m.delta);

    let d = details.get(m.code);
    if (!d) {
      d = { code: m.code, name: m.name, hex: m.hex, rgb: m.rgb, count: 0, sumDelta: 0, maxDelta: 0 };
      details.set(m.code, d);
    }
    d.count++;
    d.sumDelta += m.delta;
    if (m.delta > d.maxDelta) d.maxDelta = m.delta;
  }

  // 汇总平均 ΔE
  for (const d of details.values()) {
    d.avgDelta = d.count ? d.sumDelta / d.count : 0;
    delete d.sumDelta;
  }

  const avg = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
  const max = deltas.length ? Math.max(...deltas) : 0;
  const poorCount = deltas.filter((d) => d > MATCH.acceptableDelta).length;

  return {
    codes,
    details,
    unmatched,
    deltaStats: {
      avg: Number(avg.toFixed(2)),
      max: Number(max.toFixed(2)),
      poorCount,
      poorRatio: deltas.length ? poorCount / deltas.length : 0,
      acceptableDelta: MATCH.acceptableDelta,
    },
  };
}

/**
 * 对已匹配结果施加「颜色数上限」约束（文档 §8 默认配置：颜色数上限 20）。
 *
 * 策略：取出现频次最高的 N 个色号为主色集，其余色号的格子重新在主色集内匹配。
 * 这是「保数量」而非「保细节」的取舍 —— 用可控的细节损失换取图纸可施工性。
 *
 * @param {object} matchResult  matchCodes 的返回值
 * @param {object} grid         原格点阵（需要原色值做重映射）
 * @param {number} limit        颜色数上限
 * @param {object} palette      色库索引，提供 byCode 供查找候选条目
 * @returns {{ codes, details, reducedFrom }}
 */
function limitColorCount(matchResult, grid, limit, palette) {
  if (!limit || limit <= 0 || matchResult.details.size <= limit) {
    return { ...matchResult, reducedFrom: 0 };
  }

  const cols = grid.cols;
  const total = grid.cells.length;

  // 按频次排序取前 limit 个
  const sorted = [...matchResult.details.values()].sort((a, b) => b.count - a.count);
  const keep = sorted.slice(0, limit);
  const keepSet = new Set(keep.map((k) => k.code));

  // 重映射：把落选色号的格子归到频次最近的保留色号
  const codes = new Array(total).fill('');
  const details = new Map();
  const keptEntries = keep.map((k) => (palette ? palette.byCode.get(k.code) : null)).filter(Boolean);
  // 若无色库上下文，退化为「归到频次最高色」
  const fallbackEntry = keptEntries.length ? keptEntries[0] : null;

  for (let i = 0; i < total; i++) {
    const orig = matchResult.codes[i];
    if (!orig) continue;

    let finalCode = orig;
    if (!keepSet.has(orig)) {
      const cell = grid.cells[i];
      let m = null;
      if (keptEntries.length && cell && !cell.empty) {
        m = matchOne(cell.r, cell.g, cell.b, keptEntries, {});
      }
      finalCode = m ? m.code : (fallbackEntry ? fallbackEntry.code : keep[0].code);
    }

    codes[i] = finalCode;
    const src = matchResult.details.get(finalCode);
    let d = details.get(finalCode);
    if (!d) {
      d = src ? { ...src, count: 0, sumDelta: 0, maxDelta: 0 } : { code: finalCode, count: 0, sumDelta: 0, maxDelta: 0 };
      details.set(finalCode, d);
    }
    d.count++;
    if (src) {
      d.name = src.name;
      d.hex = src.hex;
      d.rgb = src.rgb;
    }
  }

  for (const d of details.values()) delete d.sumDelta;

  return {
    codes,
    details,
    unmatched: matchResult.unmatched,
    deltaStats: matchResult.deltaStats,
    reducedFrom: matchResult.details.size,
  };
}

module.exports = {
  matchOne,
  matchCodes,
  limitColorCount,
};