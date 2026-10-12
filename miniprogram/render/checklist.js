/**
 * render/checklist.js —— 用量清单（文档 M6 / §4.1 `countUsage`）
 *
 * 职责：
 *   - 用量明细分组（按色系归类，便于一次备料）
 *   - 库存缺口分析（与豆柜对比）
 *   - 分板施工单切分
 *   - 采购建议
 */

const { splitByBoard } = require('./canvas');
const { BEAD_SPECS, DISCLAIMER } = require('../utils/config');

/**
 * 按色系归类，便于按色系分批备料
 * @returns {Array<{ name, items, totalCount, kinds }>}
 */
function groupByHue(colors) {
  const GROUPS = [
    { name: '红 / 粉', test: (c) => c.hueGroup === 'red' },
    { name: '橙 / 黄', test: (c) => c.hueGroup === 'orange' || c.hueGroup === 'yellow' },
    { name: '绿', test: (c) => c.hueGroup === 'green' },
    { name: '青 / 蓝', test: (c) => c.hueGroup === 'cyan' },
    { name: '紫', test: (c) => c.hueGroup === 'purple' },
    { name: '中性 / 棕', test: (c) => !c.hueGroup },
  ];

  return GROUPS.map((g) => {
    const items = colors.filter((c) => g.test(c));
    return {
      name: g.name,
      items,
      totalCount: items.reduce((s, c) => s + c.count, 0),
      kinds: items.length,
    };
  }).filter((g) => g.items.length > 0);
}

/**
 * 库存缺口分析
 *
 * @param {object} pattern
 * @param {object} inventory { [brand]: { [beadSize]: { [code]: qty } } }
 * @returns {{ hasConstraint, total, sufficient, shortage, unknownColors, shortageList }}
 */
function analyzeInventory(pattern, inventory) {
  const stock = (inventory && inventory[pattern.brand] && inventory[pattern.brand][pattern.beadSize]) || null;

  if (!stock) {
    return {
      hasConstraint: false,
      total: 0,
      sufficient: 0,
      shortage: 0,
      shortageList: [],
      unknownColors: [],
      missingColors: [],
    };
  }

  let sufficient = 0;
  let shortage = 0;
  const shortageList = [];
  const missingColors = [];

  for (const c of pattern.colors) {
    const have = stock[c.code] || 0;
    if (have >= c.count) {
      sufficient++;
    } else {
      shortage++;
      shortageList.push({ code: c.code, name: c.name, need: c.count, have, lack: c.count - have });
      if (have === 0) missingColors.push(c);
    }
  }

  return {
    hasConstraint: true,
    total: pattern.colors.length,
    sufficient,
    shortage,
    shortageList: shortageList.sort((a, b) => b.lack - a.lack),
    missingColors,
  };
}

/**
 * 分板施工单
 *
 * @returns {Array<{ label, x, y, w, h, total, kinds, list }>}
 */
function buildBoardSheets(pattern) {
  const boardSize = pattern.boardCount || 29;
  const regions = splitByBoard(pattern, boardSize);
  // S-04：cells 缺失或结构非法时按空图纸处理，不向上抛错
  const cells = (pattern && typeof pattern.cells === 'object' && pattern.cells) || {};

  const meta = {};
  for (const c of pattern.colors || []) meta[c.code] = c;

  return regions.map((r) => {
    const counts = new Map();
    let total = 0;
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const code = cells[`${y},${x}`];
        if (!code) continue;
        counts.set(code, (counts.get(code) || 0) + 1);
        total++;
      }
    }
    const list = [...counts.entries()]
      .map(([code, count]) => ({
        code,
        name: meta[code] ? meta[code].name : code,
        hex: meta[code] ? meta[code].hex : '#ccc',
        count,
      }))
      .sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : 1));

    return {
      ...r,
      total,
      kinds: list.length,
      list,
    };
  });
}

/**
 * 完整清单对象（供 result 页一次性渲染）
 */
function buildChecklist(pattern, inventory) {
  const spec = BEAD_SPECS[pattern.beadSize] || BEAD_SPECS['5mm'];
  const p = pattern.physicalSize || {};

  return {
    size: `${p.width || '?'} × ${p.height || '?'} cm`,
    boardSize: pattern.boardCount,
    boardCount: Math.ceil(pattern.cols / (pattern.boardCount || 29)) *
      Math.ceil(pattern.rows / (pattern.boardCount || 29)),
    totalCount: pattern.totalCount,
    colorCount: pattern.colors.length,
    suggestedBeads: pattern.suggestedBeads,
    beadType: pattern.beadType,
    beadSizeLabel: spec.label,
    warnAge: spec.warnAge,
    groups: groupByHue(pattern.colors),
    inventory: analyzeInventory(pattern, inventory),
    sheets: buildBoardSheets(pattern),
    disclaimers: {
      copyright: DISCLAIMER.copyright,
      colorDiff: DISCLAIMER.colorDiff,
      age: DISCLAIMER.age,
    },
  };
}

/**
 * 统计图纸实际涉及的全部色号（用于豆柜批量录入）
 */
function collectCodes(pattern) {
  return (pattern.colors || []).map((c) => ({
    code: c.code,
    name: c.name,
    hex: c.hex,
    need: c.count,
  }));
}

module.exports = {
  groupByHue,
  analyzeInventory,
  buildBoardSheets,
  buildChecklist,
  collectCodes,
};