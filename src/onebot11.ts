/**
 * OneBot v11 适配器。
 *
 * 采用**反向 WebSocket**：框架监听端口，协议端（Lagrange / NapCat / LLOneBot /
 * go-cqhttp 等）主动连上来并上报事件。
 *
 * ```text
 * 协议端 ──ws──▶ OneBot11Server ──▶ normalizeEvent ──▶ EventEmitter('event')
 *                    │
 *                    └─ call() ──echo──▶ 协议端 ──result──▶ 兑现 Promise
 * ```
 *
 * `call` 用 `echo` 关联请求与响应：每次调用分配一个唯一 id，
 * 收到带同样 id 的响应时兑现对应的 Promise，超时则拒绝。
 */

import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';

import { type RawData, type WebSocket, WebSocketServer } from 'ws';

import type { Onebot11Config } from './config.ts';
import { normalizePath } from './config.ts';
import { asId, asString, normalizeEvent } from './event.ts';
import type { Logger } from './logger.ts';
import { seg } from './message.ts';
import type { AsterEvent, Id, MessageEvent, Segment } from './types.ts';

/* ─────────────────────────── 消息输入 ─────────────────────────── */

/** 可以传给发送接口的消息形态 */
export type MessageInput = string | Segment | Segment[];

/** 归一化成协议端可接受的形态 */
export function buildMessage(input: MessageInput): unknown {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) return input;
  return [input];
}

/* ─────────────────────────── API 响应 ─────────────────────────── */

export interface ApiResponse {
  status?: string;
  retcode?: number;
  data?: unknown;
  echo?: unknown;
  msg?: string;
  wording?: string;
}

/** retcode 0 与 1 都算成功（部分实现用 1 表示已受理） */
function isOk(response: ApiResponse): boolean {
  if (response.status === 'failed') return false;
  return response.retcode === 0 || response.retcode === 1;
}

function errorOf(response: ApiResponse): string {
  return (
    response.msg ?? response.wording ?? `retcode=${response.retcode} status=${response.status}`
  );
}

/** 从原始帧里解析出 API 响应（带 echo 且不是事件） */
function parseResponse(value: unknown): ApiResponse | null {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (!('echo' in obj)) return null;
  if (typeof obj.post_type === 'string') return null;
  return obj as ApiResponse;
}

/* ─────────────────────────── 单条连接 ─────────────────────────── */

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  action: string;
}

let echoSeq = 0;

export class OneBotConnection extends EventEmitter {
  readonly remote: string;
  readonly path: string;
  readonly #socket: WebSocket;
  readonly #logger: Logger;
  readonly #timeoutMs: number;
  readonly #heartbeatMs: number;
  readonly #pending = new Map<string, Pending>();

  /** 握手完成后的账号，`lifecycle connect` 之前为 null */
  selfId: Id | null = null;
  /** 最近一次收到数据的时间 */
  lastSeen = Date.now();
  #closed = false;

  constructor(
    socket: WebSocket,
    options: {
      remote: string;
      path: string;
      logger: Logger;
      requestTimeout: number;
      heartbeatTimeout: number;
    },
  ) {
    super();
    this.#socket = socket;
    this.remote = options.remote;
    this.path = options.path;
    this.#logger = options.logger;
    this.#timeoutMs = options.requestTimeout * 1000;
    this.#heartbeatMs = options.heartbeatTimeout * 1000;

    socket.on('message', (data) => this.#onMessage(data));
    socket.on('close', () => this.#onClose());
    socket.on('error', (err) => {
      this.#logger.debug(`连接错误：${err.message}`, 'onebot11');
    });
    socket.on('pong', () => {
      this.lastSeen = Date.now();
    });

    this.#startHeartbeat();
  }

  /** 是否已关闭 */
  get closed(): boolean {
    return this.#closed;
  }

  /** 空闲秒数 */
  get idleSeconds(): number {
    return Math.floor((Date.now() - this.lastSeen) / 1000);
  }

  /** 心跳与超时检测 */
  #startHeartbeat(): void {
    const timer = setInterval(
      () => {
        if (this.#closed) {
          clearInterval(timer);
          return;
        }
        if (this.#heartbeatMs > 0 && Date.now() - this.lastSeen > this.#heartbeatMs) {
          this.#logger.warn(
            `${this.remote} 心跳超时（${this.idleSeconds} 秒未收到数据），断开连接`,
            'onebot11',
          );
          this.close();
          return;
        }
        // 主动 ping，让对端与内核都能感知链路状态
        try {
          this.#socket.ping();
        } catch {
          /* 忽略 */
        }
      },
      Math.min(10_000, Math.max(3000, this.#heartbeatMs / 3)),
    );
    timer.unref?.();
  }

  /** 收到一帧 */
  #onMessage(data: RawData): void {
    this.lastSeen = Date.now();

    let value: unknown;
    try {
      value = JSON.parse(data.toString());
    } catch {
      this.#logger.warn(`收到无法解析的帧：${data.toString().slice(0, 200)}`, 'onebot11');
      return;
    }

    // 先看是不是 API 响应
    const response = parseResponse(value);
    if (response) {
      this.#settle(response);
      return;
    }

    const event = normalizeEvent(value);

    if (event.type === 'meta' && event.isConnect) {
      this.#onConnect(event.selfId);
    }

    this.emit('event', event);
  }

  /** 处理 lifecycle connect */
  #onConnect(selfId: Id): void {
    if (this.selfId === selfId) return;
    this.selfId = selfId;
    this.#logger.info(`账号 ${selfId} 上线（${this.remote}）`, 'onebot11');
    this.emit('connect', selfId, this);
  }

