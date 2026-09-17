# Aster

用 Rust 编写的 Bot 框架。当前阶段聚焦 **OneBot v11 适配器**与**消息字段规范化**。

## 特性

- **反向 WebSocket 服务端**：框架监听端口，协议端（Lagrange / NapCat / LLOneBot / go-cqhttp 等）主动连上来
- **消息字段规范化**：CQ 码字符串与数组形态统一收敛为强类型 `Segment`
- **事件规范化**：`message` / `notice` / `request` / `meta_event` 全部建模为强类型枚举
- **ID 类型归一**：`123` 与 `"123"` 视为同一个 ID，字符串 ID（如频道 `g1-c1`）原样保留
- **API 调用**：基于 `echo` 的请求-响应关联，带超时与连接断开清理
- **鉴权**：支持 `Authorization: Bearer`、`?access_token=` 查询参数、IP 白名单
- **插件系统**：命令词独立成词、优先级排序、四级权限、群聊/私聊范围控制
- **日志脱敏**：`base64://` 内容自动折叠，避免刷屏

## 快速开始

### 方式一：npm（推荐）

```bash
# 全局安装
npm install -g aster-bot

# 启动（前台运行，日志直接打在终端）
aster

# 另开终端改配置
aster config set onebot11.port 5310
```

### 方式二：从源码

```bash
git clone https://github.com/MimoKit/aster.git
cd aster
cargo build --release
./target/release/aster
```

启动后监听：

```text
ws://0.0.0.0:5310/onebot/v11/ws
```

把协议端的「反向 WebSocket」地址填成上面这个即可。

> **关于端口**：`0531` / `531` 属于特权端口（< 1024），普通用户无法绑定。
> 默认使用 **5310**；若确实需要 531，请执行
> `sudo setcap 'cap_net_bind_service=+ep' target/release/aster` 或用 sudo 启动，
> 并把 `config.toml` 里的 `port` 改成 531。

## 命令行

npm 安装后提供 `aster` 命令。**默认就是前台启动**，日志直接打在终端：

```bash
aster                 # 启动（等同于 aster start）
aster config          # 查看全部配置
aster config get onebot11.port
aster config set onebot11.port 5310
aster init            # 只生成配置，不启动
aster build           # 只编译 Rust 可执行文件
aster --help
```

常用选项：`--home <目录>` 指定数据目录，`--port <端口>` 临时覆盖端口。

### 数据目录

默认是当前目录下的 `./aster-data`，可用 `ASTER_HOME` 或 `--home` 指定：

```text
aster-data/
└── config.toml      运行配置
```

框架只维护这一个文件；日志不落盘，前台直启时日志就在终端里。

### 后台常驻

Aster 本身**不做进程守护**（不写 PID 文件、不后台化），需要常驻请自行托管：

**systemd**（推荐）

```ini
# ~/.config/systemd/user/aster.service
[Unit]
Description=Aster Bot
After=network.target

[Service]
WorkingDirectory=%h/bot/Aster
ExecStart=%h/.local/bin/aster
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now aster
journalctl --user -u aster -f      # 看日志
```

**screen**

```bash
screen -S aster -d -m aster
screen -r aster                     # 回到会话，Ctrl-A D 脱离
```

**tmux**

```bash
tmux new -d -s aster aster
tmux attach -t aster
```

**nohup**

```bash
nohup aster > aster.log 2>&1 &
tail -f aster.log
```

## 没有协议端时如何自测

内置了一个模拟协议端：

```bash
# 终端 1：启动框架
aster

# 终端 2：连接并上报一批样例事件
cargo run --release --example mock_adapter
```

终端 1 会直接打印框架处理结果。

## 配置

`config.toml`（首次运行从 `config/default.toml` 复制，位于数据目录下）：

```toml
[bot]
name = "Aster"

[log]
level = "info"          # trace | debug | info | warn | error | off
max_len = 4096          # 单条日志字符串上限
show_base64 = false     # 是否打印完整 base64

[onebot11]
enable = true
host = "0.0.0.0"
port = 5310
path = "/onebot/v11/ws"
access_token = ""       # 空表示不校验
trusted_ips = []        # 空表示不限制
heartbeat_timeout = 90  # 秒
handshake_timeout = 10
request_timeout = 60
```

环境变量可覆盖：`ASTER_HOST`、`ASTER_PORT`、`ASTER_TOKEN`、`ASTER_LOG`。

## 代码结构

