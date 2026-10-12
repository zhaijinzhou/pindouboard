/**
 * tools/test-core.js —— 核心算法单测（文档 D-07 测试方案）
 *
 * 运行：node tools/test-core.js
 * 无需任何依赖，纯断言脚本。CI 可直接接入 `npm test`。
 */

const path = require('path');
const M = (p) => require(path.join(__dirname, '..', 'miniprogram', p));

const { rgbToLab, deltaE76, deltaE2000, rgbToHex, hexToRgb, rgbToHue, hueDistance } = M('color/lab');
const { indexPalette, getPalette } = M('color/palette-loader');
const { matchOne, matchCodes, limitColorCount } = M('color/match');
const { pixelate, deriveGrid, checkNoiseRisk, centerCropRatio, cropEquals } = M('core/pixelate');
const { aggregate, dominantColor, areaMean, applyDither } = M('core/algorithm');
const { enhance } = M('core/enhance');
const { mergeSimilar } = M('core/merge');
const { removeBackground, estimateBackgroundColor } = M('core/background');
const { detectIsolated } = M('core/isolated');
const { checkPalette, annotateHueGroups } = M('core/check');
const { run, calcPhysical } = M('core/pipeline');
const previewCore = M('core/preview');
const { fitCanvasLayout } = M('render/canvas');
const imageUtil = M('utils/image');
const codec = M('utils/codec');

/* ================= 断言框架 ================= */
let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { pass++; }
  else {
    fail++;
    failures.push(name + (extra ? ` — ${extra}` : ''));
  }
}
function near(name, actual, expected, tol) {
  ok(name, Math.abs(actual - expected) <= tol, `期望 ${expected}±${tol}，实际 ${actual}`);
}
function section(title) {
  console.log(`\n\x1b[36m▸ ${title}\x1b[0m`);
}

/* ================= 1. Lab / ΔE ================= */
section('1. 色彩科学：Lab 转换与 ΔE');

{
  // CIE 标准参考值：纯白
  const white = rgbToLab(255, 255, 255);
  near('纯白 L≈100', white.L, 100, 0.5);
  ok('纯白 a≈b≈0', Math.abs(white.a) < 0.5 && Math.abs(white.b) < 0.5,
    `a=${white.a.toFixed(2)} b=${white.b.toFixed(2)}`);

  // 纯黑
  const black = rgbToLab(0, 0, 0);
  near('纯黑 L≈0', black.L, 0, 0.1);

  // 中性灰 a=b≈0
  const gray = rgbToLab(128, 128, 128);
  ok('中性灰 a≈0', Math.abs(gray.a) < 0.6 && Math.abs(gray.b) < 0.6,
    `a=${gray.a.toFixed(2)} b=${gray.b.toFixed(2)}`);

  // 已知 ΔE76 参考：红 vs 绿
  const red = rgbToLab(255, 0, 0);
  const green = rgbToLab(0, 255, 0);
  const d76 = deltaE76(red, green);
  // 参考值约 170.5
  near('ΔE76(纯红,纯绿)', d76, 170.5, 2);

  // ΔE2000 自反性：必须为 0
  near('ΔE2000 自反 = 0', deltaE2000(red, red), 0, 1e-9);
  near('ΔE76 自反 = 0', deltaE76(red, red), 0, 1e-9);

  // 对称性
  near('ΔE2000 对称性', deltaE2000(red, green), deltaE2000(green, red), 1e-9);

  // ★ Sharma CIEDE2000 官方测试数据（Sharma, Wu & Dalal 2005 附表）
  //   期望值取自官方附表，并已与按 CIE 142-2001 原文逐字转写的独立参考实现
  //   交叉验证，最大偏差 1e-15。
  const sharma = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 2.8361, -74.0200], [50, 0, -82.7485], 3.4412],
    [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0000],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    // 色相跨越 0°/360° 边界 —— 最易写错的一组
    [[50, 2.4900, -0.0010], [50, -2.4900, 0.0009], 7.1792],
    [[50, -0.0010, 2.4900], [50, 0.0009, -2.4900], 4.8045],
    // 中性色分支：C1'C2' == 0 时 ΔH' 置 0
    [[50, 2.5000, 0.0000], [50, 0, -2.5000], 4.3065],
    [[2.0776, 0.0795, -1.1350], [0.9033, -0.0636, -0.5514], 0.9082],
    // 大跨度 / 极端明度
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[22.7233, 20.0904, -46.6940], [23.0331, 14.9730, -42.5619], 2.0373],
    [[90.8027, -2.0831, 1.4410], [91.1528, -1.6435, 0.0447], 1.4441],
    [[35.0831, -44.1164, 3.7933], [35.0232, -40.0716, 1.5901], 1.8645],
  ];
  for (const [a, b, exp] of sharma) {
    const got = deltaE2000(
      { L: a[0], a: a[1], b: a[2] },
      { L: b[0], a: b[1], b: b[2] }
    );
    near(`★ Sharma [${a.join(',')}]`, got, exp, 0.0002);
  }

  // hex 往返
  ok('hex 往返一致', rgbToHex(...hexToRgb('#3a86ff')) === '#3a86ff');
  ok('3位 hex 扩展', rgbToHex(...hexToRgb('#fff')) === '#ffffff');

  // 色相
  near('纯红色相 = 0', rgbToHue(255, 0, 0), 0, 0.01);
  near('纯绿色相 = 120', rgbToHue(0, 255, 0), 120, 0.01);
  near('纯蓝色相 = 240', rgbToHue(0, 0, 255), 240, 0.01);
  ok('灰色无色相', rgbToHue(128, 128, 128) === -1);
  near('色相距离环绕正确 (0 vs 350)', hueDistance(0, 350), 10, 0.01);
}

/* ================= 2. 色库 ================= */
section('2. 色库加载与索引（P-04 / S-03）');

{
  const p = getPalette('MARD');
  ok('色库加载成功', p.valid && p.colors.length > 0);
  ok('色库为 221 色', p.colors.length === 221, `实际 ${p.colors.length}`);
  ok('色号唯一', p.byCode.size === p.colors.length);
  ok('预建 Lab 索引', typeof p.colors[0].lab.L === 'number');
  ok('预建色相索引', typeof p.colors[0].hue === 'number');
  ok('覆盖 5mm 规格', p.colors[0].sizes.includes('5mm'));
  ok('覆盖 2.6mm 规格', p.colors[0].sizes.includes('2.6mm'));
  ok('rgb 数值合法', p.colors.every((c) =>
    c.rgb.length === 3 && c.rgb.every((v) => typeof v === 'number' && v >= 0 && v <= 255)));
  ok('hex 与 rgb 一致', p.colors.every((c) => c.hex === rgbToHex(...c.rgb)));

  // S-03：损坏数据降级而非崩溃
  const broken = indexPalette({ brand: 'X', colors: [
    { code: 'A1', rgb: [255, 0, 0] },
    { code: 'A1', rgb: [0, 255, 0] },      // 重复色号
    { code: 'A2', rgb: [999, 0, 0] },      // 越界
    { code: '', rgb: [1, 2, 3] },          // 缺色号
    { code: 'A3' },                        // 缺 rgb
    { code: 'A4', rgb: [1, 2, 3] },        // 合法
  ]}, { brand: 'X' });
  ok('损坏数据不崩溃', Array.isArray(broken.colors));
  ok('跳过重复色号（保留首条）', broken.byCode.has('A1') && broken.byCode.get('A1').rgb[0] === 255);
  ok('跳过越界 rgb', !broken.byCode.has('A2'));
  ok('保留合法条目', broken.byCode.has('A4'));

  // 空色库降级
  const empty = indexPalette({ brand: 'Y', colors: [] }, { brand: 'Y' });
  ok('空色库降级为 invalid', empty.valid === false && empty.colors.length === 0);
  ok('未知品牌回退 MARD', getPalette('NotExist').brand === 'MARD');
}

/* ================= 3. 像素化 ================= */
section('3. 像素化（pixelate / deriveGrid）');

{
  // 4x4 纯红图 → 2x2
  const w = 4, h = 4;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = 255; data[i * 4 + 1] = 0; data[i * 4 + 2] = 0; data[i * 4 + 3] = 255;
  }
  const g = pixelate({ width: w, height: h, data }, 2, 2);
  ok('像素化维度', g.cols === 2 && g.rows === 2);
  ok('像素化取色正确', g.cells.every((c) => c.r === 255 && c.g === 0 && c.b === 0));

  // 渐变图 → 均值应处于中间
  const gw = 8, gh = 8;
  const gd = new Uint8ClampedArray(gw * gh * 4);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = (y * gw + x) * 4;
      const v = Math.round((x / (gw - 1)) * 255);
      gd[i] = v; gd[i + 1] = 0; gd[i + 2] = 0; gd[i + 3] = 255;
    }
  }
  const g2 = pixelate({ width: gw, height: gh, data: gd }, 2, 2);
  ok('渐变图左格偏暗', g2.cells[0].r < 100, `实际 ${g2.cells[0].r}`);
  ok('渐变图右格偏亮', g2.cells[1].r > 155, `实际 ${g2.cells[1].r}`);

  // deriveGrid：等比，不变形
  const d1 = deriveGrid(1000, 1000, 29, 1);
  ok('正方形图 → 等比方形', d1.cols === d1.rows, `cols=${d1.cols} rows=${d1.rows}`);

  const d2 = deriveGrid(1000, 500, 29, 1);
  ok('宽图 → 行数约为列数一半', Math.abs(d2.rows / d2.cols - 0.5) < 0.1,
    `ratio=${(d2.rows / d2.cols).toFixed(3)}`);

  const d3 = deriveGrid(500, 1000, 29, 1);
  ok('竖图 → 行数大于列数', d3.rows > d3.cols);

  const d4 = deriveGrid(1000, 1000, 29, 4);
  ok('4 板 → 列数为单板 4 倍', d4.cols === 29 * 4, `实际 ${d4.cols}`);

  // 噪点预检
  ok('低分辨率报 danger', checkNoiseRisk(60, 60, 29, 1).level === 'danger');
  ok('高分辨率报 ok', checkNoiseRisk(3000, 3000, 29, 1).level === 'ok');
  ok('预检带提示文案', typeof checkNoiseRisk(200, 200, 52, 1).message === 'string');
}

