//! 插件系统。
//!
//! ## 组成
//!
//! | 类型 | 职责 |
//! |------|------|
//! | [`Plugin`] | 一组规则的集合（名称、描述、优先级、作者） |
//! | [`Rule`] | 单条命令规则（匹配方式 + 权限 + 处理函数） |
//! | [`PluginContext`] | 传给处理函数的上下文（事件、参数、回复能力） |
//! | [`PluginRegistry`] | 注册表，按优先级分发事件 |
//!
//! ## 快速上手
//!
//! ```ignore
//! use aster::plugin::{Plugin, Rule, Permission};
//!
//! let plugin = Plugin::builder("hello")
//!     .desc("打招呼")
//!     .priority(100)
//!     .rule(
//!         Rule::prefix("#hello")
//!             .name("打招呼")
//!             .permission(Permission::All)
//!             .on(|ctx| async move {
//!                 ctx.reply("你好！").await
//!             }),
//!     )
//!     .build();
//!
//! registry.register(plugin);
//! ```

pub mod builtin;
pub mod rule;

use std::sync::Arc;

use anyhow::Result;
use futures_util::future::BoxFuture;

use crate::event::{Event, Id, MessageEvent};
use crate::message::Segment;
use crate::onebot11::connection::Bot;

pub use rule::{Handled, Matcher, Matched, Permission, Rule, Scope};

/// 插件执行上下文
#[derive(Clone)]
pub struct PluginContext {
    /// 触发的事件
    pub event: Arc<MessageEvent>,
    /// 规则匹配到的参数
    pub matched: Matched,
    /// 机器人账号（用于回复）
    pub bot: Arc<Bot>,
    /// 运行时统计
    pub stats: Arc<crate::stats::Stats>,
    /// 机器人主人列表
    pub masters: Arc<Vec<Id>>,
    /// 已加载插件数（状态类插件需要）
    pub plugin_count: usize,
}

impl std::fmt::Debug for PluginContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PluginContext")
            .field(
                "event",
                &format!(
                    "{}.{}",
                    self.event.message_type.as_str(),
                    self.event.sub_type
                ),
            )
            .field("args", &self.matched.args)
            .field("self_id", &self.bot.self_id)
            .finish_non_exhaustive()
    }
}

impl PluginContext {
    /// 回复纯文本
    pub async fn reply(&self, text: impl Into<String>) -> Result<()> {
        self.bot
            .reply(&self.event, serde_json::Value::String(text.into()))
            .await?;
        Ok(())
    }

    /// 回复消息段（例如「文本 + 图片」）
    pub async fn reply_segments(&self, segments: Vec<Segment>) -> Result<()> {
        let value = crate::message::segments_to_array(&segments);
        self.bot.reply(&self.event, value).await?;
        Ok(())
    }

    /// 是否群聊
    pub fn is_group(&self) -> bool {
        self.event.is_group()
    }

    /// 群号
    pub fn group_id(&self) -> Option<&Id> {
        self.event.group_id()
    }

    /// 发送者
    pub fn user_id(&self) -> &Id {
        &self.event.user_id
    }

    /// 命令参数（前缀后的内容）
    pub fn args(&self) -> &str {
        &self.matched.args
    }

    /// 参数按空白切分
    pub fn arg_list(&self) -> Vec<&str> {
        self.matched.args.split_whitespace().collect()
    }

    /// 完整消息文本
    pub fn text(&self) -> &str {
        &self.matched.text
    }

    /// 是否引用回复（回复时带上 reply 段）
    pub async fn reply_quote(&self, text: impl Into<String>) -> Result<()> {
        let segments = vec![
            Segment::Reply {
                id: self.event.message_id.to_string(),
            },
            Segment::Text { text: text.into() },
        ];
        self.reply_segments(segments).await
    }
}

/// 插件定义
pub struct Plugin {
    /// 插件名（唯一标识）
    pub name: String,
    /// 描述
    pub desc: String,
    /// 作者
    pub author: String,
    /// 优先级，数字越小越先执行
    pub priority: i32,
    /// 规则列表
    pub rules: Vec<Rule>,
    /// 是否启用
    pub enabled: bool,
}

impl Plugin {
    /// 创建构建器
    pub fn builder(name: impl Into<String>) -> PluginBuilder {
        PluginBuilder::new(name)
    }

    /// 插件包含的规则数
    pub fn rule_count(&self) -> usize {
        self.rules.len()
    }
}

