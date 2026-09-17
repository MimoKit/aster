//! OneBot v11 事件规范化。
//!
//! OneBot v11 采用「`post_type` 一级分派 + 各自 `*_type` 二级分派」的结构：
//!
//! ```text
//! post_type = message  → message_type = private | group
//! post_type = notice   → notice_type  = group_recall | group_increase | notify | ...
//! post_type = request  → request_type = friend | group
//! post_type = meta_event → meta_event_type = lifecycle | heartbeat
//! ```
//!
//! 本模块把这些松散字段收敛成强类型枚举 [`Event`]，
//! 同时用 [`Event::raw`] 保留完整的原始 JSON，任何未识别的字段都不会丢。
//!
//! ## 归一化约定
//!
//! * **ID 字段**：规范里是整数，但部分协议端下发字符串。
//!   统一用 [`Id`] 承载，数字字符串会被归一为 [`Id::Num`]，保证 `Id` 相等性可靠。
//! * **`raw_message`**：协议端缺失时由消息段反推，保证字段一定存在。
//! * **未知类型**：一律落到各自的 `Unknown` 变体，不静默丢弃。
//! * **`message_sent`**：单独建模为 [`Event::MessageSent`]（机器人自己发出的消息）。

pub mod common;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::message::{MessageContent, normalize_message};

pub use common::{Anonymous, FileInfo, Id, Sender};

/// 事件基类字段（所有 OneBot v11 事件共有）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventBase {
    /// 事件发生时间（Unix 秒）
    pub time: i64,
    /// 收到事件的机器人账号
    pub self_id: Id,
    /// 原始 JSON
    #[serde(skip)]
    pub raw: Value,
}

/// 消息事件
#[derive(Debug, Clone, PartialEq)]
pub struct MessageEvent {
    pub base: EventBase,
    /// `private` | `group`
    pub message_type: MessageType,
    /// `friend` | `group` | `normal` | `anonymous` | `group_self` | ...
    pub sub_type: String,
    pub message_id: Id,
    pub user_id: Id,
    /// 私聊时为 `None`
    pub group_id: Option<Id>,
    /// 规范化后的消息内容（段 + CQ 码 + 可读文本）
    pub message: MessageContent,
    /// OneBot v11 的 `raw_message`
    pub raw_message: String,
    pub font: Option<i64>,
    pub sender: Sender,
    /// 匿名消息信息（`sub_type == "anonymous"`）
    pub anonymous: Option<Anonymous>,
    /// 群名（部分协议端会在消息事件里附带）
    pub group_name: Option<String>,
}

/// 消息类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageType {
    Private,
    Group,
    Unknown,
}

impl MessageType {
    pub fn parse(s: &str) -> Self {
        match s {
            "private" => MessageType::Private,
            "group" | "guild" => MessageType::Group,
            _ => MessageType::Unknown,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            MessageType::Private => "private",
            MessageType::Group => "group",
            MessageType::Unknown => "unknown",
        }
    }

    pub fn is_group(&self) -> bool {
        matches!(self, MessageType::Group)
    }

    pub fn is_private(&self) -> bool {
        matches!(self, MessageType::Private)
    }
}

impl MessageEvent {
    /// 事件时间（Unix 秒）
    pub fn time(&self) -> i64 {
        self.base.time
    }

    /// 收到的机器人账号
    pub fn self_id(&self) -> &Id {
        &self.base.self_id
    }

    /// 发送者账号
    pub fn user_id(&self) -> &Id {
        &self.user_id
    }

    /// 群号（私聊为 `None`）
    pub fn group_id(&self) -> Option<&Id> {
        self.group_id.as_ref()
    }

    pub fn is_group(&self) -> bool {
        self.message_type.is_group()
    }

    pub fn is_private(&self) -> bool {
        self.message_type.is_private()
    }

    /// 是否 @ 了机器人自己
    pub fn is_at_self(&self) -> bool {
        self.message.contains_at(self.base.self_id.as_str().as_ref())
    }

    /// 引用回复的消息 id
    pub fn reply_id(&self) -> Option<&str> {
        self.message.reply_id()
    }

    /// 可读纯文本
    pub fn text(&self) -> &str {
        &self.message.text
    }

    /// 会话标识：群聊为群号，私聊为用户号
    ///
    /// 用于日志与命令冷却的 key。
    pub fn session_id(&self) -> String {
        match self.group_id() {
            Some(g) => g.to_string(),
            None => self.user_id.to_string(),
        }
    }

    /// 展示名：优先群名片，其次昵称，最后账号
    pub fn display_name(&self) -> String {
        self.sender
            .card
            .clone()
            .filter(|s| !s.is_empty())
            .or_else(|| self.sender.nickname.clone())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| self.user_id.to_string())
    }
}

