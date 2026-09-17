/**
 * Aster 命令行实现。
 *
 * 命令一览：
 *
 * | 命令 | 作用 |
 * |------|------|
 * | `start`   | 后台启动（默认） |
 * | `run`     | 前台启动，日志直接打到终端 |
 * | `stop`    | 停止 |
 * | `restart` | 重启 |
 * | `status`  | 查看运行状态 |
 * | `logs`    | 查看日志（`-f` 持续跟踪） |
 * | `config`  | 查看 / 修改配置 |
 * | `build`   | 编译 Rust 可执行文件 |
 * | `init`    | 生成配置与目录，不启动 |
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, watchFile, unwatchFile } from 'node:fs';

import { ConfigManager, DEFAULT_CONFIG, validate } from './config.js';
import { Paths, resolveHome } from './paths.js';
import { NotRunningError, ProcessManager, sleep } from './process.js';

const VERSION = readPackageVersion();

function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** ANSI 颜色（非 TTY 时自动关闭） */
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  bold: (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  red: (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  blue: (s) => (useColor ? `\x1b[34m${s}\x1b[0m` : s),
  cyan: (s) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
};

export const HELP = `${c.bold('Aster')} —— Rust 编写的 Bot 框架（OneBot v11）

${c.bold('用法')}
  aster <命令> [选项]

${c.bold('命令')}
  ${c.cyan('start')}              后台启动
  ${c.cyan('run')}                前台启动（日志直接输出到终端）
  ${c.cyan('stop')}               停止
  ${c.cyan('restart')}            重启
  ${c.cyan('status')}             查看运行状态
  ${c.cyan('logs')}               查看日志
  ${c.cyan('config')}             查看或修改配置
  ${c.cyan('init')}               初始化配置与目录（不启动）
  ${c.cyan('build')}              编译 Rust 可执行文件
  ${c.cyan('version')}            显示版本

${c.bold('选项')}
  --home <目录>       指定数据目录（默认 ./aster-data）
  --port <端口>       临时覆盖监听端口
  -f, --follow        跟踪日志输出（配合 logs）
  -n, --lines <行数>  日志行数（默认 50）
  --json              以 JSON 输出（配合 status / config）
  -h, --help          显示帮助
  -v, --version       显示版本

${c.bold('配置示例')}
  aster config                     查看全部配置
  aster config get onebot11.port   读取某一项
  aster config set onebot11.port 5310
  aster config set onebot11.access_token mytoken

${c.bold('环境变量')}
  ASTER_HOME      数据目录
  ASTER_BINARY    指定可执行文件路径
  ASTER_HOST      覆盖监听地址
  ASTER_PORT      覆盖监听端口
  ASTER_TOKEN     覆盖鉴权 Token
  ASTER_LOG       覆盖日志级别
`;

/** 解析命令行参数 */
export function parseArgs(argv) {
  const options = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-v':
      case '--version':
        options.version = true;
        break;
      case '-f':
      case '--follow':
        options.follow = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--home':
        options.home = argv[++i];
        break;
      case '--port':
        options.port = argv[++i];
        break;
      case '--host':
        options.host = argv[++i];
        break;
      case '--token':
        options.token = argv[++i];
        break;
      case '-n':
      case '--lines':
        options.lines = Number.parseInt(argv[++i], 10);
        break;
      default:
        options._.push(arg);
    }
  }
  return options;
}

/** 把命令行覆盖项应用到配置 */
function applyOverrides(manager, options) {
  if (options.port === undefined && options.host === undefined && options.token === undefined) {
    return;
  }
  if (options.port !== undefined) manager.set('onebot11.port', options.port);
  if (options.host !== undefined) manager.set('onebot11.host', options.host);
  if (options.token !== undefined) manager.set('onebot11.access_token', options.token);
}

/**
 * 命令入口
 * @returns {Promise<number>} 退出码
 */
