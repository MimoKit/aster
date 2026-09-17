/**
 * 插件宿主：加载、匹配、分发、热重载。
 *
 * 插件是普通的 `.ts` / `.js` 文件，放在插件目录里就会被加载。
 * 监听文件变化并自动重载——**改完存盘即生效，不需要重启，更不需要编译**。
 *
 * 单文件出错只会让那个插件加载失败并打印原因，不会影响其他插件。
 */

import { EventEmitter } from 'node:events';
import { existsSync, type FSWatcher, readdirSync, statSync, watch } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createJiti } from 'jiti';

import type { Logger } from './logger.ts';
import type { Bot, BotRegistry, MessageInput } from './onebot11.ts';
import {
  describeMatcher,
  type NormalizedPlugin,
  normalizePlugin,
  type PluginContext,
} from './plugin.ts';
import type { Stats } from './stats.ts';
import type { AsterEvent, Id, MessageEvent, Permission, Scope, StatsSnapshot } from './types.ts';

/** 支持的插件文件后缀 */
const PLUGIN_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs']);

/** 重载防抖：编辑器保存一次可能触发多个事件 */
const RELOAD_DEBOUNCE_MS = 200;

/** 包根目录 */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 让插件可以用 `import { definePlugin } from 'aster-bot'`。
 *
 * 已构建时指向 dist，开发时回落到 TS 源码——两种情况都能跑，
 * 插件作者不需要关心框架是源码状态还是打包状态。
 */
function selfEntry(): string {
  const built = join(PACKAGE_ROOT, 'dist', 'index.js');
  return existsSync(built) ? built : join(PACKAGE_ROOT, 'src', 'index.ts');
}

/** 供 WebUI 展示的插件信息 */
export interface PluginInfo {
  name: string;
  desc: string;
  author: string;
  priority: number;
  enabled: boolean;
  ruleCount: number;
  file: string | null;
  rules: { name: string; matcher: string; permission: string; scope: string }[];
}

export interface PluginHostOptions {
  /** 插件目录列表，靠前的优先（用户目录应排在包内置目录之前） */
  dirs: string[];
  logger: Logger;
  stats: Stats;
  /** 账号注册表，供插件查询在线账号 */
  registry: BotRegistry;
  /** 框架版本 */
  version: string;
  /** 适配器监听地址，未启动时返回 null */
  address: () => { host: string; port: number; path: string; url: string } | null;
  /** 主人账号，用于权限判定 */
  masters: string[];
  /** 命令强制前缀 */
  commandPrefix: string;
  /** 是否监听文件变化 */
  hotReload: boolean;
}

export interface DispatchOptions {
  event: MessageEvent;
  bot: Bot;
}

export class PluginHost extends EventEmitter {
  readonly #options: PluginHostOptions;
  readonly #logger: Logger;
  readonly #plugins: NormalizedPlugin[] = [];
  readonly #errors: { file: string; message: string }[] = [];
  #watchers: FSWatcher[] = [];
  #reloadTimer: NodeJS.Timeout | null = null;
  #reloading = false;

  constructor(options: PluginHostOptions) {
    super();
    this.#options = options;
    this.#logger = options.logger.child('plugin');
  }

  /* ─────────────────────── 加载 ─────────────────────── */

