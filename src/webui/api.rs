//! WebUI 的 HTTP API 服务。
//!
//! 为 TypeScript 前端提供数据与操作接口，同时托管前端构建产物。
//!
//! | 方法 | 路径 | 说明 |
//! |------|------|------|
//! | GET | `/api/overview` | 运行总览（版本、运行时长、事件统计、连接与插件概况） |
//! | GET | `/api/bots` | 已连接账号列表 |
//! | GET | `/api/plugins` | 插件与规则列表 |
//! | GET | `/api/config` | 完整配置 |
//! | PATCH | `/api/config` | 局部更新配置（点路径） |
//! | GET | `/api/logs` | 历史日志（支持级别过滤与增量拉取） |
//! | GET | `/api/logs/stream` | 日志实时流（SSE） |
//! | GET | `/api/events/stream` | 事件实时流（SSE） |
//! | POST | `/api/message/send` | 发送消息（测试台） |
//!
//! 鉴权：配置了 `webui.access_token` 时，请求需带
//! `Authorization: Bearer <token>` 或 `?token=<token>`。

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

use crate::config::{Config, WebUiConfig};
use crate::onebot11::connection::{BotRegistry, EventBus};
use crate::plugin::PluginRegistry;
use crate::stats::Stats;

/// WebUI 共享状态
#[derive(Clone)]
pub struct WebUiState {
    pub config: Arc<Config>,
    pub stats: Arc<Stats>,
    pub bots: Arc<BotRegistry>,
    pub plugins: Arc<PluginRegistry>,
    pub events: EventBus,
    pub log_buffer: Arc<crate::logbuf::LogBuffer>,
    /// 配置文件的读写入口
    pub config_path: std::path::PathBuf,
}

impl std::fmt::Debug for WebUiState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebUiState").finish_non_exhaustive()
    }
}

/// 启动 WebUI 服务，绑定端口后返回
pub async fn serve(
    state: WebUiState,
    webui_config: WebUiConfig,
    shutdown: tokio::sync::watch::Receiver<bool>,
) -> anyhow::Result<()> {
    let app = router(state, &webui_config);
    let addr = webui_config.bind_addr();
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|err| anyhow::anyhow!(err).context(format!("WebUI 监听 {addr} 失败")))?;

    tracing::info!("WebUI 已启动：{}", webui_config.display_url());
    if !webui_config.auth_required() {
        tracing::warn!("WebUI 未设置 access_token，仅建议在本机使用");
    }

    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let mut shutdown = shutdown;
            let _ = shutdown.changed().await;
        })
        .await?;
    Ok(())
}

/// 构建路由
pub fn router(state: WebUiState, webui_config: &WebUiConfig) -> Router {
    // 前端构建产物目录（相对可执行文件与当前工作目录都找一下）
    let dist = crate::webui::dist_dir();

    let mut app = Router::new()
        .route("/api/overview", get(overview))
        .route("/api/bots", get(list_bots))
        .route("/api/plugins", get(list_plugins))
        .route("/api/config", get(get_config).patch(patch_config))
        .route("/api/config/schema", get(config_schema))
        .route("/api/logs", get(get_logs))
        .route("/api/logs/stream", get(stream_logs))
        .route("/api/events/stream", get(stream_events))
        .route("/api/message/send", post(send_message))
        .route("/api/health", get(health));

    // 前端静态资源；找不到文件时回落到 index.html（前端路由）
    if let Some(dist) = dist
        && dist.is_dir()
    {
        let index = dist.join("index.html");
        app = app.fallback_service(
            ServeDir::new(&dist).not_found_service(ServeFile::new(index)),
        );
        tracing::debug!("WebUI 静态资源目录：{}", dist.display());
    } else {
        app = app.fallback(|| async {
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                FALLBACK_PAGE,
            )
        });
    }

    app.layer(CorsLayer::permissive())
        .with_state(AuthState {
            inner: state,
            token: webui_config.access_token.clone(),
        })
}

