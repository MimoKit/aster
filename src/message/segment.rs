//! 消息段（Message Segment）的规范化定义。
//!
//! OneBot v11 的 `message` 字段有两种形态：
//!
//! 1. **字符串形态（CQ 码）**：`"你好[CQ:at,qq=123]看看[CQ:image,file=a.jpg]"`
//! 2. **数组形态**：`[{"type":"text","data":{"text":"你好"}}, ...]`
//!
//! 无论原始形态如何，本模块都会把它们解析成**统一的 [`Segment`] 枚举**，
//! 这样上层的插件 / 命令处理逻辑只需要面对一种数据结构。
//!
//! 同时提供 [`Segment::to_cq_code`] 反向序列化，便于日志与调试。

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 消息段承载的数据。
///
/// 使用 `BTreeMap` 而非 `HashMap`，保证键顺序稳定（日志、单测可复现）。
pub type SegmentData = BTreeMap<String, Value>;

/// 一条规范化后的消息段。
///
/// 未识别的段类型会落到 [`Segment::Unknown`]，不会丢失原始信息。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum Segment {
    /// 纯文本
    Text { text: String },
    /// 表情（face）
    Face { id: String },
    /// 图片
    Image {
        file: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sub_type: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file_id: Option<String>,
    },
    /// 语音
    Record {
        file: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        magic: Option<String>,
    },
    /// 短视频
    Video {
        file: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
    },
    /// @某人
    At { qq: String },
    /// 回复引用
    Reply { id: String },
    /// 群文件 / 离线文件
    File {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        size: Option<i64>,
    },
    /// 戳一戳（部分协议端也走消息段）
    Poke { qq: String },
    /// 音乐分享
    Music {
        #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
        platform: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        audio: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },
    /// 合并转发（node / forward）
    Forward { id: String },
    /// 合并转发节点（仅出现在 `get_forward_msg` 的返回内容中）
    Node {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        user_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        nickname: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        time: Option<i64>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        content: Vec<Segment>,
    },
    /// 原始 JSON（`type: "json"`）
    Json { data: String },
    /// XML 卡片（`type: "xml"`）
    Xml { data: String },
    /// `type: "raw"` 时，协议端直接下发的原始段
    Raw { data: SegmentData },
    /// 未识别的段类型，保留原始数据以便排查
    Unknown { kind: String, data: SegmentData },
}

impl Segment {
    /// 段类型名（与 OneBot v11 的 `type` 字段一致）
    pub fn kind(&self) -> &str {
        match self {
            Segment::Text { .. } => "text",
            Segment::Face { .. } => "face",
            Segment::Image { .. } => "image",
            Segment::Record { .. } => "record",
            Segment::Video { .. } => "video",
            Segment::At { .. } => "at",
            Segment::Reply { .. } => "reply",
            Segment::File { .. } => "file",
            Segment::Poke { .. } => "poke",
            Segment::Music { .. } => "music",
            Segment::Forward { .. } => "forward",
            Segment::Node { .. } => "node",
            Segment::Json { .. } => "json",
            Segment::Xml { .. } => "xml",
            Segment::Raw { .. } => "raw",
            Segment::Unknown { kind, .. } => kind,
        }
    }

    /// 该段是否为"纯文本"语义
    pub fn is_text(&self) -> bool {
        matches!(self, Segment::Text { .. })
    }

