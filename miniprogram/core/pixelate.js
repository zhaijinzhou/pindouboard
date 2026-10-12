/**
 * core/pixelate.js —— 像素化（文档 §2.1「像素化」/ §4.1 `pixelate`）
 *
 * 契约：
 *   输入：原图 + 目标格数
 *   输出：格点阵（RGB 数组）
 *
 * 「格点阵」(grid) 数据结构（本文档全局约定）：
 *   {
 *     cols, rows,          格点阵维度
 *     cells: [{ r, g, b, empty? }]  长度 = cols * rows，行优先
 *     sourceWidth, sourceHeight,    原图尺寸
 *   }
 *
 * 纯逻辑层：不做任何 Canvas 操作，只吃像素数组。
 * Canvas 采样由 render/canvas.js 负责，两者解耦便于单测。
 */

/**
 * 从像素缓冲区执行像素化。
 *
 * @param {{width:number, height:number, data:Uint8ClampedArray|number[]}} imageData
 *        RGBA 顺序的像素数据
 * @param {number} targetCols  目标列数
 * @param {number} targetRows  目标行数
 * @returns {object} 格点阵
 */
function pixelate(imageData, targetCols, targetRows) {
  const sw = imageData.width;
  const sh = imageData.height;
  const data = imageData.data;

  const cols = Math.max(1, Math.round(targetCols));
  const rows = Math.max(1, Math.round(targetRows));

  const cells = new Array(cols * rows);

  for (let ty = 0; ty < rows; ty++) {
    // 该行对应的原图纵向范围
    const y0 = Math.floor((ty * sh) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * sh) / rows));

    for (let tx = 0; tx < cols; tx++) {
      const x0 = Math.floor((tx * sw) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * sw) / cols));

      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        let idx = (y * sw + x0) * 4;
        for (let x = x0; x < x1; x++) {
          r += data[idx];
          g += data[idx + 1];
          b += data[idx + 2];
          n++;
          idx += 4;
        }
      }

      cells[ty * cols + tx] = {
        r: n ? Math.round(r / n) : 0,
        g: n ? Math.round(g / n) : 0,
        b: n ? Math.round(b / n) : 0,
      };
    }
  }

  return { cols, rows, cells, sourceWidth: sw, sourceHeight: sh };
}

/**
 * 按目标长宽比与格数预算推导实际格点阵维度。
 *
 * 【关键：必须保持原图宽高比，否则图像会被拉伸变形】
 *   以横向 boardCount 块板推导列数 cols，行数再按 srcH/srcW 等比推导。
 *   注意行数**不**向上取整到整板 —— 若强行补齐成 boardRows*g，
 *   像素化时每个源像素会被映射到非正方形区域，导致图像纵向拉伸。
 *   正确做法是行数按比例取整，多出来的板面留空（真实拼豆板本来就是方的）。
 *
 * @param {number} srcW 原图宽
 * @param {number} srcH 原图高
 * @param {number} gridSize 单板格数（16/29/52/自定义）
 * @param {number} boardCount 横向板数
 * @returns {{cols, rows, boardCols, boardRows, ratio, usedBoards}}
 */
function deriveGrid(srcW, srcH, gridSize, boardCount) {
  const g = Math.max(1, gridSize);
  const boards = Math.max(1, boardCount);

  const boardCols = boards;

  // 横向：boardCount 块板 → boardCols * gridSize
  const cols = boardCols * g;

  // 等比推导行数（保持宽高比，避免变形）
  const ratio = srcH / srcW;
  const rows = Math.max(1, Math.round(cols * ratio));

  // 实际占用板数 = 横向板数 × 纵向所需板数
  const boardRows = Math.max(1, Math.ceil(rows / g));

  return {
    cols,
    rows,
    boardCols,
    boardRows,
    ratio: Number(ratio.toFixed(4)),
    usedBoards: boardCols * boardRows,
  };
}

/**
 * 按锁定比例求「居中最大裁剪框」的归一化坐标。
 *
 * 用途：图片刚选入、裁剪框尚未渲染时，先算出初始取景区域，
 * 让 session 一次就建立在正确的裁剪上，避免「先按整图建、组件再纠正」
 * 的重复读像素。
 *
 * ⚠️ 必须与 components/crop-frame 的 applyRatio 保持一致，
 *    包括 FREE_MARGIN 内缩：两边算出不同结果会导致
 *    「框的位置和实际出图区域对不上」。
 *    FREE_MARGIN 的作用是让选框四周都有可拖动余量，
 *    铺满时 clamp 区间会退化为 0，框就被焊死在边缘。
 *
 * 与 crop-frame 是同一套算法（居中、取最大面积、内缩余量）。
 * 放在 core 是因为它是纯计算，可单测。
 *
 * @param {number} srcW 原图宽
 * @param {number} srcH 原图高
 * @param {number} ratio 宽/高；<= 0 表示自由（返回整图）
 * @returns {{x, y, w, h}} 归一化裁剪区域
 */
