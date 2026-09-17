//! 事件公共类型与 JSON 取值辅助。
//!
//! OneBot v11 的 ID 字段在规范里是整数，但实践中有相当一部分协议端
//! （尤其是频道 / 双 ID 平台）会下发字符串。这里用 [`Id`] 统一承载：
//!
//! * 数字 → [`Id::Num`]
//! * 纯数字字符串 → 归一为 [`Id::Num`]（保证 `"123" == 123`）
//! * 其他字符串 → [`Id::Str`]（如频道的 `guild-channel`）
//!
//! 这样比较与哈希都不会因为协议端的类型差异而出错。

use std::borrow::Cow;
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 统一的 ID 类型
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Id {
    Num(i64),
    Str(String),
}

impl Id {
    /// 从任意 `Value` 构造；`Null` / 空字符串返回 `None`
    pub fn from_value(value: &Value) -> Option<Self> {
        match value {
            Value::Number(n) => n.as_i64().map(Id::Num),
            Value::String(s) => Self::from_str_checked(s),
            _ => None,
        }
    }

    /// 从字符串构造，纯数字字符串会归一为 [`Id::Num`]
    pub fn parse(s: &str) -> Self {
        Self::from_str_checked(s).unwrap_or_else(|| Id::Str(s.to_string()))
    }

    fn from_str_checked(s: &str) -> Option<Self> {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            return None;
        }
        match trimmed.parse::<i64>() {
            Ok(n) => Some(Id::Num(n)),
            Err(_) => Some(Id::Str(trimmed.to_string())),
        }
    }

    /// 数字形态（非数字返回 `None`）
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Id::Num(n) => Some(*n),
            Id::Str(_) => None,
        }
    }

    /// 字符串形态（借用，避免无谓分配）
    pub fn as_str(&self) -> Cow<'_, str> {
        match self {
            Id::Num(n) => Cow::Owned(n.to_string()),
            Id::Str(s) => Cow::Borrowed(s.as_str()),
        }
    }

    /// 是否为「全体成员」这类特殊 ID
    pub fn is_all(&self) -> bool {
        matches!(self, Id::Str(s) if s == "all" || s == "everyone")
    }
}

impl fmt::Display for Id {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Id::Num(n) => write!(f, "{n}"),
            Id::Str(s) => f.write_str(s),
        }
    }
}

impl From<i64> for Id {
    fn from(value: i64) -> Self {
        Id::Num(value)
    }
}

impl From<&str> for Id {
    fn from(value: &str) -> Self {
        Id::parse(value)
    }
}

impl From<String> for Id {
    fn from(value: String) -> Self {
        Id::parse(&value)
    }
}

impl PartialEq<i64> for Id {
    fn eq(&self, other: &i64) -> bool {
        self.as_i64() == Some(*other)
    }
}

impl PartialEq<str> for Id {
    fn eq(&self, other: &str) -> bool {
        self.as_str() == other
    }
}

impl PartialEq<&str> for Id {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == *other
    }
}

impl Serialize for Id {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Id::Num(n) => serializer.serialize_i64(*n),
            Id::Str(s) => serializer.serialize_str(s),
        }
    }
}

impl<'de> Deserialize<'de> for Id {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        Id::from_value(&value).ok_or_else(|| serde::de::Error::custom("无效的 ID"))
    }
}

/// 消息发送者信息（`sender` 字段）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Sender {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nickname: Option<String>,
    /// 群名片
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card: Option<String>,
    /// `owner` | `admin` | `member`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sex: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub age: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub area: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

impl Sender {
    pub fn from_value(value: Option<&Value>) -> Self {
        let Some(value) = value else {
            return Sender::default();
        };
        Sender {
            user_id: get_id(value, "user_id"),
            nickname: get_str_opt(value, "nickname"),
            card: get_str_opt(value, "card"),
            role: get_str_opt(value, "role"),
            sex: get_str_opt(value, "sex"),
            age: get_i64(value, "age"),
            area: get_str_opt(value, "area"),
            level: get_str_opt(value, "level"),
            title: get_str_opt(value, "title"),
        }
    }

    /// 是否群主
    pub fn is_owner(&self) -> bool {
        self.role.as_deref() == Some("owner")
    }

