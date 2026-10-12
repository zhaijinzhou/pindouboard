/**
 * core/isolated.js —— 孤立块检测（文档 §2.1「孤立块检测」/ §4.1 `detectIsolated`）
 *
 * 四邻域遍历，标记孤立单格供体检提示。
 *
 * 判定规则：
 *   一格为「孤立格」当且仅当 —— 它存在至少 2 个有效邻居，
 *   且这些有效邻居的颜色全部与它不同（即它是一个被异色完全包围的孤立点）。
 *
 * 为何不用「异色邻居数 ≥ N」这种固定阈值：
 *   贴边格天然邻居更少（角落仅 2 个、边缘 3 个），固定阈值会让所有贴边格
 *   永远无法被判为孤立，产生「边缘检测不到碎片」的系统性盲区。
 *   采用「全部有效邻居均为异色」的比例型规则，边界与内部行为一致。
 *
 * 为何这值得提示：
 *   拼豆是实体拼接，一个孤立格在图纸上容易漏拼、或被误认为噪点删掉；
 *   大量孤立格通常意味着取色阶段参数不合适（格数过大 / 噪点 / 原图分辨率不足）。
 */

const { ISOLATED } = require('../utils/config');

/**
 * @param {string[]} codes 色号矩阵
 * @param {number} cols
 * @param {number} rows
 * @returns {{ isolated, count, ratio, groups }}
 *   isolated: number[]  孤立格的线性索引
 *   groups:   Array<{ x, y, code, isolatedCount, neighborCodes }>
 *              把相邻的孤立格聚成「碎片簇」，便于提示「右上角有 3 格碎片」
 */
function detectIsolated(codes, cols, rows, options = {}) {
  const total = cols * rows;

  const isolated = [];
  const isIsolated = new Uint8Array(total);

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const code = codes[i];
      if (!code) continue; // 空/背景格不参与孤立判定

      // 4 邻域。注意：越界不计入「异色邻居」——
      // 若把越界当作异色，则所有贴边格都会被误判为孤立（角落格天然只有 2 个邻居）。
      let diffCount = 0;
      let neighborCount = 0;

      const check = (j) => {
        neighborCount++;
        if (codes[j] !== code) diffCount++;
      };

      if (x > 0) check(i - 1);
      if (x < cols - 1) check(i + 1);
      if (y > 0) check(i - cols);
      if (y < rows - 1) check(i + cols);

      // 至少 2 个有效邻居，且全部异色
      if (neighborCount >= 2 && diffCount === neighborCount) {
        isolated.push(i);
        isIsolated[i] = 1;
      }
    }
  }

  // ---- 把相邻的孤立格聚成碎片簇 ----
  const groups = [];
  const seen = new Uint8Array(total);
  const stack = [];

  for (const start of isolated) {
    if (seen[start]) continue;
    const cluster = [];
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;

    while (stack.length) {
      const i = stack.pop();
      cluster.push(i);
      const x = i % cols;
      const y = (i - x) / cols;
      const visit = (j) => {
        if (j < 0 || j >= total || seen[j] || !isIsolated[j]) return;
        seen[j] = 1;
        stack.push(j);
      };
      if (x > 0) visit(i - 1);
      if (x < cols - 1) visit(i + 1);
      if (y > 0) visit(i - cols);
      if (y < rows - 1) visit(i + cols);
    }

    const cx = cluster[0] % cols;
    const cy = (cluster[0] - cx) / cols;
    groups.push({
      x: cx,
      y: cy,
      code: codes[cluster[0]],
      isolatedCount: cluster.length,
      // 碎片簇的合并包围盒，供 UI 高亮
      box: boundingBox(cluster, cols),
    });
  }

  groups.sort((a, b) => b.isolatedCount - a.isolatedCount);

  return {
    isolated,
    count: isolated.length,
    ratio: total ? isolated.length / total : 0,
    groups,
    isIsolated,
  };
}

function boundingBox(cluster, cols) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const i of cluster) {
    const x = i % cols;
    const y = (i - x) / cols;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

module.exports = {
  detectIsolated,
};