impl std::fmt::Debug for Plugin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Plugin")
            .field("name", &self.name)
            .field("desc", &self.desc)
            .field("priority", &self.priority)
            .field("rules", &self.rules.len())
            .field("enabled", &self.enabled)
            .finish()
    }
}

/// 插件构建器
pub struct PluginBuilder {
    plugin: Plugin,
}

impl PluginBuilder {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            plugin: Plugin {
                name: name.into(),
                desc: String::new(),
                author: String::new(),
                priority: 5000,
                rules: Vec::new(),
                enabled: true,
            },
        }
    }

    pub fn desc(mut self, desc: impl Into<String>) -> Self {
        self.plugin.desc = desc.into();
        self
    }

    pub fn author(mut self, author: impl Into<String>) -> Self {
        self.plugin.author = author.into();
        self
    }

    pub fn priority(mut self, priority: i32) -> Self {
        self.plugin.priority = priority;
        self
    }

    pub fn enabled(mut self, enabled: bool) -> Self {
        self.plugin.enabled = enabled;
        self
    }

    /// 追加一条规则
    pub fn rule(mut self, rule: Rule) -> Self {
        self.plugin.rules.push(rule);
        self
    }

    /// 批量追加规则
    pub fn rules(mut self, rules: Vec<Rule>) -> Self {
        self.plugin.rules.extend(rules);
        self
    }

    pub fn build(self) -> Plugin {
        self.plugin
    }
}

/// 插件注册表
///
/// 事件到达时按 `priority` 升序尝试各插件的规则，命中即执行；
/// 若规则返回 [`Handled::Stop`]（默认），则停止后续匹配。
#[derive(Default)]
pub struct PluginRegistry {
    plugins: Vec<Arc<Plugin>>,
}

impl std::fmt::Debug for PluginRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PluginRegistry")
            .field("plugins", &self.plugins.len())
            .finish()
    }
}

impl PluginRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册插件（按优先级重新排序）
    pub fn register(&mut self, plugin: Plugin) {
        self.plugins.retain(|p| p.name != plugin.name);
        self.plugins.push(Arc::new(plugin));
        self.plugins.sort_by_key(|p| p.priority);
    }

    /// 已注册的插件
    pub fn plugins(&self) -> &[Arc<Plugin>] {
        &self.plugins
    }

    /// 插件数量（含未启用的）
    pub fn len(&self) -> usize {
        self.plugins.len()
    }

    pub fn is_empty(&self) -> bool {
        self.plugins.is_empty()
    }

    /// 启用中的插件数量
    pub fn enabled_count(&self) -> usize {
        self.plugins.iter().filter(|p| p.enabled).count()
    }

    /// 规则总数
    pub fn rule_count(&self) -> usize {
        self.plugins.iter().map(|p| p.rule_count()).sum()
    }

    /// 查找插件
    pub fn get(&self, name: &str) -> Option<&Arc<Plugin>> {
        self.plugins.iter().find(|p| p.name == name)
    }

    /// 分发事件：返回是否有规则命中
    pub async fn dispatch(&self, ctx_base: DispatchBase<'_>) -> Result<bool> {
        let mut handled = false;

        for plugin in self.plugins.iter().filter(|p| p.enabled) {
            for rule in &plugin.rules {
                let Some(matched) = rule.try_match(ctx_base.event) else {
                    continue;
                };

                // 权限校验
                if !rule
                    .permission
                    .allows(ctx_base.event, ctx_base.masters)
                {                    if rule.log {
                        tracing::info!(
                            "插件 {} 规则「{}」权限不足（需要{}）：{}",
                            plugin.name,
                            rule.name,
                            rule.permission.as_str(),
                            ctx_base.event.display_name()
                        );
                    }
                    continue;
                }

                let Some(handler) = rule.handler_ref() else {
                    tracing::warn!("插件 {} 的规则「{}」未设置处理函数", plugin.name, rule.name);
                    continue;
                };

                if rule.log {
                    tracing::info!(
                        "执行插件 {} 规则「{}」：{} <= {} | {}",
                        plugin.name,
                        rule.name,
                        ctx_base.event.self_id(),
                        ctx_base.event.session_id(),
                        truncate(&matched.text, 100)
                    );
                }

                let ctx = PluginContext {
                    event: ctx_base.event.clone(),
                    matched,
                    bot: ctx_base.bot.clone(),
                    stats: ctx_base.stats.clone(),
                    masters: ctx_base.masters.clone(),
                    plugin_count: self.enabled_count(),
                };

                handled = true;
                ctx_base.stats.record_command();

                match handler(ctx).await {
                    Ok(Handled::Stop) => return Ok(true),
                    Ok(Handled::Continue) => continue,
                    Err(err) => {
                        tracing::error!("插件 {} 规则「{}」执行出错：{err:#}", plugin.name, rule.name);
                    }
                }
            }
        }

        Ok(handled)
    }
}

