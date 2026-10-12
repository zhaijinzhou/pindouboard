/**
 * components/magnifier —— 图纸放大镜（长按跟手）
 *
 * 【为什么需要】
 *   屏幕上的图纸是缩略图：52 格时单格仅 5~6px，色号文字与网格线都看不清，
 *   而用户往往要在施工前核对某一格到底取了哪个色号。
 *
 * 【v0.9 重写：从「实时逐格重绘」改为「预渲染底图 + drawImage 取局部】
 *
 *   旧方案（v0.9 初版）失败：每次 touchmove 都逐格 fillRect + fillText 重画，
 *   52 格时单格只有 5~6px，文字挤在几个像素里被压缩交错，
 *   表现为**乱码**；且每帧 O(cols×rows) 重绘，长按滑动明显卡顿。
 *
 *   新方案分两步：
 *     1. 首次需要时把整幅图纸按 zoom×dpr 渲染到**离屏画布**并缓存
 *        （渲染一次，之后复用）；
 *     2. 放大时只用 drawImage 从底图裁出对应区域放大显示 ——
 *        纯位图搬运，与格数无关，60fps 无压力，且文字是预先渲染好的，
 *        放大后依然锐利。
 *
 * 【交互：长按跟手】
 *   长按 300ms 进入放大态，手指移动即平移，松开立即退出。
 *   「按住哪、看哪」，符合放大镜直觉，且不遮挡页面、无需额外关闭路径。
 *
 * 【关键约束】
 *   放大态下触摸层必须扩展到全屏并用 catchtouchmove ——
 *   否则手指滑出画布就收不到 touchmove，页面会跟着滚，
 *   手指一动图纸就跑掉，这是长按放大最容易踩的坑。
 */

/** 进入放大态所需的长按时长（ms） */
const HOLD_MS = 300;
/** 默认放大倍率 */
const DEFAULT_ZOOM = 3;
/** 视窗最大边长 = 视口宽度 × 本系数 */
const WIN_RATIO = 0.86;
/** 手指移动超过该距离（px）即取消长按判定 */
const MOVE_TOLERANCE = 8;
/**
 * 底图像素上限。
 *
 * ⚠️ 离屏画布过大在低端机上会触发内存峰值甚至崩溃。
 *    104×104 格在 zoom=3、scale=9 时约 62MB，足以让中低端机 OOM，
 *    故同时用「最长边封顶」与「总像素封顶」双重约束。
 */
const BITMAP_MAX_EDGE = 4096;
/** 总像素上限（约 16M px ≈ 64MB RGBA） */
const BITMAP_MAX_PIXELS = 16 * 1024 * 1024;