export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const command = options._[0] ?? 'help';

  if (options.help || command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.version || command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const home = resolveHome(options.home);
  const manager = new ProcessManager(home);
  const configManager = new ConfigManager(home);

  try {
    switch (command) {
      case 'init':
        return cmdInit(manager, configManager, options);
      case 'start':
        return await cmdStart(manager, configManager, options);
      case 'run':
        return await cmdRun(manager, configManager, options);
      case 'stop':
        return await cmdStop(manager);
      case 'restart':
        return await cmdRestart(manager, configManager, options);
      case 'status':
        return await cmdStatus(manager, options);
      case 'logs':
      case 'log':
        return await cmdLogs(manager, options);
      case 'config':
        return cmdConfig(configManager, options);
      case 'build':
        return cmdBuild(manager);
      default:
        process.stderr.write(`${c.red('未知命令：')}${command}\n\n${HELP}`);
        return 1;
    }
  } catch (err) {
    process.stderr.write(`${c.red('错误：')}${err.message}\n`);
    return 1;
  }
}

function cmdInit(manager, configManager, options) {
  manager.paths.ensure();
  configManager.ensure();
  if (options.port !== undefined || options.host !== undefined || options.token !== undefined) {
    applyOverrides(configManager, options);
  }
  const problems = validate(configManager.read());

  process.stdout.write(`${c.green('✓')} 数据目录：${manager.paths.home}\n`);
  process.stdout.write(`${c.green('✓')} 配置文件：${manager.paths.configFile}\n`);
  if (problems.length) {
    for (const problem of problems) {
      process.stdout.write(`${c.yellow('!')} ${problem}\n`);
    }
  }
  return 0;
}

async function cmdStart(manager, configManager, options) {
  manager.paths.ensure();
  configManager.ensure();
  applyOverrides(configManager, options);

  const { pid, binary } = manager.start({ foreground: false });
  process.stdout.write(`${c.green('✓')} 已启动（PID ${pid}）\n`);
  process.stdout.write(`  可执行文件：${c.dim(binary)}\n`);

  const config = configManager.read();
  const { host, port, path } = config.onebot11;
  const ready = await manager.waitReady(host, port, 10000);

  if (ready) {
    const shown = !host || host === '0.0.0.0' ? '127.0.0.1' : host;
    process.stdout.write(`${c.green('✓')} 监听就绪：${c.cyan(`ws://${shown}:${port}${path}`)}\n`);
  } else {
    process.stdout.write(
      `${c.yellow('!')} 端口 ${port} 暂未就绪，请查看日志：${c.dim(`aster logs -f`)}\n`,
    );
  }
  process.stdout.write(`  数据目录：${manager.paths.home}\n`);
  return 0;
}

async function cmdRun(manager, configManager, options) {
  manager.paths.ensure();
  configManager.ensure();
  applyOverrides(configManager, options);

  const { binary } = manager.resolveBinary({ build: true });
  process.stdout.write(`${c.dim(`前台运行 ${binary}（Ctrl-C 退出）`)}\n`);
  const { child } = manager.start({ foreground: true });
  return await new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      if (signal) process.stdout.write(`${c.yellow('已终止')}（${signal}）\n`);
      resolve(code ?? 0);
    });
  });
}

async function cmdStop(manager) {
  const status = manager.status();
  if (!status.running) {
    process.stdout.write(`${c.yellow('!')} Aster 未在运行\n`);
    return 0;
  }
  const { pid, forced } = await manager.stop();
  process.stdout.write(
    forced
      ? `${c.yellow('✓')} 已强制停止（PID ${pid}）\n`
      : `${c.green('✓')} 已停止（PID ${pid}）\n`,
  );
  return 0;
}

async function cmdRestart(manager, configManager, options) {
  const status = manager.status();
  if (status.running) {
    await manager.stop();
    process.stdout.write(`${c.green('✓')} 已停止（PID ${status.pid}）\n`);
  }
  return await cmdStart(manager, configManager, options);
}

