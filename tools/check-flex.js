/**
 * tools/check-flex.js —— WXSS 布局体检
 *
 * 检查 flex 容器中「可伸缩 + 长文本」组合是否漏了 min-width: 0。
 *
 * 背景：flex 项的 `flex: 1` 只设置 flex-basis（期望尺寸），
 * 而 `min-width` 默认是 `auto`，会被解析为「内容的最小尺寸」。
 * 长文本撑出的下限会把整项顶出容器，表现为文字堆到屏幕右侧或溢出。
 *
 * 运行：node tools/check-flex.js
 * 退出码：0 = 无问题，1 = 有问题
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'miniprogram');

function collectWxss(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) collectWxss(p, out);
    else if (p.endsWith('.wxss')) out.push(p);
  }
  return out;
}

const files = collectWxss(ROOT, []);
let problems = 0;
let staleList = 0;

/**
 * 已核查无需 min-width 的白名单。
 * 判定依据：内容长度由代码固定（数字、枚举标签），
 * 不存在用户可控的长文本，min-width:auto 不会造成溢出。
 * 新增 flex:1 规则时若不在此列，必须补 min-width:0。
 */
const SAFE_WITHOUT_MIN_WIDTH = new Set([
  '.stat-item',      // 豆柜统计：纯数字等宽块
  '.entry-tab',      // 豆柜入口分栏：固定枚举文案
  '.qty-input',      // 数量输入框：input 自身不换行
  '.summary-item',   // 配置页指标：纯数字等宽块
  '.mode',           // 算法模式分栏：固定枚举文案
]);

/**
 * 必须声明 flex-shrink: 0 的类名。
 *
 * ⚠️ 这些类会作为 flex 子项承载 <canvas>。漏写 flex-shrink:0 时，
 *   画布超出容器会被**压缩**（而不是溢出），CSS 显示宽度被压窄而
 *   canvas.width 缓冲不变 → 图纸被静默拉伸变形。
 *
 *   历史 bug（2026-10-13「图纸被横向压扁」）就是这么来的：
 *   .board-canvas 未写 flex-shrink:0，52 格画布 344px 溢出 303px 容器
 *   被压到 88%，而纵向不变。这类 bug 在 Node 里测不出来（属渲染层行为），
 *   静态拦截是唯一可靠的防回归手段。
 */
const MUST_NOT_SHRINK = new Set([
  '.board-canvas',   // pages/editor + pages/result 的图纸画布
  '.lp-canvas',      // pages/config 的实时预览画布
]);

/** 规则块正则：不含嵌套花括号，足够覆盖本项目的扁平 WXSS */
const RULE_RE = /([^{}]+)\{([^{}]*)\}/g;
const FLEX_RE = /flex:\s*1\s*;/;
const MINWIDTH_RE = /min-width/;
const SHRINK_RE = /flex-shrink:\s*0\s*;/;
const COMMENT_RE = /\/\*[\s\S]*?\*\//g;

/** MUST_NOT_SHRINK 的命中计数，用于确认白名单没有与实际 WXSS 脱节 */
const shrinkSeen = new Set();

for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  /*
   * ⚠️ 必须先剥离注释再解析规则：RULE_RE 的选择器组是 [^{}]+，
   *    会把注释文本一并吞进去。`.board-canvas` 前面若跟着多行注释，
   *    捕获到的选择器会变成「…注释内容… .board-canvas」，
   *    导致白名单精确匹配失败（既漏报又误报）。
   *    行号保持精确：注释被替换成等长空白，换行数不变。
   */
  const css = raw.replace(COMMENT_RE, (c) => c.replace(/[^\n]/g, ' '));
  let m;
  RULE_RE.lastIndex = 0;
  while ((m = RULE_RE.exec(css))) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    const body = m[2];

    // @规则（如 @media）不算
    if (selector.startsWith('*') || selector.startsWith('@')) continue;

    // 画布类必须禁止被 flex 压缩
    if (MUST_NOT_SHRINK.has(selector)) {
      shrinkSeen.add(selector);
      if (!SHRINK_RE.test(body)) {
        const line = css.slice(0, m.index).split('\n').length;
        console.log(`  ${path.relative(ROOT, file)}:${line}  ${selector}  缺少 flex-shrink: 0`);
        problems++;
      }
    }

    if (SAFE_WITHOUT_MIN_WIDTH.has(selector)) continue;

    if (FLEX_RE.test(body) && !MINWIDTH_RE.test(body)) {
      const line = css.slice(0, m.index).split('\n').length;
      console.log(`  ${path.relative(ROOT, file)}:${line}  ${selector}`);
      problems++;
    }
  }
}

// 白名单与实际 WXSS 的一致性：类被改名/删除时能及时发现
for (const sel of MUST_NOT_SHRINK) {
  if (!shrinkSeen.has(sel)) {
    console.log(`  （白名单）${sel} 在 WXSS 中已不存在，请确认是否被改名或删除`);
    staleList++;
  }
}

if (problems === 0 && staleList === 0) {
  console.log('✓ 所有 flex: 1 规则均已配 min-width，长文本不会撑破容器');
  console.log(`  （白名单 ${SAFE_WITHOUT_MIN_WIDTH.size} 项，内容长度由代码固定）`);
  console.log(`✓ ${MUST_NOT_SHRINK.size} 个画布类均已配 flex-shrink: 0，不会被压缩变形`);
} else {
  if (problems > 0) {
    console.log(`\n✗ ${problems} 处布局问题：`);
    console.log('  · 缺少 flex-shrink: 0（画布类）→ 补 flex-shrink: 0，否则画布被压缩变形');
    console.log('  · 缺少 min-width: 0（flex: 1 类）→ 补 min-width: 0，否则长文本撑破容器');
    console.log('    若内容长度确由代码固定，可加入 tools/check-flex.js 的白名单并注明理由');
  }
  if (staleList > 0) {
    console.log(`\n✗ ${staleList} 处白名单与 WXSS 不一致：`);
    console.log('  · 请更新 tools/check-flex.js 中的白名单，或恢复被误删的样式');
  }
  process.exit(1);
}
