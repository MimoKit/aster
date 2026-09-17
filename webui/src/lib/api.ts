/**
 * API 客户端。
 *
 * 约定：
 * - 所有请求走 `/api`，开发时由 Vite 代理到后端
 * - 访问令牌存在 localStorage，随请求头发送
 * - 后端返回非 2xx 时抛出 `ApiError`，由界面统一渲染
 */

import type {
  ApiErrorBody,
  BotDetail,
  ConfigField,
  ConfigPatchResult,
  ConfigResponse,
  LogsResponse,
  Overview,
  PluginInfo,
  SendMessageRequest,
  SendMessageResult,
} from './types';

const TOKEN_KEY = 'aster.token';

/** API 错误 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }

  /** 是否为鉴权失败 */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

/** 读取已保存的访问令牌 */
export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

/** 保存访问令牌 */
export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 隐私模式下可能不可用，忽略 */
  }
}

/** 发起请求并解析 JSON */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(`/api${path}`, { ...init, headers });
  } catch (err) {
    throw new ApiError(0, 'network', `无法连接到 Aster：${(err as Error).message}`);
  }

  if (!response.ok) {
    let code = 'unknown';
    let message = `请求失败（HTTP ${response.status}）`;
    try {
      const body = (await response.json()) as ApiErrorBody;
      if (body?.error) code = body.error;
      if (body?.message) message = body.message;
    } catch {
      /* 响应不是 JSON，沿用默认信息 */
    }
    throw new ApiError(response.status, code, message);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** 拼接查询串 */
function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export const api = {
  /** 运行总览 */
  overview: () => request<Overview>('/overview'),

  /** 在线账号 */
  bots: () => request<{ bots: BotDetail[] }>('/bots'),

  /** 插件列表 */
  plugins: () => request<{ plugins: PluginInfo[]; count: number; rules: number }>('/plugins'),

  /** 完整配置 */
  config: () => request<ConfigResponse>('/config'),

  /** 配置字段元信息 */
  configSchema: () => request<{ fields: ConfigField[] }>('/config/schema'),

  /** 更新配置 */
  patchConfig: (values: Record<string, unknown>) =>
    request<ConfigPatchResult>('/config', {
      method: 'PATCH',
      body: JSON.stringify({ values }),
    }),

  /** 历史日志 */
  logs: (params: { limit?: number; level?: string; after?: number } = {}) =>
    request<LogsResponse>(`/logs${query(params)}`),

  /** 发送消息 */
  send: (payload: SendMessageRequest) =>
    request<SendMessageResult>('/message/send', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  /** 健康检查 */
  health: () => request<{ status: string; version: string }>('/health'),
};

/**
 * 订阅 SSE 流。
 *
 * 浏览器原生 `EventSource` 无法自定义请求头，因此令牌走查询参数。
 * 返回一个取消订阅函数。
 */
export function subscribe(
  path: string,
  event: string,
  onMessage: (data: unknown) => void,
  onError?: (err: Event) => void,
): () => void {
  const token = getToken();
  const url = `/api${path}${query({ token })}`;
  const source = new EventSource(url);

  source.addEventListener(event, (e) => {
    try {
      onMessage(JSON.parse((e as MessageEvent).data));
    } catch {
      /* 忽略无法解析的帧 */
    }
  });

  source.addEventListener('error', (err) => {
    onError?.(err);
  });

  return () => source.close();
}