/// 未构建前端时的占位页
const FALLBACK_PAGE: &str = r#"<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>Aster</title>
<style>
body{font:14px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:44rem;margin:14vh auto;padding:0 1.5rem;color:#18181b}
code{background:#f4f4f5;padding:.15em .4em;border-radius:4px;font-size:.9em}
h1{font-size:1.5rem;margin:0 0 .5rem}
p{color:#52525b;margin:.5rem 0}
pre{background:#fafafa;border:1px solid #e4e4e7;border-radius:8px;padding:1rem;overflow:auto}
</style></head><body>
<h1>Aster WebUI</h1>
<p>API 已就绪，但前端尚未构建。</p>
<pre>cd webui
pnpm install
pnpm build</pre>
<p>构建产物会输出到 <code>webui/dist</code>，刷新本页即可。</p>
<p>API 文档见 <code>GET /api/overview</code>。</p>
</body></html>"#;

/// 带鉴权信息的包装状态
#[derive(Clone)]
struct AuthState {
    inner: WebUiState,
    token: String,
}

/// 从请求中提取 token
fn extract_token(headers: &HeaderMap, query: Option<&str>) -> Option<String> {
    if let Some(value) = headers.get(header::AUTHORIZATION)
        && let Ok(text) = value.to_str()
    {
        let text = text.trim();
        for prefix in ["Bearer ", "bearer ", "Token ", "token "] {
            if let Some(rest) = text.strip_prefix(prefix) {
                return Some(rest.trim().to_string());
            }
        }
        return Some(text.to_string());
    }

    let query = query?;
    for pair in query.split('&') {
        if let Some((key, value)) = pair.split_once('=')
            && key == "token"
        {
            return Some(value.to_string());
        }
    }
    None
}

/// 统一鉴权检查
fn authorize(state: &AuthState, headers: &HeaderMap, query: Option<&str>) -> Result<(), Response> {
    if state.token.is_empty() {
        return Ok(());
    }
    match extract_token(headers, query) {
        Some(token) if token == state.token => Ok(()),
        _ => Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "unauthorized", "message": "访问令牌无效或缺失"})),
        )
            .into_response()),
    }
}

macro_rules! guard {
    ($state:expr, $headers:expr, $query:expr) => {
        if let Err(response) = authorize($state, $headers, $query) {
            return response;
        }
    };
}

// ─────────────────────────── 接口实现 ───────────────────────────

async fn health() -> impl IntoResponse {
    Json(json!({"status": "ok", "version": env!("CARGO_PKG_VERSION")}))
}

/// 运行总览
async fn overview(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Query(query): Query<LogQuery>,
) -> Response {
    guard!(&state, &headers, query.query.as_deref());
    let inner = &state.inner;
    let snapshot = inner.stats.snapshot();

    let bots = inner.bots.list().await;
    let bot_items: Vec<Value> = bots
        .iter()
        .map(|bot| {
            json!({
                "self_id": bot.self_id.to_string(),
                "nickname": bot.info.try_lock().ok().and_then(|i| i.nickname.clone()),
                "online": bot.online.load(std::sync::atomic::Ordering::Relaxed),
                "connections": bot.connections.load(std::sync::atomic::Ordering::Relaxed),
            })
        })
        .collect();

    Json(json!({
        "bot": {
            "name": inner.config.bot.name,
            "version": snapshot.version,
            "started_at": snapshot.started_text(),
            "uptime": snapshot.uptime_text(),
            "uptime_secs": snapshot.uptime.as_secs(),
        },
        "stats": {
            "events": snapshot.events,
            "messages": snapshot.messages,
            "notices": snapshot.notices,
            "requests": snapshot.requests,
            "meta_events": snapshot.meta_events,
            "commands": snapshot.commands,
        },
        "plugins": {
            "count": inner.plugins.enabled_count(),
            "rules": inner.plugins.rule_count(),
        },
        "onebot11": {
            "enable": inner.config.onebot11.enable,
            "host": inner.config.onebot11.host,
            "port": inner.config.onebot11.port,
            "path": inner.config.onebot11.normalized_path(),
            "auth": inner.config.onebot11.auth_required(),
        },
        "webui": {
            "auth": inner.config.webui.auth_required(),
        },
        "bots": bot_items,
        "log_count": inner.log_buffer.len(),
    }))
    .into_response()
}

