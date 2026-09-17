# 安全策略

## 报告漏洞

**不要开公开 issue。**

用 GitHub 的私密渠道：[提交安全公告](https://github.com/MimoKit/aster/security/advisories/new)，
或直接邮件联系维护者。

请附上：

- 影响版本
- 复现步骤或 PoC
- 影响面（能做什么、需要什么前提）
- 如果有修复思路也一并说明

一般 48 小时内会回复。确认后会在修复版本里致谢（除非你希望匿名）。

## 部署时的安全要点

Aster 有两处对外监听，默认配置已经尽量保守，改动时注意以下几点。

### WebUI 不要裸奔在公网

WebUI 的权限**等同于机器人本身**：能以任意账号发消息、改配置、看日志。

```toml
[webui]
host = "127.0.0.1"        # 默认只监听本机，保持这样最安全
access_token = ""         # 改成 0.0.0.0 时【必须】设置
```

需要远程访问时，优先用 SSH 隧道而不是直接暴露：

```bash
ssh -L 5311:127.0.0.1:5311 你的服务器
# 本地浏览器开 http://127.0.0.1:5311
```

一定要公网访问的话，至少：

1. `access_token` 用 `openssl rand -hex 32` 生成
2. 前面套一层 Nginx/Caddy 做 HTTPS —— WebUI 本身只有 HTTP，token 走明文
3. 用防火墙或安全组限制来源 IP

### OneBot 端口要鉴权

`5310` 是协议端接入的入口。默认监听 `0.0.0.0`（协议端常在同机或内网另一台机器），
如果机器有公网 IP，务必：

```toml
[onebot11]
access_token = "另一个随机串"
trusted_ips = ["127.0.0.1", "192.168.1.50"]   # 只放行协议端
```

### Token 的存放

- `config.toml` 已经在 `.gitignore` 里，**不要提交**
- 环境变量可以覆盖：`ASTER_DATA`、`ASTER_WEBUI_DIST`
- 容器部署时用 secret 挂载，不要写进镜像

### 插件是可执行代码

插件跑在框架进程里，**权限和框架完全一样**。装第三方插件前先看一眼源码，
尤其是网络请求与文件读写。市场里的插件只提供仓库地址，框架不做事前审计。

### 反向代理注意

用 Nginx 代理 WebSocket 时需要显式转发升级头：

```nginx
location /onebot/v11/ws {
    proxy_pass http://127.0.0.1:5310;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;      # 心跳间隔要小于这个值
}
```

## 支持范围

只对**最新发布版本**提供安全修复。旧版本请先升级。
