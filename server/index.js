import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import archiver from 'archiver';
import {
  ROLE_COLLECTOR,
  ROLE_PROJECT_ADMIN,
  ROLE_SUPER_ADMIN,
  STATUS_ACTIVE,
  STATUS_DISABLED,
  STATUS_PENDING,
  STATUS_REJECTED,
  backupDir,
  dataDir,
  db,
  hashPassword,
  initDb,
  rowToUser,
  uploadDir
} from './db.js';
import {
  USER_STATUSES,
  canManageTargetRole,
  canSetUserStatus,
  normalizeUserStatus,
  registrationDefaults,
  shouldAllowLogin
} from './accountPolicy.js';
import { downloadName, ensureDir, hasValue, padSequence, parseJson, pick, publicPath, sanitizeName } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const tokens = new Map();
const RECYCLE_DAYS = 30;
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_SECRET = process.env.AUTH_SECRET || crypto.createHash('sha256').update(`telecom-photo:${dataDir}`).digest('hex');
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const BUILD_TIME = process.env.BUILD_TIME || new Date().toISOString();
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

initDb();

app.use(express.json({ limit: '2mb' }));

function isLanHost(hostname) {
  return hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  const configured = String(process.env.ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (configured.includes('*') || configured.includes(origin)) return true;
  try {
    return isLanHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/uploads', express.static(uploadDir));

app.get('/api/public/health', (_req, res) => {
  res.json({
    status: 'ok',
    serverOnline: true,
    now: new Date().toISOString(),
    publicBaseUrl: PUBLIC_BASE_URL,
    suggestedAppUrl: PUBLIC_BASE_URL || getLanAddresses(Number(process.env.PORT || 3001))[0] || '',
    lanUrls: getLanAddresses(Number(process.env.PORT || 3001))
  });
});

app.get('/api/diagnostics', auth, (req, res) => {
  let database = true;
  let uploadWritable = true;
  try {
    db.prepare('SELECT 1 AS ok').get();
  } catch {
    database = false;
  }
  try {
    const probe = path.join(uploadDir, `.write-test-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch {
    uploadWritable = false;
  }
  res.json({
    status: database && uploadWritable ? 'ok' : 'warning',
    user: {
      id: req.user.id,
      username: req.user.username,
      phone: req.user.phone,
      displayName: req.user.displayName,
      company: req.user.company,
      role: req.user.role,
      status: req.user.status
    },
    database,
    uploadWritable,
    dataDir,
    uploadDir,
    backupDir,
    publicBaseUrl: PUBLIC_BASE_URL,
    suggestedAppUrl: PUBLIC_BASE_URL || getLanAddresses(Number(process.env.PORT || 3001))[0] || '',
    serverTime: new Date().toISOString(),
    lanUrls: getLanAddresses(Number(process.env.PORT || 3001)),
    version: packageJson.version,
    buildTime: BUILD_TIME,
    apk: getApkInfo()
  });
});

function broadcast(type, payload) {
  const message = JSON.stringify({ type, payload });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(message);
  }
}

function displayPhotoType(type) {
  return type === 'extra' || type === '额外拍摄照片' ? '额外拍摄照片' : type;
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signPayload(payload) {
  return crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
}

function createToken(user) {
  const payload = base64UrlEncode(JSON.stringify({ uid: user.id, iat: Date.now() }));
  return `${payload}.${signPayload(payload)}`;
}

function readSignedToken(token) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature || signature !== signPayload(payload)) return null;
  const data = parseJson(base64UrlDecode(payload), null);
  if (!data?.uid || !data?.iat || Date.now() - Number(data.iat) > TOKEN_TTL_MS) return null;
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(data.uid));
  if (!shouldAllowLogin(row)) return null;
  return rowToUser(row);
}

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.token;
  const cachedUser = tokens.get(token);
  const freshRow = cachedUser ? db.prepare('SELECT * FROM users WHERE id = ?').get(cachedUser.id) : null;
  const user = shouldAllowLogin(freshRow) ? rowToUser(freshRow) : readSignedToken(token);
  if (!user) {
    if (token) tokens.delete(token);
    return res.status(401).json({ error: '未登录或登录已过期' });
  }
  req.user = user;
  next();
}

const isSuperAdmin = (user) => user?.role === ROLE_SUPER_ADMIN;
const isProjectAdmin = (user) => user?.role === ROLE_PROJECT_ADMIN;
const isCollector = (user) => user?.role === ROLE_COLLECTOR;
const canCreateProject = (user) => isSuperAdmin(user) || isProjectAdmin(user);
const VALID_ROLES = [ROLE_SUPER_ADMIN, ROLE_PROJECT_ADMIN, ROLE_COLLECTOR];

function activeSuperAdminCount() {
  return db.prepare('SELECT COUNT(*) AS count FROM users WHERE role = ? AND status = ? AND deleted_at IS NULL').get(ROLE_SUPER_ADMIN, STATUS_ACTIVE).count;
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\s+/g, '');
}

function validatePhone(phone) {
  return /^\d{6,20}$/.test(phone);
}

function selectUserRows(whereSql = '', params = []) {
  return db.prepare(`SELECT id, username, phone, display_name AS displayName, company, role, status,
      approved_by AS approvedBy, approved_at AS approvedAt, rejected_by AS rejectedBy, rejected_at AS rejectedAt,
      deleted_at AS deletedAt, created_at AS createdAt
    FROM users ${whereSql}
    ORDER BY status = 'pending' DESC, deleted_at IS NOT NULL, id`).all(...params);
}

function getUserById(id) {
  return db.prepare(`SELECT id, username, phone, display_name AS displayName, company, role, status,
      approved_by AS approvedBy, approved_at AS approvedAt, rejected_by AS rejectedBy, rejected_at AS rejectedAt,
      deleted_at AS deletedAt, created_at AS createdAt
    FROM users WHERE id = ?`).get(id);
}

function findLoginUser(identifier) {
  const login = String(identifier || '').trim();
  return db.prepare('SELECT * FROM users WHERE phone = ? OR username = ?').get(login, login);
}

function requireCanManageUser(actor, targetRole, res) {
  if (!isSuperAdmin(actor) && !isProjectAdmin(actor)) {
    res.status(403).json({ error: '需要管理员权限' });
    return false;
  }
  if (!canManageTargetRole(actor.role, targetRole)) {
    res.status(403).json({ error: '无权管理该账号' });
    return false;
  }
  return true;
}

function getProject(id) {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

function canManageProject(user, projectId) {
  if (isSuperAdmin(user)) return true;
  return isProjectAdmin(user);
}

function canViewProject(user, projectId) {
  return isSuperAdmin(user) || isProjectAdmin(user) || isCollector(user);
}

function requireSuperAdmin(req, res, next) {
  if (!isSuperAdmin(req.user)) return res.status(403).json({ error: '需要完全管理员权限' });
  next();
}

function requireProjectCreator(req, res, next) {
  if (!canCreateProject(req.user)) return res.status(403).json({ error: '需要管理员权限' });
  next();
}

function requireProjectManager(req, res, next) {
  const projectId = Number(req.params.id || req.params.projectId);
  if (!getProject(projectId)) return res.status(404).json({ error: '项目不存在' });
  if (!canManageProject(req.user, projectId)) return res.status(403).json({ error: '无权管理该项目' });
  next();
}

function requireProjectViewer(req, res, next) {
  const projectId = Number(req.params.id || req.params.projectId);
  if (!getProject(projectId)) return res.status(404).json({ error: '项目不存在' });
  if (!canViewProject(req.user, projectId)) return res.status(403).json({ error: '无权查看该项目' });
  next();
}

function readWorkbookRows(file) {
  const workbook = XLSX.read(file.buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}

function getTemplatePhotoTypes(deviceType) {
  const cleanType = String(deviceType || '通用').trim() || '通用';
  const rows = db.prepare('SELECT id, device_type AS deviceType, name, required, sort_order AS sortOrder FROM device_type_templates WHERE device_type = ? ORDER BY sort_order, id').all(cleanType);
  if (rows.length > 0) return rows;
  return db.prepare('SELECT id, device_type AS deviceType, name, required, sort_order AS sortOrder FROM device_type_templates WHERE device_type = ? ORDER BY sort_order, id').all('通用');
}

function insertDefaultPhotoTypesForDeviceType(projectId, deviceType) {
  const cleanType = String(deviceType || '通用').trim() || '通用';
  const insert = db.prepare('INSERT OR IGNORE INTO photo_types (project_id, device_type, name, required, sort_order) VALUES (?, ?, ?, ?, ?)');
  getTemplatePhotoTypes(cleanType).forEach((type, index) => insert.run(projectId, cleanType, type.name, type.required ? 1 : 0, type.sortOrder ?? index));
}

function insertDefaultPhotoTypes(projectId) {
  insertDefaultPhotoTypesForDeviceType(projectId, '通用');
}

function getTree(projectId) {
  const project = db.prepare('SELECT id, name, source_file_name AS sourceFileName, archived_at AS archivedAt FROM projects WHERE id = ?').get(projectId);
  if (!project) return null;
  const photoTypes = db.prepare('SELECT id, device_type AS deviceType, name, required, sort_order AS sortOrder FROM photo_types WHERE project_id = ? ORDER BY device_type, sort_order, id').all(projectId).map((row) => ({ ...row, required: Boolean(row.required) }));
  const taskRows = db.prepare(`SELECT id, name, is_temporary AS isTemporary, review_status AS reviewStatus,
      created_by AS createdBy, created_at AS createdAt
     FROM task_points WHERE project_id = ? ORDER BY name`).all(projectId).map((row) => ({ ...row, isTemporary: Boolean(row.isTemporary) }));
  const deviceStmt = db.prepare(`SELECT id, name, code, device_type AS deviceType, is_temporary AS isTemporary,
      review_status AS reviewStatus, created_by AS createdBy, created_at AS createdAt
     FROM device_positions WHERE task_point_id = ? ORDER BY name`);
  return { ...project, photoTypes, tasks: taskRows.map((task) => ({ ...task, devices: deviceStmt.all(task.id).map((row) => ({ ...row, isTemporary: Boolean(row.isTemporary) })) })) };
}

function getProgress(projectId) {
  const tree = getTree(projectId);
  if (!tree) return null;
  const countStmt = db.prepare(`
    SELECT photo_type AS photoType, COUNT(*) AS count
    FROM photo_records
    WHERE device_position_id = ? AND deleted_at IS NULL
    GROUP BY photo_type
  `);
  let totalDevices = 0;
  let completedDevices = 0;
  const tasks = tree.tasks.map((task) => {
    let taskCompleted = 0;
    const devices = task.devices.map((device) => {
      totalDevices += 1;
      const deviceType = device.deviceType || '通用';
      const requiredTypes = tree.photoTypes.filter((type) => type.required && type.deviceType === deviceType).map((type) => type.name);
      const counts = Object.fromEntries(countStmt.all(device.id).map((row) => [row.photoType, row.count]));
      const missingRequired = requiredTypes.filter((type) => !counts[type]);
      const completed = missingRequired.length === 0;
      if (completed) {
        completedDevices += 1;
        taskCompleted += 1;
      }
      return { ...device, counts, photoCount: Object.values(counts).reduce((sum, value) => sum + value, 0), missingRequired, completed };
    });
    return { id: task.id, name: task.name, isTemporary: Boolean(task.isTemporary), reviewStatus: task.reviewStatus, totalDevices: devices.length, completedDevices: taskCompleted, devices };
  });
  return { project: { id: tree.id, name: tree.name }, totalDevices, completedDevices, tasks };
}

function importRowsIntoProject({ projectId, fileName, fields, rows }) {
  const errors = [];
  let imported = 0;
  const deviceTypes = new Set();
  const taskStmt = db.prepare('INSERT OR IGNORE INTO task_points (project_id, name) VALUES (?, ?)');
  const getTaskStmt = db.prepare('SELECT id FROM task_points WHERE project_id = ? AND name = ?');
  const deviceStmt = db.prepare('INSERT OR IGNORE INTO device_positions (task_point_id, name, code, device_type) VALUES (?, ?, ?, ?)');

  rows.forEach((row, index) => {
    const taskName = String(pick(row, fields.taskPoint) || '').trim();
    const deviceName = String(pick(row, fields.devicePosition) || '').trim();
    const code = String(pick(row, fields.deviceCode) || deviceName).trim();
    const deviceType = String(pick(row, fields.deviceType) || '通用').trim() || '通用';
    if (!hasValue(taskName) || !hasValue(deviceName)) {
      errors.push(`第 ${index + 2} 行缺少任务点或设备位，已跳过`);
      return;
    }
    taskStmt.run(projectId, taskName);
    const task = getTaskStmt.get(projectId, taskName);
    deviceStmt.run(task.id, deviceName, code, deviceType);
    deviceTypes.add(deviceType);
    imported += 1;
  });

  for (const deviceType of deviceTypes) insertDefaultPhotoTypesForDeviceType(projectId, deviceType);
  db.prepare('UPDATE projects SET source_file_name = ? WHERE id = ?').run(fileName, projectId);
  return { imported, skipped: errors.length, errors, deviceTypes: [...deviceTypes] };
}

function previewImportRows({ fields, rows }) {
  const projectNames = new Set();
  const taskPoints = new Set();
  const deviceTypes = new Set();
  const deviceKeys = new Set();
  const duplicates = [];
  const errors = [];
  rows.forEach((row, index) => {
    const projectName = String(pick(row, fields.project) || '').trim();
    const taskName = String(pick(row, fields.taskPoint) || '').trim();
    const deviceName = String(pick(row, fields.devicePosition) || '').trim();
    const deviceType = String(pick(row, fields.deviceType) || '通用').trim() || '通用';
    if (projectName) projectNames.add(projectName);
    if (taskName) taskPoints.add(taskName);
    if (deviceType) deviceTypes.add(deviceType);
    if (!projectName || !taskName || !deviceName) {
      errors.push(`第 ${index + 2} 行缺少项目、任务点或设备位`);
      return;
    }
    const key = `${projectName}::${taskName}::${deviceName}`;
    if (deviceKeys.has(key)) duplicates.push(`第 ${index + 2} 行重复：${taskName}/${deviceName}`);
    deviceKeys.add(key);
  });
  const firstProjectName = [...projectNames][0] || '';
  return {
    projectName: firstProjectName,
    projectNames: [...projectNames],
    existingProject: firstProjectName ? db.prepare('SELECT id, name FROM projects WHERE name = ?').get(firstProjectName) || null : null,
    taskPointCount: taskPoints.size,
    deviceCount: deviceKeys.size,
    deviceTypes: [...deviceTypes],
    duplicateCount: duplicates.length,
    duplicates,
    errorCount: errors.length,
    errors,
    templateMatches: [...deviceTypes].map((deviceType) => ({ deviceType, photoTypes: getTemplatePhotoTypes(deviceType).map((type) => ({ name: type.name, required: Boolean(type.required) })) }))
  };
}

function photoSelectSql(includeDeleted = false) {
  return `SELECT p.id, p.file_name AS fileName, p.photo_type AS photoType, p.sequence,
    p.watermarked_path AS watermarkedPath, p.original_path AS originalPath,
    p.captured_at AS capturedAt, p.gps_lat AS gpsLat, p.gps_lng AS gpsLng,
    p.quality_warnings AS qualityWarnings, p.captured_by AS capturedById, u.display_name AS capturedBy,
    p.deleted_at AS deletedAt, p.deleted_by AS deletedById, du.display_name AS deletedBy, p.delete_reason AS deleteReason,
    t.id AS taskPointId, t.name AS taskPointName, t.is_temporary AS taskIsTemporary, t.review_status AS taskReviewStatus,
    d.id AS devicePositionId, d.name AS devicePositionName, d.device_type AS deviceType,
    d.is_temporary AS deviceIsTemporary, d.review_status AS deviceReviewStatus
   FROM photo_records p
   JOIN users u ON u.id = p.captured_by
   LEFT JOIN users du ON du.id = p.deleted_by
   JOIN task_points t ON t.id = p.task_point_id
   JOIN device_positions d ON d.id = p.device_position_id
   WHERE p.project_id = ? ${includeDeleted ? 'AND p.deleted_at IS NOT NULL' : 'AND p.deleted_at IS NULL'}`;
}

function mapPhoto(row) {
  return {
    ...row,
    taskIsTemporary: Boolean(row.taskIsTemporary),
    deviceIsTemporary: Boolean(row.deviceIsTemporary),
    qualityWarnings: parseJson(row.qualityWarnings, []) || []
  };
}

function listProjectPhotos(projectId, { taskPointId = null, deleted = false } = {}) {
  const params = [projectId];
  let sql = photoSelectSql(deleted);
  if (taskPointId) {
    sql += ' AND p.task_point_id = ?';
    params.push(taskPointId);
  }
  sql += ' ORDER BY p.sequence DESC, p.created_at DESC, p.id DESC';
  return db.prepare(sql).all(...params).map(mapPhoto);
}

function getExportCheck(projectId, localPendingCount = 0) {
  const progress = getProgress(projectId);
  if (!progress) return null;
  const photos = listProjectPhotos(projectId);
  const recycleCount = db.prepare('SELECT COUNT(*) AS count FROM photo_records WHERE project_id = ? AND deleted_at IS NOT NULL').get(projectId).count;
  const missingDevices = progress.tasks.flatMap((task) =>
    task.devices.filter((device) => !device.completed).map((device) => ({
      taskPointId: task.id,
      taskPointName: task.name,
      devicePositionName: device.name,
      deviceType: device.deviceType,
      missingRequired: device.missingRequired
    }))
  );
  const qualityWarnings = photos.filter((photo) => photo.qualityWarnings.length > 0);
  const noGps = photos.filter((photo) => photo.gpsLat === null || photo.gpsLng === null);
  const temporaryTaskPoints = progress.tasks.filter((task) => task.isTemporary);
  const temporaryDevices = progress.tasks.flatMap((task) => task.devices.filter((device) => device.isTemporary).map((device) => ({ ...device, taskPointId: task.id, taskPointName: task.name })));
  const pendingTemporaryTaskPoints = temporaryTaskPoints.filter((task) => task.reviewStatus !== 'approved');
  const pendingTemporaryDevices = temporaryDevices.filter((device) => device.reviewStatus !== 'approved');
  return {
    progress,
    totalPhotos: photos.length,
    missingDevices,
    qualityWarnings,
    noGps,
    recycleCount,
    localPendingCount,
    temporaryTaskPoints,
    temporaryDevices,
    pendingTemporaryTaskPoints,
    pendingTemporaryDevices,
    ready: missingDevices.length === 0 && localPendingCount === 0 && pendingTemporaryTaskPoints.length === 0 && pendingTemporaryDevices.length === 0
  };
}

function appendDirToArchive(archive, sourceDir, archiveRoot) {
  if (!fs.existsSync(sourceDir)) return;
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(archiveRoot, entry.name).replace(/\\/g, '/');
    if (entry.isDirectory()) appendDirToArchive(archive, source, target);
    else archive.file(source, { name: target });
  }
}

function createBackupFile(reason = 'manual') {
  ensureDir(backupDir);
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const fileName = `telecom-photo-backup-${reason}-${stamp}.zip`;
  const filePath = path.join(backupDir, fileName);
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(filePath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolve({ fileName, filePath }));
    archive.on('error', reject);
    archive.pipe(output);
    const dbPath = path.join(dataDir, 'app.sqlite');
    if (fs.existsSync(dbPath)) archive.file(dbPath, { name: 'app.sqlite' });
    appendDirToArchive(archive, uploadDir, 'uploads');
    archive.append(JSON.stringify({ createdAt: new Date().toISOString(), reason, dataDir, uploadDir }, null, 2), { name: 'backup-manifest.json' });
    archive.finalize();
  });
}

function readZipEntries(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 30 < buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + fileNameLength + extraLength;
    const name = buffer.slice(nameStart, nameStart + fileNameLength).toString('utf8').replace(/\\/g, '/');
    if (flags & 0x08) throw new Error('不支持带数据描述符的 ZIP 备份，请使用系统内置备份文件。');
    const compressed = buffer.slice(dataStart, dataStart + compressedSize);
    if (!name.endsWith('/')) {
      if (method === 0) entries.set(name, compressed);
      else if (method === 8) entries.set(name, zlib.inflateRawSync(compressed));
      else throw new Error(`不支持的 ZIP 压缩方式：${method}`);
    }
    offset = dataStart + compressedSize;
  }
  return entries;
}

function safeClearDirectory(dir) {
  ensureDir(dir);
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

function getLanAddresses(port) {
  const items = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family === 'IPv4' && !item.internal) items.push(`http://${item.address}:${port}`);
    }
  }
  return items;
}

function getApkInfo() {
  const apkPath = path.join(__dirname, '..', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  if (!fs.existsSync(apkPath)) return { available: false, path: apkPath };
  const stat = fs.statSync(apkPath);
  return {
    available: true,
    path: apkPath,
    fileName: '工程照片采集-debug.apk',
    size: stat.size,
    updatedAt: stat.mtime.toISOString()
  };
}

function listBackupFiles() {
  ensureDir(backupDir);
  return fs.readdirSync(backupDir)
    .filter((name) => /\.zip$/i.test(name))
    .map((name) => {
      const filePath = path.join(backupDir, name);
      const stat = fs.statSync(filePath);
      return { fileName: name, size: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 20);
}

async function buildImportTemplate() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '通信工程照片采集系统';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('设备导入模板');
  sheet.columns = [
    { header: '项目', key: 'project', width: 24 },
    { header: '任务点', key: 'taskPoint', width: 24 },
    { header: '设备位', key: 'devicePosition', width: 28 },
    { header: '设备编号', key: 'deviceCode', width: 18 },
    { header: '设备类型', key: 'deviceType', width: 16 },
    { header: '备注', key: 'remark', width: 28 }
  ];
  sheet.addRows([
    { project: '示例项目', taskPoint: 'A区基站机房', devicePosition: '机柜01-BBU01', deviceCode: 'BBU01', deviceType: 'BBU', remark: '设备类型会匹配必拍照片模板' },
    { project: '示例项目', taskPoint: 'A区基站机房', devicePosition: '机柜01-RRU01', deviceCode: 'RRU01', deviceType: 'RRU', remark: '同一任务点下设备位不要重名' },
    { project: '示例项目', taskPoint: 'B区楼顶抱杆', devicePosition: '抱杆01-天线01', deviceCode: 'ANT01', deviceType: '天线', remark: '项目名称由本列读取' }
  ]);
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF126B5A' } };
  sheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
  sheet.getRow(1).height = 24;
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = 'A1:F1';
  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFD5DED9' } },
        left: { style: 'thin', color: { argb: 'FFD5DED9' } },
        bottom: { style: 'thin', color: { argb: 'FFD5DED9' } },
        right: { style: 'thin', color: { argb: 'FFD5DED9' } }
      };
      cell.alignment = { vertical: 'middle', wrapText: true };
    });
  });

  const help = workbook.addWorksheet('填写说明');
  help.columns = [{ width: 22 }, { width: 72 }];
  help.addRows([
    ['字段', '说明'],
    ['项目', '必填。导入时系统会读取此列作为项目名称；同一个文件建议只填写一个项目。'],
    ['任务点', '必填。一个项目下可以有多个任务点，例如机房、楼顶、站点。'],
    ['设备位', '必填。一个任务点下设备位名称不能重复。'],
    ['设备编号', '选填。为空时默认使用设备位名称。'],
    ['设备类型', '建议填写。常用值：BBU、RRU、天线、通用；系统会按设备类型匹配必拍照片类型。'],
    ['备注', '选填。导入时不会作为核心字段使用。']
  ]);
  help.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  help.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF126B5A' } };
  help.eachRow((row) => {
    row.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFD5DED9' } },
        left: { style: 'thin', color: { argb: 'FFD5DED9' } },
        bottom: { style: 'thin', color: { argb: 'FFD5DED9' } },
        right: { style: 'thin', color: { argb: 'FFD5DED9' } }
      };
      cell.alignment = { vertical: 'middle', wrapText: true };
    });
  });

  return workbook.xlsx.writeBuffer();
}

