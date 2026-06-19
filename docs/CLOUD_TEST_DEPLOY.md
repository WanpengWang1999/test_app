# 云端测试部署说明

本文用于把“工程照片采集”部署为当前公网 IP 测试访问方式。域名备案、HTTPS 和 Nginx 反向代理完成前，入口统一为：

```text
http://114.55.109.150:3001
```

Node 后端在测试阶段监听 `0.0.0.0:3001`，手机和网页直接访问公网 IP。后续切换正式域名时，再改为 `127.0.0.1:3001` 并由 Nginx 提供 `80/443`。

## 1. 安全组

当前测试阶段云服务器安全组开放：

```text
22
3001
```

暂时不要使用：

```text
80
443
5173
```

正式域名、备案和 HTTPS 完成后，再关闭公网：

```text
3001
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

测试 `.env` 关键项：

```text
NODE_ENV=production
HOST=0.0.0.0
PORT=3001
DATA_DIR=/data/telecom-photo
PUBLIC_BASE_URL=http://114.55.109.150:3001
ALLOWED_ORIGINS=http://114.55.109.150:3001,capacitor://localhost
AUTH_SECRET=请改成长随机字符串
INITIAL_ADMIN_PHONE=19720410920
INITIAL_ADMIN_PASSWORD=WWP1999
ENABLE_DEMO_USERS=0
VITE_FIXED_API_BASE_URL=http://114.55.109.150:3001
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

当前测试模式不需要 Nginx 和 HTTPS。域名备案完成后，再复制示例配置：

```bash
sudo cp deploy/nginx-cloud.conf.example /etc/nginx/sites-available/telecom-photo
sudo ln -sf /etc/nginx/sites-available/telecom-photo /etc/nginx/sites-enabled/telecom-photo
sudo nginx -t
sudo systemctl reload nginx
```

首次申请证书：

```bash
sudo certbot --nginx -d 待备案域名
```

证书完成后检查：

```bash
curl https://正式域名/api/public/health
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
http://114.55.109.150:3001
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
curl http://114.55.109.150:3001/api/public/health
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
