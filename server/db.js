import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
export const uploadDir = path.join(dataDir, 'uploads');
export const backupDir = path.join(dataDir, 'backups');

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(backupDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, 'app.sqlite'));
db.exec('PRAGMA foreign_keys = ON');

export const ROLE_SUPER_ADMIN = 'super_admin';
export const ROLE_PROJECT_ADMIN = 'project_admin';
export const ROLE_COLLECTOR = 'collector';

export function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

function tableExists(tableName) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
}

function tableColumns(tableName) {
  if (!tableExists(tableName)) return [];
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name);
}

function tableSql(tableName) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName)?.sql || '';
}

function addColumn(tableName, columnName, definition) {
  if (tableExists(tableName) && !tableColumns(tableName).includes(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function migrateUsers() {
  if (!tableExists('users')) return;
  const sql = tableSql('users');
  if (sql.includes("'super_admin'") && sql.includes("'project_admin'")) {
    db.prepare("UPDATE users SET role = 'super_admin' WHERE role = 'admin'").run();
    return;
  }

  db.exec(`
    PRAGMA foreign_keys = OFF;
    ALTER TABLE users RENAME TO users_legacy;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('super_admin', 'project_admin', 'collector')),
      deleted_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO users (id, username, password_hash, display_name, role, deleted_at, created_at)
      SELECT id, username, password_hash, display_name,
        CASE WHEN role = 'admin' THEN 'super_admin' ELSE role END,
        NULL,
        created_at
      FROM users_legacy;
    DROP TABLE users_legacy;
    PRAGMA foreign_keys = ON;
  `);
}

function repairTableWithUserForeignKeys() {
  const projectFkLegacy = tableExists('projects')
    ? db.prepare('PRAGMA foreign_key_list(projects)').all().some((row) => row.table === 'users_legacy')
    : false;
  if (projectFkLegacy) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE projects_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        source_file_name TEXT,
        created_by INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(created_by) REFERENCES users(id)
      );
      INSERT INTO projects_new (id, name, source_file_name, created_by, created_at)
        SELECT p.id, p.name, p.source_file_name, CASE WHEN u.id IS NULL THEN NULL ELSE p.created_by END, p.created_at
        FROM projects p LEFT JOIN users u ON u.id = p.created_by;
      DROP TABLE projects;
      ALTER TABLE projects_new RENAME TO projects;
      PRAGMA foreign_keys = ON;
    `);
  }

  const photoFkLegacy = tableExists('photo_records')
    ? db.prepare('PRAGMA foreign_key_list(photo_records)').all().some((row) => row.table === 'users_legacy')
    : false;
  if (photoFkLegacy) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE photo_records_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id TEXT UNIQUE,
        project_id INTEGER NOT NULL,
        task_point_id INTEGER NOT NULL,
        device_position_id INTEGER NOT NULL,
        photo_type TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        file_name TEXT NOT NULL,
        original_path TEXT NOT NULL,
        watermarked_path TEXT NOT NULL,
        captured_by INTEGER NOT NULL,
        captured_at TEXT NOT NULL,
        gps_lat REAL,
        gps_lng REAL,
        quality_warnings TEXT NOT NULL DEFAULT '[]',
        sync_status TEXT NOT NULL DEFAULT 'synced',
        deleted_at TEXT,
        deleted_by INTEGER,
        delete_reason TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(task_point_id) REFERENCES task_points(id) ON DELETE CASCADE,
        FOREIGN KEY(device_position_id) REFERENCES device_positions(id) ON DELETE CASCADE,
        FOREIGN KEY(captured_by) REFERENCES users(id),
        FOREIGN KEY(deleted_by) REFERENCES users(id)
      );
      INSERT INTO photo_records_new
        (id, client_id, project_id, task_point_id, device_position_id, photo_type, sequence, file_name,
         original_path, watermarked_path, captured_by, captured_at, gps_lat, gps_lng, quality_warnings,
         sync_status, created_at)
        SELECT p.id, p.client_id, p.project_id, p.task_point_id, p.device_position_id, p.photo_type,
          p.sequence, p.file_name, p.original_path, p.watermarked_path, p.captured_by, p.captured_at,
          p.gps_lat, p.gps_lng, p.quality_warnings, p.sync_status, p.created_at
        FROM photo_records p JOIN users u ON u.id = p.captured_by;
      DROP TABLE photo_records;
      ALTER TABLE photo_records_new RENAME TO photo_records;
      PRAGMA foreign_keys = ON;
    `);
  }
}

function migratePhotoTypes() {
  if (!tableExists('photo_types')) return;
  if (tableColumns('photo_types').includes('device_type')) return;
  db.exec(`
    ALTER TABLE photo_types RENAME TO photo_types_legacy;
    CREATE TABLE photo_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      device_type TEXT NOT NULL DEFAULT '通用',
      name TEXT NOT NULL,
      required INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    INSERT INTO photo_types (id, project_id, device_type, name, required, sort_order)
      SELECT id, project_id, '通用', name, required, sort_order FROM photo_types_legacy;
    DROP TABLE photo_types_legacy;
  `);
}