app.post('/api/auth/register', (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const displayName = String(req.body.displayName || '').trim();
  const company = String(req.body.company || '').trim();
  const password = String(req.body.password || '');
  if (!validatePhone(phone)) return res.status(400).json({ error: '请输入有效手机号' });
  if (!displayName || !company || password.length < 6) return res.status(400).json({ error: '姓名、工作单位和至少 6 位密码不能为空' });
  const defaults = registrationDefaults();
  try {
    const result = db.prepare(`INSERT INTO users (username, phone, password_hash, display_name, company, role, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(phone, phone, hashPassword(password), displayName, company, defaults.role, defaults.status);
    res.status(201).json({ id: result.lastInsertRowid, status: defaults.status, role: defaults.role });
  } catch {
    res.status(409).json({ error: '手机号已注册' });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  const identifier = req.body.phone || req.body.username;
  const row = findLoginUser(identifier);
  if (!row || row.password_hash !== hashPassword(password)) return res.status(401).json({ error: '手机号或密码错误' });
  const status = normalizeUserStatus(row.status);
  if (!shouldAllowLogin(row)) {
    if (status === STATUS_PENDING) return res.status(403).json({ error: '账号待管理员审批后才能登录' });
    if (status === STATUS_REJECTED) return res.status(403).json({ error: '账号注册申请已被拒绝' });
    if (status === STATUS_DISABLED || row.deleted_at) return res.status(403).json({ error: '账号已停用' });
    return res.status(403).json({ error: '账号状态异常' });
  }
  const user = rowToUser(row);
  const token = createToken(user);
  tokens.set(token, user);
  res.json({ token, user });
});

app.get('/api/users', auth, (req, res) => {
  if (!isSuperAdmin(req.user) && !isProjectAdmin(req.user)) return res.status(403).json({ error: '需要管理员权限' });
  const users = isSuperAdmin(req.user)
    ? selectUserRows()
    : selectUserRows('WHERE role = ? OR id = ?', [ROLE_COLLECTOR, req.user.id]);
  res.json({ users });
});

app.post('/api/users', auth, (req, res) => {
  const phone = normalizePhone(req.body.phone || req.body.username);
  const password = String(req.body.password || '');
  const displayName = String(req.body.displayName || '').trim();
  const company = String(req.body.company || '').trim();
  const role = String(req.body.role || ROLE_COLLECTOR);
  const status = USER_STATUSES.includes(req.body.status) ? req.body.status : STATUS_ACTIVE;
  if (!validatePhone(phone) || !password || !displayName || !company || !VALID_ROLES.includes(role)) return res.status(400).json({ error: '用户信息不完整' });
  if (!isSuperAdmin(req.user) && !isProjectAdmin(req.user)) return res.status(403).json({ error: '需要管理员权限' });
  if (!canManageTargetRole(req.user.role, role)) return res.status(403).json({ error: '无权创建该角色账号' });
  try {
    const now = new Date().toISOString();
    const result = db.prepare(`INSERT INTO users
      (username, phone, password_hash, display_name, company, role, status, approved_by, approved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(phone, phone, hashPassword(password), displayName, company, role, status, status === STATUS_ACTIVE ? req.user.id : null, status === STATUS_ACTIVE ? now : null);
    res.status(201).json({ id: result.lastInsertRowid });
  } catch {
    res.status(409).json({ error: '手机号已存在' });
  }
});

app.patch('/api/users/:id', auth, (req, res) => {
  const userId = Number(req.params.id);
  const target = getUserById(userId);
  if (!target) return res.status(404).json({ error: '账号不存在' });
  const nextRole = String(req.body.role || target.role);
  if (!VALID_ROLES.includes(nextRole)) return res.status(400).json({ error: '角色无效' });
  if (!requireCanManageUser(req.user, target.role, res)) return;
  if (nextRole !== target.role && !canManageTargetRole(req.user.role, nextRole)) return res.status(403).json({ error: '无权设置该角色' });
  if (target.role === ROLE_SUPER_ADMIN && nextRole !== ROLE_SUPER_ADMIN && normalizeUserStatus(target.status) === STATUS_ACTIVE && activeSuperAdminCount() <= 1) {
    return res.status(400).json({ error: '至少需要保留一个已启用的完全管理员账号' });
  }
  const phone = normalizePhone(req.body.phone ?? target.phone ?? target.username);
  const displayName = String(req.body.displayName ?? target.displayName ?? '').trim();
  const company = String(req.body.company ?? target.company ?? '').trim();
  if (!validatePhone(phone) || !displayName || !company) return res.status(400).json({ error: '手机号、姓名和工作单位不能为空' });
  try {
    db.prepare('UPDATE users SET username = ?, phone = ?, display_name = ?, company = ?, role = ? WHERE id = ?')
      .run(phone, phone, displayName, company, nextRole, userId);
    res.json({ user: getUserById(userId) });
  } catch {
    res.status(409).json({ error: '手机号已存在' });
  }
});

app.patch('/api/users/:id/status', auth, (req, res) => {
  const userId = Number(req.params.id);
  const target = getUserById(userId);
  if (!target) return res.status(404).json({ error: '账号不存在' });
  const nextStatus = String(req.body.status || '');
  const decision = canSetUserStatus({
    actorRole: req.user.role,
    targetRole: target.role,
    nextStatus,
    activeSuperAdminCount: activeSuperAdminCount(),
    isSelf: target.id === req.user.id
  });
  if (!decision.allowed) return res.status(403).json({ error: decision.error });
  const now = new Date().toISOString();
  const fields = {
    approvedBy: null,
    approvedAt: null,
    rejectedBy: null,
    rejectedAt: null
  };
  if (nextStatus === STATUS_ACTIVE) {
    fields.approvedBy = req.user.id;
    fields.approvedAt = now;
  }
  if (nextStatus === STATUS_REJECTED) {
    fields.rejectedBy = req.user.id;
    fields.rejectedAt = now;
  }
  db.prepare(`UPDATE users SET status = ?, approved_by = ?, approved_at = ?, rejected_by = ?, rejected_at = ?
    WHERE id = ?`).run(nextStatus, fields.approvedBy, fields.approvedAt, fields.rejectedBy, fields.rejectedAt, userId);
  if (nextStatus !== STATUS_ACTIVE) {
    for (const [token, user] of tokens.entries()) {
      if (user.id === userId) tokens.delete(token);
    }
  }
  res.json({ user: getUserById(userId) });
});

app.post('/api/users/:id/reset-password', auth, (req, res) => {
  const userId = Number(req.params.id);
  const password = String(req.body.password || '');
  if (password.length < 6) return res.status(400).json({ error: '密码至少需要 6 位' });
  const target = getUserById(userId);
  if (!target) return res.status(404).json({ error: '账号不存在' });
  if (!requireCanManageUser(req.user, target.role, res)) return;
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), userId);
  for (const [token, user] of tokens.entries()) {
    if (user.id === userId) tokens.delete(token);
  }
  res.json({ ok: true });
});

