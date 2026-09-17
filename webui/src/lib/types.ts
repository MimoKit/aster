/**
 * 后端 API 类型定义。
 *
 * 与 Rust 侧 `src/webui/api.rs` 的响应结构一一对应。
 */

/** 运行总览 */
export interface Overview {
  bot: {
    name: string;
    version: string;
    startedAt: string;
    uptime: string;
    uptimeSecs: number;
  };
  stats: {
    events: number;
    messages: number;
    notices: number;
    requests: number;
    metaEvents: number;
    commands: number;
  };
  plugins: {
    count: number;
    rules: number;
  };
  onebot11: {
    enable: boolean;
    host: string;
    port: number;
    path: string;
    auth: boolean;
  };
  webui: {
    auth: boolean;
  };
  bots: BotSummary[];
  logCount: number;
}

/** 在线账号摘要 */
export interface BotSummary {
  selfId: string;
  nickname: string | null;
  online: boolean;
  connections: number;
}

/** 账号详情 */
export interface BotDetail {
  selfId: string;
  nickname: string | null;
  uin: string | null;
  avatar: string | null;
  online: boolean;
  connections: number;
  connectedSecs: number;
}

/** 插件规则 */
export interface PluginRule {
  name: string;
  matcher: string;
  permission: string;
  scope: string;
}

/** 插件 */
export interface PluginInfo {
  name: string;
  desc: string;
  author: string;
  priority: number;
  enabled: boolean;
  ruleCount: number;
  rules: PluginRule[];
}

/** 日志条目 */
export interface LogEntry {
  seq: number;
  timestamp: number;
  level: string;
  target: string;
  message: string;
}

/** 日志查询结果 */
export interface LogsResponse {
  logs: LogEntry[];
  count: number;
  capacity: number;
}

/** 配置字段的元信息，驱动表单渲染 */
export interface ConfigField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'password' | 'string[]' | 'enum';
  group: string;
  hint?: string;
  options?: string[];
}

/** 配置读取结果 */
export interface ConfigResponse {
  config: Record<string, unknown>;
  path: string;
}

/** 配置更新结果 */
export interface ConfigPatchResult {
  ok: boolean;
  restart_required: boolean;
  message: string;
}

/** 发送消息请求 */
export interface SendMessageRequest {
  target: 'group' | 'private';
  id: string;
  message: unknown;
  selfId?: string;
}

/** 发送消息结果 */
export interface SendMessageResult {
  ok: boolean;
  data: unknown;
}

/** 实时事件（SSE） */
export interface LiveEvent {
  name: string;
  time: number;
  selfId: string | null;
  raw: unknown;
}

/** 统一错误结构 */
export interface ApiErrorBody {
  error: string;
  message: string;
}