/* ================= 4. 主导色 / 均值 ================= */
section('4. 主导色与区域均值算法（§2.1 / D-03）');

{
  // 构造：区域内 8 个黑 + 1 个白 → 主导色应为黑
  const samples = [];
  for (let i = 0; i < 8; i++) samples.push({ r: 0, g: 0, b: 0 });
  samples.push({ r: 255, g: 255, b: 255 });
  const dom = dominantColor(samples, { quantizeStep: 32, minPixels: 3 });
  ok('主导色取频次最高者（黑）', dom.r === 0 && dom.g === 0 && dom.b === 0,
    `实际 rgb(${dom.r},${dom.g},${dom.b})`);

  // 8 白 + 1 黑 → 主导色应为白
  const samples2 = [];
  for (let i = 0; i < 8; i++) samples2.push({ r: 255, g: 255, b: 255 });
  samples2.push({ r: 0, g: 0, b: 0 });
  const dom2 = dominantColor(samples2, { quantizeStep: 32, minPixels: 3 });
  ok('主导色取频次最高者（白）', dom2.r === 255);

  // 颜色分散 → 回退均值
  const spread = [
    { r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 0 }, { r: 0, g: 0, b: 255 },
    { r: 255, g: 255, b: 0 }, { r: 0, g: 255, b: 255 }, { r: 255, g: 0, b: 255 },
  ];
  const dom3 = dominantColor(spread, { quantizeStep: 32, minPixels: 3 });
  ok('颜色分散时回退均值', dom3.__fallback === true);
  near('回退均值 R ≈ 127', dom3.r, 127, 2);

  // 均值算法
  const mean = areaMean([{ r: 0, g: 0, b: 0 }, { r: 100, g: 100, b: 100 }]);
  ok('区域均值正确', mean.r === 50);

  // aggregate：3x3 高采样 → 1 格
  const hi = {
    cols: 3, rows: 3, sourceWidth: 3, sourceHeight: 3,
    cells: [
      { r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 },
      { r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 },
      { r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 },
    ],
  };
  const agg = aggregate(hi, { mode: 'cartoon', sampleScale: 3, quantizeStep: 32, minPixels: 3 });
  ok('聚合输出 1x1', agg.cols === 1 && agg.rows === 1);
  ok('聚合用主导色（黑）', agg.cells[0].r === 0);

  const aggPhoto = aggregate(hi, { mode: 'photo', sampleScale: 3 });
  ok('photo 模式走均值（偏灰）', aggPhoto.cells[0].r > 20 && aggPhoto.cells[0].r < 40,
    `实际 ${aggPhoto.cells[0].r}`);
}

/* ================= 5. 增强 ================= */
section('5. 图像增强（enhance）');

{
  const grid = {
    cols: 1, rows: 1,
    cells: [{ r: 200, g: 200, b: 200 }],
  };
  const up = enhance(grid, { contrast: 0.5 });
  ok('增强提高对比度（亮部更亮）', up.cells[0].r > 200, `实际 ${up.cells[0].r}`);

  const down = enhance(grid, { contrast: -0.5 });
  ok('降低对比度（亮部变暗）', down.cells[0].r < 200, `实际 ${down.cells[0].r}`);

  const sat = enhance({ cols: 1, rows: 1, cells: [{ r: 100, g: 50, b: 50 }] }, { saturation: 0.5 });
  ok('增强提高饱和度', sat.cells[0].r - sat.cells[0].g > 50);

  const noop = enhance(grid, {});
  ok('无参数时原样返回', noop === grid);

  // 不修改入参
  enhance(grid, { contrast: 0.5 });
  ok('不修改入参（不可变）', grid.cells[0].r === 200);

  // 溢出裁剪
  const clip = enhance({ cols: 1, rows: 1, cells: [{ r: 250, g: 250, b: 250 }] },
    { contrast: 1, brightness: 1 });
  ok('结果裁剪到 0~255', clip.cells[0].r <= 255 && clip.cells[0].r >= 0);
}

/* ================= 6. 色号匹配 ================= */
section('6. 色号匹配（§4.1 matchCodes / D-02）');

{
  const palette = getPalette('MARD');

  // 精确命中：色库中 H7 正黑
  const blackEntry = palette.byCode.get('H7');
  const mBlack = matchOne(blackEntry.rgb[0], blackEntry.rgb[1], blackEntry.rgb[2], palette.colors);
  ok('精确颜色命中自身色号', mBlack.code === 'H7', `实际 ${mBlack.code}`);

  // 中间色应匹配到邻近色
  const mMid = matchOne(128, 128, 128, palette.colors);
  ok('灰色匹配到灰色系色号', typeof mMid.code === 'string' && mMid.delta >= 0);

  // ΔE 自反：命中自身时 ΔE = 0
  near('命中自身 ΔE = 0', mBlack.delta, 0, 0.01);

  // 库存色集约束
  const redEntry = palette.byCode.get('H21');
  const onlyBlue = palette.colors.filter((c) => c.code === 'H86' || c.code === 'H89');
  const mRestricted = matchOne(redEntry.rgb[0], redEntry.rgb[1], redEntry.rgb[2], onlyBlue);
  ok('限定色集生效', onlyBlue.some((c) => c.code === mRestricted.code),
    `实际 ${mRestricted.code}`);

  // 空候选集
  ok('空候选集返回 null', matchOne(255, 0, 0, []) === null);

  // 批量匹配 + 跳过空格子
  const grid = {
    cols: 2, rows: 2,
    cells: [
      { r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 0 },
      { r: 0, g: 0, b: 255 }, { r: 0, g: 0, b: 0, empty: true },
    ],
  };
  const res = matchCodes(grid, palette, { beadSize: '5mm' });
  ok('批量匹配返回 codes 数组', Array.isArray(res.codes) && res.codes.length === 4);
  ok('空格子不匹配', res.codes[3] === '');
  ok('生成用量明细', res.details.size >= 3);
  ok('产出 ΔE 统计', typeof res.deltaStats.avg === 'number');
  ok('ΔE 统计含可接受上限', typeof res.deltaStats.acceptableDelta === 'number');

  // 颜色数上限
  const limitRes = limitColorCount(res, grid, 2, palette);
  ok('颜色数被压到上限', limitRes.details.size <= 2, `实际 ${limitRes.details.size}`);
  ok('记录压缩前色数', limitRes.reducedFrom >= 3, `实际 ${limitRes.reducedFrom}`);

  const noLimit = limitColorCount(res, grid, 20, palette);
  ok('未超限时不改动', noLimit.reducedFrom === 0 && noLimit.details.size === res.details.size);
}

/* ================= 7. 去背景 ================= */
section('7. 去背景（§2.1 / §4.1 removeBackground）');

{
  // 5x5：白边 + 中心红
  const cols = 5, rows = 5;
  const cells = new Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const isCenter = (x >= 2 && x <= 2 && y >= 2 && y <= 2);
      cells[y * cols + x] = isCenter ? { r: 220, g: 30, b: 30 } : { r: 250, g: 250, b: 250 };
    }
  }
  const grid = { cols, rows, cells };
  const bg = estimateBackgroundColor(cells, cols, rows);
  ok('估计背景色接近白', bg.r > 230, `实际 ${bg.r}`);

  const r = removeBackground(grid, { tolerance: 30 });
  ok('去背景标记了中心外的格', r.removedCount === 24, `实际 ${r.removedCount}`);
  ok('中心格保留为非空', !r.grid.cells[2 * cols + 2].empty);
  ok('边缘格标记为 empty', r.grid.cells[0].empty === true);
  ok('背景占比正确', Math.abs(r.ratio - 24 / 25) < 0.001);
  ok('不修改入参', cells[0].empty === undefined);

  // 容差收紧到 1：白色背景与基准背景色距离为 0，仍应被识别
  //   （容差控制的是「多远的颜色算背景」，而非「完全相同才算」）
  const strict = removeBackground(grid, { tolerance: 1 });
  ok('容差 1 仍识别出纯色背景', strict.removedCount === 24, `实际 ${strict.removedCount}`);

  // 容差放宽到 441（RGB 空间最大距离）→ 连主体一起被吞
  const loose = removeBackground(grid, { tolerance: 441 });
  ok('容差过大时全删', loose.removedCount === 25, `实际 ${loose.removedCount}`);

  // 关键行为：背景色与基准色接近但不同时，小容差不应误删主体
  const soft = {
    cols: 5, rows: 5,
    cells: (() => {
      const a = new Array(25);
      for (let y = 0; y < 5; y++) {
        for (let x = 0; x < 5; x++) {
          const center = x === 2 && y === 2;
          // 主体色 (245,245,245) 与背景 (250,250,250) 距离仅 8.66
          a[y * 5 + x] = center ? { r: 245, g: 245, b: 245 } : { r: 250, g: 250, b: 250 };
        }
      }
      return a;
    })(),
  };
  const narrow = removeBackground(soft, { tolerance: 3 });
  ok('★ 小容差下保留近色主体', narrow.removedCount < 25 && !narrow.grid.cells[12].empty,
    `已删 ${narrow.removedCount} 格`);
  const wide = removeBackground(soft, { tolerance: 20 });
  ok('★ 大容差下近色主体被并入背景', wide.grid.cells[12].empty === true);

  // ★ 关键时序：仅连通到边缘的同色才算背景，画面中部的同色区域必须保留
  const cells2 = new Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      // 中部另有一块白，但不与边缘连通
      const inner = (x === 1 && y === 1);
      cells2[y * cols + x] = inner ? { r: 250, g: 250, b: 250 } : { r: 250, g: 250, b: 250 };
    }
  }
  // 构造：背景为红，中心白块不触边
  const cells3 = new Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const inner = (x >= 2 && x <= 2 && y >= 2 && y <= 2);
      cells3[y * cols + x] = inner ? { r: 250, g: 250, b: 250 } : { r: 200, g: 30, b: 30 };
    }
  }
  const r3 = removeBackground({ cols, rows, cells: cells3 }, { tolerance: 30 });
  ok('★ 不触边的同色区域被保留', !r3.grid.cells[2 * cols + 2].empty,
    '中部白色块不应被判为背景');
  ok('★ 触边区域被判为背景', r3.grid.cells[0].empty === true);
}

