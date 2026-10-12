/**
 * tools/check-wxss.js —— WXSS 语法体检
 *
 * 小程序 WXSS 不是完整 CSS，只支持子集。以下写法会直接导致
 * 「[WXSS 文件编译错误] unexpected token」而整页白屏：
 *
 *   1. 通配选择器 `*`、`.a *`、`.a > *`
 *   2. CSS4 伪类/函数式伪类 `:is() :where() :has()`
 *   3. 标签选择器在部分场景行为不一致（且易被页面内同名标签误命中）
 *   4. 自定义属性选择器 `[data-*]`（内建的如 [disabled] 是支持的）
 *
 * 本脚本做静态扫描，把编译期错误挡在真机之前。
 * 运行：node tools/check-wxss.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'miniprogram');

/** 规则表：{ 正则, 说明, 修复建议 } */
const RULES = [
  {
    name: '通配选择器 *',
    // 匹配 `.a *` / `> *` / 独立的 `* {`
    re: /(^|[\s>+~])\*[\s]*[,{]/m,
    hint: 'WXSS 不支持通配选择器。`pointer-events` 等属性本身会继承，'
      + '在父级声明即可；若确需批量设置，请逐个列出类名。',
  },
  {
    name: 'CSS4 函数式伪类 :is/:where/:has',
    re: /:(is|where|has)\s*\(/,
    hint: 'WXSS 不支持 CSS4 函数式伪类，请改用逗号分隔的多选择器。',
  },
  {
    name: '自定义/动态属性选择器 [data-*]',
    // WXSS 支持组件内建属性选择器（如 .btn[disabled]），
    // 但**自定义属性 data-* 与 wx: 动态绑定产生的属性不受支持**，
    // 写了不报错但选择器静默失效 —— 比直接编译报错更难排查。
    re: /^\s*\[(?:data-|wx[:\-])/m,
    hint: 'WXSS 支持内建属性选择器（如 [disabled]），'
      + '但不支持自定义属性 data-* / wx: 绑定产生的属性 —— 选择器会静默失效。'
      + '请改用显式类名。',
  },
  {
    name: '后代通配组合器 (*>)',
    re: />\s*\*/,
    hint: '通配选择器一律不支持，改用逗号分隔的多选择器。',
  },
];

function collectWxss(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) collectWxss(p, out);
    else if (p.endsWith('.wxss')) out.push(p);
  }
  return out;
}

/** 去掉注释，避免注释里的示例文字被误判 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

const files = collectWxss(ROOT, []);
let problems = 0;

for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  const css = stripComments(raw);
  const rel = path.relative(ROOT, file);

  for (const rule of RULES) {
    // 全局扫描，逐个报告命中位置
    const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g');
    let m;
    while ((m = re.exec(css))) {
      const line = css.slice(0, m.index).split('\n').length;
      console.log(`  ${rel}:${line}  ${rule.name}  →  ${m[0].trim()}`);
      problems++;
    }
  }
}

if (problems === 0) {
  console.log(`✓ WXSS 语法体检通过（${files.length} 个文件）`);
  console.log('  已检查：通配选择器 / CSS4 伪类 / 自定义属性选择器');
} else {
  console.log(`\n✗ ${problems} 处 WXSS 高风险写法，会导致编译报错`);
  for (const rule of RULES) {
    console.log(`\n【${rule.name}】${rule.hint}`);
  }
  process.exit(1);
}