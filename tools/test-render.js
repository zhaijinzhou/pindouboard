/**
 * tools/test-render.js —— 渲染与清单层单测
 *
 * 用 mock Canvas 2D context 验证绘制调用序列，
 * 无需小程序环境即可跑通 render/ 与 codec/ 的逻辑。
 *
 * 运行：node tools/test-render.js
 */

const path = require('path');
const M = (p) => require(path.join(__dirname, '..', 'miniprogram', p));

const { renderBoard, renderLegend, renderSplit, flattenCells } = M('render/board');
const { calcLayout, fitCanvasLayout, splitByBoard, needSplit } = M('render/canvas');
const { buildChecklistText, boardUsage } = M('render/exporter');
const { buildChecklist, groupByHue, analyzeInventory, buildBoardSheets } = M('render/checklist');
const { run } = M('core/pipeline');
const { getPalette } = M('color/palette-loader');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); }
}
function near(name, a, b, tol) {
  ok(name, Math.abs(a - b) <= tol, `期望 ${b}±${tol}，实际 ${a}`);
}
function section(t) { console.log(`\n\x1b[36m▸ ${t}\x1b[0m`); }

/* ================= Mock Canvas 2D Context ================= */
function createMockCtx() {
  const calls = [];
  const rec = (name) => (...args) => { calls.push({ name, args }); };
  const ctx = {
    calls,
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    font: '', textAlign: 'left', textBaseline: 'top',
    fillRect: rec('fillRect'),
    strokeRect: rec('strokeRect'),
    clearRect: rec('clearRect'),
    fillText: rec('fillText'),
    strokeText: rec('strokeText'),
    beginPath: rec('beginPath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    arc: rec('arc'),
    closePath: rec('closePath'),
    fill: rec('fill'),
    stroke: rec('stroke'),
    save: rec('save'),
    restore: rec('restore'),
    quadraticCurveTo: rec('quadraticCurveTo'),
    measureText: (t) => ({ width: (t || '').length * 6 }),
    createImage: () => ({}),
  };
  // 记录 fillRect 时使用的颜色，便于校验色块填充
  ctx._fillRects = [];
  const origFillRect = ctx.fillRect;
  ctx.fillRect = (...args) => { ctx._fillRects.push({ args, fillStyle: ctx.fillStyle }); calls.push({ name: 'fillRect', args }); };
  return ctx;
}

/** 构造一张测试图纸 */
/**
 * 造一张测试图纸。
 * @param {number} [cols] 横向格数（间接影响输出尺寸），默认 29
 * @param {number} [rows] 纵向格数，默认按 4:3 比例
 */
function makePattern(cols, rows) {
  const board = cols || 29;
  const W = board * 8;
  const H = (rows || Math.round(board * 0.75)) * 8;
  const cx = W / 2, cy = H / 2, r = Math.min(W, H) * 0.35;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const inCircle = Math.pow(x - cx, 2) + Math.pow(y - cy, 2) < r * r;
      data[i] = inCircle ? 220 : 250;
      data[i + 1] = inCircle ? 30 : 250;
      data[i + 2] = inCircle ? 30 : 250;
      data[i + 3] = 255;
    }
  }
  return run({
    imageData: { width: W, height: H, data },
    params: { boardCount: board, beadSize: '5mm', removeBg: true, bgTolerance: 20 },
  }).pattern;
}

/* ================= 1. 布局计算 ================= */
section('1. 渲染布局（calcLayout）');