/// 已连接账号
async fn list_bots(State(state): State<AuthState>, headers: HeaderMap) -> Response {
    guard!(&state, &headers, None);

    let bots = state.inner.bots.list().await;
    let items: Vec<Value> = bots
        .iter()
        .map(|bot| {
            let info = bot.info.try_lock().ok();
            json!({
                "self_id": bot.self_id.to_string(),
                "nickname": info.as_ref().and_then(|i| i.nickname.clone()),
                "uin": info.as_ref()
                    .and_then(|i| i.user_id.as_ref())
                    .map(ToString::to_string),
                "avatar": info.as_ref().and_then(|i| i.avatar_url()),
                "online": bot.online.load(std::sync::atomic::Ordering::Relaxed),
                "connections": bot.connections.load(std::sync::atomic::Ordering::Relaxed),
                "connected_secs": bot.connected_at.elapsed().as_secs(),
            })
        })
        .collect();

    Json(json!({"bots": items})).into_response()
}

/// 插件与规则
async fn list_plugins(State(state): State<AuthState>, headers: HeaderMap) -> Response {
    guard!(&state, &headers, None);

    let items: Vec<Value> = state
        .inner
        .plugins
        .plugins()
        .iter()
        .map(|plugin| {
            let rules: Vec<Value> = plugin
                .rules
                .iter()
                .map(|rule| {
                    json!({
                        "name": rule.name,
                        "matcher": describe_matcher(&rule.matcher),
                        "permission": rule.permission.as_str(),
                        "scope": rule.scope.as_str(),
                    })
                })
                .collect();
            json!({
                "name": plugin.name,
                "desc": plugin.desc,
                "author": plugin.author,
                "priority": plugin.priority,
                "enabled": plugin.enabled,
                "rule_count": plugin.rule_count(),
                "rules": rules,
            })
        })
        .collect();

    Json(json!({
        "plugins": items,
        "count": state.inner.plugins.enabled_count(),
        "rules": state.inner.plugins.rule_count(),
    }))
    .into_response()
}

/// 描述匹配方式，供前端展示
fn describe_matcher(matcher: &crate::plugin::Matcher) -> String {
    use crate::plugin::Matcher;
    match matcher {
        Matcher::Command(keyword) => format!("命令 {keyword}"),
        Matcher::Prefix(prefix) => format!("前缀 {prefix}"),
        Matcher::Exact(text) => format!("完全匹配 {text}"),
        Matcher::Regex(regex) => format!("正则 {}", regex.as_str()),
        Matcher::Contains(text) => format!("包含 {text}"),
        Matcher::Any => "任意消息".to_string(),
    }
}

/// 读取完整配置
async fn get_config(State(state): State<AuthState>, headers: HeaderMap) -> Response {
    guard!(&state, &headers, None);
    Json(json!({
        "config": state.inner.config.as_ref(),
        "path": state.inner.config_path.display().to_string(),
    }))
    .into_response()
}

