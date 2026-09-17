/**
 * Aster 的 Node.js 编程接口。
 *
 * 命令行用法见 `aster --help`；本模块把底层能力暴露出来，
 * 便于在其他 Node 项目里以代码方式控制 Aster。
 *
 * ```js
 * import { ConfigManager, ProcessManager } from 'aster-bot';
 *
 * const manager = new ProcessManager('/path/to/data');
 * manager.start();
 * console.log(manager.status());
 * await manager.stop();
 * ```
 */

export { ConfigManager, DEFAULT_CONFIG, validate } from './config.js';
export { Paths, PACKAGE_ROOT, binaryName, resolveHome } from './paths.js';
export { NotRunningError, ProcessManager, sleep } from './process.js';
export { main, parseArgs, HELP } from './cli.js';
