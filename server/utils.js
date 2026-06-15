import fs from 'node:fs';
import path from 'node:path';

export function sanitizeName(value, maxLength = 60) {
  const cleaned = String(value || '未命名')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, maxLength);
  return cleaned || '未命名';
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function publicPath(absPath, baseDir = path.join(process.cwd(), 'server', 'data')) {
  return path.relative(baseDir, absPath).replace(/\\/g, '/');
}

export function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

export function pick(row, key) {
  return key ? row[key] : undefined;
}

export function padSequence(value) {
  return String(value).padStart(2, '0');
}

export function downloadName(value) {
  return sanitizeName(value).replace(/_+/g, '_');
}

export function resolveUploadPath(uploadDir, storedPath) {
  return path.join(uploadDir, String(storedPath || '').replace(/^uploads[\\/]/, ''));
}
