/**
 * core/preview.js —— 参数配置阶段的实时预览（文档 §2 流程的可视化前置）
 *
 * 【为什么要单独一套预览逻辑】
 *   editor 页跑的是完整处理链：高采样（sampleScale=3）+ 全量色号匹配 +
 *   杂色合并 + 体检，单次耗时可达数百毫秒。参数配置页需要在拖动滑块、
 *   连点 chip 时**实时**反馈，逐次跑全链路会明显卡顿。
 *
 *   预览的取舍：
 *     1. 先把像素缓冲面积平均降采样到 PREVIEW.maxSourceEdge（默认 220px）
 *     2. sampleScale 固定为 1（不做子采样主导色统计）
 *     3. 跳过体检与用量清单的精细化，仅取色号矩阵用于画缩略图
 *   结果是「配色与构图可信，细节纹理略有简化」——正好是配置阶段需要的信息量。
 *
 * 纯逻辑层：只处理像素数组与格点阵，Canvas 绘制由调用方注入 ctx。
 */

const { pixelate, deriveGrid } = require('./pixelate');
const { aggregate } = require('./algorithm');
const { enhance } = require('./enhance');
const { removeBackground } = require('./background');
const { mergeSimilar } = require('./merge');
const { matchCodes, limitColorCount } = require('../color/match');
const { getPalette } = require('../color/palette-loader');
const { MERGE_DEFAULT_DELTA } = require('../utils/config');

/** 预览专用参数：不写进 utils/config.js 的默认配置，仅预览链路使用 */
const PREVIEW = {
  /** 预览用像素源的最长边（px）。越大越清晰也越慢，220px 足够表达配色 */
  maxSourceEdge: 220,
  /**
   * 预览的子采样倍率。
   *
   * ⚠️ 不能用 1：主导色算法的本质是「在格内统计频次」，只有 1 个子样本时
   * 桶统计退化为单点判断，cartoon 与 photo 输出完全相同 —— 表现为
   * 「切换算法模式但预览不变」，用户会以为开关坏了。
   * 取 2 让每格有 2×2=4 个子样本，既能区分两种算法，又把计算量压在实时范围内。
   */
  sampleScale: 2,
  /**
   * 预览缩略图单格边长区间（px）。
   *
   * ⚠️ 下限不能太小：实测 cartoon 与 photo 在真实照片上约 5% 的格子取色不同，
   *    若单格只有 4~5px，色差在缩略图上完全看不出来，用户会以为预览没生效。
   *    取 8px 起，保证取色差异可辨。
   *
   * ⚠️ 但这是**软下限**：≥40 格时容器的宽度上限已低于 8px（375px 屏约 5px），
   *    此时由 fitCanvasLayout 自动让步，绝不能为了守住下限而把画布撑出容器
   *    —— 那正是「图纸被压扁」bug 的形态。此时改由预览卡的指标条
   *    （颜色数 / 实心占比 / 格点阵）承担「确认参数生效」的职责。
   */
  minCellPx: 8,
  maxCellPx: 16,
  /** 画布内边距（px）。预览画布同样走 px 内联样式 */
  padding: 6,
  /** 绝对下限（px），容器极端不足时的兜底，防 0 / 负 */
  hardFloor: 2,
  /**
   * 预览区高度预算 = 视口高度 × 本系数。
   *
   * ⚠️ 0.34（历史值）会让**高度**先于宽度成为约束：375×667 上 52 格只能拿到
   *    4px/格，比宽度本可给的 5px 还小，缩略图被白白缩小。
   *    提到 0.45 后由宽度决定单格，与 editor / result 行为对齐。
   */
  heightRatio: 0.45,
  /** 参数变更后的防抖间隔（ms）—— 拖动滑块时避免中间态反复计算 */
  debounceMs: 180,
};

/**
 * 面积平均降采样：把像素缓冲缩到最长边 ≤ maxEdge。
 *
 * 为什么用面积平均而不是最近邻：
 *   最近邻会丢掉大量像素，拼豆预览里表现为「细小结构凭空消失」，
 *   甚至整块色偏（只采到某个高频噪点）。面积平均的代价是遍历全部源像素，
 *   但预览源本身已是缩略图，这个开销可忽略。
 *
 * @param {{width, height, data}} imageData RGBA 像素缓冲
 * @param {number} maxEdge 目标最长边
 * @returns {{width, height, data}} 降采样后的缓冲
 */
