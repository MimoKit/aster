//! 端到端测试：用真实的 WebSocket 客户端模拟 OneBot v11 协议端，
//! 连上 Aster 的端口，验证「握手 → 事件规范化 → API 回调」全链路。

use std::sync::Arc;
use std::time::Duration;

use aster::config::OneBot11Config;
use aster::event::{Event, Id, MessageType};
use aster::onebot11::OneBot11Server;
use aster::onebot11::connection::{BotRegistry, EventBus};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::MaybeTlsStream;
use tokio_tungstenite::tungstenite::Message;

type Client = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

/// 启动一个测试用服务器，返回 (地址, 事件接收端, bot 注册表, 关闭开关)
async fn start_server(
    token: &str,
) -> (
    String,
    mpsc::Receiver<Arc<Event>>,
    Arc<BotRegistry>,
    watch::Sender<bool>,
) {
    let mut config = OneBot11Config::default();
    config.host = "127.0.0.1".into();
    config.port = 0; // 系统分配
    config.access_token = token.to_string();
    config.heartbeat_timeout = 30;
    config.request_timeout = 5;

    let (bus, events) = EventBus::new(64);
    let bots = Arc::new(BotRegistry::default());
    let server = Arc::new(OneBot11Server::new(config, bots.clone(), bus));

    let listener = server.bind().await.expect("绑定端口失败");
    let addr = listener.local_addr().unwrap().to_string();

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    tokio::spawn(async move {
        let _ = server.serve_on(listener, shutdown_rx).await;
    });
    tokio::time::sleep(Duration::from_millis(100)).await;

    (addr, events, bots, shutdown_tx)
}

/// 连接协议端，完成握手
async fn connect(addr: &str, token: &str) -> Client {
    let url = if token.is_empty() {
        format!("ws://{addr}/onebot/v11/ws")
    } else {
        format!("ws://{addr}/onebot/v11/ws?access_token={token}")
    };
    let (ws, _response) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("握手失败");
    ws
}

async fn send_json(ws: &mut Client, value: Value) {
    ws.send(Message::Text(value.to_string().into()))
        .await
        .expect("发送失败");
}

/// 收下一条文本帧
async fn recv_json(ws: &mut Client) -> Value {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(3), ws.next())
            .await
            .expect("等待消息超时")
            .expect("连接已关闭")
            .expect("读取失败");
        match msg {
            Message::Text(text) => return serde_json::from_str(&text).expect("JSON 解析失败"),
            Message::Ping(_) | Message::Pong(_) => continue,
            other => panic!("期望文本帧，实际 {other:?}"),
        }
    }
}

async fn recv_event(events: &mut mpsc::Receiver<Arc<Event>>) -> Arc<Event> {
    tokio::time::timeout(Duration::from_secs(3), events.recv())
        .await
        .expect("等待事件超时")
        .expect("事件通道关闭")
}

/// 群消息：字符串（CQ 码）形态
#[tokio::test]
async fn e2e_group_message_cq_string() {
    let (addr, mut events, _bots, shutdown) = start_server("").await;
    let mut ws = connect(&addr, "").await;

    send_json(
        &mut ws,
        json!({
            "time": 1700000000, "self_id": 10001, "post_type": "meta_event",
            "meta_event_type": "lifecycle", "sub_type": "connect"
        }),
    )
    .await;

    send_json(
        &mut ws,
        json!({
            "time": 1700000001, "self_id": 10001, "post_type": "message",
            "message_type": "group", "sub_type": "normal",
            "message_id": 1234, "user_id": 20002, "group_id": 30003,
            "raw_message": "你好[CQ:at,qq=10001][CQ:image,file=a.jpg]",
            "message": "你好[CQ:at,qq=10001][CQ:image,file=a.jpg]",
            "sender": {"user_id": 20002, "nickname": "小明", "card": "群名片", "role": "member"}
        }),
    )
    .await;

    // 第一条可能是 lifecycle，过滤出消息事件
    let event = loop {
        let event = recv_event(&mut events).await;
        if matches!(&*event, Event::Message(_)) {
            break event;
        }
    };

    let msg = event.as_message().expect("应为消息事件");
    assert_eq!(event.event_name(), "message.group.normal");
    assert!(msg.is_group());
    assert_eq!(msg.group_id().unwrap().as_i64(), Some(30003));
    assert_eq!(msg.user_id().as_i64(), Some(20002));
    assert_eq!(msg.self_id().as_i64(), Some(10001));
    assert!(msg.is_at_self(), "应识别出 @ 机器人自己");
    assert!(msg.has_image(), "应识别出图片段");
    assert_eq!(msg.message.raw, "你好[CQ:at,qq=10001][CQ:image,file=a.jpg]");
    assert_eq!(msg.message.text, "你好@10001[图片]");
    assert_eq!(msg.display_name(), "群名片");
    assert_eq!(msg.session_id(), "30003");

    let _ = shutdown.send(true);
}