Component({
  options: {
    addGlobalClass: true,
  },

  properties: {
    /** 图纸模型 */
    pattern: { type: Object, value: null },
    /** calcLayout 返回值（含 cellPx / padding / width / height） */
    layout: { type: Object, value: null },
    /** 是否显示色号 */
    showCode: { type: Boolean, value: true },
    /** 网格线 */
    gridLine: { type: Boolean, value: true },
    /** 放大倍率 */
    zoom: { type: Number, value: DEFAULT_ZOOM },
  },

  data: {
    zooming: false,
    /** 触摸层尺寸（与画布一致） */
    sourceW: 0,
    sourceH: 0,
    /** 放大视窗的 CSS 尺寸（正方形） */
    winW: 0,
    winH: 0,
    /** 视窗左上角在图纸坐标系（px）中的偏移 */
    offX: 0,
    offY: 0,
    /** 当前聚焦的格坐标 + 色号，用于底部提示 */
    focusCell: '',
  },

  observers: {
    // 画布尺寸随屏幕与图格数变化，触摸层必须同步，否则手势区域错位
    'pattern, layout': function () {
      const layout = this.data.layout;
      if (!layout) return;
      // 图纸或布局变化 → 底图失效，下次放大时重新渲染
      this._bitmap = null;
      this.setData({ sourceW: layout.width, sourceH: layout.height });
    },
    'showCode, gridLine': function () {
      // 底图把色号/网格线烤进去了，这两项一变就得重渲染
      this._bitmap = null;
    },
  },

  lifetimes: {
    attached() {
      this._holdTimer = null;
      this._touchId = null;
      this._offX = 0;
      this._offY = 0;
      this._bitmap = null;
      this._rendering = false;
      this._renderPending = false;
    },
    detached() {
      if (this._holdTimer) clearTimeout(this._holdTimer);
      // 及时释放底图，避免页面销毁后仍占用大块内存
      this._bitmap = null;
      this._renderPending = false;
    },
  },

  methods: {
    /* ============ 长按手势 ============ */

    onTouchStart(e) {
      const t = e.touches && e.touches[0];
      if (!t || !this.data.pattern || !this.data.layout) return;
      if (this.data.zooming) return;

      this._touchId = t.identifier;
      this._startX = t.clientX;
      this._startY = t.clientY;

      // 超过 300ms 仍未移动 → 判定为长按意图，进入放大态
      this._holdTimer = setTimeout(() => {
        this._holdTimer = null;
        this.openZoom(t.clientX, t.clientY);
      }, HOLD_MS);
    },

    onTouchMove(e) {
      const t = this._findTouch(e);
      if (!t) return;

      if (this._holdTimer) {
        // 长按判定期间发生位移 → 视为页面滚动，取消长按（不与滚动抢手势）
        const moved = Math.abs(t.clientX - this._startX) > MOVE_TOLERANCE
          || Math.abs(t.clientY - this._startY) > MOVE_TOLERANCE;
        if (moved) {
          clearTimeout(this._holdTimer);
          this._holdTimer = null;
        }
        return;
      }

      if (!this.data.zooming) return;
      this.panTo(t.clientX, t.clientY);
    },

    onTouchEnd() {
      if (this._holdTimer) {
        clearTimeout(this._holdTimer);
        this._holdTimer = null;
      }
      this.closeZoom();
    },

    onTouchCancel() {
      this.onTouchEnd();
    },

    _findTouch(e) {
      const list = (e.touches && e.touches.length)
        ? e.touches
        : (e.changedTouches || []);
      for (const t of list) {
        if (t.identifier === this._touchId) return t;
      }
      return list[0] || null;
    },

    /* ============ 放大态 ============ */

    /**
     * 进入放大态：以手指位置为视窗中心
     */
    async openZoom(clientX, clientY) {
      const rect = await this._queryRect();
      if (!rect || !rect.width) return;

      /*
       * 视窗尺寸 = 视口上限与「图纸 × 1.2」的较小值。
       * 大图纸时视窗小于图纸是正常的 —— 放大靠的是单格像素，
       * 视窗只显示局部格子才对。
       */
      const cap = this._winMax();
      const fit = Math.max(this.data.sourceW, this.data.sourceH);
      const winSize = Math.round(Math.max(160, Math.min(cap, Math.max(fit * 1.2, 220))));

      /*
       * ⚠️ 必须等 zooming 渲染完成再取 canvas 节点：
       *    #mgCanvas 位于 wx:if="{{zooming}}" 内，setData 尚未落地时节点不存在。
       */
      await new Promise((resolve) => {
        this.setData({ zooming: true, winW: winSize, winH: winSize }, resolve);
      });

      await this._ensureCanvas(winSize);
      this._centerOn(clientX, clientY);
    },

    closeZoom() {
      if (!this.data.zooming) return;
      // 停止未完成的渲染循环，避免退出后仍在画布上作画
      this._renderPending = false;
      this.setData({ zooming: false, focusCell: '' });
    },

    /**
     * 以手指位置为中心平移视窗。
     *
     * ⚠️ 放大态下原画布被遮罩盖住、测不到 rect，
     *    所以用「屏幕坐标 → 视窗内比例 → 图纸坐标」的路径，
     *    完全绕开对原画布 rect 的依赖，也不受页面滚动影响。
     */
    panTo(clientX, clientY) {
      const layout = this.data.layout;
      if (!layout) return;
      const zoom = this.data.zoom || 1;

      // 遮罩里的视窗居中于屏幕，用「手指相对屏幕中心」驱动平移，
      // 直观且与视窗实际像素尺寸解耦。
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      const dx = clientX - info.windowWidth / 2;
      const dy = clientY - info.windowHeight / 2;

      // 屏幕 1px 对应图纸 1/zoom px
      const fx = this._offX + this.data.winW / (2 * zoom) + dx / zoom;
      const fy = this._offY + this.data.winH / (2 * zoom) + dy / zoom;
      this._centerOnByPoint(fx, fy);
    },

    /** 把图纸坐标 (fx, fy) 移到视窗中心 */
    /**
     * 把图纸坐标 (fx, fy) 移到视窗中心。
     *
     * ⚠️ 关键：视窗是「CSS 像素尺寸」，但它显示的**图纸范围**只有
     *    winW / zoom 这么宽（322px 的窗口在 3 倍下只看得到 107px 的图纸）。
     *    所以偏移必须按「图纸范围」来算，而不是按 winW ——
     *    否则图纸比视窗略大时（344 vs 322，可移动范围仅 22px），
     *    钳位会让视窗中心与手指位置严重错位。
     */
    _centerOnByPoint(fx, fy) {
      const layout = this.data.layout;
      if (!layout) return;
      const zoom = this.data.zoom || 1;

      // 视窗在图纸坐标系下覆盖的实际范围
      const spanW = this.data.winW / zoom;
      const spanH = this.data.winH / zoom;
      const maxX = Math.max(0, layout.width - spanW);
      const maxY = Math.max(0, layout.height - spanH);

      const offX = clamp(fx - spanW / 2, 0, maxX);
      const offY = clamp(fy - spanH / 2, 0, maxY);

      this._offX = offX;
      this._offY = offY;
      this.setData({ offX, offY, focusCell: this._describeCell(fx, fy) });
      this._scheduleRender();
    },

    /**
     * 合并渲染请求。
     *
     * ⚠️ 关键：滑动时 touchmove 每秒可达 60 次，而 _render 是异步的
     *    （首帧要 await _ensureBitmap 建底图）。若不加合并，
     *    排队的旧请求会读到**已被更新**的 _offX/_offY 之外的中间态，
     *    表现为画面滞后、闪烁 —— 即「卡顿」。
     *    这里只保证「同一时刻最多一次渲染在飞」，后来的请求覆盖先前的，
     *    保证最终画面与手指位置一致。
     */
    _scheduleRender() {
      this._renderPending = true;
      if (this._rendering) return;
      this._doRenderLoop();
    },

    async _doRenderLoop() {
      if (this._rendering) return;
      this._rendering = true;
      try {
        while (this._renderPending) {
          this._renderPending = false;
          // eslint-disable-next-line no-await-in-loop
          await this._render();
        }
      } catch (e) {
        console.warn('[magnifier] 渲染失败：', e);
      } finally {
        this._rendering = false;
      }
    },

    /** 屏幕坐标 → 图纸内部坐标（未经缩放），再居中 */
    _centerOn(clientX, clientY) {
      const layout = this.data.layout;
      const rect = this._rect;
      if (!layout || !rect) return;

      const fx = (clientX - rect.left) * (layout.width / rect.width);
      const fy = (clientY - rect.top) * (layout.height / rect.height);
      this._centerOnByPoint(fx, fy);
    },

    /** 描述当前聚焦的格，如 "第 12 行 8 列 · H21" */
    _describeCell(fx, fy) {
      const { pattern, layout } = this.data;
      if (!pattern || !layout) return '';
      const gx = Math.floor((fx - layout.padding) / layout.cellPx);
      const gy = Math.floor((fy - layout.padding) / layout.cellPx);
      if (gx < 0 || gy < 0 || gx >= pattern.cols || gy >= pattern.rows) return '';
      const cell = pattern.cells[`${gy},${gx}`];
      return `第 ${gy + 1} 行 ${gx + 1} 列${cell ? ' · ' + cell : ' · 留空'}`;
    },

    _winMax() {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      return info.windowWidth * WIN_RATIO;
    },

    /* ============ 画布 ============ */

    _queryRect() {
      return new Promise((resolve) => {
        wx.createSelectorQuery()
          .in(this)
          .select('.mg-source')
          .boundingClientRect((rect) => {
            this._rect = rect || null;
            resolve(rect);
          })
          .exec();
      });
    },

    async _ensureCanvas(size) {
      const dpr = (wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : 2) || 2;
      const node = await new Promise((resolve) => {
        wx.createSelectorQuery()
          .in(this)
          .select('#mgCanvas')
          .fields({ node: true, size: true })
          .exec((res) => {
            resolve(res && res[0] && res[0].node ? res[0].node : null);
          });
      });
      if (!node) return;

      node.width = Math.round(size * dpr);
      node.height = Math.round(size * dpr);
      this._node = node;
      this._ctx = node.getContext('2d');
      this._dpr = dpr;
    },

    /**
     * 构建（或复用）整幅图纸的高清底图。
     *
     * 分辨率 = 屏幕 cellPx × zoom × dpr：
     *   乘 zoom 是为了放大后格子仍然是「更大」的实心像素，
     *   乘 dpr 是为了高密度屏上不糊。
     * 最长边按 BITMAP_MAX_EDGE 封顶，防止 4 块板 + 3 倍放大时爆内存。
     *
     * @returns {Promise<{canvas, scale}>} scale = 底图像素 / 图纸 CSS px
     */
    async _ensureBitmap() {
      if (this._bitmap) return this._bitmap;

      const { pattern, layout, zoom } = this.data;
      const dpr = this._dpr;
      if (!pattern || !layout || !dpr) return null;

      const longest = Math.max(pattern.cols, pattern.rows);
      let scale = zoom * dpr;

      /*
       * 双重封顶：最长边 + 总像素。
       * 只封最长边不够 —— 正方形图纸即使边长合规，像素总量也可能超标。
       * 超限时按比例缩小 scale，保证在任一维度都画得下。
       */
      const unitW = longest * layout.cellPx + layout.padding * 2;
      const estEdge = unitW * scale;
      if (estEdge > BITMAP_MAX_EDGE) {
        scale = BITMAP_MAX_EDGE / unitW;
      }
      // 此时底图为 unitW×unitW 量级的正方形，再校验总像素
      if (unitW * unitW * scale * scale > BITMAP_MAX_PIXELS) {
        scale = Math.sqrt(BITMAP_MAX_PIXELS) / unitW;
      }

      const bw = Math.max(1, Math.round((pattern.cols * layout.cellPx + layout.padding * 2) * scale));
      const bh = Math.max(1, Math.round((pattern.rows * layout.cellPx + layout.padding * 2) * scale));

      // 底图只在放大态存在，此时 hidden canvas 已在树中
      const bmpCanvas = await new Promise((resolve) => {
        wx.createSelectorQuery()
          .in(this)
          .select('#mgBitmap')
          .fields({ node: true, size: true })
          .exec((res) => {
            resolve(res && res[0] && res[0].node ? res[0].node : null);
          });
      });
      if (!bmpCanvas) return null;

      bmpCanvas.width = bw;
      bmpCanvas.height = bh;
      const bctx = bmpCanvas.getContext('2d');

      // 放大底图用与 renderBoard 相同的绘制路径，保证与整幅图纸观感一致
      const { renderBoard, attachIndex } = require('../../render/board');
      if (!pattern._index) attachIndex(pattern);

      const cellPxB = layout.cellPx * scale;
      const scaled = {
        cellPx: cellPxB,
        padding: layout.padding * scale,
        width: bw,
        height: bh,
        lineWidth: Math.max(1, layout.cellPx * 0.045 * scale),
        boardLineWidth: Math.max(1.5, layout.cellPx * 0.18 * scale),
        /*
         * ⚠️ 字号必须按 cellPx 比例**直接**算，不能用 layout.codeFontPx × scale。
         *   layout.codeFontPx 已被 Math.max(6, cellPx*0.34) 钳过一次，
         *   104 格（cellPx=3）时它是 6px —— 那是为屏幕缩略图准备的最小值，
         *   放大后仍是 6px，文字挤在格子里就是乱码。
         *   这里从 cellPx 重新推导，并设 14px 硬下限：
         *   低于此值色号必然糊成一团，宁可不画也不能画成乱码。
         */
        codeFontPx: Math.max(14, cellPxB * 0.42),
        titleFontPx: Math.max(14, cellPxB * 0.5),
      };

      renderBoard(bctx, pattern, scaled, {
        gridLine: this.data.gridLine,
        codeLabel: this.data.showCode,
        showDisclaimer: false,
      });

      this._bitmap = { canvas: bmpCanvas, scale };
      return this._bitmap;
    },

    /**
     * 把底图的对应区域画进放大视窗。
     *
     * 纯 drawImage 位图搬运 —— 与格数无关，因此：
     *   · 快：不受 cols×rows 影响，长按滑动可稳定 60fps
     *   · 清晰：文字是底图渲染时就画好的，放大只是采样已有像素
     */
    async _render() {
      const ctx = this._ctx;
      const layout = this.data.layout;
      if (!ctx || !layout) return;

      const bmp = await this._ensureBitmap();
      if (!bmp) {
        // 底图不可用（低端机不支持离屏画布）时至少给出白底，
        // 不能留一块空白让用户以为图纸缺内容
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, this._node.width, this._node.height);
        return;
      }

      /*
       * ⚠️ 必须读 this._offX/_offY（同步字段）而非 this.data.offX：
       *   setData 更新 this.data 是异步的，滑动时读 this.data 会拿到
       *   上一帧甚至更早的值 —— 这正是「画面跟不上手指」的根因。
       */
      const winW = this.data.winW;
      const winH = this.data.winH;
      const offX = this._offX;
      const offY = this._offY;
      const dpr = this._dpr;
      const s = bmp.scale;

      // 源区域：图纸坐标 → 底图像素
      const sx = offX * s;
      const sy = offY * s;
      // 视窗内可见的图纸范围 = 视窗尺寸 ÷ 放大倍率
      const sw = winW / this.data.zoom * s;
      const sh = winH / this.data.zoom * s;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, winW, winH);

      // 源区域可能被夹在图外（如图纸比视窗小），需裁到合法范围
      const maxX = Math.max(0, bmp.canvas.width - sw);
      const maxY = Math.max(0, bmp.canvas.height - sh);

      try {
        ctx.drawImage(
          bmp.canvas,
          clamp(sx, 0, maxX), clamp(sy, 0, maxY), sw, sh,
          0, 0, winW, winH
        );
      } catch (e) {
        // 极端参数下 drawImage 可能因源矩形越界抛错；退化为整图居中
        console.warn('[magnifier] drawImage 失败，回退为整图：', e);
        ctx.drawImage(bmp.canvas, 0, 0, bmp.canvas.width, bmp.canvas.height,
          0, 0, winW, winH);
      }
    },
  },
});

function clamp(v, min, max) {
  if (Number.isNaN(v)) return min;
  return Math.min(Math.max(v, min), max);
}
