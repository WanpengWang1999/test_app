export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
export const WS_BASE_URL = (import.meta.env.VITE_WS_BASE_URL || '').replace(/\/$/, '');
export const TEST_API_BASE_URL = (import.meta.env.VITE_TEST_API_BASE_URL || 'http://114.55.109.150:3001').replace(/\/$/, '');
export const FIXED_CLOUD_API_BASE_URL = (import.meta.env.VITE_FIXED_API_BASE_URL || TEST_API_BASE_URL).replace(/\/$/, '');
const SERVER_CONFIG_KEY = 'server-config';

let token = '';
let runtimeApiBaseUrl = readSavedApiBaseUrl();

export function setAuthToken(nextToken) {
  token = nextToken || '';
}

export function getApiBaseUrl() {
  return runtimeApiBaseUrl || API_BASE_URL;
}

export function setApiBaseUrl(nextUrl) {
  if (isNativeRuntime() && !import.meta.env.DEV) {
    runtimeApiBaseUrl = FIXED_CLOUD_API_BASE_URL;
    return;
  }
  runtimeApiBaseUrl = normalizeBaseUrl(nextUrl);
  if (runtimeApiBaseUrl) {
    localStorage.setItem(SERVER_CONFIG_KEY, JSON.stringify({ apiBaseUrl: runtimeApiBaseUrl }));
  } else {
    localStorage.removeItem(SERVER_CONFIG_KEY);
  }
}

export function getSavedServerConfig() {
  return { apiBaseUrl: runtimeApiBaseUrl };
}

export function apiUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${getApiBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
}

export function assetUrl(path) {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  return `${getApiBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
}

export function wsUrl(path = '/ws') {
  if (WS_BASE_URL) return `${WS_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
  if (getApiBaseUrl()) {
    const url = new URL(getApiBaseUrl());
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = path;
    url.search = '';
    url.hash = '';
    return url.toString();
  }
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${location.host}${path}`;
}

function normalizeBaseUrl(value) {
  const text = String(value || '').trim().replace(/\/$/, '');
  if (!text) return '';
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function readSavedApiBaseUrl() {
  if (isNativeRuntime() && !import.meta.env.DEV) return FIXED_CLOUD_API_BASE_URL;
  try {
    const saved = JSON.parse(localStorage.getItem(SERVER_CONFIG_KEY) || '{}');
    return normalizeBaseUrl(saved.apiBaseUrl);
  } catch {
    return '';
  }
}

function isNativeRuntime() {
  return Boolean(window.Capacitor?.isNativePlatform?.());
}

export async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(apiUrl(path), { ...options, headers });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    throw new Error(data?.error || data || '请求失败');
  }
  return data;
}
