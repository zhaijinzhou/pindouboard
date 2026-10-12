/**
 * pages/index/index.js —— 首页：图片选择 + 预检（文档 M1）
 *
 * 两段式状态机（未增加任何流程步骤）：
 *   空态 →（选图）→ 图片预检 →（下一步）→ 参数配置
 *
 * 【取景框的位置约定】
 *   取景框内嵌在「图片预检」卡片里，**不作为独立环节**。
 *   用户选图后直接进入预检，卡片顶部就是可拖动的取景框，
 *   拖完即生效，点「下一步 · 配置」直接出图 —— 与改造前的步骤数一致。
 *
 * 取景的价值：拼豆图纸的格点阵宽高由取景区域的宽高比决定，
 * 用户经常只想用照片里的某个主体（如人脸、宠物），而不是整张照片。
 * 交互对齐微信头像上传：图片铺满取景台，拖动选框 + 拖角缩放。
 *
 * 【性能取舍】
 *   拖动过程中不重读像素（drawImage + getImageData 对 1400px 图约需数十毫秒，
 *   拖动时每帧都做会明显卡顿）。改为：
 *     拖动中 → 只更新「取景尺寸」与预检指标（纯计算，微秒级）
 *     拖动结束 → 重读像素，刷新 session
 *   这样既保证拖动跟手，最终出图数据又与取景框严格一致。
 */

const image = require('../../utils/image');
const storage = require('../../utils/storage');
const { DEFAULT_PARAMS, PALETTE_VERSION } = require('../../utils/config');
const { checkNoiseRisk, centerCropRatio, cropEquals } = require('../../core/pixelate');
const { calcCroppedSize } = image;

const app = getApp();

/** 拖动结束后延迟多久重读像素 —— 等手指完全离开，避免误触发 */
const RECROP_DELAY = 120;