  /** 扫描并加载全部插件 */
  async load(): Promise<void> {
    const collected: NormalizedPlugin[] = [];
    const errors: { file: string; message: string }[] = [];

    // 每次加载都用新的 jiti 实例，避免模块缓存导致改了文件不生效
    const jiti = createJiti(import.meta.url, {
      moduleCache: false,
      fsCache: false,
      alias: { 'aster-bot': selfEntry() },
    });

    const seen = new Set<string>();

    for (const dir of this.#options.dirs) {
      if (!existsSync(dir)) continue;

      let files: string[];
      try {
        files = readdirSync(dir)
          .filter((name) => PLUGIN_EXTENSIONS.has(extname(name)))
          .filter((name) => !name.startsWith('_') && !name.startsWith('.'))
          .sort();
      } catch (err) {
        errors.push({ file: dir, message: `读取目录失败：${(err as Error).message}` });
        continue;
      }

      for (const name of files) {
        const file = join(dir, name);
        try {
          const plugin = await loadPluginFile(jiti, file);
          // 同名插件的处理：靠前的目录优先
          if (seen.has(plugin.name)) {
            this.#logger.debug(`插件 ${plugin.name} 已被更优先的目录提供，跳过 ${file}`);
            continue;
          }
          seen.add(plugin.name);
          collected.push(plugin);
        } catch (err) {
          errors.push({ file, message: (err as Error).message });
        }
      }
    }

    // 按优先级排序，小的先执行
    collected.sort((a, b) => a.priority - b.priority);

    this.#plugins.length = 0;
    this.#plugins.push(...collected);
    this.#errors.length = 0;
    this.#errors.push(...errors);

    for (const error of errors) {
      this.#logger.error(`加载 ${error.file} 失败：${error.message}`);
    }

    this.#options.stats.setPlugins(this.#plugins.length);
  }

  /** 重新加载（热重载入口） */
  async reload(): Promise<void> {
    if (this.#reloading) return;
    this.#reloading = true;

    const before = this.#plugins.length;
    try {
      await this.load();
      const after = this.#plugins.length;
      const rules = this.ruleCount;

      if (before === 0 && after > 0) {
        this.#logger.info(`已加载 ${after} 个插件、${rules} 条规则`);
      } else {
        this.#logger.info(`插件已重载：${before} → ${after} 个，共 ${rules} 条规则`);
      }

      if (this.#errors.length > 0) {
        this.#logger.warn(`${this.#errors.length} 个插件加载失败，详见上方日志`);
      }

      this.emit('reload', this.list());
    } finally {
      this.#reloading = false;
    }
  }

  /* ─────────────────────── 监听 ─────────────────────── */

  /** 开始监听插件目录 */
  startWatching(): void {
    if (!this.#options.hotReload || this.#watchers.length > 0) return;

    const dirs = this.#options.dirs.filter((dir) => existsSync(dir));
    if (dirs.length === 0) return;

    const onChange = (): void => {
      if (this.#reloadTimer) clearTimeout(this.#reloadTimer);
      this.#reloadTimer = setTimeout(() => {
        this.#reloadTimer = null;
        void this.reload();
      }, RELOAD_DEBOUNCE_MS);
    };

    // fs.watch 一次只能监听一个路径，所以每个目录各起一个 watcher
    for (const dir of dirs) {
      try {
        this.#watchers.push(watch(dir, { recursive: true }, onChange));
      } catch (err) {
        this.#logger.warn(`无法监听 ${dir}（${(err as Error).message}）`);
      }
    }

    if (this.#watchers.length > 0) {
      this.#logger.info(`插件热重载已开启（${this.#watchers.length} 个目录），改动文件后自动生效`);
    }
  }

  /** 停止监听 */
  stopWatching(): void {
    if (this.#reloadTimer) {
      clearTimeout(this.#reloadTimer);
      this.#reloadTimer = null;
    }
    for (const watcher of this.#watchers) watcher.close();
    this.#watchers = [];
  }

  /* ─────────────────────── 查询 ─────────────────────── */

  /** 已加载插件 */
  get plugins(): readonly NormalizedPlugin[] {
    return this.#plugins;
  }

  /** 加载失败的插件 */
  get errors(): readonly { file: string; message: string }[] {
    return this.#errors;
  }

  get count(): number {
    return this.#plugins.length;
  }

  get ruleCount(): number {
    return this.#plugins.reduce((sum, plugin) => sum + plugin.rules.length, 0);
  }

  /** 供 WebUI 展示的清单 */
  list(): PluginInfo[] {
    return this.#plugins.map((plugin) => ({
      name: plugin.name,
      desc: plugin.desc,
      author: plugin.author,
      priority: plugin.priority,
      enabled: true,
      ruleCount: plugin.rules.length,
      file: plugin.file ?? null,
      rules: plugin.rules.map((rule) => ({
        name: rule.name,
        matcher: describeMatcher(rule, this.#options.commandPrefix),
        permission: rule.permission,
        scope: rule.scope,
      })),
    }));
  }

  /* ─────────────────────── 分发 ─────────────────────── */

  /**
   * 分发消息事件。
   *
   * 按插件优先级顺序尝试规则，命中即执行。
   * 处理函数返回 `false` 表示放行，其余（含 `undefined`）都视为已处理并停止。
   *
   * @returns 是否被处理
   */
  async dispatch({ event, bot }: DispatchOptions): Promise<boolean> {
    // 机器人自己发的消息不触发命令，避免自问自答
    if (event.messageSent) return false;

    const text = commandText(event, this.#options.commandPrefix);

    for (const plugin of this.#plugins) {
      for (const rule of plugin.rules) {
        if (!scopeAllows(rule.scope, event)) continue;

        const matched = matchRule(rule, text);
        if (matched === null) continue;

        if (!permissionAllows(rule.permission, event, this.#options.masters)) {
          if (rule.log) {
            this.#logger.info(
              `插件 ${plugin.name} 规则「${rule.name}」权限不足（需要 ${rule.permission}）：${event.displayName}`,
            );
          }
          continue;
        }

        if (rule.log) {
          this.#logger.info(
            `执行插件 ${plugin.name} 规则「${rule.name}」：${event.selfId} <= ${event.sessionId} | ${event.text.slice(0, 100)}`,
          );
        }

        this.#options.stats.recordCommand();

        const ctx = createContext({
          event,
          bot,
          args: matched.args,
          matches: matched.matches,
          plugin: plugin.name,
          rule: rule.name,
          logger: this.#logger,
          stats: this.#options.stats,
          registry: this.#options.registry,
          address: this.#options.address,
          version: this.#options.version,
        });

        try {
          const result = await rule.handler(ctx);
          // 只有显式返回 false 才放行
          if (result === false) continue;
          return true;
        } catch (err) {
          this.#logger.error(
            `插件 ${plugin.name} 规则「${rule.name}」执行出错：${(err as Error).message}`,
          );
          this.#logger.debug((err as Error).stack ?? '');
        }
      }
    }

    return false;
  }

