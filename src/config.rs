//! 配置加载。
//!
//! 首次运行时把 `config/default.toml` 复制到工作目录下的 `config.toml`，
//! 已存在则不覆盖；`config.toml` 中缺失的字段会回退到默认值。
//!
//! 环境变量覆盖（优先级最高）：
//!
//! | 变量 | 作用 |
//! |------|------|
//! | `ASTER_HOST` | OneBot v11 监听地址 |
//! | `ASTER_PORT` | OneBot v11 监听端口 |
//! | `ASTER_TOKEN` | 鉴权 Token |

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// 顶层配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub bot: BotConfig,
    pub log: LogConfig,
    pub onebot11: OneBot11Config,
    pub webui: WebUiConfig,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            bot: BotConfig::default(),
            log: LogConfig::default(),
            onebot11: OneBot11Config::default(),
            webui: WebUiConfig::default(),
        }
    }
}

/// WebUI 配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct WebUiConfig {
    /// 是否启用 WebUI 与 HTTP API
    pub enable: bool,
    /// 监听地址
    pub host: String,
    /// 监听端口
    pub port: u16,
    /// 访问令牌，为空则不校验（仅建议在本机使用）
    pub access_token: String,
    /// 内存中保留的日志条数
    pub log_capacity: usize,
}

impl Default for WebUiConfig {
    fn default() -> Self {
        Self {
            enable: true,
            host: "127.0.0.1".into(),
            port: 5311,
            access_token: String::new(),
            log_capacity: crate::logbuf::DEFAULT_CAPACITY,
        }
    }
}

impl WebUiConfig {
    /// 是否需要鉴权
    pub fn auth_required(&self) -> bool {
        !self.access_token.is_empty()
    }

    /// 监听地址字符串
    pub fn bind_addr(&self) -> String {
        if self.host.contains(':') && !self.host.starts_with('[') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }

    /// 访问地址（用于日志提示）
    pub fn display_url(&self) -> String {
        let host = if self.host == "0.0.0.0" || self.host == "::" {
            "127.0.0.1"
        } else {
            &self.host
        };
        let host = if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]")
        } else {
            host.to_string()
        };
        format!("http://{host}:{}", self.port)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct BotConfig {
    /// 框架名，用于日志
    pub name: String,
    /// 机器人主人账号，拥有全部插件权限
    pub masters: Vec<String>,
    /// 是否加载内置插件（状态查询等）
    pub builtin_plugins: bool,
    /// 命令强制前缀，留空表示命令直接以命令词开头（如 `as`）
    pub command_prefix: String,
}

impl Default for BotConfig {
    fn default() -> Self {
        Self {
            name: "Aster".into(),
            masters: Vec::new(),
            builtin_plugins: true,
            command_prefix: String::new(),
        }
    }
}

impl BotConfig {
    /// 主人账号列表（已归一为 [`crate::event::Id`]）
    pub fn master_ids(&self) -> Vec<crate::event::Id> {
        self.masters
            .iter()
            .map(|s| crate::event::Id::parse(s.trim()))
            .collect()
    }