/// 群文件信息（`group_upload` 通知 / `file` 段）
impl MessageEvent {
    /// 消息中是否包含图片
    pub fn has_image(&self) -> bool {
        self.message.contains_image()
    }
}

/// 通知事件
#[derive(Debug, Clone, PartialEq)]
pub enum NoticeEvent {
    /// 好友消息撤回
    FriendRecall {
        base: EventBase,
        user_id: Id,
        message_id: Id,
    },
    /// 群消息撤回
    GroupRecall {
        base: EventBase,
        group_id: Id,
        user_id: Id,
        operator_id: Id,
        message_id: Id,
    },
    /// 群成员增加
    GroupIncrease {
        base: EventBase,
        group_id: Id,
        user_id: Id,
        operator_id: Option<Id>,
        sub_type: String,
    },
    /// 群成员减少
    GroupDecrease {
        base: EventBase,
        group_id: Id,
        user_id: Id,
        operator_id: Option<Id>,
        sub_type: String,
    },
    /// 群管理员变动
    GroupAdmin {
        base: EventBase,
        group_id: Id,
        user_id: Id,
        sub_type: String,
    },
    /// 群禁言
    GroupBan {
        base: EventBase,
        group_id: Id,
        user_id: Id,
        operator_id: Option<Id>,
        duration: i64,
        sub_type: String,
    },
    /// 群名片变更
    GroupCard {
        base: EventBase,
        group_id: Id,
        user_id: Id,
        card_new: String,
        card_old: String,
    },
    /// 群文件上传
    GroupUpload {
        base: EventBase,
        group_id: Id,
        user_id: Id,
        file: FileInfo,
    },
    /// 群消息表情回应
    GroupMsgEmojiLike {
        base: EventBase,
        group_id: Id,
        user_id: Id,
        message_id: Id,
        likes: Vec<EmojiLike>,
    },
    /// 好友添加
    FriendAdd { base: EventBase, user_id: Id },
    /// 群精华消息变动
    Essence {
        base: EventBase,
        group_id: Id,
        message_id: Id,
        operator_id: Id,
        sender_id: Id,
        sub_type: String,
    },
    /// `notify` 系列
    Notify(NotifyEvent),
    /// 机器人下线
    BotOffline {
        base: EventBase,
        tag: Option<String>,
        message: Option<String>,
    },
    /// 未识别的通知
    Unknown {
        base: EventBase,
        notice_type: String,
        sub_type: Option<String>,
    },
}

/// `notice_type == "notify"` 时的细分事件
#[derive(Debug, Clone, PartialEq)]
pub enum NotifyEvent {
    /// 戳一戳
    Poke {
        base: EventBase,
        group_id: Option<Id>,
        user_id: Id,
        target_id: Id,
    },
    /// 戳一戳撤回
    PokeRecall {
        base: EventBase,
        group_id: Option<Id>,
        user_id: Id,
        target_id: Id,
    },
    /// 群荣誉变更
    Honor {
        base: EventBase,
        group_id: Id,
        user_id: Id,
        honor_type: String,
    },
    /// 群头衔变更
    Title {
        base: EventBase,
        group_id: Id,
        user_id: Id,
        title: String,
    },
    /// 群名变更
    GroupName {
        base: EventBase,
        group_id: Id,
        user_id: Id,
        name_new: String,
    },
    /// 输入状态（部分协议端扩展）
    InputStatus {
        base: EventBase,
        user_id: Id,
        group_id: Option<Id>,
        status_text: Option<String>,
    },
    /// 资料卡点赞
    ProfileLike {
        base: EventBase,
        operator_id: Id,
        times: i64,
    },
    /// 未识别的 notify
    Unknown {
        base: EventBase,
        sub_type: String,
    },
}

impl NoticeEvent {
    pub fn base(&self) -> &EventBase {
        match self {
            NoticeEvent::FriendRecall { base, .. }
            | NoticeEvent::GroupRecall { base, .. }
            | NoticeEvent::GroupIncrease { base, .. }
            | NoticeEvent::GroupDecrease { base, .. }
            | NoticeEvent::GroupAdmin { base, .. }
            | NoticeEvent::GroupBan { base, .. }
            | NoticeEvent::GroupCard { base, .. }
            | NoticeEvent::GroupUpload { base, .. }
            | NoticeEvent::GroupMsgEmojiLike { base, .. }
            | NoticeEvent::FriendAdd { base, .. }
            | NoticeEvent::Essence { base, .. }
            | NoticeEvent::BotOffline { base, .. }
            | NoticeEvent::Unknown { base, .. } => base,
            NoticeEvent::Notify(n) => n.base(),
        }
    }