/// 配置项元信息，供前端渲染表单
async fn config_schema(State(state): State<AuthState>, headers: HeaderMap) -> Response {
    guard!(&state, &headers, None);
    Json(json!({
        "fields": [
            {"key": "bot.name", "label": "框架名称", "type": "string", "group": "基础"},
            {"key": "bot.command_prefix", "label": "命令前缀", "type": "string", "group": "基础",
             "hint": "留空则命令直接以命令词开头，例如 as"},
            {"key": "bot.masters", "label": "主人账号", "type": "string[]", "group": "基础"},
            {"key": "bot.builtin_plugins", "label": "启用内置插件", "type": "boolean", "group": "基础"},

            {"key": "log.level", "label": "日志级别", "type": "enum", "group": "日志",
             "options": ["trace", "debug", "info", "warn", "error", "off"]},
            {"key": "log.max_len", "label": "单条日志上限", "type": "number", "group": "日志"},
            {"key": "log.show_base64", "label": "打印完整 base64", "type": "boolean", "group": "日志"},

            {"key": "onebot11.enable", "label": "启用适配器", "type": "boolean", "group": "OneBot v11"},
            {"key": "onebot11.host", "label": "监听地址", "type": "string", "group": "OneBot v11"},
            {"key": "onebot11.port", "label": "监听端口", "type": "number", "group": "OneBot v11"},
            {"key": "onebot11.path", "label": "挂载路径", "type": "string", "group": "OneBot v11"},
            {"key": "onebot11.access_token", "label": "鉴权 Token", "type": "password", "group": "OneBot v11"},
            {"key": "onebot11.trusted_ips", "label": "IP 白名单", "type": "string[]", "group": "OneBot v11"},
            {"key": "onebot11.heartbeat_timeout", "label": "心跳超时（秒）", "type": "number", "group": "OneBot v11"},
            {"key": "onebot11.handshake_timeout", "label": "握手超时（秒）", "type": "number", "group": "OneBot v11"},
            {"key": "onebot11.request_timeout", "label": "请求超时（秒）", "type": "number", "group": "OneBot v11"},

            {"key": "webui.enable", "label": "启用 WebUI", "type": "boolean", "group": "WebUI"},
            {"key": "webui.host", "label": "监听地址", "type": "boolean", "type": "string", "group": "WebUI"},
            {"key": "webui.port", "label": "监听端口", "type": "number", "group": "WebUI"},
            {"key": "webui.access_token", "label": "访问令牌", "type": "password", "group": "WebUI"},
            {"key": "webui.log_capacity", "label": "日志保留条数", "type": "number", "group": "WebUI"},
        ]
    }))
    .into_response()
}

/// 配置更新请求
#[derive(Debug, Deserialize)]
struct ConfigPatch {
    /// 点路径 → 新值，例如 `{"onebot11.port": 5310}`
    values: std::collections::HashMap<String, Value>,
}

/// 局部更新配置
async fn patch_config(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Json(patch): Json<ConfigPatch>,
) -> Response {
    guard!(&state, &headers, None);

    if patch.values.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "empty", "message": "没有需要更新的配置项"})),
        )
            .into_response();
    }

    // 读取 → 修改 → 校验 → 写回
    let text = match std::fs::read_to_string(&state.inner.config_path) {
        Ok(text) => text,
        Err(err) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "read_failed", "message": err.to_string()})),
            )
                .into_response();
        }
    };
    let mut doc: toml::Value = match toml::from_str(&text) {
        Ok(doc) => doc,
        Err(err) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "parse_failed", "message": err.to_string()})),
            )
                .into_response();
        }
    };

    for (key, value) in &patch.values {
        if let Err(message) = set_toml_path(&mut doc, key, value) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "invalid_key", "message": message})),
            )
                .into_response();
        }
    }

    // 写回前先反序列化校验，避免写入坏配置
    let serialized = match toml::to_string_pretty(&doc) {
        Ok(text) => text,
        Err(err) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "serialize_failed", "message": err.to_string()})),
            )
                .into_response();
        }
    };
    if let Err(err) = toml::from_str::<Config>(&serialized) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "invalid_config",
                "message": format!("配置校验失败：{err}"),
            })),
        )
            .into_response();
    }

    if let Err(err) = std::fs::write(&state.inner.config_path, serialized) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "write_failed", "message": err.to_string()})),
        )
            .into_response();
    }

    tracing::info!("WebUI 更新了配置：{:?}", patch.values.keys());
    Json(json!({
        "ok": true,
        "restart_required": true,
        "message": "配置已保存，重启后生效",
    }))
    .into_response()
}

/// 按点路径写入 TOML
fn set_toml_path(doc: &mut toml::Value, path: &str, value: &Value) -> Result<(), String> {
    let keys: Vec<&str> = path.split('.').filter(|s| !s.is_empty()).collect();
    if keys.is_empty() {
        return Err("配置键不能为空".to_string());
    }

    let mut cursor = doc;
    for key in &keys[..keys.len() - 1] {
        let table = cursor
            .as_table_mut()
            .ok_or_else(|| format!("{key} 不是配置分组"))?;
        cursor = table
            .entry((*key).to_string())
            .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
    }

    let table = cursor
        .as_table_mut()
        .ok_or_else(|| "目标不是配置分组".to_string())?;
    let last = keys[keys.len() - 1];
    let converted = json_to_toml(value).ok_or_else(|| format!("{path} 的值类型不支持"))?;
    table.insert(last.to_string(), converted);
    Ok(())
}

