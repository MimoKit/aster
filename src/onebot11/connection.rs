//! 单连接管理：握手后的生命周期、事件分发、心跳与清理。
//!
//! ```text
//! accept → 握手(回调内完成 Token/IP 校验) → 读循环
//!                                        ├─ 事件  → EventBus
//!                                        ├─ 响应  → ApiCaller.resolve
//!                                        ├─ 心跳  → 刷新 last_seen
//!                                        └─ 静默  → 超时断开
//! ```
//!
//! 首次收到 `meta_event.lifecycle.connect` 时注册机器人账号（[`Bot`]），
//! 同 `self_id` 的重连复用同一账号并累加连接计数。

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::{Duration, Instant};

use anyhow::Result;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::sync::{Mutex, mpsc, watch};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

use super::action::{ApiCaller, Outgoing, parse_response};
use crate::event::{Event, EventBase, Id, MessageEvent, MessageType, Sender};
use crate::message::{MessageContent, segments_to_array};

/// 机器人账号信息
#[derive(Debug, Clone, Default)]
pub struct BotInfo {
    pub user_id: Option<Id>,
    pub nickname: Option<String>,
}

impl BotInfo {
    /// 头像地址（QQ 头像服务）
    pub fn avatar_url(&self) -> Option<String> {
        self.user_id
            .as_ref()
            .map(|id| format!("https://q.qlogo.cn/g?b=qq&s=0&nk={id}"))
    }
}

/// 一个已连接的机器人账号
#[derive(Debug)]
pub struct Bot {
    pub self_id: Id,
    pub info: Mutex<BotInfo>,
    /// 该账号当前的活动连接数
    pub connections: AtomicI64,
    pub online: AtomicBool,
    /// 机器人 API 调用入口
    pub api: Arc<ApiCaller>,
    pub connected_at: Instant,
}

impl Bot {
    pub fn new(self_id: Id, api: Arc<ApiCaller>) -> Self {
        Self {
            self_id,
            info: Mutex::new(BotInfo::default()),
            connections: AtomicI64::new(0),
            online: AtomicBool::new(true),
            api,
            connected_at: Instant::now(),
        }
    }

    /// 登录号（未取到时回退到 self_id）
    pub async fn uin(&self) -> String {
        match self.info.lock().await.user_id.as_ref() {
            Some(id) => id.to_string(),
            None => self.self_id.to_string(),
        }
    }

    /// 昵称
    pub async fn nickname(&self) -> Option<String> {
        self.info.lock().await.nickname.clone()
    }

    /// 发送群消息
    pub async fn send_group_msg(
        &self,
        group_id: impl std::fmt::Display,
        message: Value,
    ) -> Result<Value> {
        let (action, params) = super::action::api::send_group_msg(group_id, message);
        self.api.call(action, params).await
    }

    /// 发送私聊消息
    pub async fn send_private_msg(
        &self,
        user_id: impl std::fmt::Display,
        message: Value,
    ) -> Result<Value> {
        let (action, params) = super::action::api::send_private_msg(user_id, message);
        self.api.call(action, params).await
    }

    /// 回复一条消息（自动判断群聊 / 私聊）
    pub async fn reply(&self, event: &MessageEvent, message: Value) -> Result<Value> {
        match event.group_id() {
            Some(group_id) => self.send_group_msg(group_id, message).await,
            None => self.send_private_msg(&event.user_id, message).await,
        }
    }

    /// 发送纯文本
    pub async fn send_text(&self, event: &MessageEvent, text: impl Into<String>) -> Result<Value> {
        self.reply(event, Value::String(text.into())).await
    }

    /// 发送规范化消息（自动序列化为 OneBot v11 数组形态）
    pub async fn send_content(
        &self,
        event: &MessageEvent,
        content: &MessageContent,
    ) -> Result<Value> {
        self.reply(event, segments_to_array(&content.segments)).await
    }

