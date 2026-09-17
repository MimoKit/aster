//! 内置插件。
//!
//! 目前包含「运行状态」插件：发送 `as` 查询框架当前状态。

use super::rule::{Handled, Permission, Rule, Scope};
use super::{Plugin, PluginContext};
use crate::stats::{Stats, human_bytes, human_duration};

/// 状态插件的默认命令词
pub const STATUS_COMMAND: &str = "as";

/// 构建「运行状态」插件
///
/// 命令词为 `as`（可通过参数自定义），语义同 GsCore 的 `on_command`：
/// 命令词独立成词，后接参数可选。
///
/// * `as` —— 简要状态
/// * `as 详细` —— 详细状态
/// * `as 帮助` —— 命令列表
///
/// `prefix` 为可选的强制前缀（如 `#` 或 `/`），为空表示不需要前缀。
pub fn status_plugin(prefix: impl Into<String>) -> Plugin {
    status_plugin_with(prefix, STATUS_COMMAND)
}

/// 构建「运行状态」插件（同时指定前缀与命令词）
pub fn status_plugin_with(prefix: impl Into<String>, command: impl Into<String>) -> Plugin {
    let prefix = prefix.into();
    let command = command.into();
    // 最终匹配用的完整命令词：prefix + command（prefix 为空则就是 command）
    let full_command = format!("{prefix}{command}");

    Plugin::builder("status")
        .desc("查询 Aster 运行状态")
        .author("Aster")
        .priority(100)
        .rule(
            Rule::command(full_command.clone())
                .name("运行状态")
                .permission(Permission::All)
                .scope(Scope::Any)
                .handler(move |ctx| {
                    let help_command = full_command.clone();
                    async move {
                        let args = ctx.args();
                        if args.starts_with("帮助") || args.starts_with("help") {
                            ctx.reply(help_text(&help_command)).await?;
                        } else if args.contains("详细") || args.contains("detail") {
                            ctx.reply(detailed_status(&ctx)).await?;
                        } else {
                            ctx.reply(brief_status(&ctx)).await?;
                        }
                        Ok(Handled::Stop)
                    }
                }),
        )
        .build()
}

/// 帮助文本
fn help_text(command: &str) -> String {
    format!(
        "【Aster 状态命令】\n\
         {command}        查看运行状态\n\
         {command} 详细   查看详细信息\n\
         {command} 帮助   显示本帮助"
    )
}

/// 简要状态文本
fn brief_status(ctx: &PluginContext) -> String {
    let snapshot = ctx.stats.snapshot();
    let bot_name = ctx
        .bot
        .info
        .try_lock()
        .ok()
        .and_then(|info| info.nickname.clone())
        .unwrap_or_else(|| "Aster".to_string());

    format!(
        "【Aster 运行状态】\n\
         机器人：{bot_name}（{}）\n\
         版本：v{}\n\
         运行：{}\n\
         已处理事件：{} 条\n\
         插件：{} 个",
        ctx.bot.self_id,
        snapshot.version,
        snapshot.uptime_text(),
        snapshot.events,
        ctx.plugin_count,
    )
}

/// 详细状态文本
fn detailed_status(ctx: &PluginContext) -> String {
    let snapshot = ctx.stats.snapshot();

    let (nickname, uin) = match ctx.bot.info.try_lock() {
        Ok(info) => (
            info.nickname.clone().unwrap_or_else(|| "未知".into()),
            info.user_id
                .as_ref()
                .map(ToString::to_string)
                .unwrap_or_else(|| ctx.bot.self_id.to_string()),
        ),
        Err(_) => ("获取中".into(), ctx.bot.self_id.to_string()),
    };

    let masters = if ctx.masters.is_empty() {
        "未配置".to_string()
    } else {
        ctx.masters
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(", ")
    };

    format!(
        "【Aster 详细状态】\n\
         ── 基本信息 ──\n\
         机器人：{nickname}\n\
         账号：{uin}\n\
         版本：v{}\n\
         启动：{}\n\
         运行：{}\n\
         ── 事件统计 ──\n\
         总计：{}\n\
         消息：{}（含自身发送）\n\
         通知：{}\n\
         请求：{}\n\
         元事件：{}\n\
         ── 插件 ──\n\
         已加载：{} 个\n\
         已执行：{} 次\n\
         ── 环境 ──\n\
         主人：{masters}",
        snapshot.version,
        snapshot.started_text(),
        snapshot.uptime_text(),
        snapshot.events,
        snapshot.messages,
        snapshot.notices,
        snapshot.requests,
        snapshot.meta_events,
        snapshot.plugins.max(ctx.plugin_count),
        snapshot.commands,
    )
}

/// 供外部复用的格式化工具（同时也是对 [`crate::stats`] 的再导出）
pub fn format_uptime(seconds: u64) -> String {
    human_duration(std::time::Duration::from_secs(seconds))
}

/// 供外部复用的字节格式化
pub fn format_bytes(bytes: u64) -> String {
    human_bytes(bytes)
}

