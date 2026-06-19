# 项目代码说明

## 总体结构

本项目是通信工程照片采集与验收归档系统，包含：

- React + Vite 前端。
- Node.js + Express 后端。
- SQLite 本地数据库。
- IndexedDB 离线同步队列。
- Capacitor Android App 壳。

当前测试云端入口为 `http://114.55.109.150:3001`。Web 端同源访问后端，Android App 固定连接该测试地址。域名备案和 HTTPS 完成后再切换正式入口。

## 主要目录

| 路径 | 作用 |
| --- | --- |
| `src/main.jsx` | 前端主入口，包含登录注册、项目首页、同步中心、进度、管理、导入导出、账号和诊断页面。 |
| `src/components/CapturePanelV2.jsx` | 手机端分层采集流程：项目、任务点、设备位、单设备拍照。 |
| `src/services/api.js` | API 地址、鉴权 token、WebSocket 地址和 App 固定云端地址。 |
| `src/services/localDb.js` | IndexedDB 本地队列和项目缓存。 |
| `src/services/photo.js` | 图片读取、质量提醒和水印生成。 |
| `src/services/nativeApp.js` | Capacitor 相机、定位、网络、文件和返回键封装。 |
| `server/index.js` | 后端 API、鉴权、项目、照片、导入导出、备份和健康检查。 |
| `server/db.js` | SQLite 初始化、迁移、默认正式管理员和基础模板数据。 |
| `server/accountPolicy.js` | 账号注册审批、状态和角色等级策略。 |
| `deploy/nginx-cloud.conf.example` | 正式域名 Nginx 反向代理示例。 |
| `docs/CLOUD_TEST_DEPLOY.md` | 当前公网 IP 测试部署说明。 |

## 核心业务

### 账号

用户使用手机号登录。新用户注册时填写手机号、姓名、工作单位和密码，默认角色为采集员，状态为待审批。

账号状态：

- `pending`：待审批，不能登录。
- `active`：已启用，可登录。
- `rejected`：已拒绝，不能登录。
- `disabled`：已停用，不能登录。

完全管理员可管理所有账号；项目管理员只能管理采集员；采集员不能访问账号管理。

### 项目和采集

项目结构为：

```text
项目 → 任务点 → 设备位 → 照片类型
```

采集员进入项目后逐级选择任务点和设备位，再拍摄必拍类型和额外拍摄照片。照片确认后进入本地队列，联网时上传原图和水印图。

### 离线同步

未同步照片保存在当前浏览器或 App 的 IndexedDB 队列中。同步中心按项目和任务点查看本机队列，支持失败重试和删除本地队列。

### 导入导出

Excel 导入支持字段映射和预检查。导出支持项目 ZIP、任务点 ZIP、Excel 清单和 JSON 清单。导出前检查缺拍、质量提醒、未同步、回收站和现场补录。

## 开发命令

本地开发：

```powershell
npm.cmd run dev
```

构建网页：

```powershell
npm.cmd run build
```

生成 Android APK：

```powershell
npm.cmd run android:apk
```

账号策略测试：

```powershell
node server\accountPolicy.test.js
```

云端回归脚本需要先启动后端：

```powershell
node scripts\mock-verify.mjs
```

## 云端测试部署

当前测试部署使用：

```text
http://114.55.109.150:3001
```

Node 后端测试阶段监听 `0.0.0.0:3001`，公网直接访问测试端口。域名备案和 HTTPS 完成后再切换为 Nginx 反向代理模式。详细步骤见 `docs/CLOUD_TEST_DEPLOY.md`。