/// JSON 值转 TOML 值
fn json_to_toml(value: &Value) -> Option<toml::Value> {
    Some(match value {
        Value::Null => return None,
        Value::Bool(b) => toml::Value::Boolean(*b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                toml::Value::Integer(i)
            } else {
                toml::Value::Float(n.as_f64()?)
            }
        }
        Value::String(s) => toml::Value::String(s.clone()),
        Value::Array(items) => toml::Value::Array(
            items
                .iter()
                .map(json_to_toml)
                .collect::<Option<Vec<_>>>()?,
        ),
        Value::Object(map) => {
            let mut table = toml::map::Map::new();
            for (k, v) in map {
                // TOML 表里不允许 null
                if v.is_null() {
                    continue;
                }
                table.insert(k.clone(), json_to_toml(v)?);
            }
            toml::Value::Table(table)
        }
    })
}

/// 日志查询参数
#[derive(Debug, Default, Deserialize)]
struct LogQuery {
    limit: Option<usize>,
    level: Option<String>,
    after: Option<u64>,
    /// 供 SSE 接口复用鉴权
    token: Option<String>,
    query: Option<String>,
}

/// 历史日志
async fn get_logs(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Query(query): Query<LogQuery>,
) -> Response {
    guard!(&state, &headers, query.token.as_deref());
    let limit = query.limit.unwrap_or(500).min(5000);

    let entries = match query.level.as_deref() {
        Some(level) if !level.is_empty() && level != "all" => {
            state.inner.log_buffer.filter_level(level, limit)
        }
        _ => state.inner.log_buffer.tail(limit, query.after),
    };

    Json(json!({
        "logs": entries,
        "count": entries.len(),
        "capacity": state.inner.log_buffer.len(),
    }))
    .into_response()
}

/// 日志实时流（SSE）
async fn stream_logs(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Query(query): Query<LogQuery>,
) -> Response {
    guard!(&state, &headers, query.token.as_deref());

    let receiver = state.inner.log_buffer.subscribe();
    let stream = BroadcastStream::new(receiver).filter_map(|result| match result {
        Ok(entry) => {
            let data = serde_json::to_string(&entry).unwrap_or_default();
            Some(Ok::<_, Infallible>(
                SseEvent::default().event("log").data(data),
            ))
        }
        Err(_) => None,
    });

    Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response()
}

/// 事件实时流（SSE）
async fn stream_events(State(state): State<AuthState>, headers: HeaderMap) -> Response {
    guard!(&state, &headers, None);

    // 订阅事件总线：把 EventBus 的 mpsc 接收端转为 SSE
    let receiver = state.inner.events.subscribe();
    let stream = BroadcastStream::new(receiver).filter_map(|result| match result {
        Ok(event) => {
            let payload = json!({
                "name": event.event_name(),
                "time": event.time(),
                "self_id": event.self_id().map(ToString::to_string),
                "raw": event.raw(),
            });
            Some(Ok::<_, Infallible>(
                SseEvent::default()
                    .event("event")
                    .data(payload.to_string()),
            ))
        }
        Err(_) => None,
    });

    Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response()
}

/// 发送消息请求
#[derive(Debug, Deserialize)]
struct SendRequest {
    /// 目标类型：group 或 private
    target: String,
    /// 群号或用户号
    id: String,
    /// 消息内容（字符串或段数组）
    message: Value,
    /// 指定机器人账号，缺省用第一个在线账号
    #[serde(default)]
    self_id: Option<String>,
}

/// 发送消息（测试台）
async fn send_message(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Json(request): Json<SendRequest>,
) -> Response {
    guard!(&state, &headers, None);

    // 先校验入参，再检查账号可用性——否则参数错误会被误报成"没有账号"
    if !matches!(request.target.as_str(), "group" | "private") {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "invalid_target",
                "message": format!("target 只能是 group 或 private，收到 {}", request.target),
            })),
        )
            .into_response();
    }

    let bots = state.inner.bots.list().await;
    let bot = match &request.self_id {
        Some(id) => bots
            .iter()
            .find(|b| b.self_id.as_str() == id.as_str())
            .cloned(),
        None => bots.first().cloned(),
    };

    let Some(bot) = bot else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "no_bot", "message": "没有在线账号，请先让协议端连接"})),
        )
            .into_response();
    };

    let result = match request.target.as_str() {
        "group" => bot.send_group_msg(&request.id, request.message.clone()).await,
        _ => {
            bot.send_private_msg(&request.id, request.message.clone())
                .await
        }
    };

    match result {
        Ok(data) => Json(json!({"ok": true, "data": data})).into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error": "send_failed", "message": err.to_string()})),
        )
            .into_response(),
    }
}

