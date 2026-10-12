/**
 * render/board.js —— 图纸渲染（文档 M5 / §4.1 `renderBoard`）
 *
 * 绘制要素（对应文档 §9「分板线」「留空角标」「色号标注」）：
 *   1. 色块底色
 *   2. 网格线
 *   3. 色号标注
 *   4. 分板粗线（每 boardSize 格一条，标注换板位置）
 *   5. 留空角标（默认左上角）
 *   6. 图例与标题
 *   7. 孤立格高亮（可选）
 *
 * 关键工程约束：
 *   setData 不参与绘制 —— 直接操作 Canvas 2D context，
 *   避免把 cols*rows 个色块塞进 setData 导致 JS→渲染层桥接卡顿。
 *
 * 纯绘制逻辑，不依赖 wx（ctx 由调用方注入），可在 Node 中用 mock ctx 测试。
 */

const { splitByBoard } = require('./canvas');
const { DISCLAIMER } = require('../utils/config');

/**
 * 绘制图纸主体
 *
 * @param {object} ctx     Canvas 2D context
 * @param {object} pattern 图纸模型
 * @param {object} layout  calcLayout 返回值
 * @param {object} options {
 *     offsetX, offsetY   在画布中的偏移（分板导出时用）
 *     crop              { x, y, w, h } 只绘制该区域（分板导出时用）
 *     isolated          孤立格索引数组，用于高亮
 *     showDisclaimer    是否绘制版权与免责信息
 *   }
 */