app.delete('/api/users/:id', auth, (req, res) => {
  if (!isSuperAdmin(req.user) && !isProjectAdmin(req.user)) return res.status(403).json({ error: '需要管理员权限' });
  const userId = Number(req.params.id);
  const target = getUserById(userId);
  if (!target) return res.status(404).json({ error: '账号不存在' });
  if (target.id === req.user.id) return res.status(400).json({ error: '不能删除当前登录账号' });
  if (target.deletedAt) return res.json({ ok: true, deletedAt: target.deletedAt });
  if (!requireCanManageUser(req.user, target.role, res)) return;
  if (target.role === ROLE_SUPER_ADMIN && normalizeUserStatus(target.status) === STATUS_ACTIVE) {
    if (activeSuperAdminCount() <= 1) return res.status(400).json({ error: '至少需要保留一个已启用的完全管理员账号' });
  }
  const deletedAt = new Date().toISOString();
  db.prepare('UPDATE users SET deleted_at = ?, status = ? WHERE id = ?').run(deletedAt, STATUS_DISABLED, userId);
  for (const [token, user] of tokens.entries()) {
    if (user.id === userId) tokens.delete(token);
  }
  res.json({ ok: true, deletedAt });
});

app.get('/api/templates', auth, (_req, res) => {
  const templates = db.prepare('SELECT id, device_type AS deviceType, name, required, sort_order AS sortOrder FROM device_type_templates ORDER BY device_type, sort_order, id').all().map((row) => ({ ...row, required: Boolean(row.required) }));
  res.json({ templates });
});