/// 测试用临时目录，离开作用域时自动删除。
///
/// 不用 `tempfile` 是为了避免为测试引入额外依赖。
#[cfg(test)]
pub(crate) struct TempDir(std::path::PathBuf);

#[cfg(test)]
impl TempDir {
    fn new(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "aster-webui-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        Self(dir)
    }

    fn path(&self) -> &std::path::Path {
        &self.0
    }
}

#[cfg(test)]
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// 供测试使用：构造一个最小状态
///
/// 返回的 [`TempDir`] 必须被测试持有，否则目录会提前删除。
#[cfg(test)]
pub(crate) fn test_state(config: Config) -> (WebUiState, TempDir) {
    let dir = TempDir::new("test");
    let config_path = dir.path().join("config.toml");
    std::fs::write(
        &config_path,
        toml::to_string_pretty(&config).expect("序列化配置失败"),
    )
    .expect("写入配置失败");

    let (bus, _rx) = EventBus::new(16);
    let state = WebUiState {
        config: Arc::new(config),
        stats: Arc::new(Stats::new()),
        bots: Arc::new(BotRegistry::default()),
        plugins: Arc::new(PluginRegistry::new()),
        events: bus,
        log_buffer: crate::logbuf::LogBuffer::new(100),
        config_path,
    };
    (state, dir)
}

