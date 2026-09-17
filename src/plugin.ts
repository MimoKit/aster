/**
 * 插件定义 API。
 *
 * 插件是普通的 TypeScript 模块，导出一个 `definePlugin` 的结果：
 *
 * ```ts
 * // plugins/hello.ts
 * import { definePlugin } from 'aster-bot'
 *
 * export default definePlugin({
 *   name: 'hello',
 *   desc: '打招呼',
 *   rules: [
 *     {
 *       name: '打招呼',
 *       command: 'hi',
 *       async handler(ctx) {
 *         return ctx.reply(`你好，${ctx.args || '陌生人'}`)
 *       },
 *     },
 *   ],
 * })
 * ```
 */

import type { Logger } from './logger.ts';
import type { Bot, MessageInput } from './onebot11.ts';
import type { Id, MessageEvent, Permission, Scope, Segment, StatsSnapshot } from './types.ts';

/* ─────────────────────────── 上下文 ─────────────────────────── */

/**
 * 处理函数拿到的上下文。
 *
 * 事件本身在 `ctx.event`，其余是匹配结果与回复/调用能力。
 */
export interface PluginContext {
  /** 归一化后的消息事件 */
  readonly event: MessageEvent;
  /** 命令词之后的参数（前缀/命令/正则匹配都会填充） */
  readonly args: string;
  /** 正则捕获组，`matches[0]` 是整体匹配 */
  readonly matches: string[];
  /** 当前插件名 */
  readonly plugin: string;
  /** 当前规则名 */
  readonly rule: string;

  /** 触发事件的账号 */
  readonly bot: Bot;
  readonly logger: Logger;

  /** 是否群聊 */
  readonly isGroup: boolean;
  /** 是否私聊 */
  readonly isPrivate: boolean;
  /** 群号（私聊为 null） */
  readonly groupId: Id | null;
  /** 发送者账号 */
  readonly userId: Id;
  /** 机器人账号 */
  readonly selfId: Id;
  /** 会话标识：群聊为群号，私聊为用户号 */
  readonly sessionId: Id;
  /** 发送者展示名 */
  readonly displayName: string;

  /** 回复消息 */
  reply(message: MessageInput): Promise<unknown>;
  /** 回复并 @ 发送者 */
  replyAt(message: MessageInput): Promise<unknown>;
  /** 引用回复 */
  replyQuote(message: MessageInput): Promise<unknown>;
  /** 调用任意 OneBot API */
  call<T = unknown>(action: string, params?: Record<string, unknown>): Promise<T>;
  /** 写日志（会带上插件名） */
  log(message: unknown, level?: 'trace' | 'debug' | 'info' | 'warn' | 'error'): void;
  /** 已登记的账号（含离线） */
  readonly bots: Bot[];
  /** 适配器监听地址，未启动时为 null */
  readonly address: { host: string; port: number; path: string; url: string } | null;
  /** 框架版本 */
  readonly version: string;
  /** 查询框架运行状态 */
  status(): StatsSnapshot;
}

/** 处理函数：返回 `false` 表示未处理、放行后续规则 */
export type PluginHandler = (ctx: PluginContext) => unknown | Promise<unknown>;

/* ─────────────────────────── 规则 ─────────────────────────── */

export interface PluginRule {
  /** 规则名，出现在日志里 */
  name?: string;
  /** 命令词，独立成词：`as` 命中 `as` 与 `as 详细`，不命中 `asd` */
  command?: string;
  /** 前缀匹配：只要以此开头就命中 */
  prefix?: string;
  /** 完全相等 */
  exact?: string;
  /** 正则匹配 */
  regex?: RegExp | string;
  /** 包含子串 */
  contains?: string;
  /** 匹配所有消息 */
  any?: boolean;

  /** 需要的权限，默认 `all` */
  permission?: Permission;
  /** 生效范围，默认 `any` */
  scope?: Scope;
  /** 是否打印执行日志，默认 true */
  log?: boolean;

  handler: PluginHandler;
}

/** 插件定义 */
export interface PluginDefinition {
  /** 插件名，唯一，小写字母数字与 `-` `_` */
  name: string;
  /** 说明 */
  desc?: string;
  /** 作者 */
  author?: string;
  /** 优先级，越小越先执行，默认 5000 */
  priority?: number;
  rules: PluginRule[];
}

/** 归一化后的规则（内部使用） */
export interface NormalizedRule {
  name: string;
  matcher: 'command' | 'prefix' | 'exact' | 'regex' | 'contains' | 'any';
  value: string | RegExp | null;
  permission: Permission;
  scope: Scope;
  log: boolean;
  handler: PluginHandler;
}

/** 归一化后的插件（内部使用） */
export interface NormalizedPlugin {
  name: string;
  desc: string;
  author: string;
  priority: number;
  rules: NormalizedRule[];
  /** 来源文件，热重载时用于定位 */
  file?: string;
}

/* ─────────────────────────── 校验 ─────────────────────────── */

