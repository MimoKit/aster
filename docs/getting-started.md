# 快速开始

从零把一个机器人跑起来，大约需要五分钟。

## 准备

| 需要 | 说明 |
|------|------|
| **Node.js 20.11+** | `node -v` 检查；推荐 22 或更高 |
| **一个 QQ 协议端** | Lagrange / NapCat / LLOneBot / go-cqhttp 等，需支持 OneBot v11 |
| **一个 QQ 号** | 建议用小号 |

> [!NOTE]
> 协议端不在本项目范围内，需要你自行准备并登录。
> 各实现的安装方式见其自身文档。

## 安装

```bash
npm install -g aster-bot
```

如果提示权限不足，说明 npm 的全局目录是系统路径。**不要用 `sudo`**，
把全局前缀指到用户目录即可：

```bash
npm config set prefix ~/.local
export PATH="$HOME/.local/bin:$PATH"   # 建议写进 ~/.bashrc
npm install -g aster-bot

aster version   # 验证
```

<details>
<summary><b>从源码安装</b></summary>

```bash
git clone https://github.com/MimoKit/aster.git
cd aster
npm install
npm start
```

开发期不需要构建：Node 22+ 能直接执行 TypeScript。

</details>

## 首次启动

```bash
# 指定一个数据目录，配置与插件都放这里
mkdir -p ~/my-bot && cd ~/my-bot

aster
```

输出：

```text
2026-09-17 15:17:37.241 INFO  [aster] Aster v0.1.0 启动中
2026-09-17 15:17:37.242 INFO  [aster] 已加载 2 个插件、2 条规则
2026-09-17 15:17:37.251 INFO  [onebot11] 已监听 ws://127.0.0.1:5310/onebot/v11/ws（鉴权：关闭）
2026-09-17 15:17:37.252 INFO  [plugin] 插件热重载已开启（2 个目录），改动文件后自动生效
2026-09-17 15:17:37.254 INFO  [webui] 已启动：http://127.0.0.1:5311
协议端请连接：ws://127.0.0.1:5310/onebot/v11/ws
控制台地址：  http://127.0.0.1:5311
```

同时目录下会生成：

```text
my-bot/
├── config.toml     带注释的配置
└── plugins/        空的插件目录
```

## 接入协议端

在协议端里找「**反向 WebSocket**」相关的配置，填入：

| 配置项 | 值 |
|--------|-----|
| 地址 | `ws://127.0.0.1:5310/onebot/v11/ws` |
| Access Token | 留空（与 `config.toml` 保持一致） |

<details>
<summary><b>各协议端的填法</b></summary>

协议端之间主要是字段名不同，含义一致：

```text
# NapCat / LLOneBot 这类
WebSocket 反向地址：ws://127.0.0.1:5310/onebot/v11/ws
Token：

# Lagrange
- Type: ws-reverse
  Universal: ws://127.0.0.1:5310/onebot/v11/ws
```

关键点：**路径要带全**，`/onebot/v11/ws` 不能省。

</details>

连上后终端会打印：

```text
2026-09-17 15:20:01.882 INFO  [onebot11] 新连接 127.0.0.1:54321（当前 1 个）
2026-09-17 15:20:01.885 INFO  [onebot11] 账号 123456 上线（127.0.0.1:54321）
2026-09-17 15:20:01.886 INFO  [onebot11] 登录信息：我的机器人（123456）
```

## 验证

在群里（或私聊）发送：

```text
as
```

应该收到：

```text
【Aster 运行状态】
版本：v0.1.0
运行：1分20秒
在线账号：1 个
已处理事件：2 条
插件：2 个（0 次命中）
```

收到就说明链路通了。再试试内置的示例插件：

```text
echo 你好        → 你好
echo 我的名片    → 昵称、账号、会话类型
as 详细          → 事件统计与账号列表
```

## 第一个插件

在 `plugins/` 下建 `hello.ts`：

```ts
import { definePlugin } from 'aster-bot';

export default definePlugin({
  name: 'hello',
  desc: '我的第一个插件',
  rules: [
    {
      name: '打招呼',
      command: 'hi',
      async handler(ctx) {
        if (!ctx.args) return ctx.reply('用法：hi <名字>');
        return ctx.reply(`你好，${ctx.args}！`);
      },
    },
  ],
});
```

保存后**不用重启**，终端会打印：

```text
2026-09-17 15:21:03.412 INFO  [plugin] 插件已重载：2 → 3 个，共 3 条规则
```

群里发 `hi 世界`，机器人回复 `你好，世界！`。

> [!TIP]
> 试着把回复文字改一下再保存，同样立刻生效。
> 这就是不用编译的好处 —— 调文案不用等构建。

## 打开控制台

浏览器访问 <http://127.0.0.1:5311>，可以看到：

- **总览** —— 运行时长、事件统计、实时事件流
- **插件** —— 刚写的 `hello` 已经在列表里
- **日志** —— 每条命令的触发记录
- **发送台** —— 不经过 QQ 直接测试发消息

## 配置主人账号

`permission: 'master'` / `'admin'` / `'owner'` 的规则需要身份判断。
把自己的 QQ 号配成主人：

```bash
aster config set bot.masters '["你的QQ号"]'
```

或直接改 `config.toml`：

```toml
[bot]
masters = ["123456"]
```

改完重启生效。

## 下一步

| 想看什么 | 去哪 |
|---------|------|
| 插件能做什么 | [插件开发](./plugin.md) |
| 每个配置项什么意思 | [配置参考](./config.md) |
| 怎么让它一直跑着 | [部署指南](./deploy.md) |
| 事件是怎么流转的 | [架构说明](./architecture.md) |

## 遇到问题

<details>
<summary><b><code>aster: command not found</code></b></summary>

npm 全局目录不在 `PATH` 里：

```bash
npm config get prefix        # 看装到哪了
export PATH="$(npm config get prefix)/bin:$PATH"
```

写进 `~/.bashrc` 或 `~/.zshrc` 永久生效。

</details>

<details>
<summary><b>端口已被占用</b></summary>

```bash
ss -ltnp | grep 5310
aster config set onebot11.port 5312
```

WebUI 端口冲突同理，改 `webui.port`。

</details>

<details>
<summary><b>协议端连不上，日志里什么都没有</b></summary>

说明连接根本没到达框架。检查：

1. `ss -ltn | grep 5310` —— 端口是不是在监听
2. 协议端与框架**不在同一台机器**时，`onebot11.host` 要改成 `0.0.0.0`，并放行防火墙
3. 路径大小写、斜杠要完全一致
4. 协议端那边的错误日志往往更具体

</details>

<details>
<summary><b>连上了但命令没反应</b></summary>

```bash
# 打开调试日志，看事件有没有进来、匹配过程如何
aster config set log.level debug
```

如果连 `message` 事件的日志都没有，说明协议端没在上报消息事件，
检查它的事件订阅配置（有些实现默认只开部分事件）。

</details>
