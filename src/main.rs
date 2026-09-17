//! Aster 可执行程序入口。
//!
//! 装配与启动逻辑在 [`aster::App`] 中，这里只负责调用。

use anyhow::Result;

fn main() -> Result<()> {
    aster::App::new()?.run()
}