    /// 撤回消息
    pub async fn delete_msg(&self, message_id: impl std::fmt::Display) -> Result<Value> {
        let (action, params) = super::action::api::delete_msg(message_id);
        self.api.call(action, params).await
    }
}

/// 机器人账号注册表
#[derive(Debug, Default)]
pub struct BotRegistry {
    bots: Mutex<HashMap<Id, Arc<Bot>>>,
}

impl BotRegistry {
    pub async fn get(&self, self_id: &Id) -> Option<Arc<Bot>> {
        self.bots.lock().await.get(self_id).cloned()
    }

    /// 获取已有账号，没有则创建（重连时复用），连接计数 +1
    pub async fn acquire(&self, self_id: &Id, api: Arc<ApiCaller>) -> Arc<Bot> {
        let mut bots = self.bots.lock().await;
        match bots.get(self_id) {
            Some(bot) => {
                bot.connections.fetch_add(1, Ordering::Relaxed);
                bot.online.store(true, Ordering::Relaxed);
                bot.clone()
            }
            None => {
                let bot = Arc::new(Bot::new(self_id.clone(), api));
                bot.connections.fetch_add(1, Ordering::Relaxed);
                bots.insert(self_id.clone(), bot.clone());
                bot
            }
        }
    }

    /// 连接断开时递减计数，归零则标记离线
    pub async fn release(&self, self_id: &Id) {
        let bots = self.bots.lock().await;
        if let Some(bot) = bots.get(self_id)
            && bot.connections.fetch_sub(1, Ordering::Relaxed) <= 1
        {
            bot.online.store(false, Ordering::Relaxed);
        }
    }

    pub async fn list(&self) -> Vec<Arc<Bot>> {
        self.bots.lock().await.values().cloned().collect()
    }

    pub async fn ids(&self) -> Vec<Id> {
        self.bots.lock().await.keys().cloned().collect()
    }

    pub async fn len(&self) -> usize {
        self.bots.lock().await.len()
    }

    pub async fn is_empty(&self) -> bool {
        self.bots.lock().await.is_empty()
    }
}

/// 事件总线：把规范化后的事件广播给订阅者
#[derive(Debug, Clone)]
pub struct EventBus {
    tx: mpsc::Sender<Arc<Event>>,
}

impl EventBus {
    /// 创建事件总线
    pub fn new(capacity: usize) -> (Self, mpsc::Receiver<Arc<Event>>) {
        let (tx, rx) = mpsc::channel(capacity);
        (Self { tx }, rx)
    }

    /// 发布事件（队列满时丢弃当前事件并告警，避免阻塞读循环）
    pub async fn publish(&self, event: Event) {
        let event = Arc::new(event);
        match self.tx.try_send(event.clone()) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(_)) => {
                tracing::warn!("事件队列已满，丢弃：{}", event.event_name());
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                tracing::debug!("事件总线已关闭");
            }
        }
    }
}

/// 一条连接上可复用的上下文
#[derive(Debug)]
pub struct Connection {
    /// 远端地址
    pub remote: String,
    /// 请求路径
    pub path: String,
    /// 已绑定的机器人账号（`lifecycle.connect` 后填充）
    self_id: watch::Receiver<Option<Id>>,
    self_id_tx: watch::Sender<Option<Id>>,
    /// 该连接的 API 调用器
    pub api: Arc<ApiCaller>,
    pub bots: Arc<BotRegistry>,
    pub bus: EventBus,
    last_seen: AtomicI64,
    closed: AtomicBool,
    heartbeat_timeout: Duration,
    request_timeout: Duration,
    started: Instant,
}