{
  const pattern = makePattern();
  const l1 = calcLayout(pattern, { cellPx: 20, padding: 10 });
  ok('画布宽 = 格数×单格 + 2×padding',
    l1.width === pattern.cols * 20 + 20, `实际 ${l1.width}`);
  ok('画布高正确', l1.height === pattern.rows * 20 + 20);
  ok('色号字号随单格缩放', l1.codeFontPx === Math.max(6, Math.round(20 * 0.34)));
  ok('网格线宽不小于 0.5', l1.lineWidth >= 0.5);

  // 目标边长反推
  const l2 = calcLayout(pattern, { targetEdge: 2048, padding: 20 });
  ok('按 targetEdge 反推后最长边达标',
    Math.max(pattern.cols, pattern.rows) * l2.cellPx >= 2048 - l2.cellPx,
    `单格=${l2.cellPx}px`);
  ok('单格尺寸有下限保护', l2.cellPx >= 26);

  // 极小单格不应产生 0 或负数
  const l3 = calcLayout(pattern, { cellPx: 1, padding: 5 });
  ok('极小单格有下限', l3.cellPx >= 6 && l3.codeFontPx >= 6);
  ok('画布尺寸为正', l3.width > 0 && l3.height > 0);

  /*
   * ★ 拉伸 bug 的不变量断言（2026-10-13）
   *
   * 绘制按 cellPx 逐格 fillRect，画布按 width/height 开。
   * 两者必须严格一致，否则图纸被拉伸变形。
   * 历史 bug：width/height 用未取整 cellPx 算，返回的 cellPx 却取整了。
   */
  const INVARIANTS = [
    ['整数单格', { cellPx: 20, padding: 16 }],
    ['带小数单格', { cellPx: 13.7, padding: 16 }],
    ['带小数 + scale', { cellPx: 13.7, padding: 16, scale: 0.5 }],
    ['极小单格触发下限', { cellPx: 3, padding: 8 }],
    ['targetEdge 路径', { targetEdge: 2048, padding: 20 }],
  ];
  for (const [name, opt] of INVARIANTS) {
    const l = calcLayout(pattern, opt);
    ok(`★ ${name}：画布宽与单格严格一致`,
      l.width === Math.round(pattern.cols * l.cellPx + l.padding * 2),
      `width=${l.width} 期望 ${Math.round(pattern.cols * l.cellPx + l.padding * 2)}`);
    ok(`★ ${name}：画布高与单格严格一致`,
      l.height === Math.round(pattern.rows * l.cellPx + l.padding * 2),
      `height=${l.height} 期望 ${Math.round(pattern.rows * l.cellPx + l.padding * 2)}`);
  }

  // 等比缩放：padding 必须同步缩放，否则内边距比例失真
  const s1 = calcLayout(pattern, { cellPx: 20, padding: 20 });
  const s2 = calcLayout(pattern, { cellPx: 20, padding: 20, scale: 0.5 });
  ok('★ scale 生效于单格', s2.cellPx === Math.round(s1.cellPx * 0.5),
    `${s1.cellPx} → ${s2.cellPx}`);
  ok('★ scale 同步作用于 padding',
    s2.padding === Math.round(s1.padding * 0.5), `${s1.padding} → ${s2.padding}`);

  // 格数越多越容易暴露累计误差 —— 52 格是主场景
  const big = makePattern(52, 52);
  const lb = calcLayout(big, { cellPx: 7.3, padding: 16 });
  ok('★ 52 格下画布仍与单格严格一致',
    lb.width === Math.round(52 * lb.cellPx + lb.padding * 2)
    && lb.height === Math.round(52 * lb.cellPx + lb.padding * 2),
    `${lb.width}×${lb.height} cellPx=${lb.cellPx}`);

  /*
   * minCellPx 只放宽「下限」，默认行为必须不变 ——
   * calcLayout 是导出链路的公共依赖，回归代价极高。
   */
  const d1 = calcLayout(pattern, { cellPx: 3, padding: 8 });
  ok('★ 未传 minCellPx 时下限仍为 6（默认行为不变）', d1.cellPx === 6, `${d1.cellPx}`);
  const d2 = calcLayout(pattern, { cellPx: 5, padding: 16, minCellPx: 2 });
  ok('★ 传 minCellPx 后可低于 6（52 格窄屏必需）', d2.cellPx === 5, `${d2.cellPx}`);
  ok('★ 放宽下限后画布仍与单格一致',
    d2.width === Math.round(pattern.cols * 5 + 16 * 2), `${d2.width}`);
  ok('★ 放宽下限后 scale 路径不受影响',
    calcLayout(pattern, { cellPx: 5, padding: 16, minCellPx: 2, scale: 0.5 }).cellPx === 3);
}

/* ================= 1b. 容器适配 ================= */
section('1b. 容器适配（fitCanvasLayout：容器可用宽 → cellPx → 画布尺寸）');