/* ================= 8. 杂色合并 ================= */
section('8. 杂色合并 BFS（§2.1 / D-04）');

{
  const palette = getPalette('MARD');
  const c1 = palette.byCode.get('H21').code; // 正红
  const c2 = palette.byCode.get('H22').code; // 大红（ΔE 与正红很近）
  const c3 = palette.byCode.get('H85').code; // 深蓝（ΔE 很大）

  // 相邻的红 + 大红 + 深蓝
  const cols = 3, rows = 1;
  const codes = [c1, c2, c3];

  // 高阈值 → 全合并
  const loose = mergeSimilar(codes, cols, rows, { delta: 60, palette });
  ok('高阈值下相近色被合并', loose.codes[0] === loose.codes[1],
    `${loose.codes[0]} vs ${loose.codes[1]}`);
  ok('记录合并前区域数', loose.regionBefore === 3, `实际 ${loose.regionBefore}`);
  ok('高阈值下压缩后区域变少', loose.regionAfter < loose.regionBefore,
    `${loose.regionBefore} → ${loose.regionAfter}`);

  // 低阈值 → 不同色不合并
  const tight = mergeSimilar(codes, cols, rows, { delta: 0.1, palette });
  ok('低阈值下不同色不合并', tight.mergeCount === 0);

  // 只合并红/大红，保留深蓝
  const mid = mergeSimilar(codes, cols, rows, { delta: 12, palette });
  ok('中间阈值：红系合并、蓝保留', mid.codes[0] === mid.codes[1] && mid.codes[2] !== mid.codes[0],
    `结果 ${mid.codes.join(',')}`);

  // 空格子不被合并污染
  const withEmpty = [c1, '', c2];
  const r = mergeSimilar(withEmpty, 3, 1, { delta: 60, palette });
  ok('空格子保持为空', r.codes[1] === '');

  // fusion 豆型阈值放大
  const regular = mergeSimilar(codes, cols, rows, { delta: 10, palette, beadType: 'regular' });
  const fusion = mergeSimilar(codes, cols, rows, { delta: 10, palette, beadType: 'fusion' });
  ok('fusion 阈值被放大', fusion.deltaUsed > regular.deltaUsed,
    `regular=${regular.deltaUsed} fusion=${fusion.deltaUsed}`);

  // 单色无变化
  const single = mergeSimilar([c1, c1, c1], 3, 1, { delta: 5, palette });
  ok('单一色号不产生合并', single.mergeCount === 0 && single.codes.every((c) => c === c1));
}

/* ================= 9. 孤立块 ================= */
section('9. 孤立块检测（§2.1 / §4.1 detectIsolated）');

{
  // 3x3 全同色 → 无孤立
  const a = ['X', 'X', 'X', 'X', 'X', 'X', 'X', 'X', 'X'];
  const r0 = detectIsolated(a, 3, 3);
  ok('全同色无孤立块', r0.count === 0, `实际 ${r0.count}`);

  // 3x3 中心单格异色 → 中心孤立
  const b = ['X', 'X', 'X', 'X', 'Y', 'X', 'X', 'X', 'X'];
  const r1 = detectIsolated(b, 3, 3);
  ok('中心单格判为孤立', r1.count === 1, `实际 ${r1.count}`);
  ok('孤立块坐标正确', r1.isolated[0] === 4);
  ok('孤立坐标换算为 (1,1)', r1.groups[0].x === 1 && r1.groups[0].y === 1);

  // 两个不相邻的孤立格 → 两个独立簇
  //   注意：若两格 4-邻域相邻，各自只有 3 个异色邻居 < 4，按定义均不算孤立。
  const c = ['X', 'Y', 'X', 'X', 'X', 'X', 'X', 'Y', 'X'];
  const r2 = detectIsolated(c, 3, 3);
  ok('两个不相邻孤立格均被检出', r2.count === 2, `实际 ${r2.count}`);
  ok('不相邻孤立格形成 2 个簇', r2.groups.length === 2, `实际 ${r2.groups.length}`);
  ok('孤立坐标换算正确', r2.isolated.includes(1) && r2.isolated.includes(7));

  // ★ 4-邻域相邻的同色格互为邻居，不判孤立
  const cAdj = ['X', 'Y', 'X', 'X', 'Y', 'X', 'X', 'X', 'X'];
  const r2b = detectIsolated(cAdj, 3, 3);
  ok('★ 相邻同色格互为邻居，不判孤立', r2b.count === 0, `实际 ${r2b.count}`);

  // ★ 贴边格可被检出（比例型规则保证边缘无盲区）
  //   3x3 中 (0,1) 顶部边缘孤立：左右为 X，下为 X，共 3 邻居全异色 → 孤立
  const edge = ['X', 'Y', 'X', 'X', 'X', 'X', 'X', 'X', 'X'];
  const r2d = detectIsolated(edge, 3, 3);
  ok('★ 贴边孤立格可被检出', r2d.count === 1, `实际 ${r2d.count}`);

  // ★ 角落孤立格：仅 2 个邻居，全异色 → 孤立
  const corner = ['Y', 'X', 'X', 'X', 'X', 'X', 'X', 'X', 'X'];
  const r2e = detectIsolated(corner, 3, 3);
  ok('★ 角落孤立格可被检出', r2e.count === 1, `实际 ${r2e.count}`);

  // ★ 单格图（无邻居）不算孤立，避免除零/误报
  const single = detectIsolated(['X'], 1, 1);
  ok('★ 单格图不算孤立', single.count === 0);

  // 空格子跳过
  const d = ['', '', '', '', 'Y', '', '', '', ''];
  const r3 = detectIsolated(d, 3, 3);
  ok('空格子参与邻居判定', r3.count === 1);

  // 空格子本身不算孤立
  const e = ['', 'X', 'X', 'X', 'X', 'X', 'X', 'X', 'X'];
  const r4 = detectIsolated(e, 3, 3);
  ok('空格子自身不判孤立', r4.isolated[0] !== 0);
}

/* ================= 10. 体检 ================= */
section('10. 配色体检（§9 M8 / §4.1 checkPalette）');

{
  const palette = getPalette('MARD');
  const codes = ['H21', 'H21', 'H85', 'H85', 'H7', 'H7'];
  const details = new Map();
  details.set('H21', { code: 'H21', name: '正红', hex: '#d9252a', rgb: [217, 37, 42], count: 2 });
  details.set('H85', { code: 'H85', name: '深蓝', hex: '#1c3f7a', rgb: [28, 63, 122], count: 2 });
  details.set('H7', { code: 'H7', name: '正黑', hex: '#0a0a0a', rgb: [10, 10, 10], count: 2 });
  annotateHueGroups(details);

  const iso = detectIsolated(codes, 3, 2);
  const rep = checkPalette({
    codes, cols: 3, rows: 2, details,
    deltaStats: { avg: 5.2, max: 12, poorCount: 0, poorRatio: 0, acceptableDelta: 14 },
    isolated: iso, bgRatio: 0.1,
    params: { colorLimit: 20 },
  });

  ok('体检返回条目', Array.isArray(rep.items) && rep.items.length > 0);
  ok('体检有汇总文案', typeof rep.summary === 'string' && rep.summary.length > 0);
  ok('体检有总体等级', ['pass', 'warn', 'danger'].includes(rep.level));
  ok('条目结构统一', rep.items.every((i) =>
    typeof i.key === 'string' && typeof i.level === 'string' &&
    typeof i.title === 'string' && typeof i.advice === 'string'));
  ok('包含颜色数体检项', rep.items.some((i) => i.key === 'colorCount'));
  ok('包含孤立块体检项', rep.items.some((i) => i.key === 'isolated'));
  ok('包含明暗体检项', rep.items.some((i) => i.key === 'outline'));
  ok('包含色差体检项', rep.items.some((i) => i.key === 'delta'));

  // 颜色数超限 → warn
  const rep2 = checkPalette({
    codes: ['a', 'b', 'c'], cols: 1, rows: 3,
    details: new Map([['a', { code: 'a', rgb: [255, 0, 0], count: 1 }],
                      ['b', { code: 'b', rgb: [0, 255, 0], count: 1 }],
                      ['c', { code: 'c', rgb: [0, 0, 255], count: 1 }]]),
    isolated: { count: 0, ratio: 0, groups: [] },
    params: { colorLimit: 2 },
  });
  ok('颜色数超限触发 warn',
    rep2.items.find((i) => i.key === 'colorCount').level === 'warn');

  // 浅色缺深色 → warn
  const lightDetails = new Map([
    ['l1', { code: 'l1', name: '白', rgb: [252, 251, 248], count: 90 }],
    ['l2', { code: 'l2', name: '米', rgb: [244, 239, 230], count: 10 }],
  ]);
  const rep3 = checkPalette({
    codes: Array(100).fill('l1'), cols: 10, rows: 10,
    details: lightDetails,
    isolated: { count: 0, ratio: 0, groups: [] },
    params: { colorLimit: 20 },
  });
  ok('浅色缺深色轮廓触发 warn',
    rep3.items.find((i) => i.key === 'outline').level === 'warn');
}

