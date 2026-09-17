/**
 * 消息规范化。
 *
 * OneBot v11 的 `message` 字段有三种形态，协议端之间差异很大：
 *
 * ```text
 * 1. CQ 码字符串   "你好[CQ:at,qq=123][CQ:image,file=a.jpg]"
 * 2. 标准数组      [{ type: "at", data: { qq: "123" } }]
 * 3. 扁平数组      [{ type: "at", qq: "123" }]        // 部分协议端
 * ```
 *
 * 本模块把它们统一成 {@link Segment} 数组，并提供 CQ 码互转与常用访问器。
 */

import type { Id, Segment } from './types.ts';

/* ─────────────────────────── CQ 码转义 ─────────────────────────── */

/** CQ 码参数值转义 */
export function escapeCqParam(input: string): string {
  let out = '';
  for (const char of input) {
    switch (char) {
      case '&':
        out += '&amp;';
        break;
      case ',':
        out += '&#44;';
        break;
      case '[':
        out += '&#91;';
        break;
      case ']':
        out += '&#93;';
        break;
      default:
        out += char;
    }
  }
  return out;
}

/** 文本段转义（逗号不需要转义） */
export function escapeCqText(input: string): string {
  let out = '';
  for (const char of input) {
    switch (char) {
      case '&':
        out += '&amp;';
        break;
      case '[':
        out += '&#91;';
        break;
      case ']':
        out += '&#93;';
        break;
      default:
        out += char;
    }
  }
  return out;
}

/** CQ 码反转义 */
export function unescapeCq(input: string): string {
  if (!input.includes('&')) return input;
  return input
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&');
}

/* ─────────────────────────── 段构造器 ─────────────────────────── */

/** 段构造器集合，供插件与内核拼装消息 */
export const seg = {
  text: (text: string): Segment => ({ type: 'text', data: { text } }),

  at: (qq: Id | 'all'): Segment => ({ type: 'at', data: { qq: String(qq) } }),

  atAll: (): Segment => ({ type: 'at', data: { qq: 'all' } }),

  face: (id: Id): Segment => ({ type: 'face', data: { id: String(id) } }),

  image: (file: string, extra: Record<string, unknown> = {}): Segment => ({
    type: 'image',
    data: { file, ...extra },
  }),

  record: (file: string, extra: Record<string, unknown> = {}): Segment => ({
    type: 'record',
    data: { file, ...extra },
  }),

  video: (file: string, extra: Record<string, unknown> = {}): Segment => ({
    type: 'video',
    data: { file, ...extra },
  }),

  reply: (id: Id): Segment => ({ type: 'reply', data: { id: String(id) } }),

  file: (file: string, name?: string): Segment => ({
    type: 'file',
    data: name ? { file, name } : { file },
  }),

  json: (data: string): Segment => ({ type: 'json', data: { data } }),

  xml: (data: string): Segment => ({ type: 'xml', data: { data } }),

  poke: (qq: Id): Segment => ({ type: 'poke', data: { qq: String(qq) } }),

  /** 合并转发节点（供 send_*_forward_msg 使用） */
  node: (
    content: Segment[],
    opts: { userId?: Id; nickname?: string; time?: number } = {},
  ): Segment => ({
    type: 'node',
    data: {
      user_id: String(opts.userId ?? '80000000'),
      nickname: opts.nickname ?? '匿名消息',
      content,
      ...(opts.time === undefined ? {} : { time: opts.time }),
    },
  }),
};

/* ─────────────────────────── 解析 ─────────────────────────── */

/** 需要强制转成字符串的字段 */
const ID_KEYS = new Set([
  'qq',
  'id',
  'user_id',
  'message_id',
  'file_id',
  'busid',
  'card',
  'nickname',
  'name',
  'title',
]);

/** 需要强制转成数字的字段 */
const NUMBER_KEYS = new Set([
  'times',
  'duration',
  'size',
  'width',
  'height',
  'age',
  'level',
  'msg_seq',
  'group_id',
]);

/** 字段别名：不同协议端对同一含义用不同键名 */
const KEY_ALIASES: Record<string, Record<string, string>> = {
  at: { user_id: 'qq', uin: 'qq', target: 'qq' },
  reply: { message_id: 'id' },
  image: { url: 'url' },
};

/** 归一化单个字段值 */
function normalizeValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (ID_KEYS.has(key)) {
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
    if (typeof value === 'string') return value;
  }

  if (NUMBER_KEYS.has(key)) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  return value;
}

