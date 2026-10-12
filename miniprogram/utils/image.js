/**
 * utils/image.js —— 图片载入与像素读取（文档 M1 / S-02）
 *
 * 职责：
 *   1. 选择图片（相册 / 拍照）
 *   2. 格式与体积校验（S-02）
 *   3. 压缩到处理链上限，避免大图内存溢出
 *   4. 从 Canvas 读取像素缓冲，交给 core/pixelate.js
 *
 * 隐私要点（S-01）：全过程在本机完成，图片不会离开设备。
 * 本模块不发起任何网络请求。
 */

const { PRECHECK } = require('./config');

/**
 * 选择图片
 * @returns {Promise<{path, size}>}
 */
function chooseImage(sourceType = ['album', 'camera']) {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType,
      sizeType: ['original'],
      camera: 'back',
      success: (res) => {
        const item = res.tempFiles && res.tempFiles[0];
        if (!item) {
          reject(new Error('未获取到图片'));
          return;
        }
        resolve({ path: item.tempFilePath, size: item.size, width: item.width, height: item.height });
      },
      fail: (err) => {
        // 用户主动取消不视为错误
        if (err.errMsg && err.errMsg.indexOf('cancel') >= 0) {
          reject({ canceled: true });
        } else {
          reject(new Error('选择图片失败：' + (err.errMsg || '未知错误')));
        }
      },
    });
  });
}

/**
 * 校验图片格式与体积（S-02）
 * @returns {{ valid, reason }}
 */
function validateImage(path, size) {
  if (!path) return { valid: false, reason: '未选择图片' };

  const ext = String(path).toLowerCase().split('.').pop();
  const allowed = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'];
  if (ext && !allowed.includes(ext)) {
    return { valid: false, reason: `不支持的图片格式：.${ext}。请使用 JPG / PNG / WEBP。` };
  }

  if (size && size > PRECHECK.maxSizeMB * 1024 * 1024) {
    return {
      valid: false,
      reason: `图片体积 ${(size / 1024 / 1024).toFixed(1)}MB 超过 ${PRECHECK.maxSizeMB}MB 上限。`
        + '请压缩后再上传。',
    };
  }
  return { valid: true, reason: '' };
}

/**
 * 获取图片信息
 * @returns {Promise<{width, height, path}>}
 */
function getImageInfo(path) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({
      src: path,
      success: (res) => resolve({ width: res.width, height: res.height, path: res.path || path }),
      fail: (err) => reject(new Error('读取图片信息失败：' + (err.errMsg || '未知错误'))),
    });
  });
}

/**
 * 把图片绘制到指定尺寸的 Canvas 并读取像素。
 *
 * ⚠️ 尺寸选择策略（S-02「大尺寸原图需先压缩再进入处理链」）：
 *   直接读取 4000×3000 原图的像素需占用约 48MB 内存，
 *   在中低端机上会触发 OOM。这里限制最长边为 PRECHECK.maxProcessEdge，
 *   既保证采样精度（每格仍对应多个像素），又把内存控制在安全范围。
 *
 * @param {string} srcPath   本地图片路径
 * @param {number} targetW   目标宽
 * @param {number} targetH   目标高
 * @param {object} [crop]   取景裁剪区域 {x, y, w, h}，**相对原图的归一化比例**。
 *                          缺省表示整张图。传入后只有该区域参与后续处理，
 *                          实现「用户选择用图片的哪一部分来生图」。
 * @returns {Promise<{width, height, data, scale}>}
 */
function readPixels(srcPath, targetW, targetH, crop) {
  return new Promise((resolve, reject) => {
    // 优先 OffscreenCanvas：不占用页面布局，且不受屏幕尺寸限制
    if (typeof wx.createOffscreenCanvas === 'function') {
      try {
        const canvas = wx.createOffscreenCanvas({ type: '2d', width: targetW, height: targetH });
        const ctx = canvas.getContext('2d');
        drawAndRead(canvas, ctx, srcPath, targetW, targetH, crop)
          .then(resolve)
          .catch(() => fallbackToPageCanvas(srcPath, targetW, targetH, crop).then(resolve).catch(reject));
        return;
      } catch (e) {
        // 落到页面 Canvas
      }
    }
    fallbackToPageCanvas(srcPath, targetW, targetH, crop).then(resolve).catch(reject);
  });
}