function ensureExtraColumns() {
  addColumn('projects', 'archived_at', 'TEXT');
  addColumn('projects', 'archived_by', 'INTEGER');
  addColumn('users', 'deleted_at', 'TEXT');
  addColumn('task_points', 'is_temporary', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('task_points', 'review_status', "TEXT NOT NULL DEFAULT 'approved'");
  addColumn('task_points', 'created_by', 'INTEGER');
  addColumn('task_points', 'created_at', 'TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP');
  addColumn('device_positions', 'device_type', "TEXT NOT NULL DEFAULT '通用'");
  addColumn('device_positions', 'is_temporary', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('device_positions', 'review_status', "TEXT NOT NULL DEFAULT 'approved'");
  addColumn('device_positions', 'created_by', 'INTEGER');
  addColumn('device_positions', 'created_at', 'TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP');
  addColumn('photo_records', 'deleted_at', 'TEXT');
  addColumn('photo_records', 'deleted_by', 'INTEGER');
  addColumn('photo_records', 'delete_reason', 'TEXT');
}

function ensureIndexes() {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_photo_types_scope ON photo_types(project_id, device_type, name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_device_type_templates_scope ON device_type_templates(device_type, name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_members_scope ON project_members(project_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_photo_records_active ON photo_records(project_id, deleted_at);
  `);
}

function seedTemplates() {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO device_type_templates (device_type, name, required, sort_order) VALUES (?, ?, ?, ?)'
  );
  [
    ['RRU', '全景', 1],
    ['RRU', '近景', 1],
    ['RRU', '铭牌', 1],
    ['RRU', '走线', 1],
    ['BBU', '全景', 1],
    ['BBU', '铭牌', 1],
    ['BBU', '端口', 1],
    ['天线', '全景', 1],
    ['天线', '方位角', 1],
    ['天线', '下倾角', 1],
    ['天线', '铭牌', 1],
    ['通用', '全景', 1],
    ['通用', '近景', 1],
    ['通用', '铭牌', 1]
  ].forEach(([deviceType, name, required], index) => insert.run(deviceType, name, required, index));
}

function seedDefaultUsers() {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)'
  );
  insert.run('admin', hashPassword('admin123'), '完全管理员', ROLE_SUPER_ADMIN);
  insert.run('projectadmin', hashPassword('project123'), '项目管理员', ROLE_PROJECT_ADMIN);
  insert.run('collector', hashPassword('collector123'), '采集员', ROLE_COLLECTOR);
  db.prepare("UPDATE users SET display_name = '完全管理员', role = ? WHERE username = 'admin'").run(ROLE_SUPER_ADMIN);
  db.prepare("UPDATE users SET display_name = '项目管理员', role = ? WHERE username = 'projectadmin'").run(ROLE_PROJECT_ADMIN);
  db.prepare("UPDATE users SET display_name = '采集员', role = ? WHERE username = 'collector'").run(ROLE_COLLECTOR);
}
export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('super_admin', 'project_admin', 'collector')),
      deleted_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      source_file_name TEXT,
      created_by INTEGER,
      archived_at TEXT,
      archived_by INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(created_by) REFERENCES users(id),
      FOREIGN KEY(archived_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS project_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'project_manager',
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS task_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      is_temporary INTEGER NOT NULL DEFAULT 0,
      review_status TEXT NOT NULL DEFAULT 'approved',
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(created_by) REFERENCES users(id),
      UNIQUE(project_id, name)
    );

    CREATE TABLE IF NOT EXISTS device_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_point_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      code TEXT,
      device_type TEXT NOT NULL DEFAULT '通用',
      is_temporary INTEGER NOT NULL DEFAULT 0,
      review_status TEXT NOT NULL DEFAULT 'approved',
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(task_point_id) REFERENCES task_points(id) ON DELETE CASCADE,
      FOREIGN KEY(created_by) REFERENCES users(id),
      UNIQUE(task_point_id, name)
    );

    CREATE TABLE IF NOT EXISTS photo_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      device_type TEXT NOT NULL DEFAULT '通用',
      name TEXT NOT NULL,
      required INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS device_type_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_type TEXT NOT NULL,
      name TEXT NOT NULL,
      required INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS photo_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT UNIQUE,
      project_id INTEGER NOT NULL,
      task_point_id INTEGER NOT NULL,
      device_position_id INTEGER NOT NULL,
      photo_type TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      original_path TEXT NOT NULL,
      watermarked_path TEXT NOT NULL,
      captured_by INTEGER NOT NULL,
      captured_at TEXT NOT NULL,
      gps_lat REAL,
      gps_lng REAL,
      quality_warnings TEXT NOT NULL DEFAULT '[]',
      sync_status TEXT NOT NULL DEFAULT 'synced',
      deleted_at TEXT,
      deleted_by INTEGER,
      delete_reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(task_point_id) REFERENCES task_points(id) ON DELETE CASCADE,
      FOREIGN KEY(device_position_id) REFERENCES device_positions(id) ON DELETE CASCADE,
      FOREIGN KEY(captured_by) REFERENCES users(id),
      FOREIGN KEY(deleted_by) REFERENCES users(id)
    );
  `);

  migrateUsers();
  repairTableWithUserForeignKeys();
  migratePhotoTypes();
  ensureExtraColumns();
  ensureIndexes();
  seedDefaultUsers();
  seedTemplates();
}

export function rowToUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    deletedAt: row.deleted_at,
    createdAt: row.created_at
  };
}
