/**
 * 配置读写。
 *
 * 首次运行时把包内置的 `config/default.toml` 复制到数据目录，
 * 之后的读写都作用于数据目录下的 `config.toml`。
 *
 * 这里同时维护一份「点路径」访问器，让 `aster config get onebot11.port`
 * 这类命令不必关心嵌套层级。
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parse, stringify } from 'smol-toml';

import { Paths } from './paths.js';

/** 内置默认配置（与 Rust 侧 config/default.toml 保持一致） */
export const DEFAULT_CONFIG = {
  bot: {
    name: 'Aster',
    masters: [],
    builtin_plugins: true,
    command_prefix: '',
  },
  log: { level: 'info', max_len: 4096, show_base64: false },
  onebot11: {
    enable: true,
    host: '0.0.0.0',
    port: 5310,
    path: '/onebot/v11/ws',
    access_token: '',
    trusted_ips: [],
    heartbeat_timeout: 90,
    handshake_timeout: 10,
    request_timeout: 60,
  },
};

/**
 * 配置管理器
 */
export class ConfigManager {
  constructor(home) {
    this.paths = new Paths(home);
  }

  /** 确保配置文件存在 */
  ensure() {
    this.paths.ensure();
    if (existsSync(this.paths.configFile)) return this.paths.configFile;

    if (existsSync(this.paths.defaultConfig)) {
      copyFileSync(this.paths.defaultConfig, this.paths.configFile);
    } else {
      writeFileSync(this.paths.configFile, stringify(DEFAULT_CONFIG), 'utf8');
    }
    return this.paths.configFile;
  }

  /** 读取配置对象 */
  read() {
    this.ensure();
    const text = readFileSync(this.paths.configFile, 'utf8');
    try {
      return parse(text);
    } catch (err) {
      throw new Error(`解析 ${this.paths.configFile} 失败：${err.message}`);
    }
  }

  /** 写入配置对象（整体覆盖） */
  write(config) {
    this.ensure();
    writeFileSync(this.paths.configFile, stringify(config), 'utf8');
  }

  /** 按点路径读取，如 `onebot11.port` */
  get(dotted) {
    const config = this.read();
    const value = dotted
      .split('.')
      .filter(Boolean)
      .reduce((acc, key) => (acc == null ? undefined : acc[key]), config);
    return value;
  }

  /** 按点路径写入，值会被转换为合适的类型 */
  set(dotted, rawValue) {
    const config = this.read();
    const keys = dotted.split('.').filter(Boolean);
    if (keys.length === 0) throw new Error('配置键不能为空');

    let cursor = config;
    for (const key of keys.slice(0, -1)) {
      if (typeof cursor[key] !== 'object' || cursor[key] === null || Array.isArray(cursor[key])) {
        cursor[key] = {};
      }
      cursor = cursor[key];
    }
    const last = keys.at(-1);
    const previous = cursor[last];
    cursor[last] = coerce(rawValue, previous);
    this.write(config);
    return cursor[last];
  }

  /** 把嵌套对象摊平成点路径表 */
  flatten(config = this.read(), prefix = '', out = {}) {
    for (const [key, value] of Object.entries(config)) {
      const dotted = prefix ? `${prefix}.${key}` : key;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        this.flatten(value, dotted, out);
      } else {
        out[dotted] = value;
      }
    }
    return out;
  }
}

/** 依据原值类型转换输入字符串 */
export function coerce(raw, previous) {
  const text = String(raw);
  if (typeof previous === 'boolean') {
    if (['true', '1', 'yes', 'on'].includes(text.toLowerCase())) return true;
    if (['false', '0', 'no', 'off'].includes(text.toLowerCase())) return false;
    throw new Error(`需要布尔值，收到：${raw}`);
  }
  if (typeof previous === 'number') {
    const num = Number(text);
    if (!Number.isFinite(num)) throw new Error(`需要数字，收到：${raw}`);
    return num;
  }
  if (Array.isArray(previous)) {
    return text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // 无原值时按字面量推断
  if (previous === undefined) {
    if (text === 'true') return true;
    if (text === 'false') return false;
    if (/^-?\d+$/.test(text)) return Number(text);
  }
  return text;
}

/** 校验配置，返回问题列表 */
export function validate(config) {
  const problems = [];
  const port = config?.onebot11?.port;
  if (port !== undefined) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      problems.push(`onebot11.port 非法：${port}（应为 0-65535）`);
    }
    if (port > 0 && port < 1024) {
      problems.push(
        `onebot11.port = ${port} 属于特权端口（<1024），普通用户无法绑定，建议改用 5310 或提权`,
      );
    }
  }
  const path = config?.onebot11?.path;
  if (path !== undefined && !String(path).startsWith('/')) {
    problems.push(`onebot11.path 应以 / 开头，当前为：${path}`);
  }
  const level = config?.log?.level;
  if (level !== undefined && !['trace', 'debug', 'info', 'warn', 'error', 'off'].includes(level)) {
    problems.push(`log.level 非法：${level}`);
  }
  return problems;
}