    /// 通知类型字符串（与 OneBot v11 对齐）
    pub fn notice_type(&self) -> &str {
        match self {
            NoticeEvent::FriendRecall { .. } => "friend_recall",
            NoticeEvent::GroupRecall { .. } => "group_recall",
            NoticeEvent::GroupIncrease { .. } => "group_increase",
            NoticeEvent::GroupDecrease { .. } => "group_decrease",
            NoticeEvent::GroupAdmin { .. } => "group_admin",
            NoticeEvent::GroupBan { .. } => "group_ban",
            NoticeEvent::GroupCard { .. } => "group_card",
            NoticeEvent::GroupUpload { .. } => "group_upload",
            NoticeEvent::GroupMsgEmojiLike { .. } => "group_msg_emoji_like",
            NoticeEvent::FriendAdd { .. } => "friend_add",
            NoticeEvent::Essence { .. } => "essence",
            NoticeEvent::BotOffline { .. } => "bot_offline",
            NoticeEvent::Notify(_) => "notify",
            NoticeEvent::Unknown { notice_type, .. } => notice_type,
        }
    }

    /// sub_type（无则为 `None`）
    pub fn sub_type(&self) -> Option<&str> {
        match self {
            NoticeEvent::GroupIncrease { sub_type, .. }
            | NoticeEvent::GroupDecrease { sub_type, .. }
            | NoticeEvent::GroupAdmin { sub_type, .. }
            | NoticeEvent::GroupBan { sub_type, .. }
            | NoticeEvent::Essence { sub_type, .. } => Some(sub_type),
            NoticeEvent::Notify(n) => n.sub_type(),
            NoticeEvent::Unknown { sub_type, .. } => sub_type.as_deref(),
            _ => None,
        }
    }

    /// 涉及的群号
    pub fn group_id(&self) -> Option<&Id> {
        match self {
            NoticeEvent::GroupRecall { group_id, .. }
            | NoticeEvent::GroupIncrease { group_id, .. }
            | NoticeEvent::GroupDecrease { group_id, .. }
            | NoticeEvent::GroupAdmin { group_id, .. }
            | NoticeEvent::GroupBan { group_id, .. }
            | NoticeEvent::GroupCard { group_id, .. }
            | NoticeEvent::GroupUpload { group_id, .. }
            | NoticeEvent::GroupMsgEmojiLike { group_id, .. }
            | NoticeEvent::Essence { group_id, .. } => Some(group_id),
            NoticeEvent::Notify(n) => n.group_id(),
            _ => None,
        }
    }

    /// 涉及的用户号
    pub fn user_id(&self) -> Option<&Id> {
        match self {
            NoticeEvent::FriendRecall { user_id, .. }
            | NoticeEvent::GroupRecall { user_id, .. }
            | NoticeEvent::GroupIncrease { user_id, .. }
            | NoticeEvent::GroupDecrease { user_id, .. }
            | NoticeEvent::GroupAdmin { user_id, .. }
            | NoticeEvent::GroupBan { user_id, .. }
            | NoticeEvent::GroupCard { user_id, .. }
            | NoticeEvent::GroupUpload { user_id, .. }
            | NoticeEvent::GroupMsgEmojiLike { user_id, .. }
            | NoticeEvent::FriendAdd { user_id, .. } => Some(user_id),
            NoticeEvent::Notify(n) => n.user_id(),
            _ => None,
        }
    }
}

impl NotifyEvent {
    pub fn base(&self) -> &EventBase {
        match self {
            NotifyEvent::Poke { base, .. }
            | NotifyEvent::PokeRecall { base, .. }
            | NotifyEvent::Honor { base, .. }
            | NotifyEvent::Title { base, .. }
            | NotifyEvent::GroupName { base, .. }
            | NotifyEvent::InputStatus { base, .. }
            | NotifyEvent::ProfileLike { base, .. }
            | NotifyEvent::Unknown { base, .. } => base,
        }
    }

    pub fn sub_type(&self) -> Option<&str> {
        Some(match self {
            NotifyEvent::Poke { .. } => "poke",
            NotifyEvent::PokeRecall { .. } => "poke_recall",
            NotifyEvent::Honor { .. } => "honor",
            NotifyEvent::Title { .. } => "title",
            NotifyEvent::GroupName { .. } => "group_name",
            NotifyEvent::InputStatus { .. } => "input_status",
            NotifyEvent::ProfileLike { .. } => "profile_like",
            NotifyEvent::Unknown { .. } => return None,
        })
    }

    pub fn group_id(&self) -> Option<&Id> {
        match self {
            NotifyEvent::Poke { group_id, .. }
            | NotifyEvent::PokeRecall { group_id, .. }
            | NotifyEvent::InputStatus { group_id, .. } => group_id.as_ref(),
            NotifyEvent::Honor { group_id, .. }
            | NotifyEvent::Title { group_id, .. }
            | NotifyEvent::GroupName { group_id, .. } => Some(group_id),
            _ => None,
        }
    }