/// 未使用但在测试中需要的占位，保证 trait 完整
#[allow(dead_code)]
fn _assert_send_sync() {
    fn assert<T: Send + Sync>() {}
    assert::<WebUiState>();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    #[test]
    fn token_extraction_from_header() {
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "Bearer secret".parse().unwrap());
        assert_eq!(
            extract_token(&headers, None).as_deref(),
            Some("secret"),
            "应支持 Bearer 前缀"
        );

        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "secret".parse().unwrap());
        assert_eq!(extract_token(&headers, None).as_deref(), Some("secret"));

        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "Token abc".parse().unwrap());
        assert_eq!(extract_token(&headers, None).as_deref(), Some("abc"));
    }

    #[test]
    fn token_extraction_from_query() {
        assert_eq!(
            extract_token(&HeaderMap::new(), Some("token=xyz")).as_deref(),
            Some("xyz")
        );
        assert_eq!(
            extract_token(&HeaderMap::new(), Some("a=1&token=xyz&b=2")).as_deref(),
            Some("xyz")
        );
        assert_eq!(extract_token(&HeaderMap::new(), Some("a=1")), None);
        assert_eq!(extract_token(&HeaderMap::new(), None), None);
    }

    #[test]
    fn json_to_toml_conversion() {
        assert_eq!(json_to_toml(&json!(true)), Some(toml::Value::Boolean(true)));
        assert_eq!(json_to_toml(&json!(42)), Some(toml::Value::Integer(42)));
        assert_eq!(
            json_to_toml(&json!("hi")),
            Some(toml::Value::String("hi".into()))
        );
        assert_eq!(json_to_toml(&json!(null)), None, "null 不可转换");

        let array = json_to_toml(&json!(["a", "b"])).unwrap();
        assert_eq!(array.as_array().unwrap().len(), 2);
    }

    #[test]
    fn set_toml_path_writes_nested() {
        let mut doc: toml::Value = toml::from_str(
            r#"
            [onebot11]
            port = 5310
            "#,
        )
        .unwrap();

        set_toml_path(&mut doc, "onebot11.port", &json!(5399)).unwrap();
        assert_eq!(doc["onebot11"]["port"].as_integer(), Some(5399));

        // 不存在的中间层会自动创建
        set_toml_path(&mut doc, "webui.port", &json!(5311)).unwrap();
        assert_eq!(doc["webui"]["port"].as_integer(), Some(5311));
    }

    #[test]
    fn set_toml_path_rejects_empty() {
        let mut doc: toml::Value = toml::from_str("[a]\nb=1").unwrap();
        assert!(set_toml_path(&mut doc, "", &json!(1)).is_err());
        assert!(set_toml_path(&mut doc, "...", &json!(1)).is_err());
    }

    #[tokio::test]
    async fn patch_config_persists_and_validates() {
        let (state, _dir) = test_state(Config::default());
        let path = state.config_path.clone();

        // 合法更新
        let mut values = std::collections::HashMap::new();
        values.insert("onebot11.port".to_string(), json!(5399));
        let result = patch_config(
            State(AuthState {
                inner: state.clone(),
                token: String::new(),
            }),
            HeaderMap::new(),
            Json(ConfigPatch { values }),
        )
        .await;
        assert_eq!(result.status(), StatusCode::OK);

        let text = std::fs::read_to_string(&path).unwrap();
        let parsed: Config = toml::from_str(&text).unwrap();
        assert_eq!(parsed.onebot11.port, 5399);
    }

    #[tokio::test]
    async fn patch_config_rejects_invalid_value() {
        let (state, _dir) = test_state(Config::default());

        let mut values = std::collections::HashMap::new();
        // 端口必须是数字，传字符串应被拒绝
        values.insert("onebot11.port".to_string(), json!("not-a-number"));

        let result = patch_config(
            State(AuthState {
                inner: state.clone(),
                token: String::new(),
            }),
            HeaderMap::new(),
            Json(ConfigPatch { values }),
        )
        .await;
        assert_eq!(result.status(), StatusCode::BAD_REQUEST, "非法值应被拒绝");
    }

    #[tokio::test]
    async fn patch_config_rejects_empty_patch() {
        let (state, _dir) = test_state(Config::default());
        let result = patch_config(
            State(AuthState {
                inner: state,
                token: String::new(),
            }),
            HeaderMap::new(),
            Json(ConfigPatch {
                values: std::collections::HashMap::new(),
            }),
        )
        .await;
        assert_eq!(result.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn authorize_enforces_token() {
        let (state, _dir) = test_state(Config::default());
        let secured = AuthState {
            inner: state.clone(),
            token: "secret".into(),
        };

        // 无 token → 401
        assert!(authorize(&secured, &HeaderMap::new(), None).is_err());

        // 正确 token → 通过
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "Bearer secret".parse().unwrap());
        assert!(authorize(&secured, &headers, None).is_ok());

        // 错误 token → 401
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "Bearer wrong".parse().unwrap());
        assert!(authorize(&secured, &headers, None).is_err());

        // 未设置 token 时不校验
        let open = AuthState {
            inner: state,
            token: String::new(),
        };
        assert!(authorize(&open, &HeaderMap::new(), None).is_ok());
    }

    #[tokio::test]
    async fn send_message_without_bot_fails_gracefully() {
        let (state, _dir) = test_state(Config::default());
        let response = send_message(
            State(AuthState {
                inner: state,
                token: String::new(),
            }),
            HeaderMap::new(),
            Json(SendRequest {
                target: "group".into(),
                id: "123".into(),
                message: json!("hi"),
                self_id: None,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn send_message_rejects_invalid_target() {
        let (state, _dir) = test_state(Config::default());
        let response = send_message(
            State(AuthState {
                inner: state,
                token: String::new(),
            }),
            HeaderMap::new(),
            Json(SendRequest {
                target: "channel".into(),
                id: "123".into(),
                message: json!("hi"),
                self_id: None,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn describe_matcher_variants() {
        use crate::plugin::{Matcher, Rule};
        assert!(describe_matcher(&Rule::command("as").matcher).contains("命令 as"));
        assert!(describe_matcher(&Rule::prefix("#as").matcher).contains("前缀 #as"));
        assert!(describe_matcher(&Rule::exact("状态").matcher).contains("完全匹配"));
        assert!(describe_matcher(&Rule::any().matcher).contains("任意"));
        assert!(describe_matcher(&Matcher::Contains("x".into())).contains("包含"));
    }
}
