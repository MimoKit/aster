<div align="center">

# Aster

**用 TypeScript 编写的 QQ 机器人框架**

插件是普通的 `.ts` 文件，改完存盘立刻生效 —— 不编译、不重启

[![CI](https://img.shields.io/github/actions/workflow/status/MimoKit/aster/ci.yml?branch=main&label=CI&logo=github)](https://github.com/MimoKit/aster/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/aster-bot?logo=npm&label=npm)](https://www.npmjs.com/package/aster-bot)
[![Node](https://img.shields.io/node/v/aster-bot?logo=node.js&label=node)](https://nodejs.org)
[![License](https://img.shields.io/github/license/MimoKit/aster?label=license)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](./tsconfig.json)

[快速开始](#快速开始) · [插件开发](./docs/plugin.md) · [配置](./docs/config.md) · [部署](./docs/deploy.md) · [架构](./docs/architecture.md)

</div>

---

## 特性

| | |
|---|---|
| **TypeScript 全栈** | 内核与插件同一门语言，`strict` 全开，配置与事件都有完整类型 |
| **零编译插件** | 插件是普通 `.ts` 文件，运行时加载；存盘即生效，改一行不用等构建 |
| **OneBot v11** | 反向 WebSocket 接入 Lagrange / NapCat / LLOneBot / go-cqhttp 等实现 |
| **消息规范化** | CQ 码、标准数组、扁平数组三种形态归一成同一套结构 |
| **WebUI** | 自带控制台：实时状态、事件流、日志、插件列表、配置编辑、消息测试台 |
| **依赖极少** | 运行时只有 3 个依赖：`ws`、`jiti`、`smol-toml` |

## 快速开始

```bash
# 全局安装
npm install -g aster-bot

# 启动（前台运行，Ctrl-C 退出）
aster
```

终端会打印两个地址：

```text
协议端请连接：ws://127.0.0.1:5310/onebot/v11/ws
控制台地址：  http://127.0.0.1:5311
```

把第一个地址填进协议端的「反向 WebSocket」配置，连上后：

```bash
# 在群里发送
as          # 查看运行状态
as 详细     # 详细信息
echo 你好   # 内置示例插件
```

> [!TIP]
> 数据目录默认是当前目录。想在固定位置存放配置与插件，用 `aster --data ~/my-bot`，
> 或设置环境变量 `ASTER_DATA`。

## 写一个插件

在数据目录下建 `plugins/hello.ts`：

```ts
import { definePlugin, seg } from 'aster-bot';

export default definePlugin({
  name: 'hello',
  desc: '打个招呼',
  rules: [
    {
      name: '打招呼',
      command: 'hi', // 命令词独立成词：hi / hi 参数 都触发，hi_there 不触发
      async handler(ctx) {
        if (!ctx.args) {
          return ctx.reply('用法：hi <名字>');
        }
        return ctx.reply([seg.at(ctx.userId), seg.text(` 你好，${ctx.args}！`)]);
      },
    },
  ],
});
```

**存盘即生效**，终端会打印：

```text
2026-09-17 15:21:03.412 INFO  [plugin] 插件已重载：2 → 3 个，共 3 条规则
```

群里发 `hi 世界`，机器人就会 @ 你并回复。完整 API 见 **[插件开发指南](./docs/plugin.md)**。

## 内置插件

| 命令 | 作用 |
|------|------|
| `as` | 简要运行状态 |
| `as 详细` | 详细信息（事件统计、账号列表、监听地址） |
| `as 帮助` | 命令列表 |
| `echo <内容>` | 复读；`echo 我的名片` 看发送者信息，`echo 图片` 演示消息段 |

不想用内置插件：

```toml
[bot]
builtin_plugins = false
```

## WebUI

`aster` 启动后访问 <http://127.0.0.1:5311>。

| 页面 | 内容 |
|------|------|
| **总览** | 运行时长、事件统计、在线账号、实时事件流 |
| **连接** | 账号详情、接入地址一键复制 |
| **插件** | 已加载插件、规则、权限、作用范围，支持手动重载 |
| **插件市场** | 浏览 [xlinxt/aster-plugins](https://github.com/xlinxt/aster-plugins) 上的插件 |
| **发送台** | 直接调 API 发消息，接入调试用 |
| **日志** | 级别筛选、实时跟踪、滚动到底自动恢复跟随 |
| **配置** | 表单化编辑，改动按点路径写回 |

> [!WARNING]
> WebUI 的权限**等同于机器人本身**：能以任意账号发消息、改配置、看日志。
> 默认只监听 `127.0.0.1`。需要远程访问时优先用 SSH 隧道，详见 [安全策略](./SECURITY.md)。

## 配置

`aster init` 会在数据目录生成带注释的 `config.toml`：

```toml
[bot]
name = "Aster"
masters = []              # 主人账号，拥有所有插件权限
command_prefix = ""       # 留空则命令直接以命令词开头（如 as）

[log]
level = "info"            # trace | debug | info | warn | error | silent

[onebot11]
host = "0.0.0.0"
port = 5310
path = "/onebot/v11/ws"
access_token = ""         # 对外暴露时务必设置

[webui]
host = "127.0.0.1"
port = 5311
access_token = ""

[plugin]
dir = "plugins"
hot_reload = true
```

也可以用命令行改：

```bash
aster config                                  # 查看全部
aster config get onebot11.port                # 读单项
aster config set onebot11.port 5312           # 改单项
aster config set bot.masters '["123456"]'     # 数组
```

完整字段说明见 **[配置参考](./docs/config.md)**。

## 后台常驻

Aster 只做前台启动，不做进程守护（不写 PID 文件、不后台化）。需要常驻请自行托管：

<details>
<summary><b>systemd</b>（推荐）</summary>

```ini
# ~/.config/systemd/user/aster.service
[Unit]
Description=Aster Bot
After=network.target

[Service]
WorkingDirectory=%h/my-bot
ExecStart=%h/.local/bin/aster
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now aster
journalctl --user -u aster -f
```

</details>

<details>
<summary><b>screen / tmux</b></summary>

```bash
screen -S aster -d -m aster      # 脱离，Ctrl-A D 返回
tmux new -d -s aster aster
```

</details>

<details>
<summary><b>nohup</b></summary>

```bash
nohup aster > aster.log 2>&1 &
tail -f aster.log
```

</details>

更多部署方式（Docker、反向代理、跨机部署）见 **[部署指南](./docs/deploy.md)**。

## 文档

| 文档 | 内容 |
|------|------|
| [快速开始](./docs/getting-started.md) | 安装、接入协议端、第一个插件 |
| [插件开发](./docs/plugin.md) | 规则匹配、上下文 API、权限、热重载、调试技巧 |
| [配置参考](./docs/config.md) | 全部配置项、环境变量、配置优先级 |
| [部署指南](./docs/deploy.md) | systemd、Docker、反向代理、跨机部署 |
| [架构说明](./docs/architecture.md) | 事件从协议端到插件的完整路径、目录职责 |
| [贡献指南](./CONTRIBUTING.md) | 本地开发、代码约定、提 PR |
| [安全策略](./SECURITY.md) | 漏洞报告、部署安全要点 |

## 项目结构

```text
src/
├── message.ts      消息段与 CQ 码：三种输入形态归一
├── event.ts        事件归一化：字段类型差异的容忍层
├── onebot11.ts     适配器：WS 服务端、echo 调用、账号注册表
├── plugin.ts       插件 API：definePlugin 与定义校验
├── plugin-host.ts  插件宿主：加载、匹配、分发、热重载
├── config.ts       配置：TOML 读写、校验、点路径访问
├── logger.ts       日志：终端输出 + 内存环形缓冲
├── webui.ts        HTTP API、SSE、前端托管
├── app.ts          装配：把上面这些拼成可启动的整体
└── cli.ts          命令行
plugins/            内置插件（和第三方插件走同一套 API）
webui/              前端（React + Vite + Tailwind）
docs/               文档
```

## 常见问题

<details>
<summary><b>端口被占用怎么办？</b></summary>

```bash
ss -ltnp | grep 5310        # 看谁占着
aster config set onebot11.port 5312
```

启动时会明确报错并给出提示，不会静默挂起。

</details>

<details>
<summary><b>协议端连不上？</b></summary>

按顺序检查：

1. `ss -ltn | grep 5310` 确认端口在监听
2. 协议端填的路径要和 `onebot11.path` 完全一致（默认 `/onebot/v11/ws`）
3. 若设置了 `access_token`，协议端也要填同样的值
4. 跨机器部署时 `host` 要改成 `0.0.0.0`，并放行防火墙端口
5. 打开 `log.level = "debug"` 看握手阶段的日志

</details>

<details>
<summary><b>插件改了没生效？</b></summary>

- 文件名不能以 `_` 或 `.` 开头（会被当作草稿跳过）
- 确认 `plugin.hot_reload = true`
- 语法错误会打印在终端，加载失败不会影响其他插件
- 也可以在 WebUI 的「插件」页点手动重载

</details>

<details>
<summary><b>为什么命令前面不用加 <code>#</code>？</b></summary>

命令词本身就是触发词，`as` 直接发就行。想恢复 `#as` 风格：

```toml
[bot]
command_prefix = "#"
```

</details>

## 相关项目

- [OneBot v11 标准](https://github.com/botuniverse/onebot-11) —— 协议规范
- [xlinxt/aster-plugins](https://github.com/xlinxt/aster-plugins) —— 插件市场
- [Yunzai](https://github.com/TimeRainStarSky/Yunzai) / [Karin](https://github.com/KarinJS/Karin) / [NoneBot2](https://github.com/nonebot/nonebot2) —— 同类框架，本项目的插件模型参考了它们的设计

## License

[MIT](./LICENSE)
