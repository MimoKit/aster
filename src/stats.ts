/**
 * 运行时统计。
 *
 * 供状态命令与 WebUI 读取，记录自启动以来的事件计数与运行时长。
 */

import type { AsterEvent, StatsSnapshot } from './types.ts';

/** 时长格式化：`1天2小时3分4秒` */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const rest = total % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}天`);
  if (hours > 0 || days > 0) parts.push(`${hours}小时`);
  if (minutes > 0 || hours > 0 || days > 0) parts.push(`${minutes}分`);
  parts.push(`${rest}秒`);
  return parts.join('');
}

/** 字节数格式化 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`;
}

export class Stats {
  readonly #startedAt = Date.now();
  #events = 0;
  #messages = 0;
  #notices = 0;
  #requests = 0;
  #metaEvents = 0;
  #commands = 0;
  #unknown = 0;
  #plugins = 0;

  /** 记录一个事件 */
  recordEvent(event: AsterEvent): void {
    this.#events += 1;
    switch (event.type) {
      case 'message':
        this.#messages += 1;
        break;
      case 'notice':
        this.#notices += 1;
        break;
      case 'request':
        this.#requests += 1;
        break;
      case 'meta':
        this.#metaEvents += 1;
        break;
      default:
        this.#unknown += 1;
    }
  }

  /** 记录一次命令命中 */
  recordCommand(): void {
    this.#commands += 1;
  }

  /** 设置已加载插件数 */
  setPlugins(count: number): void {
    this.#plugins = count;
  }

  /** 运行秒数 */
  get uptime(): number {
    return Math.floor((Date.now() - this.#startedAt) / 1000);
  }

  /** 生成快照 */
  snapshot(version: string): StatsSnapshot {
    return {
      version,
      startedAt: new Date(this.#startedAt).toLocaleString('zh-CN', { hour12: false }),
      uptime: this.uptime,
      uptimeText: formatDuration(this.uptime),
      events: this.#events,
      messages: this.#messages,
      notices: this.#notices,
      requests: this.#requests,
      metaEvents: this.#metaEvents,
      commands: this.#commands,
      plugins: this.#plugins,
    };
  }

  /** 未识别事件数（排查协议端差异时有用） */
  get unknown(): number {
    return this.#unknown;
  }
}
