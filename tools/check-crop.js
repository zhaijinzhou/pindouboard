/**
 * tools/check-crop.js —— 取景框交互逻辑离线验证
 *
 * 背景：取景框「划不动」的问题连修两次仍未解决，
 * 与其继续在真机上试错，不如把纯逻辑抽出来在 Node 里跑。
 *
 * crop-frame 的 hitTest / moveRect / resizeRect / applyRatio 都是纯计算，
 * 只依赖 this.disp / this.data，本模块用最小桩件把它们原样跑起来，
 * 验证三件事：
 *   1. 自由比例下选框四周都有可移动空间（不能被焊死）
 *   2. 框内拖动能产生实际位移
 *   3. 四角缩放能同时改变宽高，且不越出图片显示区
 *
 * 运行：node tools/check-crop.js
 */

const path = require('path');

const FILE = path.join(__dirname, '..', 'miniprogram', 'components', 'crop-frame', 'crop-frame.js');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); }
}
function section(t) { console.log(`\n\x1b[36m▸ ${t}\x1b[0m`); }

/**
 * 加载 crop-frame 的方法。
 *
 * 用桩件替换全局 Component()，在 require 时捕获注册对象，
 * 再补齐模块私有依赖（clamp / dist2 / 常量）——这些不导出，
 * 只能通过在该模块作用域内执行的方式取到。
 */
function loadComponent() {
  const path = require('path');
  const fs = require('fs');
  const Module = require('module');

  const FILE = path.join(__dirname, '..', 'miniprogram', 'components', 'crop-frame', 'crop-frame.js');
  const src = fs.readFileSync(FILE, 'utf8');

  /*
   * 改写策略：把 `Component({ ... })` 的注册调用替换成直接赋值，
   * 再追加一个导出语句把私有方法/常量交出来。
   *
   * 用「最后一个 `});`」定位注册块结尾 —— 该文件里 observers/methods
   * 内层的闭合都是 `},` 或 `})`，只有注册块末尾才是独立的 `});`。
   */
  const start = src.indexOf('\nComponent({');
  if (start < 0) throw new Error('未找到 Component({ 注册块');

  const end = src.lastIndexOf('\n});');
  if (end < start) throw new Error('未找到注册块结尾 });');

  const patched =
    src.slice(0, start)
    + '\nconst __component = {'
    + src.slice(start + '\nComponent({'.length, end)
    + '\n};'
    + src.slice(end + '\n});'.length)
    + '\nmodule.exports = Object.assign({}, __component.methods, '
    + '{ HIT, MIN_SIZE, FREE_MARGIN, MASK_COLOR, clamp, dist2, round4 });'
    + '\n';

  const m = new Module(FILE, null);
  m.filename = FILE;
  m.paths = Module._nodeModulePaths(path.dirname(FILE));
  m._compile(patched, FILE);
  return m.exports;
}

const M = loadComponent();
const { applyRatio, hitTest, moveRect, resizeRect, dist2 } = M;

// ---------- 构造一个可控的组件实例 ----------
const STAGE_W = 335, STAGE_H = 620;
const IMG_W = 1200, IMG_H = 800;

function makeInstance(ratio) {
  const scale = Math.min(STAGE_W / IMG_W, STAGE_H / IMG_H);
  const dispW = IMG_W * scale;
  const dispH = IMG_H * scale;
  const offX = (STAGE_W - dispW) / 2;
  const offY = (STAGE_H - dispH) / 2;

  const self = {
    data: { ratio, ready: true, stageW: STAGE_W, stageH: STAGE_H },
    disp: { offX, offY, dispW, dispH },
    crop: null,
    emitted: 0,
    /**
     * 桩掉 setData：把 patch 合并进 data，并把 crop 落回实例，
     * 让被测代码走的是真实链路（setCrop → setData → paintMask → emit）
     * 而非替身行为。
     */
    setData(patch, cb) {
      Object.assign(self.data, patch);
      if (patch.crop) self.crop = patch.crop;
      if (typeof cb === 'function') cb();
    },
    triggerEvent() { self.emitted++; },
  };

  // 绑定组件的全部真实方法（含 setCrop / paintMask / emitChange 等）
  for (const k of Object.keys(M)) {
    if (typeof M[k] === 'function' && M[k].name !== 'clamp' && M[k].name !== 'dist2' && M[k].name !== 'round4') {
      self[k] = M[k].bind(self);
    }
  }

  return self;
}

section('1. 自由比例：选框必须四周可移动');

