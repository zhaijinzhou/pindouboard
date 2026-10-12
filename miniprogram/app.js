/**
 * app.js —— 应用入口
 *
 * 启动即构建色库 Lab 索引（文档 P-04：把 RGB→Lab 的开销从
 * 「每次匹配」前移到「启动一次」），后续所有匹配直接复用。
 */

const { getPalette } = require('./color/palette-loader');
const { PALETTE_VERSION, DEFAULT_PARAMS } = require('./utils/config');
const storage = require('./utils/storage');

App({
  globalData: {
    paletteVersion: PALETTE_VERSION,
    paletteCount: 0,
    /** 跨页共享的当前图像（选图 → 配置 → 编辑 → 结果） */
    session: null,
    /** 处理中间结果缓存，避免返回上一页时重复计算 */
    pipelineResult: null,
  },

  onLaunch() {
    // P-04：启动时预构建色库索引
    try {
      const palette = getPalette(DEFAULT_PARAMS.brand);
      this.globalData.paletteCount = palette.colors.length;
      this.globalData.palette = palette;
      console.log(`[app] 色库索引就绪：${palette.colors.length} 色 (v${palette.version})`);
    } catch (e) {
      console.error('[app] 色库初始化失败：', e);
      this.globalData.paletteCount = 0;
    }

    // 隐私合规提示（文档 S-01）：明确告知本地处理
    this.checkPrivacyCompliance();
  },

  /**
   * 隐私合规检查（文档 S-01 / S-08）
   *
   * 本应用图像处理全部在本机完成，不上传云端，因此不需要
   * 用户授权地理位置等敏感信息。但保存图片到相册需要用户授权。
   */
  checkPrivacyCompliance() {
    if (typeof wx.getPrivacySetting !== 'function') return;
    try {
      wx.getPrivacySetting({
        success: (res) => {
          this.globalData.privacySetting = res;
          if (res.needAuthorization) {
            // 需要用户同意隐私协议后才能继续
            wx.requirePrivacyAuthorize({
              success: () => { this.globalData.privacyAgreed = true; },
              fail: () => { this.globalData.privacyAgreed = false; },
            });
          } else {
            this.globalData.privacyAgreed = true;
          }
        },
        fail: () => { this.globalData.privacyAgreed = true; },
      });
    } catch (e) {
      this.globalData.privacyAgreed = true;
    }
  },

  onError(err) {
    console.error('[app] 未捕获异常：', err);
    wx.showToast({ title: '出错了，请重试', icon: 'none' });
  },
});