app.post('/api/templates', auth, requireSuperAdmin, (req, res) => {
  const deviceType = String(req.body.deviceType || '').trim();
  const name = String(req.body.name || '').trim();
  const required = req.body.required === false ? 0 : 1;
  if (!deviceType || !name) return res.status(400).json({ error: '设备类型和照片类型不能为空' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS value FROM device_type_templates WHERE device_type = ?').get(deviceType).value;
  try {
    const result = db.prepare('INSERT INTO device_type_templates (device_type, name, required, sort_order) VALUES (?, ?, ?, ?)').run(deviceType, name, required, maxOrder + 1);
    res.status(201).json({ id: result.lastInsertRowid, deviceType, name, required: Boolean(required) });
  } catch {
    res.status(409).json({ error: '模板照片类型已存在' });
  }
});

app.delete('/api/templates/:id', auth, requireSuperAdmin, (req, res) => {
  const result = db.prepare('DELETE FROM device_type_templates WHERE id = ?').run(Number(req.params.id));
  if (result.changes === 0) return res.status(404).json({ error: '模板不存在' });
  res.json({ deleted: true });
});

app.get('/api/projects', auth, (req, res) => {
  const includeArchived = req.query.includeArchived === '1' || !isCollector(req.user);
  const archiveFilter = includeArchived ? '' : 'p.archived_at IS NULL';
  const baseSql = `SELECT p.id, p.name, p.source_file_name AS sourceFileName, p.created_by AS createdBy,
      p.created_at AS createdAt, p.archived_at AS archivedAt, p.archived_by AS archivedBy,
      u.display_name AS createdByName,
      COUNT(DISTINCT t.id) AS taskCount, COUNT(DISTINCT d.id) AS deviceCount
     FROM projects p
     LEFT JOIN users u ON u.id = p.created_by
     LEFT JOIN task_points t ON t.project_id = p.id
     LEFT JOIN device_positions d ON d.task_point_id = t.id`;
  const groupSql = ' GROUP BY p.id ORDER BY p.created_at DESC';
  let projects;
  projects = db.prepare(`${baseSql}${archiveFilter ? ` WHERE ${archiveFilter}` : ''}${groupSql}`).all();
  res.json({ projects });
});

app.post('/api/projects', auth, requireProjectCreator, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '项目名称不能为空' });
  try {
    const result = db.prepare('INSERT INTO projects (name, created_by) VALUES (?, ?)').run(name, req.user.id);
    insertDefaultPhotoTypes(result.lastInsertRowid);
    broadcast('project:created', { id: result.lastInsertRowid });
    res.status(201).json({ id: result.lastInsertRowid, name });
  } catch {
    res.status(409).json({ error: '项目名称已存在' });
  }
});

