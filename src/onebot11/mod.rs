//! OneBot v11 适配器（反向 WebSocket 服务端）。
//!
//! 采用「反向 WebSocket」模式：EternallyBot 监听端口，协议端（Lagrange / NapCat /
//! LLOneBot 等）主动连上来并上报事件。
//!
//! ## 连接地址
//!
//! ```text
//! ws://<host>:<port>/onebot/v11/ws
//! ```
//!
//! Token 可放在三处，任选其一：
//!
//! * 请求头 `Authorization: Bearer <token>`
//! * 请求头 `Authorization: Token <token>`
//! * 查询参数 `?access_token=<token>`

pub mod action;
pub mod connection;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::handshake::server::{
    Callback, ErrorResponse, Request, Response,
};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;

use crate::config::OneBot11Config;
use connection::{BotRegistry, Connection, EventBus};

/// 从 `Authorization` 头中取出 token（支持 `Bearer` / `Token` 前缀）
fn token_from_header(value: &str) -> &str {
    let value = value.trim();
    for prefix in ["Bearer ", "bearer ", "Token ", "token "] {
        if let Some(rest) = value.strip_prefix(prefix) {
            return rest.trim();
        }
    }
    value
}

/// 从查询串中取 `access_token`
fn token_from_query(query: &str) -> Option<String> {
    for pair in query.split('&') {
        let (key, value) = match pair.split_once('=') {
            Some(kv) => kv,
            None => continue,
        };
        if key == "access_token" {
            return Some(percent_decode(value));
        }
    }
    None
}

/// 极简 percent 解码（仅用于 token 场景）
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        out.push(byte);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 握手校验回调：路径 + IP + Token
struct AuthCallback {
    config: OneBot11Config,
    remote_ip: String,
    expected_path: String,
}

impl Callback for AuthCallback {
    fn on_request(
        self,
        request: &Request,
        response: Response,
    ) -> Result<Response, ErrorResponse> {
        if request.uri().path() != self.expected_path {
            tracing::warn!(
                "拒绝连接：路径 {} 不匹配（期望 {}）",
                request.uri().path(),
                self.expected_path
            );
            return Err(unauthorized("路径不匹配"));
        }

        if !self.config.is_trusted(&self.remote_ip) {
            tracing::warn!("拒绝连接：IP {} 不在白名单内", self.remote_ip);
            return Err(unauthorized("IP 不在白名单内"));
        }

        if self.config.auth_required() {
            let from_header = request
                .headers()
                .get(AUTHORIZATION)
                .and_then(|v| v.to_str().ok())
                .map(token_from_header);
            let from_query = request.uri().query().and_then(token_from_query);

            let matched = [from_header, from_query.as_deref()]
                .into_iter()
                .flatten()
                .any(|token| constant_time_eq(token, &self.config.access_token));

            if !matched {
                tracing::warn!("拒绝连接：{} 鉴权失败", self.remote_ip);
                return Err(unauthorized("access_token 校验失败"));
            }
        }

        Ok(response)
    }
}

/// 构造 401 响应
fn unauthorized(message: &str) -> ErrorResponse {
    let mut response = ErrorResponse::new(Some(message.to_string()));
    *response.status_mut() = StatusCode::UNAUTHORIZED;
    response
}

/// 等长比较，避免因提前返回泄露 token 长度信息
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// OneBot v11 服务端
#[derive(Debug)]
pub struct OneBot11Server {
    pub config: OneBot11Config,
    pub bots: Arc<BotRegistry>,
    pub bus: EventBus,
}

impl OneBot11Server {
    pub fn new(config: OneBot11Config, bots: Arc<BotRegistry>, bus: EventBus) -> Self {
        Self { config, bots, bus }
    }

    /// 启动监听，返回实际绑定地址
    pub async fn bind(&self) -> Result<TcpListener> {
        let addr = self.config.bind_addr();
        match TcpListener::bind(&addr).await {
            Ok(listener) => Ok(listener),
            Err(err) => {
                let hint = if self.config.port < 1024 {
                    format!(
                        "\n提示：端口 {} 属于特权端口（<1024），普通用户无法绑定。\n\
                         请改用非特权端口（如 5310），或执行：\n\
                         \x20 sudo setcap 'cap_net_bind_service=+ep' $(which eternallybot)\n\
                         \x20 或使用 sudo 启动。",
                        self.config.port
                    )
                } else {
                    String::new()
                };
                Err(anyhow::anyhow!(err).context(format!("监听 {addr} 失败{hint}")))
            }
        }
    }

    /// 启动服务：接受连接直到收到关闭信号
    pub async fn serve(self: Arc<Self>, shutdown: watch::Receiver<bool>) -> Result<()> {
        let listener = self.bind().await?;
        self.serve_on(listener, shutdown).await
    }