    pub fn user_id(&self) -> Option<&Id> {
        match self {
            NotifyEvent::Poke { user_id, .. }
            | NotifyEvent::PokeRecall { user_id, .. }
            | NotifyEvent::Honor { user_id, .. }
            | NotifyEvent::Title { user_id, .. }
            | NotifyEvent::GroupName { user_id, .. }
            | NotifyEvent::InputStatus { user_id, .. } => Some(user_id),
            NotifyEvent::ProfileLike { operator_id, .. } => Some(operator_id),
            _ => None,
        }
    }
}

/// 表情回应项
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EmojiLike {
    pub emoji_id: String,
    #[serde(default)]
    pub count: i64,
}

/// 请求事件
#[derive(Debug, Clone, PartialEq)]
pub enum RequestEvent {
    /// 加好友请求
    Friend {
        base: EventBase,
        user_id: Id,
        comment: String,
        flag: String,
    },
    /// 加群 / 邀请入群请求
    Group {
        base: EventBase,
        group_id: Id,
        user_id: Id,
        comment: String,
        flag: String,
        sub_type: String,
    },
    /// 未识别的请求
    Unknown {
        base: EventBase,
        request_type: String,
    },
}

impl RequestEvent {
    pub fn base(&self) -> &EventBase {
        match self {
            RequestEvent::Friend { base, .. }
            | RequestEvent::Group { base, .. }
            | RequestEvent::Unknown { base, .. } => base,
        }
    }

    pub fn request_type(&self) -> &str {
        match self {
            RequestEvent::Friend { .. } => "friend",
            RequestEvent::Group { .. } => "group",
            RequestEvent::Unknown { request_type, .. } => request_type,
        }
    }

    /// 请求的 flag（用于 `set_friend_add_request` / `set_group_add_request`）
    pub fn flag(&self) -> Option<&str> {
        match self {
            RequestEvent::Friend { flag, .. } | RequestEvent::Group { flag, .. } => Some(flag),
            RequestEvent::Unknown { .. } => None,
        }
    }

    pub fn sub_type(&self) -> Option<&str> {
        match self {
            RequestEvent::Friend { .. } => Some("add"),
            RequestEvent::Group { sub_type, .. } => Some(sub_type),
            RequestEvent::Unknown { .. } => None,
        }
    }
}

/// 元事件
#[derive(Debug, Clone, PartialEq)]
pub enum MetaEvent {
    /// 生命周期（连接建立 / 断开）
    Lifecycle { base: EventBase, sub_type: String },
    /// 心跳
    Heartbeat {
        base: EventBase,
        /// 心跳间隔（毫秒）
        interval: Option<i64>,
        status: Value,
    },
    /// 未识别的元事件
    Unknown {
        base: EventBase,
        meta_event_type: String,
    },
}

impl MetaEvent {
    pub fn base(&self) -> &EventBase {
        match self {
            MetaEvent::Lifecycle { base, .. }
            | MetaEvent::Heartbeat { base, .. }
            | MetaEvent::Unknown { base, .. } => base,
        }
    }

    pub fn meta_event_type(&self) -> &str {
        match self {
            MetaEvent::Lifecycle { .. } => "lifecycle",
            MetaEvent::Heartbeat { .. } => "heartbeat",
            MetaEvent::Unknown {
                meta_event_type, ..
            } => meta_event_type,
        }
    }

    pub fn sub_type(&self) -> Option<&str> {
        match self {
            MetaEvent::Lifecycle { sub_type, .. } => Some(sub_type),
            _ => None,
        }
    }

    /// 连接是否正常建立（`lifecycle` + `connect`）
    pub fn is_connect(&self) -> bool {
        matches!(self, MetaEvent::Lifecycle { sub_type, .. } if sub_type == "connect")
    }

    pub fn is_heartbeat(&self) -> bool {
        matches!(self, MetaEvent::Heartbeat { .. })
    }
}

/// 规范化后的 OneBot v11 事件
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// `post_type == "message"`
    Message(MessageEvent),
    /// `post_type == "message_sent"`（机器人自身发出的消息）
    MessageSent(MessageEvent),
    /// `post_type == "notice"`
    Notice(NoticeEvent),
    /// `post_type == "request"`
    Request(RequestEvent),
    /// `post_type == "meta_event"`
    Meta(MetaEvent),
    /// 未识别的事件
    Unknown { post_type: String, raw: Value },
}

impl Event {
    /// 事件时间
    pub fn time(&self) -> i64 {
        match self {
            Event::Message(e) | Event::MessageSent(e) => e.base.time,
            Event::Notice(e) => e.base().time,
            Event::Request(e) => e.base().time,
            Event::Meta(e) => e.base().time,
            Event::Unknown { .. } => 0,
        }
    }

