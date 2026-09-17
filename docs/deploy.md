# 部署指南

Aster 只做**前台启动**：不写 PID 文件、不自动后台化、不做进程守护。
这样进程模型简单可预期，常驻交给专门的工具去做。

## 选择托管方式

| 方式 | 适合 | 优点 |
|------|------|------|
| [systemd](#systemd) | 长期运行的生产环境 | 自动重启、日志归集、开机自启 |
| [Docker](#docker) | 容器化环境、多实例 | 环境隔离、部署一致 |
| [screen / tmux](#screen--tmux) | 临时跑、调试 | 零配置 |
| [nohup](#nohup) | 一次性后台 | 简单 |

## systemd

用户级服务，不需要 root。

```ini
# ~/.config/systemd/user/aster.service
[Unit]
Description=Aster Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/my-bot
ExecStart=%h/.local/bin/aster
Restart=always
RestartSec=5

# 日志带上时间戳（Aster 自己也会打）
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now aster

systemctl --user status aster        # 看状态
journalctl --user -u aster -f        # 跟踪日志
systemctl --user restart aster        # 重启（改配置后）
```

<details>
<summary><b>想让服务在没登录时也运行</b></summary>

默认情况下用户级服务在用户注销后会停止。开启 lingering：

```bash
sudo loginctl enable-linger $USER
```

</details>

<details>
<summary><b>系统级服务（root 运行）</b></summary>

```ini
# /etc/systemd/system/aster.service
[Unit]
Description=Aster Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=aster
WorkingDirectory=/home/aster/my-bot
ExecStart=/usr/bin/aster
Restart=always
RestartSec=5

# 基础加固
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/aster/my-bot

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now aster
```

</details>

## Docker

```dockerfile
FROM node:22-alpine

WORKDIR /app

# 只装生产依赖
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# 数据目录挂出来，配置与插件都在里面
VOLUME /data
WORKDIR /data

EXPOSE 5310 5311
CMD ["npx", "aster"]
```

构建与运行：

```bash
docker build -t aster .

docker run -d \
  --name aster \
  --restart unless-stopped \
  -p 5310:5310 \
  -p 127.0.0.1:5311:5311 \
  -v "$PWD/data:/data" \
  aster
```

> [!IMPORTANT]
> 协议端在宿主机上时，容器里的 `onebot11.host` 保持 `0.0.0.0`，
> 协议端连接宿主机的 `5310`。反过来（协议端在容器里）要用 Docker 网络名而不是 `127.0.0.1`。

<details>
<summary><b>docker compose</b></summary>

```yaml
services:
  aster:
    build: .
    container_name: aster
    restart: unless-stopped
    ports:
      - '5310:5310'
      - '127.0.0.1:5311:5311'   # 控制台只映射到本机
    volumes:
      - ./data:/data
    environment:
      - TZ=Asia/Shanghai
```

```bash
docker compose up -d
docker compose logs -f
```

</details>

<details>
<summary><b>用 npm 包而不是源码构建</b></summary>

```dockerfile
FROM node:22-alpine
RUN npm install -g aster-bot
VOLUME /data
WORKDIR /data
EXPOSE 5310 5311
CMD ["aster"]
```

镜像更小，但插件需要的额外依赖要在运行时装。

</details>

## screen / tmux

```bash
# screen
screen -S aster -d -m aster
screen -r aster            # 回到会话，Ctrl-A D 脱离

# tmux
tmux new -d -s aster aster
tmux attach -t aster       # Ctrl-B D 脱离
```

## nohup

```bash
nohup aster > aster.log 2>&1 &
echo $! > aster.pid

tail -f aster.log
kill "$(cat aster.pid)"    # 停止
```

> [!NOTE]
> Aster 收到 `SIGTERM` / `SIGINT` 会优雅关闭：断开所有连接、写完日志再退出。

## 跨机部署

协议端与框架不在同一台机器时：

```toml
[onebot11]
host = "0.0.0.0"                          # 不能是 127.0.0.1
access_token = "openssl rand -hex 24"     # 必须设
trusted_ips = ["192.168.1.50"]            # 只放行协议端
```

放行防火墙：

```bash
# firewalld
sudo firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=192.168.1.50 port port=5310 protocol=tcp accept'
sudo firewall-cmd --reload

# ufw
sudo ufw allow from 192.168.1.50 to any port 5310 proto tcp
```

> [!TIP]
> 两台机器在同一个可信内网时，也可以什么都不设、直接放行内网网段。
> 但**绝对不要把 5310 暴露到公网且不设 token**。

## 反向代理

协议端不方便直连、或需要统一走 443 时，用 Nginx 转发。

```nginx
server {
    listen 443 ssl http2;
    server_name bot.example.com;

    ssl_certificate     /etc/letsencrypt/live/bot.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bot.example.com/privkey.pem;

    location /onebot/v11/ws {
        proxy_pass http://127.0.0.1:5310;
        proxy_http_version 1.1;

        # WebSocket 升级必须显式转发
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        # 要大于 heartbeat_timeout，否则长连接会被代理掐断
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

协议端则填：

```text
wss://bot.example.com/onebot/v11/ws?access_token=<token>
```

> [!WARNING]
> 走代理后 `trusted_ips` 里看到的是代理的 IP，不是协议端的真实 IP。
> 要么把代理 IP 加进白名单，要么改用 `access_token` 鉴权。

## 远程访问控制台

控制台权限等于机器人本身，**不建议直接暴露到公网**。

<details>
<summary><b>方式一：SSH 隧道（推荐）</b></summary>

控制台保持 `host = "127.0.0.1"`，本地做端口转发：

```bash
ssh -L 5311:127.0.0.1:5311 用户@服务器
# 本地浏览器打开 http://127.0.0.1:5311
```

不用改任何配置，也不用担心 token 泄露。

</details>

<details>
<summary><b>方式二：Nginx + HTTPS + token</b></summary>

```nginx
server {
    listen 443 ssl http2;
    server_name bot-admin.example.com;

    ssl_certificate     /etc/letsencrypt/live/bot-admin.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bot-admin.example.com/privkey.pem;

    # 限制来源
    allow 203.0.113.0/24;
    deny all;

    location / {
        proxy_pass http://127.0.0.1:5311;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        # SSE 不能被缓冲，否则日志与事件流会卡住
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}
```

配置里必须设 `webui.access_token`。WebUI 只有 HTTP，token 走明文，
所以**必须**由 Nginx 终止 TLS。

</details>

## 运维

### 日志

```bash
journalctl --user -u aster -f              # systemd
docker compose logs -f                     # Docker
tail -f aster.log                          # nohup
```

结构化筛选：

```bash
journalctl --user -u aster | grep -i error
journalctl --user -u aster --since "1 hour ago"
```

### 更新

```bash
npm install -g aster-bot@latest
systemctl --user restart aster
```

> [!NOTE]
> 更新前先看 [CHANGELOG](../CHANGELOG.md)，注意有没有破坏性变更。

### 备份

要备份的只有数据目录：

```bash
tar czf aster-backup-$(date +%F).tar.gz -C ~ my-bot
```

包含 `config.toml` 与 `plugins/`。**注意配置里可能有 token**，别传到公开的地方。

### 健康检查

框架自身暴露了健康接口：

```bash
# OneBot 端口（不受 WebUI 鉴权影响）
curl http://127.0.0.1:5310/health
# {"status":"ok","bots":1}

# WebUI 端口
curl http://127.0.0.1:5311/api/health
# {"status":"ok","version":"0.1.0"}
```

配合监控做存活检测：

```bash
# 简单的看门狗
*/5 * * * * curl -sf http://127.0.0.1:5310/health > /dev/null || systemctl --user restart aster
```

### 排查

<details>
<summary><b>进程起来了但协议端连不上</b></summary>

```bash
ss -ltnp | grep 5310                     # 端口在听吗
curl http://127.0.0.1:5310/health        # 本机能通吗
sudo iptables -L -n | grep 5310          # 防火墙
```

从协议端所在机器测试：

```bash
nc -vz <框架IP> 5310
```

</details>

<details>
<summary><b>容器里连不上宿主机的协议端</b></summary>

`127.0.0.1` 在容器里指的是容器自己。要么用 `host.docker.internal`（Docker Desktop），
要么用宿主机的内网 IP，要么把协议端也放进同一个 compose 网络里用服务名互访。

</details>

<details>
<summary><b>连上后频繁掉线</b></summary>

多半是心跳超时太短或代理掐了长连接：

```toml
[onebot11]
heartbeat_timeout = 180     # 放宽
```

同时确认 Nginx 的 `proxy_read_timeout` 大于这个值。

</details>