function centerCropRatio(srcW, srcH, ratio) {
  // 与 crop-frame.js 的 FREE_MARGIN 保持一致
  const FREE_MARGIN = 0.06;

  if (!ratio || ratio <= 0) {
    // 自由比例：铺满但留出内缩余量
    return {
      x: round4(FREE_MARGIN),
      y: round4(FREE_MARGIN),
      w: round4(1 - FREE_MARGIN * 2),
      h: round4(1 - FREE_MARGIN * 2),
    };
  }

  /*
   * 内缩余量，保证选框四周都可拖动（与 crop-frame 一致）。
   *
   * ⚠️ 内缩**必须保持裁剪区自身形状**：不能简单地 w-=2m; h-=2m，
   *    那样 1:1 会被拉成非正方形（实测 0.68×0.88），
   *    导致「选了 1:1 单板，出图却不是方的」。
   *    正确做法：按比例**等比缩放**（w/h 比值不变），再居中放置。
   *
   * 注意：`ratio` 是**目标裁剪区**的宽高比。
   * 由于原图未必是目标比例，裁剪区要同时满足两个约束：
   *   ① 形状 = ratio（如 1:1 必须是正方形）
   *   ② 不超出原图可见范围（否则会把画面外的内容算进出图）
   * 因此先算出「最大可容纳的 ratio 形状框」，再按可用余量等比缩小。
   */
  const imgRatio = srcW / srcH;
  const availW = 1 - FREE_MARGIN * 2;
  const availH = 1 - FREE_MARGIN * 2;

  // 先按原图能容纳的最大 ratio 形状框（此时形状恰为 ratio）
  let w, h;
  if (imgRatio > ratio) { h = 1; w = ratio / imgRatio; }
  else { w = 1; h = imgRatio / ratio; }

  // 再等比缩到 availW×availH 以内（保持形状不变，仅四周留出余量）
  const fit = Math.min(availW / w, availH / h);
  w *= fit;
  h *= fit;

  return {
    x: round4((1 - w) / 2),
    y: round4((1 - h) / 2),
    w: round4(w),
    h: round4(h),
  };
}

/** 归一化裁剪区域是否近似相等（用于跳过无意义的重复读像素） */
function cropEquals(a, b, eps = 0.001) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) < eps
    && Math.abs(a.y - b.y) < eps
    && Math.abs(a.w - b.w) < eps
    && Math.abs(a.h - b.h) < eps;
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

/**
 * 噪点风险预检（文档 M1 职责 / S-02）。
 *
 * 逻辑：原图短边像素数越少，被压缩到 N 格后每格覆盖的像素越少，
 * 噪点和压缩伪影会被放大成整格的错误取色。
 * 经验阈值：短边像素 / 目标总格数 < 3 时风险显著。
 *
 * @returns {{ level:'ok'|'warn'|'danger', message, ratio, pixelsPerCell }}
 */
function checkNoiseRisk(srcW, srcH, gridSize, boardCount) {
  const info = deriveGrid(srcW, srcH, gridSize, boardCount);
  const totalCells = info.cols * info.rows;
  const shortEdge = Math.min(srcW, srcH);
  const pixelsPerCell = (srcW * srcH) / totalCells;

  let level = 'ok';
  let message = '';

  if (shortEdge < 120) {
    level = 'danger';
    message = `原图分辨率过低（${shortEdge}px），放大后必然模糊失真，建议更换高清图。`;
  } else if (pixelsPerCell < 3) {
    level = 'warn';
    message = `每格仅对应约 ${pixelsPerCell.toFixed(1)} 个原图像素，噪点可能被放大为整格杂色，建议减小格数或更换更清晰的图片。`;
  } else if (pixelsPerCell < 8) {
    level = 'warn';
    message = `每格对应约 ${pixelsPerCell.toFixed(1)} 个原图像素，细小细节可能丢失，可尝试关闭「图片增强」。`;
  }

  return { level, message, ratio: info.ratio, pixelsPerCell: Number(pixelsPerCell.toFixed(2)) };
}

module.exports = {
  pixelate,
  deriveGrid,
  checkNoiseRisk,
  centerCropRatio,
  cropEquals,
};