```text
src/
├── main.rs              程序入口：配置 → 日志 → 注册插件 → 启动适配器 → 分发事件
├── lib.rs               库入口与文档
├── config.rs            配置加载与校验
├── logging.rs           日志初始化与 base64 脱敏
├── stats.rs             运行时统计（事件计数、运行时长）
├── message/             ★ 消息字段规范化
│   ├── segment.rs       消息段枚举（Segment）+ CQ 转义
│   ├── cq.rs            CQ 码字符串 → 消息段
│   ├── parser.rs        message 字段（字符串/数组）→ 消息段
│   ├── text.rs          消息段 → raw_message / 可读文本
│   └── mod.rs           MessageContent：上层统一入口
├── event/               ★ 事件规范化
│   ├── common.rs        Id / Sender / Anonymous / FileInfo / 取值辅助
│   └── mod.rs           Event / MessageEvent / NoticeEvent / RequestEvent / MetaEvent
├── plugin/              ★ 插件系统
│   ├── rule.rs          规则：匹配方式 / 权限 / 范围
│   ├── builtin.rs       内置插件（as 状态查询）
│   └── mod.rs           Plugin / PluginContext / PluginRegistry
└── onebot11/            OneBot v11 适配器
    ├── action.rs        action-echo 调用（ApiCaller）+ 常用 API 封装
    ├── connection.rs    连接生命周期、Bot 注册表、EventBus
    └── mod.rs           WS 服务端、握手鉴权、accept 循环
```

## 插件系统

### 内置插件：`as` 状态查询

命令词独立成词，**不需要 `#` 之类的符号**（语义同 GsCore 的 `on_command`）：

| 发送内容 | 效果 |
|---------|------|
| `as` | 简要运行状态 |
| `as 详细` / `as detail` | 详细信息（事件统计、启动时间、主人配置） |
| `as 帮助` / `as help` | 命令列表 |

`asd`、`asdf 详细`、`xas` 都**不会**误触发。

实际回复示例：

```text
【Aster 运行状态】
机器人：弥灵（3853125761）
版本：v0.0.1
运行：1小时2分3秒
已处理事件：1234 条
插件：1 个
```

### 命令前缀可配置

默认不需要前缀。若想改成 `#as` 风格：

```toml
[bot]
command_prefix = "#"     # 之后命令变成 #as、#as 详细
```

### 写一个插件

```rust
use aster::plugin::{Handled, Permission, Plugin, Rule, Scope};

let plugin = Plugin::builder("hello")
    .desc("打招呼")
    .priority(100)                    // 数字越小越先执行
    .rule(
        Rule::command("hi")           // 命令词独立成词
            .name("打招呼")
            .permission(Permission::All)
            .scope(Scope::Any)        // Any / Group / Private
            .handler(|ctx| async move {
                let name = ctx.event.display_name();
                let args = ctx.args();          // 命令词之后的参数
                ctx.reply(format!("你好，{name}！参数：{args}")).await?;
                Ok(Handled::Stop)               // Stop 停止后续规则；Continue 继续
            }),
    )
    .build();

registry.register(plugin);
```

### 匹配方式

| 构造 | 语义 | 示例 |
|------|------|------|
| `Rule::command("as")` | 命令词独立成词，后接参数可选 | `as`、`as 详细` ✅；`asd` ❌ |
| `Rule::prefix("#as")` | 只要以该串开头就命中 | `#as`、`#asd` ✅ |
| `Rule::exact("状态")` | 整条消息完全相等 | `状态` ✅；`状态啊` ❌ |
| `Rule::regex(r"^echo\s+(.+)$")` | 正则匹配，捕获组作为参数 | `echo 你好` ✅ |
| `Rule::contains("状态")` | 包含子串 | `看看状态` ✅ |
| `Rule::any()` | 匹配所有消息 | 慎用 |

### 权限与范围

权限四档：`Permission::All`（所有人）、`Master`（主人）、`Admin`（群管理+群主+主人）、`Owner`（群主+主人）。
主人账号在 `config.toml` 里配置：

```toml
[bot]
masters = ["3853125761"]
```

主人**始终放行**，即使规则要求群主权限。

范围三档：`Scope::Any`（群聊+私聊）、`Group`（仅群聊）、`Private`（仅私聊）。

### 处理函数返回值

- `Ok(Handled::Stop)` —— 已处理，停止匹配后续规则（默认）
- `Ok(Handled::Continue)` —— 已处理，但允许后续规则继续（用于旁路监听）
- `Err(e)` —— 记录错误日志，继续尝试后续规则

## 消息字段规范化

### 1. 两种输入形态归一

OneBot v11 的 `message` 字段既可能是 CQ 码字符串，也可能是数组，且数组内还分
「标准写法」与「扁平写法」：

```jsonc
// CQ 码字符串
"你好[CQ:at,qq=123][CQ:image,file=a.jpg]"

// 标准数组
[{"type": "text", "data": {"text": "你好"}}, {"type": "at", "data": {"qq": "123"}}]

// 扁平写法（部分协议端）
[{"type": "at", "qq": "123"}]
```

三者都会归一为同一结果：