  /** 释放资源 */
  destroy(): void {
    this.stopWatching();
    this.removeAllListeners();
    this.#plugins.length = 0;
  }
}

/* ─────────────────────── 单文件加载 ─────────────────────── */

async function loadPluginFile(
  jiti: ReturnType<typeof createJiti>,
  file: string,
): Promise<NormalizedPlugin> {
  const module = (await jiti.import(file)) as Record<string, unknown>;
  const definition = (module.default ?? module.plugin ?? module) as unknown;

  if (typeof definition !== 'object' || definition === null) {
    throw new Error('插件必须默认导出一个 definePlugin 的结果');
  }

  const candidate = definition as { name?: unknown; rules?: unknown };
  if (typeof candidate.name !== 'string') {
    throw new Error('插件缺少 name（是否忘了用 definePlugin 包装？）');
  }
  if (!Array.isArray(candidate.rules)) {
    throw new Error(`插件 ${candidate.name} 缺少 rules 数组`);
  }

  // definePlugin 已做过校验，这里只做结构归一
  return normalizePlugin(definition as Parameters<typeof normalizePlugin>[0], resolve(file));
}

/* ─────────────────────── 匹配 ─────────────────────── */

/**
 * 供匹配用的命令文本。
 *
 * 去掉消息开头的 `@机器人` 与命令前缀，让 `@bot as` 与 `as` 等价。
 */
