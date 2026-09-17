//! CQ 码解析器。
//!
//! 支持 OneBot v11 定义的转义规则：
//!
//! | 原字符 | 转义后 |
//! |--------|--------|
//! | `&`    | `&amp;` |
//! | `,`    | `&#44;` |
//! | `[`    | `&#91;` |
//! | `]`    | `&#93;` |
//!
//! 另外兼容旧版 `&#44;` / `&#91;` / `&#93;` 之外的 `\uXXXX` 形态不处理，
//! 因为 OneBot v11 并未定义该形态。

use serde_json::Value;

use super::segment::{Segment, SegmentData, cq_unescape};

/// 解析 CQ 码字符串为消息段数组。
///
/// * 未闭合的 `[CQ:` 会被当作普通文本原样保留，不会 panic。
/// * 形如 `[CQ:xxx]` 的未知段会落到 [`Segment::Unknown`]。
pub fn parse_cq_string(raw: &str) -> Vec<Segment> {
    /// 把累积的文本反转义后作为 Text 段推入
    fn flush(text_buf: &mut String, segments: &mut Vec<Segment>) {
        if !text_buf.is_empty() {
            segments.push(Segment::Text {
                text: cq_unescape(text_buf),
            });
            text_buf.clear();
        }
    }

    let mut segments = Vec::new();
    let mut text_buf = String::new();
    let bytes = raw.as_bytes();
    let mut cursor = 0usize;

    while cursor < bytes.len() {
        // 非 CQ 码起始：按 UTF-8 边界取一个字符放进文本缓冲
        if !raw[cursor..].starts_with("[CQ:") {
            let len = utf8_len(bytes[cursor]);
            text_buf.push_str(&raw[cursor..cursor + len]);
            cursor += len;
            continue;
        }

        // CQ 码内不嵌套 `[`：遇到裸 `[` 视为未闭合
        let body_start = cursor + "[CQ:".len();
        let mut end = None;
        for (offset, ch) in raw[body_start..].char_indices() {
            match ch {
                ']' => {
                    end = Some(body_start + offset);
                    break;
                }
                '[' => break,
                _ => {}
            }
        }

        let Some(end) = end else {
            // 未闭合：原样当作文本继续扫描
            text_buf.push('[');
            cursor += 1;
            continue;
        };

        match parse_cq_body(&raw[body_start..end]) {
            Some(segment) => {
                flush(&mut text_buf, &mut segments);
                segments.push(segment);
            }
            // 解析失败：整段 CQ 码文本原样保留
            None => text_buf.push_str(&raw[cursor..=end]),
        }
        cursor = end + 1;
    }

    flush(&mut text_buf, &mut segments);

    segments
}

/// 解析 `[CQ:...]` 内部的内容（不含中括号与 `CQ:` 前缀）
fn parse_cq_body(body: &str) -> Option<Segment> {
    // 段类型与第一个逗号之间的部分
    let (kind, rest) = match body.find(',') {
        Some(pos) => (&body[..pos], &body[pos + 1..]),
        None => (body, ""),
    };
    let kind = kind.trim();
    if kind.is_empty() {
        return None;
    }

    let data = parse_cq_params(rest);
    Some(build_segment(kind, data))
}

/// 解析 `key=value` 参数列表，值会做 CQ 反转义
fn parse_cq_params(rest: &str) -> SegmentData {
    let mut map = SegmentData::new();
    if rest.is_empty() {
        return map;
    }

    // 按未转义的逗号切分
    let mut parts = Vec::new();
    let mut current = String::new();
    let bytes = rest.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if c == '&' && rest[i..].starts_with("&#44;") {
            current.push(',');
            i += "&#44;".len();
            continue;
        }
        if c == ',' {
            parts.push(std::mem::take(&mut current));
            i += 1;
            continue;
        }
        // 多字节字符：按 UTF-8 边界推进
        let ch_len = utf8_len(bytes[i]);
        current.push_str(&rest[i..i + ch_len]);
        i += ch_len;
    }
    parts.push(current);

    for part in parts {
        if part.is_empty() {
            continue;
        }
        let (k, v) = match part.find('=') {
            Some(pos) => (&part[..pos], &part[pos + 1..]),
            None => (part.as_str(), ""),
        };
        let key = k.trim().to_string();
        if key.is_empty() {
            continue;
        }
        map.insert(key, Value::String(super::segment::cq_unescape(v)));
    }
    map
}

/// UTF-8 字符首字节对应的长度
fn utf8_len(byte: u8) -> usize {
    match byte {
        0x00..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF7 => 4,
        _ => 1,
    }
}

