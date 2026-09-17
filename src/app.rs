//! 应用装配与启动。
//!
//! 把「加载配置 → 注册插件 → 启动适配器 → 分发事件」这套流程封装成 [`App`]，
//! 插件项目只需组装自己的插件再调用 [`App::run`]：
//!
//! ```no_run
//! use aster::App;
//!
//! fn main() -> anyhow::Result<()> {
//!     App::new()?
//!         .plugin(my_plugin())
//!         .run()
//! }
//! # fn my_plugin() -> aster::Plugin { todo!() }
//! ```
//!
//! 内置插件（`as` 状态查询）由 [`App`] 按配置自动注册，
//! 也可以先用 [`App::without_builtins`] 关掉再自行添加。

use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::sync::watch;

use crate::config::Config;
use crate::event::Event;
use crate::onebot11::OneBot11Server;
use crate::onebot11::connection::{BotRegistry, EventBus};
use crate::plugin::builtin;
use crate::plugin::{DispatchBase, Plugin, PluginRegistry};
use crate::stats::Stats;

/// 事件队列容量
const EVENT_QUEUE: usize = 1024;
/// 内置状态插件的命令词
const STATUS_COMMAND: &str = "as";

/// 一个待启动的 Aster 实例
pub struct App {
    config: Config,
    plugins: Vec<Plugin>,
    with_builtins: bool,
}

impl App {
    /// 从工作目录的 `config.toml` 加载配置
    pub fn new() -> Result<Self> {
        Ok(Self::with_config(Config::load()?))
    }

    /// 使用已有配置
    pub fn with_config(config: Config) -> Self {
        let with_builtins = config.bot.builtin_plugins;
        Self {
            config,
            plugins: Vec::new(),
            with_builtins,
        }
    }

    /// 关闭内置插件（`as` 状态查询）
    pub fn without_builtins(mut self) -> Self {
        self.with_builtins = false;
        self
    }

    /// 追加一个插件
    pub fn plugin(mut self, plugin: Plugin) -> Self {
        self.plugins.push(plugin);
        self
    }

    /// 批量追加插件
    pub fn plugins(mut self, plugins: impl IntoIterator<Item = Plugin>) -> Self {
        self.plugins.extend(plugins);
        self
    }

    /// 当前配置
    pub fn config(&self) -> &Config {
        &self.config
    }

    /// 启动并阻塞到进程退出
    pub fn run(self) -> Result<()> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .context("创建 Tokio 运行时失败")?;
        runtime.block_on(self.run_async())
    }

    /// 在已有 Tokio 运行时中启动
    pub async fn run_async(self) -> Result<()> {
        let Self {
            config,
            plugins: extra,
            with_builtins,
        } = self;

        crate::logging::setup(&config.log)?;
        tracing::info!("{} v{} 启动中", config.bot.name, env!("CARGO_PKG_VERSION"));

        // ── 插件注册 ──
        let mut registry = PluginRegistry::new();
        if with_builtins {
            registry.register(builtin::status_plugin_with(
                config.bot.command_prefix.clone(),
                STATUS_COMMAND,
            ));
        }
        for plugin in extra {
            registry.register(plugin);
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

        if config.bot.masters.is_empty() {
            tracing::debug!("未配置主人账号（bot.masters），权限类命令将不可用");
        } else {
            tracing::info!("主人账号：{}", config.bot.masters.join(", "));
        }

        let (bus, events) = EventBus::new(EVENT_QUEUE);
        let bots = Arc::new(BotRegistry::default());
        let (shutdown_tx, shutdown_rx) = watch::channel(false);

        let registry = Arc::new(registry);
        let consumer = tokio::spawn(consume_events(
            events,
            registry.clone(),
            stats.clone(),
            bots.clone(),
            Arc::new(config.bot.master_ids()),
        ));

        // ── WebUI ──
        let webui_config = config.webui.clone();
        let webui_task = if webui_config.enable {
            let config_path = std::env::current_dir()
                .map(|dir| dir.join(crate::config::RUNTIME_FILE))
                .unwrap_or_else(|_| std::path::PathBuf::from(crate::config::RUNTIME_FILE));

            let state = crate::webui::WebUiState {
                config: Arc::new(config.clone()),
                stats: stats.clone(),
                bots: bots.clone(),
                plugins: registry.clone(),
                events: bus.clone(),
                log_buffer: crate::logging::buffer(),
                config_path,
            };
            let shutdown_rx = shutdown_rx.clone();
            Some(tokio::spawn(async move {
                if let Err(err) = crate::webui::serve(state, webui_config, shutdown_rx).await {
                    tracing::error!("WebUI 退出：{err:#}");
                }
            }))
        } else {
            None
        };

        if !config.onebot11.enable {
            tracing::warn!("配置中 onebot11.enable = false，适配器未启动");
            consumer.abort();
            return Ok(());
        }

        let server = Arc::new(OneBot11Server::new(
            config.onebot11.clone(),
            bots.clone(),
            bus,
        ));

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

        let mut serve_task = {
            let server = server.clone();
            let shutdown_rx = shutdown_rx.clone();
            tokio::spawn(async move { server.serve_on(listener, shutdown_rx).await })
        };

        tokio::select! {
            _ = wait_for_shutdown() => {
                tracing::info!("收到退出信号，正在关闭...");
                let _ = shutdown_tx.send(true);
                match tokio::time::timeout(std::time::Duration::from_secs(5), &mut serve_task).await {
                    Ok(Ok(Ok(()))) => tracing::info!("适配器已停止"),
                    Ok(Ok(Err(err))) => tracing::error!("适配器退出：{err:#}"),
                    Ok(Err(err)) => tracing::error!("适配器任务 panic：{err}"),
                    Err(_) => tracing::warn!("适配器停止超时"),
                }
            }
            result = &mut serve_task => {
                // 没收到关闭信号就退出，说明是异常
                consumer.abort();
                if let Some(task) = webui_task {
                    task.abort();
                }
                match result {
                    Ok(Ok(())) => return Err(anyhow::anyhow!("适配器意外停止")),
                    Ok(Err(err)) => return Err(err.context("适配器异常退出")),
                    Err(err) => return Err(anyhow::anyhow!("适配器任务 panic：{err}")),
                }
            }
        }

        consumer.abort();
        if let Some(task) = webui_task {
            task.abort();
        }
        Ok(())
    }
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
    masters: Arc<Vec<crate::event::Id>>,
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

        if let Err(err) = registry
            .dispatch(DispatchBase {
                event: &message,
                bot,
                stats: stats.clone(),
                masters: &masters,
            })
            .await
        {
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
