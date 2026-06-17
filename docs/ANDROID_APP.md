# Android App 打包与测试说明

当前项目使用 Capacitor Android，把 React/Vite 前端打包为内部测试 APK。正式 App 固定连接：

```text
https://wangwanpeng.qzz.io
```

用户安装后只需要使用手机号和密码登录，不需要填写服务器地址。

## 基本信息

- App 名称：工程照片采集
- 包名：`com.telecom.photoacceptance`
- Android 工程目录：`android/`
- Capacitor 配置：`capacitor.config.json`
- 原生能力封装：`src/services/nativeApp.js`

## 打包命令

同步 Android 工程：

```powershell
npm.cmd run android:sync
```

生成调试 APK：

```powershell
npm.cmd run android:apk
```

APK 输出位置：

```text
android\app\build\outputs\apk\debug\app-debug.apk
```

## 云端正式测试

1. 确认服务器健康检查正常：

```text
https://wangwanpeng.qzz.io/api/public/health
```

2. 重新生成 APK。
3. 手机卸载旧版 App 后安装新版 APK。
4. 打开 App，使用手机号登录。
5. 新用户点击“注册账号”，填写手机号、姓名、工作单位和密码。
6. 管理员审批通过后，新用户可登录采集。

## 登录与自动恢复

- 登录成功后，App 会保存登录状态。
- 下次打开 App 会自动进入系统。
- 如果 token 过期、账号被停用或账号未审批，App 会回到登录页。

## 限制说明

- App 前台、回前台、网络恢复时会自动同步。
- 不承诺锁屏或长时间后台时持续上传。
- 未同步照片保存在 App 私有目录，卸载 App 后会被清除。
- 已同步照片保存在云端服务器数据目录。