/// 私聊消息：数组形态 + 数字型 ID（部分协议端的写法）
#[tokio::test]
async fn e2e_private_message_array_form() {
    let (addr, mut events, _bots, shutdown) = start_server("").await;
    let mut ws = connect(&addr, "").await;

    send_json(
        &mut ws,
        json!({
            "time": 1, "self_id": "10001", "post_type": "message",
            "message_type": "private", "sub_type": "friend",
            "message_id": "555", "user_id": 20002,
            "message": [
                {"type": "text", "data": {"text": "在吗"}},
                {"type": "face", "data": {"id": 1}}
            ],
            "sender": {"user_id": 20002, "nickname": "小明"}
        }),
    )
    .await;

    let event = recv_event(&mut events).await;
    let msg = event.as_message().expect("应为消息事件");
    assert!(msg.is_private());
    assert!(msg.group_id().is_none());
    assert_eq!(event.event_name(), "message.private.friend");
    // 字符串 ID 被归一为数字
    assert_eq!(msg.self_id(), &Id::Num(10001));
    assert_eq!(msg.message_id, Id::Num(555));
    assert_eq!(msg.message.text, "在吗[表情:1]");
    // 缺失 raw_message 时自动推导 CQ 码
    assert_eq!(msg.raw_message, "在吗[CQ:face,id=1]");
    assert_eq!(msg.display_name(), "小明");

    let _ = shutdown.send(true);
}

/// 通知与请求事件
#[tokio::test]
async fn e2e_notice_and_request() {
    let (addr, mut events, _bots, shutdown) = start_server("").await;
    let mut ws = connect(&addr, "").await;

    send_json(
        &mut ws,
        json!({
            "time": 2, "self_id": 1, "post_type": "notice",
            "notice_type": "group_recall", "group_id": 30003,
            "user_id": 20002, "operator_id": 20002, "message_id": 99
        }),
    )
    .await;

    let event = recv_event(&mut events).await;
    assert_eq!(event.event_name(), "notice.group_recall");

    send_json(
        &mut ws,
        json!({
            "time": 3, "self_id": 1, "post_type": "notice",
            "notice_type": "notify", "sub_type": "poke",
            "group_id": 30003, "user_id": 20002, "target_id": 10001
        }),
    )
    .await;

    let event = recv_event(&mut events).await;
    assert_eq!(event.event_name(), "notice.notify.poke");

    send_json(
        &mut ws,
        json!({
            "time": 4, "self_id": 1, "post_type": "request",
            "request_type": "group", "sub_type": "invite",
            "group_id": 30003, "user_id": 20002, "comment": "来玩", "flag": "flag-1"
        }),
    )
    .await;

    let event = recv_event(&mut events).await;
    assert_eq!(event.event_name(), "request.group.invite");

    let _ = shutdown.send(true);
}