const PERMISSIONS: readonly Permission[] = ['all', 'master', 'admin', 'owner'];
const SCOPES: readonly Scope[] = ['any', 'group', 'private'];
const MATCHERS = ['command', 'prefix', 'exact', 'regex', 'contains'] as const;
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * 定义一个插件。
 *
 * 这里做的是**加载期校验**：名字、匹配方式、权限、正则语法都在加载时报错，
 * 而不是等到某条命令被触发时才炸。
 */
export function definePlugin(definition: PluginDefinition): PluginDefinition {
  if (typeof definition !== 'object' || definition === null) {
    throw new TypeError('definePlugin 需要一个对象');
  }

  const { name, desc = '', author = '', priority = 5000, rules } = definition;

  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('插件缺少 name');
  }
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`插件名 ${name} 不合法：只允许字母、数字、- 和 _`);
  }
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error(`插件 ${name} 至少要有一条 rule`);
  }
  if (typeof priority !== 'number' || !Number.isFinite(priority)) {
    throw new Error(`插件 ${name} 的 priority 必须是数字`);
  }

  for (const [index, rule] of rules.entries()) {
    validateRule(name, rule, index);
  }

  return { name, desc, author, priority, rules };
}

function validateRule(pluginName: string, rule: PluginRule, index: number): void {
  const where = `插件 ${pluginName} 的 rules[${index}]`;

  if (typeof rule !== 'object' || rule === null) {
    throw new TypeError(`${where} 必须是对象`);
  }
  if (typeof rule.handler !== 'function') {
    throw new Error(`${where} 缺少 handler 函数`);
  }

  const used = MATCHERS.filter((key) => rule[key] !== undefined && rule[key] !== null);
  const any = rule.any === true;

  if (used.length === 0 && !any) {
    throw new Error(`${where} 需要 ${MATCHERS.join(' / ')} 之一，或 any: true`);
  }
  if (used.length > 1) {
    throw new Error(`${where} 只能指定一种匹配方式，收到 ${used.join(' + ')}`);
  }

  const matcher = used[0];
  if (matcher && matcher !== 'regex') {
    const value = rule[matcher];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`${where} 的 ${matcher} 必须是非空字符串`);
    }
  }

  if (matcher === 'regex') {
    const pattern = rule.regex;
    if (!(pattern instanceof RegExp) && typeof pattern !== 'string') {
      throw new Error(`${where} 的 regex 必须是 RegExp 或字符串`);
    }
    try {
      // 提前编译，把语法错误暴露在加载期
      void new RegExp(pattern);
    } catch (err) {
      throw new Error(`${where} 的正则不合法：${(err as Error).message}`);
    }
  }

  if (rule.permission !== undefined && !PERMISSIONS.includes(rule.permission)) {
    throw new Error(`${where} 的 permission 只能是 ${PERMISSIONS.join(' / ')}`);
  }
  if (rule.scope !== undefined && !SCOPES.includes(rule.scope)) {
    throw new Error(`${where} 的 scope 只能是 ${SCOPES.join(' / ')}`);
  }
}

/* ─────────────────────────── 归一化 ─────────────────────────── */

/** 把校验过的定义转成运行时结构 */
export function normalizePlugin(definition: PluginDefinition, file?: string): NormalizedPlugin {
  return {
    name: definition.name,
    desc: definition.desc ?? '',
    author: definition.author ?? '',
    priority: definition.priority ?? 5000,
    file,
    rules: definition.rules.map((rule) => {
      const used = MATCHERS.find((key) => rule[key] !== undefined && rule[key] !== null);
      const matcher = used ?? 'any';

      let value: string | RegExp | null = null;
      if (matcher === 'regex' && rule.regex !== undefined) {
        value = rule.regex instanceof RegExp ? rule.regex : new RegExp(rule.regex);
      } else if (matcher !== 'any') {
        value = String(rule[matcher] ?? '');
      }

      return {
        name: rule.name ?? (matcher === 'any' ? '全部消息' : String(value)),
        matcher,
        value,
        permission: rule.permission ?? 'all',
        scope: rule.scope ?? 'any',
        log: rule.log !== false,
        handler: rule.handler,
      };
    }),
  };
}

/** 匹配方式的可读描述 */
export function describeMatcher(
  rule: Pick<NormalizedRule, 'matcher' | 'value'>,
  prefix = '',
): string {
  switch (rule.matcher) {
    case 'command':
      return `命令 ${prefix}${String(rule.value)}`;
    case 'prefix':
      return `前缀 ${prefix}${String(rule.value)}`;
    case 'exact':
      return `完全匹配 ${prefix}${String(rule.value)}`;
    case 'regex':
      return `正则 ${String(rule.value)}`;
    case 'contains':
      return `包含 ${String(rule.value)}`;
    default:
      return '任意消息';
  }
}

/** 段构造器的再次导出，插件里可以只 import 这一个模块 */
export type { Segment };
export { MATCHERS, PERMISSIONS, SCOPES };
