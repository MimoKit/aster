# 更新日志

本项目的所有重要变更都会记录在这里。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-09-17

**用 TypeScript 重写了整个框架。**

这一版把内核从 Rust 换成了 TypeScript，起因是插件开发体验：Rust 插件每改一行都要重新
编译，而这恰恰是写机器人时最高频的操作。换成 TS 之后，插件是普通的 `.ts` 文件，
**改完存盘立即生效**。

### 新增

- **运行时插件加载**：插件目录下的 `.ts` / `.js` 文件自动加载，无需构建
  - `definePlugin` 在**加载期**校验名称、匹配方式、权限、正则语法
  - 单文件出错只影响该插件，原因记录在 `aster plugin` 的输出里
- **插件热重载**：基于 `fs.watch` 监听插件目录，200ms 防抖后重新加载
  - 多个插件目录各起一个 watcher
  - 可在 WebUI 插件页手动触发重载
- **完整的类型定义**：`strict` + `noUncheckedIndexedAccess` 全开，
  事件、配置、插件上下文都有类型，编辑器可直接补全
- **插件开发 API**
  - 六种匹配方式：`command`（词边界）、`prefix`、`exact`、`regex`、`contains`、`any`
  - 四级权限：`all` / `master` / `admin` / `owner`
  - 三种范围：`any` / `group` / `private`
  - 上下文提供 `reply` / `replyAt` / `replyQuote` / `call` / `log` / `status`
  - 消息段构造器 `seg.text` / `seg.at` / `seg.image` / `seg.node` 等
- **配置校验**：端口范围、端口冲突、路径格式、日志级别、主人账号格式、
  WebUI 暴露但无 token 等情况会在启动时给出可操作的提示
- **WebUI 接口层**：HTTP API + SSE 实时日志与事件流，与前端配套
- 命令行新增 `plugin` 子命令，可列出插件与加载失败原因

### 变更

- **运行方式**：不再需要 Rust 工具链，`aster` 直接在当前 Node 进程内运行
  - 安装后立即可用，没有首次编译等待
  - 运行时依赖只有 3 个：`ws`、`jiti`、`smol-toml`
- **配置项**：`log.max_len` 更名为 `log.max_length`，新增 `log.color`
- **端口**：`onebot11.port` 默认仍是 `5310`，`webui.port` 默认仍是 `5311`
- **API 响应字段**：内部接口统一为 camelCase（如 `self_id` → `selfId`）
- **Node 版本要求**：`>=20.11`（原为 18.17）

### 移除

- Rust 内核（`src/**/*.rs`、`Cargo.toml`、`Cargo.lock`）
- 编译期 Rust 插件系统
- `prepack` 的版本一致性检查脚本

### 修复

- **端口被占用时不再静默挂起**：改为立即报错退出，并提示排查命令
- **协议端重连后无法发送消息**：`Bot` 句柄不再绑定具体连接，每次调用从注册表取当前连接
- **端口配为 0 时对外给出的地址错误**：改为读回系统实际分配的端口
- **多个插件目录只有第一个被监听**
- **数据目录的 `plugins/` 不存在时不会被监听**：启动时自动创建

### 迁移

从 Rust 版本升级：

1. 插件需要改用 TypeScript 重写，见 [插件开发](./docs/plugin.md)
2. `config.toml` 里的 `log.max_len` 改名 `log.max_length`
3. 其余配置项保持兼容，无需改动

```bash
npm install -g aster-bot@latest
```

## [0.0.5] - 2026-09-17

### 修复

- 配置模板补充 `[webui]` 段，此前用户生成的配置里看不到 WebUI 选项

## [0.0.4] - 2026-09-17

### 新增

- TypeScript 编写的 WebUI（总览 / 连接 / 插件 / 市场 / 发送台 / 日志 / 配置）
- HTTP API 层与内存日志环形缓冲

### 修复

- WebUI 构建产物未打入 npm 包

## [0.0.3] - 2026-09-17

### 修复

- 端口被占用时静默挂起

## [0.0.2] - 2026-09-17

### 新增

- 插件系统：命令匹配、优先级、权限、范围
- 内置 `as` 状态查询插件

## [0.0.1] - 2026-09-17

### 新增

- 首个版本：OneBot v11 反向 WebSocket 适配器
- 消息字段规范化与事件归一化
- 基于 `echo` 的 API 请求-响应关联
- 命令行管理（`start` / `config` / `init`）

[0.1.0]: https://github.com/MimoKit/aster/compare/v0.0.5...v0.1.0
[0.0.5]: https://github.com/MimoKit/aster/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/MimoKit/aster/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/MimoKit/aster/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/MimoKit/aster/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/MimoKit/aster/releases/tag/v0.0.1