/** 归一化段参数 */
function normalizeData(type: string, raw: Record<string, unknown>): Record<string, unknown> {
  const aliases = KEY_ALIASES[type];
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    const target = aliases?.[key] ?? key;
    // 别名目标已有值时不要覆盖
    if (target !== key && target in out) continue;
    out[target] = normalizeValue(target, value);
  }

  return out;
}

/**
 * 解析单个段对象。
 *
 * 同时兼容 `{ type, data: {...} }` 与 `{ type, ...params }` 两种写法。
 */
export function parseSegmentObject(value: Record<string, unknown>): Segment | null {
  const type = typeof value.type === 'string' ? value.type : '';

  // `type` 缺失但有 `text`：兼容极简写法
  if (!type) {
    if (typeof value.text === 'string') return { type: 'text', data: { text: value.text } };
    return null;
  }

  const data = value.data;
  let params: Record<string, unknown>;

  if (data && typeof data === 'object' && !Array.isArray(data)) {
    params = data as Record<string, unknown>;
  } else if (typeof data === 'string') {
    // 少数协议端把 data 写成标量
    params = { text: data };
  } else {
    // 扁平写法：除 type / data 外的同级字段都是参数
    params = { ...value };
    delete params.type;
    delete params.data;
  }

  // `raw` 段：协议端把真实段藏在 data 里
  if (type === 'raw' && typeof params.type === 'string') {
    return parseSegmentObject(params);
  }

  return { type, data: normalizeData(type, params) };
}

/**
 * 把 `message` 字段的任意形态解析为段数组。
 *
 * 支持的输入：CQ 码字符串、段数组、单个段对象、裸值。
 */
export function parseMessage(value: unknown): Segment[] {
  if (value === null || value === undefined) return [];

  if (typeof value === 'string') return parseCq(value);

  if (Array.isArray(value)) {
    const segments: Segment[] = [];
    for (const item of value) segments.push(...parseMessage(item));
    return segments;
  }

  if (typeof value === 'object') {
    const segment = parseSegmentObject(value as Record<string, unknown>);
    return segment ? [segment] : [];
  }

  // 裸数字 / 布尔：视为文本
  return [{ type: 'text', data: { text: String(value) } }];
}

/**
 * 解析 CQ 码字符串。
 *
 * 未闭合的 `[CQ:` 会当作普通文本保留，不会抛错。
 */
export function parseCq(raw: string): Segment[] {
  const segments: Segment[] = [];
  let text = '';

  const flush = (): void => {
    if (text.length > 0) {
      segments.push({ type: 'text', data: { text: unescapeCq(text) } });
      text = '';
    }
  };

  let cursor = 0;
  while (cursor < raw.length) {
    if (!raw.startsWith('[CQ:', cursor)) {
      text += raw[cursor];
      cursor += 1;
      continue;
    }

    // 找配对的 `]`；裸 `[` 视为未闭合
    const bodyStart = cursor + 4;
    let end = -1;
    for (let i = bodyStart; i < raw.length; i += 1) {
      const char = raw[i];
      if (char === ']') {
        end = i;
        break;
      }
      if (char === '[') break;
    }

    if (end === -1) {
      text += '[';
      cursor += 1;
      continue;
    }

    const segment = parseCqBody(raw.slice(bodyStart, end));
    if (segment) {
      flush();
      segments.push(segment);
    } else {
      text += raw.slice(cursor, end + 1);
    }
    cursor = end + 1;
  }

  flush();
  return segments;
}

/** 解析 `[CQ:...]` 内部内容 */
function parseCqBody(body: string): Segment | null {
  const comma = body.indexOf(',');
  const type = (comma === -1 ? body : body.slice(0, comma)).trim();
  if (type.length === 0) return null;

  const params: Record<string, unknown> = {};
  if (comma !== -1) {
    for (const pair of splitCqParams(body.slice(comma + 1))) {
      if (pair.length === 0) continue;
      const eq = pair.indexOf('=');
      const key = (eq === -1 ? pair : pair.slice(0, eq)).trim();
      if (key.length === 0) continue;
      const value = eq === -1 ? '' : unescapeCq(pair.slice(eq + 1));
      params[key] = value;
    }
  }

  return { type, data: normalizeData(type, params) };
}

