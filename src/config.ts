/**
 * 配置管理。
 *
 * 磁盘上是 TOML（便于手改与加注释），内存里是 camelCase 的类型化对象。
 * 首次运行会生成带注释的默认配置，不会覆盖已有文件。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { parse, stringify } from 'smol-toml';

/* ─────────────────────────── 类型 ─────────────────────────── */

export interface BotConfig {
  /** 框架名，用于日志 */
  name: string;
  /** 主人账号，拥有全部插件权限 */
  masters: string[];
  /** 是否加载内置插件 */
  builtinPlugins: boolean;
  /** 命令强制前缀，留空则命令直接以命令词开头 */
  commandPrefix: string;
}

export interface LogConfig {
  /** trace | debug | info | warn | error | silent */
  level: string;
  /** 单条日志字符串上限 */
  maxLength: number;
  /** 是否打印完整 base64 内容 */
  showBase64: boolean;
  /** 是否输出 ANSI 颜色 */
  color: boolean;
}

export interface Onebot11Config {
  enable: boolean;
  host: string;
  port: number;
  path: string;
  /** 鉴权 Token，为空则不校验 */
  accessToken: string;
  /** 允许连接的 IP，空表示不限制 */
  trustedIps: string[];
  /** 心跳超时（秒） */
  heartbeatTimeout: number;
  /** 握手超时（秒） */
  handshakeTimeout: number;
  /** API 调用超时（秒） */
  requestTimeout: number;
}

export interface WebUiConfig {
  enable: boolean;
  host: string;
  port: number;
  accessToken: string;
  /** 内存中保留的日志条数 */
  logCapacity: number;
}

export interface PluginConfig {
  /** 用户插件目录，相对数据目录或绝对路径 */
  dir: string;
  /** 文件变化时自动重载 */
  hotReload: boolean;
}

export interface AsterConfig {
  bot: BotConfig;
  log: LogConfig;
  onebot11: Onebot11Config;
  webui: WebUiConfig;
  plugin: PluginConfig;
}

/* ─────────────────────────── 默认值 ─────────────────────────── */

export function defaultConfig(): AsterConfig {
  return {
    bot: {
      name: 'Aster',
      masters: [],
      builtinPlugins: true,
      commandPrefix: '',
    },
    log: {
      level: 'info',
      maxLength: 4096,
      showBase64: false,
      color: true,
    },
    onebot11: {
      enable: true,
      host: '0.0.0.0',
      port: 5310,
      path: '/onebot/v11/ws',
      accessToken: '',
      trustedIps: [],
      heartbeatTimeout: 90,
      handshakeTimeout: 10,
      requestTimeout: 60,
    },
    webui: {
      enable: true,
      host: '127.0.0.1',
      port: 5311,
      accessToken: '',
      logCapacity: 2000,
    },
    plugin: {
      dir: 'plugins',
      hotReload: true,
    },
  };
}

/** 默认配置文件内容（带注释，首次运行写出） */
export const DEFAULT_CONFIG_TOML = `# Aster 配置
# 首次运行自动生成，可放心修改；删除本文件会重新生成默认值。

[bot]
# 框架名，出现在日志里
name = "Aster"
# 主人账号，拥有所有插件权限
masters = []
# 是否加载内置插件（status 等）
builtin_plugins = true
# 命令强制前缀，留空则命令直接以命令词开头（如 as）
# 想要 #as 风格就填 "#"
command_prefix = ""

[log]
# trace | debug | info | warn | error | silent
level = "info"
# 单条日志字符串上限
max_length = 4096
# 是否打印完整 base64:// 内容（默认折叠，避免刷屏）
show_base64 = false
# 是否输出 ANSI 颜色（重定向到文件时可关掉）
color = true

[onebot11]
enable = true
# 监听地址，0.0.0.0 表示所有网卡
host = "0.0.0.0"
# 监听端口，协议端反向连接这个端口
port = 5310
# WebSocket 挂载路径
path = "/onebot/v11/ws"
# 鉴权 Token，为空则不校验（对外暴露时务必设置）
access_token = ""
# 允许连接的适配器 IP，为空表示不限制
trusted_ips = []
# 心跳超时（秒），超时未收到任何数据则断开
heartbeat_timeout = 90
# 等待协议端上报 lifecycle 事件的超时（秒）
handshake_timeout = 10
# API 调用等待 echo 回执的超时（秒）
request_timeout = 60

[webui]
# 是否启用网页控制台与 HTTP API
enable = true
# 监听地址，默认仅本机可访问
host = "127.0.0.1"
# 监听端口，浏览器访问 http://host:port
port = 5311
# 访问令牌，为空则不校验（对外暴露时务必设置）
access_token = ""
# 内存中保留的日志条数，供日志页回看
log_capacity = 2000

[plugin]
# 用户插件目录，相对数据目录或绝对路径
dir = "plugins"
# 文件变化时自动重载，改完存盘即生效
hot_reload = true
`;

