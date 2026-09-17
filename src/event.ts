/**
 * 事件归一化。
 *
 * OneBot v11 的字段类型在不同协议端之间并不一致：ID 可能是数字也可能是字符串、
 * `sender` 可能缺字段、`raw_message` 可能不下发。本模块把这些差异收敛掉，
 * 让插件面对一套稳定结构。
 */

import {
  atList as collectAtList,
  replyId as findReplyId,
  hasImage,
  isAt,
  isAtAll,
  isPlainText,
  parseMessage,
  readableText,
  toCq,
} from './message.ts';
import type {
  Anonymous,
  AsterEvent,
  Id,
  MessageEvent,
  MessageType,
  MetaEvent,
  NoticeEvent,
  RequestEvent,
  Segment,
  Sender,
  UnknownEvent,
} from './types.ts';

/* ─────────────────────────── 宽松取值 ─────────────────────────── */

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 取字符串；数字会被转成字符串（协议端字段类型不稳） */
export function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return String(value);
  return null;
}

/** 取 ID；数字与字符串统一成字符串 */
export function asId(value: unknown): Id | null {
  const text = asString(value);
  if (text === null) return null;
  const trimmed = text.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** 取数字；数字字符串会被解析 */
export function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** 取布尔；0/1、"true"/"false" 都能识别 */
export function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
  }
  return null;
}

function pick(obj: Obj, key: string): unknown {
  const value = obj[key];
  return value === null ? undefined : value;
}

function str(obj: Obj, key: string): string | null {
  return asString(pick(obj, key));
}

function id(obj: Obj, key: string): Id | null {
  return asId(pick(obj, key));
}

function num(obj: Obj, key: string): number | null {
  return asNumber(pick(obj, key));
}

/* ─────────────────────────── 归一化入口 ─────────────────────────── */

/**
 * 把协议端下发的原始事件归一化。
 *
 * 无法识别的事件不会丢弃，而是包成 {@link UnknownEvent} 并保留原始 JSON。
 */
export function normalizeEvent(raw: unknown): AsterEvent {
  if (!isObj(raw)) {
    return { type: 'unknown', postType: '', raw: {} };
  }

  const postType = str(raw, 'post_type') ?? '';

  switch (postType) {
    case 'message':
      return normalizeMessage(raw, false);
    case 'message_sent':
      return normalizeMessage(raw, true);
    case 'notice':
      return normalizeNotice(raw);
    case 'request':
      return normalizeRequest(raw);
    case 'meta_event':
      return normalizeMeta(raw);
    default:
      return { type: 'unknown', postType, raw };
  }
}

/* ─────────────────────────── 消息事件 ─────────────────────────── */

const MESSAGE_TYPE_MAP: Record<string, MessageType> = {
  private: 'private',
  group: 'group',
  // 部分协议端把频道消息也标成 group
  guild: 'group',
};

function normalizeSender(value: unknown): Sender {
  if (!isObj(value)) return {};

  const userId = id(value, 'user_id');
  const nickname = str(value, 'nickname');
  const card = str(value, 'card');
  const role = str(value, 'role');
  const sex = str(value, 'sex');
  const age = num(value, 'age');
  const area = str(value, 'area');
  const level = str(value, 'level');
  const title = str(value, 'title');

  const sender: Sender = {};
  if (userId !== null) sender.userId = userId;
  if (nickname !== null) sender.nickname = nickname;
  if (card !== null) sender.card = card;
  if (role !== null) sender.role = role;
  if (sex !== null) sender.sex = sex;
  if (age !== null) sender.age = age;
  if (area !== null) sender.area = area;
  if (level !== null) sender.level = level;
  if (title !== null) sender.title = title;
  return sender;
}

function normalizeAnonymous(value: unknown): Anonymous | null {
  if (!isObj(value)) return null;
  const anonymous: Anonymous = {};
  const anonymousId = id(value, 'id');
  const name = str(value, 'name');
  const flag = str(value, 'flag');
  if (anonymousId !== null) anonymous.id = anonymousId;
  if (name !== null) anonymous.name = name;
  if (flag !== null) anonymous.flag = flag;
  return anonymous;
}