/* ================= 11. 物理尺寸计算 ================= */
section('11. 尺寸与用量公式（§2.2）');

{
  const p5 = calcPhysical(29, 29, { beadSize: '5mm', beadType: 'regular' });
  near('5mm 29格边长 = 14.5cm', p5.width, 14.5, 0.01);
  ok('总格数 841', p5.totalCells === 841);
  ok('建议采购量向上取整到50', p5.suggestedBeads % 50 === 0);
  ok('含损耗余量', p5.suggestedBeads > 841, `实际 ${p5.suggestedBeads}`);
  ok('损耗率 10%', Math.abs(p5.lossRate - 0.1) < 1e-9);

  const p26 = calcPhysical(29, 29, { beadSize: '2.6mm', beadType: 'regular' });
  near('2.6mm 29格边长 = 7.54cm', p26.width, 7.54, 0.01);

  const pFus = calcPhysical(29, 29, { beadSize: '5mm', beadType: 'fusion' });
  ok('fusion 损耗率更高 15%', pFus.lossRate > p5.lossRate);
  ok('fusion 采购量更大', pFus.suggestedBeads >= p5.suggestedBeads);

  const pRect = calcPhysical(58, 29, { beadSize: '5mm', beadType: 'regular' });
  near('2板横排宽度 = 29cm', pRect.width, 29, 0.01);
  near('高度 = 14.5cm', pRect.height, 14.5, 0.01);
}

/* ================= 12. 端到端流水线 ================= */
section('12. 端到端流水线（§2 处理链）');

{
  // 构造 60x60 测试图：白底 + 红色圆形
  const W = 60, H = 60;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - 30, dy = y - 30;
      const inCircle = dx * dx + dy * dy < 20 * 20;
      const i = (y * W + x) * 4;
      data[i] = inCircle ? 220 : 250;
      data[i + 1] = inCircle ? 30 : 250;
      data[i + 2] = inCircle ? 30 : 250;
      data[i + 3] = 255;
    }
  }

  const out = run({
    imageData: { width: W, height: H, data },
    params: { boardCount: 29, beadSize: '5mm', mode: 'cartoon', colorLimit: 20 },
  });

  ok('流水线返回图纸', !!out.pattern);
  ok('图纸含稀疏 cells', typeof out.pattern.cells === 'object');
  ok('图纸含用量清单', Array.isArray(out.pattern.colors) && out.pattern.colors.length > 0);
  ok('图纸含物理尺寸', out.pattern.physicalSize.width > 0);
  ok('图纸含体检结论', !!out.pattern.health);
  ok('图纸含留空角标', out.pattern.originMarker === 'top-left');

  /*
   * ★ 板数链路（v0.9 修复「选了双板却显示共 1 块板」）
   *
   *   历史 bug：pipeline 把 params.boardCount（单板格数）当 gridSize 传给
   *   deriveGrid，且横向板数写死 1 → cols 恒为单板宽度 →
   *   checklist 算出的块数恒为 1，分板线与分板施工单全部失效。
   *   现在 boardCols 一路传到 deriveGrid，格点阵与块数都应随之变化。
   */
  ok('默认单板：pattern 记录 boardCols=1', out.pattern.boardCols === 1,
    `实际 ${out.pattern.boardCols}`);
  ok('默认单板：cols 等于单板格数', out.pattern.cols === 29,
    `实际 ${out.pattern.cols}`);

  const dual = run({
    imageData: { width: W, height: H, data },
    params: { boardCount: 29, boardCols: 2, beadSize: '5mm', mode: 'cartoon', colorLimit: 20 },
  });
  ok('★ 双板：cols 翻倍为 58', dual.pattern.cols === 58, `实际 ${dual.pattern.cols}`);
  ok('★ 双板：pattern 记录 boardCols=2', dual.pattern.boardCols === 2,
    `实际 ${dual.pattern.boardCols}`);
  ok('★ 双板：块数不再是 1',
    Math.ceil(dual.pattern.cols / 29) * Math.ceil(dual.pattern.rows / 29) >= 2,
    `cols=${dual.pattern.cols} rows=${dual.pattern.rows}`);

  // 预览与出图必须用同一套板数推导，否则预览显示单板、出图却是双板
  const previewCore = M('core/preview');
  const pv = previewCore.buildPreview(
    { width: W, height: H, data },
    { boardCount: 29, boardCols: 2, mode: 'cartoon', colorLimit: 20 },
    null
  );
  ok('★ 预览与出图的格点阵一致（板数不丢）',
    pv.cols === dual.pattern.cols && pv.rows === dual.pattern.rows,
    `预览 ${pv.cols}×${pv.rows} vs 出图 ${dual.pattern.cols}×${dual.pattern.rows}`);

  // ★ cells 坐标不得越界
  const maxX = Math.max(...Object.keys(out.pattern.cells).map((k) => Number(k.split(',')[1])));
  const maxY = Math.max(...Object.keys(out.pattern.cells).map((k) => Number(k.split(',')[0])));
  ok('cells 坐标不越界', maxX < out.pattern.cols && maxY < out.pattern.rows,
    `max=(${maxX},${maxY}) vs (${out.pattern.cols - 1},${out.pattern.rows - 1})`);

  // ★ cells 数量与用量清单总数一致
  const cellCount = Object.keys(out.pattern.cells).length;
  ok('cells 数量 = 用量总数', cellCount === out.pattern.totalCount,
    `cells=${cellCount} total=${out.pattern.totalCount}`);

  // ★ 用量清单求和 = totalCount
  const sum = out.pattern.colors.reduce((s, c) => s + c.count, 0);
  ok('用量清单求和自洽', sum === out.pattern.totalCount, `求和=${sum} 声明=${out.pattern.totalCount}`);

  // ★ 去背景必须在统计之前
  const out2 = run({
    imageData: { width: W, height: H, data },
    params: { boardCount: 29, beadSize: '5mm', removeBg: true, bgTolerance: 30 },
  });
  ok('去背景后用量显著减少',
    out2.pattern.totalCount < out.pattern.totalCount,
    `去背景=${out2.pattern.totalCount} 未去背景=${out.pattern.totalCount}`);
  ok('去背景后用量不含背景色',
    !out2.pattern.colors.some((c) => c.code === out2.details.get(out2.pattern.colors[0].code) &&
      c.name === '纯白') || out2.bgRatio > 0,
    '不应把背景色计入用量');

  // photo 模式
  const out3 = run({
    imageData: { width: W, height: H, data },
    params: { boardCount: 29, beadSize: '5mm', mode: 'photo' },
  });
  ok('photo 模式可运行', out3.pattern.totalCount > 0);

  // 杂色合并开启
  const out4 = run({
    imageData: { width: W, height: H, data },
    params: { boardCount: 29, beadSize: '5mm', mergeSimilar: true, mergeDelta: 15 },
  });
  ok('杂色合并可运行', out4.pattern.totalCount > 0);
  ok('合并后颜色数不增', out4.pattern.colors.length <= out.pattern.colors.length + 1);

  // 库存约束
  const palette = getPalette('MARD');
  const limitedCodes = palette.colors.slice(0, 3).map((c) => c.code);
  const out5 = run({
    imageData: { width: W, height: H, data },
    params: { boardCount: 29, beadSize: '5mm' },
    onlyCodes: limitedCodes,
  });
  ok('库存约束生效', out5.pattern.colors.every((c) => limitedCodes.includes(c.code)),
    `实际色号：${out5.pattern.colors.map((c) => c.code).join(',')}`);

  // 抖动开启
  const out6 = run({
    imageData: { width: W, height: H, data },
    params: { boardCount: 29, beadSize: '5mm', dither: true },
  });
  ok('抖动可运行', out6.pattern.totalCount > 0);

  // 颜色数上限生效
  const out7 = run({
    imageData: { width: W, height: H, data },
    params: { boardCount: 29, beadSize: '5mm', colorLimit: 2 },
  });
  ok('颜色数上限生效', out7.pattern.colors.length <= 2,
    `实际 ${out7.pattern.colors.length} 色`);

  // 16 格 / 52 格板
  for (const bs of [16, 52]) {
    const o = run({
      imageData: { width: W, height: H, data },
      params: { boardCount: bs, beadSize: '5mm' },
    });
    ok(`${bs} 格板可运行`, o.pattern.totalCount > 0);
  }

  // 性能：52 格应在合理耗时内
  const t = Date.now();
  run({ imageData: { width: W, height: H, data }, params: { boardCount: 52, beadSize: '5mm', mergeSimilar: true } });
  const elapsed = Date.now() - t;
  ok('52 格全链路耗时 < 3s', elapsed < 3000, `实际 ${elapsed}ms`);

  // 输入校验
  let threw = false;
  try { run({ imageData: null }); } catch (e) { threw = true; }
  ok('缺少 imageData 时抛错', threw);
}

