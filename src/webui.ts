/**
 * WebUI 的 HTTP 服务。
 *
 * 两件事：
 * 1. 提供 `/api/*` 接口给前端
 * 2. 托管前端构建产物（`webui/dist`），未构建时给一个明确的占位页
 *
 * 实时数据走 SSE：日志与事件各一条流，比轮询省事也更即时。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

import type { AsterConfig, LoadedConfig, WebUiConfig } from './config.ts';
import { getByPath, setByPath, validateConfig } from './config.ts';
import { asId, asString, eventName } from './event.ts';
import type { LogEntry, Logger } from './logger.ts';
import type { OneBot11Server } from './onebot11.ts';
import { buildMessage, type MessageInput } from './onebot11.ts';
import type { PluginHost } from './plugin-host.ts';
import type { Stats } from './stats.ts';
import type { AsterEvent } from './types.ts';

/** 静态资源的 MIME 类型 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** 未构建前端时的占位页 */
const FALLBACK_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Aster</title>
<style>
:root{color-scheme:light}
body{font:14px/1.7 ui-sans-serif,system-ui,-apple-system,"Noto Sans CJK SC",sans-serif;
  max-width:40rem;margin:16vh auto;padding:0 1.5rem;color:#18181b;background:#fafafa}
h1{font-size:1.25rem;margin:0 0 .375rem;letter-spacing:-.01em}
p{color:#52525b;margin:.5rem 0}
code{background:#f4f4f5;border:1px solid #e4e4e7;padding:.1em .35em;border-radius:4px;font-size:.9em}
pre{background:#fff;border:1px solid #e4e4e7;border-radius:8px;padding:.875rem 1rem;overflow:auto;font-size:12px}
a{color:#0f766e}
</style></head><body>
<h1>Aster WebUI</h1>
<p>接口已经就绪，但前端还没有构建。</p>
<pre>cd webui
npm install
npm run build</pre>
<p>产物会输出到 <code>webui/dist</code>，刷新本页即可。</p>
<p>也可以直接看接口：<a href="/api/overview">/api/overview</a></p>
</body></html>`;

export interface WebUiDeps {
  config: AsterConfig;
  loaded: LoadedConfig;
  logger: Logger;
  stats: Stats;
  server: OneBot11Server;
  plugins: PluginHost;
  version: string;
  /** 前端构建产物目录 */
  distDir: string | null;
}

export class WebUiServer {
  readonly #deps: WebUiDeps;
  readonly #config: WebUiConfig;
  readonly #logger: Logger;
  readonly #http: Server;
  #listening = false;

  constructor(deps: WebUiDeps) {
    this.#deps = deps;
    this.#config = deps.config.webui;
    this.#logger = deps.logger.child('webui');
    this.#http = createServer((req, res) => {
      void this.#handle(req, res).catch((err: Error) => {
        this.#logger.error(`请求处理失败：${err.message}`);
        if (!res.headersSent) this.#json(res, 500, { error: 'internal', message: err.message });
        else res.end();
      });
    });
  }

  /** 启动监听 */
  async start(): Promise<{ url: string; host: string; port: number }> {
    const { host, port } = this.#config;

    await new Promise<void>((resolve_, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        this.#http.off('listening', onListening);
        if (err.code === 'EADDRINUSE') {
          reject(
            new Error(
              `WebUI 监听 ${host}:${port} 失败：端口已被占用。\n` +
                `可用 ss -ltnp | grep ${port} 查看占用进程。`,
            ),
          );
          return;
        }
        if (err.code === 'EACCES' && port < 1024) {
          reject(new Error(`WebUI 监听 ${host}:${port} 失败：端口属于特权端口（<1024）`));
          return;
        }
        reject(new Error(`WebUI 监听 ${host}:${port} 失败：${err.message}`));
      };
      const onListening = (): void => {
        this.#http.off('error', onError);
        resolve_();
      };

      this.#http.once('error', onError);
      this.#http.once('listening', onListening);
      this.#http.listen(port, host);
    });

    this.#listening = true;

    // 端口配置为 0 时由系统分配，读回真实端口
    const bound = this.#http.address();
    const actualPort = typeof bound === 'object' && bound !== null ? bound.port : port;

    const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    const url = `http://${displayHost}:${actualPort}`;

    this.#logger.info(`已启动：${url}`);
    if (!this.#config.accessToken) {
      this.#logger.debug('未设置 access_token，仅建议在本机使用');
    }
    if (!this.#deps.distDir) {
      this.#logger.warn('未找到前端构建产物，页面会显示构建提示（接口仍然可用）');
    }

    return { url, host, port: actualPort };
  }

  /** 停止 */
  async stop(): Promise<void> {
    if (!this.#listening) return;
    this.#listening = false;
    await new Promise<void>((resolve_) => {
      this.#http.close(() => resolve_());
      setTimeout(resolve_, 800).unref?.();
    });
  }

  /* ─────────────────────── 路由 ─────────────────────── */

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    if (!path.startsWith('/api/')) {
      this.#serveStatic(path, res);
      return;
    }

    if (!this.#authorize(req, url, res)) return;

    const method = req.method ?? 'GET';

    // 简单路由表
    if (method === 'GET' && path === '/api/health') {
      this.#json(res, 200, { status: 'ok', version: this.#deps.version });
      return;
    }
    if (method === 'GET' && path === '/api/overview') {
      this.#json(res, 200, this.#overview());
      return;
    }
    if (method === 'GET' && path === '/api/bots') {
      this.#json(res, 200, { bots: this.#bots() });
      return;
    }
    if (method === 'GET' && path === '/api/plugins') {
      this.#json(res, 200, this.#plugins());
      return;
    }
    if (method === 'GET' && path === '/api/config') {
      this.#json(res, 200, { config: this.#deps.config, path: this.#deps.loaded.path });
      return;
    }
    if (method === 'GET' && path === '/api/config/schema') {
      this.#json(res, 200, { fields: CONFIG_SCHEMA });
      return;
    }
    if (method === 'PATCH' && path === '/api/config') {
      await this.#patchConfig(req, res);
      return;
    }
    if (method === 'GET' && path === '/api/logs') {
      const limit = Number(url.searchParams.get('limit') ?? 500);
      const level = url.searchParams.get('level') ?? undefined;
      const after = url.searchParams.get('after');
      const entries = this.#deps.logger.entries({
        limit,
        ...(level === null ? {} : { level }),
        ...(after === null ? {} : { afterSeq: Number(after) }),
      });
      this.#json(res, 200, {
        logs: entries,
        count: entries.length,
        capacity: this.#deps.logger.size,
      });
      return;
    }
    if (method === 'GET' && path === '/api/logs/stream') {
      this.#streamLogs(req, res);
      return;
    }
    if (method === 'GET' && path === '/api/events/stream') {
      this.#streamEvents(req, res);
      return;
    }
    if (method === 'POST' && path === '/api/plugins/reload') {
      await this.#deps.plugins.reload();
      this.#json(res, 200, { ok: true, ...(this.#plugins() as object) });
      return;
    }
    if (method === 'POST' && path === '/api/message/send') {
      await this.#sendMessage(req, res);
      return;
    }

    this.#json(res, 404, { error: 'not_found', message: `未知接口 ${method} ${path}` });
  }

  /* ─────────────────────── 鉴权 ─────────────────────── */

  #authorize(req: IncomingMessage, url: URL, res: ServerResponse): boolean {
    const expected = this.#config.accessToken;
    if (expected.length === 0) return true;

    const header = req.headers.authorization;
    if (typeof header === 'string') {
      const value = header.trim();
      for (const prefix of ['Bearer ', 'bearer ', 'Token ', 'token ']) {
        if (value.startsWith(prefix) && value.slice(prefix.length).trim() === expected) return true;
      }
      if (value === expected) return true;
    }

    // SSE 无法自定义请求头，允许查询参数
    if (url.searchParams.get('token') === expected) return true;

    this.#json(res, 401, { error: 'unauthorized', message: '访问令牌无效或缺失' });
    return false;
  }

  /* ─────────────────────── 接口实现 ─────────────────────── */

  #overview(): unknown {
    const { config, stats, server, plugins, logger, version } = this.#deps;
    const snapshot = stats.snapshot(version);

    return {
      bot: {
        name: config.bot.name,
        version: snapshot.version,
        startedAt: snapshot.startedAt,
        uptime: snapshot.uptimeText,
        uptimeSecs: snapshot.uptime,
      },
      stats: {
        events: snapshot.events,
        messages: snapshot.messages,
        notices: snapshot.notices,
        requests: snapshot.requests,
        metaEvents: snapshot.metaEvents,
        commands: snapshot.commands,
      },
      plugins: { count: plugins.count, rules: plugins.ruleCount },
      onebot11: {
        enable: config.onebot11.enable,
        host: config.onebot11.host,
        port: config.onebot11.port,
        path: server.path,
        auth: config.onebot11.accessToken.length > 0,
      },
      webui: { auth: config.webui.accessToken.length > 0 },
      bots: this.#bots(),
      logCount: logger.size,
    };
  }

  #bots(): unknown[] {
    return this.#deps.server.registry.list().map((bot) => ({
      selfId: bot.selfId,
      nickname: bot.nickname,
      uin: bot.uin,
      avatar: bot.avatar,
      online: bot.online,
      connections: bot.connections,
      connectedSecs: bot.connectedSeconds,
    }));
  }

  #plugins(): unknown {
    const list = this.#deps.plugins.list();
    return {
      plugins: list.map((plugin) => ({
        name: plugin.name,
        desc: plugin.desc,
        author: plugin.author,
        priority: plugin.priority,
        enabled: plugin.enabled,
        ruleCount: plugin.ruleCount,
        file: plugin.file,
        rules: plugin.rules,
      })),
      count: list.length,
      rules: list.reduce((sum, plugin) => sum + plugin.ruleCount, 0),
      errors: this.#deps.plugins.errors,
      hotReload: this.#deps.config.plugin.hotReload,
      dirs: this.#deps.plugins.plugins
        .map((plugin) => plugin.file)
        .filter((file): file is string => file !== undefined)
        .map((file) => file.slice(0, file.lastIndexOf('/'))),
    };
  }

  /** 局部更新配置 */
  async #patchConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const values = (body as { values?: Record<string, unknown> })?.values;

    if (!values || typeof values !== 'object' || Object.keys(values).length === 0) {
      this.#json(res, 400, { error: 'empty', message: '没有需要更新的配置项' });
      return;
    }

    let next = this.#deps.config;
    for (const [path, value] of Object.entries(values)) {
      try {
        next = setByPath(next, path, value);
      } catch (err) {
        this.#json(res, 400, { error: 'invalid_key', message: (err as Error).message });
        return;
      }
    }

    const problems = validateConfig(next);
    if (problems.length > 0) {
      this.#json(res, 400, { error: 'invalid_config', message: problems.join('；') });
      return;
    }

    // 复用同一次加载结果的路径写回
    const { saveConfig } = await import('./config.ts');
    saveConfig(this.#deps.loaded, next);
    this.#deps.config = next;
    this.#logger.info(`配置已更新：${Object.keys(values).join(', ')}`);

    this.#json(res, 200, {
      ok: true,
      restartRequired: true,
      message: '配置已保存，重启后生效',
    });
  }

  /** 发送消息（测试台） */
  async #sendMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJson(req)) as {
      target?: string;
      id?: string;
      message?: unknown;
      selfId?: string;
    };

    const target = body?.target;
    if (target !== 'group' && target !== 'private') {
      this.#json(res, 400, {
        error: 'invalid_target',
        message: `target 只能是 group 或 private，收到 ${String(target)}`,
      });
      return;
    }

    const id = asId(body.id);
    if (id === null) {
      this.#json(res, 400, { error: 'invalid_id', message: '缺少目标群号或用户号' });
      return;
    }

    const registry = this.#deps.server.registry;
    const bot = body.selfId ? registry.get(String(body.selfId)) : registry.first();
    if (!bot) {
      this.#json(res, 503, { error: 'no_bot', message: '没有在线账号，请先让协议端连接' });
      return;
    }

    const message = (body.message ?? '') as MessageInput;

    try {
      const data =
        target === 'group'
          ? await bot.sendGroupMsg(id, message)
          : await bot.sendPrivateMsg(id, message);
      this.#json(res, 200, { ok: true, data });
    } catch (err) {
      this.#json(res, 502, { error: 'send_failed', message: (err as Error).message });
    }
  }

  /* ─────────────────────── SSE ─────────────────────── */

  /** 日志实时流 */
  #streamLogs(req: IncomingMessage, res: ServerResponse): void {
    this.#openStream(res, 'logs');
    const unsubscribe = this.#deps.logger.subscribe((entry: LogEntry) => {
      writeEvent(res, 'log', entry);
    });
    req.on('close', unsubscribe);
  }

  /** 事件实时流 */
  #streamEvents(req: IncomingMessage, res: ServerResponse): void {
    this.#openStream(res, 'events');
    const onEvent = (event: AsterEvent): void => {
      writeEvent(res, 'event', {
        name: eventName(event),
        time: 'time' in event ? event.time : 0,
        selfId: 'selfId' in event ? event.selfId : null,
        raw: event.raw,
      });
    };
    this.#deps.server.on('event', onEvent);
    req.on('close', () => {
      this.#deps.server.off('event', onEvent);
    });
  }

  #openStream(res: ServerResponse, label: string): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`: ${label} stream opened\n\n`);
    this.#logger.debug(`${label} 流已建立`);
  }

  /* ─────────────────────── 静态资源 ─────────────────────── */

  #serveStatic(path: string, res: ServerResponse): void {
    const dist = this.#deps.distDir;

    if (!dist) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FALLBACK_PAGE);
      return;
    }

    // 防目录穿越：规范化后必须仍在 dist 内
    const relative = normalize(path).replace(/^(\.\.[/\\])+/, '');
    let file = resolve(dist, `.${relative}`);

    if (!file.startsWith(resolve(dist))) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // 目录或不存在 → 回落到 index.html（前端是 SPA）
    if (!existsSync(file) || statSync(file).isDirectory()) {
      file = join(dist, 'index.html');
      if (!existsSync(file)) {
        res.writeHead(404);
        res.end('index.html not found');
        return;
      }
    }

    try {
      const data = readFileSync(file);
      const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
      // 带 hash 的静态资源可以长缓存，index.html 必须每次校验
      const cache = file.endsWith('index.html')
        ? 'no-cache'
        : 'public, max-age=31536000, immutable';
      res.writeHead(200, { 'content-type': type, 'cache-control': cache });
      res.end(data);
    } catch (err) {
      res.writeHead(500);
      res.end(`读取 ${file} 失败：${(err as Error).message}`);
    }
  }

  /* ─────────────────────── 工具 ─────────────────────── */

  #json(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
    });
    res.end(text);
  }
}

