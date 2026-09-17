//! OneBot v11 API 调用（`action` / `echo` 请求-响应）。
//!
//! 请求形态：
//!
//! ```json
//! {"action": "send_group_msg", "params": {...}, "echo": "唯一标识"}
//! ```
//!
//! 响应形态：
//!
//! ```json
//! {"status": "ok", "retcode": 0, "data": {...}, "echo": "唯一标识"}
//! ```
//!
//! 这里用 `echo` 关联请求与响应：调用方拿到一个 `oneshot` 通道，
//! 读循环收到带 `echo` 的响应后唤醒对应调用方，超时则报错并清理。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(test)]
use serde_json::json;
use tokio::sync::{Mutex, mpsc, oneshot};

/// 发往协议端的数据
#[derive(Debug, Clone)]
pub enum Outgoing {
    /// 文本帧（OneBot v11 使用 JSON 文本帧）
    Text(String),
    /// 对客户端 Ping 的回应
    Pong(Vec<u8>),
    /// 主动关闭
    Close,
}

/// OneBot v11 请求体
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiRequest {
    pub action: String,
    #[serde(default)]
    pub params: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub echo: Option<String>,
}

impl ApiRequest {
    pub fn new(action: impl Into<String>, params: Value) -> Self {
        Self {
            action: action.into(),
            params,
            echo: None,
        }
    }

    pub fn with_echo(mut self, echo: impl Into<String>) -> Self {
        self.echo = Some(echo.into());
        self
    }
}

/// OneBot v11 响应体
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiResponse {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub retcode: i64,
    #[serde(default)]
    pub data: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub echo: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub msg: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wording: Option<String>,
}

impl ApiResponse {
    /// 是否调用成功
    ///
    /// 兼容三类实现：`status == "ok"`、`retcode == 0`、`retcode == 1`（部分实现用 1 表示成功）。
    pub fn is_ok(&self) -> bool {
        self.status.eq_ignore_ascii_case("ok") || self.retcode == 0 || self.retcode == 1
    }

    /// 错误描述
    pub fn error_message(&self) -> String {
        self.msg
            .clone()
            .or_else(|| self.wording.clone())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("retcode={} status={}", self.retcode, self.status))
    }

    /// echo 的字符串形态
    pub fn echo_key(&self) -> Option<String> {
        match self.echo.as_ref()? {
            Value::String(s) => Some(s.clone()),
            Value::Number(n) => Some(n.to_string()),
            other => Some(other.to_string()),
        }
    }
}

/// 从原始 JSON 判断是否为 API 响应（带 `echo`）
pub fn parse_response(value: &Value) -> Option<ApiResponse> {
    value.get("echo")?;
    serde_json::from_value(value.clone()).ok()
}

/// API 调用器：持有写通道与待响应表
#[derive(Debug)]
pub struct ApiCaller {
    tx: mpsc::Sender<Outgoing>,
    pending: Mutex<HashMap<String, oneshot::Sender<ApiResponse>>>,
    timeout: Duration,
}

impl ApiCaller {
    pub fn new(tx: mpsc::Sender<Outgoing>, timeout: Duration) -> Self {
        Self {
            tx,
            pending: Mutex::new(HashMap::new()),
            timeout,
        }
    }

    /// 直接投递一条出站数据（心跳回应等）
    pub async fn send(&self, outgoing: Outgoing) -> bool {
        self.tx.send(outgoing).await.is_ok()
    }

    /// 调用一个 API，成功时返回 `data` 字段
    pub async fn call(&self, action: impl Into<String>, params: Value) -> Result<Value> {
        let response = self.call_raw(action, params).await?;
        Ok(response.data)
    }