impl Connection {
    /// 建立连接上下文；此时尚未绑定写通道，需由 [`Connection::attach`] 补上
    pub fn new(
        remote: impl Into<String>,
        path: impl Into<String>,
        bots: Arc<BotRegistry>,
        bus: EventBus,
        heartbeat_timeout: Duration,
        request_timeout: Duration,
    ) -> Self {
        let (self_id_tx, self_id) = watch::channel(None);
        // 占位通道，attach 时替换
        let (out_tx, _) = mpsc::channel(1);
        Self {
            remote: remote.into(),
            path: path.into(),
            self_id,
            self_id_tx,
            api: Arc::new(ApiCaller::new(out_tx, request_timeout)),
            bots,
            bus,
            last_seen: AtomicI64::new(now_secs()),
            closed: AtomicBool::new(false),
            heartbeat_timeout,
            request_timeout,
            started: Instant::now(),
        }
    }

    /// 绑定真实写通道，返回可供驱动使用的连接对象
    pub fn attach(
        self,
        out_tx: mpsc::Sender<Outgoing>,
    ) -> (Self, watch::Sender<Option<Id>>) {
        let self_id_tx = self.self_id_tx.clone();
        let api = Arc::new(ApiCaller::new(out_tx, self.request_timeout));
        let connection = Self {
            remote: self.remote,
            path: self.path,
            self_id: self.self_id,
            self_id_tx: self.self_id_tx,
            api,
            bots: self.bots,
            bus: self.bus,
            last_seen: AtomicI64::new(now_secs()),
            closed: AtomicBool::new(false),
            heartbeat_timeout: self.heartbeat_timeout,
            request_timeout: self.request_timeout,
            started: self.started,
        };
        (connection, self_id_tx)
    }

    /// 当前绑定的机器人账号
    pub fn current_self_id(&self) -> Option<Id> {
        self.self_id.borrow().clone()
    }

    /// 订阅账号绑定变化
    pub fn watch_self_id(&self) -> watch::Receiver<Option<Id>> {
        self.self_id.clone()
    }

    /// 距离上次收到数据的秒数
    pub fn idle_secs(&self) -> i64 {
        now_secs() - self.last_seen.load(Ordering::Relaxed)
    }

    /// 处理一条文本帧；返回是否被正常消费
    pub async fn handle_text(&self, text: &str) -> bool {
        self.last_seen.store(now_secs(), Ordering::Relaxed);

        let value: Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(err) => {
                tracing::warn!("解析 JSON 失败（{err}）：{}", truncate(text, 256));
                return false;
            }
        };

        // 优先按 API 响应处理（带 echo）
        if let Some(response) = parse_response(&value)
            && self.api.resolve(response).await
        {
            return true;
        }

        let event = Event::from_value(value);
        match &event {
            Event::Meta(meta) if meta.is_connect() => {
                self.on_lifecycle_connect(meta.base()).await;
            }
            Event::Meta(meta) if meta.is_heartbeat() => {
                tracing::trace!(remote = %self.remote, "心跳");
            }
            Event::Unknown { post_type, .. } => {
                tracing::warn!("未知事件 post_type={post_type}");
            }
            _ => {}
        }

        self.bus.publish(event).await;
        true
    }

    /// 处理 `meta_event.lifecycle.connect`
    async fn on_lifecycle_connect(&self, base: &EventBase) {
        let self_id = base.self_id.clone();
        if self.current_self_id().as_ref() == Some(&self_id) {
            return;
        }

        let bot = self.bots.acquire(&self_id, self.api.clone()).await;
        self.self_id_tx.send_replace(Some(self_id.clone()));
        tracing::info!(
            "机器人 {} 上线（{}，握手 {:.2}s）",
            self_id,
            self.remote,
            self.started.elapsed().as_secs_f32()
        );

        // 异步拉取登录信息，失败不影响连接
        tokio::spawn(async move {
            match bot.api.call("get_login_info", serde_json::json!({})).await {
                Ok(data) => {
                    let mut info = bot.info.lock().await;
                    info.user_id = data.get("user_id").and_then(Id::from_value);
                    info.nickname = data
                        .get("nickname")
                        .and_then(|v| v.as_str())
                        .map(str::to_string);
                    tracing::info!(
                        "登录信息：{}（{}）",
                        info.nickname.as_deref().unwrap_or("未知"),
                        info.user_id
                            .as_ref()
                            .map(ToString::to_string)
                            .unwrap_or_else(|| "未知".into())
                    );
                }
                Err(err) => tracing::debug!("获取登录信息失败：{err}"),
            }
        });
    }

    /// 是否心跳超时
    pub fn is_timed_out(&self) -> bool {
        self.idle_secs() as u64 > self.heartbeat_timeout.as_secs()
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }

    /// 连接结束时清理：中断挂起请求、递减账号连接计数
    pub async fn cleanup(&self) {
        if self.closed.swap(true, Ordering::Relaxed) {
            return;
        }
        self.api.abort_all().await;
        if let Some(self_id) = self.current_self_id() {
            self.bots.release(&self_id).await;
            tracing::info!("机器人 {} 已断开（{}）", self_id, self.remote);
        }
    }
}

fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

fn truncate(input: &str, max: usize) -> String {
    if input.chars().count() <= max {
        return input.to_string();
    }
    let head: String = input.chars().take(max).collect();
    format!("{head}...")
}

/// 已握手连接的分半读写端
pub type WsSink = SplitSink<WebSocketStream<TcpStream>, Message>;
pub type WsStream = SplitStream<WebSocketStream<TcpStream>>;

/// 驱动一条连接的完整生命周期，直到断开或收到关闭信号
pub async fn run(
    connection: Connection,
    ws: WebSocketStream<TcpStream>,
    mut shutdown: watch::Receiver<bool>,
) -> Result<()> {
    let (mut sink, mut stream) = ws.split();
    let (out_tx, mut out_rx) = mpsc::channel::<Outgoing>(256);
    let (connection, _self_id_tx) = connection.attach(out_tx);
    let connection = Arc::new(connection);

    let remote = connection.remote.clone();
    let writer = tokio::spawn(async move {
        while let Some(outgoing) = out_rx.recv().await {
            let msg = match outgoing {
                Outgoing::Text(text) => Message::Text(text.into()),
                Outgoing::Pong(payload) => Message::Pong(payload.into()),
                Outgoing::Close => Message::Close(Some(CloseFrame {
                    code: CloseCode::Normal,
                    reason: "server shutdown".into(),
                })),
            };
            if let Err(err) = sink.send(msg).await {
                tracing::debug!(%remote, "写出失败：{err}");
                break;
            }
        }
        let _ = sink.close().await;
    });

    let mut heartbeat = tokio::time::interval(Duration::from_secs(10));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            biased;

            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    tracing::debug!(remote = %connection.remote, "收到关闭信号");
                    break;
                }
            }

            _ = heartbeat.tick() => {
                if connection.is_timed_out() {
                    tracing::warn!(
                        "{} 心跳超时（{} 秒未收到数据），断开连接",
                        connection.remote,
                        connection.idle_secs()
                    );
                    break;
                }
            }

            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        tracing::debug!(remote = %connection.remote, "← {}", crate::logging::sanitize(&text));
                        connection.handle_text(&text).await;
                    }
                    Some(Ok(Message::Binary(bytes))) => {
                        match std::str::from_utf8(&bytes) {
                            Ok(text) => {
                                tracing::debug!(remote = %connection.remote, "← (binary) {}", crate::logging::sanitize(text));
                                connection.handle_text(text).await;
                            }
                            Err(_) => tracing::warn!("收到非 UTF-8 二进制帧，已忽略"),
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        connection.last_seen.store(now_secs(), Ordering::Relaxed);
                        let _ = connection.api.send(Outgoing::Pong(payload.to_vec())).await;
                    }
                    Some(Ok(Message::Pong(_))) => {
                        connection.last_seen.store(now_secs(), Ordering::Relaxed);
                    }
                    Some(Ok(Message::Close(frame))) => {
                        tracing::info!(remote = %connection.remote, "对端关闭连接：{frame:?}");
                        break;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(err)) => {
                        tracing::warn!(remote = %connection.remote, "读取失败：{err}");
                        break;
                    }
                    None => break,
                }
            }
        }
    }

    connection.cleanup().await;
    let _ = connection.api.send(Outgoing::Close).await;
    drop(connection);
    let _ = tokio::time::timeout(Duration::from_secs(3), writer).await;
    Ok(())
}