/* ─────────────────────── 配置表单 schema ─────────────────────── */

/** 驱动前端表单渲染的字段元信息 */
const CONFIG_SCHEMA = [
  { key: 'bot.name', label: '框架名称', type: 'string', group: '基础' },
  {
    key: 'bot.commandPrefix',
    label: '命令前缀',
    type: 'string',
    group: '基础',
    hint: '留空则命令直接以命令词开头，例如 as',
  },
  { key: 'bot.masters', label: '主人账号', type: 'string[]', group: '基础' },
  { key: 'bot.builtinPlugins', label: '启用内置插件', type: 'boolean', group: '基础' },

  {
    key: 'log.level',
    label: '日志级别',
    type: 'enum',
    group: '日志',
    options: ['trace', 'debug', 'info', 'warn', 'error', 'silent'],
  },
  { key: 'log.maxLength', label: '单条日志上限', type: 'number', group: '日志' },
  { key: 'log.showBase64', label: '打印完整 base64', type: 'boolean', group: '日志' },
  { key: 'log.color', label: '终端彩色输出', type: 'boolean', group: '日志' },

  { key: 'onebot11.enable', label: '启用适配器', type: 'boolean', group: 'OneBot v11' },
  { key: 'onebot11.host', label: '监听地址', type: 'string', group: 'OneBot v11' },
  { key: 'onebot11.port', label: '监听端口', type: 'number', group: 'OneBot v11' },
  { key: 'onebot11.path', label: '挂载路径', type: 'string', group: 'OneBot v11' },
  {
    key: 'onebot11.accessToken',
    label: '鉴权 Token',
    type: 'password',
    group: 'OneBot v11',
  },
  { key: 'onebot11.trustedIps', label: 'IP 白名单', type: 'string[]', group: 'OneBot v11' },
  {
    key: 'onebot11.heartbeatTimeout',
    label: '心跳超时（秒）',
    type: 'number',
    group: 'OneBot v11',
  },
  {
    key: 'onebot11.handshakeTimeout',
    label: '握手超时（秒）',
    type: 'number',
    group: 'OneBot v11',
  },
  {
    key: 'onebot11.requestTimeout',
    label: '请求超时（秒）',
    type: 'number',
    group: 'OneBot v11',
  },

  { key: 'webui.enable', label: '启用 WebUI', type: 'boolean', group: 'WebUI' },
  { key: 'webui.host', label: '监听地址', type: 'string', group: 'WebUI' },
  { key: 'webui.port', label: '监听端口', type: 'number', group: 'WebUI' },
  { key: 'webui.accessToken', label: '访问令牌', type: 'password', group: 'WebUI' },
  { key: 'webui.logCapacity', label: '日志保留条数', type: 'number', group: 'WebUI' },

  { key: 'plugin.dir', label: '插件目录', type: 'string', group: '插件' },
  { key: 'plugin.hotReload', label: '热重载', type: 'boolean', group: '插件' },
];

/* ─────────────────────── 请求工具 ─────────────────────── */

/** 读取并解析 JSON 请求体（限制大小，避免被塞爆内存） */
async function readJson(req: IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(buf);
  }

  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim().length === 0) return {};
  return JSON.parse(text);
}

/** 写一条 SSE 事件 */
function writeEvent(res: ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** 供 app 使用：读取配置里的可展示字段 */
export function configValue(config: AsterConfig, path: string): unknown {
  return getByPath(config, path);
}

export { asString, buildMessage };
