/**
 * render/canvas.js —— Canvas 能力封装（文档 P-01 / D-05）
 *
 * 处理两类 Canvas：
 *   1. 页面内 <canvas type="2d">  —— 用于屏幕预览
 *   2. wx.createOffscreenCanvas   —— 用于高清导出
 *
 * 【D-05 导出尺寸上限问题的解法】
 *   小程序 wx.canvasToTempFilePath 对输出尺寸存在机型相关上限（常见 2048~4096），
 *   且超大 Canvas 在中低端机上易触发内存峰值崩溃。
 *   本模块的策略：
 *     - 单次绘制尺寸按 EXPORT.maxCanvasEdge 封顶
 *     - 需要更大输出时走「分板分段导出」：每块板单独出一张图，
 *       用户拼接打印；52 格四板场景即为 4 张图
 *     - 屏幕预览与导出解耦：预览用缩略尺寸保证流畅，导出时才上高分辨率
 */

const { EXPORT, SCREEN_CANVAS } = require('../utils/config');

/**
 * 获取页面内 Canvas 节点
 *
 * @param {string} id canvas 组件 id
 * @param {number} width  CSS 像素宽
 * @param {number} height CSS 像素高
 * @returns {Promise<{canvas, ctx, dpr, rect}>}
 */
function getCanvasNode(id, width, height) {
  return new Promise((resolve, reject) => {
    wx.createSelectorQuery()
      .select(`#${id}`)
      .fields({ node: true, size: true, rect: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) {
          reject(new Error(`未找到 canvas 节点：#${id}`));
          return;
        }
        const canvas = res[0].node;
        const dpr = (wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : wx.getSystemInfoSync().pixelRatio) || 2;

        /*
         * ⚠️ 后备缓冲与 CSS 尺寸严格 1:1，**不乘 dpr**。
         *
         *   乘 dpr 必须在绘制前调用 ctx.scale(dpr, dpr)，否则内容只占左上角 1/dpr；
         *   而 layout.width / padding / cellPx 以及 editor 的点击坐标换算
         *   全是 CSS 像素单位，混用必然出第二类错位。
         *   1:1 是「不可能变形」的唯一简单保证。
         *   （3x 屏上会略糊，属独立优化项，不在本次修复范围。）
         */
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        resolve({
          canvas,
          ctx,
          dpr,
          rect: {
            left: res[0].left,
            top: res[0].top,
            width: res[0].width,
            height: res[0].height,
          },
        });
      });
  });
}

/**
 * 创建离屏 Canvas（导出用）
 *
 * @returns {{canvas, ctx, width, height, offscreen:boolean}}
 */
function createOffscreen(width, height) {
  const w = Math.min(width, EXPORT.maxCanvasEdge);
  const h = Math.min(height, EXPORT.maxCanvasEdge);

  if (typeof wx.createOffscreenCanvas === 'function') {
    try {
      const canvas = wx.createOffscreenCanvas({ type: '2d', width: w, height: h });
      const ctx = canvas.getContext('2d');
      return { canvas, ctx, width: w, height: h, offscreen: true };
    } catch (e) {
      console.warn('[canvas] OffscreenCanvas 不可用，回退到 page canvas：', e);
    }
  }
  return { canvas: null, ctx: null, width: w, height: h, offscreen: false };
}

/**
 * 计算渲染参数：给定格点阵与单格像素尺寸，返回画布尺寸与字号。
 *
 * @param {object} pattern 图纸
 * @param {object} options {
 *     cellPx:     单格边长（px）
 *     padding:    外边距（px）
 *     scale:      整体缩放
 *     targetEdge: 目标最短边（导出时用）
 *     minCellPx:  单格下限（px），默认 6。屏幕预览需允许低于 6，见下方注释
 *   }
 * @returns {{ cellPx, width, height, padding, fontPx, codeFontPx, lineWidth }}
 */