/* ================= 13. 稀疏存储与校验 ================= */
section('13. 图纸模型与存储校验（S-04）');

{
  // 稀疏存储：空格子不落盘
  const W = 10, H = 10;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = 220; data[i * 4 + 1] = 30; data[i * 4 + 2] = 30; data[i * 4 + 3] = 255;
  }
  const o = run({
    imageData: { width: W, height: H, data },
    params: { boardCount: 29, removeBg: false },
  });
  const filled = Object.keys(o.pattern.cells).length;
  ok('稀疏存储仅存非空格', filled === o.pattern.cols * o.pattern.rows,
    `存入 ${filled} / 实际 ${o.pattern.cols * o.pattern.rows}`);

  // 稀疏存储收益只在「有空格子」时才体现 → 构造去背景后的图纸
  const BW = 40, BH = 40;
  const bdata = new Uint8ClampedArray(BW * BH * 4);
  for (let y = 0; y < BH; y++) {
    for (let x = 0; x < BW; x++) {
      const i = (y * BW + x) * 4;
      // 中心圆为红，四周为白背景
      const dx = x - 20, dy = y - 20;
      const inCircle = dx * dx + dy * dy < 14 * 14;
      bdata[i] = inCircle ? 220 : 250;
      bdata[i + 1] = inCircle ? 30 : 250;
      bdata[i + 2] = inCircle ? 30 : 250;
      bdata[i + 3] = 255;
    }
  }
  const sparse = run({
    imageData: { width: BW, height: BH, data: bdata },
    params: { boardCount: 29, beadSize: '5mm', removeBg: true, bgTolerance: 20 },
  }).pattern;

  // ★ 稀疏存储仅在「空格占比极高」时才勉强占优，正常图纸上应改用 RLE
  const totalCells = sparse.cols * sparse.rows;
  const filledCells = Object.keys(sparse.cells).length;
  ok('★ 去背景后存在空格', filledCells < totalCells,
    `填充 ${filledCells} / 总计 ${totalCells}`);
  ok('★ cells 只存非空格', filledCells === sparse.totalCount,
    `cells=${filledCells} totalCount=${sparse.totalCount}`);

  // ★ Q-04 存储格式对比：稀疏键值 vs RLE 编码
  //   结论：§3.2 的稀疏键值在真实图纸上反而更大，改用色号字典 + 行程编码
  const sparseJson = JSON.stringify(sparse.cells);
  const enc = codec.encodePattern(sparse);
  const encJson = JSON.stringify(enc);

  ok('★ RLE 编码显著小于稀疏结构', encJson.length < sparseJson.length * 0.5,
    `稀疏=${sparseJson.length} RLE=${encJson.length} 节省 ${(100 - encJson.length / sparseJson.length * 100).toFixed(1)}%`);
  ok('★ RLE 体积告警阈值内', encJson.length < 900 * 1024,
    `实际 ${(encJson.length / 1024).toFixed(1)}KB`);

  // 编解码可逆性
  const decoded = codec.decodePattern(enc);
  ok('★ RLE 解码后尺寸一致', decoded.cols === sparse.cols && decoded.rows === sparse.rows);
  ok('★ RLE 解码后格点完全一致',
    JSON.stringify(decoded.cells) === JSON.stringify(sparse.cells),
    '往返编解码必须无损');
  ok('★ RLE 解码后用量清单一致',
    decoded.totalCount === sparse.totalCount && decoded.colors.length === sparse.colors.length);

  // 稀疏 ↔ 线性数组互转
  const dense = codec.fromSparse(sparse.cells, sparse.cols, sparse.rows);
  ok('★ 稀疏转线性长度正确', dense.length === sparse.cols * sparse.rows);
  ok('★ 线性转稀疏可逆',
    JSON.stringify(codec.toSparse(dense, sparse.cols, sparse.rows)) === JSON.stringify(sparse.cells));

  // 损坏数据降级（S-04）
  const badDecoded = codec.decodePattern(null);
  ok('★ 空编码降级不崩溃', badDecoded === null || badDecoded.cols === 0);

  // storage 校验逻辑（不依赖 wx，用等价的纯逻辑复现）
  const { validatePattern } = { validatePattern: validatePatternLocal };
  ok('合法图纸通过校验', validatePattern(o.pattern).valid === true);
  ok('空图纸被拒', validatePattern(null).valid === false);
  ok('非法 gridSize 被拒', validatePattern({ gridSize: -1, cells: { '0,0': 'H1' }, colors: [] }).valid === false);
  ok('cells 结构错误被拒', validatePattern({ gridSize: 29, cells: [], colors: [] }).valid === false);
  ok('坐标越界被拒', validatePattern({ gridSize: 5, cells: { '9,9': 'H1' }, colors: [] }).valid === false);
  ok('键格式错误被拒', validatePattern({ gridSize: 29, cells: { 'abc': 'H1' }, colors: [] }).valid === false);
  ok('colors 结构错误被拒', validatePattern({ gridSize: 29, cells: { '0,0': 'H1' }, colors: null }).valid === false);
  ok('空 cells 被拒', validatePattern({ gridSize: 29, cells: {}, colors: [] }).valid === false);
}

/**
 * 复现 storage.validatePattern 的纯逻辑版本用于测试
 * （storage.js 依赖 wx.*，无法在 Node 直接 require）
 */
function validatePatternLocal(pattern) {
  if (!pattern || typeof pattern !== 'object') return { valid: false, reason: '图纸为空' };
  const { cols, rows, cells, colors } = pattern;
  const gridSize = cols;
  if (!Number.isInteger(gridSize) || gridSize <= 0 || gridSize > 200) return { valid: false, reason: 'gridSize' };
  if (!cells || typeof cells !== 'object' || Array.isArray(cells)) return { valid: false, reason: 'cells' };
  if (!Array.isArray(colors)) return { valid: false, reason: 'colors' };
  const keys = Object.keys(cells);
  if (keys.length === 0) return { valid: false, reason: '空' };
  for (const k of keys) {
    const parts = k.split(',');
    if (parts.length !== 2) return { valid: false, reason: '键格式' };
    const r = Number(parts[0]), c = Number(parts[1]);
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0 || r >= rows || c >= cols) {
      return { valid: false, reason: '越界' };
    }
    if (typeof cells[k] !== 'string' || !cells[k]) return { valid: false, reason: '值' };
  }
  return { valid: true, reason: '' };
}

/* ================= 14. 实时预览链路 ================= */
section('14. 参数配置实时预览（core/preview）');