/** 按未转义的逗号切分参数 */
function splitCqParams(input: string): string[] {
  const parts: string[] = [];
  let current = '';

  for (let i = 0; i < input.length; i += 1) {
    if (input.startsWith('&#44;', i)) {
      current += ',';
      i += 4;
      continue;
    }
    if (input[i] === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += input[i];
  }
  parts.push(current);
  return parts;
}

/* ─────────────────────────── 序列化 ─────────────────────────── */

/** 段数组 → CQ 码字符串 */
export function toCq(segments: Segment[]): string {
  let out = '';
  for (const segment of segments) {
    if (segment.type === 'text') {
      out += escapeCqText(String(segment.data.text ?? ''));
      continue;
    }

    out += `[CQ:${segment.type}`;
    for (const [key, value] of Object.entries(segment.data)) {
      if (value === null || value === undefined) continue;
      out += `,${key}=${escapeCqParam(String(value))}`;
    }
    out += ']';
  }
  return out;
}

/** 段数组 → 数组形态（原样返回，便于类型标注与后续扩展） */
export function toArray(segments: Segment[]): Segment[] {
  return segments.map((segment) => ({ type: segment.type, data: { ...segment.data } }));
}

/* ─────────────────────────── 可读文本 ─────────────────────────── */

/** 不可读段的占位文案 */
const PLACEHOLDERS: Record<string, string> = {
  face: '[表情]',
  image: '[图片]',
  record: '[语音]',
  video: '[视频]',
  reply: '[回复]',
  poke: '[戳一戳]',
  music: '[音乐]',
  forward: '[合并转发]',
  node: '[转发节点]',
  json: '[卡片消息]',
  xml: '[卡片消息]',
  mface: '[表情]',
  markdown: '[Markdown]',
  keyboard: '[按钮]',
  button: '[按钮]',
  shake: '[窗口抖动]',
  rps: '[猜拳]',
  dice: '[骰子]',
  anonymous: '[匿名消息]',
  contact: '[推荐名片]',
  location: '[位置]',
  share: '[链接]',
};

/**
 * 生成人类可读文本。
 *
 * 与 CQ 码的区别：`at` 展开成 `@昵称`、附件变成 `[图片]` 这类占位符，
 * 适合直接用于日志与命令匹配。
 */
export function readableText(segments: Segment[]): string {
  let out = '';
  for (const segment of segments) {
    switch (segment.type) {
      case 'text':
        out += String(segment.data.text ?? '');
        break;
      case 'at': {
        const qq = String(segment.data.qq ?? '');
        if (qq === 'all' || qq === 'everyone') out += '@全体成员';
        else if (segment.data.name) out += `@${String(segment.data.name)}`;
        else out += `@${qq}`;
        break;
      }
      case 'file': {
        const name = segment.data.name;
        out += name ? `[文件:${String(name)}]` : '[文件]';
        break;
      }
      default:
        out += PLACEHOLDERS[segment.type] ?? `[${segment.type}]`;
    }
  }
  return out;
}

/* ─────────────────────────── 访问器 ─────────────────────────── */

/** 所有 `at` 目标 */
export function atList(segments: Segment[]): Id[] {
  const list: Id[] = [];
  for (const segment of segments) {
    if (segment.type === 'at') list.push(String(segment.data.qq ?? ''));
  }
  return list;
}

/** 第一条 `reply` 的消息 ID */
export function replyId(segments: Segment[]): Id | null {
  for (const segment of segments) {
    if (segment.type === 'reply') return String(segment.data.id ?? '');
  }
  return null;
}

/** 是否包含图片 */
export function hasImage(segments: Segment[]): boolean {
  return segments.some((segment) => segment.type === 'image');
}

/** 是否 @ 了全体成员 */
export function isAtAll(segments: Segment[]): boolean {
  return segments.some(
    (segment) =>
      segment.type === 'at' && (segment.data.qq === 'all' || segment.data.qq === 'everyone'),
  );
}

/** 是否全部由文本段组成 */
export function isPlainText(segments: Segment[]): boolean {
  return segments.every((segment) => segment.type === 'text');
}

/** 是否为空消息 */
export function isEmpty(segments: Segment[]): boolean {
  return segments.length === 0;
}

/** 是否 @ 了指定账号 */
export function isAt(segments: Segment[], userId: Id): boolean {
  return segments.some((segment) => segment.type === 'at' && String(segment.data.qq) === userId);
}

/** 拼接所有文本段 */
export function textOnly(segments: Segment[]): string {
  let out = '';
  for (const segment of segments) {
    if (segment.type === 'text') out += String(segment.data.text ?? '');
  }
  return out;
}
