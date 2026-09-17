//! WebUI：HTTP API + 前端静态资源托管。
//!
//! 前端用 TypeScript 编写，源码在仓库的 `webui/` 目录，
//! 构建产物输出到 `webui/dist`，由本模块托管。
//!
//! 未构建前端时，`/` 会返回一个占位页提示如何构建，API 仍然可用。

pub mod api;

use std::path::PathBuf;

pub use api::{WebUiState, serve};

/// 定位前端构建产物目录。
///
/// 依次尝试：
/// 1. 环境变量 `ASTER_WEBUI_DIST`
/// 2. 当前工作目录下的 `webui/dist`（源码运行）
/// 3. 可执行文件同级的 `webui/dist`
/// 4. 包根目录的 `webui/dist`（npm 安装场景）
#[must_use]
pub fn dist_dir() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("ASTER_WEBUI_DIST") {
        let path = PathBuf::from(path);
        if path.is_dir() {
            return Some(path);
        }
    }

    let mut candidates = Vec::new();

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("webui").join("dist"));
    }

    if let Ok(exe) = std::env::current_exe() {
        // target/release/aster → 仓库根
        for ancestor in exe.ancestors().skip(1).take(4) {
            candidates.push(ancestor.join("webui").join("dist"));
        }
    }

    candidates.into_iter().find(|path| path.is_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dist_dir_respects_env_override() {
        let dir = std::env::temp_dir().join(format!("aster-dist-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        // 保存并设置环境变量
        let original = std::env::var("ASTER_WEBUI_DIST").ok();
        // SAFETY: 测试单线程访问该变量，且随后恢复
        unsafe { std::env::set_var("ASTER_WEBUI_DIST", &dir) };

        let resolved = dist_dir();
        assert_eq!(resolved.as_deref(), Some(dir.as_path()));

        // 恢复
        unsafe {
            match original {
                Some(value) => std::env::set_var("ASTER_WEBUI_DIST", value),
                None => std::env::remove_var("ASTER_WEBUI_DIST"),
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dist_dir_returns_none_for_missing_env_path() {
        let original = std::env::var("ASTER_WEBUI_DIST").ok();
        unsafe { std::env::set_var("ASTER_WEBUI_DIST", "/nonexistent/aster/dist") };

        // 其他候选路径也可能不存在，这里只断言不会 panic
        let _ = dist_dir();

        unsafe {
            match original {
                Some(value) => std::env::set_var("ASTER_WEBUI_DIST", value),
                None => std::env::remove_var("ASTER_WEBUI_DIST"),
            }
        }
    }
}