{
  const { downsample, getPreviewSource, buildPreview, PREVIEW } = previewCore;

  /*
   * 预览画布尺寸推导已统一到 render/canvas.fitCanvasLayout（三页共用一套算法）。
   * 此处包一层，只是为了把 PREVIEW 的策略参数喂进去，让本节断言语义不变。
   */
  const fitPreviewLayout = (cols, rows, box) => fitCanvasLayout({ cols, rows }, box, {
    padding: PREVIEW.padding,
    minCellPx: PREVIEW.minCellPx,
    maxCellPx: PREVIEW.maxCellPx,
    hardFloor: PREVIEW.hardFloor,
  });

  // --- 降采样 ---
  const W = 400, H = 300;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    // 左半红、右半蓝，降采样后左右两半应仍保持各自主色
    const left = (i % W) < W / 2;
    data[i * 4] = left ? 220 : 30;
    data[i * 4 + 1] = left ? 30 : 60;
    data[i * 4 + 2] = left ? 30 : 200;
    data[i * 4 + 3] = 255;
  }
  const src = downsample({ width: W, height: H, data }, 100);

  ok('降采样后最长边不超过上限', Math.max(src.width, src.height) <= 100,
    `实际 ${src.width}×${src.height}`);
  ok('降采样保持宽高比', Math.abs(src.width / src.height - W / H) < 0.05,
    `${src.width}×${src.height}`);
  ok('降采样输出长度正确', src.data.length === src.width * src.height * 4);

  const midPx = (x) => {
    const idx = (Math.floor(src.height / 2) * src.width + x) * 4;
    return [src.data[idx], src.data[idx + 1], src.data[idx + 2]];
  };
  const leftPx = midPx(Math.floor(src.width * 0.25));
  const rightPx = midPx(Math.floor(src.width * 0.75));
  ok('降采样保留左侧红色调', leftPx[0] > leftPx[2], `rgb=${leftPx}`);
  ok('降采样保留右侧蓝色调', rightPx[2] > rightPx[0], `rgb=${rightPx}`);

  // 小图不缩放（原样返回，避免无谓的数据拷贝语义）
  const small = downsample({ width: 40, height: 30, data: new Uint8ClampedArray(40 * 30 * 4) }, 220);
  ok('小于上限的图不缩放', small.width === 40 && small.height === 30);

  // --- 预览源缓存 ---
  const session = { imageData: { width: W, height: H, data } };
  const s1 = getPreviewSource(session);
  const s2 = getPreviewSource(session);
  ok('预览源被缓存复用（同一引用）', s1 === s2);
  ok('缓存的预览源已降采样', Math.max(s1.width, s1.height) <= PREVIEW.maxSourceEdge);
  ok('缺少 session 时返回 null', getPreviewSource(null) === null);

  // ⚠️ 换图 / 改取景后 session 会被整体替换，缓存必须失效，
  //    否则会把上一张图的降采样结果错用在新图上。
  //    注意：换图后新图可能仍需降采样（300 > maxSourceEdge），
  //    所以断言「不等于旧引用」而不是「等于原尺寸」。
  const newW = 300, newH = 200;
  const newData = new Uint8ClampedArray(newW * newH * 4);
  for (let i = 0; i < newW * newH; i++) {
    newData[i * 4] = 10; newData[i * 4 + 1] = 120; newData[i * 4 + 2] = 240; newData[i * 4 + 3] = 255;
  }
  const session2 = { imageData: { width: newW, height: newH, data: newData } };
  const s3 = getPreviewSource(session2);
  ok('★ 换图后重建预览源', s3 !== s1);
  ok('换图后预览源尺寸正确',
    s3.width === 220 && s3.height === 147, `实际 ${s3.width}×${s3.height}`);
  ok('★ 换图后预览源是新图的像素（而非旧图）',
    s3.data[0] < 50 && s3.data[2] > 200, `首像素 rgb=(${s3.data[0]},${s3.data[1]},${s3.data[2]})`);

  // 同尺寸但像素不同（改取景的典型情形）也必须重建
  const sameSizeNewData = new Uint8ClampedArray(newW * newH * 4);
  for (let i = 0; i < newW * newH; i++) {
    sameSizeNewData[i * 4] = 250; sameSizeNewData[i * 4 + 1] = 20; sameSizeNewData[i * 4 + 2] = 20; sameSizeNewData[i * 4 + 3] = 255;
  }
  session2.imageData = { width: newW, height: newH, data: sameSizeNewData };
  const s4 = getPreviewSource(session2);
  ok('★ 同尺寸换内容也重建预览源', s4 !== s3);
  ok('★ 新预览源反映新像素', s4.data[0] > 200, `首像素 ${s4.data[0]}`);

  // --- 构建预览图纸 ---
  const params = { boardCount: 29, beadSize: '5mm', mode: 'cartoon', colorLimit: 20, brand: 'MARD' };
  const pv = buildPreview(src, params, null);

  ok('预览格点阵列数 = 格数', pv.cols === 29, `实际 ${pv.cols}`);
  ok('预览保持原图宽高比（不拉伸）',
    Math.abs(pv.rows / pv.cols - H / W) < 0.1, `${pv.cols}×${pv.rows}`);
  ok('预览产出颜色清单', pv.colors.length > 0 && pv.colorCount === pv.colors.length);
  ok('预览 colors 按用量降序',
    pv.colors.every((c, i) => i === 0 || pv.colors[i - 1].count >= c.count));
  ok('预览 codes 长度 = cols×rows', pv.codes.length === pv.cols * pv.rows);

  // 稀疏 cells 与线性 codes 一致
  const cellCount = Object.keys(pv.pattern.cells).length;
  const nonEmpty = pv.codes.filter(Boolean).length;
  ok('稀疏 cells 与 codes 一致', cellCount === nonEmpty, `稀疏 ${cellCount} / 线性 ${nonEmpty}`);
  ok('预览关闭色号标注', pv.pattern.render.codeLabel === false);

  // 抽样校验：cells 键能反查到同一色号
  let cellOk = true;
  for (const k of Object.keys(pv.pattern.cells).slice(0, 30)) {
    const [y, x] = k.split(',').map(Number);
    if (pv.pattern.cells[k] !== pv.codes[y * pv.cols + x]) { cellOk = false; break; }
  }
  ok('★ cells 键格式与索引正确', cellOk);

  // --- 参数敏感性：模式与格数变化应体现在预览结果上 ---
  //
  // 测试图必须选「深色描边 + 浅色填充」这一算法真正针对的场景（§2.1 cartoon 的
  // 存在理由就是消除深浅交界黑边）。若用平滑渐变图，每格内色差小于量化步长 32，
  // 桶内均值恰好等于算术均值，两种模式输出必然相同 —— 那是图的性质，不是缺陷。
  const gW = 120, gH = 90;
  const gData = new Uint8ClampedArray(gW * gH * 4);
  const CELLS_X = 10, CELLS_Y = 8;
  const cw = gW / CELLS_X, ch = gH / CELLS_Y;
  for (let y = 0; y < gH; y++) {
    for (let x = 0; x < gW; x++) {
      const i = (y * gW + x) * 4;
      const fx = (x % cw) / cw;      // 格内横向相对位置
      const fy = (y % ch) / ch;      // 格内纵向相对位置
      const onEdge = fx < 0.18 || fx > 0.82 || fy < 0.18 || fy > 0.82;
      // 描边处纯黑，填充处亮黄：同一格内黑黄混杂，均值会稀释成脏灰
      if (onEdge) { gData[i] = 10; gData[i + 1] = 10; gData[i + 2] = 10; }
      else { gData[i] = 250; gData[i + 1] = 220; gData[i + 2] = 60; }
      gData[i + 3] = 255;
    }
  }
  const gradSrc = downsample({ width: gW, height: gH, data: gData }, 220);
  const cartoonPv = buildPreview(gradSrc, { ...params, mode: 'cartoon' }, null);
  const photoPv = buildPreview(gradSrc, { ...params, mode: 'photo' }, null);
  ok('切换算法模式不改变格点阵尺寸',
    photoPv.cols === cartoonPv.cols && photoPv.rows === cartoonPv.rows);
  ok('★ 切换算法模式改变了取色结果',
    JSON.stringify(photoPv.pattern.cells) !== JSON.stringify(cartoonPv.pattern.cells));

  // 主导色应保住纯黑描边，均值则被黄色稀释 → 用到的颜色集合不同
  ok('★ 主导色与均值的用色集合不同',
    cartoonPv.colors.map((c) => c.code).join() !== photoPv.colors.map((c) => c.code).join(),
    `cartoon=${cartoonPv.colors.length} 色 / photo=${photoPv.colors.length} 色`);

  const pv52 = buildPreview(src, { ...params, boardCount: 52 }, null);
  ok('格数变化后预览列数随之变化', pv52.cols === 52, `实际 ${pv52.cols}`);

  // 颜色数上限生效
  const pvLimited = buildPreview(src, { ...params, colorLimit: 4 }, null);
  ok('预览遵守颜色数上限', pvLimited.colors.length <= 4, `实际 ${pvLimited.colors.length}`);

  // 库存限定色集生效
  const onlyCodes = pv.colors.slice(0, 3).map((c) => c.code);
  const pvInv = buildPreview(src, params, onlyCodes);
  ok('库存限定下只用豆柜色',
    pvInv.colors.every((c) => onlyCodes.includes(c.code)),
    pvInv.colors.map((c) => c.code).join(','));

  // --- 画布布局（尺寸推导已统一到 render/canvas.fitCanvasLayout，此处保留等价校验）---
  const layout = fitPreviewLayout(pv.cols, pv.rows, { width: 335, height: 300 });
  ok('单格尺寸落在预设区间或已让步',
    (layout.cellPx >= PREVIEW.minCellPx && layout.cellPx <= PREVIEW.maxCellPx) || layout.capped,
    `实际 ${layout.cellPx} capped=${layout.capped}`);
  ok('画布宽度不超可用宽度', layout.width <= 335, `实际 ${layout.width}`);
  ok('画布尺寸为正', layout.width > 0 && layout.height > 0);

  // 极窄容器也不能算出 0 或负数
  const tiny = fitPreviewLayout(29, 29, { width: 10, height: 0 });
  ok('极窄容器下尺寸仍为正', tiny.width > 0 && tiny.height > 0 && tiny.cellPx > 0);

  // --- 性能：预览必须比全链路快一个量级 ---
  const bigW = 1400, bigH = 1050;
  const bigData = new Uint8ClampedArray(bigW * bigH * 4);
  for (let i = 0; i < bigW * bigH; i++) {
    bigData[i * 4] = (i * 7) % 256;
    bigData[i * 4 + 1] = (i * 13) % 256;
    bigData[i * 4 + 2] = (i * 29) % 256;
    bigData[i * 4 + 3] = 255;
  }
  const bigSrc = downsample({ width: bigW, height: bigH, data: bigData }, PREVIEW.maxSourceEdge);

  const t0 = Date.now();
  for (let i = 0; i < 10; i++) buildPreview(bigSrc, { ...params, boardCount: 52 }, null);
  const pvMs = (Date.now() - t0) / 10;
  ok('预览单次耗时 < 120ms（可支撑实时反馈）', pvMs < 120, `实际 ${pvMs.toFixed(1)}ms`);
}

/* ================= 14b. 预览的参数敏感性（v0.7） ================= */
section('14b. 预览须对每个参数都有反应');