/// 分发所需的依赖
#[derive(Clone)]
pub struct DispatchBase<'a> {
    pub event: &'a Arc<MessageEvent>,
    pub bot: Arc<Bot>,
    pub stats: Arc<crate::stats::Stats>,
    pub masters: &'a Arc<Vec<Id>>,
}

fn truncate(input: &str, max: usize) -> String {
    if input.chars().count() <= max {
        return input.to_string();
    }
    let head: String = input.chars().take(max).collect();
    format!("{head}...")
}

/// 事件处理器 trait（预留给未来的异步插件）
pub trait EventHandler: Send + Sync {
    fn handle<'a>(&'a self, event: &'a Event) -> BoxFuture<'a, Result<()>>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::Event;
    use crate::onebot11::action::ApiCaller;
    use serde_json::json;
    use std::sync::Mutex;
    use tokio::sync::mpsc;

    fn message_event(text: &str, role: &str) -> Arc<MessageEvent> {
        let event = Event::from_value(json!({
            "time": 1, "self_id": 10001, "post_type": "message",
            "message_type": "group", "sub_type": "normal",
            "message_id": 1, "user_id": 20002, "group_id": 30003,
            "message": text,
            "sender": {"user_id": 20002, "nickname": "测试", "role": role}
        }));
        match event {
            Event::Message(msg) => Arc::new(msg),
            _ => panic!("应为消息事件"),
        }
    }

    fn test_bot() -> Arc<Bot> {
        let (tx, _rx) = mpsc::channel(16);
        let api = Arc::new(ApiCaller::new(tx, std::time::Duration::from_secs(1)));
        Arc::new(Bot::new(Id::Num(10001), api))
    }