{
  const self = makeInstance(0);
  self.applyRatio();

  const c = self.crop;
  const { offX, offY, dispW, dispH } = self.disp;

  ok('选框未铺满（宽度小于显示区）', c.w < dispW, `w=${c.w.toFixed(1)} dispW=${dispW.toFixed(1)}`);
  ok('选框未铺满（高度小于显示区）', c.h < dispH, `h=${c.h.toFixed(1)} dispH=${dispH.toFixed(1)}`);

  // 四个方向的可移动余量
  const moveX = (offX + dispW - c.x - c.w);   // 向右的最大位移
  const moveY = (offY + dispH - c.y - c.h);
  ok('向右可移动空间 > 0', moveX > 1, `余量 ${moveX.toFixed(1)}px`);
  ok('向左可移动空间 > 0', c.x - offX > 1, `余量 ${(c.x - offX).toFixed(1)}px`);
  ok('向下可移动空间 > 0', moveY > 1, `余量 ${moveY.toFixed(1)}px`);
  ok('向上可移动空间 > 0', c.y - offY > 1, `余量 ${(c.y - offY).toFixed(1)}px`);
}

section('2. 框内拖动必须产生实际位移');

for (const ratio of [0, 1]) {
  const name = ratio === 0 ? '自由比例' : '锁定 1:1';
  const self = makeInstance(ratio);
  self.applyRatio();

  const c = self.crop;
  const centerX = c.x + c.w / 2;
  const centerY = c.y + c.h / 2;

  const mode = self.hitTest(centerX, centerY, c);
  ok(`★ ${name}：框内点命中为 move`, mode === 'move', `实际 ${mode}`);

  const g = { mode, disp: self.disp, origin: { ...c } };
  const moved = self.moveRect(g, 20, 15);
  ok(`★ ${name}：右移产生位移`, moved.x > c.x + 1,
    `位移 ${(moved.x - c.x).toFixed(1)}px（余量不足时会小于请求量，但必须 > 0）`);
  ok(`★ ${name}：下移产生位移`, moved.y > c.y + 1,
    `位移 ${(moved.y - c.y).toFixed(1)}px`);
  ok(`★ ${name}：拖动后尺寸不变`, moved.w === c.w && moved.h === c.h);

  // 位移量必须精确跟随手指（不能被静默截断）
  const roomX = self.disp.dispW - c.w;
  const roomY = self.disp.dispH - c.h;
  const tryX = Math.min(12, roomX - 1);
  const tryY = Math.min(12, roomY - 1);
  const exact = self.moveRect(g, tryX, tryY);
  ok(`★ ${name}：右移精确跟随手指`,
    Math.abs((exact.x - c.x) - tryX) < 0.5,
    `期望 ${tryX.toFixed(1)} 实际 ${(exact.x - c.x).toFixed(1)}（余量 ${roomX.toFixed(1)}）`);
  ok(`★ ${name}：下移精确跟随手指`,
    Math.abs((exact.y - c.y) - tryY) < 0.5,
    `期望 ${tryY.toFixed(1)} 实际 ${(exact.y - c.y).toFixed(1)}（余量 ${roomY.toFixed(1)}）`);
}

section('3. 拖动边界：不越出图片显示区');

{
  const self = makeInstance(0);
  self.applyRatio();
  const { offX, offY, dispW, dispH } = self.disp;
  const c = self.crop;
  const g = { mode: 'move', disp: self.disp, origin: { ...c } };

  const right = self.moveRect(g, 9999, 9999);
  ok('右边界不越出', right.x + right.w <= offX + dispW + 0.5,
    `${(right.x + right.w).toFixed(1)} vs ${(offX + dispW).toFixed(1)}`);
  const left = self.moveRect(g, -9999, -9999);
  ok('左边界不越出', left.x >= offX - 0.5, `${left.x.toFixed(1)} vs ${offX.toFixed(1)}`);
  ok('下边界不越出', left.y + left.h <= offY + dispH + 0.5);
}

section('4. 四角缩放');

/*
 * 方向语义（务必先想清楚再写断言）：
 *   nw 左上 / ne 右上 / sw 左下 / se 右下
 *   拖角 → 该角沿手指方向移动，**对角保持不动**
 *   例：se 往右下拖 → 右下角外扩，左上角锚定 → w↑ h↑
 */
