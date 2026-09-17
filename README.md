# EternallyBot

用 Rust 编写的 Bot 框架。当前阶段聚焦 **OneBot v11 适配器**与**消息字段规范化**，

## 特性

- **反向 WebSocket 服务端**：框架监听端口，协议端（Lagrange / NapCat / LLOneBot / go-cqhttp 等）主动连上来
- **消息字段规范化**：CQ 码字符串与数组形态统一收敛为强类型 `Segment`
- **事件规范化**：`message` / `notice` / `request` / `meta_event` 全部建模为强类型枚举
- **ID 类型归一**：`123` 与 `"123"` 视为同一个 ID，字符串 ID（如频道 `g1-c1`）原样保留
- **API 调用**：基于 `echo` 的请求-响应关联，带超时与连接断开清理
- **鉴权**：支持 `Authorization: Bearer`、`?access_token=` 查询参数、IP 白名单
- **日志脱敏**：`base64://` 内容自动折叠，避免刷屏

## 快速开始

```bash
# 构建
cargo build --release

# 运行（首次会自动生成 config.toml）
./target/release/eternallybot
```

启动后监听：

```text
ws://0.0.0.0:5310/onebot/v11/ws
```

把协议端的「反向 WebSocket」地址填成上面这个即可。

> **关于端口**：`0531` / `531` 属于特权端口（< 1024），普通用户无法绑定。
> 默认使用 **5310**；若确实需要 531，请执行
> `sudo setcap 'cap_net_bind_service=+ep' target/release/eternallybot` 或用 sudo 启动，
> 并把 `config.toml` 里的 `port` 改成 531。

## 没有协议端时如何自测

内置了一个模拟协议端：

```bash
# 终端 1
cargo run --release

# 终端 2：连接并上报一批样例事件
cargo run --release --example mock_adapter
```

## 配置

`config.toml`（首次运行从 `config/default.toml` 复制）：

```toml
[bot]
name = "EternallyBot"

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

环境变量可覆盖：`ETERNALLY_HOST`、`ETERNALLY_PORT`、`ETERNALLY_TOKEN`、`ETERNALLY_LOG`。

## 代码结构

```text
src/
├── main.rs              程序入口：配置 → 日志 → 启动适配器 → 消费事件
├── lib.rs               库入口与文档
├── config.rs            配置加载与校验
├── logging.rs           日志初始化与 base64 脱敏
├── message/             ★ 消息字段规范化
│   ├── segment.rs       消息段枚举（Segment）+ CQ 转义
│   ├── cq.rs            CQ 码字符串 → 消息段
│   ├── parser.rs        message 字段（字符串/数组）→ 消息段
│   ├── text.rs          消息段 → raw_message / 可读文本
│   └── mod.rs           MessageContent：上层统一入口
├── event/               ★ 事件规范化
│   ├── common.rs        Id / Sender / Anonymous / FileInfo / 取值辅助
│   └── mod.rs           Event / MessageEvent / NoticeEvent / RequestEvent / MetaEvent
└── onebot11/            OneBot v11 适配器
    ├── action.rs        action-echo 调用（ApiCaller）+ 常用 API 封装
    ├── connection.rs    连接生命周期、Bot 注册表、EventBus
    └── mod.rs           WS 服务端、握手鉴权、accept 循环
```

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
use eternallybot::event::Event;
use eternallybot::onebot11::connection::EventBus;

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
cargo test                    # 74 个单元测试 + 9 个端到端测试
cargo test --test e2e_onebot11  # 仅端到端（真实 WebSocket 连接）
```

端到端测试覆盖：群/私聊消息规范化、通知与请求事件、API 调用与 `echo` 回执、
Token 鉴权（查询参数 + Bearer 头）、路径校验、未知事件容错、`message_sent`。

## 后续计划

- [ ] 插件系统（命令注册、权限、冷却）
- [ ] 正向 WebSocket（框架主动连协议端）与 HTTP POST 上报
- [ ] 其他适配器（Satori / Milky / GsCore）
- [ ] 群成员与好友缓存
- [ ] 消息发送频控与重试

## License

MIT
