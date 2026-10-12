/**
 * color/lab.js —— 色彩科学层（文档 §1.1「CIE Lab ΔE」）
 *
 * 纯函数，无任何 wx / UI 依赖，可在 Node 中直接单测。
 * 提供 sRGB → CIE XYZ → CIE Lab 转换，以及 ΔE76 / ΔE2000 色差计算。
 */

/**
 * CIE 标准 D65 白点，2° 观察者。
 * ⚠️ 必须使用 0~1 归一化值：上方 sRGB 原色矩阵输出的 XYZ 本身就是 0~1 区间，
 *    若这里误用 95.047/100/108.883 的百分制数值，Lab 的 L 会整体塌缩到接近 0，
 *    进而让 ΔE 全部失真（色差趋近于相等，匹配退化为任意选择）。
 */
const D65 = { X: 0.95047, Y: 1.0, Z: 1.08883 };

/** sRGB 逆伽马校正阈值 */
const GAMMA_THRESHOLD = 0.04045;
const GAMMA_SLOPE = 12.92;
const GAMMA_OFFSET = 0.055;
const GAMMA_POW = 2.4;

/**
 * 单通道逆伽马（sRGB 电平 0~255 → 线性光 0~1）
 */
function srgbToLinear(channel255) {
  const c = channel255 / 255;
  if (c <= GAMMA_THRESHOLD) return c / GAMMA_SLOPE;
  return Math.pow((c + GAMMA_OFFSET) / (1 + GAMMA_OFFSET), GAMMA_POW);
}

/**
 * RGB(0~255) → CIE Lab。
 *
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {{L:number, a:number, b:number}}
 */
function rgbToLab(r, g, b) {
  // Step 1: sRGB 逆伽马 → 线性 RGB
  const rl = srgbToLinear(r);
  const gl = srgbToLinear(g);
  const bl = srgbToLinear(b);

  // Step 2: 线性 RGB → CIE XYZ（sRGB 原色矩阵, D65）
  const X = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375;
  const Y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750;
  const Z = rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041;

  // Step 3: XYZ → Lab（相对于 D65 白点做归一化）
  const fx = labF(X / D65.X);
  const fy = labF(Y / D65.Y);
  const fz = labF(Z / D65.Z);

  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

const LAB_EPSILON = 216 / 24389; // 0.008856
const LAB_KAPPA = 24389 / 27; // 903.3

/** Lab 的 f(t) 分段函数 */
function labF(t) {
  return t > LAB_EPSILON ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116;
}

/* ============================ ΔE 实现 ============================ */

/**
 * CIE76 色差（欧氏距离）。
 * 公式简单、速度快，适合剪枝阶段的粗筛。
 */
function deltaE76(lab1, lab2) {
  const dL = lab1.L - lab2.L;
  const da = lab1.a - lab2.a;
  const db = lab1.b - lab2.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

/**
 * CIE2000 色差（CIEDE2000）。
 *
 * 这是文档 §1.1 指定的默认算法。相较 ΔE76 它修正了蓝绿色区域的
 * 显著偏差与人眼对色相变化敏感度低、对明度变化敏感度高的特性，
 * 在小色库（221 色）上匹配准确度明显更高。
 *
 * 实现遵循 Sharma, Wu & Dalal (2005) 的标准测试数据公式。
 */
function deltaE2000(lab1, lab2, opts) {
  const kL = (opts && opts.kL) || 1;
  const kC = (opts && opts.kC) || 1;
  const kH = (opts && opts.kH) || 1;

  const L1 = lab1.L, a1 = lab1.a, b1 = lab1.b;
  const L2 = lab2.L, a2 = lab2.a, b2 = lab2.b;

  // 1) 转换到 CIELCh
  const C1ab = Math.sqrt(a1 * a1 + b1 * b1);
  const C2ab = Math.sqrt(a2 * a2 + b2 * b2);
  const Cab = (C1ab + C2ab) / 2;
  const Cab7 = Math.pow(Cab, 7);
  const G = 0.5 * (1 - Math.sqrt(Cab7 / (Cab7 + 6103515625))); // 25^7

  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.sqrt(a1p * a1p + b1 * b1);
  const C2p = Math.sqrt(a2p * a2p + b2 * b2);

  // h' 角，b=0 时定义为 0
  const h1p = hueAngle(b1, a1p);
  const h2p = hueAngle(b2, a2p);

  // 2) ΔL', ΔC', ΔH'
  const dLp = L2 - L1;
  const dCp = C2p - C1p;

  let dhp;
  if (C1p * C2p === 0) {
    dhp = 0; // 任一为中性色时，色相差不计入
  } else {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));

  // 3) 加权因子
  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;

  let hbarp;
  if (C1p * C2p === 0) {
    hbarp = h1p + h2p;
  } else if (Math.abs(h1p - h2p) <= 180) {
    hbarp = (h1p + h2p) / 2;
  } else {
    hbarp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }

  const T = 1
    - 0.17 * Math.cos(rad(hbarp - 30))
    + 0.24 * Math.cos(rad(2 * hbarp))
    + 0.32 * Math.cos(rad(3 * hbarp + 6))
    - 0.20 * Math.cos(rad(4 * hbarp - 63));

  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));

  const RC = 2 * Math.sqrt(Math.pow(Cbarp, 7) / (Math.pow(Cbarp, 7) + 6103515625));
  const SL = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(rad(2 * dTheta)) * RC;

  // 4) 合成 ΔE
  const tL = dLp / (kL * SL);
  const tC = dCp / (kC * SC);
  const tH = dHp / (kH * SH);
  return Math.sqrt(tL * tL + tC * tC + tH * tH + RT * tC * tH);
}