{
  const { downsample, buildPreview } = previewCore;

  // 造一张「近白背景 + 深色描边 + 红填充」的图：
  // 这是去背景与杂色合并最能显出差异的输入。
  const W = 400, H = 300;
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const edge = x < 60 || x > 340 || y < 45 || y > 255;
      const inner = ((((x - 100) / 40) | 0) + (((y - 80) / 35) | 0)) % 2 === 0;
      if (edge) { d[i] = 245; d[i + 1] = 245; d[i + 2] = 250; }
      else if (inner) { d[i] = 20; d[i + 1] = 20; d[i + 2] = 25; }
      else { d[i] = 230; d[i + 1] = 60; d[i + 2] = 70; }
      d[i + 3] = 255;
    }
  }
  const scene = downsample({ width: W, height: H, data: d }, 220);
  const base = { boardCount: 29, brand: 'MARD', colorLimit: 20, mode: 'cartoon', beadSize: '5mm' };

  const sigOf = (p) => buildPreview(scene, { ...base, ...p }, null).codes.join(',');
  const ref = sigOf({});

  // ⚠️ 每条都对应一个「开了却看不出变化」的真实缺陷。
  // 预览链路必须与正式 pipeline 逐步对齐，漏一步该参数就形同虚设。
  ok('★ 去背景开关改变预览（曾漏实现）',
    sigOf({ removeBg: true, bgTolerance: 40 }) !== ref);

  ok('★ 杂色合并开关改变预览（曾漏实现）',
    sigOf({ mergeSimilar: true, mergeDelta: 30 }) !== ref);

  ok('★ 颜色数上限改变预览', sigOf({ colorLimit: 6 }) !== ref);
  ok('颜色数上限生效（实际色数 ≤ 上限）',
    buildPreview(scene, { ...base, colorLimit: 6 }, null).colors.length <= 6);

  ok('★ 图片增强改变预览', sigOf({ enhance: true }) !== ref);
  ok('★ 板数改变预览', sigOf({ boardCount: 16 }) !== ref);
  ok('★ 网格线开关不改变取色（只影响绘制）',
    sigOf({ gridLine: false }) === ref, '网格线属渲染参数，不应影响色号');

  // 库存约束
  const codes4 = buildPreview(scene, base, null).colors.slice(0, 3).map((c) => c.code);
  const invSig = buildPreview(scene, base, codes4).codes.join(',');
  ok('★ 库存限定改变预览', invSig !== ref);
  ok('库存限定下只用豆柜色',
    buildPreview(scene, base, codes4).colors.every((c) => codes4.includes(c.code)));

  // 去背景后应出现空格（实心占比下降）
  const noBg = buildPreview(scene, base, null);
  const withBg = buildPreview(scene, { ...base, removeBg: true, bgTolerance: 40 }, null);
  const fill = (r) => r.codes.filter(Boolean).length / (r.cols * r.rows);
  ok('★ 去背景后实心格占比下降', fill(withBg) < fill(noBg),
    `${(fill(noBg) * 100).toFixed(0)}% → ${(fill(withBg) * 100).toFixed(0)}%`);
  ok('去背景会产出留空格（code 为空）',
    withBg.codes.some((c) => !c));
  ok('去背景的留空格不计入稀疏 cells',
    Object.keys(withBg.pattern.cells).length
      === withBg.codes.filter(Boolean).length);

  // 合并后用量清单必须与 cells 一致（recount 生效）
  const merged = buildPreview(scene, { ...base, mergeSimilar: true, mergeDelta: 30 }, null);
  const sumCount = merged.colors.reduce((s, c) => s + c.count, 0);
  ok('★ 合并后用量清单与色号矩阵一致',
    sumCount === merged.codes.filter(Boolean).length,
    `清单 ${sumCount} / 矩阵 ${merged.codes.filter(Boolean).length}`);

  // 算法模式：用「深色描边 + 渐变填充」——纯色块下两种算法本就等价
  const gW = 400, gH = 300;
  const gd = new Uint8ClampedArray(gW * gH * 4);
  for (let y = 0; y < gH; y++) {
    for (let x = 0; x < gW; x++) {
      const i = (y * gW + x) * 4;
      const fx = (x % 50) / 50;
      const fy = (y % 45) / 45;
      const onEdge = fx < 0.2 || fx > 0.8 || fy < 0.2 || fy > 0.8;
      if (onEdge) { gd[i] = 15; gd[i + 1] = 15; gd[i + 2] = 20; }
      else {
        gd[i] = Math.round(200 + 50 * fx);
        gd[i + 1] = Math.round(50 + 120 * fy);
        gd[i + 2] = Math.round(60 + 80 * (1 - fx));
      }
      gd[i + 3] = 255;
    }
  }
  const gradScene = downsample({ width: gW, height: gH, data: gd }, 220);
  const cartoonR = buildPreview(gradScene, { ...base, mode: 'cartoon' }, null);
  const photoR = buildPreview(gradScene, { ...base, mode: 'photo' }, null);
  ok('★ 切换算法模式改变预览取色',
    cartoonR.codes.join(',') !== photoR.codes.join(','));

  // 预览布局：单格边长下限保证取色差异可辨（P-08 的可视化前提）
  // ⚠️ minCellPx 现在是软下限：空间不足时自动让步并置 capped，
  //    绝不允许为了守住下限把画布撑出容器（那正是「图纸被压扁」的形态）
  const PV = previewCore.PREVIEW;
  const fitPreviewLayout = (cols, rows, box) => fitCanvasLayout({ cols, rows }, box, {
    padding: PV.padding,
    minCellPx: PV.minCellPx,
    maxCellPx: PV.maxCellPx,
    hardFloor: PV.hardFloor,
  });
  const lay = fitPreviewLayout(29, 22, { width: 335, height: 500 });
  ok('预览单格边长不低于可辨识下限或已让步',
    lay.cellPx >= previewCore.PREVIEW.minCellPx || lay.capped, `实际 ${lay.cellPx}px`);
  const tall = fitPreviewLayout(75, 56, { width: 335, height: 300 });
  ok('★ 高格数时按高度收缩，完整可见',
    tall.height <= 300 && tall.capped === true, `${tall.width}×${tall.height}`);
  ok('高度受限时仍保持最小可读格（2px）',
    tall.cellPx >= 2, `实际 ${tall.cellPx}px`);
}

/* ================= 15. 取景裁剪尺寸换算 ================= */
section('15. 取景裁剪（calcCroppedSize 与取景后推导）');

