# 项目代码说明

本文档用于从头理解当前工程照片采集系统的功能、代码结构和数据流。

## 1. 项目定位

系统面向通信工程现场采集和验收归档，核心流程是：

```text
Excel 导入项目数据 → 现场按项目/任务点/设备位拍照 → 本地队列离线保存 → 后端同步保存原图和水印图 → 查看进度 → 导出成果 ZIP/Excel/JSON
```

## 2. 技术栈

| 模块 | 技术 |
| --- | --- |
| 前端 | React + Vite |
| 移动端网页 | PWA + IndexedDB |
| Android App | Capacitor Android |
| 后端 | Node.js + Express |
| 数据库 | SQLite |
| 实时同步 | WebSocket |
| Excel 处理 | xlsx、exceljs |
| ZIP 导出 | archiver |
| 本地部署 | Windows CMD/PowerShell |

## 3. 主要目录

| 路径 | 作用 |
| --- | --- |
| `src/main.jsx` | 前端主入口，包含登录、项目首页、同步中心、进度、项目管理、导入、导出、账号、健康、诊断等页面。 |
| `src/components/CapturePanelV2.jsx` | 手机端采集核心组件，负责项目内任务点列表、设备列表、单设备拍照、照片确认、临时补录、删除重拍。 |
| `src/services/api.js` | API 地址、鉴权 token、运行时服务器地址配置、WebSocket 地址。 |
| `src/services/localDb.js` | IndexedDB 本地缓存和离线照片队列。 |
| `src/services/nativeApp.js` | Capacitor 相机、文件、网络、定位、返回键等原生能力封装。 |
| `src/services/photo.js` | 图片质量检测、GPS 获取、水印图生成。 |
| `src/styles.css` | 全局样式、移动端底部导航、列表、照片卡片、管理页样式。 |
| `server/index.js` | 后端主服务，包含鉴权、项目、Excel 导入、照片上传、进度、导出、回收站、备份、诊断等接口。 |
| `server/database.js` | SQLite 数据库初始化、表结构迁移、默认账号和默认模板。 |
| `scripts/start-lan.ps1` | 局域网前后端启动脚本。 |
| `scripts/start-production.ps1` | 生产模式启动脚本。 |
| `android/` | Capacitor 生成的 Android 工程。 |
| `docs/USER_GUIDE.md` | 面向使用者的完整说明。 |
| `docs/ANDROID_APP.md` | Android App 打包和测试说明。 |

## 4. 核心数据实体

| 实体 | 说明 |
| --- | --- |
| `User` | 用户账号、显示名、角色。角色包括完全管理员、项目管理员、采集员。 |
| `Project` | 项目名称、创建人、归档状态。 |
| `TaskPoint` | 任务点，归属项目，可来自 Excel 或现场临时补录。 |
| `DevicePosition` | 设备位，归属任务点，可来自 Excel 或现场临时补录。 |
| `PhotoType` | 照片类型，支持按设备类型配置必拍项。 |
| `PhotoRecord` | 已同步照片记录，包含原图、水印图、命名、序号、拍摄人、时间、GPS、质量提醒和回收站状态。 |

## 5. 权限模型

- 完全管理员：管理所有项目、账号、备份、健康页和数据清理。
- 项目管理员：管理所有项目，可导入、导出、维护项目和创建采集员。
- 采集员：只进行采集、同步、查看进度，以及删除自己上传的照片重拍。

前端会隐藏无权限入口，后端接口也会校验权限，不能只依赖前端隐藏按钮。

## 6. 前端页面结构

### 登录页

位于 `src/main.jsx` 的 `Login` 组件。支持保存服务器地址，Android App 可在登录前配置局域网后端 API。

### 项目首页

`ProjectHome` 组件。登录后默认进入，显示项目列表、继续上次采集、未完成、待同步、同步失败和待确认补录入口。

### 采集页

`CapturePanelV2` 组件。采用手机优先的分层流程：

```text
项目 → 任务点列表 → 设备列表 → 单设备拍照页
```

任务点和设备列表以搜索为主，支持清空输入和只看未完成。拍照页只突出设备状态、照片类型、下一种类型和拍照按钮，照片明细默认折叠。

### 同步中心

`SyncCenter` 组件。显示当前浏览器或当前手机自己的本地队列，支持暂停自动同步、重试和删除本地队列照片。

### 采集进度

`ProgressPanel` 组件。按项目、任务点、设备分层查看进度，每层支持搜索。

### 项目管理

`ProjectManagePanel` 组件。结构为项目列表进入项目详情，项目详情内处理基本信息、导入、导出、照片类型和数据清理入口。

### 导入导出

`UploadPanel` 负责下载模板、预检查 Excel、确认导入和照片类型配置。

`ExportPanel` 负责导出前检查、项目 ZIP 导出、任务点 ZIP 导出和回收站查看。

### 诊断和健康

`DiagnosticsPanel` 面向所有角色，用于排查连接、登录、网络和本地队列问题。

`HealthPanel` 面向完全管理员，用于查看后端健康、磁盘、备份列表、APK 下载和备份恢复。

## 7. 后端接口分组

| 分组 | 主要接口 |
| --- | --- |
| 鉴权 | `POST /api/auth/login` |
| 项目 | `GET /api/projects`、`POST /api/projects`、`PATCH /api/projects/:id`、`DELETE /api/projects/:id` |
| Excel | `GET /api/projects/import-template`、`POST /api/projects/import-preview`、`POST /api/projects/import-excel` |
| 采集 | `GET /api/projects/:id/tree`、`POST /api/photos`、`DELETE /api/projects/:id/photos/:photoId` |
| 进度 | `GET /api/projects/:id/progress` |
| 导出 | `GET /api/projects/:id/export-check`、`GET /api/projects/:id/export`、`GET /api/projects/:id/tasks/:taskPointId/export` |
| 回收站 | `GET /api/projects/:id/recycle-bin`、`POST /api/projects/:id/photos/:photoId/restore`、`DELETE /api/projects/:id/photos/:photoId/permanent` |
| 管理 | `GET /api/admin/health`、`GET /api/admin/backup`、`GET /api/admin/backups`、`POST /api/admin/restore-backup` |
| 诊断更新 | `GET /api/diagnostics`、`GET /api/admin/version`、`GET /api/app/apk` |

## 8. 照片数据流

1. 用户选择照片类型并拍照。
2. 前端保存原图和采集元数据。
3. 用户确认后照片进入 IndexedDB 本地队列。
4. 同步时前端读取原图，生成水印图。
5. 前端同时上传原图和水印图到 `/api/photos`。
6. 后端按项目、任务点、设备、照片类型和序号生成文件名。
7. 后端保存文件并写入 `PhotoRecord`。
8. 前端移除本地队列记录并刷新进度。

## 9. 开发入门建议

阅读顺序：

1. 先看 `docs/USER_GUIDE.md`，理解用户怎么使用。
2. 再看 `src/main.jsx`，理解页面入口和整体状态。
3. 再看 `src/components/CapturePanelV2.jsx`，理解采集流程。
4. 再看 `src/services/localDb.js` 和 `src/services/photo.js`，理解离线队列和水印。
5. 再看 `server/index.js`，按接口分组理解后端。
6. 最后看 `server/database.js`，理解数据库表和迁移。

## 10. 常用验证命令

```powershell
node --check server/index.js
npm.cmd run build
```

Android APK：

```powershell
npm.cmd run android:apk
```

局域网启动：

```powershell
.\scripts\start-lan.cmd
```
