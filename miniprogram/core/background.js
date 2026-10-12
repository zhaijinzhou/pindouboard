/**
 * core/background.js —— 去背景（文档 §2.1「去背景」/ §4.1 `removeBackground`）
 *
 * 洪水填充从图像边缘识别背景。
 *
 * ⚠️ 【关键时序约束】必须在统计用量前执行，否则清单数量虚高。
 *    本模块在 §2 的处理链中被放在「像素化 → 增强 → 去背景 → 色号匹配」，
 *    保证 countUsage 拿到的已经是剔除背景后的矩阵。
 *
 * 背景判定策略（按优先级）：
 *   1. 边缘采样：以四边边界格的像素作为背景色样本，取众数作为基准背景色
 *   2. 洪水填充：从边界格出发 BFS，仅当某格与「基准背景色」的 RGB 距离
 *      ≤ tolerance 时才纳入背景（避免把画面中部的同色区域误删）
 *
 * 与「四角采样」的取舍：四角采样对纯色背景简单有效，但当背景本身有渐变
 * （如渐变天空）或主体触边时会失效。边缘众数 + 容差洪水填充对渐变的容忍度更好，
 * 因此作为默认实现。
 *
 * 纯逻辑层，不依赖 wx。
 */

const { BG_TOLERANCE_RANGE } = require('../utils/config');

/**
 * @param {object} grid    格点阵
 * @param {object} options { tolerance: 0~441 的 RGB 欧氏距离容差, default 30 }
 * @returns {{ grid, mask, bgColor, removedCount, ratio }}
 *   mask: Uint8Array，长度 cols*rows，1 = 背景
 *   grid: 新格点阵，背景格的 empty 标记为 true
 */
function removeBackground(grid, options = {}) {
  const tol = options.tolerance != null ? options.tolerance : BG_TOLERANCE_RANGE.default;
  const { cols, rows, cells } = grid;
  const total = cols * rows;

  // ---- 1. 边缘采样求基准背景色 ----
  const bgColor = estimateBackgroundColor(cells, cols, rows);

  // ---- 2. 洪水填充 ----
  const mask = new Uint8Array(total);
  const stack = [];
  let removedCount = 0;

  const pushIfBg = (i) => {
    if (mask[i]) return;
    const c = cells[i];
    if (!c || c.empty) return;
    if (rgbDistance(c.r, c.g, c.b, bgColor.r, bgColor.g, bgColor.b) <= tol) {
      mask[i] = 1;
      stack.push(i);
    }
  };

  // 从四边入队
  for (let x = 0; x < cols; x++) {
    pushIfBg(x);
    pushIfBg((rows - 1) * cols + x);
  }
  for (let y = 0; y < rows; y++) {
    pushIfBg(y * cols);
    pushIfBg(y * cols + cols - 1);
  }

  // BFS 扩散
  while (stack.length) {
    const i = stack.pop();
    removedCount++;
    const x = i % cols;
    const y = (i - x) / cols;
    if (x > 0) pushIfBg(i - 1);
    if (x < cols - 1) pushIfBg(i + 1);
    if (y > 0) pushIfBg(i - cols);
    if (y < rows - 1) pushIfBg(i + cols);
  }

  // ---- 3. 输出新格点阵 ----
  const outCells = new Array(total);
  for (let i = 0; i < total; i++) {
    const c = cells[i];
    if (!c) { outCells[i] = { r: 255, g: 255, b: 255, empty: true }; continue; }
    if (mask[i]) {
      outCells[i] = { r: bgColor.r, g: bgColor.g, b: bgColor.b, empty: true };
    } else {
      outCells[i] = { r: c.r, g: c.g, b: c.b };
    }
  }

  return {
    grid: { ...grid, cells: outCells },
    mask,
    bgColor,
    removedCount,
    ratio: removedCount / total,
  };
}

/**
 * 估计背景色：对四边边界格做 8 级量化，取出现频次最高的桶，返回桶内均值。
 * 量化可抵抗边缘上的少量抗锯齿过渡像素。
 */
function estimateBackgroundColor(cells, cols, rows) {
  const border = [];
  const push = (i) => { const c = cells[i]; if (c && !c.empty) border.push(c); };

  for (let x = 0; x < cols; x++) { push(x); push((rows - 1) * cols + x); }
  for (let y = 1; y < rows - 1; y++) { push(y * cols); push(y * cols + cols - 1); }

  if (border.length === 0) return { r: 255, g: 255, b: 255 };

  const STEP = 32;
  const buckets = new Map();
  for (const c of border) {
    const key = (Math.round(c.r / STEP) << 16) | (Math.round(c.g / STEP) << 8) | Math.round(c.b / STEP);
    let b = buckets.get(key);
    if (!b) { b = { n: 0, r: 0, g: 0, b: 0 }; buckets.set(key, b); }
    b.n++; b.r += c.r; b.g += c.g; b.b += c.b;
  }

  let best = null;
  for (const b of buckets.values()) if (!best || b.n > best.n) best = b;

  return {
    r: Math.round(best.r / best.n),
    g: Math.round(best.g / best.n),
    b: Math.round(best.b / best.n),
  };
}

/** RGB 欧氏距离（用于容差比较；此处只需快速近似，故不用 Lab） */
function rgbDistance(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

module.exports = {
  removeBackground,
  estimateBackgroundColor,
  rgbDistance,
};