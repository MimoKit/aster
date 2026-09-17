/**
 * 运行时目录与路径解析。
 *
 * Aster 的文件布局：
 *
 * ```text
 * <数据目录>/
 * ├── config.toml        运行期配置（首次从内置默认配置生成）
 * ├── aster.pid          进程 PID 文件
 * ├── logs/
 * │   └── aster.log      运行日志
 * └── bin/aster          Rust 可执行文件（首次运行时安装）
 * ```
 *
 * 数据目录的确定顺序：
 * 1. 环境变量 `ASTER_HOME`
 * 2. 命令行 `--home <dir>`
 * 3. 当前工作目录下的 `./aster-data`
 *
 * 之所以不默认写当前目录，是为了避免 `npx aster-bot` 在任意目录运行时
 * 把配置撒得到处都是。
 */

import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** npm 包根目录 */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 可执行文件在不同平台下的名字 */
export function binaryName(platform = process.platform) {
  return platform === 'win32' ? 'aster.exe' : 'aster';
}

/** 解析数据目录 */
export function resolveHome(explicit) {
  const fromEnv = process.env.ASTER_HOME;
  if (explicit) return resolve(explicit);
  if (fromEnv) return resolve(fromEnv);
  return resolve(process.cwd(), 'aster-data');
}

/** 运行时路径集合 */
export class Paths {
  constructor(home) {
    this.home = home;
    this.configFile = join(home, 'config.toml');
    this.pidFile = join(home, 'aster.pid');
    this.logDir = join(home, 'logs');
    this.logFile = join(this.logDir, 'aster.log');
    /** 可执行文件存放目录（数据目录内，保证可写） */
    this.binDir = join(home, 'bin');
    this.binary = join(this.binDir, binaryName());
    /** 包内预编译二进制目录（随包分发时使用） */
    this.vendorDir = join(PACKAGE_ROOT, 'vendor');
    this.defaultConfig = join(PACKAGE_ROOT, 'config', 'default.toml');
  }

  /** 创建所有必要目录 */
  ensure() {
    for (const dir of [this.home, this.logDir, this.binDir]) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
  }

  /** 用户级 npm 包目录（用于提示全局安装位置） */
  static globalRoot() {
    const prefix = process.env.npm_config_prefix;
    return prefix ? join(prefix, 'lib', 'node_modules') : join(homedir(), '.npm-global');
  }
}

/** 判断路径是否为绝对路径，否则相对 cwd 解析 */
export function toAbsolute(input) {
  return isAbsolute(input) ? input : resolve(process.cwd(), input);
}
