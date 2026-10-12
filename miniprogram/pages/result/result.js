/**
 * pages/result/result.js —— 图纸 + 清单（文档 M6）
 */

const { exportPattern, buildChecklistText } = require('../../render/exporter');
const { buildChecklist } = require('../../render/checklist');
const { renderBoard, attachIndex } = require('../../render/board');
const {
  fitCanvasLayout,
  measureStage,
  fallbackAvailWidth,
  getCanvasNode,
  getWindowSize,
} = require('../../render/canvas');
const { SCREEN_CANVAS } = require('../../utils/config');
const storage = require('../../utils/storage');
const image = require('../../utils/image');

const app = getApp();

Page({
  data: {
    pattern: null,
    checklist: { groups: [], sheets: [], disclaimers: {} },
    canvasW: 300,
    canvasH: 300,
    /** 布局对象：放大镜据此换算坐标与倍率 */
    layout: null,
    showCode: true,
    exportNote: '',
  },

  onLoad() {
    const result = app.globalData.pipelineResult;
    if (!result || !result.pattern) {
      wx.showToast({ title: '缺少图纸数据', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }

    this.pattern = result.pattern;
    attachIndex(this.pattern);

    const checklist = buildChecklist(this.pattern, storage.getInventory());

    this.setData({
      pattern: this.pattern,
      checklist,
      showCode: this.pattern.render ? this.pattern.render.codeLabel : true,
    });

    this.renderCanvas();
  },

  async renderCanvas() {
    if (!this.pattern) return;

    const win = getWindowSize();

    /*
     * ① 实测容器内容盒宽度（.canvas-stage 无 padding，测到的就是纯可用宽）。
     *    历史代码用 `windowWidth - 40` 估算，比真实值偏大约 32px，
     *    导致画布溢出 → 被 flex 压缩 → 图纸横向压扁。本项目不再有该估算。
     */
    const measured = await measureStage('.canvas-stage', '.canvas-wrap');
    const box = {
      width: measured ? measured.stage.width : fallbackAvailWidth(win),
      // ② 补上本页此前完全缺失的高度约束，长图不再纵向溢出屏幕
      height: Math.round(win.windowHeight * SCREEN_CANVAS.heightRatio),
    };

    // ③ 一次算出「宽高都完整可见」的 cellPx 与画布尺寸
    const layout = fitCanvasLayout(this.pattern, box, {
      padding: SCREEN_CANVAS.padding,
      minCellPx: SCREEN_CANVAS.minCellPx,
      maxCellPx: SCREEN_CANVAS.maxCellPx,
      hardFloor: SCREEN_CANVAS.hardFloor,
    });

    // ④ CSS 尺寸 === canvas 后备缓冲尺寸，1:1，不可能变形
    this.setData({
      canvasW: layout.width,
      canvasH: layout.height,
      // 放大镜组件据此换算坐标与倍率（cellPx / padding 缺一不可）
      layout,
    });

    await sleep(20);

    try {
      const { canvas, ctx } = await getCanvasNode('resultCanvas', layout.width, layout.height);
      this.canvasInfo = { canvas, ctx, layout };
      this.draw();

      if (layout.capped) {
        console.warn(`[result] 单格被可用空间压到 ${layout.cellPx}px（低于质量下限 ${SCREEN_CANVAS.minCellPx}）`);
      }
    } catch (e) {
      console.error('[result] 画布渲染失败：', e);
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
    if (!this.canvasInfo) return;
    renderBoard(this.canvasInfo.ctx, this.pattern, this.canvasInfo.layout, {
      gridLine: this.pattern.render.gridLine,
      codeLabel: this.data.showCode && this.canvasInfo.layout.cellPx >= 12,
      showDisclaimer: false,
    });
  },

  toggleShowCode() {
    this.setData({ showCode: !this.data.showCode });
    this.draw();
  },

  /* ============ 导出 ============ */

  async onExport() {
    wx.showLoading({ title: '正在导出…', mask: true });

    try {
      const result = await exportPattern(this.pattern, {
        canvasId: 'exportCanvas',
        showCode: this.data.showCode,
        showGrid: this.pattern.render.gridLine,
        isolated: this.isolatedIndex,
      });

      wx.hideLoading();

      if (!result.files.length) {
        this.setData({ exportNote: result.note || '导出失败' });
        wx.showToast({ title: '导出失败', icon: 'none' });
        return;
      }

      this.setData({ exportNote: result.note });

      // 多文件时逐张保存
      for (const f of result.files) {
        try {
          await image.saveToAlbum(f);
        } catch (e) {
          if (e && e.needAuth) {
            wx.openSetting({
              success: () => {
                wx.showToast({ title: '已保存到相册', icon: 'success' });
              },
            });
            return;
          }
          if (e && e.canceled) continue;
          throw e;
        }
      }

      wx.showToast({
        title: result.split ? `已保存${result.files.length}张` : '已保存到相册',
        icon: 'success',
      });
    } catch (e) {
      wx.hideLoading();
      console.error('[result] 导出异常：', e);
      wx.showModal({
        title: '导出失败',
        content: (e && e.message) || '请重试',
        showCancel: false,
      });
    }
  },

  /* ============ 清单复制 ============ */

  copyChecklist() {
    const text = buildChecklistText(this.pattern);
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '清单已复制', icon: 'success' }),
      fail: () => wx.showToast({ title: '复制失败', icon: 'none' }),
    });
  },

  onShareAppMessage() {
    return {
      title: `我用拼豆出图做了一个 ${this.pattern ? this.pattern.cols + '×' + this.pattern.rows : ''} 的图纸`,
      path: '/pages/index/index',
      imageUrl: '/assets/share.png',
    };
  },

  goHome() {
    app.globalData.session = null;
    app.globalData.pipelineResult = null;
    wx.reLaunch({ url: '/pages/index/index' });
  },
});

/* ============ 工具 ============ */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}