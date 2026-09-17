/**
 * Aster 的公开 API。
 *
 * 插件作者通常只需要 `definePlugin` 和 `seg`：
 *
 * ```ts
 * import { definePlugin, seg } from 'aster-bot'
 * ```
 *
 * 想在别的 Node 项目里嵌入 Aster，用 {@link App}：
 *
 * ```ts
 * import { App } from 'aster-bot'
 *
 * const app = await App.create({ dataDir: './data' })
 * await app.start()
 * await app.waitForShutdown()
 * ```
 */

export type { AppOptions, StartResult } from './app.ts';
/* ─── 应用 ─── */
export { App, findWebUiDist, PACKAGE_ROOT } from './app.ts';
export type {
  AsterConfig,
  BotConfig,
  LoadedConfig,
  LogConfig,
  Onebot11Config,
  PluginConfig,
  WebUiConfig,
} from './config.ts';
/* ─── 配置 ─── */
export {
  DEFAULT_CONFIG_TOML,
  defaultConfig,
  getByPath,
  loadConfig,
  normalizePath,
  resolvePluginDir,
  saveConfig,
  setByPath,
  validateConfig,
} from './config.ts';
/* ─── 事件归一化 ─── */
export {
  asBoolean,
  asId,
  asNumber,
  asString,
  eventName,
  isObj,
  normalizeEvent,
} from './event.ts';
export type { LogEntry, LogLevel } from './logger.ts';
/* ─── 基础设施 ─── */
export { collapseBase64, createFallbackLogger, Logger } from './logger.ts';
/* ─── 消息处理 ─── */
export {
  atList,
  escapeCqParam,
  escapeCqText,
  hasImage,
  isAt,
  isAtAll,
  isEmpty,
  isPlainText,
  parseCq,
  parseMessage,
  parseSegmentObject,
  readableText,
  replyId,
  seg,
  textOnly,
  toArray,
  toCq,
  unescapeCq,
} from './message.ts';
export type { ApiResponse, MessageInput, ServerAddress } from './onebot11.ts';
/* ─── 适配器 ─── */
export { Bot, BotRegistry, OneBot11Server, OneBotConnection } from './onebot11.ts';
export type {
  NormalizedPlugin,
  NormalizedRule,
  PluginContext,
  PluginDefinition,
  PluginHandler,
  PluginRule,
} from './plugin.ts';
/* ─── 插件开发 ─── */
export {
  definePlugin,
  describeMatcher,
  MATCHERS,
  normalizePlugin,
  PERMISSIONS,
  SCOPES,
} from './plugin.ts';
export type { PluginHostOptions, PluginInfo } from './plugin-host.ts';
/* ─── 插件宿主 ─── */
export { isDirectory, isMessageEvent, PluginHost, permissionAllows } from './plugin-host.ts';
export { formatBytes, formatDuration, Stats } from './stats.ts';
/* ─── 核心类型 ─── */
export type {
  Anonymous,
  AsterEvent,
  AtSegment,
  HandlerResult,
  Id,
  ImageSegment,
  MatcherKind,
  MessageEvent,
  MessageType,
  MetaEvent,
  NoticeEvent,
  Permission,
  RequestEvent,
  Scope,
  Segment,
  Sender,
  StatsSnapshot,
  UnknownEvent,
} from './types.ts';
export type { WebUiDeps } from './webui.ts';
export { WebUiServer } from './webui.ts';