{
  /*
   * ⚠️ 这组断言锁死的是 2026-10-13「图纸被横向压扁」的完整链路：
   *     容器可用宽 → cellPx → 画布尺寸 → 显示比例。
   *
   *   历史 bug：JS 用 windowWidth-40 估算可用宽（比真实值大约 32px）
   *   → 画布溢出容器 → flex 子项被压缩 → CSS 显示宽度变窄
   *   → 而 canvas.width 缓冲不变 → 比例失配、图纸被压扁。
   *
   *   之前的 INVARIANTS 只锁了 calcLayout 的**绘制侧自洽**，
   *   完全没覆盖「画布有没有超出容器」—— 而后者才是 bug 的第一现场。
   */
  const DEVICES = [
    { name: 'iPhone SE', box: { width: 258, height: 400 } },
    { name: 'iPhone 8/375', box: { width: 303, height: 367 } },
    { name: 'iPhone 14 Pro', box: { width: 349, height: 690 } },
    { name: 'iPad 竖屏', box: { width: 640, height: 800 } },
  ];
  const GRIDS = [
    { cols: 16, rows: 16 }, { cols: 29, rows: 22 },
    { cols: 52, rows: 52 }, { cols: 104, rows: 58 },
    { cols: 75, rows: 56 }, { cols: 29, rows: 87 },
  ];

  for (const g of GRIDS) {
    for (const d of DEVICES) {
      const tag = `${g.cols}×${g.rows} @ ${d.name}`;
      const l = fitCanvasLayout(g, d.box, { padding: 16, minCellPx: 6, maxCellPx: 28 });

      // ① 不溢出 —— 直接对应「溢出 → 被 flex 压缩 → 变形」
      ok(`★ ${tag}：画布宽不超容器`, l.width <= d.box.width,
        `${l.width} > ${d.box.width}`);
      ok(`★ ${tag}：画布高不超容器`, l.height <= d.box.height,
        `${l.height} > ${d.box.height}`);

      // ② 与 calcLayout 同源：尺寸由同一个 cellPx 算出
      ok(`★ ${tag}：宽与单格严格一致`,
        l.width === Math.round(g.cols * l.cellPx + l.padding * 2),
        `${l.width} vs ${Math.round(g.cols * l.cellPx + l.padding * 2)}`);
      ok(`★ ${tag}：高与单格严格一致`,
        l.height === Math.round(g.rows * l.cellPx + l.padding * 2));

      // ③ ★★ 这条就是「图纸被拉伸」的数学定义，最该被锁死
      //    判据是**格区**（扣掉内边距）的宽高比，不是整幅画布的比例 ——
      //    padding 是设计留白，本就不属于图纸内容；极端长图（如 29×87）下
      //    pad*2 相对格区占比很大，用整幅比例断言会误报。
      //    格区比例恒等于 cols/rows ⇔ 格子是方的 ⇔ 没有被拉伸。
      const expect = g.cols / g.rows;
      const gridW = l.width - l.padding * 2;
      const gridH = l.height - l.padding * 2;
      const got = gridW / gridH;
      ok(`★ ${tag}：格区比例未被拉伸`,
        Math.abs(got - expect) / expect < 0.001,
        `期望 ${expect.toFixed(3)} 实际 ${got.toFixed(3)}`);

      // ③b 格子必须是方的：横向单格 == 纵向单格（历史 bug 正是这里不等）
      ok(`★ ${tag}：单格宽高相等`,
        Math.abs(gridW / g.cols - gridH / g.rows) < 1e-9,
        `${(gridW / g.cols).toFixed(3)} vs ${(gridH / g.rows).toFixed(3)}`);

      // ④ 基本健全性
      ok(`${tag}：单格为整数`, Number.isInteger(l.cellPx));
      ok(`${tag}：单格在 [2, 28]`, l.cellPx >= 2 && l.cellPx <= 28, `${l.cellPx}`);
    }
  }

  // --- 单格上限生效 ---
  const cap = fitCanvasLayout({ cols: 16, rows: 16 }, { width: 900, height: 900 },
    { padding: 16, maxCellPx: 28 });
  ok('大容器下受单格上限约束', cap.cellPx === 28, `${cap.cellPx}`);
  ok('未触上限时不报 capped', cap.capped === false);

  // --- 高度约束生效并如实上报 ---
  const flat = fitCanvasLayout({ cols: 29, rows: 29 }, { width: 900, height: 120 },
    { padding: 16, minCellPx: 8, maxCellPx: 16 });
  ok('高度受限时按高度收缩',
    flat.cellPx === Math.floor((120 - 32 - 2) / 29), `${flat.cellPx}`);
  ok('高度收紧时返回 capped=true', flat.capped === true);
  ok('capped 时仍完整可见', flat.height <= 120, `${flat.height}`);

  // --- 不给高度 = 只按宽度 ---
  const noH = fitCanvasLayout({ cols: 29, rows: 87 }, { width: 303, height: 0 },
    { padding: 16 });
  ok('未给高度时按宽度定尺寸',
    noH.cellPx === Math.floor((303 - 32 - 2) / 87), `${noH.cellPx}`);

  // --- 单调性：容器变大，单格不许变小（防抖动 / 防回退） ---
  let prev = 0;
  for (const w of [120, 200, 260, 320, 420, 600, 900]) {
    const l = fitCanvasLayout({ cols: 52, rows: 52 }, { width: w, height: 0 },
      { padding: 16 });
    ok(`容器 ${w}px 时单格单调不减`, l.cellPx >= prev, `${prev} → ${l.cellPx}`);
    prev = l.cellPx;
  }

  // --- 退化输入不崩 ---
  for (const bad of [{ cols: 1, rows: 1 }, { cols: 0, rows: 0 }, { cols: 200, rows: 200 }]) {
    const l = fitCanvasLayout(bad, { width: 20, height: 20 }, { padding: 16 });
    ok(`退化输入 ${bad.cols}×${bad.rows} 不崩`,
      l.cellPx >= 2 && l.width > 0 && l.height > 0, `${l.width}×${l.height}`);
  }

  // --- config 页参数下的等价覆盖（预览用软下限 8、上限 16、内边距 6） ---
  const pvOpt = { padding: 6, minCellPx: 8, maxCellPx: 16, hardFloor: 2 };
  const pv = fitCanvasLayout({ cols: 29, rows: 22 }, { width: 303, height: 300 }, pvOpt);
  ok('预览单格落在 [8,16] 或已让步',
    (pv.cellPx >= 8 && pv.cellPx <= 16) || pv.capped, `${pv.cellPx} capped=${pv.capped}`);
  ok('预览画布不超容器', pv.width <= 303 && pv.height <= 300,
    `${pv.width}×${pv.height}`);
  const pvTiny = fitCanvasLayout({ cols: 29, rows: 29 }, { width: 10, height: 0 }, pvOpt);
  ok('预览极窄容器下尺寸仍为正',
    pvTiny.width > 0 && pvTiny.height > 0 && pvTiny.cellPx > 0);
  const pvTall = fitCanvasLayout({ cols: 75, rows: 56 }, { width: 303, height: 300 }, pvOpt);
  ok('★ 预览高格数时按高度收缩，完整可见',
    pvTall.height <= 300 && pvTall.capped === true, `${pvTall.width}×${pvTall.height}`);
  ok('预览高度受限时仍保底 2px', pvTall.cellPx >= 2, `${pvTall.cellPx}`);
}