  /** 兑现响应 */
  #settle(response: ApiResponse): void {
    const key = asString(response.echo);
    if (key === null) return;

    const pending = this.#pending.get(key);
    if (!pending) {
      this.#logger.debug(`收到未知 echo 的响应：${key}`, 'onebot11');
      return;
    }

    this.#pending.delete(key);
    clearTimeout(pending.timer);

    if (isOk(response)) {
      pending.resolve(response.data);
    } else {
      pending.reject(new Error(`${pending.action} 调用失败：${errorOf(response)}`));
    }
  }

  /**
   * 调用 API
   *
   * @param action 动作名，如 `send_group_msg`
   * @param params 参数
   */
  call<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new Error(`连接已关闭，无法调用 ${action}`));
    }

    echoSeq += 1;
    const echo = `${Date.now().toString(36)}-${echoSeq.toString(36)}`;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(echo);
        reject(new Error(`${action} 调用超时（${this.#timeoutMs}ms）`));
      }, this.#timeoutMs);
      timer.unref?.();

      this.#pending.set(echo, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        action,
      });

      try {
        this.#socket.send(JSON.stringify({ action, params, echo }));
      } catch (err) {
        this.#pending.delete(echo);
        clearTimeout(timer);
        reject(err as Error);
      }
    });
  }

  /** 关闭连接 */
  close(code = 1000, reason = 'server closing'): void {
    if (this.#closed) return;
    this.#closed = true;

    // 挂起的请求立即失败，不要等超时
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`连接已关闭，${pending.action} 被中断`));
    }
    this.#pending.clear();

    try {
      this.#socket.close(code, reason);
    } catch {
      this.#socket.terminate();
    }
    this.emit('close');
  }

  #onClose(): void {
    if (this.#closed) return;
    this.#closed = true;

    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`连接已断开，${pending.action} 被中断`));
    }
    this.#pending.clear();
    this.emit('close');
  }

  /** 当前挂起的请求数 */
  get pendingCount(): number {
    return this.#pending.size;
  }
}

/* ─────────────────────────── 账号 ─────────────────────────── */

interface BotEntry {
  selfId: Id;
  connection: OneBotConnection;
  info: { userId: Id | null; nickname: string | null };
  connections: number;
  connectedAt: number;
  online: boolean;
}

/**
 * 账号句柄。
 *
 * 每次调用都从注册表取当前连接，因此协议端重连后不需要替换句柄——
 * 这是上一版用固定连接导致「重连后发不出消息」的根因。
 */
export class Bot {
  readonly selfId: Id;
  readonly #registry: BotRegistry;

  constructor(registry: BotRegistry, selfId: Id) {
    this.#registry = registry;
    this.selfId = selfId;
  }