    /// 机器人账号
    pub fn self_id(&self) -> Option<&Id> {
        Some(match self {
            Event::Message(e) | Event::MessageSent(e) => &e.base.self_id,
            Event::Notice(e) => &e.base().self_id,
            Event::Request(e) => &e.base().self_id,
            Event::Meta(e) => &e.base().self_id,
            Event::Unknown { .. } => return None,
        })
    }

    /// 原始 JSON
    pub fn raw(&self) -> Cow<'_, Value> {
        match self {
            Event::Message(e) | Event::MessageSent(e) => Cow::Borrowed(&e.base.raw),
            Event::Notice(e) => Cow::Borrowed(&e.base().raw),
            Event::Request(e) => Cow::Borrowed(&e.base().raw),
            Event::Meta(e) => Cow::Borrowed(&e.base().raw),
            Event::Unknown { raw, .. } => Cow::Borrowed(raw),
        }
    }

    /// 事件类型路径，如 `message.group.normal` / `notice.notify.poke`
    pub fn event_name(&self) -> String {
        match self {
            Event::Message(e) | Event::MessageSent(e) => {
                format!("message.{}.{}", e.message_type.as_str(), e.sub_type)
            }
            Event::Notice(n) => match n.sub_type() {
                Some(sub) => format!("notice.{}.{}", n.notice_type(), sub),
                None => format!("notice.{}", n.notice_type()),
            },
            Event::Request(r) => match r.sub_type() {
                Some(sub) => format!("request.{}.{}", r.request_type(), sub),
                None => format!("request.{}", r.request_type()),
            },
            Event::Meta(m) => match m.sub_type() {
                Some(sub) => format!("meta_event.{}.{}", m.meta_event_type(), sub),
                None => format!("meta_event.{}", m.meta_event_type()),
            },
            Event::Unknown { post_type, .. } => format!("unknown.{post_type}"),
        }
    }

    /// 取出消息事件（`message` / `message_sent`）
    pub fn as_message(&self) -> Option<&MessageEvent> {
        match self {
            Event::Message(e) | Event::MessageSent(e) => Some(e),
            _ => None,
        }
    }

    /// 从原始 JSON 规范化
    pub fn from_value(value: Value) -> Self {
        let post_type = value
            .get("post_type")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();

        match post_type.as_str() {
            "message" => Event::Message(parse_message_event(&value)),
            "message_sent" => Event::MessageSent(parse_message_event(&value)),
            "notice" => Event::Notice(parse_notice_event(&value)),
            "request" => Event::Request(parse_request_event(&value)),
            "meta_event" => Event::Meta(parse_meta_event(&value)),
            other => Event::Unknown {
                post_type: other.to_string(),
                raw: value,
            },
        }
    }

    /// 从原始 JSON 字符串规范化
    pub fn from_json_str(s: &str) -> Result<Self, serde_json::Error> {
        let value: Value = serde_json::from_str(s)?;
        Ok(Event::from_value(value))
    }
}

use std::borrow::Cow;

use common::{get_id, get_i64, get_str, get_str_opt};

fn base_of(value: &Value) -> EventBase {
    EventBase {
        time: get_i64(value, "time").unwrap_or(0),
        self_id: get_id(value, "self_id").unwrap_or(Id::Num(0)),
        raw: value.clone(),
    }
}

fn parse_message_event(value: &Value) -> MessageEvent {
    let message_value = value.get("message").cloned().unwrap_or(Value::Null);
    let raw_message = get_str_opt(value, "raw_message");
    let message = normalize_message(&message_value, raw_message.as_deref());

    // 群聊时 group_id 一定存在；部分协议端在频道场景用 guild_id-channel_id
    let mut group_id = get_id(value, "group_id");
    if group_id.is_none()
        && let (Some(guild), Some(channel)) =
            (get_str_opt(value, "guild_id"), get_str_opt(value, "channel_id"))
    {
        group_id = Some(Id::Str(format!("{guild}-{channel}")));
    }

    let raw = message.raw.clone();
    MessageEvent {
        base: base_of(value),
        message_type: MessageType::parse(&get_str(value, "message_type")),
        sub_type: get_str(value, "sub_type"),
        message_id: get_id(value, "message_id").unwrap_or(Id::Num(0)),
        user_id: get_id(value, "user_id").unwrap_or(Id::Num(0)),
        group_id,
        message,
        raw_message: raw,
        font: get_i64(value, "font"),
        sender: Sender::from_value(value.get("sender")),
        anonymous: value.get("anonymous").map(Anonymous::from_value),
        group_name: get_str_opt(value, "group_name"),
    }
}