/* ================= 2. 分板切分 ================= */
section('2. 分板切分（splitByBoard / needSplit）');

{
  const pattern = makePattern();
  const regions = splitByBoard(pattern, 29);
  ok('能切分出板区', regions.length > 0);
  ok('每块板都有坐标与尺寸', regions.every((r) =>
    typeof r.x === 'number' && typeof r.y === 'number' && r.w > 0 && r.h > 0));
  ok('每块板不超过板尺寸', regions.every((r) => r.w <= 29 && r.h <= 29));
  ok('板区有可读标签', regions.every((r) => typeof r.label === 'string' && r.label.length > 0));

  // 覆盖完整：不漏格
  let covered = 0;
  regions.forEach((r) => { covered += r.w * r.h; });
  ok('分板覆盖全部格点', covered === pattern.cols * pattern.rows,
    `覆盖 ${covered} / 实际 ${pattern.cols * pattern.rows}`);

  // 52 格四板场景
  const p52 = { cols: 104, rows: 58, boardCount: 52, cells: {} };
  const r52 = splitByBoard(p52, 52);
  ok('52 格四板切出 4 块', r52.length === 4, `实际 ${r52.length}`);

  ok('小图不需分板', needSplit(pattern, 20) === false);
  ok('超大图需分板', needSplit({ cols: 200, rows: 200, boardCount: 52 }, 40) === true);
}