    /// 在已绑定的监听器上提供服务
    ///
    /// 与 [`OneBot11Server::serve`] 的区别是复用外部传入的 listener，
    /// 便于测试用 `port = 0` 让系统分配端口后再读取实际地址。
    pub async fn serve_on(
        self: Arc<Self>,
        listener: TcpListener,
        mut shutdown: watch::Receiver<bool>,
    ) -> Result<()> {
        let local = listener.local_addr()?;
        let path = self.config.normalized_path();
        tracing::info!(
            "OneBot v11 适配器已监听 ws://{}{} （鉴权：{}）",
            local,
            path,
            if self.config.auth_required() {
                "已开启"
            } else {
                "关闭"
            }
        );

        let (conn_tx, mut conn_rx) = mpsc::channel::<(SocketAddr, TcpStream)>(64);

        // 接受循环单独持有一个 shutdown 订阅，主循环保留自己的那份
        let mut accept_shutdown = shutdown.clone();
        let accept_task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = accept_shutdown.changed() => {
                        if *accept_shutdown.borrow() { break; }
                    }
                    accepted = listener.accept() => {
                        match accepted {
                            Ok((stream, addr)) => {
                                if conn_tx.send((addr, stream)).await.is_err() {
                                    break;
                                }
                            }
                            Err(err) => {
                                tracing::warn!("接受连接失败：{err}");
                                tokio::time::sleep(Duration::from_millis(200)).await;
                            }
                        }
                    }
                }
            }
        });

        let mut handlers = Vec::new();
        loop {
            tokio::select! {
                biased;
                _ = shutdown.changed() => {
                    if *shutdown.borrow() { break; }
                }
                item = conn_rx.recv() => {
                    let Some((addr, stream)) = item else { break };
                    let server = self.clone();
                    let path = path.clone();
                    let shutdown = shutdown.clone();
                    handlers.push(tokio::spawn(async move {
                        if let Err(err) = server.handle_client(addr, stream, path, shutdown).await {
                            tracing::warn!("连接 {addr} 处理失败：{err}");
                        }
                    }));
                }
            }
        }

        tracing::info!("正在停止 OneBot v11 适配器...");
        accept_task.abort();
        for handler in handlers {
            handler.abort();
        }
        Ok(())
    }

    /// 处理单个客户端：握手 → 交给连接驱动
    async fn handle_client(
        self: Arc<Self>,
        addr: SocketAddr,
        stream: TcpStream,
        expected_path: String,
        shutdown: watch::Receiver<bool>,
    ) -> Result<()> {
        let remote_ip = addr.ip().to_string();
        tracing::debug!("来自 {addr} 的 WebSocket 握手请求");

        let callback = AuthCallback {
            config: self.config.clone(),
            remote_ip,
            expected_path,
        };

        let ws = tokio_tungstenite::accept_hdr_async(stream, callback)
            .await
            .context("WebSocket 握手失败")?;

        let connection = Connection::new(
            addr.to_string(),
            self.config.normalized_path(),
            self.bots.clone(),
            self.bus.clone(),
            Duration::from_secs(self.config.heartbeat_timeout),
            Duration::from_secs(self.config.request_timeout),
        );

        connection::run(connection, ws, shutdown).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_parsing_variants() {
        assert_eq!(token_from_header("Bearer abc"), "abc");
        assert_eq!(token_from_header("bearer abc"), "abc");
        assert_eq!(token_from_header("Token abc"), "abc");
        assert_eq!(token_from_header("abc"), "abc");
        assert_eq!(token_from_header("  Bearer  abc  "), "abc");
    }

    #[test]
    fn query_token_parsing() {
        assert_eq!(
            token_from_query("access_token=abc").as_deref(),
            Some("abc")
        );
        assert_eq!(
            token_from_query("foo=1&access_token=abc&bar=2").as_deref(),
            Some("abc")
        );
        assert_eq!(token_from_query("foo=1"), None);
        assert_eq!(
            token_from_query("access_token=a%20b").as_deref(),
            Some("a b")
        );
    }

    #[test]
    fn constant_time_eq_works() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
    }

    #[test]
    fn percent_decode_handles_edge_cases() {
        assert_eq!(percent_decode("a+b"), "a b");
        assert_eq!(percent_decode("%E4%BD%A0"), "你");
        assert_eq!(percent_decode("%ZZ"), "%ZZ");
    }

    #[tokio::test]
    async fn bind_reports_privileged_port_hint() {
        let mut config = OneBot11Config::default();
        config.host = "127.0.0.1".into();
        config.port = 531;
        let (bus, _rx) = EventBus::new(1);
        let server = OneBot11Server::new(config, Arc::new(BotRegistry::default()), bus);
        match server.bind().await {
            Ok(listener) => {
                // 极少见：当前用户有权限绑定特权端口
                drop(listener);
            }
            Err(err) => {
                let text = format!("{err:#}");
                assert!(text.contains("特权端口"), "错误信息应给出提权提示：{text}");
            }
        }
    }

    #[tokio::test]
    async fn bind_and_serve_accepts_and_stops() {
        let mut config = OneBot11Config::default();
        config.host = "127.0.0.1".into();
        config.port = 0; // 由系统分配，避免占用真实端口
        let (bus, _rx) = EventBus::new(8);
        let server = Arc::new(OneBot11Server::new(
            config,
            Arc::new(BotRegistry::default()),
            bus,
        ));

        let listener = server.bind().await.unwrap();
        let addr = listener.local_addr().unwrap();

        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let serve_server = server.clone();
        let task = tokio::spawn(async move { serve_server.serve_on(listener, shutdown_rx).await });

        // 等监听就绪后连接
        tokio::time::sleep(Duration::from_millis(120)).await;
        let url = format!("ws://{addr}/onebot/v11/ws");
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            tokio_tungstenite::connect_async(&url),
        )
        .await;

        let connected = matches!(result, Ok(Ok(_)));
        let _ = shutdown_tx.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(3), task).await;
        assert!(connected, "应能连上 ws://{addr}/onebot/v11/ws");
    }
}
