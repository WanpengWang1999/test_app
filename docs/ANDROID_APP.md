# Android App 打包与测试说明

当前项目已经接入 Capacitor Android，第一版用于内部测试 APK。Android App 和网页端共用同一套 React 前端与 Node/Express 后端。

## 基本信息

- App 名称：工程照片采集
- 包名：`com.telecom.photoacceptance`
- Android 工程目录：`android/`
- Capacitor 配置：`capacitor.config.json`
- 原生能力封装：`src/services/nativeApp.js`

## 常用命令

同步 Android 工程：

```powershell
npm.cmd run android:sync
```

打开 Android Studio：

```powershell
npm.cmd run android:open
```

生成调试 APK：

```powershell
npm.cmd run android:apk
```

APK 输出位置：

```text
android\app\build\outputs\apk\debug\app-debug.apk
```

## 云端 App 测试

云端部署后，App 登录页的服务器地址填写公网 HTTPS 地址：

```text
https://photo.example.com
```

测试步骤：

1. 云服务器启动后，浏览器访问 `https://photo.example.com/api/public/health`。
2. 确认返回 `status: ok`。
3. 生成并安装 APK。
4. 打开 App，在登录页展开“服务器地址”。
5. 填写 `https://photo.example.com`。
6. 点击“测试连接”。
7. 连接成功后登录并进行采集、同步、进度查看。

云端测试不要填写：

```text
localhost
127.0.0.1
电脑局域网 IP
```

## 局域网 App 测试

局域网调试时，服务器地址填写电脑后端 API 地址：

```text
http://电脑局域网IP:3001
```

示例：

```text
http://192.168.1.10:3001
```

## 限制说明

- 第一版只保证 App 前台、回到前台、网络恢复时可靠同步。
- 不承诺锁屏或长时间后台时持续上传。
- 未同步照片保存在 App 私有目录，卸载 App 后会被清除。
- 已同步照片保存在后端 `uploads` 目录。
- 云端正式测试建议使用 HTTPS，避免移动网络或系统安全策略拦截 HTTP。