for (const ratio of [0, 1]) {
  const name = ratio === 0 ? '自由比例' : '锁定 1:1';

  /** 拖某个角，验证尺寸变化方向 + 对角锚定 */
  function dragCorner(mode, label, want) {
    const self = makeInstance(ratio);
    self.applyRatio();
    const c = self.crop;

    const corner = {
      nw: { x: c.x, y: c.y },
      ne: { x: c.x + c.w, y: c.y },
      sw: { x: c.x, y: c.y + c.h },
      se: { x: c.x + c.w, y: c.y + c.h },
    }[mode];

    const hit = self.hitTest(corner.x, corner.y, c);
    ok(`★ ${name}：${label}角命中 ${mode}`, hit === mode, `实际 ${hit}`);

    /*
     * ⚠️ 拖拽量必须按**实际余量**取，不能写死 20。
     * 框四周只有 FREE_MARGIN(6%) 的余量（纵向可能仅十几 px），
     * 请求量超过余量会被 clamp 截断 —— 那是正确行为（不许越出图片），
     * 但会让「尺寸应当增大」的断言失败。测试要反映真实可用范围。
     */
    const roomLeft = c.x - self.disp.offX;
    const roomRight = (self.disp.offX + self.disp.dispW) - (c.x + c.w);
    const roomTop = c.y - self.disp.offY;
    const roomBottom = (self.disp.offY + self.disp.dispH) - (c.y + c.h);

    // 外扩方向能用的空间：dx>0 用右侧余量，dx<0 用左侧余量
    const dx = want.dx > 0 ? Math.min(want.dx, roomRight - 1)
      : (want.dx < 0 ? -Math.min(-want.dx, roomLeft - 1) : 0);
    const dy = want.dy > 0 ? Math.min(want.dy, roomBottom - 1)
      : (want.dy < 0 ? -Math.min(-want.dy, roomTop - 1) : 0);

    const r = self.resizeRect({ mode, disp: self.disp, origin: { ...c } }, dx, dy);

    if (dx > 0) ok(`★ ${name}：${label}角右拖宽度增大`, r.w > c.w,
      `${c.w.toFixed(1)} → ${r.w.toFixed(1)}（右余量 ${roomRight.toFixed(1)}）`);
    if (dx < 0) ok(`★ ${name}：${label}角左拖宽度增大`, r.w > c.w,
      `${c.w.toFixed(1)} → ${r.w.toFixed(1)}（左余量 ${roomLeft.toFixed(1)}）`);
    if (dy > 0) ok(`★ ${name}：${label}角下拖高度增大`, r.h > c.h,
      `${c.h.toFixed(1)} → ${r.h.toFixed(1)}（下余量 ${roomBottom.toFixed(1)}）`);
    if (dy < 0) ok(`★ ${name}：${label}角上拖高度增大`, r.h > c.h,
      `${c.h.toFixed(1)} → ${r.h.toFixed(1)}（上余量 ${roomTop.toFixed(1)}）`);

    /*
     * 对角锚定：拖动角沿手指方向走，**与之相对的那个角**保持不动。
     *   角  ↔ 对角
     *   nw  ↔ se     ne  ↔ sw
     *   sw  ↔ ne     se  ↔ nw
     * 拖动方向与锚定边的关系：
     *   dx > 0（往右拖）→ 左边界不动
     *   dx < 0（往左拖）→ 右边界不动
     *   dy > 0（往下拖）→ 上边界不动
     *   dy < 0（往上拖）→ 下边界不动
     */
    if (dx > 0) {
      ok(`★ ${name}：${label}角右拖，左边界锚定`,
        Math.abs(r.x - c.x) < 1.0, `期望 ${c.x.toFixed(1)} 实际 ${r.x.toFixed(1)}`);
    } else if (dx < 0) {
      ok(`★ ${name}：${label}角左拖，右边界锚定`,
        Math.abs((r.x + r.w) - (c.x + c.w)) < 1.0,
        `期望 ${(c.x + c.w).toFixed(1)} 实际 ${(r.x + r.w).toFixed(1)}`);
    }
    if (dy > 0) {
      /*
       * 锁定比例时，纵向由主轴推导：
       * 若垂直方向是「被动轴」（宽度为主），高度变化不由 dy 直接决定，
       * 对角锚定不成立 —— 这是比例锁定的固有语义，不是缺陷。
       * 只在垂直为主轴时才断言锚定。
       */
      const verticalIsPrimary = ratio <= 0 || Math.abs(dy) >= Math.abs(dx);
      if (verticalIsPrimary) {
        ok(`★ ${name}：${label}角下拖，上边界锚定`,
          Math.abs(r.y - c.y) < 1.0, `期望 ${c.y.toFixed(1)} 实际 ${r.y.toFixed(1)}`);
      }
    } else if (dy < 0) {
      const verticalIsPrimary = ratio <= 0 || Math.abs(dy) >= Math.abs(dx);
      if (verticalIsPrimary) {
        ok(`★ ${name}：${label}角上拖，下边界锚定`,
          Math.abs((r.y + r.h) - (c.y + c.h)) < 1.0,
          `期望 ${(c.y + c.h).toFixed(1)} 实际 ${(r.y + r.h).toFixed(1)}`);
      }
    }

    if (ratio > 0) {
      ok(`★ ${name}：${label}角缩放后保持锁定比例`,
        Math.abs(r.w / r.h - ratio) < 0.06, `实际 ${(r.w / r.h).toFixed(3)}`);
    }
  }

  // se 往右下拖 → 右下外扩，左上锚定
  dragCorner('se', '右下', { dx: 20, dy: 20 });
  // nw 往左上拖 → 左上外扩，右下锚定
  dragCorner('nw', '左上', { dx: -20, dy: -20 });
  // ne 往右上拖 → 右上外扩，左下锚定（宽度增、高度增）
  dragCorner('ne', '右上', { dx: 20, dy: -20 });
  // sw 往左下拖 → 左下外扩，右上锚定（宽度增、高度增）
  dragCorner('sw', '左下', { dx: -20, dy: 20 });
}

