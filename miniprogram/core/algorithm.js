/**
 * core/algorithm.js —— 主导色 / 区域均值（文档 §2.1 双算法 / D-03 主导色区域划分规则）
 *
 * cartoon 主导色模式
 *   取区域内「出现频次最高」的颜色作主色。
 *   解决的问题：卡通/动漫风格的图片有大量深浅交界，若用均值，
 *   深色描边会被稀释成灰边；用主导色则描边保持纯黑，轮廓清晰。
 *
 * photo 区域均值模式
 *   计算区域平均色，过渡柔和，适合风景、人像。
 *
 * 【D-03 主导色区域划分规则 —— 本实现采用的规则】
 *   1. 以目标格为单位，格内再划分 q×q 的子采样网格（q = sampleScale，默认 3）。
 *      规则依据：直接统计整格像素在 sampleScale=1 时容易受压缩噪点影响；
 *      q=3 时 9 个子样本已足以反映视觉主导色，同时计算量可控。
 *   2. 每个子样本取其像素颜色，按 quantizeStep=32 对 RGB 三通道做桶量化。
 *      规则依据：量化步长过小则噪点被当成独立颜色，步长过大则真实渐变被抹平；
 *      32 步长（约 8 级/通道）既能合并压缩噪点，又保留主要色块边界。
 *   3. 统计每个桶的出现频次，取频次最高者为该格主色。
 *   4. 若最高频次 < minPixels（默认 3），认为该格颜色过于分散（如渐变天空），
 *      回退到区域均值模式，避免选出一个仅占 1 票的噪声色。
 */

const { DOMINANT } = require('../utils/config');

/**
 * 对格点阵执行区域聚合，得到每个格的代表色。
 *
 * 【D-03 说明】本函数接收的是「高采样格点阵」：
 *   pixelate 阶段按 cols*sampleScale × rows*sampleScale 输出，
 *   本函数再按 sampleScale 聚合成最终 cols × rows。
 *   这样做的原因：只有在子像素级别统计频次，才能真正判断「哪个颜色占主导」；
 *   如果先聚合成一格再统计，频次信息已经丢失。
 *
 * @param {object} hiGrid  高采样格点阵（cols = targetCols * q）
 * @param {object} options { mode:'cartoon'|'photo', sampleScale, quantizeStep, minPixels }
 * @returns {object} 输出格点阵（cols/rows 为目标尺寸）
 */
function aggregate(hiGrid, options = {}) {
  const mode = options.mode || 'cartoon';
  const q = Math.max(1, options.sampleScale || 3);

  const outCols = Math.floor(hiGrid.cols / q);
  const outRows = Math.floor(hiGrid.rows / q);

  if (outCols < 1 || outRows < 1) {
    // 高采样格点阵比目标还小，无法聚合，原样返回
    return hiGrid;
  }

  const cells = new Array(outCols * outRows);
  const stats = { dominantCells: 0, fallbackCells: 0 };

  for (let oy = 0; oy < outRows; oy++) {
    for (let ox = 0; ox < outCols; ox++) {
      // 收集该目标格对应的 q×q 子样本
      const samples = [];
      for (let sy = 0; sy < q; sy++) {
        for (let sx = 0; sx < q; sx++) {
          const idx = (oy * q + sy) * hiGrid.cols + (ox * q + sx);
          const c = hiGrid.cells[idx];
          if (c && !c.empty) samples.push(c);
        }
      }

      const outIdx = oy * outCols + ox;

      if (samples.length === 0) {
        cells[outIdx] = { r: 255, g: 255, b: 255, empty: true };
        continue;
      }

      if (mode === 'photo') {
        cells[outIdx] = areaMean(samples);
        stats.fallbackCells++;
      } else {
        const res = dominantColor(samples, options);
        cells[outIdx] = res;
        if (res.__fallback) stats.fallbackCells++;
        else stats.dominantCells++;
        delete cells[outIdx].__fallback;
      }
    }
  }

  return {
    cols: outCols,
    rows: outRows,
    cells,
    sourceWidth: hiGrid.sourceWidth,
    sourceHeight: hiGrid.sourceHeight,
    stats,
  };
}

/**
 * 主导色：取区域内出现频次最高的颜色。
 *
 * @param {Array} samples 子样本数组 [{r,g,b}]
 * @returns {object} 代表色
 */
