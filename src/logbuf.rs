//! 内存日志缓冲。
//!
//! WebUI 的日志页需要能回看历史并实时跟踪，而框架本身只往终端打印。
//! 这里在内存里维护一个环形缓冲：
//!
//! * 保留最近 N 条（可配置），供 `GET /api/logs` 回看
//! * 新日志通过 `broadcast` 推给订阅者，供 `GET /api/logs/stream`（SSE）实时跟踪
//!
//! 缓冲只存在于内存，进程退出即消失——落盘交给用户的终端重定向或 journald。

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

/// 默认保留条数
pub const DEFAULT_CAPACITY: usize = 2000;

/// 一条日志
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    /// 自增序号，便于前端去重与增量拉取
    pub seq: u64,
    /// 时间戳（毫秒）
    pub timestamp: i64,
    /// 级别：trace / debug / info / warn / error
    pub level: String,
    /// 来源模块
    pub target: String,
    /// 消息正文（已脱敏）
    pub message: String,
}

/// 日志环形缓冲
#[derive(Debug)]
pub struct LogBuffer {
    entries: Mutex<VecDeque<LogEntry>>,
    tx: broadcast::Sender<LogEntry>,
    capacity: usize,
    seq: Mutex<u64>,
}

impl LogBuffer {
    pub fn new(capacity: usize) -> Arc<Self> {
        let capacity = capacity.max(100);
        let (tx, _) = broadcast::channel(capacity);
        Arc::new(Self {
            entries: Mutex::new(VecDeque::with_capacity(capacity)),
            tx,
            capacity,
            seq: Mutex::new(0),
        })
    }

    /// 追加一条日志
    pub fn push(&self, level: &str, target: &str, message: &str) {
        let seq = {
            let mut seq = self.seq.lock().unwrap_or_else(|e| e.into_inner());
            *seq += 1;
            *seq
        };

        let entry = LogEntry {
            seq,
            timestamp: chrono::Utc::now().timestamp_millis(),
            level: level.to_string(),
            target: target.to_string(),
            message: message.to_string(),
        };

        {
            let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            if entries.len() >= self.capacity {
                entries.pop_front();
            }
            entries.push_back(entry.clone());
        }

        // 没有订阅者时 send 会报错，属于正常情况
        let _ = self.tx.send(entry);
    }

    /// 取最近 `limit` 条；`after_seq` 用于增量拉取
    pub fn tail(&self, limit: usize, after_seq: Option<u64>) -> Vec<LogEntry> {
        let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let iter: Box<dyn Iterator<Item = &LogEntry>> = match after_seq {
            Some(seq) => Box::new(entries.iter().filter(move |e| e.seq > seq)),
            None => Box::new(entries.iter()),
        };
        let all: Vec<LogEntry> = iter.cloned().collect();
        if limit == 0 || all.len() <= limit {
            all
        } else {
            all[all.len() - limit..].to_vec()
        }
    }

    /// 按级别过滤
    pub fn filter_level(&self, min_level: &str, limit: usize) -> Vec<LogEntry> {
        let order = |level: &str| match level {
            "trace" => 0,
            "debug" => 1,
            "info" => 2,
            "warn" => 3,
            "error" => 4,
            _ => 2,
        };
        let threshold = order(min_level);
        let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let filtered: Vec<LogEntry> = entries
            .iter()
            .filter(|e| order(&e.level) >= threshold)
            .cloned()
            .collect();
        if limit == 0 || filtered.len() <= limit {
            filtered
        } else {
            filtered[filtered.len() - limit..].to_vec()
        }
    }

    /// 订阅实时日志
    pub fn subscribe(&self) -> broadcast::Receiver<LogEntry> {
        self.tx.subscribe()
    }

    /// 当前条数
    pub fn len(&self) -> usize {
        self.entries.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// 清空
    pub fn clear(&self) {
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pushes_and_reads_back() {
        let buffer = LogBuffer::new(10);
        buffer.push("info", "aster", "第一条");
        buffer.push("warn", "aster::webui", "第二条");

        let entries = buffer.tail(10, None);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].message, "第一条");
        assert_eq!(entries[1].level, "warn");
        assert_eq!(entries[1].target, "aster::webui");
        assert_eq!(entries[0].seq, 1);
        assert_eq!(entries[1].seq, 2);
    }

    #[test]
    fn evicts_oldest_when_full() {
        let buffer = LogBuffer::new(100); // 内部下限即 100
        for i in 0..150 {
            buffer.push("info", "t", &format!("第{i}条"));
        }
        assert_eq!(buffer.len(), 100);
        let entries = buffer.tail(0, None);
        assert_eq!(entries.first().unwrap().message, "第50条");
        assert_eq!(entries.last().unwrap().message, "第149条");
    }

    #[test]
    fn tail_limit_keeps_newest() {
        let buffer = LogBuffer::new(100);
        for i in 0..20 {
            buffer.push("info", "t", &format!("{i}"));
        }
        let entries = buffer.tail(5, None);
        assert_eq!(entries.len(), 5);
        assert_eq!(entries.last().unwrap().message, "19");
    }

    #[test]
    fn after_seq_returns_only_new() {
        let buffer = LogBuffer::new(100);
        buffer.push("info", "t", "a");
        buffer.push("info", "t", "b");
        let seq = buffer.tail(1, None)[0].seq;
        buffer.push("info", "t", "c");

        let entries = buffer.tail(0, Some(seq));
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].message, "c");
    }

    #[test]
    fn filter_level_works() {
        let buffer = LogBuffer::new(100);
        buffer.push("debug", "t", "d");
        buffer.push("info", "t", "i");
        buffer.push("error", "t", "e");

        assert_eq!(buffer.filter_level("info", 0).len(), 2);
        assert_eq!(buffer.filter_level("error", 0).len(), 1);
        assert_eq!(buffer.filter_level("trace", 0).len(), 3);
    }

    #[test]
    fn clear_empties_buffer() {
        let buffer = LogBuffer::new(100);
        buffer.push("info", "t", "x");
        assert!(!buffer.is_empty());
        buffer.clear();
        assert!(buffer.is_empty());
    }

    #[tokio::test]
    async fn broadcast_delivers_to_subscribers() {
        let buffer = LogBuffer::new(100);
        let mut rx = buffer.subscribe();
        buffer.push("info", "t", "实时消息");

        let entry = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
            .await
            .expect("等待超时")
            .expect("通道关闭");
        assert_eq!(entry.message, "实时消息");
    }

    #[test]
    fn seq_is_monotonic() {
        let buffer = LogBuffer::new(100);
        for _ in 0..10 {
            buffer.push("info", "t", "x");
        }
        let entries = buffer.tail(0, None);
        let seqs: Vec<u64> = entries.iter().map(|e| e.seq).collect();
        let mut sorted = seqs.clone();
        sorted.sort_unstable();
        assert_eq!(seqs, sorted);
        assert_eq!(seqs, (1..=10).collect::<Vec<u64>>());
    }
}