function downsample(imageData, maxEdge) {
  const sw = imageData.width;
  const sh = imageData.height;
  const longest = Math.max(sw, sh);

  if (longest <= maxEdge) {
    return { width: sw, height: sh, data: imageData.data };
  }

  const scale = maxEdge / longest;
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  const out = new Uint8ClampedArray(dw * dh * 4);

  const ratioX = sw / dw;
  const ratioY = sh / dh;

  for (let dy = 0; dy < dh; dy++) {
    // 该目标行对应的源行区间（至少 1 行，避免极端比例下取空）
    const y0 = Math.floor(dy * ratioY);
    const y1 = Math.max(y0 + 1, Math.floor((dy + 1) * ratioY));

    for (let dx = 0; dx < dw; dx++) {
      const x0 = Math.floor(dx * ratioX);
      const x1 = Math.max(x0 + 1, Math.floor((dx + 1) * ratioX));

      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        let idx = (sy * sw + x0) * 4;
        for (let sx = x0; sx < x1; sx++) {
          r += imageData.data[idx];
          g += imageData.data[idx + 1];
          b += imageData.data[idx + 2];
          a += imageData.data[idx + 3];
          n++;
          idx += 4;
        }
      }

      const o = (dy * dw + dx) * 4;
      out[o] = n ? r / n : 0;
      out[o + 1] = n ? g / n : 0;
      out[o + 2] = n ? b / n : 0;
      out[o + 3] = n ? a / n : 255;
    }
  }

  return { width: dw, height: dh, data: out };
}

/**
 * 为预览构建（并缓存）降采样后的像素源。
 * 参数配置页每次参数变更都要复用同一份源，避免重复降采样。
 *
 * ⚠️ 缓存挂在 session 对象上，而 session 会在「换图」或「调整取景」时被
 *    整体替换（新的 imageData）。此时 previewSource 必须失效，
 *    否则会把上一张图的降采样结果错用在新图上。
 *
 *    有效性判据只看**尺寸是不够的**：调整取景框后，裁剪区域可能恰好
 *    与上次同尺寸（例如从整图拖成同宽的另一半），像素内容已完全不同。
 *    因此额外用「首像素 + 中点像素 + 末像素」做廉价指纹，
 *    覆盖横竖两个方向，足以区分不同的图或不同的取景，
 *    且开销固定为 3 次读取，与图像大小无关。
 *
 * @param {object} session app.globalData.session
 * @returns {{width, height, data}|null}
 */
function getPreviewSource(session) {
  if (!session || !session.imageData) return null;

  const img = session.imageData;
  const cached = session.previewSource;

  if (cached
    && cached.srcWidth === img.width
    && cached.srcHeight === img.height
    && cached.fingerprint === fingerprint(img)) {
    return cached.buffer;
  }

  const buffer = downsample(img, PREVIEW.maxSourceEdge);
  session.previewSource = {
    srcWidth: img.width,
    srcHeight: img.height,
    fingerprint: fingerprint(img),
    buffer,
  };
  return buffer;
}

/**
 * 像素缓冲的廉价指纹：取首、中、末三个像素。
 * 开销恒定，用极小的代价换取「同尺寸不同内容」的可识别性。
 */
function fingerprint(img) {
  const d = img.data;
  const n = img.width * img.height;
  const mid = Math.floor(n / 2);
  const last = n - 1;
  return `${d[0]},${d[mid * 4]},${d[last * 4]},${d[mid * 4 + 1]},${d[last * 4 + 2]}`;
}

/**
 * 生成预览用的图纸对象。
 *
 * @param {object} source 降采样后的像素源
 * @param {object} params 当前参数
 * @param {Array<string>} [onlyCodes] 库存限定色集
 * @returns {{pattern, codes, details, colorCount, cols, rows}}
 */
