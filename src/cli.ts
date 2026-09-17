/**
 * 命令行。
 *
 * | 命令 | 作用 |
 * |------|------|
 * | `aster` | 前台启动 |
 * | `aster config` | 查看配置 |
 * | `aster config get <键>` | 读取配置项 |
 * | `aster config set <键> <值>` | 修改配置项 |
 * | `aster plugin` | 列出插件 |
 * | `aster init` | 只生成配置，不启动 |
 * | `aster version` | 显示版本 |
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { App, findWebUiDist, PACKAGE_ROOT } from './app.ts';
import {
  DEFAULT_CONFIG_TOML,
  defaultConfig,
  getByPath,
  loadConfig,
  resolvePluginDir,
  saveConfig,
  setByPath,
  validateConfig,
} from './config.ts';
import { Logger } from './logger.ts';
import { BotRegistry } from './onebot11.ts';
import { PluginHost } from './plugin-host.ts';
import { Stats } from './stats.ts';

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;

const paint = {
  dim: (text: string): string => (COLOR ? `\u001b[2m${text}\u001b[0m` : text),
  bold: (text: string): string => (COLOR ? `\u001b[1m${text}\u001b[0m` : text),
  green: (text: string): string => (COLOR ? `\u001b[32m${text}\u001b[0m` : text),
  yellow: (text: string): string => (COLOR ? `\u001b[33m${text}\u001b[0m` : text),
  red: (text: string): string => (COLOR ? `\u001b[31m${text}\u001b[0m` : text),
  teal: (text: string): string => (COLOR ? `\u001b[36m${text}\u001b[0m` : text),
};

export const HELP = `${paint.bold('Aster')} —— TypeScript 编写的 Bot 框架（OneBot v11）

${paint.bold('用法')}
  aster [命令] [选项]

${paint.bold('命令')}
  ${paint.teal('(无)')}                 前台启动（Ctrl-C 退出）
  ${paint.teal('config')}               查看全部配置
  ${paint.teal('config get <键>')}      读取配置项
  ${paint.teal('config set <键> <值>')} 修改配置项
  ${paint.teal('config path')}          打印配置文件路径
  ${paint.teal('plugin')}               列出已加载插件
  ${paint.teal('init')}                 只生成配置，不启动
  ${paint.teal('version')}              显示版本

${paint.bold('选项')}
  --data <目录>      指定数据目录（默认当前目录）
  --port <端口>      临时覆盖 OneBot 端口
  --webui-port <端口> 临时覆盖 WebUI 端口
  --json             以 JSON 输出（配合 config / plugin）
  -h, --help         显示帮助
  -v, --version      显示版本

${paint.bold('示例')}
  aster                              启动
  aster --port 5310                  换个端口启动
  aster config set webui.access_token 我的令牌
  aster config set bot.masters '["123456"]'

${paint.bold('后台常驻')}
  Aster 只做前台启动，需要常驻请自行托管：

  ${paint.dim('# systemd')}
  ExecStart=$(which aster)

  ${paint.dim('# screen / tmux')}
  screen -S aster -d -m aster
  tmux new -d -s aster aster

  ${paint.dim('# nohup')}
  nohup aster > aster.log 2>&1 &

${paint.bold('环境变量')}
  ASTER_DATA          数据目录
  ASTER_WEBUI_DIST    前端构建产物目录
`;

interface CliOptions {
  command: string;
  args: string[];
  dataDir?: string;
  port?: number;
  webuiPort?: number;
  json: boolean;
  help: boolean;
  version: boolean;
}

/** 解析命令行参数 */
export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    command: '',
    args: [],
    json: false,
    help: false,
    version: false,
  };

  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-v':
      case '--version':
        options.version = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--data':
      case '--home':
        options.dataDir = argv[++i];
        break;
      case '--port':
        options.port = Number(argv[++i]);
        break;
      case '--webui-port':
        options.webuiPort = Number(argv[++i]);
        break;
      default:
        rest.push(arg);
    }
  }

  options.command = rest[0] ?? 'start';
  options.args = rest.slice(1);
  return options;
}

/** 解析数据目录 */
function resolveDataDir(options: CliOptions): string {
  return options.dataDir ?? process.env.ASTER_DATA ?? process.cwd();
}

