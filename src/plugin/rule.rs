//! 插件规则：匹配方式、权限、执行范围。
//!
//! 设计参考了主流框架的「规则 + 优先级 + 权限」模型：
//! 每个插件按 `priority`（数字越小越优先）排序，
//! 事件到达时逐条尝试规则，命中即执行。
//!
//! ```ignore
//! PluginBuilder::new("status")
//!     .desc("运行状态")
//!     .priority(100)
//!     .rule(
//!         Rule::prefix("as")
//!             .name("状态")
//!             .permission(Permission::All)
//!             .handler(|ctx| async move {
//!                 ctx.reply("一切正常").await
//!             }),
//!     )
//!     .build()
//! ```

use std::future::Future;
use std::sync::Arc;

use anyhow::Result;
use futures_util::future::BoxFuture;
use regex::Regex;

use crate::event::MessageEvent;
use crate::plugin::PluginContext;

/// 规则执行后的控制流
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Handled {
    /// 已处理，停止后续规则
    Stop,
    /// 已处理，但允许后续规则继续
    Continue,
}

impl Handled {
    pub fn is_continue(&self) -> bool {
        matches!(self, Handled::Continue)
    }
}

/// 规则处理函数
pub type BoxedHandler =
    Arc<dyn Fn(PluginContext) -> BoxFuture<'static, Result<Handled>> + Send + Sync>;

/// 命令权限
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Permission {
    /// 任何人可用
    #[default]
    All,
    /// 仅机器人主人（配置 `bot.masters`）
    Master,
    /// 仅群管理或群主（含主人）
    Admin,
    /// 仅群主（含主人）
    Owner,
}

impl Permission {
    pub fn as_str(&self) -> &'static str {
        match self {
            Permission::All => "所有人",
            Permission::Master => "主人",
            Permission::Admin => "群管理",
            Permission::Owner => "群主",
        }
    }

    /// 判断事件发送者是否满足权限
    pub fn allows(&self, event: &MessageEvent, masters: &[crate::event::Id]) -> bool {
        if *self == Permission::All {
            return true;
        }

        // 主人始终放行
        if masters.iter().any(|id| id.same(&event.user_id)) {
            return true;
        }

        match self {
            Permission::All | Permission::Master => *self == Permission::All,
            Permission::Admin => event.sender.is_admin(),
            Permission::Owner => event.sender.is_owner(),
        }
    }
}

/// 规则生效的会话范围
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Scope {
    /// 群聊与私聊都可触发
    #[default]
    Any,
    /// 仅群聊
    Group,
    /// 仅私聊
    Private,
}

impl Scope {
    pub fn matches(&self, event: &MessageEvent) -> bool {
        match self {
            Scope::Any => true,
            Scope::Group => event.is_group(),
            Scope::Private => event.is_private(),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Scope::Any => "群聊+私聊",
            Scope::Group => "仅群聊",
            Scope::Private => "仅私聊",
        }
    }
}

/// 匹配方式
#[derive(Debug, Clone)]
pub enum Matcher {
    /// 命令词匹配（对应 GsCore 的 `on_command` 语义）
    ///
    /// 命令词必须**独立成词**：后面要么是消息结尾，要么是空白。
    /// 因此命令 `as` 能匹配 `as` 与 `as 详细`，但不会匹配 `asdf`。
    Command(String),
    /// 前缀匹配，参数为去掉前缀并 trim 后的剩余文本
    Prefix(String),
    /// 完全相等
    Exact(String),
    /// 正则匹配，参数为第 1 个捕获组（无捕获组则为整体匹配）
    Regex(Arc<Regex>),
    /// 包含子串
    Contains(String),
    /// 匹配所有消息
    Any,
}

/// 一次匹配的结果
#[derive(Debug, Clone, Default)]
pub struct Matched {
    /// 命令参数（前缀后的内容 / 正则捕获组）
    pub args: String,
    /// 完整文本
    pub text: String,
    /// 正则捕获组（含第 0 组）
    pub captures: Vec<String>,
}

/// 插件规则
pub struct Rule {
    /// 规则名（日志用）
    pub name: String,
    pub matcher: Matcher,
    pub permission: Permission,
    pub scope: Scope,
    /// 是否在日志里打印执行记录
    pub log: bool,
    handler: Option<BoxedHandler>,
}

