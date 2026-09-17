# Aster

基于 OneBot v11 的 QQ 机器人框架，使用 TypeScript 编写。

[![CI](https://img.shields.io/github/actions/workflow/status/MimoKit/aster/ci.yml?branch=main&label=CI&logo=github)](https://github.com/MimoKit/aster/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/aster-bot?logo=npm)](https://www.npmjs.com/package/aster-bot)
[![License](https://img.shields.io/github/license/MimoKit/aster)](./LICENSE)

## 安装

需要 Node.js 20.11 或更高版本。

```bash
npm install -g aster-bot
```

## 启动

```bash
aster
```

首次运行会在当前目录生成 `config.toml` 和 `plugins/`，然后监听两个端口：

| | 地址 |
|---|---|
| OneBot v11 | `ws://127.0.0.1:5310/onebot/v11/ws` |
| WebUI | <http://127.0.0.1:5311> |

在协议端（NapCat、Lagrange、LLOneBot、go-cqhttp 等）里配置反向 WebSocket，
地址填 `ws://127.0.0.1:5310/onebot/v11/ws`。连上后终端会打印账号上线日志。

数据目录默认是当前目录，可以指定：

```bash
aster --data ~/my-bot
```

## 写插件

在 `plugins/` 下新建 `hello.ts`：

```ts
import { definePlugin } from 'aster-bot';

export default definePlugin({
  name: 'hello',
  desc: '打招呼',
  rules: [
    {
      name: '打招呼',
      command: 'hi',
      async handler(ctx) {
        if (!ctx.args) return ctx.reply('用法：hi <名字>');
        return ctx.reply(`你好，${ctx.args}`);
      },
    },
  ],
});
```

保存后自动加载，群里发 `hi 世界` 就会回复。

匹配方式有 `command`（命令词独立成词）、`prefix`、`exact`、`regex`、`contains`、`any`，
权限有 `all` / `master` / `admin` / `owner`，范围有 `any` / `group` / `private`。
完整 API 见 [插件开发文档](./docs/plugin.md)。

## 内置命令

| 命令 | 说明 |
|---|---|
| `as` | 运行状态 |
| `as 详细` | 事件统计、账号列表、监听地址 |
| `as 帮助` | 命令帮助 |
| `echo <内容>` | 复读 |

关闭内置插件：

```toml
[bot]
builtin_plugins = false
```

## 配置

`config.toml`：

```toml
[bot]
name = "Aster"
masters = []              # 主人 QQ，拥有所有插件权限
builtin_plugins = true
command_prefix = ""       # 留空则命令直接以命令词开头

[log]
level = "info"            # trace | debug | info | warn | error | silent

[onebot11]
enable = true
host = "0.0.0.0"
port = 5310
path = "/onebot/v11/ws"
access_token = ""
trusted_ips = []

[webui]
enable = true
host = "127.0.0.1"
port = 5311
access_token = ""

[plugin]
dir = "plugins"
hot_reload = true
```

命令行读取和修改：

```bash
aster config                            # 查看全部
aster config get onebot11.port          # 读单项
aster config set onebot11.port 5312     # 改单项
aster config set bot.masters '["123"]'  # 数组
aster config path                       # 配置文件路径
```

每个字段的含义见 [配置参考](./docs/config.md)。

## 后台运行

只支持前台启动，不做进程守护。常驻请自行托管：

```bash
# systemd
# ~/.config/systemd/user/aster.service
[Unit]
Description=Aster
After=network.target

[Service]
WorkingDirectory=%h/my-bot
ExecStart=%h/.local/bin/aster
Restart=always

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now aster
journalctl --user -u aster -f
```

或者用 `tmux new -d -s aster aster`、`nohup aster > aster.log 2>&1 &`。
Docker 与反向代理配置见 [部署指南](./docs/deploy.md)。

## 命令行

```text
aster                              前台启动
aster config [get|set|path|reset]  配置读写
aster plugin                       列出已加载插件
aster init                         只生成配置
aster version                      版本号
aster --port 5312                  临时改端口启动
```

## 文档

- [快速开始](./docs/getting-started.md) — 装好到跑通
- [插件开发](./docs/plugin.md) — 匹配规则、上下文 API、权限、调试
- [配置参考](./docs/config.md) — 全部字段与环境变量
- [部署指南](./docs/deploy.md) — systemd、Docker、反向代理
- [架构说明](./docs/architecture.md) — 事件流转与模块职责
- [更新日志](./CHANGELOG.md)

## 安全提醒

- WebUI 权限等同于机器人本身，默认只监听 `127.0.0.1`。要对外访问请先设 `webui.access_token`，或改用 SSH 隧道。
- `onebot11` 监听 `0.0.0.0` 且没有 `access_token` 时，任何能访问该端口的人都能接入。用 `trusted_ips` 或设 token。
- 插件是进程内可执行代码，装第三方插件前先看源码。

细节见 [SECURITY.md](./SECURITY.md)。

## License

[MIT](./LICENSE)
