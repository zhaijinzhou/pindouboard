/**
 * core/check.js —— 配色体检报告（文档 M8 / §4.1 `checkPalette`）
 *
 * 体检项（文档 §9「P1 实现要点」）：
 *   - 孤立色块数
 *   - 颜色数超阈
 *   - 互补色面积失衡
 *   - 浅色系缺深色轮廓
 *
 * 另加入三项工程上同样关键、且成本极低的检查：
 *   - 色差质量（平均/最大 ΔE）：判断是否有大量格子被迫匹配到「勉强够近」的色
 *   - 背景占比异常：主体过小或过大时提示
 *   - 碎片簇位置：把孤立格聚类后给出定位，便于用户回到 editor 页修图
 *
 * 输出结构统一为 { level, title, detail, advice }，UI 层直接渲染即可。
 *   level: 'pass' | 'warn' | 'danger'
 *
 * 纯逻辑层，不依赖 wx。
 */

const { MATCH, DEFAULT_PARAMS } = require('../utils/config');
const { perceivedLightness } = require('../color/lab');

/** 互补色分组：把色相环分成 6 组做面积对比（文档「互补色面积失衡」） */
const HUE_GROUPS = [
  { id: 'red', name: '红', ranges: [[345, 360], [0, 15]] },
  { id: 'orange', name: '橙', ranges: [[15, 45]] },
  { id: 'yellow', name: '黄', ranges: [[45, 70]] },
  { id: 'green', name: '绿', ranges: [[70, 165]] },
  { id: 'cyan', name: '青蓝', ranges: [[165, 255]] },
  { id: 'purple', name: '紫红', ranges: [[255, 345]] },
];

function hueGroupOf(hue) {
  if (hue < 0) return null;
  for (const g of HUE_GROUPS) {
    for (const [lo, hi] of g.ranges) {
      if (hue >= lo && hue < hi) return g.id;
    }
  }
  return null;
}

/**
 * @param {object} input {
 *     codes, cols, rows,
 *     details,          matchCodes 的 details Map
 *     deltaStats,       matchCodes 的 deltaStats
 *     isolated,         detectIsolated 的返回值
 *     bgRatio,          去背景后的背景占比
 *     params            当前参数
 *   }
 * @returns {{ items, level, summary }}
 */