    async fn run(registry: &PluginRegistry, event: Arc<MessageEvent>) -> bool {
        let stats = Arc::new(crate::stats::Stats::new());
        let masters: Arc<Vec<Id>> = Arc::new(Vec::new());
        registry
            .dispatch(DispatchBase {
                event: &event,
                bot: test_bot(),
                stats,
                masters: &masters,
            })
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn dispatch_matches_prefix_rule() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let calls_clone = calls.clone();

        let plugin = Plugin::builder("test")
            .desc("测试")
            .rule(Rule::prefix("#status").name("状态").on(move |ctx| {
                let calls = calls_clone.clone();
                async move {
                    calls.lock().unwrap().push(ctx.args().to_string());
                    Ok(())
                }
            }))
            .build();

        let mut registry = PluginRegistry::new();
        registry.register(plugin);

        assert!(run(&registry, message_event("#status", "member")).await);
        assert_eq!(calls.lock().unwrap().len(), 1);

        // 未命中
        assert!(!run(&registry, message_event("别的", "member")).await);
        assert_eq!(calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn priority_ordering_is_respected() {
        let order = Arc::new(Mutex::new(Vec::new()));

        let mut registry = PluginRegistry::new();
        for (name, priority) in [("low", 100), ("high", 10)] {
            let order = order.clone();
            let plugin = Plugin::builder(name)
                .priority(priority)
                .rule(Rule::prefix("#go").on(move |_ctx| {
                    let order = order.clone();
                    let name = name.to_string();
                    async move {
                        order.lock().unwrap().push(name);
                        Ok(())
                    }
                }))
                .build();
            registry.register(plugin);
        }

        run(&registry, message_event("#go", "member")).await;
        // priority 小的先执行；默认 Stop，只执行第一个
        assert_eq!(*order.lock().unwrap(), vec!["high"]);
        assert_eq!(registry.plugins()[0].name, "high");
    }

    #[tokio::test]
    async fn permission_denied_skips_rule() {
        let plugin = Plugin::builder("admin-only")
            .rule(
                Rule::prefix("#kick")
                    .permission(Permission::Owner)
                    .on(|_ctx| async move { Ok(()) }),
            )
            .build();

        let mut registry = PluginRegistry::new();
        registry.register(plugin);

        // 普通成员：不命中
        assert!(!run(&registry, message_event("#kick", "member")).await);
        // 群主：命中
        assert!(run(&registry, message_event("#kick", "owner")).await);
    }

    #[tokio::test]
    async fn error_in_handler_does_not_stop_dispatch() {
        let second_called = Arc::new(Mutex::new(false));
        let flag = second_called.clone();

        let mut registry = PluginRegistry::new();
        registry.register(
            Plugin::builder("broken")
                .priority(1)
                .rule(Rule::prefix("#x").on(|_ctx| async move {
                    Err(anyhow::anyhow!("故意失败"))
                }))
                .build(),
        );
        registry.register(
            Plugin::builder("ok")
                .priority(2)
                .rule(Rule::prefix("#x").on(move |_ctx| {
                    let flag = flag.clone();
                    async move {
                        *flag.lock().unwrap() = true;
                        Ok(())
                    }
                }))
                .build(),
        );

        run(&registry, message_event("#x", "member")).await;
        assert!(*second_called.lock().unwrap(), "前一插件出错后应继续尝试后续规则");
    }

    #[tokio::test]
    async fn continue_allows_later_rules() {
        let second_called = Arc::new(Mutex::new(false));
        let flag = second_called.clone();

        let mut registry = PluginRegistry::new();
        registry.register(
            Plugin::builder("first")
                .priority(1)
                .rule(Rule::prefix("#x").handler(|_ctx| async move { Ok(Handled::Continue) }))
                .build(),
        );
        registry.register(
            Plugin::builder("second")
                .priority(2)
                .rule(Rule::prefix("#x").on(move |_ctx| {
                    let flag = flag.clone();
                    async move {
                        *flag.lock().unwrap() = true;
                        Ok(())
                    }
                }))
                .build(),
        );

        run(&registry, message_event("#x", "member")).await;
        assert!(*second_called.lock().unwrap(), "Continue 应允许后续规则执行");
    }

    #[tokio::test]
    async fn continue_propagates_to_all_plugins() {
        let count = Arc::new(Mutex::new(0));

        let mut registry = PluginRegistry::new();
        for i in 0..3 {
            let count = count.clone();
            registry.register(
                Plugin::builder(format!("p{i}"))
                    .priority(i)
                    .rule(Rule::prefix("#all").handler(move |_ctx| {
                        let count = count.clone();
                        async move {
                            *count.lock().unwrap() += 1;
                            Ok(Handled::Continue)
                        }
                    }))
                    .build(),
            );
        }

        let handled = run(&registry, message_event("#all", "member")).await;
        assert!(handled);
        assert_eq!(*count.lock().unwrap(), 3);
    }

    #[test]
    fn registry_counters() {
        let mut registry = PluginRegistry::new();
        assert!(registry.is_empty());

        registry.register(
            Plugin::builder("a")
                .rule(Rule::prefix("#1"))
                .rule(Rule::prefix("#2"))
                .build(),
        );
        registry.register(
            Plugin::builder("b")
                .enabled(false)
                .rule(Rule::prefix("#3"))
                .build(),
        );

        assert_eq!(registry.len(), 2);
        assert_eq!(registry.enabled_count(), 1);
        assert_eq!(registry.rule_count(), 3);
        assert!(registry.get("a").is_some());
        assert!(registry.get("nope").is_none());
    }

    #[test]
    fn registering_same_name_replaces() {
        let mut registry = PluginRegistry::new();
        registry.register(Plugin::builder("dup").priority(1).build());
        registry.register(Plugin::builder("dup").priority(2).build());
        assert_eq!(registry.len(), 1);
        assert_eq!(registry.plugins()[0].priority, 2);
    }

    #[test]
    fn context_helpers() {
        let event = message_event("#echo 你好 世界", "member");
        let ctx = PluginContext {
            event: event.clone(),
            matched: Matched {
                args: "你好 世界".into(),
                text: "#echo 你好 世界".into(),
                captures: vec![],
            },
            bot: test_bot(),
            stats: Arc::new(crate::stats::Stats::new()),
            masters: Arc::new(vec![]),
            plugin_count: 1,
        };

        assert_eq!(ctx.args(), "你好 世界");
        assert_eq!(ctx.arg_list(), vec!["你好", "世界"]);
        assert!(ctx.is_group());
        assert_eq!(ctx.group_id().unwrap().as_i64(), Some(30003));
        assert_eq!(ctx.user_id().as_i64(), Some(20002));
    }
}
