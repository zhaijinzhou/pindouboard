/**
 * utils/storage.js
 * 本地存储封装。图纸结构校验（文档 S-04）在此统一收口，
 * 任何损坏数据一律降级为 null，不向上抛错。
 */

const STORAGE_KEYS = {
  PARAMS: 'pd_params',
  INVENTORY: 'pd_inventory',
  PATTERN_META: 'pd_pattern_meta',
  HISTORY: 'pd_history',
  DRAFT: 'pd_draft',
};

/** 读取并安全反序列化 */
function read(key, fallback = null) {
  try {
    const raw = wx.getStorageSync(key);
    if (!raw) return fallback;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    // S-04：数据损坏时降级，绝不崩溃
    console.warn('[storage] 读取失败，已降级：', key, e);
    return fallback;
  }
}

/** 序列化并写入 */
function write(key, value) {
  try {
    wx.setStorageSync(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.error('[storage] 写入失败：', key, e);
    return false;
  }
}

function remove(key) {
  try {
    wx.removeStorageSync(key);
  } catch (e) {
    console.warn('[storage] 删除失败：', key, e);
  }
}

/**
 * 校验图纸结构合法性（S-04）。
 * 返回 { valid, reason }，valid 为 false 时调用方应丢弃该图纸。
 */
function validatePattern(pattern) {
  if (!pattern || typeof pattern !== 'object') {
    return { valid: false, reason: '图纸为空' };
  }
  const { gridSize, cells, colors } = pattern;

  if (!Number.isInteger(gridSize) || gridSize <= 0 || gridSize > 200) {
    return { valid: false, reason: `gridSize 非法：${gridSize}` };
  }
  if (!cells || typeof cells !== 'object' || Array.isArray(cells)) {
    return { valid: false, reason: 'cells 结构非法' };
  }
  if (!Array.isArray(colors)) {
    return { valid: false, reason: 'colors 结构非法' };
  }

  // 抽查 cells 的键值格式："行,列" -> 色号
  const keys = Object.keys(cells);
  if (keys.length === 0) {
    return { valid: false, reason: '图纸无有效格点' };
  }
  const probeKeys = keys.length > 20
    ? keys.filter((_, i) => i % Math.ceil(keys.length / 20) === 0)
    : keys;
  for (const k of probeKeys) {
    const parts = k.split(',');
    if (parts.length !== 2) return { valid: false, reason: `cells 键格式非法：${k}` };
    const r = Number(parts[0]);
    const c = Number(parts[1]);
    if (
      !Number.isInteger(r) || !Number.isInteger(c) ||
      r < 0 || c < 0 || r >= gridSize || c >= gridSize
    ) {
      return { valid: false, reason: `cells 坐标越界：${k}` };
    }
    if (typeof cells[k] !== 'string' || !cells[k]) {
      return { valid: false, reason: `cells 值非法：${k}` };
    }
  }
  return { valid: true, reason: '' };
}

/* ============ 参数读写 ============ */

/** 读取用户参数，并与默认值合并（保证新增配置项自动有默认值） */
function getParams(defaults) {
  const saved = read(STORAGE_KEYS.PARAMS, {});
  return { ...defaults, ...(saved && typeof saved === 'object' ? saved : {}) };
}

function setParams(params) {
  return write(STORAGE_KEYS.PARAMS, params);
}

/* ============ 库存豆柜读写（M7） ============ */

/**
 * 库存结构：{ [brand]: { [beadSize]: { [code]: quantity } } }
 * 例：{ MARD: { '5mm': { H1: 120, H7: 30 } } }
 */
function getInventory() {
  const inv = read(STORAGE_KEYS.INVENTORY, null);
  if (!inv || typeof inv !== 'object' || Array.isArray(inv)) return {};
  return inv;
}

/** 写入库存，自动裁掉数量 <= 0 的条目 */
function setInventory(inv) {
  const clean = {};
  Object.keys(inv || {}).forEach((brand) => {
    const bySize = inv[brand] || {};
    clean[brand] = {};
    Object.keys(bySize).forEach((size) => {
      const byCode = bySize[size] || {};
      const codes = {};
      let sum = 0;
      Object.keys(byCode).forEach((code) => {
        const q = Math.max(0, Math.floor(Number(byCode[code]) || 0));
        if (q > 0) {
          codes[code] = q;
          sum += q;
        }
      });
      if (sum > 0) clean[brand][size] = codes;
    });
  });
  return write(STORAGE_KEYS.INVENTORY, clean);
}

/** 取某品牌某规格下「数量 > 0」的色号集合，作为匹配时的限定色集 */
function getAvailableCodes(brand, beadSize) {
  const inv = getInventory();
  const bySize = (inv[brand] || {})[beadSize];
  if (!bySize) return null; // null 表示未设置库存 → 不做约束
  return Object.keys(bySize).filter((c) => bySize[c] > 0);
}

/** 清空库存 */
function clearInventory() {
  remove(STORAGE_KEYS.INVENTORY);
}

/* ============ 图纸存取 ============ */

function savePattern(pattern) {
  const check = validatePattern(pattern);
  if (!check.valid) {
    console.warn('[storage] 图纸校验失败，拒绝保存：', check.reason);
    return { ok: false, reason: check.reason };
  }
  const ok = write(STORAGE_KEYS.DRAFT, pattern);
  return { ok, reason: ok ? '' : '存储空间不足' };
}

function loadPattern() {
  const p = read(STORAGE_KEYS.DRAFT, null);
  if (!p) return null;
  const check = validatePattern(p);
  if (!check.valid) {
    console.warn('[storage] 本地图纸损坏，已丢弃：', check.reason);
    remove(STORAGE_KEYS.DRAFT);
    return null;
  }
  return p;
}

function clearPattern() {
  remove(STORAGE_KEYS.DRAFT);
}

module.exports = {
  STORAGE_KEYS,
  read,
  write,
  remove,
  validatePattern,
  getParams,
  setParams,
  getInventory,
  setInventory,
  getAvailableCodes,
  clearInventory,
  savePattern,
  loadPattern,
  clearPattern,
};