app.patch('/api/projects/:id', auth, requireProjectManager, (req, res) => {
  const id = Number(req.params.id);
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '项目名称不能为空' });
  try {
    db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id);
    broadcast('project:updated', { id });
    res.json({ id, name });
  } catch {
    res.status(409).json({ error: '项目名称已存在' });
  }
});

app.patch('/api/projects/:id/archive', auth, requireProjectManager, (req, res) => {
  const id = Number(req.params.id);
  const archived = req.body?.archived !== false;
  if (archived) {
    db.prepare('UPDATE projects SET archived_at = ?, archived_by = ? WHERE id = ?').run(new Date().toISOString(), req.user.id, id);
  } else {
    db.prepare('UPDATE projects SET archived_at = NULL, archived_by = NULL WHERE id = ?').run(id);
  }
  broadcast('project:archived', { id, archived });
  res.json({ id, archived });
});

app.delete('/api/projects/:id', auth, requireProjectManager, (req, res) => {
  const id = Number(req.params.id);
  const project = getProject(id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  const projectDir = path.join(uploadDir, sanitizeName(project.name));
  if (fs.existsSync(projectDir)) fs.rmSync(projectDir, { recursive: true, force: true });
  broadcast('project:deleted', { id });
  res.json({ deleted: true });
});

app.post('/api/projects/:id/cleanup', auth, requireSuperAdmin, async (req, res) => {
  const projectId = Number(req.params.id);
  const project = getProject(projectId);
  const kind = String(req.body?.kind || '').trim();
  if (!['recycle', 'photos', 'devices', 'all'].includes(kind)) return res.status(400).json({ error: '清理类型无效' });
  try {
    const safety = await createBackupFile(`cleanup-${projectId}-${kind}`);
    const rows = db.prepare('SELECT id, original_path AS originalPath, watermarked_path AS watermarkedPath FROM photo_records WHERE project_id = ?').all(projectId);
    const activeRows = rows.filter((row) => {
      if (kind === 'recycle') {
        return db.prepare('SELECT deleted_at AS deletedAt FROM photo_records WHERE id = ?').get(row.id)?.deletedAt;
      }
      return true;
    });
    for (const row of activeRows) {
      for (const rel of [row.originalPath, row.watermarkedPath]) {
        const abs = path.join(dataDir, rel || '');
        if (rel && fs.existsSync(abs)) fs.unlinkSync(abs);
      }
    }
    let deletedPhotos = 0;
    let deletedTasks = 0;
    if (kind === 'recycle') {
      deletedPhotos = db.prepare('DELETE FROM photo_records WHERE project_id = ? AND deleted_at IS NOT NULL').run(projectId).changes;
    } else if (kind === 'photos') {
      deletedPhotos = db.prepare('DELETE FROM photo_records WHERE project_id = ?').run(projectId).changes;
      const projectDir = path.join(uploadDir, sanitizeName(project.name));
      if (fs.existsSync(projectDir)) fs.rmSync(projectDir, { recursive: true, force: true });
    } else if (kind === 'devices' || kind === 'all') {
      deletedPhotos = db.prepare('DELETE FROM photo_records WHERE project_id = ?').run(projectId).changes;
      deletedTasks = db.prepare('DELETE FROM task_points WHERE project_id = ?').run(projectId).changes;
      db.prepare('DELETE FROM photo_types WHERE project_id = ?').run(projectId);
      const projectDir = path.join(uploadDir, sanitizeName(project.name));
      if (fs.existsSync(projectDir)) fs.rmSync(projectDir, { recursive: true, force: true });
      if (kind === 'all') db.prepare('UPDATE projects SET source_file_name = NULL WHERE id = ?').run(projectId);
    }
    broadcast('project:cleanup', { projectId, kind });
    res.json({ cleaned: true, kind, deletedPhotos, deletedTasks, backupFile: safety.fileName });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/projects/:id/members', auth, requireProjectManager, (req, res) => {
  const members = db.prepare(`SELECT pm.id, pm.project_id AS projectId, pm.user_id AS userId, pm.role, pm.created_at AS createdAt,
      u.username, u.display_name AS displayName, u.role AS userRole
     FROM project_members pm JOIN users u ON u.id = pm.user_id
     WHERE pm.project_id = ? ORDER BY pm.created_at DESC, pm.id DESC`).all(Number(req.params.id));
  res.json({ members });
});

app.post('/api/projects/:id/members', auth, requireSuperAdmin, (req, res) => {
  const projectId = Number(req.params.id);
  const userId = Number(req.body.userId);
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
  if (!getProject(projectId)) return res.status(404).json({ error: '项目不存在' });
  if (!user || user.role !== ROLE_PROJECT_ADMIN) return res.status(400).json({ error: '只能授权给项目管理员账号' });
  const result = db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id, role, created_by) VALUES (?, ?, ?, ?)').run(projectId, userId, 'project_manager', req.user.id);
  broadcast('project:member-updated', { projectId });
  res.status(result.changes ? 201 : 200).json({ projectId, userId, role: 'project_manager' });
});

app.delete('/api/projects/:projectId/members/:userId', auth, requireSuperAdmin, (req, res) => {
  const result = db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(Number(req.params.projectId), Number(req.params.userId));
  if (result.changes === 0) return res.status(404).json({ error: '授权不存在' });
  broadcast('project:member-updated', { projectId: Number(req.params.projectId) });
  res.json({ deleted: true });
});

app.post('/api/projects/import-preview', auth, requireProjectCreator, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传 Excel 文件' });
  const fields = parseJson(req.body.fields || '{}', {});
  if (!fields.project || !fields.taskPoint || !fields.devicePosition) return res.status(400).json({ error: '项目、任务点、设备位列不能为空' });
  res.json(previewImportRows({ fields, rows: readWorkbookRows(req.file) }));
});