/// 状态插件的统计数据（便于测试）
pub fn snapshot_of(stats: &Stats) -> crate::stats::StatsSnapshot {
    stats.snapshot()
}

/// 构建所有内置插件
///
/// `prefix` 为命令强制前缀（可为空字符串，表示不需要前缀）。
pub fn all(builtin_enabled: bool, prefix: impl Into<String>) -> Vec<Plugin> {
    if !builtin_enabled {
        return Vec::new();
    }
    vec![status_plugin(prefix)]
}

/// 把内置插件注册进注册表，返回注册数量
pub fn register_all(
    registry: &mut super::PluginRegistry,
    builtin_enabled: bool,
    prefix: impl Into<String>,
) -> usize {
    let plugins = all(builtin_enabled, prefix);
    let count = plugins.len();
    for plugin in plugins {
        registry.register(plugin);
    }
    count
}

/// 便捷：在给定统计上构造上下文（测试用）
pub fn describe(stats: &Stats) -> String {
    let snapshot = stats.snapshot();
    format!(
        "v{} 运行 {}，处理 {} 个事件",
        snapshot.version,
        snapshot.uptime_text(),
        snapshot.events
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{Event, Id};
    use crate::onebot11::action::{ApiCaller, ApiRequest, Outgoing};
    use crate::onebot11::connection::Bot;
    use crate::plugin::{DispatchBase, PluginRegistry};
    use serde_json::json;
    use std::sync::Arc;
    use tokio::sync::mpsc;

    /// 测试夹具：一个能捕获机器人回复的环境
    struct Harness {
        registry: PluginRegistry,
        bot: Arc<Bot>,
        stats: Arc<Stats>,
        masters: Arc<Vec<Id>>,
        /// 机器人写通道，用来读取它发出的 API 请求
        outbox: mpsc::Receiver<Outgoing>,
    }

    impl Harness {
        fn new(prefix: &str, masters: Vec<Id>) -> Self {
            let (tx, outbox) = mpsc::channel(32);
            let api = Arc::new(ApiCaller::new(tx, std::time::Duration::from_secs(1)));
            let bot = Arc::new(Bot::new(Id::Num(10001), api));

            let mut registry = PluginRegistry::new();
            registry.register(status_plugin(prefix));

            Self {
                registry,
                bot,
                stats: Arc::new(Stats::new()),
                masters: Arc::new(masters),
                outbox,
            }
        }

        /// 投递一条消息，返回是否被插件处理
        async fn fire(&mut self, text: &str, role: &str) -> bool {
            self.fire_in(text, role, true).await
        }

        async fn fire_in(&mut self, text: &str, role: &str, is_group: bool) -> bool {
            let value = if is_group {
                json!({
                    "time": 1, "self_id": 10001, "post_type": "message",
                    "message_type": "group", "sub_type": "normal",
                    "message_id": 1, "user_id": 20002, "group_id": 30003,
                    "message": text,
                    "sender": {"user_id": 20002, "nickname": "测试", "role": role}
                })
            } else {
                json!({
                    "time": 1, "self_id": 10001, "post_type": "message",
                    "message_type": "private", "sub_type": "friend",
                    "message_id": 1, "user_id": 20002,
                    "message": text,
                    "sender": {"user_id": 20002, "nickname": "测试"}
                })
            };

            let Event::Message(message) = Event::from_value(value) else {
                panic!("应为消息事件");
            };
            let message = Arc::new(message);
            self.stats.record_event(&Event::Message((*message).clone()));

            self.registry
                .dispatch(DispatchBase {
                    event: &message,
                    bot: self.bot.clone(),
                    stats: self.stats.clone(),
                    masters: &self.masters,
                })
                .await
                .unwrap()
        }

        /// 取出机器人发出的一条 API 请求
        async fn take_request(&mut self) -> ApiRequest {
            let outgoing = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                self.outbox.recv(),
            )
            .await
            .expect("等待回复超时")
            .expect("通道已关闭");

            match outgoing {
                Outgoing::Text(text) => serde_json::from_str(&text).expect("API 请求应为合法 JSON"),
                other => panic!("期望文本帧，实际 {other:?}"),
            }
        }

        /// 取出回复的文本内容
        async fn take_reply(&mut self) -> String {
            let request = self.take_request().await;
            request.params["message"]
                .as_str()
                .unwrap_or_default()
                .to_string()
        }
    }

    #[tokio::test]
    async fn status_command_replies_with_text() {
        let mut h = Harness::new("", vec![]);
        assert!(h.fire("as", "member").await, "as 应命中状态插件");

        let request = h.take_request().await;
        assert_eq!(request.action, "send_group_msg");
        assert_eq!(request.params["group_id"], "30003");

        let text = request.params["message"].as_str().unwrap();
        assert!(text.contains("Aster 运行状态"), "应含标题：{text}");
        assert!(text.contains("版本"), "应含版本：{text}");
        assert!(text.contains("运行"), "应含运行时长：{text}");
        assert!(text.contains("插件"), "应含插件数：{text}");
    }

    #[tokio::test]
    async fn detail_variant_has_more_info() {
        let mut h = Harness::new("", vec![]);
        assert!(h.fire("as 详细", "member").await);
        let detail = h.take_reply().await;

        assert!(detail.contains("详细状态"), "应返回详细状态：{detail}");
        assert!(detail.contains("事件统计"), "应含事件统计：{detail}");
        assert!(detail.contains("启动"), "应含启动时间：{detail}");
        assert!(detail.contains("主人"), "应含主人配置：{detail}");
    }

    #[tokio::test]
    async fn brief_is_shorter_than_detail() {
        let mut h = Harness::new("", vec![]);

        h.fire("as", "member").await;
        let brief = h.take_reply().await;

        h.fire("as 详细", "member").await;
        let detail = h.take_reply().await;

        assert_ne!(brief, detail);
        assert!(detail.len() > brief.len(), "详细模式应更长");
        assert!(brief.contains("运行状态"));
        assert!(!brief.contains("详细状态"));
    }

    #[tokio::test]
    async fn detail_english_alias() {
        let mut h = Harness::new("", vec![]);
        assert!(h.fire("as detail", "member").await);
        assert!(h.take_reply().await.contains("详细状态"));
    }

    #[tokio::test]
    async fn help_command_lists_commands() {
        let mut h = Harness::new("", vec![]);
        assert!(h.fire("as 帮助", "member").await);
        let reply = h.take_reply().await;
        assert!(reply.contains("as"), "帮助应列出命令：{reply}");
        assert!(reply.contains("详细"), "帮助应提及详细模式：{reply}");
    }

    #[tokio::test]
    async fn everyone_can_query_status() {
        for role in ["member", "admin", "owner"] {
            let mut h = Harness::new("", vec![]);
            assert!(h.fire("as", role).await, "{role} 应能查询");
            assert!(!h.take_reply().await.is_empty());
        }
    }

    #[tokio::test]
    async fn works_in_private_chat() {
        let mut h = Harness::new("", vec![]);
        assert!(h.fire_in("as", "member", false).await);

        let request = h.take_request().await;
        assert_eq!(request.action, "send_private_msg", "私聊应走私聊接口");
        assert_eq!(request.params["user_id"], "20002");
    }

    #[tokio::test]
    async fn non_matching_text_is_ignored() {
        let mut h = Harness::new("", vec![]);
        assert!(!h.fire("你好呀", "member").await);
        assert!(!h.fire("#status", "member").await);
        assert!(!h.fire("asd", "member").await, "asd 不应误触发 as 命令");
    }

    #[tokio::test]
    async fn custom_prefix_works() {
        let mut h = Harness::new("/", vec![]);
        assert!(h.fire("/as", "member").await, "自定义前缀应生效");
        assert!(h.take_reply().await.contains("Aster 运行状态"));
    }

    #[tokio::test]
    async fn command_counter_increases() {
        let mut h = Harness::new("", vec![]);
        assert_eq!(h.stats.snapshot().commands, 0);

        h.fire("as", "member").await;
        h.take_reply().await;
        assert_eq!(h.stats.snapshot().commands, 1);

        h.fire("as", "member").await;
        h.take_reply().await;
        assert_eq!(h.stats.snapshot().commands, 2);
    }

    #[tokio::test]
    async fn stats_recorded_in_reply() {
        let mut h = Harness::new("", vec![]);
        // 夹具在 fire 时已记录 1 个事件
        h.fire("as", "member").await;
        let reply = h.take_reply().await;
        assert!(
            reply.contains("已处理事件：1 条"),
            "应展示已处理事件数：{reply}"
        );
    }

    #[test]
    fn plugin_metadata() {
        let plugin = status_plugin("");
        assert_eq!(plugin.name, "status");
        // 单条命令规则覆盖 `as` / `as 详细` / `as 帮助`
        assert_eq!(plugin.rule_count(), 1);
        assert_eq!(plugin.priority, 100);
        assert!(plugin.enabled);
        assert!(!plugin.desc.is_empty());
    }

    #[test]
    fn all_respects_enable_flag() {
        assert_eq!(all(true, "").len(), 1);
        assert_eq!(all(false, "").len(), 0);
    }

    #[test]
    fn register_all_helper() {
        let mut registry = PluginRegistry::new();
        assert_eq!(register_all(&mut registry, true, ""), 1);
        assert_eq!(registry.enabled_count(), 1);
        assert!(registry.get("status").is_some());

        let mut disabled = PluginRegistry::new();
        assert_eq!(register_all(&mut disabled, false, ""), 0);
        assert!(disabled.is_empty());
    }

    #[test]
    fn stats_snapshot_helpers() {
        let stats = Stats::new();
        stats.record_command();
        assert_eq!(snapshot_of(&stats).commands, 1);
        assert!(describe(&stats).contains("个事件"));
    }

    #[test]
    fn formatting_helpers() {
        assert_eq!(format_uptime(90), "1分30秒");
        assert_eq!(format_uptime(0), "0秒");
        assert_eq!(format_bytes(2048), "2.0 KB");
        assert_eq!(format_bytes(512), "512 B");
    }
}