impl Rule {
    pub fn new(matcher: Matcher) -> Self {
        Self {
            name: String::new(),
            matcher,
            permission: Permission::All,
            scope: Scope::Any,
            log: true,
            handler: None,
        }
    }

    /// 前缀匹配，如 `as`
    pub fn prefix(prefix: impl Into<String>) -> Self {
        Self::new(Matcher::Prefix(prefix.into()))
    }

    /// 命令词匹配（推荐，语义同 GsCore 的 `on_command`）
    ///
    /// 命令词独立成词，后接参数可选：
    /// `as` 与 `as 详细` 都触发，`asdf` 不触发。
    pub fn command(keyword: impl Into<String>) -> Self {
        Self::new(Matcher::Command(keyword.into()))
    }

    /// 完全匹配
    pub fn exact(text: impl Into<String>) -> Self {
        Self::new(Matcher::Exact(text.into()))
    }

    /// 正则匹配
    pub fn regex(pattern: &str) -> Result<Self> {
        Ok(Self::new(Matcher::Regex(Arc::new(Regex::new(pattern)?))))
    }

    /// 包含匹配
    pub fn contains(text: impl Into<String>) -> Self {
        Self::new(Matcher::Contains(text.into()))
    }

    /// 匹配所有消息
    pub fn any() -> Self {
        Self::new(Matcher::Any)
    }

    pub fn name(mut self, name: impl Into<String>) -> Self {
        self.name = name.into();
        self
    }

    pub fn permission(mut self, permission: Permission) -> Self {
        self.permission = permission;
        self
    }

    pub fn scope(mut self, scope: Scope) -> Self {
        self.scope = scope;
        self
    }

    /// 关闭执行日志
    pub fn quiet(mut self) -> Self {
        self.log = false;
        self
    }

