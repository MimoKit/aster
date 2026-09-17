# 配置参考

配置存放在数据目录的 `config.toml`。首次启动会自动生成带注释的默认配置。

改了配置需要**重启生效**（日志级别与 WebUI 内的部分项除外）。

## 配置文件位置

```text
<数据目录>/config.toml
```

数据目录的确定顺序：

1. 命令行 `--data <目录>`
2. 环境变量 `ASTER_DATA`
3. 当前工作目录

```bash
aster config path        # 直接打印路径
```

## 环境变量

| 变量 | 作用 |
|------|------|
| `ASTER_DATA` | 数据目录 |
| `ASTER_WEBUI_DIST` | 前端构建产物目录（自行定制界面时用） |
| `NO_COLOR` | 设为任意值可关闭终端彩色输出 |

## `[bot]`

```toml
[bot]
name = "Aster"
masters = []
builtin_plugins = true
command_prefix = ""
```

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `name` | string | `"Aster"` | 框架名，只出现在日志里 |
| `masters` | string[] | `[]` | 主人账号。**主人绕过所有权限检查** |
| `builtin_plugins` | bool | `true` | 是否加载内置的 `status` / `echo` 插件 |
| `command_prefix` | string | `""` | 命令强制前缀。留空则命令直接以命令词开头 |

> [!TIP]
> `command_prefix = "#"` 会让规则里的 `command: 'as'` 变成必须发 `#as`。
> 从别的框架迁移过来、习惯了 `#` 前缀的话可以开。

## `[log]`

```toml
[log]
level = "info"
max_length = 4096
show_base64 = false
color = true
```

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `level` | enum | `"info"` | `trace` / `debug` / `info` / `warn` / `error` / `silent` |
| `max_length` | number | `4096` | 单条日志字符串上限，超出会截断并标注原长 |
| `show_base64` | bool | `false` | 是否完整打印 `base64://` 内容（默认折叠） |
| `color` | bool | `true` | 是否输出 ANSI 颜色。重定向到文件时可关掉 |

级别从低到高，设成某一级意味着**只输出该级及以上**：

```text
trace < debug < info < warn < error < silent
```

> [!TIP]
> 排查问题时用 `debug`，它会打印事件分发与插件匹配过程。
> `trace` 会刷得很快，一般只在开发框架本身时用。

## `[onebot11]`

```toml
[onebot11]
enable = true
host = "0.0.0.0"
port = 5310
path = "/onebot/v11/ws"
access_token = ""
trusted_ips = []
heartbeat_timeout = 90
handshake_timeout = 10
request_timeout = 60
```

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `enable` | bool | `true` | 是否启动适配器 |
| `host` | string | `"0.0.0.0"` | 监听地址。同机部署可改 `127.0.0.1` 更安全 |
| `port` | number | `5310` | 监听端口 |
| `path` | string | `"/onebot/v11/ws"` | WS 挂载路径，协议端要填一致 |
| `access_token` | string | `""` | 鉴权 Token，为空则不校验 |
| `trusted_ips` | string[] | `[]` | IP 白名单，为空表示不限制 |
| `heartbeat_timeout` | number | `90` | 多少秒没收到任何数据就断开 |
| `handshake_timeout` | number | `10` | 等待 `lifecycle connect` 的超时 |
| `request_timeout` | number | `60` | 调用 API 等待 `echo` 回执的超时 |

### 关于鉴权

支持两种传法，协议端用哪种都行：

```text
# HTTP 头
Authorization: Bearer <token>

# 查询参数
ws://127.0.0.1:5310/onebot/v11/ws?access_token=<token>
```

> [!WARNING]
> `host = "0.0.0.0"` 且 `access_token = ""` 时，任何能访问该端口的人都能接入并伪装成你的机器人。
> 机器有公网 IP 的话，**要么设 token，要么用 `trusted_ips` 限制来源**。

### 关于端口

`5310` 是非特权端口，普通用户可以绑定。若确实需要 531 这类特权端口，
必须用 `sudo` 或 `setcap` 提权 —— 框架会在启动时明确报错提示。

