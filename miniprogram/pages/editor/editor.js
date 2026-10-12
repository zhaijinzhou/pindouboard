/**
 * pages/editor/editor.js —— 图纸预览（文档 M3 编排 + M5 渲染）
 *
 * 本页负责：
 *   1. 调用 core/pipeline.run() 执行完整处理链
 *   2. 渲染预览画布（低分辨率保证流畅）
 *   3. 展示体检报告
 *
 * 注：手动修图功能已于 v0.9 移除。逐格改色会让改动与算法输出不一致，
 *     重算即丢失；色号配错应在配置页调参解决。
 */

const { run } = require('../../core/pipeline');
const { renderBoard, attachIndex } = require('../../render/board');
const {
  fitCanvasLayout,
  measureStage,
  fallbackAvailWidth,
  getCanvasNode,
  getWindowSize,
} = require('../../render/canvas');
const storage = require('../../utils/storage');
const { MATCH, SCREEN_CANVAS } = require('../../utils/config');

const app = getApp();

Page({
  data: {
    loading: true,
    progressSteps: [
      { label: '像素化与色号匹配', done: false },
      { label: '杂色合并与去背景', done: false },
      { label: '孤立块检测与配色体检', done: false },
    ],

    pattern: null,
    colors: [],
    totalCount: 0,
    /** 成品指标（v0.7 由配置页移来）：成品尺寸 / 格点阵 / 总格数 */
    metrics: { width: 0, height: 0, cols: 0, rows: 0, total: 0 },
    report: null,
    healthTitle: '',
    warnCount: 0,
    isolatedGroups: [],

    canvasW: 300,
    canvasH: 300,
    /** 布局对象：放大镜据此换算坐标与倍率 */
    layout: null,

    showCode: true,
  },

  onLoad() {
    this.pattern = null;
    this.generate();
  },

  /* ============ 处理链 ============ */

  async generate() {
    const session = app.globalData.session;
    if (!session || !session.imageData) {
      wx.showToast({ title: '缺少图片数据', icon: 'none' });
      return;
    }

    this.setData({
      loading: true,
      progressSteps: [
        { label: '像素化与色号匹配', done: false },
        { label: '杂色合并与去背景', done: false },
        { label: '孤立块检测与配色体检', done: false },
      ],
    });

    // 让首帧渲染出来，避免 loading 态一闪而过
    await sleep(30);

    try {
      const t0 = Date.now();
      const result = run({
        imageData: session.imageData,
        params: session.params,
        onlyCodes: session.onlyCodes,
      });
      const elapsed = Date.now() - t0;

      // 附加色号索引，供渲染查色
      attachIndex(result.pattern);

      this.pattern = result.pattern;
      this.codes = result.codes.slice();
      this.details = result.details;
      app.globalData.pipelineResult = result;

      const colors = result.pattern.colors.slice();
      const warnCount = result.report.items.filter((i) => i.level !== 'pass').length;

      this.setData({
        loading: false,
        pattern: result.pattern,
        colors,
        totalCount: result.pattern.totalCount,
        metrics: this.buildMetrics(result.pattern),
        report: result.report,
        healthTitle: healthTitle(result.report.level),
        warnCount,
        isolatedGroups: result.isolated.groups.slice(0, 12).map((g, i) => ({ ...g, index: i })),
        progressSteps: [
          { label: '像素化与色号匹配', done: true },
          { label: '杂色合并与去背景', done: true },
          { label: '孤立块检测与配色体检', done: true },
        ],
      });

      console.log(`[editor] 处理完成 ${elapsed}ms`, result.meta.timing);

      await this.renderCanvas();
    } catch (e) {
      console.error('[editor] 处理失败：', e);
      this.setData({ loading: false });
      wx.showModal({
        title: '出图失败',
        content: (e && e.message) || '请调整参数后重试',
        showCancel: false,
      });
    }
  },

  onRegenerate() {
    this.generate();
  },

  /**
   * 成品指标（成品尺寸 / 格点阵 / 总格数）。
   * 数据源取自图纸模型本身，保证与实际图纸一致，不另行推导。
   */
  buildMetrics(pattern) {
    return {
      width: pattern.physicalSize ? pattern.physicalSize.width : 0,
      height: pattern.physicalSize ? pattern.physicalSize.height : 0,
      cols: pattern.cols,
      rows: pattern.rows,
      total: pattern.cols * pattern.rows,
    };
  },

  /* ============ 画布渲染 ============ */

  async renderCanvas() {
    if (!this.pattern) return;

    // 预览分辨率：按容器实测尺寸自适应，保证流畅且不变形
    const win = getWindowSize();

    // .canvas-stage 无 padding，其宽度即纯可用宽；与 canvas 自身尺寸无关，首帧即可测
    const measured = await measureStage('.canvas-stage', '.canvas-wrap');
    const box = {
      width: measured ? measured.stage.width : fallbackAvailWidth(win),
      height: Math.round(win.windowHeight * SCREEN_CANVAS.heightRatio),
    };

    /*
     * cellPx 一次性同时满足宽和高 → 不再需要「先算 layout 再整体缩放」的二段式。
     * 二段式的本质是让 CSS 显示尺寸 ≠ canvas 缓冲尺寸，是变形的另一条独立成因；
     * 且 displayScale 按 finalW/layout.width 推算，在 flex 压缩失效时会命中错格。
     */
    const layout = fitCanvasLayout(this.pattern, box, {
      padding: SCREEN_CANVAS.padding,
      minCellPx: SCREEN_CANVAS.minCellPx,
      maxCellPx: SCREEN_CANVAS.maxCellPx,
      hardFloor: SCREEN_CANVAS.hardFloor,
    });

    // CSS 尺寸 === 缓冲尺寸，displayScale 理论值为 1
    this.setData({
      canvasW: layout.width,
      canvasH: layout.height,
      // 放大镜组件据此换算坐标与倍率
      layout,
    });

    await sleep(20);

    try {
      const { canvas, ctx, rect } = await getCanvasNode('boardCanvas', layout.width, layout.height);

      /*
       * displayScale 改为**实测**而非推算：防御性第二道锁。
       * 万一将来有人给 .board-canvas 加了 max-width 之类导致显示缩放，
       * 点击换算仍指向正确格子（正确性优先于清晰度）。
       */
      const displayScale = rect && rect.width > 0 ? rect.width / layout.width : 1;
      if (Math.abs(displayScale - 1) > 0.02) {
        console.warn(`[editor] canvas 显示缩放 ${displayScale.toFixed(3)} ≠ 1，请检查 WXSS`);
      }

      this.canvasInfo = { canvas, ctx, layout, displayScale };
      this.draw();

      if (layout.capped) {
        console.warn(`[editor] 单格被可用空间压到 ${layout.cellPx}px（低于质量下限 ${SCREEN_CANVAS.minCellPx}）`);
      }
    } catch (e) {
      console.error('[editor] 画布渲染失败：', e);
    }
  },

  /** 转屏 / iPad 分屏：窗口尺寸变化后重算画布尺寸 */
  onResize() {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => this.renderCanvas(), 200);
  },

  onUnload() {
    clearTimeout(this.resizeTimer);
  },

  draw() {
    if (!this.canvasInfo || !this.pattern) return;
    const { ctx, layout } = this.canvasInfo;

    renderBoard(ctx, this.pattern, layout, {
      gridLine: this.data.pattern.render.gridLine,
      codeLabel: this.data.showCode && layout.cellPx >= 12,
      isolated: this.isolatedIndex,
      showDisclaimer: false,
    });
  },

  toggleShowCode() {
    this.setData({ showCode: !this.data.showCode });
    this.draw();
  },


  onJumpIsolated(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const g = this.data.isolatedGroups[idx];
    if (!g) return;
    wx.showToast({
      title: `第 ${g.x + 1} 行 ${g.y + 1} 列有 ${g.isolatedCount} 个孤立格`,
      icon: 'none',
      duration: 2200,
    });
  },

  /* ============ 导航 ============ */

  onNext() {
    if (!this.pattern) return;

    // 同步到全局，供 result 页使用
    const result = app.globalData.pipelineResult;
    result.pattern = this.pattern;
    result.codes = this.codes;
    result.usage = this.pattern.colors;

    storage.savePattern(require('../../utils/codec').encodePattern(this.pattern));

    wx.navigateTo({ url: '/pages/result/result' });
  },

  onShareAppMessage() {
    return { title: '我用拼豆出图做了一个图纸', path: '/pages/index/index' };
  },
});

/* ============ 工具 ============ */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function healthTitle(level) {
  if (level === 'danger') return '配色有明显问题';
  if (level === 'warn') return '配色可以更好';
  return '配色体检通过';
}