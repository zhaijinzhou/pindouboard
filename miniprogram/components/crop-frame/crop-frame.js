/**
 * components/crop-frame/crop-frame.js —— 取景裁剪框
 *
 * 交互对齐微信「头像上传」：图片铺满取景台，中间一个选框，
 * 拖动选框平移、拖四角缩放，确认后把「用哪一块画面去生图」交出去。
 *
 * 【坐标约定】
 *   内部维护的 crop 是**相对取景台**的 px（便于直接渲染，不受图片尺寸影响）；
 *   对外抛出的是**相对原图归一化**的 {x, y, w, h}（0~1），
 *   这样与分辨率、屏幕尺寸、rpx/px 换算全部解耦。
 *
 * 之所以不用 movable-view / movable-area：
 *   movable-view 只支持等比缩放（scale），无法单边拖拽调整宽高比，
 *   而拼豆出图的裁剪框必须允许自由改变比例（比例直接决定图纸格点阵的宽高）。
 */

const MASK_COLOR = 'rgba(0, 0, 0, 0.55)';

/** 四角热区半径（px）—— 小程序里 44rpx≈22px，取 30 便于手指点中 */
const HIT = 30;
/** 选框最小边长（px），低于此值视为误触 */
const MIN_SIZE = 48;
/**
 * 自由比例下选框相对图片的内缩比例（每边）。
 * 铺满会导致框被「焊死」在图片边缘、拖不动；留 6% 余量即可拖动。
 */
const FREE_MARGIN = 0.06;

/**
 * 缩放方向的显式集合。
 *
 * ⚠️ 不要用 `mode.indexOf('n') >= 0` 判断方向（2026-10-13 踩坑）：
 *   `'ne'` 本身就是 n+e，indexOf('n') === 0 恒为真，
 *   会被误判成「上边」，导致右上角拖动时高度变化方向相反。
 *   同理 `'se'` 会被误判成含 n。字符串匹配在这里是陷阱。
 */
const NORTH = new Set(['n', 'ne', 'nw']);
const SOUTH = new Set(['s', 'se', 'sw']);
const WEST = new Set(['w', 'nw', 'sw']);
const EAST = new Set(['e', 'ne', 'se']);