    /// 是否管理员（含群主）
    pub fn is_admin(&self) -> bool {
        matches!(self.role.as_deref(), Some("admin") | Some("owner"))
    }
}

/// 匿名用户信息
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Anonymous {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flag: Option<String>,
}

impl Anonymous {
    pub fn from_value(value: &Value) -> Self {
        Anonymous {
            id: get_id(value, "id"),
            name: get_str_opt(value, "name"),
            flag: get_str_opt(value, "flag"),
        }
    }
}

/// 文件信息（`group_upload` 通知的 `file` 字段）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FileInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub busid: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

impl FileInfo {
    pub fn from_value(value: Option<&Value>) -> Self {
        let Some(value) = value else {
            return FileInfo::default();
        };
        FileInfo {
            id: get_str_opt(value, "id"),
            name: get_str_opt(value, "name"),
            size: get_i64(value, "size"),
            busid: get_i64(value, "busid"),
            url: get_str_opt(value, "url"),
        }
    }
}

/// 取字符串字段（缺失 / 非字符串返回空串）
pub fn get_str(value: &Value, key: &str) -> String {
    get_str_opt(value, key).unwrap_or_default()
}

/// 取可选字符串字段；数字会被转成字符串（部分协议端字段类型不稳定）
pub fn get_str_opt(value: &Value, key: &str) -> Option<String> {
    match value.get(key)? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// 取整数字段；字符串数字也会被解析
pub fn get_i64(value: &Value, key: &str) -> Option<i64> {
    match value.get(key)? {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// 取 ID 字段（自动归一数字 / 数字字符串）
pub fn get_id(value: &Value, key: &str) -> Option<Id> {
    Id::from_value(value.get(key)?)
}

/// 取布尔字段
pub fn get_bool(value: &Value, key: &str) -> Option<bool> {
    match value.get(key)? {
        Value::Bool(b) => Some(*b),
        Value::Number(n) => n.as_i64().map(|v| v != 0),
        Value::String(s) => match s.as_str() {
            "true" | "1" => Some(true),
            "false" | "0" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn id_normalizes_numeric_strings() {
        assert_eq!(Id::parse("123"), Id::Num(123));
        assert_eq!(Id::parse(" 123 "), Id::Num(123));
        assert_eq!(Id::parse("g1-c1"), Id::Str("g1-c1".into()));
        assert_eq!(Id::parse(""), Id::Str(String::new()));
    }

    #[test]
    fn id_equality_across_types() {
        assert_eq!(Id::from_value(&json!("123")), Id::from_value(&json!(123)));
        assert_eq!(Id::Num(5), 5i64);
        assert_eq!(Id::Str("all".into()), "all");
    }

    #[test]
    fn null_id_is_none() {
        assert_eq!(Id::from_value(&json!(null)), None);
    }

    #[test]
    fn id_serializes_compactly() {
        assert_eq!(serde_json::to_string(&Id::Num(7)).unwrap(), "7");
        assert_eq!(
            serde_json::to_string(&Id::Str("a-b".into())).unwrap(),
            "\"a-b\""
        );
    }

    #[test]
    fn sender_role_helpers() {
        let sender = Sender::from_value(Some(&json!({"role": "owner", "user_id": "9"})));
        assert!(sender.is_owner());
        assert!(sender.is_admin());
        assert_eq!(sender.user_id, Some(Id::Num(9)));

        let sender = Sender::from_value(Some(&json!({"role": "member"})));
        assert!(!sender.is_admin());
    }

    #[test]
    fn tolerant_getters() {
        let v = json!({"s": 12, "n": "34", "b": "true"});
        assert_eq!(get_str(&v, "s"), "12");
        assert_eq!(get_i64(&v, "n"), Some(34));
        assert_eq!(get_bool(&v, "b"), Some(true));
        assert_eq!(get_str(&v, "missing"), "");
    }

    #[test]
    fn file_info_defaults() {
        let file = FileInfo::from_value(Some(&json!({"id": "f1", "size": 10})));
        assert_eq!(file.id.as_deref(), Some("f1"));
        assert_eq!(file.size, Some(10));
        assert_eq!(FileInfo::from_value(None).name, None);
    }
}
