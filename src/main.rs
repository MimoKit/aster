//! Aster 可执行程序入口。
//!
//! 负责：加载配置 → 初始化日志 → 启动 OneBot v11 适配器 → 消费事件。

use std::sync::Arc;

use anyhow::{Context, Result};
use aster::config::Config;
use aster::event::Event;
use aster::onebot11::OneBot11Server;
use aster::onebot11::connection::{BotRegistry, EventBus};
use tokio::sync::watch;

/// 事件队列容量
const EVENT_QUEUE: usize = 1024;

fn main() -> Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("创建 Tokio 运行时失败")?;
    runtime.block_on(run())
}

async fn run() -> Result<()> {
    let config = Config::load()?;
    aster::logging::setup(&config.log)?;

    tracing::info!("{} v{} 启动中", config.bot.name, env!("CARGO_PKG_VERSION"));

    let (bus, events) = EventBus::new(EVENT_QUEUE);
    let bots = Arc::new(BotRegistry::default());
    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    // 事件消费侧：打印规范化结果，后续接插件系统
    let consumer = tokio::spawn(consume_events(events));

    let server = Arc::new(OneBot11Server::new(
        config.onebot11.clone(),
        bots.clone(),
        bus,
    ));

    if !config.onebot11.enable {
        tracing::warn!("配置中 onebot11.enable = false，适配器未启动");
        return Ok(());
    }

    let serve_task = {
        let server = server.clone();
        let shutdown_rx = shutdown_rx.clone();
        tokio::spawn(async move { server.serve(shutdown_rx).await })
    };

    wait_for_shutdown().await;
    tracing::info!("收到退出信号，正在关闭...");
    let _ = shutdown_tx.send(true);

    match tokio::time::timeout(std::time::Duration::from_secs(5), serve_task).await {
        Ok(Ok(Ok(()))) => tracing::info!("适配器已停止"),
        Ok(Ok(Err(err))) => tracing::error!("适配器异常退出：{err:#}"),
        Ok(Err(err)) => tracing::error!("适配器任务 panic：{err}"),
        Err(_) => tracing::warn!("适配器停止超时，强制退出"),
    }

    consumer.abort();
    Ok(())
}

/// 等待 Ctrl-C 或 SIGTERM
async fn wait_for_shutdown() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(err) => {
                tracing::warn!("注册 SIGTERM 失败：{err}");
                let _ = tokio::signal::ctrl_c().await;
                return;
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => tracing::info!("收到 Ctrl-C"),
            _ = term.recv() => tracing::info!("收到 SIGTERM"),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// 事件消费循环：打印事件摘要，并演示回复能力
async fn consume_events(mut events: tokio::sync::mpsc::Receiver<Arc<Event>>) {
    while let Some(event) = events.recv().await {
        log_event(&event);

        // 示例：私聊 / 群聊里 @ 机器人并说 "ping" 时回 "pong"
        if let Event::Message(msg) = &*event
            && msg.is_at_self()
            && msg.text().contains("ping")
        {
            let bots = BotRegistry::default();
            let _ = bots; // 占位：真正的回复逻辑将由插件系统接管
            tracing::info!(
                "命中示例规则：{} 在 {} 里 @ 了机器人",
                msg.display_name(),
                msg.session_id()
            );
        }
    }
}

/// 打印规范化后的事件摘要
fn log_event(event: &Event) {
    match event {
        Event::Message(msg) => tracing::info!(
            "[{}] {} <= {} {} | {}",
            event.event_name(),
            msg.self_id(),
            msg.session_id(),
            msg.display_name(),
            truncate(&msg.message.text, 200),
        ),
        Event::MessageSent(msg) => tracing::info!(
            "[{}] {} => {} | {}",
            event.event_name(),
            msg.self_id(),
            msg.session_id(),
            truncate(&msg.message.text, 200),
        ),
        Event::Notice(notice) => tracing::info!(
            "[{}] {} | group={:?} user={:?}",
            event.event_name(),
            notice.base().self_id,
            notice.group_id(),
            notice.user_id(),
        ),
        Event::Request(request) => tracing::info!(
            "[{}] {} | flag={:?}",
            event.event_name(),
            request.base().self_id,
            request.flag(),
        ),
        Event::Meta(meta) => tracing::debug!(
            "[{}] {}",
            event.event_name(),
            meta.base().self_id
        ),
        Event::Unknown { post_type, .. } => {
            tracing::warn!("未识别事件：post_type={post_type}")
        }
    }
}

fn truncate(input: &str, max: usize) -> String {
    if input.chars().count() <= max {
        return input.to_string();
    }
    let head: String = input.chars().take(max).collect();
    format!("{head}...")
}