Component({
  properties: {
    /** 本地图片路径 */
    src: { type: String, value: '' },
    /** 原图宽（px），用于把取景台坐标换算回归一化比例 */
    srcWidth: { type: Number, value: 0 },
    /** 原图高（px） */
    srcHeight: { type: Number, value: 0 },
    /** 锁定宽高比（w/h）。0 表示自由比例 */
    ratio: { type: Number, value: 0 },
  },

  data: {
    ready: false,
    stageW: 0,
    stageH: 0,
    crop: { x: 0, y: 0, w: 0, h: 0 },
    maskTop: '',
    maskBottom: '',
    maskLeft: '',
    maskRight: '',
    frameStyle: '',
  },

  observers: {
    'src, srcWidth, srcHeight': function () {
      if (this.data.src && this.data.srcWidth > 0 && this.data.srcHeight > 0) {
        this.initFrame();
      }
    },
    ratio: function () {
      if (this.data.ready) this.applyRatio();
    },
  },

  methods: {
    /** 量取景台尺寸 → 算出图片在台内的实际显示区域 → 铺满选框 */
    initFrame() {
      const self = this;
      wx.createSelectorQuery()
        .in(this)
        .select('.cf-stage')
        .boundingClientRect((rect) => {
          if (!rect || !rect.width || !rect.height) {
            // 取景台尚未布局完成，下一帧再试
            setTimeout(() => self.initFrame(), 60);
            return;
          }

          const stageW = rect.width;
          const stageH = rect.height;

          // aspectFit：图片等比内接于取景台，居中
          const scale = Math.min(stageW / this.data.srcWidth, stageH / this.data.srcHeight);
          const dispW = this.data.srcWidth * scale;
          const dispH = this.data.srcHeight * scale;
          const offX = (stageW - dispW) / 2;
          const offY = (stageH - dispH) / 2;

          // 存实例上而非 data：渲染只需要 crop，避免高频 setData 带冗余
          this.disp = { offX, offY, dispW, dispH };

          this.setData({
            ready: true,
            stageW,
            stageH,
            crop: { x: offX, y: offY, w: dispW, h: dispH },
          });

          this.applyRatio();
        })
        .exec();
    },

    /**
     * 按锁定比例重设选框（居中，保持最大面积）。
     *
     * ⚠️ 必须 emit：比例切换会实质改变裁剪区域，而父页面靠 `change` 事件
     *    才知道新区域并重算 session。若只更新内部样式，父页面仍持有旧的
     *    裁剪数据 —— 表现为「选了 2:1，预览还是原图」。
     */
    applyRatio() {
      if (!this.disp) return;
      const ratio = this.data.ratio;
      const { offX, offY, dispW, dispH } = this.disp;

      // 自由比例：铺满图片，但**留出可拖动的余量**。
      // 若真的铺满（w===dispW），moveRect 的 clamp 区间退化为零宽，
      // 框会被「焊死」在图片上，拖不动也看不出变化 —— 这正是用户反馈的
      // 「自由比例下无法拖动」。留 6% 内缩后，四个方向都有可移动空间。
      if (!ratio || ratio <= 0) {
        const mx = dispW * FREE_MARGIN;
        const my = dispH * FREE_MARGIN;
        this.setCrop({
          x: offX + mx,
          y: offY + my,
          w: dispW - mx * 2,
          h: dispH - my * 2,
        }, true);
        return;
      }

      let w = dispW;
      let h = w / ratio;
      if (h > dispH) {
        h = dispH;
        w = h * ratio;
      }

      /*
       * ⚠️ 锁定比例时也要留余量。
       * 取「按比例尽可能大」的框时，只要原图比例与锁定比例接近，
       * 框就会在某一轴上贴满取景台，该轴的 clamp 区间退化为 0，
       * 表现为「纵向怎么拖都不动」。
       *
       * 内缩必须**等比缩放**（与 core/pixelate.centerCropRatio 同一算法）：
       * 若简单地把 w/h 各减一份余量，形状会被拉歪，
       * 表现为「选了单板 1:1，出图却不是方的」。
       */
      const availW = dispW * (1 - FREE_MARGIN * 2);
      const availH = dispH * (1 - FREE_MARGIN * 2);
      const fit = Math.min(availW / w, availH / h);
      w *= fit;
      h *= fit;

      this.setCrop({
        x: offX + (dispW - w) / 2,
        y: offY + (dispH - h) / 2,
        w: Math.max(MIN_SIZE, w),
        h: Math.max(MIN_SIZE, h),
      }, true);
    },

    /* ============ 触摸交互 ============ */

    onTouchStart(e) {
      if (!this.data.ready || !this.disp) return;
      const t = e.touches && e.touches[0];
      if (!t) return;

      const { crop } = this.data;
      const mode = this.hitTest(t.clientX, t.clientY, crop);

      this.gesture = {
        mode,
        startX: t.clientX,
        startY: t.clientY,
        origin: { ...crop },
        disp: { ...this.disp },
        moved: false,
      };
    },

    onTouchMove(e) {
      const g = this.gesture;
      if (!g) return;
      // 未命中任何热区（点在选框外）时不做任何事，避免误触改变裁剪
      if (!g.mode) return;

      const t = e.touches && e.touches[0];
      if (!t) return;

      const dx = t.clientX - g.startX;
      const dy = t.clientY - g.startY;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) g.moved = true;

      const next = g.mode === 'move'
        ? this.moveRect(g, dx, dy)
        : this.resizeRect(g, dx, dy);

      this.setCrop(next);
    },

    /**
     * 手势收尾。touchend 与 touchcancel 走同一分支。
     *
     * ⚠️ cancel 必须也收尾：手势被系统打断（来电、页面切换）
     *    若不清掉 this.gesture，下次 touchmove 会沿用上一次的
     *    起始坐标，表现为「框突然跳一下」。
     */
    onTouchEnd() {
      const g = this.gesture;
      this.gesture = null;
      // 只有真正拖动过才抛事件，避免点一下也触发父层重算
      if (g && g.moved) this.emitChange();
    },

    /*
 * 命中测试：四角 > 四边中点 > 框内平移。
 *
 * ⚠️ 为什么必须「四角优先、且角内先判」（2026-10-13 连修三次的教训）：
 *   1. 正点落在角上时，相邻两角距离同为 0，若把角与边混在一起比距离，
 *      上边中点会抢走右下角 → 表现为「右下角把手失灵」。
 *   2. 角与角距离相同时，用「后遍历的胜出」依赖顺序太脆弱，
 *      改用「距离严格更小才替换」，让先遍历到的角保持优先。
 *   3. 边的语义（只改一轴）与角（改对角两轴）冲突时，
 *      永远让角优先 —— 角是更精确的意图。
 *
 * 另：选框必须四周留余量（applyRatio 的 FREE_MARGIN），
 * 否则贴边时该轴的 clamp 区间退化为 0，怎么拖都不动。
 */
    hitTest(px, py, crop) {
      // 只接受落在选框（含热区余量）内的触点
      if (px < crop.x - HIT || px > crop.x + crop.w + HIT) return null;
      if (py < crop.y - HIT || py > crop.y + crop.h + HIT) return null;

      const cx = crop.x + crop.w / 2;
      const cy = crop.y + crop.h / 2;
      const candidates = [];

      // 四角：优先级最高，先算距离
      const corners = [
        { mode: 'nw', d: dist2(px, py, crop.x, crop.y) },
        { mode: 'ne', d: dist2(px, py, crop.x + crop.w, crop.y) },
        { mode: 'sw', d: dist2(px, py, crop.x, crop.y + crop.h) },
        { mode: 'se', d: dist2(px, py, crop.x + crop.w, crop.y + crop.h) },
      ];

      let bestCorner = null;
      for (const c of corners) {
        const d = Math.sqrt(c.d);
        // 用 <= 而非 <：正点落在角上时，相邻两个角的距离同为 0，
        // 严格小于会让先遍历到的那个（ne 在 se 之前）恒定胜出，
        // 表现为「右下角把手永远失灵」。
        if (d <= HIT && (!bestCorner || d <= bestCorner.d)) bestCorner = { mode: c.mode, d };
      }
      // 命中角就直接返回：角的操作语义（改对角两轴）永远优于边（只改一轴），
      // 否则贴边时「靠右又靠上」会被上边中点抢走，表现为角把手失灵。
      if (bestCorner) return bestCorner.mode;

      // 四边中点：仅锁定比例时提供（自由比例下拖边会破坏宽高比预期）
      if (this.data.ratio > 0) {
        const edges = [
          { mode: 'n', d: dist2(px, py, cx, crop.y) },
          { mode: 's', d: dist2(px, py, cx, crop.y + crop.h) },
          { mode: 'w', d: dist2(px, py, crop.x, cy) },
          { mode: 'e', d: dist2(px, py, crop.x + crop.w, cy) },
        ];
        let bestEdge = null;
        for (const c of edges) {
          const d = Math.sqrt(c.d);
          if (d <= HIT && (!bestEdge || d < bestEdge.d)) bestEdge = { mode: c.mode, d };
        }
        if (bestEdge) return bestEdge.mode;
      }

      // 框内 → 平移
      if (px > crop.x && px < crop.x + crop.w && py > crop.y && py < crop.y + crop.h) {
        return 'move';
      }
      return null;
    },

    /** 平移：整框跟随，且不越出图片显示区域 */
    moveRect(g, dx, dy) {
      const { offX, offY, dispW, dispH } = g.disp;
      const o = g.origin;
      return {
        x: clamp(o.x + dx, offX, offX + dispW - o.w),
        y: clamp(o.y + dy, offY, offY + dispH - o.h),
        w: o.w,
        h: o.h,
      };
    },

    /**
     * 缩放：以对角为锚点改变宽高。
     * 锁定比例时，按主导方向（位移绝对值更大的一轴）推导另一轴。
     *
     * ⚠️ 这里**不能用字符串匹配判断方向**（2026-10-13 修复）：
     *   `'ne'.indexOf('n') === 0` 为真 → 右上角被当成「上边」，
     *   锚点与缩放轴全错，表现为「拖右上角高度反而变小」。
     *   同理 `'sw'.indexOf('w')` 虽正确，但与 `'nw'` 混用时极易看错。
     *   改为显式的方向集合，语义一目了然且不会误判。
     */
    resizeRect(g, dx, dy) {
      const { offX, offY, dispW, dispH } = g.disp;
      const o = g.origin;
      const mode = g.mode;
      const ratio = this.data.ratio > 0 ? this.data.ratio : 0;

      // 哪些边参与缩放：w=左/右边可改宽，h=上/下边可改高
      const touchesW = WEST.has(mode) || EAST.has(mode);
      const touchesH = NORTH.has(mode) || SOUTH.has(mode);
      // 锚点固定在「不动的那个角」
      const anchorAtRight = WEST.has(mode);
      const anchorAtBottom = NORTH.has(mode);

      let w = o.w;
      let h = o.h;

      if (touchesW) {
        // 拖左边界 → 宽度 = 原宽 - 位移；拖右边界 → 宽度 = 原宽 + 位移
        w = WEST.has(mode) ? o.w - dx : o.w + dx;
      }
      if (touchesH) {
        h = NORTH.has(mode) ? o.h - dy : o.h + dy;
      }

      if (ratio > 0 && touchesW && touchesH) {
        // 四角：取位移更大的那轴为主轴，保证跟手
        if (Math.abs(dx) / ratio >= Math.abs(dy)) h = w / ratio;
        else w = h * ratio;
      } else if (ratio > 0 && touchesW) {
        h = w / ratio;
      } else if (ratio > 0 && touchesH) {
        w = h * ratio;
      }

      w = Math.max(MIN_SIZE, w);
      h = Math.max(MIN_SIZE, h);

      // 不允许超出图片显示区域
      w = Math.min(w, dispW);
      h = Math.min(h, dispH);
      if (touchesW && touchesH && ratio > 0) {
        if (w / ratio > h) h = w / ratio;
        else w = h * ratio;
      }

      /*
       * 位置由锚点反推。
       * ⚠️ 锚点是**原框的对边**，必须在本次手势内保持不动。
       *    写成图片边缘（offX+dispW）会让框在拖动过程中持续平移 ——
       *    看着像「框自己滑走了」，而不是被缩放。
       */
      const anchorX = anchorAtRight ? o.x + o.w : o.x;
      const anchorY = anchorAtBottom ? o.y + o.h : o.y;

      return {
        x: clamp(anchorAtRight ? anchorX - w : anchorX, offX, offX + dispW - w),
        y: clamp(anchorAtBottom ? anchorY - h : anchorY, offY, offY + dispH - h),
        w,
        h,
      };
    },

    /* ============ 状态与渲染 ============ */

    /**
     * 更新选框并重绘遮罩。
     * @param {object} crop 取景台 px 坐标
     * @param {boolean} [emit=false] 是否向父页面抛 change 事件。
     *   **仅程序化改动（比例切换、初始化）才传 true**。
     *   拖动路径必须传 false —— 否则每帧都会触发父页面重算 session。
     */
    setCrop(crop, emit) {
      const c = {
        x: Math.round(crop.x * 100) / 100,
        y: Math.round(crop.y * 100) / 100,
        w: Math.round(crop.w * 100) / 100,
        h: Math.round(crop.h * 100) / 100,
      };
      this.setData({ crop: c }, () => {
        this.paintMask(c);
        if (emit) this.emitChange();
      });
    },

    /** 四块遮罩围出中间的「孔洞」，比用 canvas 画省一次渲染层通信 */
    paintMask(c) {
      const { stageW, stageH } = this.data;
      this.setData({
        maskTop: `left:0;top:0;width:${stageW}px;height:${c.y}px;background:${MASK_COLOR}`,
        maskBottom: `left:0;top:${c.y + c.h}px;width:${stageW}px;height:${Math.max(0, stageH - c.y - c.h)}px;background:${MASK_COLOR}`,
        maskLeft: `left:0;top:${c.y}px;width:${c.x}px;height:${c.h}px;background:${MASK_COLOR}`,
        maskRight: `left:${c.x + c.w}px;top:${c.y}px;width:${Math.max(0, stageW - c.x - c.w)}px;height:${c.h}px;background:${MASK_COLOR}`,
        frameStyle: `left:${c.x}px;top:${c.y}px;width:${c.w}px;height:${c.h}px`,
      });
    },

    /** 取景台 px → 原图归一化比例 */
    toNormalized() {
      if (!this.disp) return { x: 0, y: 0, w: 1, h: 1 };
      const c = this.data.crop;
      const { offX, offY, dispW, dispH } = this.disp;
      return {
        x: round4(clamp((c.x - offX) / dispW, 0, 1)),
        y: round4(clamp((c.y - offY) / dispH, 0, 1)),
        w: round4(clamp(c.w / dispW, 0, 1)),
        h: round4(clamp(c.h / dispH, 0, 1)),
      };
    },

    emitChange() {
      this.triggerEvent('change', { crop: this.toNormalized() });
    },

    /** 对外：取当前选框（归一化） */
    getCrop() {
      return this.toNormalized();
    },
  },
});

function clamp(v, min, max) {
  if (max < min) return min;
  return v < min ? min : v > max ? max : v;
}

/** 点到热区中心的平方距离（省一次开方，热区比较只需相对大小） */
function dist2(px, py, cx, cy) {
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy;
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}