function drawAndRead(canvas, ctx, srcPath, targetW, targetH, crop) {
  return new Promise((resolve, reject) => {
    const img = canvas.createImage
      ? canvas.createImage()
      : (typeof wx.createImage === 'function' ? wx.createImage() : null);

    if (!img) {
      reject(new Error('当前环境不支持图片解码'));
      return;
    }

    img.onload = () => {
      try {
        ctx.clearRect(0, 0, targetW, targetH);
        // imageSmoothingQuality 高质量缩放，保留更多细节供主导色统计
        if ('imageSmoothingEnabled' in ctx) ctx.imageSmoothingEnabled = true;
        if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';

        // 有裁剪 → 用 9 参数 drawImage 只取源区域；无裁剪 → 整图拉伸
        if (crop && crop.w > 0 && crop.h > 0) {
          const sw = img.width;
          const sh = img.height;
          // 裁剪比例先夹到 [0,1]，再取整到至少 1px，避免 drawImage 因 0 宽高抛错
          const sx = Math.max(0, Math.min(sw - 1, Math.round(crop.x * sw)));
          const sy = Math.max(0, Math.min(sh - 1, Math.round(crop.y * sh)));
          const sWidth = Math.max(1, Math.min(sw - sx, Math.round(crop.w * sw)));
          const sHeight = Math.max(1, Math.min(sh - sy, Math.round(crop.h * sh)));
          ctx.drawImage(img, sx, sy, sWidth, sHeight, 0, 0, targetW, targetH);
        } else {
          ctx.drawImage(img, 0, 0, targetW, targetH);
        }

        const imageData = ctx.getImageData(0, 0, targetW, targetH);
        resolve({
          width: targetW,
          height: targetH,
          data: imageData.data,
          scale: 1,
        });
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = srcPath;
  });
}

function fallbackToPageCanvas(srcPath, targetW, targetH, crop) {
  return new Promise((resolve, reject) => {
    wx.createSelectorQuery()
      .select('#hiddenPixelCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) {
          reject(new Error('像素读取通道不可用'));
          return;
        }
        const canvas = res[0].node;
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        drawAndRead(canvas, ctx, srcPath, targetW, targetH, crop)
          .then(resolve)
          .catch(reject);
      });
  });
}

/**
 * 计算处理用的目标尺寸：等比缩放到最长边 ≤ PRECHECK.maxProcessEdge。
 *
 * @param {number} w 原图宽
 * @param {number} h 原图高
 * @returns {{ width, height, scale }}
 */
function calcProcessSize(w, h) {
  const maxEdge = PRECHECK.maxProcessEdge;
  const longest = Math.max(w, h);
  if (longest <= maxEdge) return { width: w, height: h, scale: 1 };

  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    scale,
  };
}

/**
 * 把归一化裁剪区域换算成「取景后原图」的像素尺寸。
 *
 * 关键点：裁剪会改变有效宽高比，而图纸的格点阵行数是由宽高比推导的
 * （deriveGrid 保持比例以免图像变形），所以取景后的尺寸才是
 * 后续预检与格点阵推导的依据，而不是整张原图的尺寸。
 *
 * @param {number} w 原图宽
 * @param {number} h 原图高
 * @param {object} [crop] {x, y, w, h} 归一化；缺省或非法时返回原尺寸
 * @returns {{ width, height }}
 */
function calcCroppedSize(w, h, crop) {
  if (!crop || !(crop.w > 0) || !(crop.h > 0)) return { width: w, height: h };
  return {
    width: Math.max(1, Math.round(w * crop.w)),
    height: Math.max(1, Math.round(h * crop.h)),
  };
}

/**
 * 完整载入流程：选图 → 校验 → 压缩 → 读像素
 *
 * @param {string} path
 * @param {number} size 文件体积（字节）
 * @param {object} [crop] 取景裁剪区域 {x,y,w,h}（归一化，相对原图）
 * @returns {Promise<{imageData, origin:{width,height}, process:{width,height}, compressed, crop}>}
 */
async function loadForProcessing(path, size, crop) {
  const check = validateImage(path, size);
  if (!check.valid) throw new Error(check.reason);

  const info = await getImageInfo(path);

  // 取景后的有效尺寸 —— 预检与格点阵推导都以它为准
  const cropped = calcCroppedSize(info.width, info.height, crop);
  const target = calcProcessSize(cropped.width, cropped.height);

  const imageData = await readPixels(path, target.width, target.height, crop);

  return {
    imageData,
    // origin 语义 = 「将要参与生图的那块画面」的尺寸
    origin: { width: cropped.width, height: cropped.height, path },
    source: { width: info.width, height: info.height, path },
    crop: crop || null,
    process: { width: target.width, height: target.height },
    compressed: target.scale < 1,
  };
}

/**
 * 保存临时文件到相册
 */
function saveToAlbum(filePath) {
  return new Promise((resolve, reject) => {
    wx.saveImageToPhotosAlbum({
      filePath,
      success: () => resolve(true),
      fail: (err) => {
        if (err.errMsg && err.errMsg.indexOf('auth') >= 0 ||
            err.errMsg && err.errMsg.indexOf('deny') >= 0) {
          reject({ needAuth: true, message: '需要相册权限才能保存图片' });
        } else if (err.errMsg && err.errMsg.indexOf('cancel') >= 0) {
          reject({ canceled: true });
        } else {
          reject(new Error('保存失败：' + (err.errMsg || '未知错误')));
        }
      },
    });
  });
}

module.exports = {
  chooseImage,
  validateImage,
  getImageInfo,
  readPixels,
  calcProcessSize,
  calcCroppedSize,
  loadForProcessing,
  saveToAlbum,
};