fn parse_notice_event(value: &Value) -> NoticeEvent {
    let base = base_of(value);
    let notice_type = get_str(value, "notice_type");
    let sub_type = get_str_opt(value, "sub_type");
    let group_id = get_id(value, "group_id");
    let user_id = get_id(value, "user_id");
    let operator_id = get_id(value, "operator_id");

    match notice_type.as_str() {
        "friend_recall" => NoticeEvent::FriendRecall {
            base,
            user_id: user_id.unwrap_or(Id::Num(0)),
            message_id: get_id(value, "message_id").unwrap_or(Id::Num(0)),
        },
        "group_recall" => NoticeEvent::GroupRecall {
            base,
            group_id: group_id.unwrap_or(Id::Num(0)),
            user_id: user_id.unwrap_or(Id::Num(0)),
            operator_id: operator_id.unwrap_or(Id::Num(0)),
            message_id: get_id(value, "message_id").unwrap_or(Id::Num(0)),
        },
        "group_increase" => NoticeEvent::GroupIncrease {
            base,
            group_id: group_id.unwrap_or(Id::Num(0)),
            user_id: user_id.unwrap_or(Id::Num(0)),
            operator_id,
            sub_type: sub_type.unwrap_or_else(|| "approve".into()),
        },
        "group_decrease" => NoticeEvent::GroupDecrease {
            base,
            group_id: group_id.unwrap_or(Id::Num(0)),
            user_id: user_id.unwrap_or(Id::Num(0)),
            operator_id,
            sub_type: sub_type.unwrap_or_else(|| "leave".into()),
        },
        "group_admin" => NoticeEvent::GroupAdmin {
            base,
            group_id: group_id.unwrap_or(Id::Num(0)),
            user_id: user_id.unwrap_or(Id::Num(0)),
            sub_type: sub_type.unwrap_or_else(|| "set".into()),
        },
        "group_ban" => NoticeEvent::GroupBan {
            base,
            group_id: group_id.unwrap_or(Id::Num(0)),
            user_id: user_id.unwrap_or(Id::Num(0)),
            operator_id,
            duration: get_i64(value, "duration").unwrap_or(0),
            sub_type: sub_type.unwrap_or_else(|| "ban".into()),
        },
        "group_card" => NoticeEvent::GroupCard {
            base,
            group_id: group_id.unwrap_or(Id::Num(0)),
            user_id: user_id.unwrap_or(Id::Num(0)),
            card_new: get_str(value, "card_new"),
            card_old: get_str(value, "card_old"),
        },
        "group_upload" => NoticeEvent::GroupUpload {
            base,
            group_id: group_id.unwrap_or(Id::Num(0)),
            user_id: user_id.unwrap_or(Id::Num(0)),
            file: FileInfo::from_value(value.get("file")),
        },
        "group_msg_emoji_like" => NoticeEvent::GroupMsgEmojiLike {
            base,
            group_id: group_id.unwrap_or(Id::Num(0)),
            user_id: user_id.unwrap_or(Id::Num(0)),
            message_id: get_id(value, "message_id").unwrap_or(Id::Num(0)),
            likes: value
                .get("likes")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .map(|item| EmojiLike {
                            emoji_id: get_str(item, "emoji_id"),
                            count: get_i64(item, "count").unwrap_or(0),
                        })
                        .collect()
                })
                .unwrap_or_default(),
        },
        "friend_add" => NoticeEvent::FriendAdd {
            base,
            user_id: user_id.unwrap_or(Id::Num(0)),
        },
        "essence" => NoticeEvent::Essence {
            base,
            group_id: group_id.unwrap_or(Id::Num(0)),
            message_id: get_id(value, "message_id").unwrap_or(Id::Num(0)),
            operator_id: operator_id.unwrap_or(Id::Num(0)),
            sender_id: get_id(value, "sender_id").unwrap_or(Id::Num(0)),
            sub_type: sub_type.unwrap_or_else(|| "add".into()),
        },
        "notify" => NoticeEvent::Notify(parse_notify_event(value, base)),
        "bot_offline" => NoticeEvent::BotOffline {
            base,
            tag: get_str_opt(value, "tag"),
            message: get_str_opt(value, "message"),
        },
        other => NoticeEvent::Unknown {
            base,
            notice_type: other.to_string(),
            sub_type,
        },
    }
}