Page({
  data: {
    hasImage: false,
    /**
     * 当前选中的档位下标（不是 value）。
     *
     * ⚠️ 必须用下标而非 value 判定选中态：多个档位共用同一比例
     *    （1:1 既有单板也有四板，2:1 既有双板也有大板双拼），
     *    若按 value 比较，选中「四板拼接」时「单板」也会高亮。
     */
    cropPreset: 0,
    /** 传给 crop-frame 的锁定比例，由 cropPreset 派生 */
    cropRatio: 1,
    /*
     * 成品规格档位。
     *
     * ⚠️ v0.9 修复「板数链路丢失」：
     *   boardCols 是**横向板数**，必须一路传到 pipeline 的 deriveGrid，
     *   否则格点阵恒为「单板 × 1」，分板线、分板施工单、成品块数全部失效
     *   （原先 pipeline 把 params.boardCount 当 gridSize 传、横向板数写死 1，
     *   导致 checklist 算出的块数恒为 1）。
     *   gridSize（单板格数 16/29/52/75）与 boardCols（板数）正交：
     *   16 格板 × 2 块 = 32×16 格。
     */
    ratioOptions: [
      { value: 1, label: '单板 1:1', hint: '1 块板 · 29×29 格', boardCols: 1, boardRows: 1 },
      { value: 2, label: '双板横排 2:1', hint: '2 块板 · 58×29 格', boardCols: 2, boardRows: 1 },
      { value: 1 / 2, label: '双板竖排 1:2', hint: '2 块板 · 29×58 格', boardCols: 1, boardRows: 2 },
      { value: 1, label: '四板拼接 1:1', hint: '4 块板 · 58×58 格', boardCols: 2, boardRows: 2 },
      { value: 2, label: '大板双拼 2:1', hint: '2 块大板 · 104×52 格', boardCols: 2, boardRows: 1, big: true },
      { value: 0, label: '自由比例', hint: '跟随原图，可自由裁剪', boardCols: 1, boardRows: 1 },
    ],

    imagePath: '',
    originWidth: 0,
    originHeight: 0,
    sourceWidth: 0,
    sourceHeight: 0,
    processWidth: 0,
    processHeight: 0,
    compressed: false,

    risk: { level: '', message: '' },
    riskText: '',
    riskTagClass: 'tag-gray',

    paletteVersion: PALETTE_VERSION,
    paletteCount: 0,

    params: DEFAULT_PARAMS,
    hasHistory: false,
    modeText: '',
  },

  onLoad() {
    this.global = app.globalData;
    this.crop = null;
    this.pickedRaw = null;
    this.cropToken = 0;
    this.setData({
      paletteCount: this.global.paletteCount || 0,
      params: storage.getParams(DEFAULT_PARAMS),
    });
    this.applyModeText(this.data.params);
  },

  onShow() {
    // 从配置页返回时同步最新参数
    const p = storage.getParams(DEFAULT_PARAMS);
    this.setData({ params: p, hasHistory: !!storage.read(storage.STORAGE_KEYS.PARAMS, null) });
    this.applyModeText(p);
  },

  onUnload() {
    if (this.recropTimer) clearTimeout(this.recropTimer);
  },

  applyModeText(params) {
    this.setData({
      modeText: params.mode === 'photo' ? '照片均值' : '卡通主导色',
    });
  },

  /* ============ 选图 ============ */

  async onPickAlbum() {
    await this.pick(['album']);
  },

  async onPickCamera() {
    await this.pick(['camera']);
  },

  async pick(sourceType) {
    try {
      const picked = await image.chooseImage(sourceType);
      const check = image.validateImage(picked.path, picked.size);
      if (!check.valid) {
        wx.showModal({ title: '无法使用这张图片', content: check.reason, showCancel: false });
        return;
      }

      // 取真实像素尺寸：取景框据此把取景台坐标换算回归一化比例
      const info = await image.getImageInfo(picked.path);

      // 换图：作废上一张图遗留的取景变更与在途请求
      if (this.recropTimer) clearTimeout(this.recropTimer);
      this.cropToken++;

      this.pickedRaw = picked;
      this.global.session = null;
      this.global.pipelineResult = null;

      // 组件尚未渲染，先按当前比例档位算出初始取景，让 session 一次建对，
      // 避免「先按整图建 → 组件初始化再纠正」的多余读像素。
      const initial = centerCropRatio(info.width, info.height, this.data.cropRatio);
      this.crop = initial;

      await this.applyCrop(initial, { silent: true });

      this.setData({
        hasImage: true,
        imagePath: info.path || picked.path,
        sourceWidth: info.width,
        sourceHeight: info.height,
      });
    } catch (e) {
      if (e && e.canceled) return;
      wx.showModal({
        title: '读取失败',
        content: (e && e.message) || '请换一张图片试试',
        showCancel: false,
      });
    }
  },

  /* ============ 取景（内嵌于预检环节） ============ */

  /**
   * 切换成品规格档位。
   *
   * ⚠️ 选中态用 `cropPreset`（下标）判定，不用 `cropRatio`（比例）——
   *    多个档位共用同一比例（1:1 既有单板也有四板），按比例判定会同时高亮多档。
   */
  onRatioChange(e) {
    const index = Number(e.currentTarget.dataset.index);
    const opt = this.data.ratioOptions[index];
    if (!opt) return;

    this.setData({ cropPreset: index, cropRatio: opt.value });

    /*
     * ⚠️ v0.9 修复板数链路：把板数写入 params 并持久化。
     *   比例档位与板数是同一个选择的两面 —— 选「双板横排」既是 2:1 的
     *   裁剪比例，也是 2 块板的规格。此前板数只体现在裁剪比例上，
     *   从未传给 pipeline，导致 result 页永远显示「共 1 块板」。
     *   用 setParams 而非只 setData：onShow 会用 storage 里的值覆盖本页 data。
     */
    if (opt.boardCols) {
      const params = {
        ...this.data.params,
        boardCols: opt.boardCols,
        boardRows: opt.boardRows || 1,
      };
      storage.setParams(params);
      this.setData({ params });
    }

    // 比例切换由组件的 ratio observer → applyRatio → change 事件驱动重算，
    // 这里不重复触发。若组件尚未就绪（首帧），兜底自己算一次。
    if (this.data.sourceWidth) {
      const next = centerCropRatio(
        this.data.sourceWidth, this.data.sourceHeight, opt.value
      );
      if (!cropEquals(next, this.crop)) this.scheduleRecrop(next);
    }
  },

  onCropChange(e) {
    const next = e.detail.crop;
    // 裁剪区域没实质变化时不做无谓重算。
    // 典型场景：换图后组件初始化会 emit 一次与 pick 时算出的相同区域。
    if (cropEquals(next, this.crop)) return;

    this.crop = next;
    // 拖动过程中只刷新「取景尺寸 + 预检指标」（纯计算），保证跟手
    this.refreshRiskOnly();
    // 停下后再重读像素，让最终出图数据与取景框一致
    this.scheduleRecrop(next);
  },

  /**
   * 防抖安排一次取景重算。
   * @param {object} [crop] 目标裁剪；缺省用 this.crop。
   *   显式传入的原因：比例切换时 this.crop 可能仍是旧值。
   */
  scheduleRecrop(crop) {
    if (this.recropTimer) clearTimeout(this.recropTimer);
    const target = crop || this.crop;
    this.recropTimer = setTimeout(() => {
      this.recropTimer = null;
      this.applyCrop(target);
    }, RECROP_DELAY);
  },

  /**
   * 按给定取景区域重读像素并刷新 session。
   *
   * ⚠️ 用递增序号做竞态守卫：drawImage + getImageData 是异步的，
   *    用户连续拖动会让多个请求重叠。若不校验序号，先发的慢请求可能
   *    后到并覆盖新结果，导致「框已经拖到 B，session 还是 A」。
   *
   * @param {object|null} crop 归一化取景区域；null 表示整张图
   * @param {object} [opts] { silent } 为 true 时不弹 loading（首次选图已在 loading 中）
   */
  async applyCrop(crop, opts = {}) {
    if (!this.pickedRaw) return;

    const token = ++this.cropToken;

    if (!opts.silent) wx.showLoading({ title: '正在更新取景…', mask: true });

    try {
      const loaded = await image.loadForProcessing(
        this.pickedRaw.path,
        this.pickedRaw.size,
        crop
      );

      // 已有更新的请求在跑，丢弃本次结果
      if (token !== this.cropToken) return;

      if (!opts.silent) wx.hideLoading();

      this.global.session = loaded;

      this.setData({
        originWidth: loaded.origin.width,
        originHeight: loaded.origin.height,
        processWidth: loaded.process.width,
        processHeight: loaded.process.height,
        compressed: loaded.compressed,
      });

      this.refreshRiskOnly(loaded.origin);
    } catch (e) {
      if (token !== this.cropToken) return;
      if (!opts.silent) wx.hideLoading();
      console.error('[index] 取景更新失败：', e);
      wx.showToast({ title: '取景更新失败', icon: 'none' });
    }
  },

  /**
   * 只重算预检指标，不碰像素。
   * 拖动过程中每帧调用，必须足够轻 —— 这里只有算术运算。
   */
  refreshRiskOnly(size) {
    const srcW = this.data.sourceWidth;
    const srcH = this.data.sourceHeight;
    if (!srcW || !srcH) return;

    const origin = size || calcCroppedSize(srcW, srcH, this.crop);
    const gridSize = this.data.params.boardCount || 29;
    const risk = checkNoiseRisk(origin.width, origin.height, gridSize, 1);

    this.setData({
      originWidth: origin.width,
      originHeight: origin.height,
      risk: {
        level: risk.level,
        message: risk.message || '图片质量良好，可正常出图。',
        pixelsPerCell: risk.pixelsPerCell,
      },
      riskText: risk.level === 'danger' ? '风险高'
        : risk.level === 'warn' ? '有提示' : '良好',
      riskTagClass: risk.level === 'danger' ? 'tag-danger'
        : risk.level === 'warn' ? 'tag-warn' : 'tag-success',
    });
  },

  onReset() {
    if (this.recropTimer) clearTimeout(this.recropTimer);
    // 递增 token 作废所有在途请求，避免重选后旧结果回写
    this.cropToken++;
    this.pickedRaw = null;
    this.crop = null;
    this.global.session = null;
    this.global.pipelineResult = null;
    this.setData({
      hasImage: false,
      imagePath: '',
      originWidth: 0,
      originHeight: 0,
      sourceWidth: 0,
      sourceHeight: 0,
      compressed: false,
      risk: { level: '', message: '' },
    });
  },

  /* ============ 导航 ============ */

  async onNext() {
    if (!this.global.session) {
      wx.showToast({ title: '请先选择图片', icon: 'none' });
      return;
    }

    // ⚠️ 必须 await：若拖动刚结束、像素还没重读完就跳转，
    //    配置页会读到与取景框不一致的旧 session，图纸尺寸就错了。
    if (this.recropTimer) {
      clearTimeout(this.recropTimer);
      this.recropTimer = null;
      await this.applyCrop(this.crop, { silent: true });
    }

    // 预检为高风险时二次确认
    if (this.data.risk.level === 'danger') {
      wx.showModal({
        title: '图片分辨率偏低',
        content: this.data.risk.message + '\n\n仍要继续吗？出图效果可能不理想。',
        confirmText: '继续',
        cancelText: '再看看',
        success: (res) => {
          if (res.confirm) wx.navigateTo({ url: '/pages/config/config' });
        },
      });
      return;
    }
    wx.navigateTo({ url: '/pages/config/config' });
  },

  goCabinet() {
    wx.navigateTo({ url: '/pages/cabinet/cabinet' });
  },
});
