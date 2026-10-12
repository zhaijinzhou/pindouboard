/**
 * core/merge.js —— 杂色合并（文档 §2.1「杂色合并」/ §4.1 `mergeSimilar` / D-04）
 *
 * BFS 合并相邻相似色区域，阈值可调。
 *
 * 【D-04 阈值默认值 —— 依据说明】
 *   默认 ΔE = 12（见 utils/config.js MERGE_DEFAULT_DELTA）。
 *   依据 CIE 色差可辨识度分级：
 *     ΔE < 2.3   人眼不可察觉
 *     ΔE 2~5     仅可察觉细微差异
 *     ΔE 5~10    察觉但可接受
 *     ΔE > 10    明显差异
 *   取 12：已越过「明显差异」界线 —— 两个 ΔE<12 的颜色并排时肉眼基本分辨不出，
 *   却能把零碎色数量压下来；若取更小（如 5）压缩不足，取更大（如 20）会吞掉真实明暗层次。
 *
 * 算法：连通域 + 并查集
 *   1. 按 4-邻域把同色格切分为「初始连通域」
 *   2. 为每个域计算代表色（Lab 均值）与色号（该域内出现次数最多的色号）
 *   3. 并查集：若两个相邻域的代表色 ΔE < 阈值，则 union
 *   4. 迭代直到本轮无新增合并，或达到 maxIter 上限（防止病态输入下震荡）
 *   5. 按合并后的簇重写色号矩阵
 *
 * 为何用 Lab 均值而非直接取一方色号：直接取一方会引入系统性偏差
 * （合并结果总向初始占优的那一方偏色），累积后整图色调会漂移。
 */

const { deltaE, rgbToLab } = require('../color/lab');
const { MERGE_DEFAULT_DELTA, MERGE_MAX_ITER, BEAD_TYPES, MATCH } = require('../utils/config');

/**
 * @param {string[]} codes 色号矩阵（长度 cols*rows，'' 表示空/背景格）
 * @param {number} cols
 * @param {number} rows
 * @param {object} options {
 *     delta:      合并阈值（ΔE），默认 12
 *     palette:    色库索引，用于取色号对应的 Lab（不传则退化为按 code 去重粗筛）
 *     beadType:   豆子类型，影响阈值缩放（fusion 更宽容）
 *     maxIter:    最大迭代轮数
 *     deltaMethod:'76' | '2000'
 *   }
 * @returns {{ codes, mergeCount, regionBefore, regionAfter, deltaUsed }}
 */