```rust
vec![
    Segment::Text { text: "你好".into() },
    Segment::At { qq: "123".into() },
    Segment::Image { file: "a.jpg".into(), .. },
]
```

### 2. `MessageContent` 一次给全三种形态

```rust
pub struct MessageContent {
    pub segments: Vec<Segment>,  // 结构化，业务逻辑用这个
    pub raw: String,             // OneBot 语义的 CQ 码原文
    pub text: String,            // 人类可读："你好@123[图片]"
}
```

常用辅助方法：

| 方法 | 作用 |
|------|------|
| `is_plain_text()` | 是否纯文本（决定要不要走命令匹配） |
| `trimmed_leading_text()` | 开头的纯文本，命令解析用 |
| `starts_with(prefix)` | 是否以某前缀开头 |
| `contains_at(qq)` / `contains_at_all()` | @ 检测 |
| `contains_image()` | 图片检测 |
| `reply_id()` | 引用的消息 id |
| `at_list()` | 所有 @ 目标 |
| `to_array()` / `to_cq_string()` | 反向序列化 |

### 3. ID 归一

```rust
assert_eq!(Id::parse("123"), Id::Num(123));   // 数字字符串 → 数字
assert_eq!(Id::parse("g1-c1"), Id::Str("g1-c1".into()));  // 频道 ID 原样保留
```

### 4. 事件类型对应关系

| OneBot v11 | `Event` 变体 | `event_name()` |
|------------|--------------|----------------|
| `message` / `private` / `friend` | `Event::Message` | `message.private.friend` |
| `message` / `group` / `normal` | `Event::Message` | `message.group.normal` |
| `message_sent` | `Event::MessageSent` | `message.group.normal` |
| `notice` / `group_recall` | `Event::Notice` | `notice.group_recall` |
| `notice` / `notify` / `poke` | `Event::Notice` | `notice.notify.poke` |
| `request` / `group` / `invite` | `Event::Request` | `request.group.invite` |
| `meta_event` / `lifecycle` | `Event::Meta` | `meta_event.lifecycle.connect` |

未识别的类型一律落到 `Unknown` 变体，**不静默丢弃**，原始 JSON 保存在 `Event::raw()`。

## 消费事件

```rust
use std::sync::Arc;
use aster::event::Event;
use aster::onebot11::connection::EventBus;

let (bus, mut events) = EventBus::new(1024);
tokio::spawn(async move {
    while let Some(event) = events.recv().await {
        match &*event {
            Event::Message(msg) if msg.is_at_self() => {
                println!("{} 在 {} 里 @ 了机器人", msg.display_name(), msg.session_id());
            }
            Event::Notice(notice) => println!("通知：{}", notice.notice_type()),
            _ => {}
        }
    }
});
```

## 主动调用 API

```rust
// 通过 BotRegistry 拿到账号
if let Some(bot) = bots.get(&10001.into()).await {
    // 发文本
    bot.send_group_msg("30003", serde_json::json!("你好")).await?;
    // 发结构化消息
    bot.send_content(&event, &content).await?;
    // 撤回
    bot.delete_msg("1234").await?;
    // 任意 API
    bot.api.call("get_group_list", serde_json::json!({})).await?;
}
```

## 测试

```bash
cargo test                      # Rust：128 个单元 + 9 个端到端 + 1 个文档测试
cargo test --test e2e_onebot11  # 仅端到端（真实 WebSocket 连接）
node --test test/               # Node：37 个测试（配置、进程管理、参数解析）
```

Rust 侧端到端测试覆盖：群/私聊消息规范化、通知与请求事件、API 调用与 `echo` 回执、
Token 鉴权（查询参数 + Bearer 头）、路径校验、未知事件容错、`message_sent`。

## 常见问题

**`aster start` 提示需要 cargo？**
npm 包里不含预编译二进制时会用 `cargo` 就地编译（约 1 分钟，仅首次）。
安装 Rust 即可：https://rustup.rs 。若已有编译好的二进制，
可用 `ASTER_BINARY=/path/to/aster` 指定。

**端口被占用？**
```bash
aster config set onebot11.port 5311
# 改完重启进程即可（前台运行时 Ctrl-C 后再启动）
```

**想看收发的原始报文？**
```bash
aster config set log.level debug
# 重启后日志会打印每一帧原始 JSON（base64 自动折叠）
```

**数据目录在哪？**
```bash
aster config path    # 打印配置文件路径
```

## 后续计划

- [x] 插件系统（命令匹配、优先级、权限、范围）
- [ ] 插件热重载与外部插件目录
- [ ] 命令冷却与限流
- [ ] 正向 WebSocket（框架主动连协议端）与 HTTP POST 上报
- [ ] 其他适配器（Satori / Milky / GsCore）
- [ ] 群成员与好友缓存
- [ ] 消息发送频控与重试

## License

MIT