    /// 取文本内容（非文本段返回 `None`）
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Segment::Text { text } => Some(text.as_str()),
            _ => None,
        }
    }

    /// 取 `at` 的目标 QQ（非 at 段返回 `None`）
    pub fn as_at(&self) -> Option<&str> {
        match self {
            Segment::At { qq } => Some(qq.as_str()),
            _ => None,
        }
    }

    /// 取图片的 `file`（非 image 段返回 `None`）
    pub fn as_image(&self) -> Option<&str> {
        match self {
            Segment::Image { file, .. } => Some(file.as_str()),
            _ => None,
        }
    }

    /// 该段是否会在文本形态下产生可读内容
    pub fn has_visible_text(&self) -> bool {
        matches!(self, Segment::Text { text } if !text.trim().is_empty())
    }

    /// 序列化回 CQ 码形态。`Text` 会转义 `&`、`[`、`]`。
    pub fn to_cq_code(&self) -> String {
        match self {
            Segment::Text { text } => escape_cq_text(text),
            Segment::Unknown { kind, data } => {
                let mut s = format!("[CQ:{kind}");
                for (k, v) in data {
                    s.push(',');
                    s.push_str(k);
                    s.push('=');
                    s.push_str(&cq_escape(&value_to_string(v)));
                }
                s.push(']');
                s
            }
            other => {
                let data = other.to_data();
                let mut s = format!("[CQ:{}", other.kind());
                for (k, v) in &data {
                    s.push(',');
                    s.push_str(k);
                    s.push('=');
                    s.push_str(&cq_escape(&value_to_string(v)));
                }
                s.push(']');
                s
            }
        }
    }

    /// 展开成 `data` 字段（用于重新序列化为数组形态）
    pub fn to_data(&self) -> SegmentData {
        let mut map = SegmentData::new();
        match self {
            Segment::Text { text } => {
                map.insert("text".into(), Value::String(text.clone()));
            }
            Segment::Face { id } => {
                map.insert("id".into(), Value::String(id.clone()));
            }
            Segment::Image {
                file,
                url,
                sub_type,
                file_id,
            } => {
                map.insert("file".into(), Value::String(file.clone()));
                if let Some(v) = url {
                    map.insert("url".into(), Value::String(v.clone()));
                }
                if let Some(v) = sub_type {
                    map.insert("sub_type".into(), Value::String(v.clone()));
                }
                if let Some(v) = file_id {
                    map.insert("file_id".into(), Value::String(v.clone()));
                }
            }
            Segment::Record { file, url, magic } => {
                map.insert("file".into(), Value::String(file.clone()));
                if let Some(v) = url {
                    map.insert("url".into(), Value::String(v.clone()));
                }
                if let Some(v) = magic {
                    map.insert("magic".into(), Value::String(v.clone()));
                }
            }
            Segment::Video { file, url } => {
                map.insert("file".into(), Value::String(file.clone()));
                if let Some(v) = url {
                    map.insert("url".into(), Value::String(v.clone()));
                }
            }
            Segment::At { qq } => {
                map.insert("qq".into(), Value::String(qq.clone()));
            }
            Segment::Reply { id } => {
                map.insert("id".into(), Value::String(id.clone()));
            }
            Segment::File {
                file,
                name,
                url,
                file_id,
                size,
            } => {
                if let Some(v) = file {
                    map.insert("file".into(), Value::String(v.clone()));
                }
                if let Some(v) = name {
                    map.insert("name".into(), Value::String(v.clone()));
                }
                if let Some(v) = url {
                    map.insert("url".into(), Value::String(v.clone()));
                }
                if let Some(v) = file_id {
                    map.insert("file_id".into(), Value::String(v.clone()));
                }
                if let Some(v) = size {
                    map.insert("size".into(), Value::Number((*v).into()));
                }
            }
            Segment::Poke { qq } => {
                map.insert("qq".into(), Value::String(qq.clone()));
            }
            Segment::Music {
                platform,
                id,
                url,
                audio,
                title,
            } => {
                if let Some(v) = platform {
                    map.insert("type".into(), Value::String(v.clone()));
                }
                if let Some(v) = id {
                    map.insert("id".into(), Value::String(v.clone()));
                }
                if let Some(v) = url {
                    map.insert("url".into(), Value::String(v.clone()));
                }
                if let Some(v) = audio {
                    map.insert("audio".into(), Value::String(v.clone()));
                }
                if let Some(v) = title {
                    map.insert("title".into(), Value::String(v.clone()));
                }
            }
            Segment::Forward { id } => {
                map.insert("id".into(), Value::String(id.clone()));
            }
            Segment::Node {
                user_id,
                nickname,
                time,
                content,
            } => {
                if let Some(v) = user_id {
                    map.insert("user_id".into(), Value::String(v.clone()));
                }
                if let Some(v) = nickname {
                    map.insert("nickname".into(), Value::String(v.clone()));
                }
                if let Some(v) = time {
                    map.insert("time".into(), Value::Number((*v).into()));
                }
                map.insert(
                    "content".into(),
                    serde_json::to_value(content).unwrap_or(Value::Array(vec![])),
                );
            }
            Segment::Json { data } => {
                map.insert("data".into(), Value::String(data.clone()));
            }
            Segment::Xml { data } => {
                map.insert("data".into(), Value::String(data.clone()));
            }
            Segment::Raw { data } | Segment::Unknown { data, .. } => {
                map = data.clone();
            }
        }
        map
    }
}

impl fmt::Display for Segment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_cq_code())
    }
}

/// 把 `Value` 转成 CQ 码里的字符串形态
fn value_to_string(value: &Value) -> Cow<'_, str> {
    match value {
        Value::String(s) => Cow::Borrowed(s),
        Value::Null => Cow::Borrowed(""),
        other => Cow::Owned(other.to_string()),
    }
}

/// CQ 码属性值转义：`&` → `&amp;`，`,` → `&#44;`，`[` → `&#91;`，`]` → `&#93;`
pub fn cq_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            ',' => out.push_str("&#44;"),
            '[' => out.push_str("&#91;"),
            ']' => out.push_str("&#93;"),
            _ => out.push(c),
        }
    }
    out
}

/// 文本段内的转义：`&`、`[`、`]`
pub fn escape_cq_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '[' => out.push_str("&#91;"),
            ']' => out.push_str("&#93;"),
            _ => out.push(c),
        }
    }
    out
}

/// CQ 码反转义
pub fn cq_unescape(input: &str) -> String {
    if !input.contains('&') {
        return input.to_string();
    }
    input
        .replace("&#91;", "[")
        .replace("&#93;", "]")
        .replace("&#44;", ",")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cq_escape_roundtrip() {
        let raw = "a&b,c[d]e";
        let escaped = cq_escape(raw);
        assert_eq!(escaped, "a&amp;b&#44;c&#91;d&#93;e");
        assert_eq!(cq_unescape(&escaped), raw);
    }

    #[test]
    fn text_escape_only_brackets_and_amp() {
        assert_eq!(escape_cq_text("a,b"), "a,b");
        assert_eq!(escape_cq_text("[x]"), "&#91;x&#93;");
    }

    #[test]
    fn segment_to_cq_code() {
        let seg = Segment::At { qq: "123".into() };
        assert_eq!(seg.to_cq_code(), "[CQ:at,qq=123]");
        let seg = Segment::Text {
            text: "你好[x]".into(),
        };
        assert_eq!(seg.to_cq_code(), "你好&#91;x&#93;");
    }
}
