/**
 * pages/config/config.js —— 参数配置（文档 M2）
 *
 * 本页是「所见即所得」的中枢：
 *   1. 顶部指标卡 + 缩略预览，随任一参数变更实时刷新
 *   2. 参数写入 storage，供下次进入复用
 *   3. 确认后把参数交给 editor 页跑完整处理链
 *
 * 预览链路走 core/preview.js（降采样 + sampleScale=1），
 * 不复用 editor 的全量处理，避免拖动滑块时卡顿。
 */

const storage = require('../../utils/storage');
const {
  DEFAULT_PARAMS, BEAD_SPECS, BEAD_TYPES,
  MERGE_DEFAULT_DELTA, MERGE_DELTA_RANGE,
  BG_TOLERANCE_RANGE, DISCLAIMER,
} = require('../../utils/config');
const { deriveGrid } = require('../../core/pixelate');
const preview = require('../../core/preview');
const {
  fitCanvasLayout,
  measureStage,
  fallbackAvailWidth,
  getWindowSize,
} = require('../../render/canvas');

const app = getApp();

Page({
  data: {
    params: {},
    boardOptions: [],
    beadSizes: [],
    beadTypes: [],
    preview: {},
    warnAge: false,
    advancedOpen: false,
    useInventory: false,
    inventoryHint: '',
    modeHint: '',

    // 实时预览画布
    canvasW: 300,
    canvasH: 300,
    previewReady: false,
    previewBusy: false,
    previewColors: 0,
    previewFill: 100,
    previewCapped: false,
    previewTip: '',
  },

  onLoad() {
    const saved = storage.getParams(DEFAULT_PARAMS);
    // 补齐新增配置项的默认值
    const params = {
      ...DEFAULT_PARAMS,
      ...saved,
      mergeDelta: saved.mergeDelta != null ? saved.mergeDelta : MERGE_DEFAULT_DELTA,
      bgTolerance: saved.bgTolerance != null ? saved.bgTolerance : BG_TOLERANCE_RANGE.default,
      sampleScale: DEFAULT_PARAMS.sampleScale,
    };

    const session = app.globalData.session;

    this.setData({
      params,
      boardOptions: [
        { value: 16, label: '16 格（小板）' },
        { value: 29, label: '29 格（标准）' },
        { value: 52, label: '52 格（拼豆）' },
        { value: 75, label: '75 格（大板）' },
      ],
      beadSizes: Object.keys(BEAD_SPECS).map((k) => ({ key: k, label: BEAD_SPECS[k].label })),
      beadTypes: Object.keys(BEAD_TYPES).map((k) => ({ key: k, label: BEAD_TYPES[k].label })),
      warnAge: BEAD_SPECS[params.beadSize] ? BEAD_SPECS[params.beadSize].warnAge : false,
      modeHint: DISCLAIMER.privacy,
    });

    this.refreshInventoryHint();
    this.refreshPreview();

    if (!session) {
      wx.showToast({ title: '请先选择图片', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }

    // 画布节点必须在首帧后才拿得到
    setTimeout(() => this.initPreviewCanvas(), 60);
  },

  onUnload() {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    clearTimeout(this.resizeTimer);
  },

  /** 转屏 / iPad 分屏：窗口尺寸变化后重算预览画布 */
  onResize() {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      if (!this.canvasNode) return;
      this.measurePreviewStage().then(() => this.renderPreview());
    }, 200);
  },

  /* ============ 参数变更 ============ */

  saveParams(patch) {
    const params = { ...this.data.params, ...patch };
    this.setData({ params });
    storage.setParams(params);
    this.refreshPreview();
    this.schedulePreview();
    return params;
  },

  onBoardChange(e) {
    this.saveParams({ boardCount: Number(e.currentTarget.dataset.value) });
  },

  onModeChange(e) {
    this.saveParams({ mode: e.currentTarget.dataset.mode });
  },

  onBeadSizeChange(e) {
    const key = e.currentTarget.dataset.value;
    this.saveParams({ beadSize: key });
    this.setData({ warnAge: BEAD_SPECS[key] ? BEAD_SPECS[key].warnAge : false });
  },

  onBeadTypeChange(e) {
    this.saveParams({ beadType: e.currentTarget.dataset.value });
  },

  onColorLimitChanging(e) {
    // 拖动中仅更新显示，避免高频 setData 写 storage 与重算预览
    this.setData({ 'params.colorLimit': e.detail.value });
  },

  onColorLimitChange(e) {
    this.saveParams({ colorLimit: e.detail.value });
  },

  onBgToleranceChange(e) {
    this.saveParams({ bgTolerance: e.detail.value });
  },

  onMergeDeltaChange(e) {
    this.saveParams({ mergeDelta: e.detail.value });
  },

  onSwitch(e) {
    this.saveParams({ [e.currentTarget.dataset.key]: e.detail.value });
  },

  toggleAdvanced() {
    this.setData({ advancedOpen: !this.data.advancedOpen });
  },

  /* ============ 库存约束 ============ */

  onUseInventory(e) {
    this.setData({ useInventory: e.detail.value });
    this.refreshInventoryHint();
    this.schedulePreview();
  },

  refreshInventoryHint() {
    const params = this.data.params;
    const codes = storage.getAvailableCodes(params.brand, params.beadSize);
    if (!codes) {
      this.setData({ inventoryHint: '豆柜为空，开启后将忽略库存限制' });
      this.useInventory = false;
    } else if (codes.length === 0) {
      this.setData({ inventoryHint: '当前规格下没有库存色' });
      this.useInventory = false;
    } else {
      this.setData({ inventoryHint: `豆柜中有 ${codes.length} 色可用，出图将限定在这 ${codes.length} 色内` });
    }
    if (this.data.useInventory && !this.useInventory) {
      this.setData({ useInventory: false });
    }
  },

  /*
   * 格点阵指标：随板数变化，用于预览卡的指标条。
   *
   * 注：成品尺寸/总格数已于 v0.7 移至 editor 页（对着真实图纸看才有意义），
   * 此处不再计算，也不再引入 calcPhysical。
   */
  refreshPreview() {
    const session = app.globalData.session;
    if (!session) return;

    const { width, height } = session.origin;
    // ⚠️ 与 pipeline.run / core.preview 保持同一套板数推导，避免三处各写各的
    const spec = deriveGrid(
      width, height,
      this.data.params.boardCount || 29,
      Math.max(1, this.data.params.boardCols || 1)
    );

    this.setData({
      preview: {
        cols: spec.cols,
        rows: spec.rows,
        boards: spec.usedBoards,
      },
    });
  },

  /* ============ 实时图纸预览 ============ */

  async initPreviewCanvas() {
    const session = app.globalData.session;
    if (!session) return;

    await this.measurePreviewStage();

    wx.createSelectorQuery()
      .select('#previewCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) {
          this.setData({ previewTip: '预览不可用，可直接生成图纸' });
          return;
        }
        this.canvasNode = res[0].node;
        this.setData({ previewReady: true }, () => this.renderPreview());
      });
  },

  /**
   * 实测预览台的可用宽高。
   *
   * ⚠️ 历史代码用 `windowWidth - 40` 估算，与 editor / result 是同一个错误源头，
   *    且高度预算 0.34 过紧，会让高度先于宽度成为约束、缩略图被白白缩小。
   */
  async measurePreviewStage() {
    const win = getWindowSize();
    this.previewMaxH = Math.round(win.windowHeight * preview.PREVIEW.heightRatio);

    // .lp-stage-inner 无 padding，其宽度即纯可用宽；与 canvas 自身尺寸无关，首帧即可测
    const measured = await measureStage('.lp-stage-inner', '.lp-stage');
    this.previewMaxW = measured ? measured.stage.width : fallbackAvailWidth(win);
  },

  /** 防抖：滑块连续拖动时只在停下后算一次 */
  schedulePreview() {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.setData({ previewBusy: true });
    this.previewTimer = setTimeout(() => this.renderPreview(), preview.PREVIEW.debounceMs);
  },

  renderPreview() {
    const session = app.globalData.session;
    if (!session || !this.canvasNode) {
      this.setData({ previewBusy: false });
      return;
    }

    try {
      const source = preview.getPreviewSource(session);
      if (!source) {
        this.setData({ previewBusy: false, previewTip: '缺少图片数据' });
        return;
      }

      const codes = this.data.useInventory
        ? storage.getAvailableCodes(this.data.params.brand, this.data.params.beadSize)
        : null;

      const result = preview.buildPreview(
        source,
        this.data.params,
        codes && codes.length ? codes : null
      );

      // 与 editor / result 共用同一套尺寸推导，避免各写各的再次走偏
      const layout = fitCanvasLayout(
        { cols: result.cols, rows: result.rows },
        { width: this.previewMaxW || 300, height: this.previewMaxH },
        {
          padding: preview.PREVIEW.padding,
          minCellPx: preview.PREVIEW.minCellPx,
          maxCellPx: preview.PREVIEW.maxCellPx,
          hardFloor: preview.PREVIEW.hardFloor,
        }
      );
      const canvas = this.canvasNode;
      canvas.width = layout.width;
      canvas.height = layout.height;
      const ctx = canvas.getContext('2d');

      preview.drawPreview(ctx, result, {
        cellPx: layout.cellPx,
        padding: layout.padding,
        showGrid: this.data.params.gridLine !== false,
      });

      // 把关键指标一并展示：单看色块图，用户难以判断参数是否真的生效。
      // 颜色数 / 留空占比 / 成品尺寸都会随参数变化，是可靠的「变化指示器」。
      const filled = result.codes.reduce((n, c) => n + (c ? 1 : 0), 0);
      const fillRatio = result.cols * result.rows
        ? Math.round((filled / (result.cols * result.rows)) * 100)
        : 0;

      this.setData({
        canvasW: layout.width,
        canvasH: layout.height,
        previewColors: result.colorCount,
        previewFill: fillRatio,
        previewCapped: layout.capped,
        previewBusy: false,
        previewTip: '',
      });
    } catch (e) {
      console.error('[config] 预览渲染失败：', e);
      // 预览失败不阻断主流程：用户仍可点「生成图纸」走完整链路
      this.setData({ previewBusy: false, previewTip: '预览暂不可用，可直接生成图纸' });
    }
  },

  /* ============ 导航 ============ */

  onBack() {
    wx.navigateBack();
  },

  onGenerate() {
    const session = app.globalData.session;
    if (!session) {
      wx.showToast({ title: '请先选择图片', icon: 'none' });
      return;
    }
    const codes = this.data.useInventory
      ? storage.getAvailableCodes(this.data.params.brand, this.data.params.beadSize)
      : null;

    app.globalData.session = {
      ...session,
      params: this.data.params,
      onlyCodes: codes && codes.length ? codes : null,
    };

    wx.showLoading({ title: '正在匹配色号…', mask: true });
    wx.navigateTo({
      url: '/pages/editor/editor',
      success: () => wx.hideLoading(),
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: '打开失败', icon: 'none' });
      },
    });
  },

  goCabinet() {
    wx.navigateTo({ url: '/pages/cabinet/cabinet' });
  },
});
