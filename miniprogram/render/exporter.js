/**
 * render/exporter.js —— PNG 导出（文档 M6 / P-01 / D-05）
 *
 * 目标：输出 ≥2048px 的高清图纸，保证色号文字打印清晰。
 *
 * 【D-05 结论：导出尺寸限制的解法】
 *   小程序 wx.canvasToTempFilePath 对输出尺寸有机型相关上限，
 *   直接申请超大 Canvas 在中低端机上易触发内存崩溃。
 *   本实现采用三级策略：
 *
 *   1) 单图导出：图纸可容纳于单次 Canvas 上限时，直接整张导出（最高分辨率）
 *   2) 分板导出：超出上限时按板拆成多张图，每张独立导出
 *      —— 用户可分别打印后拼接，或按板分次施工（对应 P1「分板施工单」）
 *   3) 降级导出：OffscreenCanvas 不可用时回退到页面 Canvas，
 *      并明确告知用户导出分辨率受限
 *
 *   尺寸选择不是越大越好：单格边长超过 64px 后，
 *   再提升对打印清晰度无实质增益，反而显著增加体积与内存占用。
 */

const { EXPORT, DISCLAIMER } = require('../utils/config');
const { renderBoard, renderSplit, attachIndex } = require('./board');
const { calcLayout, createOffscreen, toTempFile, splitByBoard, needSplit } = require('./canvas');

/**
 * 导出图纸为 PNG
 *
 * @param {object} pattern 图纸模型
 * @param {object} options {
 *     canvasId     降级模式下使用的页面 canvas id
 *     split        强制分板导出
 *     showCode     是否绘制色号标注
 *     showGrid     是否绘制网格线
 *     isolated     孤立格索引数组（高亮）
 * }
 * @returns {Promise<{ files: string[], width, height, split, degraded, note }>}
 */
async function exportPattern(pattern, options = {}) {
  attachIndex(pattern);

  const boardSize = pattern.boardCount || 29;
  const longest = Math.max(pattern.cols, pattern.rows);

  // 反推单格边长：既满足目标边长，又不超过上限
  let cellPx = Math.max(
    EXPORT.minCellPx,
    Math.min(EXPORT.maxCellPx, Math.ceil(EXPORT.targetEdge / longest))
  );

  // 判断是否需要分板
  const mustSplit = options.split || needSplit(pattern, cellPx);
  const singleSize = pattern.cols * cellPx > EXPORT.maxCanvasEdge ||
    pattern.rows * cellPx > EXPORT.maxCanvasEdge;
  const split = mustSplit || singleSize;

  const drawOptions = {
    gridLine: options.showGrid,
    codeLabel: options.showCode,
    isolated: options.isolated,
    showDisclaimer: options.showDisclaimer !== false,
  };

  /* ---------- 分板导出 ---------- */
  if (split) {
    return exportByBoard(pattern, boardSize, cellPx, drawOptions, options);
  }

  /* ---------- 单图导出 ---------- */
  const layout = calcLayout(pattern, { cellPx, padding: 28 });
  const off = createOffscreen(layout.width, layout.height);

  if (!off.ctx) {
    // 降级：OffscreenCanvas 不可用
    return exportWithPageCanvas(pattern, layout, drawOptions, options);
  }

  renderBoard(off.ctx, pattern, layout, drawOptions);

  const path = await toTempFile(off.canvas, layout.width, layout.height, {});
  return {
    files: [path],
    width: layout.width,
    height: layout.height,
    split: false,
    degraded: false,
    note: cellPx >= EXPORT.minCellPx
      ? `已导出 ${layout.width}×${layout.height}px，色号可清晰打印。`
      : `已导出 ${layout.width}×${layout.height}px，色号字号偏小，建议减小格数以提高分辨率。`,
  };
}

/**
 * 分板导出：每块板一张 PNG
 */
async function exportByBoard(pattern, boardSize, cellPx, drawOptions, options) {
  const regions = splitByBoard(pattern, boardSize);

  // 分板时 layout 按「单板尺寸」计算，而非整图尺寸
  const boardPattern = { ...pattern, cols: boardSize, rows: boardSize };
  const layout = calcLayout(boardPattern, { cellPx, padding: 28 });
  const gap = Math.max(8, cellPx);

  // 计算并排总宽高
  const totalWidth = regions.length * layout.width + (regions.length - 1) * gap;
  const totalHeight = layout.height + Math.max(24, cellPx);

  const off = createOffscreen(totalWidth, totalHeight);
  if (!off.ctx) {
    return {
      files: [],
      split: true,
      degraded: true,
      note: '当前环境不支持离屏渲染，分板导出不可用。请在微信客户端中打开后重试。',
    };
  }

  // 并排渲染所有板 —— 一次出图，避免用户逐块保存
  const info = renderSplit(off.ctx, pattern, layout, drawOptions);

  const path = await toTempFile(off.canvas, info.totalWidth, info.height, {});
  return {
    files: [path],
    width: info.totalWidth,
    height: info.height,
    split: true,
    regions: info.regions,
    degraded: false,
    note: `图纸已按 ${info.regions.length} 块板并排导出（每块 ${boardSize}×${boardSize} 格）。`
      + '打印后可沿分板线裁切分开施工。',
  };
}