function dominantColor(samples, options = {}) {
  const step = options.quantizeStep || DOMINANT.quantizeStep;
  const minPixels = options.minPixels || DOMINANT.minPixels;

  // 1. 桶量化统计频次
  const buckets = new Map();
  for (const s of samples) {
    const qr = Math.min(255, Math.round(s.r / step));
    const qg = Math.min(255, Math.round(s.g / step));
    const qb = Math.min(255, Math.round(s.b / step));
    const key = (qr << 16) | (qg << 8) | qb;
    let b = buckets.get(key);
    if (!b) {
      b = { count: 0, r: 0, g: 0, b: 0 };
      buckets.set(key, b);
    }
    b.count++;
    b.r += s.r;
    b.g += s.g;
    b.b += s.b;
  }

  // 2. 找频次最高的桶
  let best = null;
  let bestCount = 0;
  for (const b of buckets.values()) {
    if (b.count > bestCount) {
      bestCount = b.count;
      best = b;
    }
  }

  // 3. 颜色过于分散 → 回退均值
  if (!best || bestCount < minPixels) {
    return { ...areaMean(samples), __fallback: true };
  }

  // 4. 用桶内实际像素的均值，避免量化带来的阶梯误差
  return {
    r: Math.round(best.r / best.count),
    g: Math.round(best.g / best.count),
    b: Math.round(best.b / best.count),
  };
}

/**
 * 区域均值：算术平均。
 */
function areaMean(samples) {
  let r = 0, g = 0, b = 0;
  for (const s of samples) { r += s.r; g += s.g; b += s.b; }
  const n = samples.length;
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

/**
 * Floyd-Steinberg 抖动（文档 §2.1：可选，默认关闭）
 *
 * ⚠️ 抖动在拼豆场景下是「可选但需谨慎」的功能：
 *    它通过把量化误差扩散到相邻格来模拟中间色，能提升照片的渐变过渡，
 *    但会产生大量零碎色，与「控制颜色数量」的核心诉求冲突。
 *    因此默认关闭（P-07：开启会增加显著计算量且产生零碎色）。
 *
 * 实现作用于「已匹配色号的 RGB 目标值」上：把当前格量化到最近色号后，
 * 把残差按 FS 权重分摊给右、左下、下、右下四个邻居。
 *
 * @param {object} grid   格点阵（RGB）
 * @param {object} palette 色库索引
 * @param {object} options { beadSize, onlyCodes }
 * @returns {object} 抖动后的格点阵（RGB 值已修正）
 */
function applyDither(grid, palette, options = {}) {
  // 延迟 require 避免循环依赖：match → lab → config
  const { matchOne } = require('../color/match');
  const { selectCandidates } = require('../color/palette-loader');

  const candidates = selectCandidates(palette, options.beadSize, options.onlyCodes);
  if (!candidates.length) return grid;

  const { cols, rows } = grid;
  const cells = grid.cells.map((c) => (c ? { ...c } : c));

  // 误差缓冲：累积到邻居上的量化误差
  const errR = new Float32Array(cols * rows);
  const errG = new Float32Array(cols * rows);
  const errB = new Float32Array(cols * rows);

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const c = cells[i];
      if (!c || c.empty) continue;

      // 带误差修正的目标值
      const tr = clamp255(c.r + errR[i]);
      const tg = clamp255(c.g + errG[i]);
      const tb = clamp255(c.b + errB[i]);

      // 量化到最近色号
      const m = matchOne(tr, tg, tb, candidates, {});
      if (!m) continue;

      // 计算量化残差（带误差目标值 - 实际命中色）
      const er = tr - m.rgb[0];
      const eg = tg - m.rgb[1];
      const eb = tb - m.rgb[2];

      // FS 权重扩散：右 7/16、左下 3/16、正下 5/16、右下 1/16
      distribute(cols, rows, x + 1, y, errR, errG, errB, er, eg, eb, 7 / 16);
      distribute(cols, rows, x - 1, y + 1, errR, errG, errB, er, eg, eb, 3 / 16);
      distribute(cols, rows, x, y + 1, errR, errG, errB, er, eg, eb, 5 / 16);
      distribute(cols, rows, x + 1, y + 1, errR, errG, errB, er, eg, eb, 1 / 16);

      // 写回量化结果（后续 matchCodes 会据此匹配到该色号）
      cells[i] = { r: m.rgb[0], g: m.rgb[1], b: m.rgb[2], empty: c.empty };
    }
  }

  return { ...grid, cells };
}

/**
 * 把残差按权重累加到指定坐标格。
 * 越界坐标直接忽略（这是 FS 算法的正常行为）。
 */
function distribute(cols, rows, x, y, errR, errG, errB, er, eg, eb, weight) {
  if (x < 0 || y < 0 || x >= cols || y >= rows) return;
  const idx = y * cols + x;
  errR[idx] += er * weight;
  errG[idx] += eg * weight;
  errB[idx] += eb * weight;
}

function clamp255(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

module.exports = {
  aggregate,
  dominantColor,
  areaMean,
  applyDither,
};