/** 角度制色相，b=0 → 0 */
function hueAngle(b, ap) {
  if (b === 0 && ap === 0) return 0;
  const h = Math.atan2(b, ap) * (180 / Math.PI);
  return h >= 0 ? h : h + 360;
}

function rad(deg) {
  return (deg * Math.PI) / 180;
}

/** ΔE 分发器 */
function deltaE(lab1, lab2, method = '2000') {
  return method === '76' ? deltaE76(lab1, lab2) : deltaE2000(lab1, lab2);
}

/* ============================ 辅助 ============================ */

/** RGB 三元组 → hex 字符串 */
function rgbToHex(r, g, b) {
  const to2 = (v) => {
    const s = Math.max(0, Math.min(255, Math.round(v))).toString(16);
    return s.length === 1 ? `0${s}` : s;
  };
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

/** hex → RGB 三元组 */
function hexToRgb(hex) {
  const h = String(hex).replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * RGB 三元组的感知明度（0~100），用于体检中的「浅色系占比」判断。
 */
function perceivedLightness(r, g, b) {
  return rgbToLab(r, g, b).L;
}

/**
 * 由 RGB 推算基础色相（HSV 的 H，0~360）。
 * 用于 P-05 匹配剪枝：色相差过大的候选色在感知上不可能是最优匹配。
 */
function rgbToHue(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  if (d === 0) return -1; // 灰色无色相
  let h;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/**
 * 判断两个色相之间的最短角距（0~180）。
 * 灰色（hue < 0）返回 -1，表示不参与剪枝。
 */
function hueDistance(h1, h2) {
  if (h1 < 0 || h2 < 0) return -1;
  const d = Math.abs(h1 - h2);
  return d > 180 ? 360 - d : d;
}

/**
 * 在 Lab 空间中合成两个颜色的平均值。
 * 直接在 Lab 里做算术平均比回到 RGB 空间平均更符合感知均匀性。
 */
function mixLab(lab1, lab2, t = 0.5) {
  return {
    L: lab1.L + (lab2.L - lab1.L) * t,
    a: lab1.a + (lab2.a - lab1.a) * t,
    b: lab1.b + (lab2.b - lab1.b) * t,
  };
}

/** Lab → RGB（用于把区域均值反查回可显示颜色） */
function labToRgb(lab) {
  const fy = (lab.L + 16) / 116;
  const fx = fy + lab.a / 500;
  const fz = fy - lab.b / 200;

  // 反解到 XYZ（0~1 区间，与 D65 归一化值一致）
  const x = (Math.pow(fx, 3) > LAB_EPSILON ? Math.pow(fx, 3) : (116 * fx - 16) / LAB_KAPPA) * D65.X;
  const y = (lab.L > LAB_KAPPA * LAB_EPSILON
    ? Math.pow((lab.L + 16) / 116, 3)
    : lab.L / LAB_KAPPA) * D65.Y;
  const z = (Math.pow(fz, 3) > LAB_EPSILON ? Math.pow(fz, 3) : (116 * fz - 16) / LAB_KAPPA) * D65.Z;

  const r = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
  const g = x * -0.9692660 + y * 1.8760108 + z * 0.0415560;
  const b = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;

  const gamma = (c) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  };
  return [gamma(r), gamma(g), gamma(b)];
}

module.exports = {
  D65,
  rgbToLab,
  deltaE,
  deltaE76,
  deltaE2000,
  rgbToHex,
  hexToRgb,
  perceivedLightness,
  rgbToHue,
  hueDistance,
  mixLab,
  labToRgb,
};