/// 双向：框架主动调用 API，协议端回 echo，调用方拿到 data
#[tokio::test]
async fn e2e_api_call_and_echo_response() {
    let (addr, mut events, bots, shutdown) = start_server("").await;
    let mut ws = connect(&addr, "").await;

    send_json(
        &mut ws,
        json!({
            "time": 1, "self_id": 10001, "post_type": "meta_event",
            "meta_event_type": "lifecycle", "sub_type": "connect"
        }),
    )
    .await;
    let _ = recv_event(&mut events).await; // lifecycle 事件

    // 等账号注册完成
    let bot = loop {
        if let Some(bot) = bots.get(&Id::Num(10001)).await {
            break bot;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };

    // 框架侧发起调用
    let caller = tokio::spawn(async move {
        bot.send_group_msg(
            "30003",
            json!([{"type": "text", "data": {"text": "pong"}}]),
        )
        .await
    });

    // 协议端侧可能先收到框架自动发起的 get_login_info（连接初始化），
    // 这里像真实协议端一样逐个响应，直到拿到我们要的 send_group_msg
    let request = loop {
        let request = recv_json(&mut ws).await;
        let action = request["action"].as_str().unwrap_or_default().to_string();
        if action == "send_group_msg" {
            break request;
        }
        // 其它请求（如 get_login_info）回复一个成功响应
        send_json(
            &mut ws,
            json!({
                "status": "ok",
                "retcode": 0,
                "data": {"user_id": 10001, "nickname": "测试Bot"},
                "echo": request["echo"].clone()
            }),
        )
        .await;
    };
    assert_eq!(request["action"], "send_group_msg");
    assert_eq!(request["params"]["group_id"], "30003");
    let echo = request["echo"].clone();

    // 回一个成功响应
    send_json(
        &mut ws,
        json!({"status": "ok", "retcode": 0, "data": {"message_id": 777}, "echo": echo}),
    )
    .await;

    let data = caller.await.unwrap().expect("API 调用应成功");
    assert_eq!(data["message_id"], 777);

    let _ = shutdown.send(true);
}

/// 错误 Token 必须被拒绝
#[tokio::test]
async fn e2e_rejects_bad_token() {
    let (addr, _events, _bots, shutdown) = start_server("secret").await;

    let url = format!("ws://{addr}/onebot/v11/ws?access_token=wrong");
    let result = tokio_tungstenite::connect_async(&url).await;
    assert!(result.is_err(), "错误 Token 不应握手成功");

    // 正确 Token 可以连上
    let url = format!("ws://{addr}/onebot/v11/ws?access_token=secret");
    let ok = tokio_tungstenite::connect_async(&url).await;
    assert!(ok.is_ok(), "正确 Token 应握手成功");

    let _ = shutdown.send(true);
}

/// 错误路径必须被拒绝
#[tokio::test]
async fn e2e_rejects_wrong_path() {
    let (addr, _events, _bots, shutdown) = start_server("").await;
    let url = format!("ws://{addr}/wrong/path");
    let result = tokio_tungstenite::connect_async(&url).await;
    assert!(result.is_err(), "错误路径不应握手成功");
    let _ = shutdown.send(true);
}

/// Bearer 头鉴权
#[tokio::test]
async fn e2e_accepts_authorization_header() {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    let (addr, _events, _bots, shutdown) = start_server("secret").await;
    let url = format!("ws://{addr}/onebot/v11/ws");
    let mut request = url.into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Authorization", "Bearer secret".parse().unwrap());

    let result = tokio_tungstenite::connect_async(request).await;
    assert!(result.is_ok(), "Bearer 头应通过鉴权");
    let _ = shutdown.send(true);
}

/// 未知事件类型不应导致连接断开
#[tokio::test]
async fn e2e_unknown_event_is_tolerated() {
    let (addr, mut events, _bots, shutdown) = start_server("").await;
    let mut ws = connect(&addr, "").await;

    send_json(&mut ws, json!({"post_type": "future_thing", "x": 1})).await;
    send_json(
        &mut ws,
        json!({
            "time": 1, "self_id": 1, "post_type": "message",
            "message_type": "group", "sub_type": "normal",
            "message_id": 1, "user_id": 2, "group_id": 3, "message": "still alive"
        }),
    )
    .await;

    let mut saw_unknown = false;
    let event = loop {
        let event = recv_event(&mut events).await;
        match &*event {
            Event::Unknown { .. } => saw_unknown = true,
            Event::Message(_) => break event,
            _ => {}
        }
    };
    assert!(saw_unknown, "未知事件应被规范化为 Event::Unknown");
    assert_eq!(event.as_message().unwrap().message.text, "still alive");

    let _ = shutdown.send(true);
}

/// 机器人自己发出的消息（message_sent）
#[tokio::test]
async fn e2e_message_sent() {
    let (addr, mut events, _bots, shutdown) = start_server("").await;
    let mut ws = connect(&addr, "").await;

    send_json(
        &mut ws,
        json!({
            "time": 1, "self_id": 10001, "post_type": "message_sent",
            "message_type": "group", "sub_type": "normal",
            "message_id": 1, "user_id": 10001, "target_id": 30003,
            "message": "我发出的", "sender": {"user_id": 10001}
        }),
    )
    .await;

    let event = recv_event(&mut events).await;
    assert!(matches!(&*event, Event::MessageSent(_)));
    assert_eq!(event.event_name(), "message.group.normal");
    let msg = event.as_message().unwrap();
    assert_eq!(msg.message_type, MessageType::Group);

    let _ = shutdown.send(true);
}