app.get('/api/projects/import-template', auth, requireProjectCreator, async (_req, res) => {
  const buffer = await buildImportTemplate();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent('设备导入模板.xlsx')}"`);
  res.end(Buffer.from(buffer));
});

app.post('/api/projects/import-excel', auth, requireProjectCreator, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传 Excel 文件' });
  const fields = parseJson(req.body.fields || '{}', {});
  const rows = readWorkbookRows(req.file);
  const firstProjectName = rows.map((row) => String(pick(row, fields.project) || '').trim()).find(Boolean);
  if (!firstProjectName) return res.status(400).json({ error: 'Excel 中未找到项目名称' });
  let project = db.prepare('SELECT id, name FROM projects WHERE name = ?').get(firstProjectName);
  if (project && !canManageProject(req.user, project.id)) return res.status(403).json({ error: '无权向该项目追加导入' });
  try {
    db.exec('BEGIN');
    if (!project) {
      const result = db.prepare('INSERT INTO projects (name, created_by, source_file_name) VALUES (?, ?, ?)').run(firstProjectName, req.user.id, req.file.originalname);
      project = { id: result.lastInsertRowid, name: firstProjectName };
    }
    const imported = importRowsIntoProject({ projectId: project.id, fileName: req.file.originalname, fields, rows });
    db.exec('COMMIT');
    broadcast('project:imported', { id: project.id });
    res.status(201).json({ project, ...imported });
  } catch (error) {
    db.exec('ROLLBACK');
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/projects/:id/tree', auth, requireProjectViewer, (req, res) => res.json(getTree(Number(req.params.id))));
app.get('/api/projects/:id/progress', auth, requireProjectViewer, (req, res) => res.json(getProgress(Number(req.params.id))));

app.post('/api/projects/:id/task-points', auth, requireProjectViewer, (req, res) => {
  const projectId = Number(req.params.id);
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: '任务点名称不能为空' });
  const reviewStatus = canManageProject(req.user, projectId) ? 'approved' : 'pending';
  try {
    const result = db.prepare('INSERT INTO task_points (project_id, name, is_temporary, review_status, created_by) VALUES (?, ?, 1, ?, ?)').run(projectId, name, reviewStatus, req.user.id);
    const taskPoint = db.prepare('SELECT id, name, is_temporary AS isTemporary, review_status AS reviewStatus FROM task_points WHERE id = ?').get(result.lastInsertRowid);
    taskPoint.isTemporary = Boolean(taskPoint.isTemporary);
    broadcast('task-point:created', { projectId, taskPointId: taskPoint.id });
    res.status(201).json({ taskPoint });
  } catch {
    res.status(409).json({ error: '该项目下已存在同名任务点' });
  }
});

app.post('/api/projects/:id/task-points/:taskPointId/devices', auth, requireProjectViewer, (req, res) => {
  const projectId = Number(req.params.id);
  const taskPointId = Number(req.params.taskPointId);
  const taskPoint = db.prepare('SELECT id, name FROM task_points WHERE id = ? AND project_id = ?').get(taskPointId, projectId);
  if (!taskPoint) return res.status(404).json({ error: '任务点不存在' });
  const name = String(req.body?.name || '').trim();
  const code = String(req.body?.code || name).trim() || name;
  const deviceType = String(req.body?.deviceType || '通用').trim() || '通用';
  if (!name) return res.status(400).json({ error: '设备位名称不能为空' });
  const reviewStatus = canManageProject(req.user, projectId) ? 'approved' : 'pending';
  try {
    const result = db.prepare('INSERT INTO device_positions (task_point_id, name, code, device_type, is_temporary, review_status, created_by) VALUES (?, ?, ?, ?, 1, ?, ?)').run(taskPointId, name, code, deviceType, reviewStatus, req.user.id);
    insertDefaultPhotoTypesForDeviceType(projectId, deviceType);
    const device = db.prepare('SELECT id, name, code, device_type AS deviceType, is_temporary AS isTemporary, review_status AS reviewStatus FROM device_positions WHERE id = ?').get(result.lastInsertRowid);
    device.isTemporary = Boolean(device.isTemporary);
    broadcast('device-position:created', { projectId, taskPointId, devicePositionId: device.id });
    res.status(201).json({ device });
  } catch {
    res.status(409).json({ error: '该任务点下已存在同名设备位' });
  }
});

app.post('/api/projects/:id/task-points/:taskPointId/approve', auth, requireProjectManager, (req, res) => {
  const projectId = Number(req.params.id);
  const taskPointId = Number(req.params.taskPointId);
  const result = db.prepare("UPDATE task_points SET review_status = 'approved' WHERE id = ? AND project_id = ? AND is_temporary = 1").run(taskPointId, projectId);
  if (result.changes === 0) return res.status(404).json({ error: '现场补录任务点不存在' });
  broadcast('task-point:approved', { projectId, taskPointId });
  res.json({ approved: true });
});

app.post('/api/projects/:id/devices/:deviceId/approve', auth, requireProjectManager, (req, res) => {
  const projectId = Number(req.params.id);
  const deviceId = Number(req.params.deviceId);
  const result = db.prepare(`UPDATE device_positions
    SET review_status = 'approved'
    WHERE id = ? AND is_temporary = 1 AND task_point_id IN (SELECT id FROM task_points WHERE project_id = ?)`).run(deviceId, projectId);
  if (result.changes === 0) return res.status(404).json({ error: '现场补录设备位不存在' });
  broadcast('device-position:approved', { projectId, deviceId });
  res.json({ approved: true });
});

app.post('/api/projects/:id/import-excel', auth, requireProjectManager, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传 Excel 文件' });
  const fields = parseJson(req.body.fields || '{}', {});
  const rows = readWorkbookRows(req.file);
  try {
    db.exec('BEGIN');
    const imported = importRowsIntoProject({ projectId: Number(req.params.id), fileName: req.file.originalname, fields, rows });
    db.exec('COMMIT');
    broadcast('project:imported', { id: Number(req.params.id) });
    res.json(imported);
  } catch (error) {
    db.exec('ROLLBACK');
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/projects/:id/photo-types', auth, requireProjectViewer, (req, res) => {
  const rows = db.prepare('SELECT id, device_type AS deviceType, name, required, sort_order AS sortOrder FROM photo_types WHERE project_id = ? ORDER BY device_type, sort_order, id').all(Number(req.params.id)).map((row) => ({ ...row, required: Boolean(row.required) }));
  res.json({ photoTypes: rows });
});