    /// 指定账号是否为主人
    ///
    /// 比较时忽略 ID 的数字/字符串类型差异。
    pub fn is_master(&self, user_id: &crate::event::Id) -> bool {
        self.master_ids().iter().any(|id| id.same(user_id))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct LogConfig {
    /// trace | debug | info | warn | error | off
    pub level: String,
    /// 单条日志字符串上限
    pub max_len: usize,
    /// 是否打印完整 base64 内容
    pub show_base64: bool,
}

impl Default for LogConfig {
    fn default() -> Self {
        Self {
            level: "info".into(),
            max_len: 4096,
            show_base64: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct OneBot11Config {
    pub enable: bool,
    /// 监听地址
    pub host: String,
    /// 监听端口（默认 5310，`0531` 为特权端口需提权）
    pub port: u16,
    /// WebSocket 挂载路径
    pub path: String,
    /// 鉴权 Token，空表示不校验
    pub access_token: String,
    /// 允许的客户端 IP，空表示不限制
    pub trusted_ips: Vec<String>,
    /// 心跳超时（秒）
    pub heartbeat_timeout: u64,
    /// 握手超时（秒）
    pub handshake_timeout: u64,
    /// API 请求超时（秒）
    pub request_timeout: u64,
}

impl Default for OneBot11Config {
    fn default() -> Self {
        Self {
            enable: true,
            host: "0.0.0.0".into(),
            port: 5310,
            path: "/onebot/v11/ws".into(),
            access_token: String::new(),
            trusted_ips: Vec::new(),
            heartbeat_timeout: 90,
            handshake_timeout: 10,
            request_timeout: 60,
        }
    }
}

impl OneBot11Config {
    /// 规范化后的挂载路径：一定有前导 `/`，且不以 `/` 结尾
    pub fn normalized_path(&self) -> String {
        let mut p = self.path.trim().to_string();
        if !p.starts_with('/') {
            p.insert(0, '/');
        }
        while p.len() > 1 && p.ends_with('/') {
            p.pop();
        }
        if p.is_empty() {
            p.push('/');
        }
        p
    }

    /// 是否需要鉴权
    pub fn auth_required(&self) -> bool {
        !self.access_token.is_empty()
    }

    /// 客户端 IP 是否被允许
    pub fn is_trusted(&self, ip: &str) -> bool {
        if self.trusted_ips.is_empty() {
            return true;
        }
        self.trusted_ips.iter().any(|allowed| {
            let allowed = allowed.trim();
            allowed == "*" || allowed == ip || allowed == "0.0.0.0"
        })
    }

    /// 监听地址字符串
    pub fn bind_addr(&self) -> String {
        if self.host.contains(':') && !self.host.starts_with('[') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

/// 默认配置文件路径
pub const DEFAULT_FILE: &str = "config/default.toml";
/// 运行时配置文件路径
pub const RUNTIME_FILE: &str = "config.toml";

impl Config {
    /// 加载配置：确保运行期文件存在，再读取并套用环境变量
    pub fn load() -> Result<Self> {
        Self::load_from(Path::new(RUNTIME_FILE))
    }

    /// 从指定路径加载配置
    pub fn load_from(path: &Path) -> Result<Self> {
        Self::ensure_file(path)?;
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("读取配置文件 {} 失败", path.display()))?;
        let mut config: Config = toml::from_str(&text)
            .with_context(|| format!("解析配置文件 {} 失败", path.display()))?;
        config.apply_env();
        Ok(config)
    }

    /// 若运行期配置不存在，则从默认配置复制一份
    pub fn ensure_file(path: &Path) -> Result<()> {
        if path.exists() {
            return Ok(());
        }
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("创建配置目录 {} 失败", parent.display()))?;
        }
        let template = PathBuf::from(DEFAULT_FILE);
        if template.exists() {
            std::fs::copy(&template, path).with_context(|| {
                format!(
                    "复制默认配置 {} → {} 失败",
                    template.display(),
                    path.display()
                )
            })?;
            tracing::info!("已生成配置文件 {}", path.display());
        } else {
            // 找不到模板时写出一份默认配置
            let default_text = toml::to_string_pretty(&Config::default())?;
            std::fs::write(path, default_text)
                .with_context(|| format!("写入配置文件 {} 失败", path.display()))?;
            tracing::info!("默认配置模板缺失，已写出内置配置 {}", path.display());
        }
        Ok(())
    }

    /// 环境变量覆盖
    fn apply_env(&mut self) {
        if let Ok(host) = std::env::var("ASTER_HOST")
            && !host.trim().is_empty()
        {
            self.onebot11.host = host;
        }
        if let Ok(port) = std::env::var("ASTER_PORT")
            && let Ok(port) = port.trim().parse::<u16>()
        {
            self.onebot11.port = port;
        }
        if let Ok(token) = std::env::var("ASTER_TOKEN") {
            self.onebot11.access_token = token;
        }
        if let Ok(level) = std::env::var("ASTER_LOG") {
            self.log.level = level;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_values() {
        let config = Config::default();
        assert_eq!(config.onebot11.port, 5310);
        assert!(config.onebot11.enable);
        assert!(!config.onebot11.auth_required());
        assert_eq!(config.onebot11.normalized_path(), "/onebot/v11/ws");
    }

    #[test]
    fn path_normalization() {
        let mut config = OneBot11Config::default();
        config.path = "onebot/v11/ws/".into();
        assert_eq!(config.normalized_path(), "/onebot/v11/ws");
        config.path = "/".into();
        assert_eq!(config.normalized_path(), "/");
    }

    #[test]
    fn trusted_ip_rules() {
        let mut config = OneBot11Config::default();
        assert!(config.is_trusted("1.2.3.4"), "空列表表示不限制");
        config.trusted_ips = vec!["127.0.0.1".into()];
        assert!(config.is_trusted("127.0.0.1"));
        assert!(!config.is_trusted("1.2.3.4"));
        config.trusted_ips = vec!["*".into()];
        assert!(config.is_trusted("1.2.3.4"));
    }

    #[test]
    fn parse_partial_toml() {
        let config: Config = toml::from_str(
            r#"
            [onebot11]
            port = 531
            access_token = "secret"
            "#,
        )
        .unwrap();
        assert_eq!(config.onebot11.port, 531);
        assert!(config.onebot11.auth_required());
        // 其他字段回退默认
        assert_eq!(config.onebot11.path, "/onebot/v11/ws");
        assert_eq!(config.bot.name, "Aster");
    }

    #[test]
    fn bind_addr_with_ipv6() {
        let mut config = OneBot11Config::default();
        config.host = "::1".into();
        assert_eq!(config.bind_addr(), "[::1]:5310");
        config.host = "127.0.0.1".into();
        assert_eq!(config.bind_addr(), "127.0.0.1:5310");
    }

    #[test]
    fn master_ids_are_normalized() {
        let config = BotConfig {
            masters: vec!["123".into(), " 456 ".into()],
            ..BotConfig::default()
        };
        let ids = config.master_ids();
        assert_eq!(ids.len(), 2);
        assert_eq!(ids[0], crate::event::Id::Num(123));
        // 前后空白被裁剪
        assert_eq!(ids[1], crate::event::Id::Num(456));
    }

    #[test]
    fn is_master_matches_across_types() {
        let config = BotConfig {
            masters: vec!["123".into()],
            ..BotConfig::default()
        };
        assert!(config.is_master(&crate::event::Id::Num(123)));
        assert!(config.is_master(&crate::event::Id::Str("123".into())));
        assert!(!config.is_master(&crate::event::Id::Num(999)));
    }

    #[test]
    fn empty_masters_by_default() {
        let config = BotConfig::default();
        assert!(config.masters.is_empty());
        assert!(config.master_ids().is_empty());
        assert!(config.builtin_plugins);
    }

    #[test]
    fn parse_masters_from_toml() {
        let config: Config = toml::from_str(
            r#"
            [bot]
            masters = ["10001", "10002"]
            "#,
        )
        .unwrap();
        assert_eq!(config.bot.masters.len(), 2);
        assert!(config.bot.is_master(&crate::event::Id::Num(10001)));
    }
}
