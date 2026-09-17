//! Aster：一个 Rust 编写的 Bot 框架。
//!
//! 当前阶段聚焦 **OneBot v11** 适配器与消息字段规范化：
//!
//! ```text
//! 协议端 ──WebSocket──▶ onebot11::OneBot11Server
//!                          │
//!                          ├─ 鉴权（Token / IP / 路径）
//!                          ├─ action/echo 请求-响应（ApiCaller）
//!                          └─ 事件规范化（event::Event）
//!                                  │
//!                                  ├─ message::MessageContent（消息字段规范化）
//!                                  └─ EventBus ──▶ 业务层 / 插件
//! ```
//!
//! # 快速开始
//!
//! ```no_run
//! # async fn demo() -> anyhow::Result<()> {
//! use std::sync::Arc;
//! use aster::config::Config;
//! use aster::onebot11::connection::{BotRegistry, EventBus};
//! use aster::onebot11::OneBot11Server;
//!
//! let config = Config::load()?;
//! let (bus, mut events) = EventBus::new(256);
//! let server = Arc::new(OneBot11Server::new(
//!     config.onebot11.clone(),
//!     Arc::new(BotRegistry::default()),
//!     bus,
//! ));
//!
//! // 业务侧消费事件
//! tokio::spawn(async move {
//!     while let Some(event) = events.recv().await {
//!         println!("{}", event.event_name());
//!     }
//! });
//!
//! let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
//! server.serve(shutdown_rx).await?;
//! # Ok(())
//! # }
//! ```

pub mod config;
pub mod event;
pub mod logging;
pub mod message;
pub mod onebot11;
pub mod plugin;
pub mod stats;

pub use config::Config;
pub use event::{Event, EventBase, Id, MessageEvent, MessageType};
pub use message::{MessageContent, Segment};
pub use plugin::{Permission, Plugin, PluginContext, PluginRegistry, Rule, Scope};
pub use stats::Stats;
