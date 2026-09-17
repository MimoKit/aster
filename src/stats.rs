//! 运行时统计。
//!
//! 记录框架自启动以来的事件计数与运行时长，供状态类插件查询。
//! 全部使用原子操作，读循环与插件线程可以无锁并发访问。

use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use chrono::{DateTime, Local};

use crate::event::Event;

/// 运行时统计快照
#[derive(Debug, Clone)]
pub struct StatsSnapshot {
    pub version: &'static str,
    pub started_at: DateTime<Local>,
    pub uptime: Duration,
    pub events: u64,
    pub messages: u64,
    pub notices: u64,
    pub requests: u64,
    pub meta_events: u64,
    /// 命中插件规则并执行的次数
    pub commands: u64,
    /// 已加载的插件数
    pub plugins: usize,
}

impl StatsSnapshot {
    /// 运行时长的人类可读形式，如 `1天2小时3分4秒`
    pub fn uptime_text(&self) -> String {
        human_duration(self.uptime)
    }

    /// 启动时间文本
    pub fn started_text(&self) -> String {
        self.started_at.format("%Y-%m-%d %H:%M:%S").to_string()
    }
}

/// 全局统计
#[derive(Debug)]
pub struct Stats {
    started: Instant,
    started_at: DateTime<Local>,
    events: AtomicU64,
    messages: AtomicU64,
    notices: AtomicU64,
    requests: AtomicU64,
    meta_events: AtomicU64,
    commands: AtomicU64,
    plugins: AtomicI64,
}

impl Default for Stats {
    fn default() -> Self {
        Self::new()
    }
}

impl Stats {
    pub fn new() -> Self {
        Self {
            started: Instant::now(),
            started_at: Local::now(),
            events: AtomicU64::new(0),
            messages: AtomicU64::new(0),
            notices: AtomicU64::new(0),
            requests: AtomicU64::new(0),
            meta_events: AtomicU64::new(0),
            commands: AtomicU64::new(0),
            plugins: AtomicI64::new(0),
        }
    }

    /// 记录一个事件
    pub fn record_event(&self, event: &Event) {
        self.events.fetch_add(1, Ordering::Relaxed);
        match event {
            Event::Message(_) | Event::MessageSent(_) => {
                self.messages.fetch_add(1, Ordering::Relaxed);
            }
            Event::Notice(_) => {
                self.notices.fetch_add(1, Ordering::Relaxed);
            }
            Event::Request(_) => {
                self.requests.fetch_add(1, Ordering::Relaxed);
            }
            Event::Meta(_) => {
                self.meta_events.fetch_add(1, Ordering::Relaxed);
            }
            Event::Unknown { .. } => {}
        }
    }

    /// 记录一次命令命中
    pub fn record_command(&self) {
        self.commands.fetch_add(1, Ordering::Relaxed);
    }

    /// 设置已加载插件数
    pub fn set_plugins(&self, count: usize) {
        self.plugins.store(count as i64, Ordering::Relaxed);
    }

    /// 运行时长
    pub fn uptime(&self) -> Duration {
        self.started.elapsed()
    }

    /// 生成快照
    pub fn snapshot(&self) -> StatsSnapshot {
        StatsSnapshot {
            version: env!("CARGO_PKG_VERSION"),
            started_at: self.started_at,
            uptime: self.uptime(),
            events: self.events.load(Ordering::Relaxed),
            messages: self.messages.load(Ordering::Relaxed),
            notices: self.notices.load(Ordering::Relaxed),
            requests: self.requests.load(Ordering::Relaxed),
            meta_events: self.meta_events.load(Ordering::Relaxed),
            commands: self.commands.load(Ordering::Relaxed),
            plugins: self.plugins.load(Ordering::Relaxed).max(0) as usize,
        }
    }
}

/// 把时长格式化成 `1天2小时3分4秒`
pub fn human_duration(duration: Duration) -> String {
    let total = duration.as_secs();
    let days = total / 86_400;
    let hours = (total % 86_400) / 3_600;
    let minutes = (total % 3_600) / 60;
    let seconds = total % 60;

    let mut parts = Vec::new();
    if days > 0 {
        parts.push(format!("{days}天"));
    }
    if hours > 0 || days > 0 {
        parts.push(format!("{hours}小时"));
    }
    if minutes > 0 || hours > 0 || days > 0 {
        parts.push(format!("{minutes}分"));
    }
    parts.push(format!("{seconds}秒"));
    parts.concat()
}

/// 把字节数格式化成人类可读形式
pub fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn records_event_types() {
        let stats = Stats::new();
        stats.record_event(&Event::from_value(json!({
            "post_type": "message", "message_type": "group", "sub_type": "normal",
            "time": 1, "self_id": 1, "message_id": 1, "user_id": 2, "group_id": 3, "message": "hi"
        })));
        stats.record_event(&Event::from_value(json!({
            "post_type": "notice", "notice_type": "friend_add", "time": 1, "self_id": 1, "user_id": 2
        })));
        stats.record_event(&Event::from_value(json!({
            "post_type": "request", "request_type": "friend", "time": 1, "self_id": 1,
            "user_id": 2, "comment": "", "flag": "f"
        })));
        stats.record_event(&Event::from_value(json!({
            "post_type": "meta_event", "meta_event_type": "heartbeat", "time": 1, "self_id": 1
        })));

        let snap = stats.snapshot();
        assert_eq!(snap.events, 4);
        assert_eq!(snap.messages, 1);
        assert_eq!(snap.notices, 1);
        assert_eq!(snap.requests, 1);
        assert_eq!(snap.meta_events, 1);
    }

    #[test]
    fn records_message_sent_as_message() {
        let stats = Stats::new();
        stats.record_event(&Event::from_value(json!({
            "post_type": "message_sent", "message_type": "private", "sub_type": "friend",
            "time": 1, "self_id": 1, "message_id": 1, "user_id": 2, "message": "x"
        })));
        assert_eq!(stats.snapshot().messages, 1);
    }

    #[test]
    fn command_and_plugin_counters() {
        let stats = Stats::new();
        stats.record_command();
        stats.record_command();
        stats.set_plugins(3);
        let snap = stats.snapshot();
        assert_eq!(snap.commands, 2);
        assert_eq!(snap.plugins, 3);
    }

    #[test]
    fn duration_formatting() {
        assert_eq!(human_duration(Duration::from_secs(5)), "5秒");
        assert_eq!(human_duration(Duration::from_secs(90)), "1分30秒");
        assert_eq!(human_duration(Duration::from_secs(3661)), "1小时1分1秒");
        assert_eq!(human_duration(Duration::from_secs(90_061)), "1天1小时1分1秒");
        assert_eq!(human_duration(Duration::from_secs(0)), "0秒");
    }

    #[test]
    fn byte_formatting() {
        assert_eq!(human_bytes(512), "512 B");
        assert_eq!(human_bytes(2048), "2.0 KB");
        assert_eq!(human_bytes(5 * 1024 * 1024), "5.0 MB");
    }

    #[test]
    fn snapshot_has_version() {
        let snap = Stats::new().snapshot();
        assert!(!snap.version.is_empty());
        assert!(!snap.started_text().is_empty());
    }
}