function calcLayout(pattern, options = {}) {
  const cols = pattern.cols;
  const rows = pattern.rows;
  const padding = options.padding != null ? options.padding : 20;

  let cellPx = options.cellPx;
  if (!cellPx && options.targetEdge) {
    // 导出：按目标边长反推单格尺寸
    const longest = Math.max(cols, rows);
    cellPx = Math.max(EXPORT.minCellPx, Math.floor(options.targetEdge / longest));
  }
  const scale = options.scale || 1;

  /*
   * ⚠️ 必须先取整、再算画布尺寸，顺序不能反（2026-10-13 修复拉伸 bug）。
   *
   *   原来：width/height 用**未取整**的 cellPx 计算，返回的却是**取整后**的 cellPx。
   *   绘制时按取整值逐格 fillRect，画布却按未取整值开 —— 两者不一致，
   *   于是右侧/底部多出或缺少一截，表现为**图纸被拉伸变形**。
   *   格数越多累计误差越大（52 格时可达数十像素）。
   *
   *   正确顺序：cellPx 取整 → 用同一个值算 width/height → 返回同一个值。
   */
  /*
   * ⚠️ 单格下限：默认 6px（历史行为，一字未改）。
   *
   *   屏幕预览需要允许**低于 6px**：375px 屏上容器实测可用宽只有约 303px，
   *   52 格时 floor((303 - 32 - 2) / 52) = 5。若下限写死 6，本函数会把 5 抬回 6，
   *   画布变成 52*6+32 = 344px > 303px —— 溢出后又被 flex 压缩，
   *   「图纸被压扁」的 bug 换个形式复活。
   *
   *   本参数只放宽「下限」，上方 96-105 行的取整顺序契约完全不变；
   *   导出链路（exporter.js）不传该参数，行为与历史逐字节一致。
   */
  const minCell = options.minCellPx != null ? options.minCellPx : 6;
  cellPx = Math.max(minCell, cellPx || 16);
  if (scale !== 1) cellPx = Math.round(cellPx * scale);

  // padding 同样要跟随 scale，否则等比缩放时内边距比例失真
  const pad = Math.round(padding * scale);

  // ⚠️ 同样用取整后的 cellPx 计算，保证与绘制逐格严格对齐
  const width = Math.round(cols * cellPx + pad * 2);
  const height = Math.round(rows * cellPx + pad * 2);

  return {
    cellPx,
    width,
    height,
    padding: pad,
    // 色号文字：格内居中，字号取单格的 34%，保证不溢出且清晰
    codeFontPx: Math.max(6, Math.round(cellPx * 0.34)),
    // 网格线宽：随单格尺寸缩放，但不低于 0.5px 避免消失
    lineWidth: Math.max(0.5, cellPx * 0.045),
    // 分板粗线
    boardLineWidth: Math.max(1.5, cellPx * 0.18),
    // 标题字号
    titleFontPx: Math.max(12, Math.round(cellPx * 0.5)),
  };
}

/**
 * 把 Canvas 导出为临时文件路径。
 *
 * @returns {Promise<string>} 临时文件路径
 */
function toTempFile(canvas, width, height, options = {}) {
  return new Promise((resolve, reject) => {
    const doExport = () => {
      wx.canvasToTempFilePath({
        canvas,
        width,
        height,
        destWidth: width,
        destHeight: height,
        fileType: 'png',
        quality: 1,
        success: (res) => resolve(res.tempFilePath),
        fail: (err) => reject(new Error(`导出失败：${err.errMsg || '未知错误'}`)),
      }, options);
    };

    // OffscreenCanvas 需显式传入节点
    if (canvas && canvas.node) doExport();
    else doExport();
  });
}

/**
 * 按板切分区域（文档 P-06「大图分板渲染」）
 *
 * @returns {Array<{bx, by, x, y, w, h, label}>}
 */
function splitByBoard(pattern, boardSize) {
  const regions = [];
  const totalCols = pattern.cols;
  const totalRows = pattern.rows;
  const boardsX = Math.ceil(totalCols / boardSize);
  const boardsY = Math.ceil(totalRows / boardSize);

  for (let by = 0; by < boardsY; by++) {
    for (let bx = 0; bx < boardsX; bx++) {
      const x0 = bx * boardSize;
      const y0 = by * boardSize;
      const w = Math.min(boardSize, totalCols - x0);
      const h = Math.min(boardSize, totalRows - y0);
      if (w <= 0 || h <= 0) continue;
      regions.push({
        bx, by, x: x0, y: y0, w, h,
        label: `第 ${by * boardsX + bx + 1} 块`,
      });
    }
  }
  return regions;
}

/**
 * 判断图纸是否需要分板导出（超出单次 Canvas 上限）
 */
function needSplit(pattern, cellPx) {
  const longest = Math.max(pattern.cols, pattern.rows) * cellPx;
  return longest > EXPORT.maxCanvasEdge;
}

/**
 * rpx → px：1rpx = windowWidth / 750 px
 */
function rpxToPx(rpx, windowWidth) {
  return (rpx * windowWidth) / 750;
}

/**
 * 取窗口尺寸（兼容新旧基础库）
 */
function getWindowSize() {
  return wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
}

/**
 * 实测画布容器的可用尺寸。
 *
 * ⚠️ 必须测「无 padding 的内层容器」（.canvas-stage / .lp-stage-inner）：
 *    boundingClientRect 返回 border-box，直接测带 20rpx padding 的 .canvas-wrap
 *    会把内边距算进可用宽度 → 画布仍超宽。这与历史代码用
 *    `windowWidth - 40` 估算不准是同一类错误。
 *
 * ⚠️ 内层容器宽度是 `width: 100%`，相对父容器内容盒解析，**与 canvas 自身尺寸无关**
 *    → 即使 canvas 还没拿到尺寸也能测到稳定值，从结构上消灭了
 *    「必须先让 canvas 有尺寸才能测量」的时序陷阱。
 *    拿不到只可能是整页尚未布局，重试即可。
 *
 * @param {string} stageSelector 无 padding 内层容器选择器
 * @param {string} [wrapSelector] 外层容器（同时返回，便于排查）
 * @param {object} [options] { scope, retry, gap }
 * @returns {Promise<{stage: object, wrap: object|null}|null>} 失败返回 null
 */
