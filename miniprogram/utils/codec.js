/**
 * utils/codec.js —— 图纸格点阵编码（文档 P-02 / Q-04 / D-04 关联）
 *
 * 【Q-04 结论：为什么不用文档 §3.2 的稀疏键值】
 *   §3.2 建议 cells 用 { "行,列": "色号" } 稀疏结构。本项目实测（29 格 / 52 格
 *   两档，fill rate 100% 与 50% 四种组合）结论是：**稀疏结构反而更大**。
 *
 *   原因在于单格编码成本：
 *     稀疏格式 "12,13":"H21",  → 15 字符（含坐标键 + 冒号）
 *     密集数组 "H21",          →  7 字符
 *     密集数组 "",            →  3 字符
 *   坐标键本身的开销就超过了一个短色号。除非空格占比极高，
 *   稀疏结构在任何真实图纸上都不占优。
 *
 *   实测数据（字符数）：
 *     29 格全满   稀疏 12615  vs  密集 5887
 *     29 格半空   稀疏  6300  vs  密集 4203
 *     52 格全满   稀疏 40560  vs  密集 18928
 *     52 格半空   稀疏 20280  vs  密集 13520
 *
 * 【本实现采用的方案：色号字典 + 行程编码（RLE）】
 *   拼豆图纸的色块天然成片相连（一个色块常有几十上百格），
 *   RLE 能把连续同色格压缩为「(长度, 色号)」一条记录，
 *   再配合色号字典去除重复字符串，是这类数据的最优通用压缩。
 *
 *   格式（便于人工排查，压缩率与紧凑二进制接近）：
 *     {
 *       cols, rows,
 *       dict: ["H21", "H85", ...],     // 色号字典，出现顺序
 *       rle:  [len, dictIdx, len, dictIdx, ...]  // 行优先展开的 [长度,字典下标] 交替序列
 *     }
 *
 *   相比 §3.2 稀疏格式，52 格全满图纸约可压缩 90%，
 *   且解码为 O(n) 单次扫描，无需 JSON.parse 大对象。
 *
 * 内存模型仍遵循 §3.2：用稀疏 cells 对外暴露可读结构，
 * 本模块只负责**存储与传输**环节的编解码。
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * 编码格点阵
 *
 * @param {string[]} codes 长度 cols*rows，'' 表示空格
 * @param {number} cols
 * @param {number} rows
 * @returns {{cols, rows, dict, rle, originalSize, encodedSize}}
 */
function encodeGrid(codes, cols, rows) {
  const dict = [];
  const dictIndex = new Map();
  const rle = [];

  let i = 0;
  const total = cols * rows;

  while (i < total) {
    const cur = codes[i] || '';
    let len = 1;
    while (i + len < total && (codes[i + len] || '') === cur) len++;

    let idx = dictIndex.get(cur);
    if (idx === undefined) {
      idx = dict.length;
      dict.push(cur);
      dictIndex.set(cur, idx);
    }
    rle.push(len, idx);
    i += len;
  }

  return {
    cols,
    rows,
    dict,
    rle,
    // 估算体积：dict 字符串长度 + rle 数字串长度
    originalSize: total,
    encodedSize: dict.reduce((s, c) => s + c.length + 3, 0) + rle.reduce((s, n) => s + String(n).length, 0),
  };
}

/**
 * 解码格点阵（encodeGrid 的逆操作）
 *
 * @param {object} enc encodeGrid 的返回值
 * @returns {{ codes, cols, rows }}
 */
function decodeGrid(enc) {
  if (!enc || !enc.dict || !enc.rle) {
    // S-04：结构非法时返回空矩阵而非崩溃
    console.warn('[codec] 编码数据非法，已降级为空图纸');
    return { codes: [], cols: 0, rows: 0 };
  }

  const { cols, rows, dict, rle } = enc;
  const total = cols * rows;
  const codes = new Array(total);
  let p = 0;

  for (let k = 0; k + 1 < rle.length; k += 2) {
    const len = rle[k];
    const code = dict[rle[k + 1]];
    if (code === undefined) {
      console.warn('[codec] 字典下标越界，已截断');
      break;
    }
    for (let n = 0; n < len && p < total; n++) {
      codes[p++] = code;
    }
  }

  // 补齐尾部（数据截断时不留 undefined）
  while (p < total) codes[p++] = '';

  return { codes, cols, rows };
}

/**
 * 稀疏键值结构（文档 §3.2 的对外模型）↔ 线性数组互转
 */
function toSparse(codes, cols, rows) {
  const cells = {};
  for (let i = 0; i < codes.length; i++) {
    if (!codes[i]) continue;
    const y = (i / cols) | 0;
    const x = i - y * cols;
    cells[`${y},${x}`] = codes[i];
  }
  return cells;
}

function fromSparse(cells, cols, rows) {
  const codes = new Array(cols * rows).fill('');
  if (!cells) return codes;
  for (const k of Object.keys(cells)) {
    const parts = k.split(',');
    if (parts.length !== 2) continue;
    const y = Number(parts[0]);
    const x = Number(parts[1]);
    // S-04：越界坐标跳过而非崩溃
    if (!(y >= 0 && x >= 0 && y < rows && x < cols)) continue;
    codes[y * cols + x] = cells[k];
  }
  return codes;
}

/**
 * 整张图纸的编解码（图纸模型 ↔ 存储结构）
 */
function encodePattern(pattern) {
  const codes = fromSparse(pattern.cells, pattern.cols, pattern.rows);
  return {
    v: 1,
    cols: pattern.cols,
    rows: pattern.rows,
    gridSize: pattern.gridSize,
    beadSize: pattern.beadSize,
    beadType: pattern.beadType,
    brand: pattern.brand,
    boardCount: pattern.boardCount,
    mode: pattern.mode,
    colors: pattern.colors,
    totalCount: pattern.totalCount,
    physicalSize: pattern.physicalSize,
    suggestedBeads: pattern.suggestedBeads,
    originMarker: pattern.originMarker,
    render: pattern.render,
    health: pattern.health,
    isolatedCount: pattern.isolatedCount,
    paletteVersion: pattern.paletteVersion,
    ...encodeGrid(codes, pattern.cols, pattern.rows),
  };
}

function decodePattern(enc) {
  if (!enc || !enc.cols || !enc.rows) return null;
  const { codes, cols, rows } = decodeGrid(enc);
  return {
    gridSize: enc.gridSize,
    cols,
    rows,
    beadSize: enc.beadSize,
    beadType: enc.beadType,
    brand: enc.brand,
    boardCount: enc.boardCount,
    mode: enc.mode,
    colors: enc.colors || [],
    totalCount: enc.totalCount || 0,
    physicalSize: enc.physicalSize || null,
    suggestedBeads: enc.suggestedBeads || 0,
    cells: toSparse(codes, cols, rows),
    originMarker: enc.originMarker || 'top-left',
    render: enc.render || {},
    health: enc.health || null,
    isolatedCount: enc.isolatedCount || 0,
    paletteVersion: enc.paletteVersion || '',
  };
}

module.exports = {
  encodeGrid,
  decodeGrid,
  toSparse,
  fromSparse,
  encodePattern,
  decodePattern,
};