## `[webui]`

```toml
[webui]
enable = true
host = "127.0.0.1"
port = 5311
access_token = ""
log_capacity = 2000
```

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `enable` | bool | `true` | 是否启动控制台与 HTTP API |
| `host` | string | `"127.0.0.1"` | 监听地址，默认仅本机 |
| `port` | number | `5311` | 监听端口 |
| `access_token` | string | `""` | 访问令牌，为空则不校验 |
| `log_capacity` | number | `2000` | 内存中保留的日志条数 |

> [!WARNING]
> 控制台的权限**等同于机器人本身**：能以任意账号发消息、改配置、读日志。
> 改成 `0.0.0.0` 时**必须**同时设置 `access_token`，否则框架会在启动时警告。
> 远程访问优先考虑 SSH 隧道，见 [部署指南](./deploy.md#远程访问控制台)。

## `[plugin]`

```toml
[plugin]
dir = "plugins"
hot_reload = true
```

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `dir` | string | `"plugins"` | 插件目录，相对数据目录或绝对路径 |
| `hot_reload` | bool | `true` | 文件变化时自动重载 |

> [!NOTE]
> 热重载不监听符号链接指向的目录。插件放在符号链接目录里时，
> 改动不会触发自动重载，但可以手动重启或在 WebUI 里点重载。

## 命令行操作

```bash
aster config                              # 查看全部（点路径展开）
aster config get onebot11.port            # 读单项
aster config set onebot11.port 5312        # 改单项
aster config set log.level debug           # 枚举
aster config set webui.access_token abc    # 字符串
aster config set bot.masters '["123"]'     # 数组，JSON 或逗号分隔都行
aster config path                          # 打印配置文件路径
aster config reset                         # 恢复默认值
aster config template                      # 打印默认配置内容
```

值的类型会按**当前值的类型**自动转换：

```bash
aster config set plugin.hot_reload off    # → false
aster config set webui.port 5312          # → 数字
aster config set bot.masters 1,2,3        # → ["1","2","3"]
```

修改前会先做校验，不合法会直接拒绝并说明原因：

```text
$ aster config set onebot11.port 99999
配置校验失败：
  onebot11 端口非法：99999（应为 0-65535）
```

## 校验规则

框架会检查这些情况，并在启动时打印警告（**不阻断启动**，方便你进 WebUI 改）：

| 情况 | 提示 |
|------|------|
| 端口超出 0-65535 | `端口非法` |
| 端口小于 1024 | `属于特权端口` |
| onebot11 与 webui 端口相同 | `端口相同，无法同时监听` |
| `path` 不以 `/` 开头 | `应以 / 开头` |
| 日志级别拼错 | `log.level 非法` |
| 主人账号不像 QQ 号 | `不像 QQ 号` |
| WebUI 监听 `0.0.0.0` 且无 token | `任何人都能访问控制台` |

## 完整示例

<details>
<summary><b>本机部署 + 主人权限 + 调试日志</b></summary>

```toml
[bot]
name = "我的机器人"
masters = ["123456"]
builtin_plugins = true
command_prefix = ""

[log]
level = "debug"
color = true

[onebot11]
enable = true
host = "127.0.0.1"
port = 5310
path = "/onebot/v11/ws"
access_token = ""

[webui]
enable = true
host = "127.0.0.1"
port = 5311

[plugin]
dir = "plugins"
hot_reload = true
```

</details>

<details>
<summary><b>跨机部署 + 双向鉴权</b></summary>

协议端在 `192.168.1.50`，框架在另一台机器：

```toml
[onebot11]
host = "0.0.0.0"
port = 5310
path = "/onebot/v11/ws"
access_token = "用 openssl rand -hex 24 生成"
trusted_ips = ["192.168.1.50"]
heartbeat_timeout = 120

[webui]
host = "127.0.0.1"          # 控制台仍然只在本机，用 SSH 隧道访问
```

</details>