  #entry(): BotEntry | null {
    return this.#registry.entry(this.selfId);
  }

  /** 是否在线 */
  get online(): boolean {
    return this.#entry()?.online ?? false;
  }

  /** 登录号 */
  get uin(): Id {
    return this.#entry()?.info.userId ?? this.selfId;
  }

  /** 昵称 */
  get nickname(): string | null {
    return this.#entry()?.info.nickname ?? null;
  }

  /** 头像地址 */
  get avatar(): string {
    return `https://q.qlogo.cn/g?b=qq&s=0&nk=${this.uin}`;
  }

  /** 活跃连接数 */
  get connections(): number {
    return this.#entry()?.connections ?? 0;
  }

  /** 在线时长（秒） */
  get connectedSeconds(): number {
    const entry = this.#entry();
    return entry ? Math.floor((Date.now() - entry.connectedAt) / 1000) : 0;
  }

  /** 调用任意 API */
  async call<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    const entry = this.#entry();
    if (!entry) throw new Error(`账号 ${this.selfId} 不在线`);
    return entry.connection.call<T>(action, params);
  }

  /** 发送群消息 */
  sendGroupMsg(groupId: Id, message: MessageInput): Promise<unknown> {
    return this.call('send_group_msg', {
      group_id: String(groupId),
      message: buildMessage(message),
    });
  }

  /** 发送私聊消息 */
  sendPrivateMsg(userId: Id, message: MessageInput): Promise<unknown> {
    return this.call('send_private_msg', {
      user_id: String(userId),
      message: buildMessage(message),
    });
  }

  /** 发送群合并转发 */
  sendGroupForwardMsg(groupId: Id, nodes: Segment[]): Promise<unknown> {
    return this.call('send_group_forward_msg', {
      group_id: String(groupId),
      messages: nodes,
    });
  }

  /** 发送私聊合并转发 */
  sendPrivateForwardMsg(userId: Id, nodes: Segment[]): Promise<unknown> {
    return this.call('send_private_forward_msg', {
      user_id: String(userId),
      messages: nodes,
    });
  }

  /** 撤回消息 */
  deleteMsg(messageId: Id): Promise<unknown> {
    return this.call('delete_msg', { message_id: String(messageId) });
  }

  /** 群禁言（duration 为 0 表示解除） */
  setGroupBan(groupId: Id, userId: Id, duration: number): Promise<unknown> {
    return this.call('set_group_ban', {
      group_id: String(groupId),
      user_id: String(userId),
      duration,
    });
  }

  /** 处理加好友请求 */
  setFriendAddRequest(flag: string, approve: boolean, remark = ''): Promise<unknown> {
    return this.call('set_friend_add_request', { flag, approve, remark });
  }

  /** 处理加群请求 */
  setGroupAddRequest(
    flag: string,
    subType: string,
    approve: boolean,
    reason = '',
  ): Promise<unknown> {
    return this.call('set_group_add_request', { flag, sub_type: subType, approve, reason });
  }

  /** 回复消息（自动判断群聊/私聊） */
  reply(event: MessageEvent, message: MessageInput): Promise<unknown> {
    return event.groupId !== null
      ? this.sendGroupMsg(event.groupId, message)
      : this.sendPrivateMsg(event.userId, message);
  }

  /** 回复并 @ 发送者 */
  replyAt(event: MessageEvent, message: MessageInput): Promise<unknown> {
    const prefix = [seg.at(event.userId), seg.text(' ')];
    if (typeof message === 'string') {
      return this.reply(event, [...prefix, seg.text(message)]);
    }
    return this.reply(event, [...prefix, ...(Array.isArray(message) ? message : [message])]);
  }

  /** 引用回复 */
  replyQuote(event: MessageEvent, message: MessageInput): Promise<unknown> {
    const prefix = [seg.reply(event.messageId)];
    if (typeof message === 'string') {
      return this.reply(event, [...prefix, seg.text(message)]);
    }
    return this.reply(event, [...prefix, ...(Array.isArray(message) ? message : [message])]);
  }

  /** 获取登录号信息 */
  getLoginInfo(): Promise<{ user_id?: Id; nickname?: string }> {
    return this.call('get_login_info');
  }
}

/** 账号注册表 */
export class BotRegistry {
  readonly #entries = new Map<Id, BotEntry>();

  /** 取原始条目 */
  entry(selfId: Id): BotEntry | null {
    return this.#entries.get(selfId) ?? null;
  }

  /**
   * 登记连接。
   *
   * 同一账号重复连接时累加计数，并把当前连接换成本次连接，
   * 这样重连后 `call` 会自动走新链路。
   */
  register(selfId: Id, connection: OneBotConnection): BotEntry {
    const existing = this.#entries.get(selfId);
    if (existing) {
      existing.connection = connection;
      existing.connections += 1;
      existing.online = true;
      existing.connectedAt = Date.now();
      return existing;
    }

    const entry: BotEntry = {
      selfId,
      connection,
      info: { userId: null, nickname: null },
      connections: 1,
      connectedAt: Date.now(),
      online: true,
    };
    this.#entries.set(selfId, entry);
    return entry;
  }

