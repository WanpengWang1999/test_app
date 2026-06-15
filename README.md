# 通信工程设备照片采集与归档系统

本项目用于通信工程现场设备照片采集、设备位归档、Excel 导入、离线同步、水印生成、进度查看、权限管理、备份恢复和成果导出。

## 默认账号

- 完全管理员：`admin` / `admin123`
- 项目管理员：`projectadmin` / `project123`
- 采集员：`collector` / `collector123`

## 本机开发运行

```powershell
npm.cmd install
npm.cmd run dev
```

- 前端：http://localhost:5173
- 后端：http://localhost:3001

## 局域网运行

推荐运行：

```powershell
.\scripts\start-lan.cmd
```

如果 PowerShell 禁止运行脚本，可使用：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-lan.ps1
```

手机不能访问电脑上的 `localhost`，需要访问脚本输出的局域网地址，例如：

```text
http://192.168.1.10:5173/
```

Android App 需要填写后端地址，例如：

```text
http://192.168.1.10:3001
```

## Android App 内部测试

第一版 Android App 使用 Capacitor 打包：

- App 名称：工程照片采集
- 包名：`com.telecom.photoacceptance`
- APK 输出：`android\app\build\outputs\apk\debug\app-debug.apk`

构建命令：

```powershell
npm.cmd run android:apk
```

## 生产运行

生产模式先构建前端，再启动后端：

```powershell
npm.cmd run build
powershell -ExecutionPolicy Bypass -File .\scripts\start-production.ps1
```

访问地址：

- 电脑：http://localhost:3001
- 手机：http://电脑局域网IP:3001

## 文档

- 完整使用说明：[docs/USER_GUIDE.md](docs/USER_GUIDE.md)
- Android App 说明：[docs/ANDROID_APP.md](docs/ANDROID_APP.md)
- 项目代码说明：[docs/PROJECT_GUIDE.md](docs/PROJECT_GUIDE.md)

## 常见问题

### 手机打不开页面

确认手机和电脑在同一局域网；访问 `http://电脑局域网IP:5173/`，不要访问 `localhost`；Windows 防火墙需要允许 Node.js 访问专用网络。

### App 登录失败

确认 App 中填写的是后端地址 `http://电脑局域网IP:3001`，不是前端地址 `http://电脑局域网IP:5173`。

### 构建时出现 `spawn EPERM`

这是沙箱拦截 esbuild 子进程启动导致的环境问题，不是代码语法错误。在 Codex 中需要授权在沙箱外运行 `npm.cmd run build`，本机 PowerShell 直接运行通常不会出现该问题。