/* ================= 3. 图纸渲染 ================= */
section('3. 图纸渲染（renderBoard）');

{
  const pattern = makePattern();
  const layout = calcLayout(pattern, { cellPx: 20, padding: 10 });
  const ctx = createMockCtx();

  renderBoard(ctx, pattern, layout, { showCode: true, gridLine: true, showDisclaimer: true });

  const fillCount = ctx.calls.filter((c) => c.name === 'fillRect').length;
  const textCount = ctx.calls.filter((c) => c.name === 'fillText').length;

  ok('有填充绘制调用', fillCount > 0);
  ok('每格都有色块填充', fillCount >= pattern.totalCount,
    `fillRect=${fillCount} totalCount=${pattern.totalCount}`);
  ok('有文字绘制调用（色号标注）', textCount > 0);
  // 文字调用应等于「每格色号 + 底部 2 行声明（尺寸 / 版权）」
  ok('文字数量与格数一致（含底部声明）', textCount === pattern.totalCount + 2,
    `fillText=${textCount} totalCount=${pattern.totalCount}`);

  // 仅统计色号标注（排除底部声明的字符串）
  const codeLabels = ctx.calls.filter((c) =>
    c.name === 'fillText' && typeof c.args[0] === 'string' && /^[A-Za-z]/.test(c.args[0]));
  ok('★ 色号标注数 = 格子数', codeLabels.length === pattern.totalCount,
    `色号=${codeLabels.length} totalCount=${pattern.totalCount}`);

  // 标注内容必须来自图纸 cells 中出现过的色号
  const validCodes = new Set(Object.keys(pattern.cells).map((k) => pattern.cells[k]));
  ok('★ 标注内容均为图纸内色号',
    codeLabels.every((c) => validCodes.has(c.args[0])),
    `出现非法色号：${codeLabels.filter((c) => !validCodes.has(c.args[0])).map((c) => c.args[0]).slice(0, 5).join(',')}`);

  // 标注必须落在画布范围内（几何自洽）
  ok('★ 标注坐标落在画布内',
    codeLabels.every((c) => c.args[1] >= 0 && c.args[1] <= layout.width &&
      c.args[2] >= 0 && c.args[2] <= layout.height));
  ok('使用了 save/restore 配对', ctx.calls.some((c) => c.name === 'save') &&
    ctx.calls.some((c) => c.name === 'restore'));
  ok('绘制了网格线', ctx.calls.some((c) => c.name === 'moveTo') &&
    ctx.calls.some((c) => c.name === 'stroke'));
  ok('绘制了留空角标', ctx.calls.some((c) => c.name === 'arc'));

  // 关闭色号标注时不应绘制文字
  const ctx2 = createMockCtx();
  renderBoard(ctx2, pattern, layout, { codeLabel: false, gridLine: false, showDisclaimer: false });
  const text2 = ctx2.calls.filter((c) => c.name === 'fillText').length;
  ok('关闭色号后无文字绘制（除免责信息）', text2 <= 2, `fillText=${text2}`);

  // 单格过小时跳过色号（避免糊成一团）
  const smallLayout = calcLayout(pattern, { cellPx: 8, padding: 5 });
  const ctx3 = createMockCtx();
  renderBoard(ctx3, pattern, smallLayout, { codeLabel: true, showDisclaimer: false });
  const text3 = ctx3.calls.filter((c) => c.name === 'fillText').length;
  ok('单格过小自动省略色号', text3 === 0, `fillText=${text3}`);

  // 裁剪渲染：只画指定区域
  const ctx4 = createMockCtx();
  renderBoard(ctx4, pattern, layout, {
    crop: { x: 0, y: 0, w: 10, h: 10 },
    showDisclaimer: false,
  });
  const fill4 = ctx4.calls.filter((c) => c.name === 'fillRect').length;
  ok('裁剪后绘制量减少', fill4 <= 100, `fillRect=${fill4}`);

  // 孤立格高亮
  const ctx5 = createMockCtx();
  renderBoard(ctx5, pattern, layout, { isolated: [0, 1, 2], showDisclaimer: false });
  ok('孤立格触发高亮描边', ctx5.calls.filter((c) => c.name === 'strokeRect').length >= 4);

  // 平铺优化：应按色号批量填色而非逐格查表
  const flat = flattenCells(pattern);
  ok('flattenCells 长度正确', flat.codes.length === pattern.cols * pattern.rows);
  ok('flattenCells 建立 hex 查表', Object.keys(flat.hex).length === pattern.colors.length);
}