  /** 注销连接（只在当前连接确实是它时才置离线） */
  unregister(selfId: Id, connection: OneBotConnection): void {
    const entry = this.#entries.get(selfId);
    if (!entry || entry.connection !== connection) return;

    entry.connections = Math.max(0, entry.connections - 1);
    if (entry.connections === 0) entry.online = false;
  }

  /** 更新账号信息 */
  updateInfo(selfId: Id, info: { userId?: Id | null; nickname?: string | null }): void {
    const entry = this.#entries.get(selfId);
    if (!entry) return;
    if (info.userId !== undefined) entry.info.userId = info.userId;
    if (info.nickname !== undefined) entry.info.nickname = info.nickname;
  }

  /** 取账号句柄（账号从未连接过返回 null） */
  get(selfId: Id): Bot | null {
    return this.#entries.has(selfId) ? new Bot(this, selfId) : null;
  }

  /** 取第一个在线账号 */
  first(): Bot | null {
    for (const [selfId, entry] of this.#entries) {
      if (entry.online) return new Bot(this, selfId);
    }
    return null;
  }

  /** 所有账号句柄 */
  list(): Bot[] {
    return [...this.#entries.keys()].map((selfId) => new Bot(this, selfId));
  }

  /** 账号数量 */
  get size(): number {
    return this.#entries.size;
  }
}

/* ─────────────────────────── 服务端 ─────────────────────────── */

export interface ServerAddress {
  host: string;
  port: number;
  path: string;
  url: string;
}

/**
 * 反向 WebSocket 服务端。
 *
 * 事件通过 `'event'` 抛出；连接建立/断开通过 `'connect'` / `'disconnect'` 抛出。
 */
export class OneBot11Server extends EventEmitter {
  readonly registry = new BotRegistry();
  readonly config: Onebot11Config;

  readonly #logger: Logger;
  readonly #wss: WebSocketServer;
  readonly #server: Server;
  readonly #connections = new Set<OneBotConnection>();
  #listening = false;
  /** 启动后的监听地址 */
  #address: ServerAddress | null = null;

  constructor(config: Onebot11Config, logger: Logger) {
    super();
    this.config = config;
    this.#logger = logger.child('onebot11');

    this.#wss = new WebSocketServer({ noServer: true });
    this.#server = createServer((req, res) => {
      // 端口上只暴露 WS 入口，普通 HTTP 请求给个明确回应
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', bots: this.registry.size }));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`这里是 Aster 的 OneBot v11 入口，请用 WebSocket 连接 ${this.path}\n`);
    });