/* ─────────────────────────── TOML ↔ 对象 ─────────────────────────── */

/** 把 TOML 里的 snake_case 映射到配置对象 */
function fromToml(raw: Record<string, unknown>): AsterConfig {
  const base = defaultConfig();
  const section = (key: string): Record<string, unknown> => {
    const value = raw[key];
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  };

  const bot = section('bot');
  const log = section('log');
  const ob = section('onebot11');
  const webui = section('webui');
  const plugin = section('plugin');

  const pick = <T>(value: unknown, fallback: T): T =>
    value === undefined ? fallback : (value as T);

  return {
    bot: {
      name: pick(bot.name, base.bot.name),
      masters: pick(bot.masters, base.bot.masters),
      builtinPlugins: pick(bot.builtin_plugins, base.bot.builtinPlugins),
      commandPrefix: pick(bot.command_prefix, base.bot.commandPrefix),
    },
    log: {
      level: pick(log.level, base.log.level),
      maxLength: pick(log.max_length, base.log.maxLength),
      showBase64: pick(log.show_base64, base.log.showBase64),
      color: pick(log.color, base.log.color),
    },
    onebot11: {
      enable: pick(ob.enable, base.onebot11.enable),
      host: pick(ob.host, base.onebot11.host),
      port: pick(ob.port, base.onebot11.port),
      path: pick(ob.path, base.onebot11.path),
      accessToken: pick(ob.access_token, base.onebot11.accessToken),
      trustedIps: pick(ob.trusted_ips, base.onebot11.trustedIps),
      heartbeatTimeout: pick(ob.heartbeat_timeout, base.onebot11.heartbeatTimeout),
      handshakeTimeout: pick(ob.handshake_timeout, base.onebot11.handshakeTimeout),
      requestTimeout: pick(ob.request_timeout, base.onebot11.requestTimeout),
    },
    webui: {
      enable: pick(webui.enable, base.webui.enable),
      host: pick(webui.host, base.webui.host),
      port: pick(webui.port, base.webui.port),
      accessToken: pick(webui.access_token, base.webui.accessToken),
      logCapacity: pick(webui.log_capacity, base.webui.logCapacity),
    },
    plugin: {
      dir: pick(plugin.dir, base.plugin.dir),
      hotReload: pick(plugin.hot_reload, base.plugin.hotReload),
    },
  };
}

/** 把配置对象转回 TOML 结构 */
function toToml(config: AsterConfig): Record<string, unknown> {
  return {
    bot: {
      name: config.bot.name,
      masters: config.bot.masters,
      builtin_plugins: config.bot.builtinPlugins,
      command_prefix: config.bot.commandPrefix,
    },
    log: {
      level: config.log.level,
      max_length: config.log.maxLength,
      show_base64: config.log.showBase64,
      color: config.log.color,
    },
    onebot11: {
      enable: config.onebot11.enable,
      host: config.onebot11.host,
      port: config.onebot11.port,
      path: config.onebot11.path,
      access_token: config.onebot11.accessToken,
      trusted_ips: config.onebot11.trustedIps,
      heartbeat_timeout: config.onebot11.heartbeatTimeout,
      handshake_timeout: config.onebot11.handshakeTimeout,
      request_timeout: config.onebot11.requestTimeout,
    },
    webui: {
      enable: config.webui.enable,
      host: config.webui.host,
      port: config.webui.port,
      access_token: config.webui.accessToken,
      log_capacity: config.webui.logCapacity,
    },
    plugin: {
      dir: config.plugin.dir,
      hot_reload: config.plugin.hotReload,
    },
  };
}

/* ─────────────────────────── 读写 ─────────────────────────── */

export interface LoadedConfig {
  config: AsterConfig;
  /** 配置文件绝对路径 */
  path: string;
  /** 数据目录 */
  dir: string;
  /** 本次是否新生成 */
  created: boolean;
}

/**
 * 加载配置。
 *
 * 文件不存在时写出带注释的默认配置再读取，保证磁盘上的内容与内存一致。
 */
