//! 模拟 OneBot v11 协议端：连上 Aster，上报一批事件并响应 API 调用。
//!
//! 用途：没有真实的协议端（Lagrange / NapCat / LLOneBot）时自测框架。
//!
//! ```bash
//! # 终端 1：启动框架
//! cargo run --release
//!
//! # 终端 2：模拟协议端连上来
//! cargo run --release --example mock_adapter
//!
//! # 自定义地址 / Token
//! cargo run --release --example mock_adapter -- ws://127.0.0.1:5310/onebot/v11/ws secret
//! ```

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let url = args
        .next()
        .unwrap_or_else(|| "ws://127.0.0.1:5310/onebot/v11/ws".to_string());
    let token = args.next().unwrap_or_default();

    let connect_url = if token.is_empty() {
        url.clone()
    } else {
        format!("{url}?access_token={token}")
    };

    println!("[mock] 正在连接 {url}");
    let (ws, _resp) = tokio_tungstenite::connect_async(&connect_url).await?;
    println!("[mock] 已连接");

    let (mut sink, mut stream) = ws.split();

    // 写端交给一个独立任务，避免被读循环借用；所有发送都走这个通道
    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<Value>(64);
    let writer = tokio::spawn(async move {
        while let Some(value) = out_rx.recv().await {
            if sink
                .send(Message::Text(value.to_string().into()))
                .await
                .is_err()
            {
                break;
            }
            let _ = sink.flush().await;
        }
        let _ = sink.close().await;
    });

    // 便捷发送
    macro_rules! send {
        ($value:expr) => {
            out_tx.send($value).await.map_err(|_| anyhow::anyhow!("连接已关闭"))?
        };
    }

    // 1. 上报生命周期：协议端连上后必须发这个，框架据此注册账号
    send!(json!({
        "time": now(),
        "self_id": 10001,
        "post_type": "meta_event",
        "meta_event_type": "lifecycle",
        "sub_type": "connect"
    }));

    // 2. 处理框架发来的 API 请求（如 get_login_info）
    let reply_tx = out_tx.clone();
    let responder = tokio::spawn(async move {
        while let Some(msg) = stream.next().await {
            let text = match msg {
                Ok(Message::Text(text)) => text.to_string(),
                Ok(Message::Close(_)) | Err(_) => break,
                Ok(_) => continue,
            };
            let request: Value = match serde_json::from_str(&text) {
                Ok(v) => v,
                Err(err) => {
                    eprintln!("[mock] 收到非法 JSON：{err}");
                    continue;
                }
            };
            let action = request["action"].as_str().unwrap_or_default();
            println!("[mock] ← action={action} params={}", request["params"]);

            let data = match action {
                "get_login_info" => json!({"user_id": 10001, "nickname": "模拟Bot"}),
                "send_group_msg" | "send_private_msg" => json!({"message_id": 424242}),
                _ => json!({}),
            };
            let response = json!({
                "status": "ok",
                "retcode": 0,
                "data": data,
                "echo": request["echo"].clone()
            });
            if reply_tx.send(response).await.is_err() {
                break;
            }
        }
        println!("[mock] 连接已关闭");
    });

    // 3. 依次上报各类事件
    tokio::time::sleep(Duration::from_millis(300)).await;

    // 3.1 群消息（CQ 码形态）
    send!(json!({
        "time": now(), "self_id": 10001, "post_type": "message",
        "message_type": "group", "sub_type": "normal",
        "message_id": 1001, "user_id": 20002, "group_id": 30003,
        "raw_message": "你好[CQ:at,qq=10001] 看看这个[CQ:image,file=cat.jpg]",
        "message": "你好[CQ:at,qq=10001] 看看这个[CQ:image,file=cat.jpg]",
        "font": 0,
        "sender": {"user_id": 20002, "nickname": "小明", "card": "群名片", "role": "member"}
    }));

    // 3.2 私聊消息（数组形态 + 字符串 ID）
    send!(json!({
        "time": now(), "self_id": "10001", "post_type": "message",
        "message_type": "private", "sub_type": "friend",
        "message_id": "1002", "user_id": "20002",
        "message": [
            {"type": "text", "data": {"text": "在吗"}},
            {"type": "face", "data": {"id": 1}},
            {"type": "reply", "data": {"id": "999"}}
        ],
        "sender": {"user_id": 20002, "nickname": "小明"}
    }));

    // 3.3 群成员增加
    send!(json!({
        "time": now(), "self_id": 10001, "post_type": "notice",
        "notice_type": "group_increase", "sub_type": "approve",
        "group_id": 30003, "user_id": 20003, "operator_id": 10001
    }));

    // 3.4 戳一戳
    send!(json!({
        "time": now(), "self_id": 10001, "post_type": "notice",
        "notice_type": "notify", "sub_type": "poke",
        "group_id": 30003, "user_id": 20002, "target_id": 10001
    }));

    // 3.5 加群请求
    send!(json!({
        "time": now(), "self_id": 10001, "post_type": "request",
        "request_type": "group", "sub_type": "invite",
        "group_id": 30003, "user_id": 20004, "comment": "拉你进群", "flag": "mock-flag-1"
    }));

    // 3.6 机器人自己发的消息
    send!(json!({
        "time": now(), "self_id": 10001, "post_type": "message_sent",
        "message_type": "group", "sub_type": "normal",
        "message_id": 1003, "user_id": 10001, "target_id": 30003,
        "message": "我是机器人", "sender": {"user_id": 10001, "nickname": "模拟Bot"}
    }));

    // 3.7 触发内置状态插件（命令词独立成词，不需要 # 前缀）
    send!(json!({
        "time": now(), "self_id": 10001, "post_type": "message",
        "message_type": "group", "sub_type": "normal",
        "message_id": 1004, "user_id": 20002, "group_id": 30003,
        "raw_message": "as 详细", "message": "as 详细",
        "sender": {"user_id": 20002, "nickname": "小明", "role": "member"}
    }));

    println!("[mock] 已上报 7 条事件，保持连接 10 秒以便观察框架日志...");
    println!("[mock] 其中 `as 详细` 会触发内置状态插件，框架应回一条状态消息");
    tokio::time::sleep(Duration::from_secs(10)).await;

    responder.abort();
    drop(out_tx);
    let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
    println!("[mock] 退出");
    Ok(())
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}
