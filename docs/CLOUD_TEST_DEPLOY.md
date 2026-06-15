# 云端网页与 Android App 测试部署说明

本文用于把“工程照片采集”部署到云服务器，供网页端和 Android App 通过公网测试。

## 推荐测试环境

- ECS：2 核 4 GiB 起步
- 系统：Ubuntu 22.04 64 位
- 系统盘：40 GiB
- 数据盘：100 GiB 起步，挂载到 `/data`
- 带宽：5 Mbps 起步，10 Mbps 更适合多人上传
- 安全组：开放 `22`、`80`、`443`
- 临时调试可开放 `3001`，正式测试建议关闭 `3001`，只通过 Nginx 暴露 `80/443`

## 云端访问方式

网页端推荐同源部署：

```text
https://photo.example.com
```

Android App 登录前服务器地址填写同一个 HTTPS 地址：

```text
https://photo.example.com
```

不要在云端 App 测试时填写 `localhost`、`127.0.0.1` 或电脑局域网 IP。

## 服务器准备

```bash
sudo apt update
sudo apt install -y nodejs npm nginx
node -v
npm -v
```

建议 Node.js 使用 20 LTS 或 22 LTS。如果系统源版本太旧，请使用 NodeSource 或 nvm 安装。

## 项目配置

复制环境模板：

```bash
cp .env.cloud.example .env
```

按实际域名修改：

```bash
PUBLIC_BASE_URL=https://photo.example.com
ALLOWED_ORIGINS=https://photo.example.com,capacitor://localhost,http://localhost
AUTH_SECRET=改成一段很长的随机字符串
DATA_DIR=/data/telecom-photo
HOST=127.0.0.1
PORT=3001
```

加载环境变量后构建并启动：

```bash
npm install
npm run build
set -a
source .env
set +a
npm run start:cloud
```

## Nginx 反向代理

复制示例：

```bash
sudo cp deploy/nginx-cloud.conf.example /etc/nginx/sites-available/telecom-photo.conf
sudo ln -s /etc/nginx/sites-available/telecom-photo.conf /etc/nginx/sites-enabled/telecom-photo.conf
sudo nginx -t
sudo systemctl reload nginx
```

把示例中的 `photo.example.com` 改成你的域名。

HTTPS 可以使用 Certbot：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d photo.example.com
```

## App 测试

1. 云服务器启动后，浏览器访问 `https://photo.example.com/api/public/health`。
2. 返回 `status: ok` 表示后端可访问。
3. 重新打包 APK：

```powershell
npm.cmd run android:apk
```

4. 安装 APK 到手机。
5. 登录页打开服务器地址设置。
6. 填写：

```text
https://photo.example.com
```

7. 点击“测试连接”，成功后登录。

## 端口建议

正式测试：

- 开放：`80`、`443`
- 不开放：`3001`
- Node.js 只监听 `127.0.0.1:3001`
- Nginx 代理公网请求到 `127.0.0.1:3001`

临时调试：

- 可短时间开放 `3001`
- App 可填写 `http://服务器公网IP:3001`
- 调试完成后应关闭 `3001`

## 数据和备份

照片和 SQLite 数据库在 `DATA_DIR` 下：

```text
/data/telecom-photo/app.sqlite
/data/telecom-photo/uploads
/data/telecom-photo/backups
```

测试期间建议每天备份：

- 管理员进入“健康与备份”
- 点击“一键备份”
- 下载 ZIP 备份包

## 常见问题

App 测试连接失败：

- 检查 App 填写的是 `https://域名`，不是 `localhost`
- 检查域名是否解析到云服务器公网 IP
- 检查安全组是否开放 `443`
- 检查 Nginx 是否启动
- 检查 `/api/public/health` 是否可访问

网页能打开但照片上传失败：

- 检查 Nginx `client_max_body_size` 是否大于照片大小
- 检查 `DATA_DIR` 是否可写
- 检查磁盘是否已满

WebSocket 进度不同步：

- 检查 Nginx `/ws` 是否配置了 `Upgrade` 和 `Connection`
- 检查浏览器控制台是否有 WebSocket 连接错误