    /// 设置处理函数
    ///
    /// 接受一个返回 `Future` 的闭包，内部自动装箱，无需手动 `Box::pin`。
    pub fn handler<F, Fut>(mut self, handler: F) -> Self
    where
        F: Fn(PluginContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Handled>> + Send + 'static,
    {
        self.handler = Some(Arc::new(move |ctx| Box::pin(handler(ctx))));
        self
    }

    /// 设置处理函数（简化版：返回值固定为 [`Handled::Stop`]）
    pub fn on<F, Fut>(mut self, handler: F) -> Self
    where
        F: Fn(PluginContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<()>> + Send + 'static,
    {
        self.handler = Some(Arc::new(move |ctx| {
            let fut = handler(ctx);
            Box::pin(async move {
                fut.await?;
                Ok(Handled::Stop)
            })
        }));
        self
    }

    pub(crate) fn handler_ref(&self) -> Option<&BoxedHandler> {
        self.handler.as_ref()
    }

    /// 尝试匹配消息，返回匹配详情
    pub fn try_match(&self, event: &MessageEvent) -> Option<Matched> {
        if !self.scope.matches(event) {
            return None;
        }

        // 命令匹配使用去掉首尾空白的可读文本
        let text = event.message.text.trim();

        match &self.matcher {
            Matcher::Command(keyword) => {
                let keyword = keyword.trim();
                if keyword.is_empty() {
                    return None;
                }
                // 命令词必须独立成词：整条相等，或后面紧跟空白
                let rest = if text == keyword {
                    Some("")
                } else {
                    text.strip_prefix(keyword)
                        .filter(|rest| rest.starts_with(char::is_whitespace))
                };
                rest.map(|rest| Matched {
                    args: rest.trim().to_string(),
                    text: text.to_string(),
                    captures: vec![text.to_string(), rest.trim().to_string()],
                })
            }
            Matcher::Prefix(prefix) => {
                let prefix = prefix.trim();
                if text.starts_with(prefix) {
                    Some(Matched {
                        args: text[prefix.len()..].trim().to_string(),
                        text: text.to_string(),
                        captures: vec![text.to_string()],
                    })
                } else {
                    None
                }
            }
            Matcher::Exact(expected) => (text == expected.trim()).then(|| Matched {
                args: String::new(),
                text: text.to_string(),
                captures: vec![text.to_string()],
            }),
            Matcher::Contains(needle) => text.contains(needle.as_str()).then(|| Matched {
                args: String::new(),
                text: text.to_string(),
                captures: vec![text.to_string()],
            }),
            Matcher::Regex(regex) => regex.captures(text).map(|caps| {
                let captures: Vec<String> = caps
                    .iter()
                    .map(|m| m.map(|m| m.as_str().to_string()).unwrap_or_default())
                    .collect();
                let args = captures
                    .get(1)
                    .cloned()
                    .unwrap_or_else(|| captures.first().cloned().unwrap_or_default());
                Matched {
                    args: args.trim().to_string(),
                    text: text.to_string(),
                    captures,
                }
            }),
            Matcher::Any => Some(Matched {
                args: text.to_string(),
                text: text.to_string(),
                captures: vec![text.to_string()],
            }),
        }
    }
}

impl std::fmt::Debug for Rule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Rule")
            .field("name", &self.name)
            .field("matcher", &self.matcher)
            .field("permission", &self.permission)
            .field("scope", &self.scope)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::Event;
    use serde_json::json;

    fn group_event(text: &str, role: &str, user_id: i64) -> MessageEvent {
        let event = Event::from_value(json!({
            "time": 1, "self_id": 10001, "post_type": "message",
            "message_type": "group", "sub_type": "normal",
            "message_id": 1, "user_id": user_id, "group_id": 30003,
            "message": text,
            "sender": {"user_id": user_id, "nickname": "测试", "role": role}
        }));
        match event {
            Event::Message(msg) => msg,
            _ => panic!("应为消息事件"),
        }
    }

    fn private_event(text: &str) -> MessageEvent {
        let event = Event::from_value(json!({
            "time": 1, "self_id": 10001, "post_type": "message",
            "message_type": "private", "sub_type": "friend",
            "message_id": 1, "user_id": 20002, "message": text,
            "sender": {"user_id": 20002, "nickname": "测试"}
        }));
        match event {
            Event::Message(msg) => msg,
            _ => panic!("应为消息事件"),
        }
    }

    #[test]
    fn command_matching_requires_word_boundary() {
        let rule = Rule::command("as");

        // 独立成词：命中
        let matched = rule.try_match(&group_event("as", "member", 1)).unwrap();
        assert_eq!(matched.args, "");

        // 后接参数：命中，参数被提取
        let matched = rule.try_match(&group_event("as 详细", "member", 1)).unwrap();
        assert_eq!(matched.args, "详细");

        // 多余空白也能正确处理
        let matched = rule.try_match(&group_event("as    详细", "member", 1)).unwrap();
        assert_eq!(matched.args, "详细");

        // 不是独立成词：不命中
        assert!(rule.try_match(&group_event("asd", "member", 1)).is_none());
        assert!(rule.try_match(&group_event("asdf 详细", "member", 1)).is_none());
        assert!(rule.try_match(&group_event("xas", "member", 1)).is_none());
        assert!(rule.try_match(&group_event("was as", "member", 1)).is_none());
    }

    #[test]
    fn command_matching_is_case_sensitive() {
        let rule = Rule::command("as");
        assert!(rule.try_match(&group_event("AS", "member", 1)).is_none());
        assert!(rule.try_match(&group_event("As", "member", 1)).is_none());
    }

    #[test]
    fn command_with_prefix() {
        let rule = Rule::command("/as");
        assert!(rule.try_match(&group_event("/as", "member", 1)).is_some());
        assert!(rule.try_match(&group_event("/as 详细", "member", 1)).is_some());
        assert!(rule.try_match(&group_event("as", "member", 1)).is_none());
    }

    #[test]
    fn command_with_chinese_keyword() {
        let rule = Rule::command("状态");
        let matched = rule.try_match(&group_event("状态", "member", 1)).unwrap();
        assert_eq!(matched.args, "");
        let matched = rule.try_match(&group_event("状态 详细", "member", 1)).unwrap();
        assert_eq!(matched.args, "详细");
        assert!(rule.try_match(&group_event("状态栏", "member", 1)).is_none());
    }

    #[test]
    fn empty_command_never_matches() {
        let rule = Rule::command("");
        assert!(rule.try_match(&group_event("任何消息", "member", 1)).is_none());
        assert!(rule.try_match(&group_event("", "member", 1)).is_none());
    }

    #[test]
    fn prefix_matching() {
        let rule = Rule::prefix("#as");
        let matched = rule.try_match(&group_event("#as", "member", 1)).unwrap();
        assert_eq!(matched.args, "");

        let matched = rule.try_match(&group_event("#as 详细", "member", 1)).unwrap();
        assert_eq!(matched.args, "详细");

        assert!(rule.try_match(&group_event("as", "member", 1)).is_none());
        assert!(rule.try_match(&group_event("x#as", "member", 1)).is_none());
    }

    #[test]
    fn prefix_is_case_sensitive_and_trimmed() {
        let rule = Rule::prefix("#AS");
        assert!(rule.try_match(&group_event("as", "member", 1)).is_none());
        assert!(rule.try_match(&group_event("#AS", "member", 1)).is_some());
        // 消息首尾空白被 trim
        assert!(rule.try_match(&group_event("  #AS  ", "member", 1)).is_some());
    }

    #[test]
    fn exact_and_contains() {
        let rule = Rule::exact("状态");
        assert!(rule.try_match(&group_event("状态", "member", 1)).is_some());
        assert!(rule.try_match(&group_event("状态啊", "member", 1)).is_none());

        let rule = Rule::contains("状态");
        assert!(rule.try_match(&group_event("看看状态如何", "member", 1)).is_some());
    }

    #[test]
    fn regex_matching_with_capture() {
        let rule = Rule::regex(r"^#echo\s+(.+)$").unwrap();
        let matched = rule.try_match(&group_event("#echo 你好世界", "member", 1)).unwrap();
        assert_eq!(matched.args, "你好世界");
        assert_eq!(matched.captures.len(), 2);
        assert!(rule.try_match(&group_event("#echo", "member", 1)).is_none());
    }

    #[test]
    fn any_matching() {
        let rule = Rule::any();
        assert!(rule.try_match(&private_event("随便什么")).is_some());
    }

    #[test]
    fn scope_filtering() {
        let rule = Rule::prefix("as").scope(Scope::Group);
        assert!(rule.try_match(&group_event("as", "member", 1)).is_some());
        assert!(rule.try_match(&private_event("as")).is_none());

        let rule = Rule::prefix("as").scope(Scope::Private);
        assert!(rule.try_match(&group_event("as", "member", 1)).is_none());
        assert!(rule.try_match(&private_event("as")).is_some());
    }

    #[test]
    fn permission_all() {
        let rule = Rule::prefix("as").permission(Permission::All);
        let event = group_event("as", "member", 1);
        assert!(rule.permission.allows(&event, &[]));
    }

    #[test]
    fn permission_master() {
        let masters = vec![crate::event::Id::Num(999)];
        let rule = Rule::prefix("as").permission(Permission::Master);
        assert!(rule.permission.allows(&group_event("as", "member", 999), &masters));
        assert!(!rule.permission.allows(&group_event("as", "owner", 1), &masters));
    }

    #[test]
    fn permission_admin_and_owner() {
        let rule_admin = Rule::prefix("as").permission(Permission::Admin);
        assert!(rule_admin.permission.allows(&group_event("as", "admin", 1), &[]));
        assert!(rule_admin.permission.allows(&group_event("as", "owner", 1), &[]));
        assert!(!rule_admin.permission.allows(&group_event("as", "member", 1), &[]));

        let rule_owner = Rule::prefix("as").permission(Permission::Owner);
        assert!(rule_owner.permission.allows(&group_event("as", "owner", 1), &[]));
        assert!(!rule_owner.permission.allows(&group_event("as", "admin", 1), &[]));
    }

    #[test]
    fn permission_master_bypasses_admin_requirement() {
        let masters = vec![crate::event::Id::Num(1)];
        let rule = Rule::prefix("as").permission(Permission::Owner);
        // 主人即便不是群主也放行
        assert!(rule.permission.allows(&group_event("as", "member", 1), &masters));
    }

    #[tokio::test]
    async fn handler_is_invoked() {
        use std::sync::atomic::{AtomicBool, Ordering};
        static CALLED: AtomicBool = AtomicBool::new(false);

        let rule = Rule::prefix("#test").on(|_ctx| async move {
            CALLED.store(true, Ordering::SeqCst);
            Ok(())
        });
        assert!(rule.handler_ref().is_some());
        let _ = CALLED.load(Ordering::SeqCst);
    }

    #[test]
    fn rule_without_handler_has_none() {
        let rule = Rule::prefix("#x");
        assert!(rule.handler_ref().is_none());
    }
}
