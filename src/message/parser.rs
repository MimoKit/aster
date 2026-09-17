//! 消息字段解析：把 OneBot v11 的 `message` 字段（字符串或数组）统一成 [`Vec<Segment>`]。

use serde_json::{Map, Value};

use super::cq::{build_segment, parse_cq_string};
use super::segment::{Segment, SegmentData};

/// 解析 `message` 字段的任意形态。
///
/// 支持的输入：
/// * `Value::String` —— 按 CQ 码解析
/// * `Value::Array`  —— 按 `{type, data}` 数组解析
/// * `Value::Object` —— 单个段对象
/// * 其他            —— 转成字符串后按 CQ 码解析
pub fn parse_message_value(value: &Value) -> Vec<Segment> {
    match value {
        Value::Null => Vec::new(),
        Value::String(s) => parse_cq_string(s),
        Value::Array(items) => {
            let mut segments = Vec::with_capacity(items.len());
            for item in items {
                segments.extend(parse_single_value(item));
            }
            segments
        }
        other => parse_single_value(other),
    }
}

/// 解析消息数组中的单个元素
fn parse_single_value(value: &Value) -> Vec<Segment> {
    match value {
        Value::String(s) => parse_cq_string(s),
        Value::Object(obj) => parse_segment_object(obj),
        Value::Array(items) => items.iter().flat_map(parse_single_value).collect(),
        // 数字 / 布尔：视为文本（部分协议端会下发裸数字）
        Value::Number(n) => vec![Segment::Text {
            text: n.to_string(),
        }],
        Value::Bool(b) => vec![Segment::Text {
            text: b.to_string(),
        }],
        Value::Null => Vec::new(),
    }
}

/// 解析单个 `{type, data}` 段对象
fn parse_segment_object(obj: &Map<String, Value>) -> Vec<Segment> {
    let kind = obj
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    // `type` 缺失但有 `text` 字段：兼容极简写法 `{"text": "hi"}`
    if kind.is_empty() {
        if let Some(text) = obj.get("text").and_then(|v| v.as_str()) {
            return vec![Segment::Text {
                text: text.to_string(),
            }];
        }
        return vec![Segment::Unknown {
            kind: String::new(),
            data: object_to_data(obj),
        }];
    }

    // data 可能是对象，也可能是「扁平写法」：{type: "at", qq: "123"}
    let data = match obj.get("data") {
        Some(Value::Object(inner)) => object_to_data(inner),
        Some(Value::Array(_)) => {
            // 极少数协议端把 data 写成数组，此时回退到扁平写法
            flat_data(obj)
        }
        Some(Value::Null) | None => flat_data(obj),
        Some(other) => {
            let mut map = SegmentData::new();
            map.insert("data".into(), other.clone());
            map
        }
    };

    vec![build_segment(&kind, data)]
}

/// 把 `data` 之外的同级字段视作参数（扁平写法）
fn flat_data(obj: &Map<String, Value>) -> SegmentData {
    let mut map = SegmentData::new();
    for (k, v) in obj {
        if k == "type" || k == "data" {
            continue;
        }
        map.insert(k.clone(), v.clone());
    }
    map
}

fn object_to_data(obj: &Map<String, Value>) -> SegmentData {
    obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
}

/// 反向：把规范化后的消息段序列化成 OneBot v11 的数组形态
pub fn segments_to_array(segments: &[Segment]) -> Value {
    Value::Array(
        segments
            .iter()
            .map(|seg| {
                let mut obj = Map::new();
                obj.insert("type".into(), Value::String(seg.kind().to_string()));
                obj.insert(
                    "data".into(),
                    Value::Object(seg.to_data().into_iter().collect()),
                );
                Value::Object(obj)
            })
            .collect(),
    )
}

/// 反向：把规范化后的消息段序列化成 CQ 码字符串
pub fn segments_to_cq_string(segments: &[Segment]) -> String {
    segments.iter().map(|s| s.to_cq_code()).collect()
}

/// 是否「纯文本消息」——常用于快速判断要不要走命令匹配
pub fn is_plain_text(segments: &[Segment]) -> bool {
    segments.iter().all(|s| s.is_text())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_string_form() {
        let segs = parse_message_value(&json!("hi[CQ:at,qq=1]"));
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[1].kind(), "at");
    }

    #[test]
    fn parse_array_form() {
        let value = json!([
            {"type": "text", "data": {"text": "hi"}},
            {"type": "at", "data": {"qq": 123}},
            {"type": "image", "data": {"file": "a.jpg", "url": "http://x"}}
        ]);
        let segs = parse_message_value(&value);
        assert_eq!(segs.len(), 3);
        assert!(matches!(&segs[0], Segment::Text { text } if text == "hi"));
        // 数字型 qq 会被规范成字符串
        assert!(matches!(&segs[1], Segment::At { qq } if qq == "123"));
        assert!(matches!(&segs[2], Segment::Image { file, .. } if file == "a.jpg"));
    }

    #[test]
    fn parse_flat_form() {
        // 兼容 {type: "at", qq: "123"} 这种没有 data 的写法
        let segs = parse_message_value(&json!([{"type": "at", "qq": "9"}]));
        assert!(matches!(&segs[0], Segment::At { qq } if qq == "9"));
    }

    #[test]
    fn array_and_string_agree() {
        let from_string = parse_message_value(&json!("[CQ:at,qq=7]走"));
        let from_array = parse_message_value(&json!([
            {"type": "at", "data": {"qq": "7"}},
            {"type": "text", "data": {"text": "走"}}
        ]));
        assert_eq!(from_string, from_array, "两种形态应归一为同一结果");
    }

    #[test]
    fn roundtrip_back_to_array() {
        let segs = parse_message_value(&json!("[CQ:at,qq=7]走"));
        let array = segments_to_array(&segs);
        assert_eq!(array[0]["type"], "at");
        assert_eq!(array[0]["data"]["qq"], "7");
        assert_eq!(array[1]["data"]["text"], "走");
    }

    #[test]
    fn plain_text_detection() {
        assert!(is_plain_text(&parse_message_value(&json!("hello"))));
        assert!(!is_plain_text(&parse_message_value(&json!(
            "[CQ:at,qq=1]"
        ))));
    }
}
