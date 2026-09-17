/**
 * Aster 的 Node.js 编程接口。
 *
 * 命令行用法见 `aster --help`。本模块把底层能力暴露出来，
 * 便于在其他 Node 项目里以代码方式调用。
 *
 * ```js
 * import { run, resolveBinary } from 'aster-bot';
 *
 * // 前台运行（会阻塞到进程退出）
 * process.exitCode = await run('/path/to/data');
 * ```
 */

export { ConfigManager, DEFAULT_CONFIG, validate } from './config.js';
export { Paths, PACKAGE_ROOT, binaryName, resolveHome, toAbsolute } from './paths.js';
export { buildBinary, resolveBinary, run } from './run.js';
export { main, parseArgs, HELP } from './cli.js';