async function cmdStatus(manager, options) {
  const status = manager.status();

  if (options.json) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return 0;
  }

  const dot = status.running ? c.green('●') : c.dim('○');
  process.stdout.write(`${dot} ${status.running ? c.green('运行中') : c.dim('未运行')}\n`);
  if (status.running) {
    process.stdout.write(`  ${c.bold('PID')}      ${status.pid}\n`);
    if (status.port) {
      const shown =
        !status.host || status.host === '0.0.0.0' ? '127.0.0.1' : status.host;
      const listening = manager.isListeningInLog(status.port);
      const mark = listening ? c.green('监听中') : c.yellow('未确认');
      process.stdout.write(
        `  ${c.bold('监听')}     ws://${shown}:${status.port}${status.path} ${mark}\n`,
      );
    }
  }
  process.stdout.write(`  ${c.bold('数据目录')} ${status.home}\n`);
  process.stdout.write(`  ${c.bold('配置文件')} ${status.configFile}\n`);
  process.stdout.write(`  ${c.bold('日志')}     ${status.logFile}\n`);
  if (status.running && status.token) {
    process.stdout.write(`  ${c.bold('鉴权')}     ${c.green('已开启')}\n`);
  }
  return 0;
}

async function cmdLogs(manager, options) {
  const lines = Number.isInteger(options.lines) ? options.lines : 50;
  const info = manager.logInfo();
  if (!info) {
    process.stdout.write(`${c.yellow('!')} 暂无日志：${manager.paths.logFile}\n`);
    return 0;
  }

  for (const line of manager.tailLog(lines)) process.stdout.write(`${line}\n`);

  if (!options.follow) return 0;

  process.stdout.write(`${c.dim('—— 跟踪日志中，Ctrl-C 退出 ——')}\n`);
  let position = info.size;
  watchFile(manager.paths.logFile, { interval: 300 }, (curr) => {
    if (curr.size < position) position = 0; // 日志被截断
    if (curr.size === position) return;
    const stream = readFileSync(manager.paths.logFile);
    process.stdout.write(stream.subarray(position).toString('utf8'));
    position = curr.size;
  });

  return await new Promise((resolve) => {
    const done = () => {
      unwatchFile(manager.paths.logFile);
      resolve(0);
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
}

function cmdConfig(configManager, options) {
  const action = options._[1];
  const configFile = configManager.paths.configFile;

  if (!action || action === 'list' || action === 'show') {
    configManager.ensure();
    if (options.json) {
      process.stdout.write(`${JSON.stringify(configManager.read(), null, 2)}\n`);
      return 0;
    }
    const flat = configManager.flatten();
    process.stdout.write(`${c.bold('配置文件')} ${configFile}\n\n`);
    for (const [key, value] of Object.entries(flat)) {
      const rendered = Array.isArray(value) ? value.join(', ') || c.dim('(空)') : String(value);
      process.stdout.write(`  ${c.cyan(key.padEnd(28))} ${rendered}\n`);
    }
    return 0;
  }

  if (action === 'get') {
    const key = options._[2];
    if (!key) throw new Error('用法：aster config get <键>');
    const value = configManager.get(key);
    if (value === undefined) {
      process.stderr.write(`${c.red('错误：')}配置项不存在：${key}\n`);
      return 1;
    }
    process.stdout.write(`${Array.isArray(value) ? value.join(', ') : value}\n`);
    return 0;
  }

  if (action === 'set') {
    const key = options._[2];
    const value = options._[3];
    if (!key || value === undefined) throw new Error('用法：aster config set <键> <值>');
    const applied = configManager.set(key, value);
    process.stdout.write(
      `${c.green('✓')} ${key} = ${Array.isArray(applied) ? applied.join(', ') : applied}\n`,
    );
    process.stdout.write(`${c.dim('修改需重启生效：aster restart')}\n`);
    return 0;
  }

  if (action === 'path') {
    configManager.ensure();
    process.stdout.write(`${configFile}\n`);
    return 0;
  }

  if (action === 'reset') {
    configManager.write(structuredClone(DEFAULT_CONFIG));
    process.stdout.write(`${c.green('✓')} 已恢复默认配置\n`);
    return 0;
  }

  throw new Error(`未知的 config 子命令：${action}`);
}

function cmdBuild(manager) {
  process.stdout.write(`${c.dim('正在编译 Rust 可执行文件...')}\n`);
  const binary = manager.build();
  process.stdout.write(`${c.green('✓')} 编译完成：${binary}\n`);
  return 0;
}
