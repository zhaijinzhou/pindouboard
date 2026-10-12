/**
 * utils/config.js
 * 全局默认配置与算法阈值。
 *
 * 本文件集中承载开发文档中标注为「待补充 / 待确认」的全部默认值，
 * 每一项都注明取值依据，便于后续校准与评审追溯。
 * 详见 /docs/决策补充文档.md 第 2 章。
 */

/** 色库版本号（文档 §8「色库版本号 待定义」→ 定义为 v0.2.0 对齐文档版本） */
const PALETTE_VERSION = '0.2.0';

/** 默认参数（文档 §8 默认配置项表） */
const DEFAULT_PARAMS = {
  /**
   * ⚠️ 字段名沿用历史叫法 boardCount，但语义是「单板格数」（16/29/52/75），
   *    **不是板数**。v0.9 新增下面两个真正的板数字段，勿再混用。
   */
  boardCount: 29, // 单板格数：29 格标准板
  /** 横向板数（1/2），由 index 页的成品规格档位决定 */
  boardCols: 1,
  /** 纵向板数（1/2） */
  boardRows: 1,
  colorLimit: 20, // 颜色数上限
  dither: false, // 抖动：关闭
  gridLine: true, // 网格线：开
  codeLabel: true, // 色号标注：开
  mode: 'cartoon', // 算法模式：cartoon 主导色
  beadSize: '5mm', // 豆子规格
  beadType: 'regular', // 豆子类型：普通
  brand: 'MARD', // 品牌
  enhance: false, // 图片增强：关
  removeBg: false, // 去背景：关
  mergeSimilar: false, // 杂色合并：关
};

/** 豆子规格定义（文档 §2.2） */
const BEAD_SPECS = {
  '5mm': { label: '5mm 标准', diameter: 5, warnAge: false },
  '3mm': { label: '3mm 小豆', diameter: 3, warnAge: false },
  '2.6mm': { label: '2.6mm 迷你', diameter: 2.6, warnAge: true },
};

/** 豆子类型（文档 §2.2） */
const BEAD_TYPES = {
  // fusion 加热融合对配色宽松度容忍更高 → 合并阈值与色差容忍相应放宽
  regular: { label: '普通豆', mergeDeltaScale: 1.0, deltaToleranceScale: 1.0 },
  fusion: { label: '加热融合', mergeDeltaScale: 1.25, deltaToleranceScale: 1.15 },
};

/**
 * 算法阈值 —— 对应文档中 D-01~D-04 的缺口。
 * 依据 CIE 推荐：「ΔE<2.3 不可察觉；2.3~5 细微；5~10 可察觉但可接受；>10 明显差异」。
 */

/** 主导色算法：区域量化粒度（每个 5bit 分桶后的频次统计桶数） */
const DOMINANT = {
  /** 分桶步长：RGB 各通道按 32 级量化，降低噪点主导的方向 */
  quantizeStep: 32,
  /**
   * 主导色区域最小像素数。低于该值时回退到区域均值，
   * 避免单像素噪点被误判成「主导色」。
   */
  minPixels: 3,
};

/** 杂色合并阈值 D-04：默认 ΔE = 12。依据：ΔE>10 属明显差异，12 已越过肉眼可辨界，能有效压缩零碎色又不至于吞掉真实细节。 */
const MERGE_DEFAULT_DELTA = 12;
/** 合并阈值可调范围 */
const MERGE_DELTA_RANGE = { min: 0, max: 40, step: 1, default: MERGE_DEFAULT_DELTA };
/** 单次合并迭代上限，防止病态输入下无限循环 */
const MERGE_MAX_ITER = 4;

/** 去背景容差（RGB 欧氏距离，0~441） */
const BG_TOLERANCE_RANGE = { min: 0, max: 120, step: 5, default: 30 };

/** 孤立块检测：单格是否算孤立（4 邻域中不同色邻居数 ≥ 该值） */
const ISOLATED = {
  /** 邻居色数达到此值即判为孤立 */
  minDifferentNeighbors: 4,
  /** 体检阈值：孤立格占比超过此比例提示 */
  warnRatio: 0.04,
};

/** 色号匹配 D-02 */
const MATCH = {
  /** ΔE 算法：'76' 更快，'2000' 更准。默认 2000 */
  deltaMethod: '2000',
  /** 可接受色差上限：超过此 ΔE 认为「匹配质量差」，进入体检 */
  acceptableDelta: 14,
  /** P-05 匹配剪枝：色相预筛的容差角（度）。超出该角度的候选不参与 ΔE 比较 */
  huePruneAngle: 25,
};