function buildPreview(source, params, onlyCodes) {
  // ⚠️ v0.9：横向板数必须与 pipeline.run 保持一致，
  //    否则预览显示单板、最终出图却是双板，用户会以为预览失真。
  const boardCols = Math.max(1, params.boardCols || 1);
  const gridSpec = deriveGrid(source.width, source.height, params.boardCount || 29, boardCols);

  // 高采样 → 区域聚合，让主导色算法有子样本可统计（见 PREVIEW.sampleScale 注释）
  const q = PREVIEW.sampleScale;
  let grid = pixelate(source, gridSpec.cols * q, gridSpec.rows * q);

  grid = aggregate(grid, {
    mode: params.mode,
    sampleScale: q,
    quantizeStep: params.quantizeStep,
    minPixels: params.minPixels,
  });

  if (params.enhance) {
    grid = enhance(grid, {
      contrast: params.contrast || 0.15,
      saturation: params.saturation || 0.1,
      brightness: params.brightness || 0,
    });
  }

  /*
   * ⚠️ 去背景必须在色号匹配**之前**执行，与 pipeline.js 的时序一致。
   *    漏掉这一步会导致：开了「去背景」但预览毫无变化 ——
   *    用户会认为开关失效。预览必须与正式链路逐步对齐，
   *    否则任何新参数在预览里都「看不出效果」。
   */
  let bgMask = null;
  if (params.removeBg) {
    const bg = removeBackground(grid, { tolerance: params.bgTolerance });
    grid = bg.grid;
    bgMask = bg.mask;
  }

  const palette = getPalette(params.brand);
  let match = matchCodes(grid, palette, {
    brand: params.brand,
    beadSize: params.beadSize,
    onlyCodes,
    deltaMethod: undefined,
    huePruneAngle: params.huePruneAngle,
  });

  if (params.colorLimit && match.details.size > params.colorLimit) {
    match = limitColorCount(match, grid, params.colorLimit, palette);
  }

  /*
   * 杂色合并：与正式链路同序（色号匹配 → 颜色数上限 → 杂色合并）。
   * 漏掉同样会让「合并阈值」滑块在预览里看不出效果。
   */
  if (params.mergeSimilar) {
    const merged = mergeSimilar(match.codes, grid.cols, grid.rows, {
      delta: params.mergeDelta != null ? params.mergeDelta : MERGE_DEFAULT_DELTA,
      palette,
      beadType: params.beadType,
    });
    match.codes = merged.codes;
    match.details = recountPreviewDetails(merged.codes, match.details);
  }

  // 背景格标记为空，渲染时不画色块（留白）
  let codes = match.codes;
  if (bgMask) {
    codes = codes.slice();
    for (let i = 0; i < codes.length; i++) {
      if (bgMask[i]) codes[i] = '';
    }
  }

  // 组装与正式图纸同构的稀疏 cells，渲染层可复用同一套绘制逻辑
  const { cols, rows } = grid;
  const cells = {};
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (!code) continue;
    const y = Math.floor(i / cols);
    cells[`${y},${i - y * cols}`] = code;
  }

  const colors = [];
  for (const [code, d] of match.details) {
    colors.push({ code, name: d.name, hex: d.hex, count: d.count });
  }
  colors.sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : 1));

  return {
    cols,
    rows,
    codes,
    details: match.details,
    colors,
    colorCount: colors.length,
    gridSpec,
    bgRatio: bgMask ? countMask(bgMask) : 0,
    pattern: {
      cols,
      rows,
      boardCount: params.boardCount,
      colors,
      cells,
      originMarker: 'top-left',
      render: {
        gridLine: params.gridLine !== false,
        codeLabel: false,
      },
    },
  };
}

/** 背景掩码占比（0~1），用于 UI 提示「去掉了多少」 */
function countMask(mask) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n / mask.length;
}

/**
 * 合并后重算 details。
 * 与 pipeline.js 的 recountDetails 同理：合并会产生新的簇主色，
 * 用量变了，颜色清单必须同步，否则预览的「N 色」会与实际不符。
 */
function recountPreviewDetails(codes, oldDetails) {
  const counts = new Map();
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (!c) continue;
    counts.set(c, (counts.get(c) || 0) + 1);
  }

  const out = new Map();
  for (const [code, count] of counts) {
    const src = oldDetails.get(code);
    if (src) out.set(code, { ...src, count });
    else out.set(code, { code, name: code, hex: '#cccccc', rgb: [204, 204, 204], count });
  }
  return out;
}

/**
 * 绘制预览缩略图。
 *
 * 与 render/board.js 的 renderBoard 分开实现，原因有二：
 *   1. 预览不需要留空角标、分板粗线、色号文字 —— 这些在缩略尺寸下
 *      要么不可见要么糊成一团，反而干扰配色判断；
 *   2. 预览是逐格 fillRect 的纯色块，逻辑极简，避免把正式渲染的
 *      全部开关参数透传到配置页。
 *
 * @param {object} ctx Canvas 2D context
 * @param {object} preview buildPreview 的返回值
 * @param {{cellPx, padding, showGrid}} layout
 */
function drawPreview(ctx, preview, layout) {
  const { cols, rows, pattern } = preview;
  const cellPx = layout.cellPx;
  const pad = layout.padding;
  const width = cols * cellPx + pad * 2;
  const height = rows * cellPx + pad * 2;

  // hex 查表，避免逐格遍历 colors
  const hex = {};
  for (const c of pattern.colors) hex[c.code] = c.hex;

  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const codes = preview.codes;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const code = codes[y * cols + x];
      if (!code) continue;
      ctx.fillStyle = hex[code] || '#cccccc';
      ctx.fillRect(pad + x * cellPx, pad + y * cellPx, cellPx, cellPx);
    }
  }

  if (layout.showGrid && cellPx >= 6) {
    ctx.strokeStyle = 'rgba(0,0,0,0.10)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let x = 0; x <= cols; x++) {
      const px = pad + x * cellPx;
      ctx.moveTo(px, pad);
      ctx.lineTo(px, pad + rows * cellPx);
    }
    for (let y = 0; y <= rows; y++) {
      const py = pad + y * cellPx;
      ctx.moveTo(pad, py);
      ctx.lineTo(pad + cols * cellPx, py);
    }
    ctx.stroke();
  }

  ctx.strokeStyle = '#d8dbe0';
  ctx.lineWidth = 1;
  ctx.strokeRect(pad, pad, cols * cellPx, rows * cellPx);
  ctx.restore();

  return { width, height };
}

module.exports = {
  PREVIEW,
  downsample,
  getPreviewSource,
  buildPreview,
  drawPreview,
  fingerprint,
};
