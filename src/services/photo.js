import { getNativeGps, isNativeApp } from './nativeApp.js';

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function loadDrawable(file) {
  if (!file || !file.type?.startsWith('image/')) {
    throw new Error('请选择图片文件');
  }

  if (globalThis.createImageBitmap) {
    try {
      return await withTimeout(createImageBitmap(file), 15000, '读取照片超时，请重拍或换一张照片');
    } catch {
      // Some mobile browsers expose createImageBitmap but fail on camera blobs.
    }
  }

  return withTimeout(new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('无法读取照片，请重拍或换一张照片'));
    };
    img.src = url;
  }), 15000, '读取照片超时，请重拍或换一张照片');
}

function closeDrawable(drawable) {
  if (drawable && typeof drawable.close === 'function') drawable.close();
}

export function getGps() {
  if (isNativeApp()) return getNativeGps();
  if (!navigator.geolocation || !globalThis.isSecureContext) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy
        }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 2500, maximumAge: 30000 }
    );
  });
}

export async function analyzeImage(file) {
  let drawable;
  try {
    drawable = await loadDrawable(file);
    const canvas = document.createElement('canvas');
    const size = 96;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return ['质量检测未完成'];
    ctx.drawImage(drawable, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);
    let brightness = 0;
    const grays = [];
    for (let i = 0; i < data.length; i += 4) {
      const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      brightness += gray;
      grays.push(gray);
    }
    brightness /= grays.length;
    let edgeEnergy = 0;
    for (let y = 1; y < size - 1; y += 1) {
      for (let x = 1; x < size - 1; x += 1) {
        const center = grays[y * size + x] * 4;
        const around =
          grays[y * size + x - 1] +
          grays[y * size + x + 1] +
          grays[(y - 1) * size + x] +
          grays[(y + 1) * size + x];
        edgeEnergy += Math.abs(center - around);
      }
    }
    edgeEnergy /= size * size;
    const warnings = [];
    if (drawable.width < 1000 || drawable.height < 750) warnings.push('分辨率偏低');
    if (brightness < 55) warnings.push('照片偏暗');
    if (edgeEnergy < 18) warnings.push('可能模糊');
    return warnings;
  } catch {
    return ['质量检测未完成'];
  } finally {
    closeDrawable(drawable);
  }
}

export async function fileToWatermarkedBlob(file, lines) {
  let drawable;
  try {
    drawable = await loadDrawable(file);
    const canvas = document.createElement('canvas');
    const maxWidth = 1600;
    const scale = Math.min(1, maxWidth / drawable.width);
    canvas.width = Math.max(1, Math.round(drawable.width * scale));
    canvas.height = Math.max(1, Math.round(drawable.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前浏览器无法处理照片画布');
    ctx.drawImage(drawable, 0, 0, canvas.width, canvas.height);
    const fontSize = Math.max(22, Math.round(canvas.width * 0.024));
    const padding = Math.round(fontSize * 0.75);
    const lineHeight = Math.round(fontSize * 1.35);
    const safeLines = (lines || []).filter(Boolean).slice(0, 7);
    const boxHeight = Math.min(canvas.height * 0.38, lineHeight * safeLines.length + padding * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.58)';
    ctx.fillRect(0, canvas.height - boxHeight, canvas.width, boxHeight);
    ctx.font = `${fontSize}px Arial, sans-serif`;
    ctx.fillStyle = '#fff';
    safeLines.forEach((line, index) => {
      ctx.fillText(String(line).slice(0, 70), padding, canvas.height - boxHeight + padding + lineHeight * (index + 0.75));
    });
    return await withTimeout(new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('无法生成水印照片'));
      }, 'image/jpeg', 0.88);
    }), 45000, '生成水印照片超时，请稍后在同步中心重试');
  } finally {
    closeDrawable(drawable);
  }
}
