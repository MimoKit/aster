//! Aster 可执行程序入口。
//!
//! 负责：加载配置 → 初始化日志 → 注册插件 → 启动 OneBot v11 适配器 → 分发事件。

use std::sync::Arc;

use anyhow::{Context, Result};
use aster::config::Config;
use aster::event::Event;
use aster::onebot11::OneBot11Server;
use aster::onebot11::connection::{BotRegistry, EventBus};
use aster::plugin::builtin;
use aster::plugin::{DispatchBase, PluginRegistry};
use aster::stats::Stats;
use tokio::sync::watch;

/// 事件队列容量
const EVENT_QUEUE: usize = 1024;
/// 状态插件的默认命令词
const STATUS_COMMAND: &str = "as";

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

    // ── 插件注册 ──
    let mut registry = PluginRegistry::new();
    if config.bot.builtin_plugins {
        registry.register(builtin::status_plugin_with(
            config.bot.command_prefix.clone(),
            STATUS_COMMAND,
        ));
    }
    let plugin_count = registry.enabled_count();
    let rule_count = registry.rule_count();

    if plugin_count == 0 {
        tracing::warn!("未加载任何插件");
    } else {
        tracing::info!("已加载 {plugin_count} 个插件、{rule_count} 条规则");
        for plugin in registry.plugins() {
            tracing::debug!(
                "  - {}：{}（优先级 {}，{} 条规则）",
                plugin.name,
                plugin.desc,
                plugin.priority,
                plugin.rule_count()
            );
        }
    }

    let stats = Arc::new(Stats::new());
    stats.set_plugins(plugin_count);

    if !config.bot.masters.is_empty() {
        tracing::info!("主人账号：{}", config.bot.masters.join(", "));
    } else {
        tracing::debug!("未配置主人账号（bot.masters），权限类命令将不可用");
    }

    let (bus, events) = EventBus::new(EVENT_QUEUE);
    let bots = Arc::new(BotRegistry::default());
    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    // ── 事件消费：统计 + 插件分发 ──
    let consumer = tokio::spawn(consume_events(
        events,
        Arc::new(registry),
        stats.clone(),
        bots.clone(),
        Arc::new(config.bot.master_ids()),
    ));

    let server = Arc::new(OneBot11Server::new(
        config.onebot11.clone(),
        bots.clone(),
        bus,
    ));

    if !config.onebot11.enable {
        tracing::warn!("配置中 onebot11.enable = false，适配器未启动");
        return Ok(());
    }

    // 先完成端口绑定再进入事件循环：
    // 绑定失败（例如端口被占用）必须立即报错退出，
    // 否则进程会静默挂起，用户看不到任何反馈。
    let listener = server.bind().await?;
    let local = listener.local_addr()?;
    tracing::info!(
        "OneBot v11 适配器已监听 ws://{}{} （鉴权：{}）",
        local,
        server.config.normalized_path(),
        if server.config.auth_required() {
            "已开启"
        } else {
            "关闭"
        }
    );

    let serve_task = {
        let server = server.clone();
        let shutdown_rx = shutdown_rx.clone();
        tokio::spawn(async move { server.serve_on(listener, shutdown_rx).await })
    };

    // 等待退出信号；若适配器提前退出（异常），同样立刻返回
    tokio::select! {
        _ = wait_for_shutdown() => {
            tracing::info!("收到退出信号，正在关闭...");
        }
        result = &mut { serve_task } => {
            // 走到这里说明服务端在没有收到关闭信号的情况下退出了
            match result {
                Ok(Ok(())) => tracing::warn!("适配器意外停止"),
                Ok(Err(err)) => {
                    consumer.abort();
                    return Err(err.context("适配器异常退出"));
                }
                Err(err) => {
                    consumer.abort();
                    return Err(anyhow::anyhow!("适配器任务 panic：{err}"));
                }
            }
        }
    }

    let _ = shutdown_tx.send(true);
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

/// 事件消费循环：统计 → 日志 → 插件分发
async fn consume_events(
    mut events: tokio::sync::mpsc::Receiver<Arc<Event>>,
    registry: Arc<PluginRegistry>,
    stats: Arc<Stats>,
    bots: Arc<BotRegistry>,
    masters: Arc<Vec<aster::event::Id>>,
) {
    while let Some(event) = events.recv().await {
        stats.record_event(&event);
        log_event(&event);

        // 只有 message 事件参与插件分发（message_sent 是机器人自己发的，跳过以免自触发）
        let Event::Message(message) = &*event else {
            continue;
        };
        let message = Arc::new(message.clone());

        let Some(self_id) = event.self_id() else {
            continue;
        };
        let Some(bot) = bots.get(self_id).await else {
            tracing::debug!("事件来自未知账号 {self_id}，跳过插件分发");
            continue;
        };

        let result = registry
            .dispatch(DispatchBase {
                event: &message,
                bot,
                stats: stats.clone(),
                masters: &masters,
            })
            .await;

        if let Err(err) = result {
            tracing::error!("插件分发出错：{err:#}");
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
        Event::Meta(meta) => {
            tracing::debug!("[{}] {}", event.event_name(), meta.base().self_id)
        }
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