/* ================= 4. 分板渲染 ================= */
section('4. 分板渲染（renderSplit）');

{
  const pattern = { cols: 104, rows: 58, boardCount: 52, cells: {}, colors: [] };
  // 填充少量格点以验证偏移
  for (let y = 0; y < 58; y++) {
    for (let x = 0; x < 104; x++) {
      pattern.cells[`${y},${x}`] = (x + y) % 2 === 0 ? 'H21' : 'H85';
    }
  }
  pattern.colors = [
    { code: 'H21', name: '正红', hex: '#d9252a', rgb: [217, 37, 42], count: 1700 },
    { code: 'H85', name: '深蓝', hex: '#1c3f7a', rgb: [28, 63, 122], count: 1700 },
  ];
  pattern.totalCount = 3400;
  pattern.physicalSize = { width: 52, height: 29, unit: 'cm' };

  const boardLayout = calcLayout({ cols: 52, rows: 52 }, { cellPx: 12, padding: 10 });
  const ctx = createMockCtx();
  const info = renderSplit(ctx, pattern, boardLayout, {});

  ok('分板渲染返回区块', info.regions.length === 4);
  ok('总宽按区块累加', info.totalWidth === 4 * boardLayout.width + 3 * (Math.max(8, 12)),
    `实际 ${info.totalWidth}`);
  ok('每块板绘制了色块', ctx.calls.filter((c) => c.name === 'fillRect').length > 3000);
  ok('标注了块编号', ctx.calls.filter((c) => c.name === 'fillText').length >= 4);
}

/* ================= 5. 图例 ================= */
section('5. 图例渲染（renderLegend）');

{
  const pattern = makePattern();
  const ctx = createMockCtx();
  renderLegend(ctx, pattern, 340, { rowH: 34, perRow: 2 });
  ok('图例有绘制调用', ctx.calls.length > 0);
  ok('每种颜色都有色块', ctx.calls.filter((c) => c.name === 'fill').length >= pattern.colors.length);
  ok('绘制了色号文字', ctx.calls.some((c) => c.name === 'fillText'));

  // 空清单不应崩溃
  const ctx2 = createMockCtx();
  renderLegend(ctx2, { colors: [] }, 340, {});
  ok('空清单不崩溃', ctx2.calls.length > 0);
}

/* ================= 6. 分板施工单 ================= */
section('6. 分板施工单（buildBoardSheets / boardUsage）');

{
  const pattern = makePattern();
  const sheets = buildBoardSheets(pattern);
  ok('生成施工单', sheets.length > 0);
  ok('施工单含标签与坐标', sheets.every((s) => s.label && typeof s.x === 'number'));
  ok('施工单含用量列表', sheets.every((s) => Array.isArray(s.list)));

  // 各板用量之和 = 总用量
  const sum = sheets.reduce((s, sh) => s + sh.total, 0);
  ok('★ 各板用量之和 = 总格数', sum === pattern.totalCount,
    `求和=${sum} 实际=${pattern.totalCount}`);

  // 颜色数之和校验
  const kindsSum = sheets.reduce((s, sh) => s + sh.kinds, 0);
  ok('各板色数之和合理', kindsSum > 0 && kindsSum <= pattern.colors.length * sheets.length);

  // 按用量降序
  ok('板内按用量降序', sheets.every((s) =>
    s.list.every((c, i) => i === 0 || s.list[i - 1].count >= c.count)));

  const usage = boardUsage(pattern, { x: 0, y: 0, w: 29, h: 29 });
  ok('boardUsage 可独立调用', usage.total >= 0 && Array.isArray(usage.list));
}

