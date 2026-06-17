# 云端正式部署说明

本文用于把“工程照片采集”部署为正式云端访问方式。正式入口统一为：

```text
https://wangwanpeng.qzz.io
```

Node 后端只监听服务器本机 `127.0.0.1:3001`，公网通过 Nginx 的 `80/443` 访问。

## 1. DNS 和安全组

1. 在域名 DNS 中添加 A 记录：

```text
wangwanpeng.qzz.io -> 服务器公网 IP
```

2. 云服务器安全组只开放：

```text
22
80
443
```

3. 正式使用时关闭公网：

```text
3001
5173
```

## 2. 服务器环境

推荐系统：Ubuntu 22.04。

安装 Node.js 24、Git、Nginx 和 Certbot：

```bash
sudo apt update
sudo apt install -y git nginx certbot python3-certbot-nginx
```

确认 Node 版本：

```bash
node -v
```

后端使用 `node:sqlite`，需要 Node.js 24 或更高版本。

## 3. 拉取和配置项目

```bash
cd /opt
git clone https://github.com/WanpengWang1999/test_app.git telecom-photo
cd /opt/telecom-photo
cp .env.cloud.example .env
nano .env
```

正式 `.env` 关键项：

```text
NODE_ENV=production
HOST=127.0.0.1
PORT=3001
DATA_DIR=/data/telecom-photo
PUBLIC_BASE_URL=https://wangwanpeng.qzz.io
ALLOWED_ORIGINS=https://wangwanpeng.qzz.io,capacitor://localhost
AUTH_SECRET=请改成长随机字符串
INITIAL_ADMIN_PHONE=19720410920
INITIAL_ADMIN_PASSWORD=WWP1999
ENABLE_DEMO_USERS=0
VITE_FIXED_API_BASE_URL=https://wangwanpeng.qzz.io
```

创建数据目录：

```bash
sudo mkdir -p /data/telecom-photo
sudo chown -R root:root /data/telecom-photo
sudo chmod 775 /data/telecom-photo
```

## 4. 构建和启动

```bash
npm install
npm run build
set -a
source .env
set +a
npm start
```

本机检查：

```bash
curl http://127.0.0.1:3001/api/public/health
```

返回 `status: ok` 后按 `Ctrl+C` 停止，继续配置 systemd。

## 5. systemd 服务

创建 `/etc/systemd/system/telecom-photo.service`：

```ini
[Unit]
Description=Telecom Photo Acceptance
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/telecom-photo
EnvironmentFile=/opt/telecom-photo/.env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

启用服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable telecom-photo
sudo systemctl restart telecom-photo
sudo systemctl status telecom-photo --no-pager
```

查看日志：

```bash
sudo journalctl -u telecom-photo -f
```

## 6. Nginx 和 HTTPS

复制示例配置：

```bash
sudo cp deploy/nginx-cloud.conf.example /etc/nginx/sites-available/telecom-photo
sudo ln -sf /etc/nginx/sites-available/telecom-photo /etc/nginx/sites-enabled/telecom-photo
sudo nginx -t
sudo systemctl reload nginx
```

首次申请证书：

```bash
sudo certbot --nginx -d wangwanpeng.qzz.io
```

证书完成后检查：

```bash
curl https://wangwanpeng.qzz.io/api/public/health
```

## 7. 初始登录和账号注册

首次正式管理员：

```text
手机号：19720410920
密码：WWP1999
```

登录后建议立即在账号管理中修改密码。

普通用户在登录页点击“注册账号”，填写手机号、姓名、工作单位和密码。注册后默认是采集员，状态为待审批，管理员审批通过后才能登录。

## 8. Android App

App 固定连接：

```text
https://wangwanpeng.qzz.io
```

重新生成 APK：

```powershell
npm.cmd run android:apk
```

APK 路径：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

安装后直接用手机号登录，不需要填写服务器地址。

## 9. 更新代码

```bash
cd /opt/telecom-photo
git pull
npm install
npm run build
sudo systemctl restart telecom-photo
sudo systemctl status telecom-photo --no-pager
curl https://wangwanpeng.qzz.io/api/public/health
```

## 10. 备份

系统数据目录：

```text
/data/telecom-photo
```

至少备份：

```text
/data/telecom-photo/app.sqlite
/data/telecom-photo/uploads
/opt/telecom-photo/.env
```

完全管理员也可以在“健康与备份”页面手动生成备份包。
