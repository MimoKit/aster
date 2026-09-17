//! 日志初始化与内容脱敏。
//!
//! OneBot 的 `base64://` 文件段长度可达数 MB，直接打进日志会刷屏，
//! 因此默认折叠为 `base64://...(N 字节)`，并对超长内容截断。

use std::fmt;
use std::sync::OnceLock;

use anyhow::Result;
use tracing::{Event, Subscriber};
use tracing_subscriber::EnvFilter;
use tracing_subscriber::fmt::{FmtContext, FormatEvent, FormatFields, FormattedFields};
use tracing_subscriber::fmt::format::Writer;
use tracing_subscriber::registry::LookupSpan;

use crate::config::LogConfig;

/// 日志样式配置（进程内一次性设置）
#[derive(Debug, Clone, Copy)]
struct LogStyle {
    max_len: usize,
    show_base64: bool,
}

static STYLE: OnceLock<LogStyle> = OnceLock::new();

fn style() -> LogStyle {
    *STYLE.get_or_init(|| LogStyle {
        max_len: 4096,
        show_base64: false,
    })
}

/// 脱敏：折叠 `base64://` 内容并按需截断
pub fn sanitize(input: &str) -> String {
    let style = style();
    let mut text = if style.show_base64 {
        input.to_string()
    } else {
        collapse_base64(input)
    };

    if text.chars().count() > style.max_len {
        let head: String = text.chars().take(style.max_len).collect();
        let omitted = text.chars().count() - style.max_len;
        text = format!("{head}...(省略 {omitted} 字符)");
    }
    text
}

/// 把 `base64://xxxx` 折叠成 `base64://...(N 字节)`
fn collapse_base64(input: &str) -> String {
    const MARK: &str = "base64://";
    let mut out = String::with_capacity(input.len());
    let mut rest = input;

    while let Some(pos) = rest.find(MARK) {
        out.push_str(&rest[..pos]);
        let after = &rest[pos + MARK.len()..];
        // payload 截止到分隔符
        let end = after
            .find(|c: char| c == '"' || c == ',' || c == ']' || c == '}' || c.is_whitespace())
            .unwrap_or(after.len());
        out.push_str(MARK);
        out.push_str(&format!("...({} 字节)", after[..end].len()));
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

/// 收集事件字段
#[derive(Default)]
struct FieldVisitor {
    message: String,
}

impl tracing::field::Visit for FieldVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn fmt::Debug) {
        if field.name() == "message" {
            self.message = format!("{value:?}");
        } else if self.message.is_empty() {
            self.message = format!("{}={value:?}", field.name());
        } else {
            self.message.push_str(&format!(" {}={value:?}", field.name()));
        }
    }

    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_string();
        } else if self.message.is_empty() {
            self.message = format!("{}={value}", field.name());
        } else {
            self.message.push_str(&format!(" {}={value}", field.name()));
        }
    }
}

/// 自定义事件格式化器：`时间 级别 [目标] 内容`
struct Formatter;

impl<S, N> FormatEvent<S, N> for Formatter
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    N: for<'a> FormatFields<'a> + 'static,
{
    fn format_event(
        &self,
        ctx: &FmtContext<'_, S, N>,
        mut writer: Writer<'_>,
        event: &Event<'_>,
    ) -> fmt::Result {
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let meta = event.metadata();
        let level = *meta.level();

        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);

        // 事件 span 里的字段（如 self_id）附加在最前面
        let mut scope = String::new();
        if let Some(span) = ctx.lookup_current()
            && let Some(fields) = span.extensions().get::<FormattedFields<N>>()
            && !fields.is_empty()
        {
            scope = format!("{{{}}} ", fields);
        }

        writeln!(
            writer,
            "{now} {level:<5} [{target}] {scope}{msg}",
            target = meta.target(),
            msg = sanitize(&visitor.message),
        )
    }
}

/// 初始化日志系统
pub fn setup(config: &LogConfig) -> Result<()> {
    let _ = STYLE.set(LogStyle {
        max_len: config.max_len.max(256),
        show_base64: config.show_base64,
    });

    let filter = EnvFilter::try_new(config.level.trim()).unwrap_or_else(|_| EnvFilter::new("info"));

    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(true)
        .event_format(Formatter)
        .try_init();

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapses_base64_payload() {
        let raw = r#"{"file":"base64://AAAABBBBCCCC","name":"a.png"}"#;
        let out = collapse_base64(raw);
        assert!(out.contains("base64://...(12 字节)"));
        assert!(!out.contains("AAAABBBBCCCC"));
    }

    #[test]
    fn keeps_short_text_intact() {
        assert_eq!(collapse_base64("hello world"), "hello world");
    }

    #[test]
    fn multiple_base64_occurrences() {
        let raw = "a base64://AAAA b base64://BBBBBB c";
        let out = collapse_base64(raw);
        assert_eq!(out.matches("base64://...").count(), 2);
    }
}