/* ================= 7. 清单对象 ================= */
section('7. 清单对象（buildChecklist / groupByHue）');

{
  const pattern = makePattern();
  const checklist = buildChecklist(pattern, null);
  ok('清单含尺寸', typeof checklist.size === 'string');
  ok('清单含总格数', checklist.totalCount === pattern.totalCount);
  ok('清单含颜色数', checklist.colorCount === pattern.colors.length);
  ok('清单含建议备豆', checklist.suggestedBeads > pattern.totalCount);
  ok('清单含分组', Array.isArray(checklist.groups) && checklist.groups.length > 0);
  ok('清单含施工单', Array.isArray(checklist.sheets));
  ok('清单含三条声明', checklist.disclaimers.copyright &&
    checklist.disclaimers.colorDiff && checklist.disclaimers.age);

  // 分组求和 = 总用量
  const groupSum = checklist.groups.reduce((s, g) => s + g.totalCount, 0);
  ok('★ 分组用量之和 = 总格数', groupSum === pattern.totalCount,
    `分组=${groupSum} 实际=${pattern.totalCount}`);

  // 2.6mm 年龄警告
  const p26 = makePattern();
  p26.beadSize = '2.6mm';
  const c26 = buildChecklist(p26, null);
  ok('2.6mm 触发年龄警告', c26.warnAge === true);

  // groupByHue 全覆盖
  const g = groupByHue(pattern.colors);
  const gSum = g.reduce((s, x) => s + x.items.length, 0);
  ok('★ 分组覆盖全部颜色', gSum === pattern.colors.length,
    `分组=${gSum} 实际=${pattern.colors.length}`);

  // 空清单
  const emptyC = buildChecklist({ colors: [], cols: 1, rows: 1, totalCount: 0, boardCount: 29 }, null);
  ok('空图纸不崩溃', emptyC.groups.length === 0 && Array.isArray(emptyC.sheets));
}

/* ================= 8. 库存核对 ================= */
section('8. 库存核对（analyzeInventory）');

{
  const pattern = makePattern();

  // 未设置库存
  const none = analyzeInventory(pattern, null);
  ok('未设库存时不做约束', none.hasConstraint === false && none.shortage === 0);

  // 库存充足
  const full = {};
  pattern.colors.forEach((c) => { full[c.code] = c.count + 10; });
  const okInv = analyzeInventory(pattern, { MARD: { '5mm': full } });
  ok('库存充足判定正确', okInv.hasConstraint && okInv.shortage === 0 && okInv.sufficient === pattern.colors.length);

  // 库存不足
  const poor = {};
  pattern.colors.forEach((c, i) => { poor[c.code] = i === 0 ? 0 : Math.floor(c.count / 2); });
  const poorInv = analyzeInventory(pattern, { MARD: { '5mm': poor } });
  ok('检测到缺口', poorInv.shortage === pattern.colors.length, `实际 ${poorInv.shortage}`);
  ok('缺口按缺量排序', poorInv.shortageList.every((s, i) =>
    i === 0 || poorInv.shortageList[i - 1].lack >= s.lack));
  ok('完全缺失的色号被标出', poorInv.missingColors.length === pattern.colors.length);

  // 规格不匹配 → 无约束
  const wrongSize = analyzeInventory(pattern, { MARD: { '3mm': full } });
  ok('规格不匹配时不生效', wrongSize.hasConstraint === false);
}

/* ================= 9. 清单文本导出 ================= */
section('9. 清单文本（buildChecklistText）');

{
  const pattern = makePattern();
  const text = buildChecklistText(pattern);
  ok('导出文本非空', typeof text === 'string' && text.length > 100);
  ok('含尺寸信息', text.includes('成品尺寸'));
  ok('含总格数', text.includes('总格数'));
  ok('含用量明细', text.includes('用量明细'));
  ok('含分板施工单', text.includes('分板施工单'));
  ok('含版权声明（S-05）', text.includes('禁商用'));
  ok('含色差声明（S-07）', text.includes('色差'));
  ok('每个色号都在文本中', pattern.colors.every((c) => text.includes(c.code)));
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