function commandText(event: MessageEvent, commandPrefix: string): string {
  let text = event.text.trim();

  const selfAt = `@${event.selfId}`;
  if (text.startsWith(selfAt)) text = text.slice(selfAt.length).trim();

  if (commandPrefix.length > 0 && text.startsWith(commandPrefix)) {
    text = text.slice(commandPrefix.length).trim();
  }

  return text;
}

interface MatchResult {
  args: string;
  matches: string[];
}

/** 尝试匹配一条规则，未命中返回 null */
function matchRule(rule: NormalizedPlugin['rules'][number], text: string): MatchResult | null {
  switch (rule.matcher) {
    case 'any':
      return { args: text, matches: [text] };

    case 'command': {
      const keyword = String(rule.value);
      // 命令词必须独立成词：整条相等，或后面紧跟空白
      if (text === keyword) return { args: '', matches: [text] };
      if (text.startsWith(keyword)) {
        const rest = text.slice(keyword.length);
        if (/^\s/.test(rest)) return { args: rest.trim(), matches: [text, rest.trim()] };
      }
      return null;
    }

    case 'prefix': {
      const prefix = String(rule.value);
      if (!text.startsWith(prefix)) return null;
      return { args: text.slice(prefix.length).trim(), matches: [text] };
    }

    case 'exact':
      return text === String(rule.value) ? { args: '', matches: [text] } : null;

    case 'contains':
      return text.includes(String(rule.value)) ? { args: '', matches: [text] } : null;

    case 'regex': {
      const pattern = rule.value as RegExp;
      const match = pattern.exec(text);
      if (!match) return null;
      const matches = [...match];
      return { args: (matches[1] ?? matches[0] ?? '').trim(), matches };
    }

    default:
      return null;
  }
}

/** 会话范围判定 */
function scopeAllows(scope: Scope, event: MessageEvent): boolean {
  switch (scope) {
    case 'group':
      return event.isGroup;
    case 'private':
      return event.isPrivate;
    default:
      return true;
  }
}

/**
 * 权限判定。
 *
 * 主人始终放行；`admin` 认可管理员与群主；`owner` 只认群主。
 */
export function permissionAllows(
  permission: Permission,
  event: MessageEvent,
  masters: readonly string[],
): boolean {
  if (permission === 'all') return true;
  if (masters.some((master) => String(master) === String(event.userId))) return true;

  const role = event.sender.role;
  switch (permission) {
    case 'master':
      return false;
    case 'admin':
      return role === 'admin' || role === 'owner';
    case 'owner':
      return role === 'owner';
    default:
      return true;
  }
}

/* ─────────────────────── 上下文构造 ─────────────────────── */

function createContext(input: {
  event: MessageEvent;
  bot: Bot;
  args: string;
  matches: string[];
  plugin: string;
  rule: string;
  logger: Logger;
  stats: Stats;
  registry: BotRegistry;
  address: () => { host: string; port: number; path: string; url: string } | null;
  version: string;
}): PluginContext {
  const { event, bot, args, matches, plugin, rule, logger, stats, registry, address, version } =
    input;

  const reply = (message: MessageInput): Promise<unknown> => bot.reply(event, message);

  return {
    event,
    args,
    matches,
    plugin,
    rule,
    bot,
    logger,
    isGroup: event.isGroup,
    isPrivate: event.isPrivate,
    groupId: event.groupId,
    userId: event.userId,
    selfId: event.selfId,
    sessionId: event.sessionId,
    displayName: event.displayName,

    reply,
    replyAt: (message) => bot.replyAt(event, message),
    replyQuote: (message) => bot.replyQuote(event, message),
    call: (action, params) => bot.call(action, params),

    log(message, level = 'info'): void {
      logger[level](`[${plugin}] ${String(message)}`);
    },

    bots: registry.list(),
    address: address(),
    version,
    status(): StatsSnapshot {
      return stats.snapshot(version);
    },
  };
}

/** 事件是否是消息事件（类型守卫） */
export function isMessageEvent(event: AsterEvent): event is MessageEvent {
  return event.type === 'message';
}

/** 目录是否存在且是目录 */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export type { Id };