function measureStage(stageSelector, wrapSelector, options = {}) {
  const retry = options.retry != null ? options.retry : 3;
  const gap = options.gap != null ? options.gap : 60;
  const scope = options.scope;

  return new Promise((resolve) => {
    let tries = 0;

    const run = () => {
      const q = wx.createSelectorQuery();
      // ⚠️ .in(null) 会抛错，必须条件调用
      if (scope) q.in(scope);
      q.select(stageSelector).boundingClientRect();
      if (wrapSelector) q.select(wrapSelector).boundingClientRect();

      q.exec((res) => {
        const stage = res && res[0];
        const wrap = (res && res[1]) || null;

        if (!stage || !stage.width) {
          if (++tries > retry) {
            resolve(null);
            return;
          }
          setTimeout(run, gap);
          return;
        }
        resolve({ stage, wrap });
      });
    };

    run();
  });
}

/**
 * 实测失败时的兜底估算。
 *
 * ⚠️ 失败方向必须「宁可估大」：
 *    估大 → 画布略超容器 → flex-shrink:0 生效 → 出现**可滚动条**（用户看得见，可反馈）
 *    估小 → 画布超宽 → 被压缩 → **静默拉伸变形**（用户看不见，无从反馈）
 *
 * @param {object} win getWindowSize() 的返回值
 * @returns {number} 可用宽度（px）
 */
function fallbackAvailWidth(win) {
  const inset = rpxToPx(SCREEN_CANVAS.fallbackInsetRpx, win.windowWidth);
  return Math.max(120, win.windowWidth - inset);
}

/**
 * 按可用空间计算「宽高都完整可见」的屏幕预览画布尺寸。
 *
 * 核心不变式（与 calcLayout 同一套，保证不可能拉伸）：
 *   返回的 width/height 一定由**同一个** cellPx 与 padding 算出，
 *   逐格 fillRect 与 canvas 后备缓冲严格对齐。
 *
 * 决策链：
 *   byW    = 可用宽约束的单格上限（floor，避免小数格）
 *   byH    = 可用高约束的上限（box.height <= 0 表示不限高 → Infinity）
 *   limit  = min(byW, byH, maxCellPx)                 ← 空间与上限
 *   floor  = max(hardFloor, min(minCellPx, limit))     ← 质量下限，但**不超过空间**
 *   cellPx = max(floor, limit)
 *
 * ⚠️ floor 之所以要 min(minCellPx, limit)，是为了让「单格下限」永远不会
 *    把画布撑出容器 —— 那正是本次修复的 bug 形态。
 *    「下限被空间挤破」通过 capped 字段如实上报，不靠溢出掩盖。
 *
 * @param {{cols:number, rows:number}} pattern
 * @param {{width:number, height?:number}} box 容器**内容盒**尺寸（px）
 * @param {object} [opt]
 * @param {number} [opt.padding=16]   画布内边距（px）
 * @param {number} [opt.minCellPx=6]  质量下限（软）
 * @param {number} [opt.maxCellPx=28] 单格上限
 * @param {number} [opt.hardFloor=2]  绝对下限（防 0 / 负）
 * @returns {object} calcLayout 的返回值 + { capped:boolean }
 */
function fitCanvasLayout(pattern, box, opt = {}) {
  const cols = Math.max(1, pattern.cols | 0);
  const rows = Math.max(1, pattern.rows | 0);
  const padding = opt.padding != null ? opt.padding : SCREEN_CANVAS.padding;
  const softFloor = opt.minCellPx != null ? opt.minCellPx : SCREEN_CANVAS.minCellPx;
  const maxCell = opt.maxCellPx != null ? opt.maxCellPx : SCREEN_CANVAS.maxCellPx;
  const hardFloor = opt.hardFloor != null ? opt.hardFloor : SCREEN_CANVAS.hardFloor;

  // 抵消 Math.round 的亚像素进位：差 1px 就会冒出滚动条
  const SAFETY = 2;

  const longest = Math.max(cols, rows);
  const byW = Math.floor(Math.max(1, box.width - padding * 2 - SAFETY) / longest);
  const byH = box.height > 0
    ? Math.floor(Math.max(1, box.height - padding * 2 - SAFETY) / longest)
    : Infinity;

  const limit = Math.min(byW, byH, maxCell);
  const floor = Math.max(hardFloor, Math.min(softFloor, limit));
  const cellPx = Math.max(floor, limit);

  return Object.assign(calcLayout({ cols, rows }, {
    cellPx,
    padding,
    minCellPx: floor,
  }), {
    capped: cellPx < softFloor,
  });
}

module.exports = {
  getCanvasNode,
  createOffscreen,
  calcLayout,
  fitCanvasLayout,
  measureStage,
  fallbackAvailWidth,
  rpxToPx,
  getWindowSize,
  toTempFile,
  splitByBoard,
  needSplit,
};