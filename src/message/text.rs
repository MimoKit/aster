//! 事件规范化文本（`raw_message` / `message_text`）。
//!
//! OneBot v11 对 `raw_message` 的约定是 **CQ 码形态**，但实际协议端实现不一：
//! 有的省略 `raw_message`，有的给出纯文本。这里统一生成一个稳定的兜底值，
//! 并额外提供「可读文本」（段被替换成 `[图片]` 之类的占位符），便于日志与匹配。

use super::segment::Segment;

/// 把消息段还原成 OneBot v11 语义的 `raw_message`（CQ 码）。
///
/// 若上游提供了非空的 `raw_message`，应优先沿用上游值；
/// 本函数用于上游缺失时兜底。
pub fn raw_message(segments: &[Segment]) -> String {
    segments.iter().map(|s| s.to_cq_code()).collect()
}

/// 生成人类可读的纯文本形态。
///
/// * `text` 段原样保留
/// * `at` 且 qq 为 `all` → `@全体成员`，否则 `@QQ号`
/// * 其他段使用 `[类型]` 占位（图片、语音等附件）
pub fn readable_text(segments: &[Segment]) -> String {
    let mut out = String::new();
    for seg in segments {
        match seg {
            Segment::Text { text } => out.push_str(text),
            Segment::At { qq } => {
                if qq == "all" || qq == "everyone" {
                    out.push_str("@全体成员");
                } else {
                    out.push('@');
                    out.push_str(qq);
                }
            }
            Segment::Face { id } => {
                out.push_str("[表情:");
                out.push_str(id);
                out.push(']');
            }
            Segment::Image { .. } => out.push_str("[图片]"),
            Segment::Record { .. } => out.push_str("[语音]"),
            Segment::Video { .. } => out.push_str("[视频]"),
            Segment::File { name, .. } => {
                out.push_str("[文件:");
                out.push_str(name.as_deref().unwrap_or("未知"));
                out.push(']');
            }
            Segment::Reply { .. } => out.push_str("[回复]"),
            Segment::Poke { .. } => out.push_str("[戳一戳]"),
            Segment::Music { .. } => out.push_str("[音乐]"),
            Segment::Forward { .. } => out.push_str("[合并转发]"),
            Segment::Node { .. } => out.push_str("[转发节点]"),
            Segment::Json { .. } => out.push_str("[JSON卡片]"),
            Segment::Xml { .. } => out.push_str("[XML卡片]"),
            Segment::Raw { .. } | Segment::Unknown { .. } => {
                out.push('[');
                out.push_str(seg.kind());
                out.push(']');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::parser::parse_message_value;
    use serde_json::json;

    #[test]
    fn readable_text_replaces_non_text() {
        let segs = parse_message_value(&json!("你好[CQ:at,qq=all][CQ:image,file=a.jpg]"));
        assert_eq!(readable_text(&segs), "你好@全体成员[图片]");
    }

    #[test]
    fn raw_message_is_cq() {
        let segs = parse_message_value(&json!([
            {"type": "text", "data": {"text": "hi"}},
            {"type": "at", "data": {"qq": "1"}}
        ]));
        assert_eq!(raw_message(&segs), "hi[CQ:at,qq=1]");
    }
}