/** 图片预检 S-02 阈值 */
const PRECHECK = {
  /** 原图体积上限（MB） */
  maxSizeMB: 20,
  /** 原图短边像素下限，低于此值提示噪点风险 */
  minShortEdge: 200,
  /** 处理链入口压缩后的最长边 */
  maxProcessEdge: 1400,
  /** 目标格数放大倍率（像素化采样密度），用于 cartoon 主导色统计 */
  sampleScale: 3,
};

/** 导出 P-01 / D-05 */
const EXPORT = {
  /** 目标导出最短边（px），保证色号文字打印清晰 */
  targetEdge: 2048,
  /** 单块 Canvas 最大像素边长，超出则分板分段导出 */
  maxCanvasEdge: 4096,
  /** 单格渲染边长区间（px） */
  minCellPx: 26,
  maxCellPx: 64,
};

/**
 * 屏幕内预览画布的适配参数（editor / result / config 三页共用）。
 *
 * 【为什么需要这一组】
 * 2026-10-13 修复「图纸被横向压扁」：三页原本各自用 `windowWidth - 40` 估算可用宽度，
 * 而真实内边距链是 .page 24rpx×2 + .card 28rpx×2 + 画布容器 20rpx×2（375px 屏约 72px）。
 * 估算偏大 → 画布溢出 → flex 子项被压缩 → CSS 显示宽度变窄而 canvas 缓冲不变 → 变形。
 * 现统一改为「实测容器 + 等比缩小到完整可见」，本块存放三页共用的阈值。
 *
 * 注：v0.9 起 result 页图纸卡收紧（.board-card padding 20rpx、.canvas-wrap 12rpx），
 * 容器内边距链随之变窄。主路径靠实测自动适配，本块常数仅在实测失败时兜底。
 */
const SCREEN_CANVAS = {
  /** 画布内边距（px）。画布尺寸走 px 内联样式，故此处也是 px 而非 rpx */
  padding: 16,
  /** 质量下限（px）。低于 6px 已难分辨格线；空间不足时自动让步，见 fitCanvasLayout */
  minCellPx: 6,
  /** 单格上限（px）。再大对预览无信息增益，只会让小图纸在大屏上糊边 */
  maxCellPx: 28,
  /** 绝对下限（px），防止极端窄屏算出 0 或负数 */
  hardFloor: 2,
  /**
   * 画布高度预算 = 视口高度 × 本系数。
   * 取 0.55：保证图纸在一屏内完整可见，同时不至于把下方体检卡挤出首屏。
   */
  heightRatio: 0.55,
  /**
   * 实测失败时的兜底内缩量（rpx，左右各半已含在数值内）。
   * 144 = .page 24×2 + .card 28×2 + 画布容器 20×2，三页同构。
   * ⚠️ 仅在 createSelectorQuery 拿不到 rect 时使用，改动对应 WXSS padding 时须同步。
   */
  fallbackInsetRpx: 144,
};

/** 存储 Q-03：单 key 体积上限保守取值（Storage 单 key 上限 1MB，总量 10MB） */
const STORAGE = {
  /** 单个图纸 storage 体积告警阈值（字符数近似） */
  warnChars: 900 * 1024,
  /** 最多保留的历史图纸数 */
  maxHistory: 10,
};

/** 安全与合规文案（S-05 ~ S-07） */
const DISCLAIMER = {
  copyright: '仅限个人自娱，禁商用 / 接单售卖',
  colorDiff:
    '屏幕显示与实物豆存在色差，请以实物色卡为准；同一色号在不同光照下也会略有差异。',
  age:
    '本作品含小零件，谨防误吞。请在成人看护下拼装；2.6mm 迷你豆建议 14 岁以上使用；加热融合须由成人操作。',
  privacy: '所有图像处理均在本机完成，图片不会上传到任何服务器。',
};

module.exports = {
  PALETTE_VERSION,
  DEFAULT_PARAMS,
  BEAD_SPECS,
  BEAD_TYPES,
  DOMINANT,
  MERGE_DEFAULT_DELTA,
  MERGE_DELTA_RANGE,
  MERGE_MAX_ITER,
  BG_TOLERANCE_RANGE,
  ISOLATED,
  MATCH,
  PRECHECK,
  EXPORT,
  SCREEN_CANVAS,
  STORAGE,
  DISCLAIMER,
};