    this.#server.on('upgrade', (req, socket, head) => this.#onUpgrade(req, socket, head));
  }

  /** 规范化后的挂载路径 */
  get path(): string {
    return normalizePath(this.config.path);
  }

  /** 监听地址，未启动时为 null */
  get address(): ServerAddress | null {
    return this.#address;
  }

  /** 当前连接数 */
  get connectionCount(): number {
    return this.#connections.size;
  }

  /** 当前所有连接 */
  get connections(): OneBotConnection[] {
    return [...this.#connections];
  }

  /** 启动监听 */
  async start(): Promise<ServerAddress> {
    const { host, port } = this.config;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        this.#server.off('listening', onListening);
        if (err.code === 'EACCES' && port < 1024) {
          reject(
            new Error(
              `监听 ${host}:${port} 失败：端口属于特权端口（<1024）。\n` +
                `改用 5310 这类非特权端口，或用 sudo / setcap 提权。`,
            ),
          );
          return;
        }
        if (err.code === 'EADDRINUSE') {
          reject(
            new Error(
              `监听 ${host}:${port} 失败：端口已被占用。\n` +
                `可能是另一个 Aster 还在跑，用 ss -ltnp | grep ${port} 查看。`,
            ),
          );
          return;
        }
        reject(new Error(`监听 ${host}:${port} 失败：${err.message}`));
      };

      const onListening = (): void => {
        this.#server.off('error', onError);
        resolve();
      };

      this.#server.once('error', onError);
      this.#server.once('listening', onListening);
      this.#server.listen(port, host);
    });

    this.#listening = true;

    // 端口配置为 0 时由系统分配，必须读回真实端口，否则对外给出的地址是错的
    const bound = this.#server.address();
    const actualPort = typeof bound === 'object' && bound !== null ? bound.port : port;

    const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    const address = `ws://${displayHost}:${actualPort}${this.path}`;

    this.#address = { host, port: actualPort, path: this.path, url: address };

    this.#logger.info(`已监听 ${address}（鉴权：${this.config.accessToken ? '已开启' : '关闭'}）`);
    if (!this.config.accessToken && (host === '0.0.0.0' || host === '::')) {
      this.#logger.warn('监听 0.0.0.0 但未设置 access_token，任何人都能接入');
    }

    return { host, port: actualPort, path: this.path, url: address };
  }

  /** 处理升级请求：校验路径、IP、Token */
  #onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const reject = (code: number, text: string): void => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };

    const url = new URL(req.url ?? '/', 'http://localhost');
    if (normalizePath(url.pathname) !== this.path) {
      this.#logger.warn(`拒绝连接：路径 ${url.pathname} 不匹配（期望 ${this.path}）`);
      reject(404, 'Not Found');
      return;
    }

    const remoteIp = req.socket.remoteAddress ?? '';
    if (!this.isTrusted(remoteIp)) {
      this.#logger.warn(`拒绝连接：IP ${remoteIp} 不在白名单内`);
      reject(403, 'Forbidden');
      return;
    }

    if (!this.checkToken(req, url)) {
      this.#logger.warn(`拒绝连接：${remoteIp} 鉴权失败`);
      reject(401, 'Unauthorized');
      return;
    }

    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      const remote = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
      const connection = new OneBotConnection(ws, {
        remote,
        path: this.path,
        logger: this.#logger,
        requestTimeout: this.config.requestTimeout,
        heartbeatTimeout: this.config.heartbeatTimeout,
      });

      this.#connections.add(connection);
      this.#logger.info(`新连接 ${remote}（当前 ${this.#connections.size} 个）`);

      connection.on('connect', (selfId: Id) => {
        this.registry.register(selfId, connection);
        this.emit('connect', selfId, connection);

        // 异步取登录信息，失败不影响连接
        void connection
          .call<{ user_id?: Id; nickname?: string }>('get_login_info')
          .then((info) => {
            this.registry.updateInfo(selfId, {
              userId: asId(info?.user_id),
              nickname: asString(info?.nickname),
            });
            this.#logger.info(
              `登录信息：${info?.nickname ?? '未知'}（${info?.user_id ?? selfId}）`,
            );
          })
          .catch((err: Error) => {
            this.#logger.debug(`获取登录信息失败：${err.message}`);
          });
      });

      connection.on('event', (event: AsterEvent) => {
        this.emit('event', event, connection);
      });

      connection.on('close', () => {
        this.#connections.delete(connection);
        if (connection.selfId !== null) {
          this.registry.unregister(connection.selfId, connection);
          this.#logger.info(
            `账号 ${connection.selfId} 断开（${remote}，剩余 ${this.#connections.size} 个连接）`,
          );
          this.emit('disconnect', connection.selfId, connection);
        } else {
          this.#logger.info(`连接 ${remote} 断开`);
        }
      });
    });
  }

  /** IP 白名单校验 */
  isTrusted(ip: string): boolean {
    const list = this.config.trustedIps;
    if (list.length === 0) return true;

    // IPv4-mapped IPv6 归一
    const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    return list.some((allowed) => {
      const entry = allowed.trim();
      if (entry === '*' || entry === '0.0.0.0') return true;
      return entry === ip || entry === normalized;
    });
  }

  /** Token 校验：支持 Authorization 头与 access_token 查询参数 */
  checkToken(req: IncomingMessage, url: URL): boolean {
    const expected = this.config.accessToken;
    if (expected.length === 0) return true;

    const header = req.headers.authorization;
    if (typeof header === 'string') {
      const value = header.trim();
      for (const prefix of ['Bearer ', 'bearer ', 'Token ', 'token ']) {
        if (value.startsWith(prefix)) {
          if (value.slice(prefix.length).trim() === expected) return true;
        }
      }
      if (value === expected) return true;
    }

    return url.searchParams.get('access_token') === expected;
  }

  /** 停止服务 */
  async stop(): Promise<void> {
    if (!this.#listening) return;
    this.#listening = false;

    for (const connection of this.#connections) connection.close(1001, 'server stopping');
    this.#connections.clear();

    this.#wss.close();
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
      // close 不会打断已建立的 keep-alive 连接，兜底
      setTimeout(resolve, 1000).unref?.();
    });

    this.#address = null;
    this.#logger.info('已停止监听');
  }

  /** 关闭并清空 */
  async destroy(): Promise<void> {
    await this.stop();
    this.removeAllListeners();
  }
}