/**
 * 降级导出：使用页面内 Canvas。
 * 页面 Canvas 的尺寸受布局限制，分辨率通常低于离屏方案。
 */
async function exportWithPageCanvas(pattern, layout, drawOptions, options) {
  const { getCanvasNode } = require('./canvas');
  const canvasId = options.canvasId || 'exportCanvas';

  try {
    const { canvas, ctx } = await getCanvasNode(canvasId, layout.width, layout.height);
    renderBoard(ctx, pattern, layout, drawOptions);
    const path = await toTempFile(canvas, layout.width, layout.height, { id: canvasId, node: canvas });
    return {
      files: [path],
      width: layout.width,
      height: layout.height,
      split: false,
      degraded: true,
      note: `当前环境不支持离屏渲染，已降级导出 ${layout.width}×${layout.height}px。`
        + '若色号不够清晰，建议在微信正式客户端中导出。',
    };
  } catch (e) {
    return {
      files: [],
      degraded: true,
      note: '导出失败：' + (e.message || '未知错误'),
    };
  }
}

/**
 * 导出用量清单为可分享的文本（便于用户复制到备忘录/微信收藏）
 */
function buildChecklistText(pattern) {
  const lines = [];
  const p = pattern.physicalSize || {};
  lines.push(`【${pattern.brand} 拼豆图纸清单】`);
  lines.push(`成品尺寸：${p.width || '?'} × ${p.height || '?'} cm`);
  lines.push(`板数：${pattern.boardCount} 格 × ${Math.ceil(pattern.cols / pattern.boardCount)} 块`);
  lines.push(`总格数：${pattern.totalCount}`);
  lines.push(`建议备豆：约 ${pattern.suggestedBeads} 颗（含损耗）`);
  lines.push(`颜色数：${pattern.colors.length} 色`);
  lines.push('');
  lines.push('—— 用量明细 ——');
  pattern.colors.forEach((c, i) => {
    lines.push(`${String(i + 1).padStart(2)}. ${c.code} ${c.name}  ${c.count} 颗`);
  });
  lines.push('');
  lines.push('—— 分板施工单 ——');
  const boardSize = pattern.boardCount || 29;
  const regions = splitByBoard(pattern, boardSize);
  for (const r of regions) {
    const usage = boardUsage(pattern, r);
    lines.push(`${r.label}（第 ${r.y + 1}~${r.y + r.h} 行，第 ${r.x + 1}~${r.x + r.w} 列）`);
    lines.push(`  共 ${usage.total} 格，${usage.kinds} 色`);
    usage.list.forEach((u) => lines.push(`    ${u.code} ${u.name}  ${u.count} 颗`));
    lines.push('');
  }
  lines.push('—— 提示 ——');
  lines.push(DISCLAIMER.copyright);
  lines.push(DISCLAIMER.colorDiff);
  return lines.join('\n');
}

/**
 * 单块板的用量统计（文档 P1「分板施工单」）
 */
function boardUsage(pattern, region) {
  const counts = new Map();
  let total = 0;
  // S-04：cells 缺失时按空处理
  const cells = (pattern && typeof pattern.cells === 'object' && pattern.cells) || {};

  for (let y = region.y; y < region.y + region.h; y++) {
    for (let x = region.x; x < region.x + region.w; x++) {
      const code = cells[`${y},${x}`];
      if (!code) continue;
      counts.set(code, (counts.get(code) || 0) + 1);
      total++;
    }
  }

  const meta = {};
  for (const c of pattern.colors || []) meta[c.code] = c;

  const list = [...counts.entries()]
    .map(([code, count]) => ({
      code,
      name: meta[code] ? meta[code].name : code,
      hex: meta[code] ? meta[code].hex : '#ccc',
      count,
    }))
    .sort((a, b) => b.count - a.count);

  return { total, kinds: list.length, list };
}

module.exports = {
  exportPattern,
  buildChecklistText,
  boardUsage,
};