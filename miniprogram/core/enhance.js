/**
 * core/enhance.js —— 图像增强（文档 §4.1 `enhance`）
 *
 * 在「格点阵」上做增强，而非在原图上 —— 因为最终要落到 N×N 格，
 * 在格点阵上增强的结果与用户实际看到的图纸一致。
 *
 * 增强项：
 *   - 对比度：以 0.5 为中心的线性拉伸
 *   - 饱和度：在 HSL 空间放大 S 分量
 *
 * 纯逻辑层，不依赖 wx / Canvas。
 */

/**
 * @param {object} grid   格点阵
 * @param {object} options { contrast: -1~1, saturation: -1~1, brightness: -1~1 }
 * @returns {object} 新格点阵（不修改入参）
 */
function enhance(grid, options = {}) {
  const contrast = clamp(options.contrast || 0, -1, 1);
  const saturation = clamp(options.saturation || 0, -1, 1);
  const brightness = clamp(options.brightness || 0, -1, 1);

  if (contrast === 0 && saturation === 0 && brightness === 0) return grid;

  const cells = new Array(grid.cells.length);

  for (let i = 0; i < grid.cells.length; i++) {
    const c = grid.cells[i];
    if (!c) { cells[i] = c; continue; }

    let r = c.r, g = c.g, b = c.b;

    // --- 亮度 ---
    if (brightness !== 0) {
      const delta = brightness * 60;
      r += delta; g += delta; b += delta;
    }

    // --- 对比度：以 128 为轴心做线性拉伸 ---
    if (contrast !== 0) {
      // factor 从 1（不变）到 2.2（较强）
      const factor = 1 + Math.abs(contrast) * 1.2 * Math.sign(contrast);
      r = 128 + (r - 128) * factor;
      g = 128 + (g - 128) * factor;
      b = 128 + (b - 128) * factor;
    }

    // --- 饱和度：先转 HSL，缩放 S，再转回 ---
    if (saturation !== 0) {
      const hsl = rgbToHsl(r, g, b);
      // S 分量放大倍数
      const mul = 1 + saturation * 0.8;
      hsl.s = clamp(hsl.s * mul, 0, 1);
      const rgb = hslToRgb(hsl.h, hsl.s, hsl.l);
      r = rgb[0]; g = rgb[1]; b = rgb[2];
    }

    cells[i] = {
      r: clampByte(r),
      g: clampByte(g),
      b: clampByte(b),
      empty: c.empty,
    };
  }

  return { ...grid, cells };
}

/* ============ HSL 辅助 ============ */

function rgbToHsl(r, g, b) {
  const rn = clamp(r, 0, 255) / 255;
  const gn = clamp(g, 0, 255) / 255;
  const bn = clamp(b, 0, 255) / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
  }
  return { h, s, l };
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (h % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = l - c / 2;
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function clampByte(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

module.exports = {
  enhance,
  rgbToHsl,
  hslToRgb,
};