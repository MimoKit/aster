/**
 * 日志。
 *
 * 除了打到终端，还在内存里保留一个环形缓冲，供 WebUI 的日志页回看与实时跟踪。
 * `base64://` 内容默认折叠——图片 base64 动辄几 MB，直接打出来会刷屏。
 */

import { EventEmitter } from 'node:events';

import type { LogConfig } from './config.ts';

/** 级别顺序，数字越大越严重 */
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LEVELS)[number];

/** 终端配色 */
const COLORS: Record<string, string> = {
  trace: '\u001b[90m',
  debug: '\u001b[36m',
  info: '\u001b[32m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
};
const DIM = '\u001b[2m';
const RESET = '\u001b[0m';

/** 一条日志 */
export interface LogEntry {
  /** 自增序号，前端据此增量拉取 */
  seq: number;
  timestamp: number;
  level: LogLevel;
  target: string;
  message: string;
}

function levelIndex(level: string): number {
  const index = LEVELS.indexOf(level as LogLevel);
  return index === -1 ? 2 : index;
}

/** 折叠 base64 内容 */
export function collapseBase64(input: string): string {
  const marker = 'base64://';
  if (!input.includes(marker)) return input;

  let out = '';
  let rest = input;
  for (;;) {
    const at = rest.indexOf(marker);
    if (at === -1) break;
    out += rest.slice(0, at) + marker;
    const after = rest.slice(at + marker.length);
    // payload 截止到常见分隔符
    let end = after.length;
    for (let i = 0; i < after.length; i += 1) {
      const char = after[i] as string;
      if (char === '"' || char === ',' || char === ']' || char === '}' || /\s/.test(char)) {
        end = i;
        break;
      }
    }
    out += `...(${end} 字节)`;
    rest = after.slice(end);
  }
  return out + rest;
}

/** 把任意值转成可读字符串 */
function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** 多个 logger 实例共享的状态 */
interface LogShared {
  level: number;
  capacity: number;
  maxLength: number;
  showBase64: boolean;
  color: boolean;
  entries: LogEntry[];
  seq: number;
  emitter: EventEmitter;
}

function createShared(config: LogConfig, capacity: number): LogShared {
  const emitter = new EventEmitter();
  // 订阅者可能不少（多个 SSE 连接），放宽上限
  emitter.setMaxListeners(0);
  return {
    level: levelIndex(config.level),
    capacity: Math.max(100, capacity),
    maxLength: Math.max(256, config.maxLength),
    showBase64: config.showBase64,
    color: config.color,
    entries: [],
    seq: 0,
    emitter,
  };
}

/** child() 复用共享状态时占位用的配置，实际不会生效 */
const SHARED_PLACEHOLDER: LogConfig = {
  level: 'info',
  maxLength: 4096,
  showBase64: false,
  color: true,
};

export class Logger {
  /** 固定前缀，便于区分模块（如 `onebot11`） */
  readonly target: string;

  /** @internal 与派生的 logger 共享 */
  readonly #shared: LogShared;

  constructor(config: LogConfig, capacity = 2000, target = 'aster', shared?: LogShared) {
    this.target = target;
    // 传入 shared 时忽略 config，仅供 child() 复用状态
    this.#shared = shared ?? createShared(config, capacity);
  }

  /**
   * 派生一个带固定 target 的 logger，共享同一份缓冲与订阅者。
   *
   * 必须走构造函数：`Object.create` 不会安装私有方法的 brand，
   * 那样派生的实例一调用日志就会抛 TypeError。
   */
  child(target: string): Logger {
    return new Logger(SHARED_PLACEHOLDER, 0, target, this.#shared);
  }

  /** 动态调整级别（影响所有派生的 logger） */
  setLevel(level: string): void {
    this.#shared.level = levelIndex(level);
  }

  get level(): string {
    return LEVELS[this.#shared.level] ?? 'info';
  }

  /** 是否会输出该级别 */
  enabled(level: LogLevel): boolean {
    return levelIndex(level) >= this.#shared.level && this.#shared.level < LEVELS.length - 1;
  }

  trace(message: unknown, target?: string): void {
    this.#log('trace', message, target);
  }

  debug(message: unknown, target?: string): void {
    this.#log('debug', message, target);
  }

  info(message: unknown, target?: string): void {
    this.#log('info', message, target);
  }

  warn(message: unknown, target?: string): void {
    this.#log('warn', message, target);
  }

  error(message: unknown, target?: string): void {
    this.#log('error', message, target);
  }

  #log(level: LogLevel, message: unknown, target?: string): void {
    if (!this.enabled(level)) return;

    const shared = this.#shared;
    shared.seq += 1;
    const entry: LogEntry = {
      seq: shared.seq,
      timestamp: Date.now(),
      level,
      target: target ?? this.target,
      message: this.#sanitize(stringify(message)),
    };

    // 环形缓冲
    shared.entries.push(entry);
    if (shared.entries.length > shared.capacity) {
      shared.entries.splice(0, shared.entries.length - shared.capacity);
    }

    this.#write(entry);
    shared.emitter.emit('log', entry);
  }

  /** 脱敏 + 截断 */
  #sanitize(input: string): string {
    const text = this.#shared.showBase64 ? input : collapseBase64(input);
    if (text.length <= this.#shared.maxLength) return text;
    return `${text.slice(0, this.#shared.maxLength)}...(共 ${text.length} 字符)`;
  }

  /** 输出到终端 */
  #write(entry: LogEntry): void {
    const time = new Date(entry.timestamp);
    const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
    const stamp = `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(
      time.getHours(),
    )}:${pad(time.getMinutes())}:${pad(time.getSeconds())}.${pad(time.getMilliseconds(), 3)}`;

    const level = entry.level.toUpperCase().padEnd(5);
    if (this.#shared.color) {
      process.stdout.write(
        `${stamp} ${COLORS[entry.level] ?? ''}${level}${RESET} ${DIM}[${entry.target}]${RESET} ${entry.message}\n`,
      );
    } else {
      process.stdout.write(`${stamp} ${level} [${entry.target}] ${entry.message}\n`);
    }
  }

  /* ─────────────────────── 供 WebUI 使用 ─────────────────────── */

  /** 读取历史日志 */
  entries(options: { limit?: number; level?: string; afterSeq?: number } = {}): LogEntry[] {
    const { limit = 500, level, afterSeq } = options;
    let list = this.#shared.entries;

    if (afterSeq !== undefined) {
      list = list.filter((entry) => entry.seq > afterSeq);
    }
    if (level && level !== 'all') {
      const threshold = levelIndex(level);
      list = list.filter((entry) => levelIndex(entry.level) >= threshold);
    }
    return limit > 0 ? list.slice(-limit) : [...list];
  }

  /** 当前缓冲条数 */
  get size(): number {
    return this.#shared.entries.length;
  }

  /** 订阅实时日志，返回取消函数 */
  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.#shared.emitter.on('log', listener);
    return () => {
      this.#shared.emitter.off('log', listener);
    };
  }

  /** 清空缓冲 */
  clear(): void {
    this.#shared.entries = [];
  }
}

/** 未初始化时的兜底 logger（比如配置还没读到就要报错） */
export function createFallbackLogger(): Logger {
  return new Logger(
    { level: 'info', maxLength: 4096, showBase64: false, color: true },
    500,
    'aster',
  );
}