app.post('/api/projects/:id/photo-types', auth, requireProjectManager, (req, res) => {
  const projectId = Number(req.params.id);
  const name = String(req.body.name || '').trim();
  const deviceType = String(req.body.deviceType || '通用').trim() || '通用';
  if (!name) return res.status(400).json({ error: '照片类型不能为空' });
  const required = req.body.required === false ? 0 : 1;
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS value FROM photo_types WHERE project_id = ? AND device_type = ?').get(projectId, deviceType).value;
  try {
    const result = db.prepare('INSERT INTO photo_types (project_id, device_type, name, required, sort_order) VALUES (?, ?, ?, ?, ?)').run(projectId, deviceType, name, required, maxOrder + 1);
    broadcast('photo-type:created', { projectId });
    res.status(201).json({ id: result.lastInsertRowid, deviceType, name, required: Boolean(required) });
  } catch {
    res.status(409).json({ error: '照片类型已存在' });
  }
});

app.delete('/api/projects/:projectId/photo-types/:typeId', auth, requireProjectManager, (req, res) => {
  const result = db.prepare('DELETE FROM photo_types WHERE id = ? AND project_id = ?').run(Number(req.params.typeId), Number(req.params.projectId));
  if (result.changes === 0) return res.status(404).json({ error: '照片类型不存在' });
  broadcast('photo-type:deleted', { projectId: Number(req.params.projectId), typeId: Number(req.params.typeId) });
  res.json({ deleted: true });
});

app.post('/api/photos', auth, upload.fields([{ name: 'original', maxCount: 1 }, { name: 'watermarked', maxCount: 1 }]), (req, res) => {
  const original = req.files?.original?.[0];
  const watermarked = req.files?.watermarked?.[0];
  if (!original || !watermarked) return res.status(400).json({ error: '请同时上传原图和水印图' });
  const meta = parseJson(req.body.metadata || '{}', {});
  const projectId = Number(meta.projectId);
  const taskPointId = Number(meta.taskPointId);
  const devicePositionId = Number(meta.devicePositionId);
  const existing = meta.clientId ? db.prepare('SELECT id, file_name AS fileName FROM photo_records WHERE client_id = ?').get(meta.clientId) : null;
  if (existing) return res.json({ ...existing, duplicate: true });

  const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId);
  const task = db.prepare('SELECT id, name FROM task_points WHERE id = ? AND project_id = ?').get(taskPointId, projectId);
  const device = db.prepare(`SELECT d.id, d.name, d.device_type AS deviceType FROM device_positions d JOIN task_points t ON t.id = d.task_point_id WHERE d.id = ? AND d.task_point_id = ? AND t.project_id = ?`).get(devicePositionId, taskPointId, projectId);
  if (!project || !task || !device) return res.status(400).json({ error: '项目、任务点或设备位不匹配' });
  if (!canViewProject(req.user, projectId)) return res.status(403).json({ error: '无权向该项目上传照片' });

  const photoType = displayPhotoType(String(meta.photoType || 'extra').trim() || 'extra');
  const sequence = db.prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM photo_records WHERE project_id = ? AND task_point_id = ? AND device_position_id = ? AND photo_type = ?`).get(projectId, taskPointId, devicePositionId, photoType).next || 1;
  const ext = '.jpg';
  const baseName = [sanitizeName(project.name, 36), sanitizeName(task.name, 36), sanitizeName(device.name, 42), sanitizeName(photoType, 24), padSequence(sequence)].join('-');
  const fileName = `${baseName}${ext}`;
  const dir = path.join(uploadDir, sanitizeName(project.name), sanitizeName(task.name));
  ensureDir(dir);
  const originalPath = path.join(dir, fileName.replace(ext, `_original${ext}`));
  const watermarkedPath = path.join(dir, fileName);
  fs.writeFileSync(originalPath, original.buffer);
  fs.writeFileSync(watermarkedPath, watermarked.buffer);

  const result = db.prepare(`INSERT INTO photo_records
    (client_id, project_id, task_point_id, device_position_id, photo_type, sequence, file_name,
     original_path, watermarked_path, captured_by, captured_at, gps_lat, gps_lng, quality_warnings)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(meta.clientId || null, projectId, taskPointId, devicePositionId, photoType, sequence, fileName, publicPath(originalPath, dataDir), publicPath(watermarkedPath, dataDir), req.user.id, meta.capturedAt || new Date().toISOString(), meta.gps?.lat ?? null, meta.gps?.lng ?? null, JSON.stringify(meta.qualityWarnings || []));
  broadcast('photo:created', { projectId, taskPointId, devicePositionId });
  res.status(201).json({ id: result.lastInsertRowid, fileName, sequence });
});

app.get('/api/projects/:id/photos', auth, requireProjectViewer, (req, res) => res.json({ photos: listProjectPhotos(Number(req.params.id)) }));

app.delete('/api/projects/:projectId/photos/:photoId', auth, requireProjectViewer, (req, res) => {
  const projectId = Number(req.params.projectId);
  const photoId = Number(req.params.photoId);
  const row = db.prepare('SELECT id, captured_by AS capturedById, deleted_at AS deletedAt FROM photo_records WHERE id = ? AND project_id = ?').get(photoId, projectId);
  if (!row || row.deletedAt) return res.status(404).json({ error: '照片不存在' });
  if (!canManageProject(req.user, projectId) && row.capturedById !== req.user.id) return res.status(403).json({ error: '只能删除自己上传的照片' });
  db.prepare('UPDATE photo_records SET deleted_at = ?, deleted_by = ?, delete_reason = ? WHERE id = ? AND project_id = ?').run(new Date().toISOString(), req.user.id, req.body?.reason || '用户删除重拍', photoId, projectId);
  broadcast('photo:deleted', { projectId, photoId });
  res.json({ deleted: true, recycled: true });
});

app.get('/api/projects/:id/recycle-bin', auth, requireProjectManager, (req, res) => {
  res.json({ retentionDays: RECYCLE_DAYS, photos: listProjectPhotos(Number(req.params.id), { deleted: true }) });
});

app.post('/api/projects/:projectId/photos/:photoId/restore', auth, requireProjectManager, (req, res) => {
  const result = db.prepare('UPDATE photo_records SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL WHERE id = ? AND project_id = ? AND deleted_at IS NOT NULL').run(Number(req.params.photoId), Number(req.params.projectId));
  if (result.changes === 0) return res.status(404).json({ error: '回收站照片不存在' });
  broadcast('photo:restored', { projectId: Number(req.params.projectId), photoId: Number(req.params.photoId) });
  res.json({ restored: true });
});

app.delete('/api/projects/:projectId/photos/:photoId/permanent', auth, requireProjectManager, (req, res) => {
  const projectId = Number(req.params.projectId);
  const photoId = Number(req.params.photoId);
  const row = db.prepare('SELECT original_path AS originalPath, watermarked_path AS watermarkedPath FROM photo_records WHERE id = ? AND project_id = ? AND deleted_at IS NOT NULL').get(photoId, projectId);
  if (!row) return res.status(404).json({ error: '回收站照片不存在' });
  db.prepare('DELETE FROM photo_records WHERE id = ? AND project_id = ?').run(photoId, projectId);
  for (const rel of [row.originalPath, row.watermarkedPath]) {
    const abs = path.join(dataDir, rel);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  }
  res.json({ deleted: true, permanent: true });
});

app.get('/api/projects/:id/export-check', auth, requireProjectManager, (req, res) => {
  const report = getExportCheck(Number(req.params.id), Number(req.query.pending || 0));
  res.json(report);
});