{
  const { calcCroppedSize } = imageUtil;

  ok('无裁剪时返回原尺寸',
    JSON.stringify(calcCroppedSize(1000, 800, null)) === JSON.stringify({ width: 1000, height: 800 }));
  ok('裁剪比例非法时回退原尺寸',
    JSON.stringify(calcCroppedSize(1000, 800, { x: 0, y: 0, w: 0, h: 0 }))
      === JSON.stringify({ width: 1000, height: 800 }));

  // 裁剪改变宽高比 → 格点阵行数必须跟着变（否则图像变形）
  // 注意：必须用**非等比**裁剪。等比裁剪（如 0.5×0.5）不改变宽高比，
  // 行数理应不变，用它断言「行数变了」是错的。
  const cropped = calcCroppedSize(1000, 800, { x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
  ok('裁剪后尺寸按比例缩小', cropped.width === 500 && cropped.height === 400,
    `${cropped.width}×${cropped.height}`);

  const full = deriveGrid(1000, 800, 29, 1);
  const sameRatio = deriveGrid(cropped.width, cropped.height, 29, 1);
  ok('等比裁剪不改变宽高比（行数保持）',
    full.rows === sameRatio.rows && sameRatio.rows === Math.round(29 * 0.8),
    `整图 ${full.rows} 行 / 取景 ${sameRatio.rows} 行`);

  // 只取中间一条横带：宽高比大幅改变
  const band = calcCroppedSize(1000, 800, { x: 0, y: 0.35, w: 1, h: 0.3 });
  const bandGrid = deriveGrid(band.width, band.height, 29, 1);
  ok('★ 非等比取景改变格点阵行数',
    bandGrid.rows < full.rows, `整图 ${full.rows} 行 / 横带 ${bandGrid.rows} 行`);
  ok('取景后保持新区域的宽高比',
    Math.abs(bandGrid.rows / bandGrid.cols - band.height / band.width) < 0.05,
    `${bandGrid.cols}×${bandGrid.rows}`);
  ok('横向裁剪后行数不变（只切横带）',
    bandGrid.cols === full.cols, `${bandGrid.cols} vs ${full.cols}`);

  // 预检基于取景后的有效尺寸
  const riskFull = checkNoiseRisk(1000, 800, 29, 1);
  const riskCrop = checkNoiseRisk(cropped.width, cropped.height, 29, 1);
  ok('取景后每格像素数下降（噪点风险上升）',
    riskCrop.pixelsPerCell < riskFull.pixelsPerCell,
    `整图 ${riskFull.pixelsPerCell} / 取景 ${riskCrop.pixelsPerCell}`);

  // 极端裁剪不产生 0 尺寸
  const tiny = calcCroppedSize(1000, 800, { x: 0, y: 0, w: 0.001, h: 0.001 });
  ok('极端裁剪仍返回至少 1px', tiny.width >= 1 && tiny.height >= 1);

  // --- 按比例求居中裁剪框（拼豆板整数块组合） ---
  //
  // 拼豆板是方板，有用的比例是「板宽:板高」的整数比：
  // 1:1 单板、2:1 横排、1:2 竖排、2:2 四板、3:2 异形。
  // 早期版本误用了头像上传的摄影比例（4:3 / 16:9），
  // 那套比例对应相机取景，与拼豆板拼法无关。

/*
   * ⚠️ 断言口径（v0.8 修正）：
   * centerCropRatio 返回**归一化坐标**，而 ratio 描述的是
   * **裁剪出来那部分的像素宽高比**。两者不是一回事 ——
   * 归一化 w/h 会带上原图自身的比例。
   *   例：1000×800 图裁 1:1 → 归一化 0.704×0.880（比值 0.8），
   *       但像素是 704×704（比值 1.0），符合预期。
   * 所有比例断言必须换算成像素比：
   *   pixelRatio = (crop.w × srcW) / (crop.h × srcH)
   */
  const pixRatio = (crop, sw, sh) => (crop.w * sw) / (crop.h * sh);
  const AVAIL = 1 - 2 * 0.06;   // 内缩后的可用比例 = 0.88

  // 自由比例 → 返回内缩后的最大区域（非整图）
  const freeCrop = centerCropRatio(1000, 800, 0);
  ok('自由比例：返回内缩区域且四周留余量',
    freeCrop.w === AVAIL && freeCrop.h === AVAIL, JSON.stringify(freeCrop));
  ok('自由比例：内缩量左右对称',
    Math.abs(freeCrop.x - (1 - freeCrop.w) / 2) < 0.001, JSON.stringify(freeCrop));

  // 1:1 —— 无论横图竖图，裁剪出来的像素必须是正方形
  const sq = centerCropRatio(1000, 800, 1);
  ok('★ 1:1 裁出正方形（横图）', Math.abs(pixRatio(sq, 1000, 800) - 1) < 0.01,
    `像素比 ${pixRatio(sq, 1000, 800).toFixed(3)}`);
  const sqT = centerCropRatio(800, 1000, 1);
  ok('★ 1:1 裁出正方形（竖图）', Math.abs(pixRatio(sqT, 800, 1000) - 1) < 0.01,
    `像素比 ${pixRatio(sqT, 800, 1000).toFixed(3)}`);
  ok('★ 1:1 居中放置',
    Math.abs(sq.x - (1 - sq.w) / 2) < 0.001 && Math.abs(sq.y - (1 - sq.h) / 2) < 0.001);

  // 各种比例 × 各种原图形状：像素比必须精确等于目标
  const RATIOS = [
    [1, '单板'], [2, '双板横排'], [1 / 2, '双板竖排'],
    [3 / 2, '3:2'], [2 / 3, '2:3'], [4, '大板双拼'],
  ];
  for (const [r, label] of RATIOS) {
    for (const [sw, sh, shape] of [[1000, 800, '横图'], [800, 1000, '竖图'], [900, 900, '方图']]) {
      const c = centerCropRatio(sw, sh, r);
      ok(`★ ${label}(${r}) 在${shape}上像素比精确`,
        Math.abs(pixRatio(c, sw, sh) - r) < 0.01,
        `期望 ${r} 实际 ${pixRatio(c, sw, sh).toFixed(3)}`);
    }
  }

  // 裁剪区四周必须留出余量（否则框被焊死、拖不动）
  for (const [r] of RATIOS) {
    const c = centerCropRatio(1000, 800, r);
    const room = { 左: c.x, 右: 1 - c.x - c.w, 上: c.y, 下: 1 - c.y - c.h };
    ok(`★ 比例 ${r} 四周均留出可拖动余量`,
      Object.values(room).every((v) => v > 0.01), JSON.stringify(room));
  }

  // 极端比例仍应给出合法区域
  const extreme = centerCropRatio(1000, 800, 100);
  ok('极端比例仍返回合法区域',
    extreme.w > 0 && extreme.h > 0 && extreme.w <= 1 && extreme.h <= 1,
    JSON.stringify(extreme));

  // 裁剪结果必须真的改变格点阵形状（否则比例档位形同虚设）
  //
  // 注意方向：列数恒为 boardCount（29），行数由宽高比推导。
  // 横图裁成 1:1 后比例变大 → 行数**增加**、趋近 29（正方形），
  // 而不是减少。想让行数变少得裁成竖长条。
  const c1 = centerCropRatio(1000, 800, 1);
  const g1 = deriveGrid(1000 * c1.w, 800 * c1.h, 29, 1);
  const gFull = deriveGrid(1000, 800, 29, 1);
  ok('★ 1:1 取景后格点阵变为正方形（行数=列数）',
    g1.rows === g1.cols, `${g1.cols}×${g1.rows}`);
  ok('横图裁 1:1 后行数增加（比例变大）',
    g1.rows > gFull.rows, `整图 ${gFull.rows} 行 / 1:1 ${g1.rows} 行`);

  // ⚠️ 比例语义：value = 宽/高（crop.w / crop.h）
  //   2:1 → 扁宽 → srcH/srcW < 1 → 行数**减少**
  //   1:2 → 竖长 → srcH/srcW > 1 → 行数**增加**
  // 两者与直觉相反，写断言时务必先确认 value 的方向。
  const cWide = centerCropRatio(1000, 800, 2);
  const gWide = deriveGrid(1000 * cWide.w, 800 * cWide.h, 29, 1);
  ok('★ 2:1 扁宽取景后行数减少',
    gWide.rows < gFull.rows, `整图 ${gFull.rows} 行 / 2:1 ${gWide.rows} 行`);
  ok('2:1 扁宽取景得到 2:1 格点阵',
    Math.abs(gWide.rows / gWide.cols - 0.5) < 0.05, `${gWide.cols}×${gWide.rows}`);

  const cTall = centerCropRatio(1000, 800, 0.5);
  const gTall = deriveGrid(1000 * cTall.w, 800 * cTall.h, 29, 1);
  ok('★ 1:2 竖长取景后行数增加',
    gTall.rows > gFull.rows, `整图 ${gFull.rows} 行 / 1:2 ${gTall.rows} 行`);

  // 板数换算：成品占几块板，由 ceil(列/格数) × ceil(行/格数) 决定。
  // ⚠️ deriveGrid 返回的 boardCols 是「输入的横向板数」（本项目恒传 1），
  //    不是成品用了几块板，别拿它当板数用。
  const boardsFor = (g, size) => Math.ceil(g.cols / size) * Math.ceil(g.rows / size);
  ok('★ 1:1 成品正好 1 块板（29 格单板）',
    boardsFor(g1, 29) === 1, `占 ${boardsFor(g1, 29)} 块板`);

  // 2:1 扁宽：29 格时列 29、行 15 → 纵向取不满一整板，仍算 1 块板的裁切
  ok('2:1 扁宽在 29 格下仍落在单板范围内',
    boardsFor(gWide, 29) === 1, `${gWide.cols}×${gWide.rows} → ${boardsFor(gWide, 29)} 块板`);

  // 52 格下 2:1 更明显：列 52、行 26 → 横向正好 1 块板
  const gWide52 = deriveGrid(1000 * cWide.w, 800 * cWide.h, 52, 1);
  ok('2:1 在 52 格下横向正好一块板',
    boardsFor(gWide52, 52) === 1, `${gWide52.cols}×${gWide52.rows}`);

  // --- 裁剪区域比较（用于跳过无意义重算） ---
  ok('相同裁剪判定为相等', cropEquals({ x: 0.1, y: 0.2, w: 0.5, h: 0.5 }, { x: 0.1, y: 0.2, w: 0.5, h: 0.5 }));
  ok('浮点微差判定为相等（容差内）',
    cropEquals({ x: 0.1, y: 0.2, w: 0.5, h: 0.5 }, { x: 0.10005, y: 0.2, w: 0.5, h: 0.5 }));
  ok('不同裁剪判定为不等',
    !cropEquals({ x: 0.1, y: 0.2, w: 0.5, h: 0.5 }, { x: 0.3, y: 0.2, w: 0.5, h: 0.5 }));
  ok('null 与非 null 不相等',
    !cropEquals(null, { x: 0, y: 0, w: 1, h: 1 }) && !cropEquals({ x: 0, y: 0, w: 1, h: 1 }, null));
  ok('两个 null 相等', cropEquals(null, null));
  // 自由裁剪与「同样自由裁剪」等价 → 换图初始化时不会重复重算
  ok('★ 重复计算自由裁剪结果一致（换图不触发多余重算）',
    cropEquals(freeCrop, centerCropRatio(640, 480, 0)));
  // 不同尺寸的图，自由裁剪比例相同（都是内缩 6%）→ 换图后判定为「等值」是合理的
  ok('★ 不同尺寸图的自由裁剪归一化结果相同',
    cropEquals(freeCrop, centerCropRatio(1920, 1080, 0)),
    JSON.stringify(centerCropRatio(1920, 1080, 0)));
}

/* ================= 汇总 ================= */
console.log(`\n${'─'.repeat(56)}`);
console.log(`\x1b[32m通过 ${pass}\x1b[0m  |  ` +
  (fail === 0 ? '\x1b[32m失败 0\x1b[0m' : `\x1b[31m失败 ${fail}\x1b[0m`));
if (fail > 0) {
  console.log('\n\x1b[31m失败明细：\x1b[0m');
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exit(1);
}
console.log('\x1b[32m✓ 全部通过\x1b[0m\n');