function renderBoard(ctx, pattern, layout, options = {}) {
  const { cols, rows } = pattern;

  // 预先把稀疏 cells 摊平成线性数组 + hex 查表，
  // 避免在 cols*rows 的双重循环里反复做 `"y,x"` 字符串拼接与哈希查找。
  // 52 格四板场景有 2704 格，此处优化对绘制耗时影响显著。
  const flat = options._flatCache || flattenCells(pattern);

  const cellPx = layout.cellPx;
  const ox = (options.offsetX || 0) + layout.padding;
  const oy = (options.offsetY || 0) + layout.padding;

  // 分板导出时的裁剪范围
  const cropX = options.crop ? options.crop.x : 0;
  const cropY = options.crop ? options.crop.y : 0;
  const cropW = options.crop ? options.crop.w : cols;
  const cropH = options.crop ? options.crop.h : rows;

  const showGrid = options.gridLine !== undefined ? options.gridLine
    : (pattern.render && pattern.render.gridLine !== undefined ? pattern.render.gridLine : true);
  const showCode = options.codeLabel !== undefined ? options.codeLabel
    : (pattern.render && pattern.render.codeLabel !== undefined ? pattern.render.codeLabel : true);

  ctx.save();

  // ---------- 1. 背景 ----------
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, layout.width, layout.height);

  // ---------- 2. 色块底色 ----------
  for (let y = cropY; y < cropY + cropH; y++) {
    for (let x = cropX; x < cropX + cropW; x++) {
      const code = flat.codes[y * cols + x];
      if (!code) continue;
      ctx.fillStyle = flat.hex[code] || '#cccccc';
      ctx.fillRect(ox + (x - cropX) * cellPx, oy + (y - cropY) * cellPx, cellPx, cellPx);
    }
  }

  // ---------- 3. 网格线 ----------
  if (showGrid) {
    ctx.strokeStyle = 'rgba(0,0,0,0.10)';
    ctx.lineWidth = layout.lineWidth;
    ctx.beginPath();
    for (let x = 0; x <= cropW; x++) {
      const px = ox + x * cellPx;
      ctx.moveTo(px, oy);
      ctx.lineTo(px, oy + cropH * cellPx);
    }
    for (let y = 0; y <= cropH; y++) {
      const py = oy + y * cellPx;
      ctx.moveTo(ox, py);
      ctx.lineTo(ox + cropW * cellPx, py);
    }
    ctx.stroke();
  }

  // ---------- 4. 色号标注 ----------
  // 逐格 fillText 开销大，仅在单格足够大时绘制（可打印）
  if (showCode && cellPx >= 14) {
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.font = `${layout.codeFontPx}px -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // 色号普遍为 1 字母 + 数字（如 H21 / S11），四字符宽度已足够；
    // 字距略收紧以适应窄格。
    ctx.font = `${layout.codeFontPx}px -apple-system, sans-serif`;

    for (let y = cropY; y < cropY + cropH; y++) {
      for (let x = cropX; x < cropX + cropW; x++) {
        const code = flat.codes[y * cols + x];
        if (!code) continue;
        ctx.fillText(
          code,
          ox + (x - cropX + 0.5) * cellPx,
          oy + (y - cropY + 0.5) * cellPx
        );
      }
    }
  }

  // ---------- 5. 分板粗线 ----------
  const boardSize = pattern.boardCount || 29;
  if (boardSize > 0 && boardSize < Math.max(cols, rows)) {
    ctx.strokeStyle = '#ff5b7f';
    ctx.lineWidth = layout.boardLineWidth;
    ctx.beginPath();
    for (let x = boardSize; x < cropW; x += boardSize) {
      const px = ox + x * cellPx;
      ctx.moveTo(px, oy);
      ctx.lineTo(px, oy + cropH * cellPx);
    }
    for (let y = boardSize; y < cropH; y += boardSize) {
      const py = oy + y * cellPx;
      ctx.moveTo(ox, py);
      ctx.lineTo(ox + cropW * cellPx, py);
    }
    ctx.stroke();
  }

  // ---------- 6. 留空角标 ----------
  const marker = pattern.originMarker || 'top-left';
  drawOriginMarker(ctx, ox, oy, cropW * cellPx, cropH * cellPx, marker, cellPx, layout);

  // ---------- 7. 孤立格高亮 ----------
  if (options.isolated && options.isolated.length && cellPx >= 10) {
    ctx.strokeStyle = 'rgba(240,69,58,0.85)';
    ctx.lineWidth = Math.max(1, cellPx * 0.08);
    for (const idx of options.isolated) {
      const y = Math.floor(idx / cols);
      const x = idx - y * cols;
      if (x < cropX || x >= cropX + cropW || y < cropY || y >= cropY + cropH) continue;
      ctx.strokeRect(
        ox + (x - cropX) * cellPx + 1,
        oy + (y - cropY) * cellPx + 1,
        cellPx - 2,
        cellPx - 2
      );
    }
  }

  // ---------- 8. 图纸边框 ----------
  ctx.strokeStyle = '#d8dbe0';
  ctx.lineWidth = Math.max(1, cellPx * 0.06);
  ctx.strokeRect(ox, oy, cropW * cellPx, cropH * cellPx);

  ctx.restore();

  // ---------- 9. 标题与免责信息（画在底部，不参与裁剪） ----------
  if (options.showDisclaimer !== false) {
    drawFooter(ctx, pattern, layout);
  }
}

/**
 * 留空角标：在起点位置画一个「从这里开始」的标记。
 * 拼接时用户需要知道图纸从哪一格开始，留空角标用于消除歧义。
 */
function drawOriginMarker(ctx, ox, oy, w, h, marker, cellPx, layout) {
  const r = Math.max(3, cellPx * 0.28);
  ctx.save();
  ctx.fillStyle = 'rgba(61,126,255,0.92)';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(1, cellPx * 0.05);

  let cx, cy;
  switch (marker) {
    case 'bottom-right': cx = ox + w - r; cy = oy + h - r; break;
    case 'top-right': cx = ox + w - r; cy = oy + r; break;
    case 'bottom-left': cx = ox + r; cy = oy + h - r; break;
    default: cx = ox + r; cy = oy + r; break;
  }

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // 中心点，确认这是起点标记
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(1, r * 0.35), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * 底部图例与合规声明
 */
function drawFooter(ctx, pattern, layout) {
  const baseY = layout.height - layout.padding * 0.8;
  ctx.save();
  ctx.fillStyle = '#5c6066';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const sizeText = `${pattern.physicalSize ? pattern.physicalSize.width : '?'} × ` +
    `${pattern.physicalSize ? pattern.physicalSize.height : '?'} cm` +
    ` · ${pattern.totalCount} 格 · ${pattern.colors.length} 色`;

  ctx.font = '12px -apple-system, sans-serif';
  ctx.fillText(sizeText, layout.padding, baseY - 14);

  // S-05 IP 版权提示：固定标注，不可关闭
  ctx.fillStyle = '#f0453a';
  ctx.font = '11px -apple-system, sans-serif';
  ctx.fillText(DISCLAIMER.copyright, layout.padding, baseY);

  ctx.restore();
}

/**
 * 绘制图例（色号 → 颜色 → 用量），渲染到独立 Canvas。
 * 放在 result 页底部，不与图纸同图，避免图纸被撑得过大。
 */
function renderLegend(ctx, pattern, width, options = {}) {
  const rowH = options.rowH || 34;
  const cols = options.perRow || 2;
  const list = pattern.colors || [];

  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, rowH * Math.ceil(list.length / cols) + 20);

  ctx.textBaseline = 'middle';
  list.forEach((c, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = 10 + col * (width - 20) / cols;
    const y = 14 + row * rowH;

    // 色块
    ctx.fillStyle = c.hex;
    roundRect(ctx, x, y - 9, 20, 18, 3);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 色号 + 名称
    ctx.fillStyle = '#1a1a1a';
    ctx.font = '12px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${c.code} ${c.name}`, x + 28, y);

    // 用量
    ctx.fillStyle = '#9aa0a6';
    ctx.textAlign = 'right';
    ctx.fillText(`${c.count} 颗`, x + (width - 20) / cols - 6, y);
  });

  ctx.restore();
}