fn parse_notify_event(value: &Value, base: EventBase) -> NotifyEvent {
    let sub_type = get_str(value, "sub_type");
    let group_id = get_id(value, "group_id");
    let user_id = get_id(value, "user_id");
    let target_id = get_id(value, "target_id");

    match sub_type.as_str() {
        "poke" => NotifyEvent::Poke {
            base,
            group_id,
            user_id: user_id.unwrap_or(Id::Num(0)),
            target_id: target_id.unwrap_or(Id::Num(0)),
        },
        "poke_recall" => NotifyEvent::PokeRecall {
            base,
            group_id,
            user_id: user_id.unwrap_or(Id::Num(0)),
            target_id: target_id.unwrap_or(Id::Num(0)),
        },
        "honor" => NotifyEvent::Honor {
            base,
            group_id: group_id.unwrap_or(Id::Num(0)),
            user_id: user_id.unwrap_or(Id::Num(0)),
            honor_type: get_str(value, "honor_type"),
        },
        "title" => NotifyEvent::Title {
            base,
            group_id: group_id.unwrap_or(Id::Num(0)),
            user_id: user_id.unwrap_or(Id::Num(0)),
            title: get_str(value, "title"),
        },
        "group_name" => NotifyEvent::GroupName {
            base,
            group_id: group_id.unwrap_or(Id::Num(0)),
            user_id: user_id.unwrap_or(Id::Num(0)),
            name_new: get_str(value, "name_new"),
        },
        "input_status" => NotifyEvent::InputStatus {
            base,
            user_id: user_id.unwrap_or(Id::Num(0)),
            group_id,
            status_text: get_str_opt(value, "status_text"),
        },
        "profile_like" => NotifyEvent::ProfileLike {
            base,
            operator_id: get_id(value, "operator_id")
                .or(user_id)
                .unwrap_or(Id::Num(0)),
            times: get_i64(value, "times").unwrap_or(0),
        },
        other => NotifyEvent::Unknown {
            base,
            sub_type: other.to_string(),
        },
    }
}

fn parse_request_event(value: &Value) -> RequestEvent {
    let base = base_of(value);
    let request_type = get_str(value, "request_type");
    let comment = get_str(value, "comment");
    let flag = get_str(value, "flag");

    match request_type.as_str() {
        "friend" => RequestEvent::Friend {
            base,
            user_id: get_id(value, "user_id").unwrap_or(Id::Num(0)),
            comment,
            flag,
        },
        "group" => RequestEvent::Group {
            base,
            group_id: get_id(value, "group_id").unwrap_or(Id::Num(0)),
            user_id: get_id(value, "user_id").unwrap_or(Id::Num(0)),
            comment,
            flag,
            sub_type: get_str(value, "sub_type"),
        },
        other => RequestEvent::Unknown {
            base,
            request_type: other.to_string(),
        },
    }
}

