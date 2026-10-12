/**
 * pages/cabinet/cabinet.js —— 我的豆柜（文档 P1 / M7 / Q-07）
 *
 * Q-07「库存豆柜录入方式」本实现采用：
 *   手动输入色号 + 按图纸批量填充 两种方式。
 *   理由：拍照识别色号需要额外的 OCR/颜色识别能力，
 *   而豆柜是低频操作（补货时才用），手动输入成本可接受；
 *   「按图纸批量填充」用实际解决高频场景 —— 出完图顺手把用量录进去。
 */

const storage = require('../../utils/storage');
const { getPalette } = require('../../color/palette-loader');
const { DEFAULT_PARAMS, BEAD_SPECS } = require('../../utils/config');

const app = getApp();

Page({
  data: {
    brand: DEFAULT_PARAMS.brand,
    beadSize: DEFAULT_PARAMS.beadSize,
    stats: { kinds: 0, total: 0, series: 0 },
    items: [],
    entryTab: 'quick',
    codeInput: '',
    qtyInput: '',
    hasPattern: false,
    patternCodeCount: 0,
  },

  onLoad() {
    const params = storage.getParams(DEFAULT_PARAMS);
    const palette = getPalette(params.brand);
    this.palette = palette;

    this.setData({
      brand: params.brand,
      beadSize: params.beadSize,
    });

    this.refresh();

    const result = app.globalData.pipelineResult;
    this.hasPattern = !!(result && result.pattern && result.pattern.colors.length);
    this.setData({
      hasPattern: this.hasPattern,
      patternCodeCount: this.hasPattern ? result.pattern.colors.length : 0,
    });
  },

  /* ============ 数据 ============ */

  refresh() {
    const inv = storage.getInventory();
    const bySize = (inv[this.data.brand] || {})[this.data.beadSize] || {};

    const items = Object.keys(bySize)
      .filter((code) => bySize[code] > 0)
      .map((code) => {
        const entry = this.palette.byCode.get(code);
        return {
          code,
          name: entry ? entry.name : code,
          hex: entry ? entry.hex : '#cccccc',
          qty: bySize[code],
          series: entry ? entry.series : '?',
        };
      })
      .sort((a, b) => a.code.localeCompare(b.code));

    const total = items.reduce((s, i) => s + i.qty, 0);
    const series = new Set(items.map((i) => i.series));

    this.setData({
      items,
      stats: { kinds: items.length, total, series: series.size },
    });
  },

  persist() {
    const inv = storage.getInventory();
    if (!inv[this.data.brand]) inv[this.data.brand] = {};
    inv[this.data.brand][this.data.beadSize] = this.buildCurrentMap();
    storage.setInventory(inv);
  },

  buildCurrentMap() {
    const map = {};
    this.data.items.forEach((i) => { map[i.code] = i.qty; });
    return map;
  },

  /* ============ 手动录入 ============ */

  onTabChange(e) {
    this.setData({ entryTab: e.currentTarget.dataset.tab });
  },

  onCodeInput(e) {
    this.setData({ codeInput: e.detail.value.toUpperCase() });
  },

  onQtyInput(e) {
    this.setData({ qtyInput: e.detail.value });
  },

  onAdd() {
    const code = (this.data.codeInput || '').trim().toUpperCase();
    if (!code) {
      wx.showToast({ title: '请输入色号', icon: 'none' });
      return;
    }
    const entry = this.palette.byCode.get(code);
    if (!entry) {
      wx.showModal({
        title: '色号不存在',
        content: `色库中没有「${code}」。请检查是否输入正确。`,
        showCancel: false,
      });
      return;
    }
    if (entry.sizes.indexOf(this.data.beadSize) < 0) {
      wx.showToast({ title: `${code} 无 ${this.data.beadSize} 规格`, icon: 'none' });
      return;
    }

    const qty = Math.max(0, Math.floor(Number(this.data.qtyInput) || 0));
    const items = this.data.items.slice();
    const idx = items.findIndex((i) => i.code === code);

    if (idx >= 0) {
      items[idx].qty += qty;
    } else {
      items.push({
        code,
        name: entry.name,
        hex: entry.hex,
        qty,
        series: entry.series,
      });
    }

    items.sort((a, b) => a.code.localeCompare(b.code));
    this.setData({ items, codeInput: '', qtyInput: '' });
    this.persist();
    wx.showToast({ title: '已加入', icon: 'success' });
  },

  /* ============ 按图纸批量 ============ */

  onFillFromPattern() {
    const result = app.globalData.pipelineResult;
    if (!result || !result.pattern) return;

    wx.showModal({
      title: '按图纸填充',
      content: `将最近图纸用到的 ${result.pattern.colors.length} 个色号及用量写入豆柜。已存在的色号会累加。`,
      confirmText: '填充',
      success: (res) => {
        if (!res.confirm) return;

        const items = this.data.items.slice();
        const index = new Map(items.map((i, k) => [i.code, k]));

        for (const c of result.pattern.colors) {
          if (index.has(c.code)) {
            items[index.get(c.code)].qty += c.count;
          } else {
            const entry = this.palette.byCode.get(c.code);
            items.push({
              code: c.code,
              name: entry ? entry.name : c.name,
              hex: entry ? entry.hex : c.hex,
              qty: c.count,
              series: entry ? entry.series : '?',
            });
          }
        }

        items.sort((a, b) => a.code.localeCompare(b.code));
        this.setData({ items });
        this.persist();
        wx.showToast({ title: '已填充', icon: 'success' });
      },
    });
  },

  /* ============ 增减 ============ */

  onInc(e) {
    this.changeQty(e.currentTarget.dataset.code, 1);
  },

  onDec(e) {
    this.changeQty(e.currentTarget.dataset.code, -1);
  },

  changeQty(code, delta) {
    const items = this.data.items.slice();
    const idx = items.findIndex((i) => i.code === code);
    if (idx < 0) return;

    items[idx].qty = Math.max(0, items[idx].qty + delta);

    let next = items;
    if (items[idx].qty === 0) {
      // 数量归零则移出列表（storage 会自动裁掉 0 值条目）
      next = items.filter((i) => i.code !== code);
    }

    this.setData({ items: next });
    this.persist();
  },

  /* ============ 其他 ============ */

  onClear() {
    wx.showModal({
      title: '清空豆柜',
      content: `确定要清空 ${this.data.brand} ${this.data.beadSize} 的全部库存记录吗？此操作不可撤销。`,
      confirmText: '清空',
      confirmColor: '#f0453a',
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ items: [], stats: { kinds: 0, total: 0, series: 0 } });
        this.persist();
        wx.showToast({ title: '已清空', icon: 'success' });
      },
    });
  },

  goResult() {
    if (!app.globalData.pipelineResult) {
      wx.showToast({ title: '还没有图纸', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/result/result' });
  },
});