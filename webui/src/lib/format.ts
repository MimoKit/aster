/** 通用格式化工具 */

/** 数字千分位 */
export function formatNumber(value: number): string {
  return value.toLocaleString('zh-CN');
}

/** 秒 → 可读时长（如 `1天2小时3分4秒`） */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}天`);
  if (hours > 0 || days > 0) parts.push(`${hours}小时`);
  if (minutes > 0 || hours > 0 || days > 0) parts.push(`${minutes}分`);
  parts.push(`${rest}秒`);
  return parts.join('');
}

/** 时间戳（毫秒）→ `HH:MM:SS.mmm` */
export function formatClock(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(
    date.getMilliseconds(),
    3,
  )}`;
}

/** 时间戳（毫秒）→ `MM-DD HH:MM:SS` */
export function formatDateTime(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`;
}

/** 相对时间（如 `3 分钟前`） */
export function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** 日志级别排序权重，用于筛选 */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** 级别 → 展示色（与主题语义色一致） */
export function levelTone(level: string): 'ok' | 'warn' | 'danger' | 'muted' {
  switch (level.toLowerCase()) {
    case 'error':
      return 'danger';
    case 'warn':
      return 'warn';
    case 'info':
      return 'ok';
    default:
      return 'muted';
  }
}

/** 复制文本到剪贴板 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