function checkPalette(input) {
  const {
    codes, cols, rows,
    details,
    deltaStats,
    isolated,
    bgRatio = 0,
    params = DEFAULT_PARAMS,
  } = input || {};

  const items = [];

  /* ---------- 1. 颜色数 ---------- */
  const colorCount = details ? details.size : countDistinct(codes);
  const limit = params.colorLimit || DEFAULT_PARAMS.colorLimit;
  if (colorCount > limit) {
    items.push({
      key: 'colorCount',
      level: 'warn',
      title: `颜色数 ${colorCount} 色，超出上限 ${limit} 色`,
      detail: '颜色过多会让备料和拼接难度显著上升。',
      advice: colorCount > limit * 1.5
        ? '建议关闭「杂色合并」并提高合并阈值，把颜色压到 20 色以内。'
        : '建议开启「杂色合并」并适当提高阈值。',
    });
  } else {
    items.push({
      key: 'colorCount',
      level: 'pass',
      title: `颜色数 ${colorCount} 色`,
      detail: `在 ${limit} 色上限内，备料压力可控。`,
      advice: '',
    });
  }

  /* ---------- 2. 孤立色块 ---------- */
  const isoCount = isolated ? isolated.count : 0;
  if (isoCount > 0) {
    const topGroups = isolated.groups.slice(0, 3)
      .map((g) => `(${g.x + 1},${g.y + 1}) 附近 ${g.isolatedCount} 格`);
    const level = isolated.ratio > 0.1 ? 'danger' : isoCount > cols * rows * 0.04 ? 'warn' : 'pass';
    items.push({
      key: 'isolated',
      level,
      title: `孤立色块 ${isoCount} 处`,
      detail: `占全图 ${(isolated.ratio * 100).toFixed(1)}%。${topGroups.join('；')}`,
      advice: isoCount > 0
        ? '孤立单格容易漏拼或被当作噪点删掉，建议在图纸预览页手动把这些格子并入相邻色块。'
        : '',
    });
  } else {
    items.push({
      key: 'isolated',
      level: 'pass',
      title: '无孤立色块',
      detail: '所有色块均与同色区域相连，施工友好。',
      advice: '',
    });
  }

  /* ---------- 3. 互补色面积失衡 ---------- */
  const groupArea = new Map();
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (!code) continue;
    const d = details ? details.get(code) : null;
    if (!d || !d.hueGroup) continue;
    groupArea.set(d.hueGroup, (groupArea.get(d.hueGroup) || 0) + 1);
  }

  if (groupArea.size >= 2) {
    const sorted = [...groupArea.entries()].sort((a, b) => b[1] - a[1]);
    const [topId, topN] = sorted[0];
    const totalArea = sorted.reduce((s, [, n]) => s + n, 0);
    const ratio = topN / totalArea;
    const topName = (HUE_GROUPS.find((g) => g.id === topId) || {}).name || topId;

    if (ratio > 0.85 && sorted.length >= 3) {
      items.push({
        key: 'complement',
        level: 'warn',
        title: `${topName}系占比 ${(ratio * 100).toFixed(0)}%，其余色系过少`,
        detail: '大面积单一色系会削弱作品层次，视觉上容易发闷。',
        advice: '可尝试切换「照片均值」算法，或提高对比度让层次拉开。',
      });
    } else {
      items.push({
        key: 'complement',
        level: 'pass',
        title: '色系面积分布均衡',
        detail: `${topName}系为主，占比 ${(ratio * 100).toFixed(0)}%，其余色系有分布。`,
        advice: '',
      });
    }
  }

  /* ---------- 4. 浅色系缺深色轮廓 ---------- */
  const lightStats = analyzeLightness(codes, details);
  if (lightStats.lightRatio > 0.6 && lightStats.darkRatio < 0.03) {
    items.push({
      key: 'outline',
      level: 'warn',
      title: `浅色占比 ${(lightStats.lightRatio * 100).toFixed(0)}%，缺少深色轮廓`,
      detail: '整体偏浅时图案轮廓容易糊成一片，拼接时也难以辨认边界。',
      advice: '建议加深 1~2 格深色作为轮廓线，或提高图像对比度。',
    });
  } else {
    items.push({
      key: 'outline',
      level: 'pass',
      title: '明暗层次正常',
      detail: `浅色 ${(lightStats.lightRatio * 100).toFixed(0)}% / 深色 ${(lightStats.darkRatio * 100).toFixed(0)}%，轮廓可辨。`,
      advice: '',
    });
  }

  /* ---------- 5. 色差匹配质量 ---------- */
  if (deltaStats && deltaStats.avg > 0) {
    const level = deltaStats.avg > MATCH.acceptableDelta ? 'danger'
      : deltaStats.avg > MATCH.acceptableDelta * 0.6 ? 'warn' : 'pass';
    items.push({
      key: 'delta',
      level,
      title: `平均色差 ΔE ${deltaStats.avg}`,
      detail: `最大 ΔE ${deltaStats.max}，${deltaStats.poorCount} 格色差超过可接受上限 ${deltaStats.acceptableDelta}。`,
      advice: level === 'pass'
        ? '色号匹配质量良好。'
        : '色号与目标色偏离较大，建议更换品牌色库、放宽库存色约束，或减少颜色数上限。',
    });
  }

  /* ---------- 6. 背景占比 ---------- */
  if (bgRatio > 0.75) {
    items.push({
      key: 'bgRatio',
      level: 'warn',
      title: `背景占比 ${(bgRatio * 100).toFixed(0)}%`,
      detail: '主体占比过小，图纸有效区域利用率低。',
      advice: '可提高背景容差以识别更多背景，或缩小格数以放大主体。',
    });
  }

  /* ---------- 汇总 ---------- */
  const level = items.some((i) => i.level === 'danger') ? 'danger'
    : items.some((i) => i.level === 'warn') ? 'warn' : 'pass';

  const warnCount = items.filter((i) => i.level === 'warn').length;
  const dangerCount = items.filter((i) => i.level === 'danger').length;

  return {
    items,
    level,
    summary: level === 'pass'
      ? '配色体检通过，图纸可直接施工。'
      : level === 'warn'
        ? `发现 ${warnCount} 项可优化问题，建议参考建议调整。`
        : `发现 ${dangerCount} 项关键问题，建议优先处理。`,
  };
}

/** 明暗分布分析 */
function analyzeLightness(codes, details) {
  let light = 0, dark = 0, filled = 0;
  if (details) {
    for (const d of details.values()) {
      const L = perceivedLightness(d.rgb[0], d.rgb[1], d.rgb[2]);
      filled += d.count;
      if (L > 78) light += d.count;
      else if (L < 42) dark += d.count;
    }
  }
  const base = filled || codes.filter(Boolean).length || 1;
  return {
    lightRatio: light / base,
    darkRatio: dark / base,
    filled,
  };
}

function countDistinct(codes) {
  const s = new Set();
  for (const c of codes) if (c) s.add(c);
  return s.size;
}

/**
 * 给 details 的每个条目补上 hueGroup（供体检做色系面积统计）。
 * 单独暴露，供 pipeline 在 matchCodes 之后调用。
 */
function annotateHueGroups(details) {
  for (const d of details.values()) {
    if (d.hueGroup !== undefined) continue;
    const { rgbToHue } = require('../color/lab');
    d.hueGroup = hueGroupOf(rgbToHue(d.rgb[0], d.rgb[1], d.rgb[2]));
  }
  return details;
}

module.exports = {
  checkPalette,
  annotateHueGroups,
  hueGroupOf,
  HUE_GROUPS,
};