function normalizeMessage(raw: Obj, sent: boolean): MessageEvent {
  const selfId = id(raw, 'self_id') ?? '';
  const userId = id(raw, 'user_id') ?? '';
  const segments: Segment[] = parseMessage(pick(raw, 'message'));
  const rawMessage = str(raw, 'raw_message') ?? '';

  // 频道场景用 guild-channel 拼出会话 ID
  let groupId = id(raw, 'group_id');
  if (groupId === null) {
    const guild = str(raw, 'guild_id');
    const channel = str(raw, 'channel_id');
    if (guild && channel) groupId = `${guild}-${channel}`;
  }

  const sender = normalizeSender(pick(raw, 'sender'));
  const messageType = MESSAGE_TYPE_MAP[str(raw, 'message_type') ?? ''] ?? 'unknown';

  // 上游没给 raw_message 时用段反推，保证字段一定有值
  const effectiveRaw = rawMessage.length > 0 ? rawMessage : toCq(segments);
  const text = readableText(segments);

  const messageId = id(raw, 'message_id') ?? '';
  const displayName =
    (sender.card && sender.card.length > 0 ? sender.card : null) ??
    (sender.nickname && sender.nickname.length > 0 ? sender.nickname : null) ??
    userId;

  const ats = collectAtList(segments);

  return {
    type: 'message',
    messageSent: sent,
    postType: sent ? 'message_sent' : 'message',
    messageType,
    subType: str(raw, 'sub_type') ?? '',
    time: num(raw, 'time') ?? 0,
    selfId,
    messageId,
    userId,
    groupId,
    text,
    rawMessage: effectiveRaw,
    segments,
    atList: ats,
    replyId: findReplyId(segments),
    hasImage: hasImage(segments),
    isAtAll: isAtAll(segments),
    isPlainText: isPlainText(segments),
    isGroup: messageType === 'group',
    isPrivate: messageType === 'private',
    isAtSelf: isAt(segments, selfId),
    displayName,
    sessionId: groupId ?? userId,
    sender,
    anonymous: normalizeAnonymous(pick(raw, 'anonymous')),
    groupName: str(raw, 'group_name'),
    font: num(raw, 'font'),
    raw,
  };
}

/* ─────────────────────────── 通知事件 ─────────────────────────── */

function normalizeNotice(raw: Obj): NoticeEvent {
  return {
    type: 'notice',
    noticeType: str(raw, 'notice_type') ?? '',
    subType: str(raw, 'sub_type'),
    time: num(raw, 'time') ?? 0,
    selfId: id(raw, 'self_id') ?? '',
    groupId: id(raw, 'group_id'),
    userId: id(raw, 'user_id'),
    operatorId: id(raw, 'operator_id'),
    targetId: id(raw, 'target_id'),
    messageId: id(raw, 'message_id'),
    duration: num(raw, 'duration'),
    raw,
  };
}

/* ─────────────────────────── 请求事件 ─────────────────────────── */

function normalizeRequest(raw: Obj): RequestEvent {
  return {
    type: 'request',
    requestType: str(raw, 'request_type') ?? '',
    subType: str(raw, 'sub_type'),
    flag: str(raw, 'flag'),
    comment: str(raw, 'comment') ?? '',
    time: num(raw, 'time') ?? 0,
    selfId: id(raw, 'self_id') ?? '',
    groupId: id(raw, 'group_id'),
    userId: id(raw, 'user_id'),
    raw,
  };
}

/* ─────────────────────────── 元事件 ─────────────────────────── */

function normalizeMeta(raw: Obj): MetaEvent {
  const metaEventType = str(raw, 'meta_event_type') ?? '';
  const subType = str(raw, 'sub_type');

  return {
    type: 'meta',
    metaEventType,
    subType,
    isConnect: metaEventType === 'lifecycle' && subType === 'connect',
    isHeartbeat: metaEventType === 'heartbeat',
    time: num(raw, 'time') ?? 0,
    selfId: id(raw, 'self_id') ?? '',
    raw,
  };
}

/* ─────────────────────────── 路由名 ─────────────────────────── */

/**
 * 事件路由名，形如 `message.group.normal`。
 *
 * 插件可以按前缀订阅：注册 `message.group` 能收到该分组下的全部子类型。
 */
export function eventName(event: AsterEvent): string {
  switch (event.type) {
    case 'message':
      return `message.${event.messageType}.${event.subType || 'normal'}`;
    case 'notice': {
      const [head, ...rest] = event.noticeType.split('_');
      const tail = rest.length > 0 ? rest.join('_') : event.subType;
      return tail ? `notice.${head}.${tail}` : `notice.${head}`;
    }
    case 'request':
      return `request.${event.requestType}.${event.subType ?? 'add'}`;
    case 'meta':
      return event.subType
        ? `meta_event.${event.metaEventType}.${event.subType}`
        : `meta_event.${event.metaEventType}`;
    default:
      return `unknown.${(event as UnknownEvent).postType}`;
  }
}

export { isObj };