/** 圆角矩形路径 */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * 把图纸的稀疏 cells 摊平为线性数组 + hex 查表（渲染性能优化）。
 *
 * @param {object} pattern
 * @returns {{ codes: string[], hex: Object, cols, rows }}
 */
function flattenCells(pattern) {
  const cols = pattern.cols || 0;
  const rows = pattern.rows || 0;
  // S-04：cells 缺失时按全空图纸处理，避免渲染阶段崩溃
  const cells = (pattern && typeof pattern.cells === 'object' && pattern.cells) || {};
  const codes = new Array(cols * rows).fill('');

  for (let i = 0; i < cols * rows; i++) {
    const y = (i / cols) | 0;
    const x = i - y * cols;
    const v = cells[`${y},${x}`];
    if (v) codes[i] = v;
  }

  const hex = {};
  for (const c of pattern.colors || []) hex[c.code] = c.hex;

  return { codes, hex, cols, rows };
}

/**
 * 为图纸附加色号索引（Map<code, {hex}>），供渲染快速查色。
 * 在 renderBoard 前调用一次，避免逐格遍历 colors 数组。
 */
function attachIndex(pattern) {
  const index = new Map();
  for (const c of pattern.colors || []) {
    index.set(c.code, c);
  }
  pattern._index = index;
  return pattern;
}

/**
 * 分板渲染：把图纸拆成若干块，逐块并排绘制到同一画布（带间隙与编号）。
 * 对应文档 P-06「大图分板渲染」。
 *
 * ⚠️ 关键：layout 必须是**单块板**的布局，而非整张图纸的布局。
 *    否则每块偏移量按整图宽度计算，而裁剪区只有一块板，会出现大段空白与错位。
 *
 * @param {object} ctx
 * @param {object} pattern
 * @param {object} boardLayout calcLayout(单板尺寸) 的结果
 * @param {object} options
 * @returns {{ regions, totalWidth, height }}
 */
function renderSplit(ctx, pattern, boardLayout, options = {}) {
  const boardSize = pattern.boardCount || 29;
  const regions = splitByBoard(pattern, boardSize);
  const gap = options.gap != null ? options.gap : boardLayout.cellPx;

  const totalWidth = regions.length * boardLayout.width + (regions.length - 1) * gap;
  const height = boardLayout.height;

  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, totalWidth, height);

  regions.forEach((r, i) => {
    const offsetX = i * (boardLayout.width + gap);

    renderBoard(ctx, pattern, boardLayout, {
      ...options,
      offsetX,
      offsetY: 0,
      crop: { x: r.x, y: r.y, w: r.w, h: r.h },
      // 底部声明在整图末尾统一画一次，避免每块重复
      showDisclaimer: false,
    });

    // 块编号（如「第 1 块」），并标注换板坐标
    ctx.fillStyle = '#5c6066';
    ctx.font = `${Math.max(11, boardLayout.titleFontPx * 0.6)}px -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(
      `${r.label}（第 ${r.y + 1} 行 / 第 ${r.x + 1} 列 起）`,
      offsetX + boardLayout.width / 2,
      height - 6
    );
  });

  ctx.restore();
  return { regions, totalWidth, height };
}

module.exports = {
  renderBoard,
  renderLegend,
  renderSplit,
  flattenCells,
  attachIndex,
  drawOriginMarker,
};