    /// 调用一个 API，返回完整响应
    pub async fn call_raw(&self, action: impl Into<String>, params: Value) -> Result<ApiResponse> {
        let action = action.into();
        let echo = next_echo();
        let request = ApiRequest::new(action.clone(), params).with_echo(echo.clone());

        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(echo.clone(), tx);

        let payload = serde_json::to_string(&request)?;
        tracing::debug!(action = %action, "→ {payload}");
        if self.tx.send(Outgoing::Text(payload)).await.is_err() {
            self.pending.lock().await.remove(&echo);
            bail!("连接已关闭，无法调用 {action}");
        }

        match tokio::time::timeout(self.timeout, rx).await {
            Ok(Ok(response)) => {
                if response.is_ok() {
                    Ok(response)
                } else {
                    Err(anyhow!("{action} 调用失败：{}", response.error_message()))
                }
            }
            Ok(Err(_)) => {
                self.pending.lock().await.remove(&echo);
                bail!("{action} 调用被中断（连接关闭）")
            }
            Err(_) => {
                self.pending.lock().await.remove(&echo);
                bail!("{action} 调用超时（{:?}）", self.timeout)
            }
        }
    }

    /// 读循环收到响应后回填；返回是否存在对应的等待者
    pub async fn resolve(&self, response: ApiResponse) -> bool {
        let Some(key) = response.echo_key() else {
            return false;
        };
        let sender = self.pending.lock().await.remove(&key);
        match sender {
            Some(tx) => {
                let _ = tx.send(response);
                true
            }
            None => false,
        }
    }

    /// 当前等待中的请求数
    pub async fn pending_count(&self) -> usize {
        self.pending.lock().await.len()
    }

    /// 连接关闭时清空等待队列，让调用方立刻失败而不是等超时
    pub async fn abort_all(&self) {
        self.pending.lock().await.clear();
    }
}

/// 生成「纳秒时间戳 + 自增序号」的 echo，保证进程内唯一
fn next_echo() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}-{seq:x}")
}

/// 常用 API 的便捷封装
pub mod api {
    use serde_json::{Value, json};

    /// 发送私聊消息
    pub fn send_private_msg(
        user_id: impl std::fmt::Display,
        message: Value,
    ) -> (&'static str, Value) {
        (
            "send_private_msg",
            json!({"user_id": user_id.to_string(), "message": message}),
        )
    }

    /// 发送群消息
    pub fn send_group_msg(group_id: impl std::fmt::Display, message: Value) -> (&'static str, Value) {
        (
            "send_group_msg",
            json!({"group_id": group_id.to_string(), "message": message}),
        )
    }

    /// 撤回消息
    pub fn delete_msg(message_id: impl std::fmt::Display) -> (&'static str, Value) {
        ("delete_msg", json!({"message_id": message_id.to_string()}))
    }

    /// 获取登录号信息
    pub fn get_login_info() -> (&'static str, Value) {
        ("get_login_info", json!({}))
    }

    /// 获取群列表
    pub fn get_group_list() -> (&'static str, Value) {
        ("get_group_list", json!({}))
    }

    /// 获取群成员列表
    pub fn get_group_member_list(group_id: impl std::fmt::Display) -> (&'static str, Value) {
        (
            "get_group_member_list",
            json!({"group_id": group_id.to_string()}),
        )
    }

    /// 获取好友列表
    pub fn get_friend_list() -> (&'static str, Value) {
        ("get_friend_list", json!({}))
    }

    /// 群禁言
    pub fn set_group_ban(
        group_id: impl std::fmt::Display,
        user_id: impl std::fmt::Display,
        duration: u32,
    ) -> (&'static str, Value) {
        (
            "set_group_ban",
            json!({
                "group_id": group_id.to_string(),
                "user_id": user_id.to_string(),
                "duration": duration
            }),
        )
    }

    /// 处理加好友请求
    pub fn set_friend_add_request(flag: &str, approve: bool, remark: &str) -> (&'static str, Value) {
        (
            "set_friend_add_request",
            json!({"flag": flag, "approve": approve, "remark": remark}),
        )
    }

