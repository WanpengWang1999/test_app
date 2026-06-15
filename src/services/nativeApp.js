import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Geolocation } from '@capacitor/geolocation';
import { Network } from '@capacitor/network';

const PHOTO_DIR = 'queued-photos';

export function isNativeApp() {
  return Capacitor.isNativePlatform();
}

export async function takeNativePhoto() {
  const photo = await Camera.getPhoto({
    quality: 92,
    resultType: CameraResultType.Uri,
    source: CameraSource.Camera,
    correctOrientation: true,
    saveToGallery: false
  });
  const response = await fetch(photo.webPath || photo.path);
  const blob = await response.blob();
  const ext = photo.format ? `.${photo.format.replace(/^jpeg$/i, 'jpg')}` : '.jpg';
  return {
    blob,
    originalName: `photo-${Date.now()}${ext}`,
    previewUrl: URL.createObjectURL(blob)
  };
}

export async function saveNativeOriginal(blob, clientId, originalName = 'photo.jpg') {
  if (!isNativeApp()) return null;
  const ext = originalName.match(/\.[a-z0-9]+$/i)?.[0] || '.jpg';
  const path = `${PHOTO_DIR}/${clientId}${ext}`;
  await Filesystem.mkdir({ path: PHOTO_DIR, directory: Directory.Data, recursive: true }).catch(() => {});
  const data = await blobToBase64(blob);
  const result = await Filesystem.writeFile({ path, data, directory: Directory.Data, recursive: true });
  return { originalFilePath: path, originalFileUri: result.uri, originalSize: blob.size };
}

export async function readNativeOriginal(item) {
  if (item.originalBlob) return item.originalBlob;
  if (!item.originalFilePath) throw new Error('本地原图文件不存在，请删除该队列照片后重新拍摄。');
  const result = await Filesystem.readFile({ path: item.originalFilePath, directory: Directory.Data });
  return base64ToBlob(result.data, item.originalMimeType || 'image/jpeg');
}

export async function removeNativeOriginal(item) {
  if (!isNativeApp() || !item.originalFilePath) return;
  await Filesystem.deleteFile({ path: item.originalFilePath, directory: Directory.Data }).catch(() => {});
}

export async function getNativeGps() {
  if (!isNativeApp()) return null;
  try {
    const position = await Geolocation.getCurrentPosition({
      enableHighAccuracy: true,
      timeout: 3500,
      maximumAge: 30000
    });
    return {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: position.coords.accuracy
    };
  } catch {
    return null;
  }
}

export async function isNativeOnline() {
  if (!isNativeApp()) return navigator.onLine;
  const status = await Network.getStatus();
  return status.connected;
}

export function onNativeNetworkRestored(callback) {
  if (!isNativeApp()) return () => {};
  let handle;
  Network.addListener('networkStatusChange', (status) => {
    if (status.connected) callback();
  }).then((listener) => { handle = listener; });
  return () => handle?.remove?.();
}

export function onNativeAppForeground(callback) {
  if (!isNativeApp()) return () => {};
  let handle;
  CapacitorApp.addListener('appStateChange', (state) => {
    if (state.isActive) callback();
  }).then((listener) => { handle = listener; });
  return () => handle?.remove?.();
}

export function onNativeBackButton(callback) {
  if (!isNativeApp()) return () => {};
  let handle;
  CapacitorApp.addListener('backButton', () => {
    callback();
  }).then((listener) => { handle = listener; });
  return () => handle?.remove?.();
}

export function exitNativeApp() {
  if (!isNativeApp()) return;
  CapacitorApp.exitApp();
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function base64ToBlob(data, mimeType) {
  if (data instanceof Blob) return data;
  const value = String(data || '');
  const clean = value.includes(',') ? value.split(',').pop() : value;
  const response = await fetch(`data:${mimeType};base64,${clean}`);
  return response.blob();
}
