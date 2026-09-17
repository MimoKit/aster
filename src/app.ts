/**
 * 应用装配。
 *
 * 把配置、日志、统计、适配器、插件宿主、WebUI 拼成一个可启动的整体：
 *
 * ```text
 * OneBot11Server ──event──▶ Stats
 *        │                    │
 *        │                    └─▶ PluginHost ──▶ 插件处理函数
 *        │                                        │
 *        └────────────── call() ◀─────────────────┘
 *        │
 *        └─▶ WebUiServer（HTTP API + SSE + 静态资源）
 * ```
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type AsterConfig,
  type LoadedConfig,
  loadConfig,
  resolvePluginDir,
  validateConfig,
} from './config.ts';
import { Logger } from './logger.ts';
import { OneBot11Server, type ServerAddress } from './onebot11.ts';
import { PluginHost } from './plugin-host.ts';
import { Stats } from './stats.ts';
import type { AsterEvent } from './types.ts';
import { WebUiServer } from './webui.ts';

/** 包根目录（dist/ 或 src/ 的上一级） */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 读取包版本 */
function packageVersion(): string {
  try {
    const file = join(PACKAGE_ROOT, 'package.json');
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export interface AppOptions {
  /** 数据目录，默认为当前工作目录 */
  dataDir?: string;
  /** 覆盖配置（测试用） */
  config?: AsterConfig;
  /** 是否启动 WebUI，覆盖配置 */
  webui?: boolean;
}

export interface StartResult {
  onebot: ServerAddress | null;
  webui: { url: string; host: string; port: number } | null;
  plugins: number;
  rules: number;
}

export class App {
  readonly config: AsterConfig;
  readonly loaded: LoadedConfig;
  readonly logger: Logger;
  readonly stats: Stats;
  readonly server: OneBot11Server;
  readonly plugins: PluginHost;
  readonly version: string;

  #webui: WebUiServer | null = null;
  #started = false;
  #stopping = false;

  private constructor(options: {
    config: AsterConfig;
    loaded: LoadedConfig;
    logger: Logger;
    stats: Stats;
    server: OneBot11Server;
    plugins: PluginHost;
    version: string;
  }) {
    this.config = options.config;
    this.loaded = options.loaded;
    this.logger = options.logger;
    this.stats = options.stats;
    this.server = options.server;
    this.plugins = options.plugins;
    this.version = options.version;
    this.#wire();
  }

  /** 创建应用（加载配置与插件，但不监听端口） */
  static async create(options: AppOptions = {}): Promise<App> {
    const dataDir = options.dataDir ?? process.cwd();
    const loaded = loadConfig(dataDir);
    const config = options.config ?? loaded.config;
    const version = packageVersion();

    const logger = new Logger(config.log, config.webui.logCapacity, 'aster');
    const stats = new Stats();

    // 配置问题只提示，不阻断启动——用户可能正要去 WebUI 改
    for (const problem of validateConfig(config)) {
      logger.warn(problem);
    }

    if (loaded.created) logger.info(`已生成默认配置 ${loaded.path}`);

    const server = new OneBot11Server(config.onebot11, logger);

    // 用户插件目录先建出来：否则它不存在时不会被文件监听覆盖，
    // 用户后来新建目录放插件就享受不到热重载
    const userPluginDir = resolvePluginDir(config.plugin.dir, loaded.dir);
    if (!existsSync(userPluginDir)) mkdirSync(userPluginDir, { recursive: true });
    logger.debug(`用户插件目录：${userPluginDir}`);

    const dirs = [userPluginDir, join(PACKAGE_ROOT, 'plugins')].filter(
      (dir, index, list) => list.indexOf(dir) === index,
    );

    const plugins = new PluginHost({
      dirs,
      logger,
      stats,
      registry: server.registry,
      version,
      address: () => server.address,
      masters: config.bot.masters,
      commandPrefix: config.bot.commandPrefix,
      hotReload: config.plugin.hotReload,
    });

    if (!config.bot.builtinPlugins) {
      logger.debug('配置中关闭了内置插件');
    }

    await plugins.load();

    return new App({ config, loaded, logger, stats, server, plugins, version });
  }

  /** 订阅事件并把消息交给插件 */
  #wire(): void {
    this.server.on('event', (event: AsterEvent) => {
      this.stats.recordEvent(event);

      // 元事件只统计，不参与命令分发
      if (event.type !== 'message') return;

      const bot = this.server.registry.get(event.selfId);
      if (!bot) {
        this.logger.debug(`事件来自未登记账号 ${event.selfId}，跳过分发`);
        return;
      }

      // 不阻塞事件循环：分发在微任务里跑
      void this.plugins
        .dispatch({ event, bot })
        .catch((err: Error) => this.logger.error(`插件分发出错：${err.message}`));
    });
  }

  /** 启动适配器与 WebUI */
  async start(): Promise<StartResult> {
    if (this.#started) throw new Error('应用已启动');
    this.#started = true;

    this.logger.info(`${this.config.bot.name} v${this.version} 启动中`);

    if (this.plugins.count > 0) {
      this.logger.info(`已加载 ${this.plugins.count} 个插件、${this.plugins.ruleCount} 条规则`);
      for (const plugin of this.plugins.plugins) {
        this.logger.debug(
          `  · ${plugin.name}：${plugin.desc || '无描述'}（优先级 ${plugin.priority}，${plugin.rules.length} 条规则）`,
        );
      }
    } else {
      this.logger.warn('没有加载到任何插件');
    }

    if (this.config.bot.masters.length > 0) {
      this.logger.info(`主人账号：${this.config.bot.masters.join(', ')}`);
    } else {
      this.logger.debug('未配置主人账号（bot.masters），需要权限的命令将不可用');
    }

    let onebot: ServerAddress | null = null;
    if (this.config.onebot11.enable) {
      onebot = await this.server.start();
    } else {
      this.logger.warn('配置中 onebot11.enable = false，适配器未启动');
    }

    // 监听文件变化（放在启动后，避免加载期间触发重载）
    this.plugins.startWatching();

    let webui: { url: string; host: string; port: number } | null = null;
    const webuiEnabled = this.config.webui.enable;
    if (webuiEnabled) {
      this.#webui = new WebUiServer({
        config: this.config,
        loaded: this.loaded,
        logger: this.logger,
        stats: this.stats,
        server: this.server,
        plugins: this.plugins,
        version: this.version,
        distDir: findWebUiDist(),
      });
      webui = await this.#webui.start();
    }

    return {
      onebot,
      webui,
      plugins: this.plugins.count,
      rules: this.plugins.ruleCount,
    };
  }

  /** 停止全部服务 */
  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;

    this.logger.info('正在关闭...');
    this.plugins.destroy();
    await this.#webui?.stop();
    await this.server.stop();
    this.logger.info('已停止');
  }

  /** 等待进程退出信号 */
  async waitForShutdown(): Promise<void> {
    await new Promise<void>((resolve_) => {
      let done = false;
      const finish = (signal: string): void => {
        if (done) return;
        done = true;
        this.logger.info(`收到 ${signal}`);
        resolve_();
      };
      process.once('SIGINT', () => finish('Ctrl-C'));
      process.once('SIGTERM', () => finish('SIGTERM'));
    });

    await this.stop();
  }
}

/** 定位前端构建产物 */
export function findWebUiDist(): string | null {
  const candidates = [
    process.env.ASTER_WEBUI_DIST,
    join(PACKAGE_ROOT, 'webui', 'dist'),
    join(process.cwd(), 'webui', 'dist'),
  ];

  for (const candidate of candidates) {
    if (candidate && existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

export { PACKAGE_ROOT };