fn parse_meta_event(value: &Value) -> MetaEvent {
    let base = base_of(value);
    let meta_event_type = get_str(value, "meta_event_type");

    match meta_event_type.as_str() {
        "lifecycle" => MetaEvent::Lifecycle {
            base,
            sub_type: get_str(value, "sub_type"),
        },
        "heartbeat" => MetaEvent::Heartbeat {
            base,
            interval: get_i64(value, "interval"),
            status: value.get("status").cloned().unwrap_or(Value::Null),
        },
        other => MetaEvent::Unknown {
            base,
            meta_event_type: other.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message_sample() -> Value {
        json!({
            "time": 1700000000,
            "self_id": 10001,
            "post_type": "message",
            "message_type": "group",
            "sub_type": "normal",
            "message_id": 1234,
            "user_id": 20002,
            "group_id": 30003,
            "raw_message": "你好[CQ:at,qq=10001]",
            "font": 0,
            "message": [
                {"type": "text", "data": {"text": "你好"}},
                {"type": "at", "data": {"qq": "10001"}}
            ],
            "sender": {
                "user_id": 20002,
                "nickname": "小明",
                "card": "群名片",
                "role": "member"
            }
        })
    }

    #[test]
    fn parse_group_message() {
        let event = Event::from_value(message_sample());
        let Event::Message(msg) = &event else {
            panic!("应为消息事件");
        };
        assert!(msg.is_group());
        assert_eq!(msg.group_id().unwrap().as_i64(), Some(30003));
        assert_eq!(msg.user_id().as_i64(), Some(20002));
        assert_eq!(msg.display_name(), "群名片");
        assert!(msg.is_at_self(), "@ 应指向 self_id");
        assert_eq!(msg.text(), "你好@10001");
        assert_eq!(event.event_name(), "message.group.normal");
        assert_eq!(msg.self_id().as_i64(), Some(10001));
    }

    #[test]
    fn string_ids_are_normalized() {
        let value = json!({
            "time": 1,
            "self_id": "10001",
            "post_type": "message",
            "message_type": "private",
            "sub_type": "friend",
            "message_id": "555",
            "user_id": "20002",
            "message": "hi",
            "sender": {"nickname": "小明"}
        });
        let Event::Message(msg) = Event::from_value(value) else {
            panic!("应为消息事件");
        };
        assert_eq!(msg.self_id(), &Id::Num(10001));
        assert_eq!(msg.message_id, Id::Num(555));
        assert!(msg.is_private());
        assert_eq!(msg.session_id(), "20002");
        assert_eq!(msg.raw_message, "hi", "缺失 raw_message 时应自动推导");
    }

    #[test]
    fn missing_raw_message_is_derived() {
        let value = json!({
            "time": 1, "self_id": 1, "post_type": "message",
            "message_type": "group", "sub_type": "normal",
            "message_id": 1, "user_id": 2, "group_id": 3,
            "message": "看这个[CQ:image,file=a.jpg]"
        });
        let Event::Message(msg) = Event::from_value(value) else {
            panic!()
        };
        assert_eq!(msg.raw_message, "看这个[CQ:image,file=a.jpg]");
        assert!(msg.has_image());
    }

    #[test]
    fn parse_group_recall_notice() {
        let value = json!({
            "time": 2, "self_id": 1, "post_type": "notice",
            "notice_type": "group_recall", "group_id": 3,
            "user_id": 2, "operator_id": 4, "message_id": 99
        });
        let Event::Notice(notice) = Event::from_value(value) else {
            panic!("应为通知事件");
        };
        assert_eq!(notice.notice_type(), "group_recall");
        assert_eq!(notice.group_id().unwrap().as_i64(), Some(3));
        assert_eq!(notice.user_id().unwrap().as_i64(), Some(2));
    }

    #[test]
    fn parse_poke_notify() {
        let value = json!({
            "time": 3, "self_id": 1, "post_type": "notice",
            "notice_type": "notify", "sub_type": "poke",
            "group_id": 3, "user_id": 2, "target_id": 1
        });
        let Event::Notice(notice) = Event::from_value(value) else {
            panic!()
        };
        assert_eq!(notice.notice_type(), "notify");
        assert_eq!(notice.sub_type(), Some("poke"));
        assert!(matches!(notice, NoticeEvent::Notify(_)));
        // 细分类型应被正确识别
        let NoticeEvent::Notify(NotifyEvent::Poke {
            group_id,
            user_id,
            target_id,
            ..
        }) = notice
        else {
            panic!("应为戳一戳通知");
        };
        assert_eq!(group_id.unwrap().as_i64(), Some(3));
        assert_eq!(user_id.as_i64(), Some(2));
        assert_eq!(target_id.as_i64(), Some(1));
    }

    #[test]
    fn parse_request_and_lifecycle() {
        let value = json!({
            "time": 4, "self_id": 1, "post_type": "request",
            "request_type": "group", "sub_type": "invite",
            "group_id": 3, "user_id": 2, "comment": "来玩", "flag": "abc"
        });
        let Event::Request(req) = Event::from_value(value) else {
            panic!()
        };
        assert_eq!(req.request_type(), "group");
        assert_eq!(req.flag(), Some("abc"));

        let value = json!({
            "time": 5, "self_id": 1, "post_type": "meta_event",
            "meta_event_type": "lifecycle", "sub_type": "connect"
        });
        let Event::Meta(meta) = Event::from_value(value) else {
            panic!()
        };
        assert!(meta.is_connect());
        assert_eq!(meta.sub_type(), Some("connect"));
    }

    #[test]
    fn parse_heartbeat() {
        let value = json!({
            "time": 6, "self_id": 1, "post_type": "meta_event",
            "meta_event_type": "heartbeat", "interval": 5000,
            "status": {"online": true, "good": true}
        });
        let Event::Meta(meta) = Event::from_value(value) else {
            panic!()
        };
        let MetaEvent::Heartbeat { interval, status, .. } = meta else {
            panic!("应为心跳");
        };
        assert_eq!(interval, Some(5000));
        assert_eq!(status["online"], true);
    }

    #[test]
    fn unknown_post_type_kept() {
        let event = Event::from_value(json!({"post_type": "custom_thing", "x": 1}));
        assert!(matches!(event, Event::Unknown { ref post_type, .. } if post_type == "custom_thing"));
        assert_eq!(event.event_name(), "unknown.custom_thing");
    }

    #[test]
    fn message_type_fallback_for_guild_ids() {
        let value = json!({
            "time": 7, "self_id": 1, "post_type": "message",
            "message_type": "group", "sub_type": "normal",
            "message_id": 1, "user_id": 2,
            "guild_id": "g1", "channel_id": "c1",
            "message": "hi"
        });
        let Event::Message(msg) = Event::from_value(value) else {
            panic!()
        };
        assert_eq!(msg.group_id().unwrap().to_string(), "g1-c1");
    }

    #[test]
    fn json_str_entrypoint() {
        let raw = serde_json::to_string(&message_sample()).unwrap();
        let event = Event::from_json_str(&raw).unwrap();
        assert!(matches!(event, Event::Message(_)));
    }
}