/** 入口 */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);

  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const dataDir = resolveDataDir(options);

  if (options.version || options.command === 'version') {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }

  try {
    switch (options.command) {
      case 'start':
      case 'run':
        return await cmdStart(options, dataDir);
      case 'init':
        return cmdInit(options, dataDir);
      case 'config':
        return cmdConfig(options, dataDir);
      case 'plugin':
        return await cmdPlugin(options, dataDir);
      case 'help':
        process.stdout.write(HELP);
        return 0;
      default:
        process.stderr.write(`${paint.red('未知命令：')}${options.command}\n\n${HELP}`);
        return 1;
    }
  } catch (err) {
    process.stderr.write(`${paint.red('错误：')}${(err as Error).message}\n`);
    return 1;
  }
}

/** 启动 */
async function cmdStart(options: CliOptions, dataDir: string): Promise<number> {
  const loaded = loadConfig(dataDir);
  const config = structuredClone(loaded.config);

  if (options.port !== undefined && Number.isFinite(options.port)) {
    config.onebot11.port = options.port;
  }
  if (options.webuiPort !== undefined && Number.isFinite(options.webuiPort)) {
    config.webui.port = options.webuiPort;
  }

  const app = await App.create({ dataDir, config });

  const result = await app.start();

  if (result.onebot) {
    process.stdout.write(`${paint.dim('协议端请连接：')}${paint.teal(result.onebot.url)}\n`);
  }
  if (result.webui) {
    process.stdout.write(`${paint.dim('控制台地址：')}${paint.teal(result.webui.url)}\n`);
  }

  await app.waitForShutdown();
  return 0;
}

/** 只生成配置 */
function cmdInit(options: CliOptions, dataDir: string): number {
  const loaded = loadConfig(dataDir);
  const config = structuredClone(loaded.config);

  const problems = validateConfig(config);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ dataDir: loaded.dir, configPath: loaded.path, problems }, null, 2)}\n`,
    );
    return 0;
  }

  process.stdout.write(`${paint.green('✓')} 数据目录：${loaded.dir}\n`);
  process.stdout.write(`${paint.green('✓')} 配置文件：${loaded.path}\n`);

  if (loaded.created) {
    process.stdout.write(`${paint.dim('  已写入默认配置（含注释）')}\n`);
  }
  for (const problem of problems) {
    process.stdout.write(`${paint.yellow('!')} ${problem}\n`);
  }
  return 0;
}

/** 配置读写 */
function cmdConfig(options: CliOptions, dataDir: string): number {
  const [action, key, ...rest] = options.args;
  const loaded = loadConfig(dataDir);

  if (!action || action === 'list' || action === 'show') {
    if (options.json) {
      process.stdout.write(`${JSON.stringify(loaded.config, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(`${paint.bold('配置文件')} ${loaded.path}\n\n`);
    for (const line of flatten(loaded.config)) {
      process.stdout.write(`  ${paint.teal(line.key.padEnd(30))} ${line.value}\n`);
    }
    return 0;
  }

  if (action === 'path') {
    process.stdout.write(`${loaded.path}\n`);
    return 0;
  }

  if (action === 'get') {
    if (!key) throw new Error('用法：aster config get <键>');
    const value = getByPath(loaded.config, key);
    if (value === undefined) {
      process.stderr.write(`${paint.red('错误：')}配置项不存在：${key}\n`);
      return 1;
    }
    process.stdout.write(`${Array.isArray(value) ? value.join(', ') : String(value)}\n`);
    return 0;
  }

  if (action === 'set') {
    if (!key || rest.length === 0) throw new Error('用法：aster config set <键> <值>');
    const raw = rest.join(' ');
    const current = getByPath(loaded.config, key);
    const value = coerce(raw, current);
    const next = setByPath(loaded.config, key, value);

    const problems = validateConfig(next);
    if (problems.length > 0) {
      process.stderr.write(`${paint.red('配置校验失败：')}\n`);
      for (const problem of problems) process.stderr.write(`  ${problem}\n`);
      return 1;
    }

    saveConfig(loaded, next);
    process.stdout.write(
      `${paint.green('✓')} ${key} = ${Array.isArray(value) ? value.join(', ') : String(value)}\n`,
    );
    process.stdout.write(`${paint.dim('修改需重启生效')}\n`);
    return 0;
  }

  if (action === 'reset') {
    saveConfig(loaded, defaultConfig());
    process.stdout.write(`${paint.green('✓')} 已恢复默认配置\n`);
    return 0;
  }

  if (action === 'template') {
    process.stdout.write(DEFAULT_CONFIG_TOML);
    return 0;
  }

  throw new Error(`未知的 config 子命令：${action}`);
}