async function exportProjectZip({ res, projectId, taskPointId = null }) {
  const project = getProject(projectId);
  const taskPoint = taskPointId ? db.prepare('SELECT id, name FROM task_points WHERE id = ? AND project_id = ?').get(taskPointId, projectId) : null;
  if (taskPointId && !taskPoint) return res.status(404).json({ error: '任务点不存在' });
  const rows = listProjectPhotos(projectId, { taskPointId }).map((row) => ({
    id: row.id,
    projectName: project.name,
    taskPointName: row.taskPointName,
    devicePositionName: row.devicePositionName,
    deviceType: row.deviceType,
    fieldAdded: row.taskIsTemporary || row.deviceIsTemporary ? '是' : '否',
    reviewStatus: row.taskReviewStatus !== 'approved' || row.deviceReviewStatus !== 'approved' ? '待确认' : '已确认',
    photoType: displayPhotoType(row.photoType),
    sequence: row.sequence,
    fileName: row.fileName,
    watermarkedPath: row.watermarkedPath,
    originalPath: row.originalPath,
    capturedBy: row.capturedBy,
    capturedAt: row.capturedAt,
    gpsLat: row.gpsLat,
    gpsLng: row.gpsLng,
    qualityWarnings: row.qualityWarnings,
    syncStatus: 'synced'
  }));
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('验收清单');
  sheet.columns = [
    { header: '项目', key: 'projectName', width: 24 },
    { header: '任务点', key: 'taskPointName', width: 24 },
    { header: '设备位', key: 'devicePositionName', width: 28 },
    { header: '设备类型', key: 'deviceType', width: 16 },
    { header: '现场补录', key: 'fieldAdded', width: 12 },
    { header: '补录确认状态', key: 'reviewStatus', width: 16 },
    { header: '照片类型', key: 'photoType', width: 14 },
    { header: '文件名', key: 'fileName', width: 42 },
    { header: '拍摄人', key: 'capturedBy', width: 14 },
    { header: '拍摄时间', key: 'capturedAt', width: 24 },
    { header: 'GPS纬度', key: 'gpsLat', width: 14 },
    { header: 'GPS经度', key: 'gpsLng', width: 14 },
    { header: '质量提醒', key: 'qualityWarningsText', width: 30 },
    { header: '同步状态', key: 'syncStatus', width: 12 },
    { header: '相对路径', key: 'watermarkedPath', width: 48 }
  ];
  rows.forEach((row) => sheet.addRow({ ...row, qualityWarningsText: row.qualityWarnings.join('、') }));
  sheet.getRow(1).font = { bold: true };
  const excelBuffer = await workbook.xlsx.writeBuffer();
  const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = taskPoint ? `_${downloadName(taskPoint.name)}` : '';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(`${downloadName(project.name)}${suffix}_验收照片_${dateStamp}.zip`)}"`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (error) => res.status(500).end(error.message));
  archive.pipe(res);
  for (const row of rows) {
    const abs = path.join(dataDir, row.watermarkedPath);
    if (fs.existsSync(abs)) archive.file(abs, { name: `${sanitizeName(project.name)}/${sanitizeName(row.taskPointName)}/${row.fileName}` });
  }
  archive.append(JSON.stringify({ project: { id: project.id, name: project.name }, taskPoint, exportedAt: new Date().toISOString(), exportCheck: getExportCheck(projectId), photos: rows }, null, 2), { name: `${sanitizeName(project.name)}/manifest.json` });
  archive.append(Buffer.from(excelBuffer), { name: `${sanitizeName(project.name)}/验收清单.xlsx` });
  archive.finalize();
}

app.get('/api/projects/:id/export', auth, requireProjectManager, (_req, res) => exportProjectZip({ res, projectId: Number(_req.params.id) }));
app.get('/api/projects/:id/tasks/:taskPointId/export', auth, requireProjectManager, (req, res) => exportProjectZip({ res, projectId: Number(req.params.id), taskPointId: Number(req.params.taskPointId) }));

app.get('/api/sync/summary', auth, (_req, res) => {
  res.json({ serverOnline: true, now: new Date().toISOString() });
});

app.get('/api/admin/health', auth, requireSuperAdmin, (_req, res) => {
  let dbOk = true;
  let uploadWritable = true;
  let disk = null;
  try {
    db.prepare('SELECT 1 AS ok').get();
  } catch {
    dbOk = false;
  }
  try {
    const probe = path.join(uploadDir, `.write-test-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch {
    uploadWritable = false;
  }
  try {
    const stat = fs.statfsSync(dataDir);
    disk = { availableBytes: stat.bavail * stat.bsize, totalBytes: stat.blocks * stat.bsize };
  } catch {
    disk = null;
  }
  res.json({
    status: dbOk && uploadWritable ? 'ok' : 'warning',
    database: dbOk,
    uploadWritable,
    dataDir,
    uploadDir,
    backupDir,
    disk,
    publicBaseUrl: PUBLIC_BASE_URL,
    suggestedAppUrl: PUBLIC_BASE_URL || getLanAddresses(Number(process.env.PORT || 3001))[0] || '',
    lanUrls: getLanAddresses(Number(process.env.PORT || 3001)),
    activeTokens: tokens.size,
    recycleRetentionDays: RECYCLE_DAYS
  });
});

app.get('/api/admin/version', auth, (_req, res) => {
  res.json({
    name: packageJson.name,
    version: packageJson.version,
    buildTime: BUILD_TIME,
    mode: process.env.NODE_ENV || 'development',
    apk: getApkInfo()
  });
});

app.get('/api/app/apk', auth, (req, res) => {
  const apk = getApkInfo();
  if (!apk.available) return res.status(404).json({ error: '当前电脑还没有生成 APK，请先运行 npm.cmd run android:apk' });
  res.download(apk.path, apk.fileName);
});

app.get('/api/admin/backups', auth, requireSuperAdmin, (_req, res) => {
  res.json({ backups: listBackupFiles(), backupDir });
});

app.get('/api/admin/backup', auth, requireSuperAdmin, async (_req, res) => {
  try {
    const backup = await createBackupFile('manual');
    res.download(backup.filePath, backup.fileName);
  } catch (err) {
    res.status(500).json({ error: err.message || '备份失败' });
  }
});

app.post('/api/admin/restore-backup', auth, requireSuperAdmin, upload.single('backup'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传备份文件' });
  try {
    const safety = await createBackupFile('before-restore');
    let sqliteBuffer = null;
    const uploadEntries = [];
    const fileName = req.file.originalname || '';
    if (/\.zip$/i.test(fileName)) {
      const entries = readZipEntries(req.file.buffer);
      sqliteBuffer = entries.get('app.sqlite');
      for (const [name, content] of entries.entries()) {
        if (name.startsWith('uploads/') && !name.includes('..')) uploadEntries.push({ name: name.slice('uploads/'.length), content });
      }
    } else {
      sqliteBuffer = req.file.buffer;
    }
    if (!sqliteBuffer) return res.status(400).json({ error: '备份中未找到 app.sqlite' });

    const restoreDbPath = path.join(dataDir, 'app.sqlite.restore');
    fs.writeFileSync(restoreDbPath, sqliteBuffer);
    if (uploadEntries.length > 0) {
      safeClearDirectory(uploadDir);
      for (const entry of uploadEntries) {
        if (!entry.name || entry.name.includes('..')) continue;
        const abs = path.join(uploadDir, entry.name);
        ensureDir(path.dirname(abs));
        fs.writeFileSync(abs, entry.content);
      }
    }

    res.json({
      restored: true,
      safetyBackup: safety.fileName,
      message: '备份已恢复到数据目录，后端即将重启。若未自动重启，请手动重新启动服务。'
    });

    setTimeout(() => {
      try {
        db.close?.();
      } catch {
        // ignore close errors before process exit
      }
      try {
        fs.copyFileSync(restoreDbPath, path.join(dataDir, 'app.sqlite'));
        fs.unlinkSync(restoreDbPath);
      } finally {
        process.exit(0);
      }
    }, 300);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '0.0.0.0';
server.listen(port, host, () => {
  console.log(`后端服务已启动: http://${host}:${port}`);
  console.log(`本机检查: http://127.0.0.1:${port}/api/public/health`);
  if (PUBLIC_BASE_URL) {
    console.log(`正式公网访问: ${PUBLIC_BASE_URL}`);
    console.log('正式部署请通过 Nginx/HTTPS 访问，不要开放公网 3001。');
  } else {
    for (const url of getLanAddresses(port)) console.log(`局域网后端: ${url}`);
  }
  console.log(`数据目录: ${dataDir}`);
});
