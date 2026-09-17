//! 消息处理层：OneBot v11 消息字段的规范化。
//!
//! 模块职责划分：
//!
//! | 模块 | 职责 |
//! |------|------|
//! | [`segment`] | 消息段的统一数据结构与 CQ 码转义 |
//! | [`cq`]      | CQ 码字符串 → 消息段 |
//! | [`parser`]  | `message` 字段（字符串 / 数组）→ 消息段 |
//! | [`text`]    | 消息段 → `raw_message` / 可读文本 |
//!
//! 入口通常是 [`normalize_message`]，它把 OneBot v11 事件里的
//! `message` / `raw_message` 两个字段一次性规范化成 [`MessageContent`]。

pub mod cq;
pub mod parser;
pub mod segment;
pub mod text;

use serde::{Deserialize, Serialize};

pub use parser::{is_plain_text, parse_message_value, segments_to_array, segments_to_cq_string};
pub use segment::{Segment, SegmentData};
pub use text::{raw_message, readable_text};

/// 规范化后的消息内容。
///
/// 这是插件层实际使用的类型，避免上层再去关心 `message` 是字符串还是数组。
#[derive(Debug, Clone, PartialEq)]
pub struct MessageContent {
    /// 结构化消息段
    pub segments: Vec<Segment>,
    /// OneBot v11 语义的 CQ 码原文（优先沿用协议端上报值）
    pub raw: String,
    /// 人类可读文本，不可读的段会变成 `[图片]` 之类的占位
    pub text: String,
}

impl MessageContent {
    /// 从消息段构造，自动推导 `raw` 与 `text`
    pub fn from_segments(segments: Vec<Segment>) -> Self {
        let raw = raw_message(&segments);
        let text = readable_text(&segments);
        Self {
            segments,
            raw,
            text,
        }
    }

    /// 指定 `raw_message` 原文（为空则自动推导）
    pub fn with_raw(segments: Vec<Segment>, raw: Option<String>) -> Self {
        let raw = match raw {
            Some(r) if !r.is_empty() => r,
            _ => raw_message(&segments),
        };
        let text = readable_text(&segments);
        Self {
            segments,
            raw,
            text,
        }
    }

    /// 空消息
    pub fn empty() -> Self {
        Self {
            segments: Vec::new(),
            raw: String::new(),
            text: String::new(),
        }
    }

    /// 是否为空消息
    pub fn is_empty(&self) -> bool {
        self.segments.is_empty() && self.text.is_empty()
    }

    /// 是否全部由文本段组成
    pub fn is_plain_text(&self) -> bool {
        is_plain_text(&self.segments)
    }

    /// 第 i 个段
    pub fn get(&self, index: usize) -> Option<&Segment> {
        self.segments.get(index)
    }

    /// 第一个非空的文本内容
    pub fn first_text(&self) -> Option<&str> {
        self.segments.iter().find_map(|s| match s {
            Segment::Text { text } if !text.trim().is_empty() => Some(text.as_str()),
            _ => None,
        })
    }

    /// 消息开头的纯文本（遇到第一个非文本段即停止）
    ///
    /// 用于命令匹配：`"#查询 [CQ:at,qq=1]"` → `"#查询 "`
    pub fn leading_text(&self) -> &str {
        match self.segments.first() {
            Some(Segment::Text { text }) => text.as_str(),
            _ => "",
        }
    }

    /// 去掉开头文本段的空白后的内容（命令解析用）
    pub fn trimmed_leading_text(&self) -> &str {
        self.leading_text().trim_start()
    }

    /// 是否以指定文本开头（忽略前导空白）
    pub fn starts_with(&self, prefix: &str) -> bool {
        self.trimmed_leading_text().starts_with(prefix)
    }

    /// 是否包含 @某人
    pub fn contains_at(&self, qq: &str) -> bool {
        self.segments
            .iter()
            .any(|s| matches!(s, Segment::At { qq: q } if q == qq))
    }

    /// 是否 @ 了全体成员
    pub fn contains_at_all(&self) -> bool {
        self.segments.iter().any(|s| {
            matches!(s, Segment::At { qq } if qq == "all" || qq == "everyone")
        })
    }

    /// 是否包含图片
    pub fn contains_image(&self) -> bool {
        self.segments.iter().any(|s| s.as_image().is_some())
    }

    /// 被回复的消息 id（第一条 `reply` 段）
    pub fn reply_id(&self) -> Option<&str> {
        self.segments.iter().find_map(|s| match s {
            Segment::Reply { id } => Some(id.as_str()),
            _ => None,
        })
    }

    /// 所有 @ 目标
    pub fn at_list(&self) -> Vec<&str> {
        self.segments.iter().filter_map(|s| s.as_at()).collect()
    }

    /// 序列化成 OneBot v11 的数组形态
    pub fn to_array(&self) -> serde_json::Value {
        segments_to_array(&self.segments)
    }

    /// 序列化成 CQ 码字符串
    pub fn to_cq_string(&self) -> String {
        raw_message(&self.segments)
    }

    /// 简化的字符串形式（发送 / 日志用）；纯文本消息直接返回原文
    pub fn as_sendable(&self) -> String {
        if self.is_plain_text() {
            self.text.clone()
        } else {
            self.to_cq_string()
        }
    }
}

impl std::fmt::Display for MessageContent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.text)
    }
}

impl Serialize for MessageContent {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.segments.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for MessageContent {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        Ok(MessageContent::from_segments(parse_message_value(&value)))
    }
}

/// 规范化入口：给定 `message` 与可选 `raw_message`，产出 [`MessageContent`]
pub fn normalize_message(message: &serde_json::Value, raw: Option<&str>) -> MessageContent {
    let segments = parse_message_value(message);
    MessageContent::with_raw(segments, raw.map(|s| s.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalize_from_string() {
        let msg = normalize_message(&json!("你好[CQ:at,qq=1]"), None);
        assert_eq!(msg.raw, "你好[CQ:at,qq=1]");
        assert_eq!(msg.text, "你好@1");
        assert!(!msg.is_plain_text());
        assert!(msg.contains_at("1"));
    }

    #[test]
    fn prefers_upstream_raw_message() {
        let msg = normalize_message(&json!("hi"), Some("hi[CQ:face,id=1]"));
        assert_eq!(msg.raw, "hi[CQ:face,id=1]");
    }

    #[test]
    fn command_like_helpers() {
        let msg = normalize_message(&json!([
            {"type": "text", "data": {"text": "#查询 "}},
            {"type": "at", "data": {"qq": "123"}}
        ]), None);
        assert!(msg.starts_with("#查询"));
        assert_eq!(msg.trimmed_leading_text(), "#查询 ");
        assert_eq!(msg.at_list(), vec!["123"]);
    }

    #[test]
    fn reply_and_image_detection() {
        let msg = normalize_message(
            &json!("[CQ:reply,id=99][CQ:image,file=x.png]"),
            None,
        );
        assert_eq!(msg.reply_id(), Some("99"));
        assert!(msg.contains_image());
        assert_eq!(msg.text, "[回复][图片]");
    }

    #[test]
    fn empty_message() {
        let msg = normalize_message(&json!(""), None);
        assert!(msg.is_empty());
        assert_eq!(msg.text, "");
    }

    #[test]
    fn serde_roundtrip() {
        let msg = normalize_message(&json!("hi[CQ:at,qq=1]"), None);
        let encoded = serde_json::to_string(&msg).unwrap();
        let decoded: MessageContent = serde_json::from_str(&encoded).unwrap();
        assert_eq!(msg.segments, decoded.segments);
    }
}