/** 列出插件（不启动服务） */
async function cmdPlugin(options: CliOptions, dataDir: string): Promise<number> {
  const loaded = loadConfig(dataDir);
  const config = loaded.config;
  const logger = new Logger({ ...config.log, level: 'warn' }, 100, 'plugin');
  const stats = new Stats();

  const dirs = [
    resolvePluginDir(config.plugin.dir, loaded.dir),
    join(PACKAGE_ROOT, 'plugins'),
  ].filter((dir, index, list) => list.indexOf(dir) === index);

  const host = new PluginHost({
    dirs,
    logger,
    stats,
    registry: new BotRegistry(),
    version: '0.0.0',
    address: () => null,
    masters: config.bot.masters,
    commandPrefix: config.bot.commandPrefix,
    hotReload: false,
  });

  await host.load();

  // 直接写 stdout，避免 logger 的 warn 级别把它吞掉
  const out = options.json
    ? JSON.stringify({ plugins: host.list(), errors: host.errors, dirs }, null, 2)
    : formatPlugins(host, dirs);
  process.stdout.write(`${out}\n`);

  host.destroy();
  return host.errors.length > 0 ? 1 : 0;
}

function formatPlugins(host: PluginHost, dirs: string[]): string {
  const lines: string[] = [];

  lines.push(`${paint.bold('插件目录')}`);
  for (const dir of dirs) {
    lines.push(`  ${existsSync(dir) ? paint.green('✓') : paint.dim('·')} ${dir}`);
  }
  lines.push('');

  if (host.count === 0) {
    lines.push(paint.yellow('没有加载到任何插件'));
  } else {
    lines.push(`${paint.bold(`已加载 ${host.count} 个插件、${host.ruleCount} 条规则`)}`);
    for (const plugin of host.list()) {
      lines.push('');
      lines.push(
        `  ${paint.teal(plugin.name)} ${paint.dim(`优先级 ${plugin.priority}`)} — ${plugin.desc || '无描述'}`,
      );
      for (const rule of plugin.rules) {
        lines.push(
          `    · ${rule.name.padEnd(12)} ${rule.matcher.padEnd(22)} ${paint.dim(`${rule.permission} / ${rule.scope}`)}`,
        );
      }
    }
  }

  if (host.errors.length > 0) {
    lines.push('');
    lines.push(paint.red(`${host.errors.length} 个插件加载失败：`));
    for (const error of host.errors) {
      lines.push(`  ${paint.red('✗')} ${error.file}`);
      lines.push(`    ${paint.dim(error.message)}`);
    }
  }

  return lines.join('\n');
}

/** 按原类型转换输入 */
function coerce(raw: string, current: unknown): unknown {
  if (typeof current === 'boolean') {
    if (['true', '1', 'yes', 'on'].includes(raw.toLowerCase())) return true;
    if (['false', '0', 'no', 'off'].includes(raw.toLowerCase())) return false;
    throw new Error(`需要布尔值，收到：${raw}`);
  }
  if (typeof current === 'number') {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`需要数字，收到：${raw}`);
    return value;
  }
  if (Array.isArray(current)) {
    const text = raw.trim();
    // 支持 JSON 数组写法
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text) as unknown;
        if (Array.isArray(parsed)) return parsed.map(String);
      } catch {
        /* 退回逗号分隔 */
      }
    }
    return text
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return raw;
}

/** 摊平成点路径列表，供展示 */
function flatten(
  config: unknown,
  prefix = '',
  out: { key: string; value: string }[] = [],
): { key: string; value: string }[] {
  if (typeof config !== 'object' || config === null) return out;

  for (const [key, value] of Object.entries(config)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      flatten(value, path, out);
    } else {
      const shown = Array.isArray(value)
        ? value.join(', ') || paint.dim('(空)')
        : typeof value === 'string' && value.length === 0
          ? paint.dim('(空)')
          : String(value);
      out.push({ key: path, value: shown });
    }
  }
  return out;
}

export { findWebUiDist };
