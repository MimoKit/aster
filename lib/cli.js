/**
 * Aster 命令行。
 *
 * 只有三件事：**启动**、**改配置**、**编译**。
 * 不做进程守护——持久化运行请自行用 systemd / screen / tmux / nohup。
 *
 * | 命令 | 作用 |
 * |------|------|
 * | `aster`        | 前台启动（默认命令） |
 * | `aster start`  | 同上，显式写法 |
 * | `aster config` | 查看 / 修改配置 |
 * | `aster build`  | 只编译 Rust 可执行文件 |
 * | `aster init`   | 只生成配置与目录 |
 */

import { readFileSync } from 'node:fs';

import { ConfigManager, DEFAULT_CONFIG, validate } from './config.js';
import { resolveHome } from './paths.js';
import { buildBinary, resolveBinary, run } from './run.js';

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
  cyan: (s) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
};

export const HELP = `${c.bold('Aster')} —— 用 Rust 编写的 Bot 框架（OneBot v11）

${c.bold('用法')}
  aster [命令] [选项]

${c.bold('命令')}
  ${c.cyan('(无)')}              前台启动（Ctrl-C 退出）
  ${c.cyan('config')}            查看配置
  ${c.cyan('config get <键>')}   读取配置项
  ${c.cyan('config set <键> <值>')}  修改配置项
  ${c.cyan('init')}              只生成配置与目录，不启动
  ${c.cyan('build')}             编译 Rust 可执行文件
  ${c.cyan('version')}           显示版本

${c.bold('选项')}
  --home <目录>   指定数据目录（默认 ./aster-data）
  --port <端口>   临时覆盖监听端口
  --host <地址>   临时覆盖监听地址
  --json          以 JSON 输出（配合 config）
  -h, --help      显示帮助
  -v, --version   显示版本

${c.bold('示例')}
  aster                            启动
  aster config                     查看全部配置
  aster config set onebot11.port 5310
  aster config set onebot11.access_token mytoken

${c.bold('后台运行')}
  Aster 只做前台启动，需要常驻请自行托管：

  ${c.dim('# systemd')}
  ExecStart=$(which aster)

  ${c.dim('# 或 screen / tmux')}
  screen -S aster -d -m aster
  tmux new -d -s aster aster

  ${c.dim('# 或 nohup')}
  nohup aster > aster.log 2>&1 &

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
      default:
        options._.push(arg);
    }
  }
  return options;
}

/** 把命令行覆盖项写入配置 */
function applyOverrides(manager, options) {
  const changes = [
    ['onebot11.port', options.port],
    ['onebot11.host', options.host],
    ['onebot11.access_token', options.token],
  ];
  for (const [key, value] of changes) {
    if (value !== undefined) manager.set(key, value);
  }
}

/**
 * 命令入口
 * @returns {Promise<number>} 退出码
 */
export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  // 默认命令就是启动：`aster` 与 `aster start` 等价
  const command = options._[0] ?? 'start';

  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.version || command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const home = resolveHome(options.home);
  const config = new ConfigManager(home);

  try {
    switch (command) {
      case 'start':
      case 'run':
        return await cmdStart(home, config, options);
      case 'init':
        return cmdInit(home, config, options);
      case 'config':
        return cmdConfig(config, options);
      case 'build':
        return cmdBuild();
      case 'help':
        process.stdout.write(HELP);
        return 0;
      default:
        process.stderr.write(`${c.red('未知命令：')}${command}\n\n${HELP}`);
        return 1;
    }
  } catch (err) {
    process.stderr.write(`${c.red('错误：')}${err.message}\n`);
    return 1;
  }
}

async function cmdStart(home, config, options) {
  config.ensure();
  applyOverrides(config, options);

  for (const problem of validate(config.read())) {
    process.stderr.write(`${c.yellow('!')} ${problem}\n`);
  }

  if (!resolveBinary({ build: false }).path) {
    process.stdout.write(`${c.dim('首次运行，正在编译 Rust 可执行文件（约 1 分钟）...')}\n`);
  }

  return await run(home, { build: true });
}

function cmdInit(home, config, options) {
  config.ensure();
  applyOverrides(config, options);

  process.stdout.write(`${c.green('✓')} 数据目录：${home}\n`);
  process.stdout.write(`${c.green('✓')} 配置文件：${config.paths.configFile}\n`);

  for (const problem of validate(config.read())) {
    process.stdout.write(`${c.yellow('!')} ${problem}\n`);
  }
  return 0;
}

function cmdConfig(configManager, options) {
  const action = options._[1];

  if (!action || action === 'list' || action === 'show') {
    configManager.ensure();
    if (options.json) {
      process.stdout.write(`${JSON.stringify(configManager.read(), null, 2)}\n`);
      return 0;
    }
    const flat = configManager.flatten();
    process.stdout.write(`${c.bold('配置文件')} ${configManager.paths.configFile}\n\n`);
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
    return 0;
  }

  if (action === 'path') {
    configManager.ensure();
    process.stdout.write(`${configManager.paths.configFile}\n`);
    return 0;
  }

  if (action === 'reset') {
    configManager.write(structuredClone(DEFAULT_CONFIG));
    process.stdout.write(`${c.green('✓')} 已恢复默认配置\n`);
    return 0;
  }

  throw new Error(`未知的 config 子命令：${action}`);
}

function cmdBuild() {
  process.stdout.write(`${c.dim('正在编译 Rust 可执行文件...')}\n`);
  const binary = buildBinary();
  process.stdout.write(`${c.green('✓')} 编译完成：${binary}\n`);
  return 0;
}