function mergeSimilar(codes, cols, rows, options = {}) {
  const beadCfg = BEAD_TYPES[options.beadType] || BEAD_TYPES.regular;
  const baseDelta = options.delta != null ? options.delta : MERGE_DEFAULT_DELTA;
  const threshold = baseDelta * beadCfg.mergeDeltaScale;
  const maxIter = options.maxIter || MERGE_MAX_ITER;
  const method = options.deltaMethod || MATCH.deltaMethod;

  const total = cols * rows;

  // ---- 色号 → Lab 查表 ----
  const labCache = new Map();
  const getLab = (code) => {
    if (!code) return null;
    if (labCache.has(code)) return labCache.get(code);
    let lab = null;
    if (options.palette) {
      const entry = options.palette.byCode.get(code);
      if (entry) lab = entry.lab;
    }
    labCache.set(code, lab);
    return lab;
  };

  // ---- 1. 初始连通域 ----
  const cellRegion = new Int32Array(total).fill(-1);
  const regionInfo = []; // { cells:[], codeTally:Map, sumLab:{L,a,b}, labN }
  const stack = [];

  for (let start = 0; start < total; start++) {
    const code = codes[start];
    if (!code) { cellRegion[start] = -1; continue; }
    if (cellRegion[start] !== -1) continue;

    const rid = regionInfo.length;
    const info = { cells: [], codeTally: new Map(), sumL: 0, sumA: 0, sumB: 0, labN: 0 };
    regionInfo.push(info);

    stack.length = 0;
    stack.push(start);
    cellRegion[start] = rid;
    while (stack.length) {
      const i = stack.pop();
      info.cells.push(i);
      info.codeTally.set(codes[i], (info.codeTally.get(codes[i]) || 0) + 1);
      const lab = getLab(codes[i]);
      if (lab) {
        info.sumL += lab.L; info.sumA += lab.a; info.sumB += lab.b; info.labN++;
      }

      const x = i % cols;
      const y = (i - x) / cols;
      // 4 邻域
      if (x > 0 && cellRegion[i - 1] === -1 && codes[i - 1] === codes[i]) {
        cellRegion[i - 1] = rid; stack.push(i - 1);
      }
      if (x < cols - 1 && cellRegion[i + 1] === -1 && codes[i + 1] === codes[i]) {
        cellRegion[i + 1] = rid; stack.push(i + 1);
      }
      if (y > 0 && cellRegion[i - cols] === -1 && codes[i - cols] === codes[i]) {
        cellRegion[i - cols] = rid; stack.push(i - cols);
      }
      if (y < rows - 1 && cellRegion[i + cols] === -1 && codes[i + cols] === codes[i]) {
        cellRegion[i + cols] = rid; stack.push(i + cols);
      }
    }
  }

  const regionBefore = regionInfo.length;
  if (regionBefore <= 1) {
    return {
      codes: codes.slice(),
      mergeCount: 0,
      regionBefore,
      regionAfter: regionBefore,
      deltaUsed: round2(threshold),
    };
  }

  // ---- 2~4. 并查集迭代合并 ----
  const parent = new Int32Array(regionInfo.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;

  const find = (x) => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    // 路径压缩
    while (parent[x] !== root) { const nx = parent[x]; parent[x] = root; x = nx; }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return false;
    parent[rb] = ra;
    return true;
  };

  // 预计算每个域的代表色
  const regionLab = regionInfo.map((info) => {
    if (!info.labN) return null;
    return { L: info.sumL / info.labN, a: info.sumA / info.labN, b: info.sumB / info.labN };
  });

  // 收集相邻域对（去重）
  const pairs = collectAdjacentPairs(cellRegion, cols, rows, regionInfo.length);

  let mergeCount = 0;
  let iter = 0;
  for (; iter < maxIter; iter++) {
    let changedThisIter = 0;
    for (let p = 0; p < pairs.length; p += 2) {
      const ra = find(pairs[p]);
      const rb = find(pairs[p + 1]);
      if (ra === rb) continue;
      const la = regionLab[ra];
      const lb = regionLab[rb];
      // 无 Lab 信息时不做合并（保守，避免误吞）
      if (!la || !lb) continue;
      if (deltaE(la, lb, method) < threshold) {
        if (union(ra, rb)) changedThisIter++;
      }
    }
    mergeCount += changedThisIter;
    if (changedThisIter === 0) break;
  }

  // ---- 5. 按合并后的簇重写色号 ----
  // 簇内取「格子数最多」的色号；平票时取首次出现序更靠前的，保证结果稳定可复现。
  const clusterInfo = new Map(); // root → { tally:Map, firstOrder:number }
  const firstOrder = new Map(); // code → 首次出现序号

  for (let i = 0; i < total; i++) {
    const code = codes[i];
    if (!code) continue;
    if (!firstOrder.has(code)) firstOrder.set(code, i);
    const rid = cellRegion[i];
    if (rid < 0) continue;
    const root = find(rid);
    if (!clusterInfo.has(root)) clusterInfo.set(root, { tally: new Map() });
    clusterInfo.get(root).tally.set(code, (clusterInfo.get(root).tally.get(code) || 0) + 1);
  }

  const clusterCode = new Map();
  for (const [root, { tally }] of clusterInfo) {
    let best = null;
    let bestCount = -1;
    for (const [code, count] of tally) {
      if (count > bestCount) {
        bestCount = count;
        best = code;
      } else if (count === bestCount && firstOrder.has(code) && firstOrder.has(best)) {
        if (firstOrder.get(code) < firstOrder.get(best)) best = code;
      }
    }
    clusterCode.set(root, best);
  }

  const out = new Array(total).fill('');
  for (let i = 0; i < total; i++) {
    if (!codes[i]) continue;
    const rid = cellRegion[i];
    if (rid < 0) continue;
    out[i] = clusterCode.get(find(rid)) || codes[i];
  }

  return {
    codes: out,
    mergeCount,
    regionBefore,
    regionAfter: clusterInfo.size,
    deltaUsed: round2(threshold),
  };
}

/**
 * 收集所有「相邻且属于不同初始域」的域对，以扁平数组 [a,b,a,b,...] 返回。
 */
function collectAdjacentPairs(cellRegion, cols, rows, regionCount) {
  const seen = new Set();
  const pairs = [];

  const tryPair = (a, b) => {
    if (a < 0 || b < 0 || a === b) return;
    const key = a < b ? a * regionCount + b : b * regionCount + a;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push(a, b);
  };

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const rid = cellRegion[i];
      if (rid < 0) continue;
      // 只看右、下两方向，保证每条边只处理一次
      if (x < cols - 1) tryPair(rid, cellRegion[i + 1]);
      if (y < rows - 1) tryPair(rid, cellRegion[i + cols]);
    }
  }
  return pairs;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

module.exports = {
  mergeSimilar,
  collectAdjacentPairs,
};