/// 根据段类型与参数构造 [`Segment`]
pub fn build_segment(kind: &str, mut data: SegmentData) -> Segment {
    fn take_str(map: &mut SegmentData, key: &str) -> Option<String> {
        map.remove(key).map(|v| match v {
            Value::String(s) => s,
            Value::Null => String::new(),
            other => other.to_string(),
        })
    }
    fn take_i64(map: &mut SegmentData, key: &str) -> Option<i64> {
        map.remove(key).and_then(|v| match v {
            Value::Number(n) => n.as_i64(),
            Value::String(s) => s.parse().ok(),
            _ => None,
        })
    }
    /// 有些协议端把 id 写成数字字面量
    fn take_id(map: &mut SegmentData, key: &str) -> Option<String> {
        take_str(map, key)
    }

    match kind {
        "text" => Segment::Text {
            text: take_str(&mut data, "text").unwrap_or_default(),
        },
        "face" => Segment::Face {
            id: take_id(&mut data, "id").unwrap_or_default(),
        },
        "image" => Segment::Image {
            file: take_str(&mut data, "file").unwrap_or_default(),
            url: take_str(&mut data, "url"),
            sub_type: take_str(&mut data, "sub_type"),
            file_id: take_str(&mut data, "file_id"),
        },
        "record" => Segment::Record {
            file: take_str(&mut data, "file").unwrap_or_default(),
            url: take_str(&mut data, "url"),
            magic: take_str(&mut data, "magic"),
        },
        "video" => Segment::Video {
            file: take_str(&mut data, "file").unwrap_or_default(),
            url: take_str(&mut data, "url"),
        },
        "at" => Segment::At {
            qq: take_id(&mut data, "qq").unwrap_or_default(),
        },
        "reply" => Segment::Reply {
            id: take_id(&mut data, "id").unwrap_or_default(),
        },
        "file" => Segment::File {
            file: take_str(&mut data, "file"),
            name: take_str(&mut data, "name"),
            url: take_str(&mut data, "url"),
            file_id: take_str(&mut data, "file_id"),
            size: take_i64(&mut data, "size"),
        },
        "poke" => Segment::Poke {
            qq: take_id(&mut data, "qq").unwrap_or_default(),
        },
        "music" => Segment::Music {
            platform: take_str(&mut data, "type"),
            id: take_id(&mut data, "id"),
            url: take_str(&mut data, "url"),
            audio: take_str(&mut data, "audio"),
            title: take_str(&mut data, "title"),
        },
        "forward" => Segment::Forward {
            id: take_id(&mut data, "id").unwrap_or_default(),
        },
        "node" => {
            let content = data
                .remove("content")
                .map(|v| super::parser::parse_message_value(&v))
                .unwrap_or_default();
            Segment::Node {
                user_id: take_id(&mut data, "user_id"),
                nickname: take_str(&mut data, "nickname"),
                time: take_i64(&mut data, "time"),
                content,
            }
        }
        "json" => Segment::Json {
            data: take_str(&mut data, "data").unwrap_or_default(),
        },
        "xml" => Segment::Xml {
            data: take_str(&mut data, "data").unwrap_or_default(),
        },
        "raw" => Segment::Raw { data },
        other => Segment::Unknown {
            kind: other.to_string(),
            data,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(segs: &[Segment]) -> Vec<&str> {
        segs.iter()
            .filter_map(|s| match s {
                Segment::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn plain_text() {
        let segs = parse_cq_string("你好世界");
        assert_eq!(segs.len(), 1);
        assert_eq!(texts(&segs), vec!["你好世界"]);
    }

    #[test]
    fn mixed_segments() {
        let segs = parse_cq_string("你好[CQ:at,qq=123] 看这个[CQ:image,file=a.jpg]");
        assert_eq!(segs.len(), 4);
        assert!(matches!(&segs[0], Segment::Text { text } if text == "你好"));
        assert!(matches!(&segs[1], Segment::At { qq } if qq == "123"));
        assert!(matches!(&segs[2], Segment::Text { text } if text == " 看这个"));
        assert!(matches!(&segs[3], Segment::Image { file, .. } if file == "a.jpg"));
    }

    #[test]
    fn escaped_brackets_are_not_segments() {
        let segs = parse_cq_string("a&#91;CQ:at,qq=1&#93;b");
        assert_eq!(segs.len(), 1, "转义的中括号不应被解析成段");
    }

    #[test]
    fn unclosed_cq_is_text() {
        let segs = parse_cq_string("前面[CQ:at,qq=123 后面");
        assert_eq!(segs.len(), 1);
        assert!(matches!(&segs[0], Segment::Text { text } if text == "前面[CQ:at,qq=123 后面"));
    }

    #[test]
    fn value_containing_escaped_comma() {
        let segs = parse_cq_string("[CQ:image,file=a&#44;b.jpg,url=http://x/y]");
        match &segs[0] {
            Segment::Image { file, url, .. } => {
                assert_eq!(file, "a,b.jpg");
                assert_eq!(url.as_deref(), Some("http://x/y"));
            }
            other => panic!("期望 image，实际 {other:?}"),
        }
    }

    #[test]
    fn unknown_segment_kept() {
        let segs = parse_cq_string("[CQ:mystery,a=1]");
        match &segs[0] {
            Segment::Unknown { kind, data } => {
                assert_eq!(kind, "mystery");
                assert_eq!(data.get("a").unwrap(), "1");
            }
            other => panic!("期望 Unknown，实际 {other:?}"),
        }
    }

    #[test]
    fn cq_roundtrip() {
        let raw = "[CQ:at,qq=123]看[CQ:image,file=a&#44;b.jpg]";
        let segs = parse_cq_string(raw);
        let rebuilt: String = segs.iter().map(|s| s.to_cq_code()).collect();
        assert_eq!(rebuilt, raw);
    }
}