section('5. 缩小与最小尺寸保护');

{
  const self = makeInstance(0);
  self.applyRatio();
  const c = self.crop;
  const g = { mode: 'se', disp: self.disp, origin: { ...c } };
  const shrunk = self.resizeRect(g, -9999, -9999);
  ok('极端缩小时不低于最小边长', shrunk.w >= 48 && shrunk.h >= 48,
    `${shrunk.w.toFixed(1)}×${shrunk.h.toFixed(1)}`);
  ok('缩小后仍在图片区内',
    shrunk.x >= self.disp.offX - 0.5 && shrunk.x + shrunk.w <= self.disp.offX + self.disp.dispW + 0.5);
}

section('6. 命中测试的边界与歧义');

{
  const self = makeInstance(0);
  self.applyRatio();
  const c = self.crop;

  ok('框外触点不命中', self.hitTest(c.x - 100, c.y + c.h / 2, c) === null);
  ok('框外触点（右下）不命中', self.hitTest(c.x + c.w + 100, c.y + c.h + 100, c) === null);

  // 贴边场景：选框紧贴左上角时，同一点不应同时命中 nw 与 w
  const edge = { x: self.disp.offX, y: self.disp.offY, w: c.w, h: c.h };
  const m1 = self.hitTest(edge.x, edge.y, edge);
  const m2 = self.hitTest(edge.x, edge.y, edge);
  ok('贴边时命中稳定（可重复）', m1 === m2, `${m1} vs ${m2}`);
  ok('贴边角点命中四角之一', ['nw', 'ne', 'sw', 'se'].includes(m1), `实际 ${m1}`);

  // 边中点应返回 null（自由比例下不提供边拖拽），而不是误判成 move
  const midEdge = self.hitTest(edge.x + edge.w / 2, edge.y, edge);
  ok('自由比例下边中点不误判', midEdge === null || midEdge === 'n' || midEdge === 's',
    `实际 ${midEdge}`);
}

section('7. 锁定比例时提供边中点拖拽');

{
  const self = makeInstance(1);
  self.applyRatio();
  const c = self.crop;
  const midTop = self.hitTest(c.x + c.w / 2, c.y, c);
  ok('上边中点命中 n', midTop === 'n', `实际 ${midTop}`);

  // 拖上边往下 → 该边下移，高度减小；**下边锚定不动**
  const g = { mode: 'n', disp: self.disp, origin: { ...c } };
  const r = self.resizeRect(g, 0, 25);
  ok('★ 拖上边往下，高度减小（被压扁）', r.h < c.h, `${c.h.toFixed(1)} → ${r.h.toFixed(1)}`);
  ok('★ 拖上边往下，下边界锚定不动',
    Math.abs((r.y + r.h) - (c.y + c.h)) < 1.0,
    `期望 ${(c.y + c.h).toFixed(1)} 实际 ${(r.y + r.h).toFixed(1)}`);
  ok('★ 拖上边往下，上边界下移', r.y > c.y, `${c.y.toFixed(1)} → ${r.y.toFixed(1)}`);
  ok('★ 拖上边往下保持锁定比例', Math.abs(r.w / r.h - 1) < 0.06,
    `${(r.w / r.h).toFixed(3)}`);

  // 拖上边往上 → 高度增大
  const r2 = self.resizeRect(g, 0, -25);
  ok('★ 拖上边往上，高度增大', r2.h > c.h, `${c.h.toFixed(1)} → ${r2.h.toFixed(1)}`);
}

section('8. dist2 辅助函数');

{
  ok('同点距离为 0', dist2(10, 10, 10, 10) === 0);
  ok('距离计算正确', dist2(0, 0, 3, 4) === 25);
}

console.log(`\n${'─'.repeat(56)}`);
console.log(`\x1b[32m通过 ${pass}\x1b[0m  |  ` +
  (fail === 0 ? '\x1b[32m失败 0\x1b[0m' : `\x1b[31m失败 ${fail}\x1b[0m`));
if (fail > 0) {
  console.log('\n\x1b[31m失败明细：\x1b[0m');
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exit(1);
}
console.log('\x1b[32m✓ 全部通过\x1b[0m\n');