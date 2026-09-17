/**
 * 框架的核心类型。
 *
 * 这些类型描述的是**归一化之后**的世界：无论协议端下发的是数字 ID 还是
 * 字符串 ID、消息是 CQ 码还是数组，插件看到的永远是同一套结构。
 */

/** 账号 / 群号 / 消息 ID，统一为字符串 */
export type Id = string;

/**
 * OneBot v11 消息段。
 *
 * 刻意保持 `{ type, data }` 的宽松形态而不是收成联合类型：
 * 协议端扩展段（`mface`、`markdown`、`keyboard`…）非常多样，
 * 收窄类型会逼着框架在遇到未知段时丢数据。
 */
export interface Segment {
  type: string;
  data: Record<string, unknown>;
}

/** `at` 段的目标 */
export interface AtSegment extends Segment {
  type: 'at';
  data: { qq: string; name?: string };
}

/** `image` 段 */
export interface ImageSegment extends Segment {
  type: 'image';
  data: { file: string; url?: string; type?: string; sub_type?: string; file_id?: string };
}

/** 发送者信息 */
export interface Sender {
  userId?: Id;
  /** 昵称 */
  nickname?: string;
  /** 群名片 */
  card?: string;
  /** `owner` | `admin` | `member` */
  role?: string;
  sex?: string;
  age?: number;
  area?: string;
  level?: string;
  title?: string;
}

/** 匿名发送者信息 */
export interface Anonymous {
  id?: Id;
  name?: string;
  flag?: string;
}

/** 会话类型 */
export type MessageType = 'private' | 'group' | 'unknown';

/** 消息事件 */
export interface MessageEvent {
  readonly type: 'message';
  /** 是否为机器人自己发出的消息（`post_type = message_sent`） */
  readonly messageSent: boolean;
  readonly postType: 'message' | 'message_sent';
  readonly messageType: MessageType;
  /** `friend` | `group` | `normal` | `anonymous` | `notice` | … */
  readonly subType: string;
  /** Unix 秒 */
  readonly time: number;
  readonly selfId: Id;
  readonly messageId: Id;
  readonly userId: Id;
  /** 私聊为 `null` */
  readonly groupId: Id | null;

  /** 可读文本：图片等不可读段会变成 `[图片]` */
  readonly text: string;
  /** CQ 码原文 */
  readonly rawMessage: string;
  /** 结构化消息段 */
  readonly segments: Segment[];

  readonly atList: Id[];
  readonly replyId: Id | null;
  readonly hasImage: boolean;
  readonly isAtAll: boolean;
  readonly isPlainText: boolean;

  readonly isGroup: boolean;
  readonly isPrivate: boolean;
  /** 是否 @ 了机器人自己 */
  readonly isAtSelf: boolean;
  /** 展示名：优先群名片，其次昵称 */
  readonly displayName: string;
  /** 会话标识：群聊为群号，私聊为用户号 */
  readonly sessionId: Id;

  readonly sender: Sender;
  readonly anonymous: Anonymous | null;
  readonly groupName: string | null;
  readonly font: number | null;

  /** 协议端下发的原始事件，用于访问非标准字段 */
  readonly raw: Record<string, unknown>;
}

/** 通知事件 */
export interface NoticeEvent {
  readonly type: 'notice';
  readonly noticeType: string;
  readonly subType: string | null;
  readonly time: number;
  readonly selfId: Id;
  readonly groupId: Id | null;
  readonly userId: Id | null;
  readonly operatorId: Id | null;
  readonly targetId: Id | null;
  readonly messageId: Id | null;
  readonly duration: number | null;
  readonly raw: Record<string, unknown>;
}

/** 请求事件 */
export interface RequestEvent {
  readonly type: 'request';
  readonly requestType: string;
  readonly subType: string | null;
  readonly flag: string | null;
  readonly comment: string;
  readonly time: number;
  readonly selfId: Id;
  readonly groupId: Id | null;
  readonly userId: Id | null;
  readonly raw: Record<string, unknown>;
}

/** 元事件 */
export interface MetaEvent {
  readonly type: 'meta';
  readonly metaEventType: string;
  readonly subType: string | null;
  readonly isConnect: boolean;
  readonly isHeartbeat: boolean;
  readonly time: number;
  readonly selfId: Id;
  readonly raw: Record<string, unknown>;
}

/** 未识别事件 */
export interface UnknownEvent {
  readonly type: 'unknown';
  readonly postType: string;
  readonly raw: Record<string, unknown>;
}

/** 所有事件的联合 */
export type AsterEvent = MessageEvent | NoticeEvent | RequestEvent | MetaEvent | UnknownEvent;

/** 事件处理函数的返回值 */
export type HandlerResult = unknown;

/** 权限级别 */
export type Permission = 'all' | 'master' | 'admin' | 'owner';

/** 会话范围 */
export type Scope = 'any' | 'group' | 'private';

/** 匹配方式 */
export type MatcherKind = 'command' | 'prefix' | 'exact' | 'regex' | 'contains' | 'any';

/** 运行状态快照 */
export interface StatsSnapshot {
  version: string;
  startedAt: string;
  uptime: number;
  uptimeText: string;
  events: number;
  messages: number;
  notices: number;
  requests: number;
  metaEvents: number;
  commands: number;
  plugins: number;
}