/// 手工构造 `message_sent` 事件（机器人自身发出的消息）
///
/// 部分协议端不上报该事件，需要时可用它补齐。
pub fn build_message_sent(
    self_id: Id,
    message_type: MessageType,
    user_id: Id,
    group_id: Option<Id>,
    content: MessageContent,
) -> Event {
    Event::MessageSent(MessageEvent {
        base: EventBase {
            time: now_secs(),
            self_id,
            raw: Value::Null,
        },
        message_type,
        sub_type: match message_type {
            MessageType::Group => "normal".into(),
            MessageType::Private => "friend".into(),
            MessageType::Unknown => "unknown".into(),
        },
        message_id: Id::Num(0),
        user_id,
        group_id,
        raw_message: content.raw.clone(),
        message: content,
        font: None,
        sender: Sender::default(),
        anonymous: None,
        group_name: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_connection() -> Arc<Connection> {
        let (bus, _rx) = EventBus::new(16);
        Arc::new(Connection::new(
            "127.0.0.1:1",
            "/onebot/v11/ws",
            Arc::new(BotRegistry::default()),
            bus,
            Duration::from_secs(90),
            Duration::from_secs(5),
        ))
    }

    #[tokio::test]
    async fn lifecycle_connect_registers_bot() {
        let conn = test_connection();
        let text = json!({
            "time": 1, "self_id": 10001, "post_type": "meta_event",
            "meta_event_type": "lifecycle", "sub_type": "connect"
        })
        .to_string();
        assert!(conn.handle_text(&text).await);
        assert_eq!(conn.current_self_id(), Some(Id::Num(10001)));
        assert_eq!(conn.bots.len().await, 1);
    }

    #[tokio::test]
    async fn repeated_lifecycle_does_not_double_register() {
        let conn = test_connection();
        let text = json!({
            "time": 1, "self_id": 7, "post_type": "meta_event",
            "meta_event_type": "lifecycle", "sub_type": "connect"
        })
        .to_string();
        conn.handle_text(&text).await;
        conn.handle_text(&text).await;
        assert_eq!(conn.bots.len().await, 1);
        let bot = conn.bots.get(&Id::Num(7)).await.unwrap();
        assert_eq!(bot.connections.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn message_event_is_published() {
        let (bus, mut rx) = EventBus::new(16);
        let conn = Arc::new(Connection::new(
            "127.0.0.1:1",
            "/ws",
            Arc::new(BotRegistry::default()),
            bus,
            Duration::from_secs(90),
            Duration::from_secs(5),
        ));
        let text = json!({
            "time": 1, "self_id": 1, "post_type": "message",
            "message_type": "group", "sub_type": "normal",
            "message_id": 1, "user_id": 2, "group_id": 3,
            "message": "hi"
        })
        .to_string();
        conn.handle_text(&text).await;
        let event = rx.recv().await.expect("应收到事件");
        assert_eq!(event.event_name(), "message.group.normal");
    }

    #[tokio::test]
    async fn invalid_json_returns_false() {
        let conn = test_connection();
        assert!(!conn.handle_text("not json").await);
    }

    #[tokio::test]
    async fn heartbeat_publishes_meta_event() {
        let (bus, mut rx) = EventBus::new(16);
        let conn = Arc::new(Connection::new(
            "127.0.0.1:1",
            "/ws",
            Arc::new(BotRegistry::default()),
            bus,
            Duration::from_secs(90),
            Duration::from_secs(5),
        ));
        let text = json!({
            "time": 1, "self_id": 1, "post_type": "meta_event",
            "meta_event_type": "heartbeat", "interval": 5000,
            "status": {}
        })
        .to_string();
        conn.handle_text(&text).await;
        assert!(conn.current_self_id().is_none());
        let event = rx.recv().await.unwrap();
        assert!(matches!(&*event, Event::Meta(m) if m.is_heartbeat()));
    }

    #[tokio::test]
    async fn api_response_is_consumed_not_published() {
        let (bus, mut rx) = EventBus::new(16);
        let (out_tx, mut out_rx) = mpsc::channel(4);
        let conn = Arc::new(
            Connection::new(
                "127.0.0.1:1",
                "/ws",
                Arc::new(BotRegistry::default()),
                bus,
                Duration::from_secs(90),
                Duration::from_secs(2),
            )
            .attach(out_tx)
            .0,
        );

        let caller = conn.api.clone();
        let task = tokio::spawn(async move { caller.call("get_login_info", json!({})).await });
        let Some(Outgoing::Text(payload)) = out_rx.recv().await else {
            panic!("应写出请求");
        };
        let echo = serde_json::from_str::<serde_json::Value>(&payload).unwrap()["echo"]
            .as_str()
            .unwrap()
            .to_string();

        let response = json!({"status": "ok", "retcode": 0, "data": {}, "echo": echo}).to_string();
        assert!(conn.handle_text(&response).await);
        assert!(task.await.unwrap().is_ok(), "echo 响应应唤醒调用方");
        assert!(rx.try_recv().is_err(), "API 响应不应进入事件总线");
    }

    #[tokio::test]
    async fn cleanup_releases_bot() {
        let conn = test_connection();
        let text = json!({
            "time": 1, "self_id": 3, "post_type": "meta_event",
            "meta_event_type": "lifecycle", "sub_type": "connect"
        })
        .to_string();
        conn.handle_text(&text).await;
        let bot = conn.bots.get(&Id::Num(3)).await.unwrap();
        conn.cleanup().await;
        assert!(!bot.online.load(Ordering::Relaxed));
        // 幂等
        conn.cleanup().await;
    }

    #[tokio::test]
    async fn bot_registry_reuses_bot_and_counts_connections() {
        let registry = BotRegistry::default();
        let (tx, _rx) = mpsc::channel(1);
        let api = Arc::new(ApiCaller::new(tx, Duration::from_secs(1)));
        let first = registry.acquire(&Id::Num(1), api.clone()).await;
        let second = registry.acquire(&Id::Num(1), api).await;
        assert!(Arc::ptr_eq(&first, &second), "同一 self_id 应复用");
        assert_eq!(second.connections.load(Ordering::Relaxed), 2);

        registry.release(&Id::Num(1)).await;
        assert!(second.online.load(Ordering::Relaxed));
        registry.release(&Id::Num(1)).await;
        assert!(!second.online.load(Ordering::Relaxed), "连接归零应离线");
    }

    #[test]
    fn bot_info_avatar() {
        let info = BotInfo {
            user_id: Some(Id::Num(10001)),
            nickname: Some("Bot".into()),
        };
        assert_eq!(
            info.avatar_url().unwrap(),
            "https://q.qlogo.cn/g?b=qq&s=0&nk=10001"
        );
        assert!(BotInfo::default().avatar_url().is_none());
    }

    #[test]
    fn message_sent_builder() {
        let content = crate::message::normalize_message(&json!("hi"), None);
        let event = build_message_sent(
            Id::Num(1),
            MessageType::Private,
            Id::Num(2),
            None,
            content,
        );
        assert!(matches!(event, Event::MessageSent(_)));
        assert_eq!(event.event_name(), "message.private.friend");
    }

    #[test]
    fn event_bus_drops_when_full_without_blocking() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (bus, _rx) = EventBus::new(1);
            bus.publish(Event::Unknown {
                post_type: "a".into(),
                raw: Value::Null,
            })
            .await;
            // 队列已满，第二次发布不应 panic，也不应阻塞
            bus.publish(Event::Unknown {
                post_type: "b".into(),
                raw: Value::Null,
            })
            .await;
        });
    }
}