    /// 处理加群请求
    pub fn set_group_add_request(
        flag: &str,
        sub_type: &str,
        approve: bool,
        reason: &str,
    ) -> (&'static str, Value) {
        (
            "set_group_add_request",
            json!({
                "flag": flag,
                "sub_type": sub_type,
                "approve": approve,
                "reason": reason
            }),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_success_variants() {
        let ok = ApiResponse {
            status: "ok".into(),
            retcode: 0,
            data: json!({"message_id": 1}),
            echo: Some(json!("e1")),
            msg: None,
            wording: None,
        };
        assert!(ok.is_ok());
        assert_eq!(ok.echo_key().as_deref(), Some("e1"));

        let ok_retcode_one = ApiResponse {
            retcode: 1,
            ..ok.clone()
        };
        assert!(ok_retcode_one.is_ok());
    }

    #[test]
    fn response_failure_variants() {
        let bad = ApiResponse {
            status: "failed".into(),
            retcode: 100,
            data: Value::Null,
            echo: Some(json!("e2")),
            msg: Some("参数错误".into()),
            wording: Some("bad param".into()),
        };
        assert!(!bad.is_ok());
        assert_eq!(bad.error_message(), "参数错误");

        let bad_no_msg = ApiResponse {
            msg: None,
            wording: None,
            ..bad
        };
        assert_eq!(bad_no_msg.error_message(), "retcode=100 status=failed");
    }

    #[test]
    fn parse_response_requires_echo() {
        assert!(parse_response(&json!({"status": "ok", "retcode": 0})).is_none());
        assert!(parse_response(&json!({"status": "ok", "retcode": 0, "echo": "1"})).is_some());
    }

    #[test]
    fn echo_values_are_unique() {
        assert_ne!(next_echo(), next_echo());
    }

    #[tokio::test]
    async fn call_times_out_and_cleans_up() {
        let (tx, mut rx) = mpsc::channel(4);
        let caller = ApiCaller::new(tx, Duration::from_millis(30));
        let err = caller.call("get_login_info", json!({})).await.unwrap_err();
        assert!(err.to_string().contains("超时"));
        assert!(matches!(rx.recv().await, Some(Outgoing::Text(_))));
        assert_eq!(caller.pending_count().await, 0, "超时后应清理待响应表");
    }

    #[tokio::test]
    async fn call_resolves_via_echo() {
        let (tx, mut rx) = mpsc::channel(4);
        let caller = std::sync::Arc::new(ApiCaller::new(tx, Duration::from_secs(5)));

        let caller_for_task = caller.clone();
        let task =
            tokio::spawn(async move { caller_for_task.call("get_login_info", json!({})).await });

        let Some(Outgoing::Text(payload)) = rx.recv().await else {
            panic!("应写出请求");
        };
        let request: ApiRequest = serde_json::from_str(&payload).unwrap();
        assert_eq!(request.action, "get_login_info");
        let echo = request.echo.clone().unwrap();

        let response = ApiResponse {
            status: "ok".into(),
            retcode: 0,
            data: json!({"user_id": 10001, "nickname": "Bot"}),
            echo: Some(json!(echo)),
            msg: None,
            wording: None,
        };
        assert!(caller.resolve(response).await);

        let data = task.await.unwrap().unwrap();
        assert_eq!(data["nickname"], "Bot");
    }

    #[tokio::test]
    async fn abort_all_fails_pending_calls() {
        let (tx, _rx) = mpsc::channel(4);
        let caller = std::sync::Arc::new(ApiCaller::new(tx, Duration::from_secs(30)));
        let caller_for_task = caller.clone();
        let task =
            tokio::spawn(async move { caller_for_task.call("get_group_list", json!({})).await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        caller.abort_all().await;
        assert!(task.await.unwrap().is_err());
    }

    #[test]
    fn api_helpers_shape() {
        let (action, params) = api::send_group_msg(123, json!("hi"));
        assert_eq!(action, "send_group_msg");
        assert_eq!(params["group_id"], "123");
        assert_eq!(params["message"], "hi");
    }
}