export function loadConfig(dir: string): LoadedConfig {
  const base = resolve(dir);
  const file = join(base, 'config.toml');

  if (!existsSync(base)) mkdirSync(base, { recursive: true });

  if (!existsSync(file)) {
    writeFileSync(file, DEFAULT_CONFIG_TOML, 'utf8');
    return { config: defaultConfig(), path: file, dir: base, created: true };
  }

  const text = readFileSync(file, 'utf8');
  let parsed: Record<string, unknown>;
  try {
    parsed = parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`解析 ${file} 失败：${(err as Error).message}`);
  }

  return { config: fromToml(parsed), path: file, dir: base, created: false };
}

/** 保存配置 */
export function saveConfig(loaded: LoadedConfig, config: AsterConfig): void {
  const text = stringify(toToml(config));
  if (!existsSync(dirname(loaded.path))) mkdirSync(dirname(loaded.path), { recursive: true });
  writeFileSync(loaded.path, text, 'utf8');
}

/* ─────────────────────────── 校验 ─────────────────────────── */

/**
 * 校验配置，返回问题列表。
 *
 * 只报告能用一句话说清、且用户能自己修的问题。
 */
export function validateConfig(config: AsterConfig): string[] {
  const problems: string[] = [];

  const checkPort = (label: string, port: number): void => {
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      problems.push(`${label} 端口非法：${port}（应为 0-65535）`);
    } else if (port > 0 && port < 1024) {
      problems.push(`${label} 端口 ${port} 属于特权端口，普通用户无法绑定，建议改用 5310/5311`);
    }
  };

  checkPort('onebot11', config.onebot11.port);
  checkPort('webui', config.webui.port);

  if (config.onebot11.enable && config.webui.enable && config.onebot11.port === config.webui.port) {
    problems.push('onebot11 与 webui 端口相同，无法同时监听');
  }

  if (!config.onebot11.path.startsWith('/')) {
    problems.push(`onebot11.path 应以 / 开头，当前为：${config.onebot11.path}`);
  }

  const levels = ['trace', 'debug', 'info', 'warn', 'error', 'silent'];
  if (!levels.includes(config.log.level)) {
    problems.push(`log.level 非法：${config.log.level}（可选 ${levels.join(' / ')}）`);
  }

  for (const master of config.bot.masters) {
    if (!/^\d+$/.test(String(master))) {
      problems.push(`bot.masters 里的 ${master} 不像 QQ 号`);
    }
  }

  // 对外暴露却没设 token 是高危配置，必须提醒
  const exposed = (host: string): boolean => host === '0.0.0.0' || host === '::';
  // WebUI 暴露在公网且无 token 属于高危：控制台能以机器人身份发消息、改配置
  if (exposed(config.webui.host) && config.webui.accessToken.length === 0) {
    problems.push('webui 监听 0.0.0.0 但未设置 access_token，任何人都能访问控制台');
  }
  // onebot11 默认就监听 0.0.0.0（协议端常在同机），这里不重复告警——
  // 监听成功时 OneBot11Server 会自己提示一次，避免每次启动看到两条一样的警告

  return problems;
}

/* ─────────────────────────── 点路径访问 ─────────────────────────── */

/** 按点路径读取，如 `onebot11.port` */
export function getByPath(config: AsterConfig, path: string): unknown {
  let cursor: unknown = config;
  for (const key of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/** 按点路径写入，返回新对象 */
export function setByPath(config: AsterConfig, path: string, value: unknown): AsterConfig {
  const next = structuredClone(config) as unknown as Record<string, unknown>;
  const keys = path.split('.').filter(Boolean);
  if (keys.length === 0) throw new Error('配置键不能为空');

  let cursor: Record<string, unknown> = next;
  for (const key of keys.slice(0, -1)) {
    const child = cursor[key];
    if (typeof child !== 'object' || child === null || Array.isArray(child)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[keys[keys.length - 1] as string] = value;
  return next as unknown as AsterConfig;
}

/** 解析插件目录：相对路径按数据目录展开 */
export function resolvePluginDir(dir: string, dataDir: string): string {
  return isAbsolute(dir) ? dir : join(dataDir, dir);
}

/** 规范化的 WS 路径：一定有前导 `/`，不以 `/` 结尾 */
export function normalizePath(path: string): string {
  let out = path.trim();
  if (!out.startsWith('/')) out = `/${out}`;
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out.length === 0 ? '/' : out;
}
