/**
 * 路径解析。
 *
 * Aster 只维护一个数据目录，里面只有配置：
 *
 * ```text
 * <数据目录>/
 * └── config.toml      运行配置（首次从包内默认配置生成）
 * ```
 *
 * 日志不再由框架落盘——前台直启时日志就在终端里，
 * 需要留存由用户自己重定向或交给 systemd。
 *
 * 数据目录确定顺序：
 * 1. 环境变量 `ASTER_HOME`
 * 2. 命令行 `--home <dir>`
 * 3. 当前工作目录下的 `./aster-data`
 */

import { existsSync, mkdirSync } from 'node:fs';
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
    /** 包内默认配置模板 */
    this.defaultConfig = join(PACKAGE_ROOT, 'config', 'default.toml');
  }

  /** 确保数据目录存在 */
  ensure() {
    if (!existsSync(this.home)) mkdirSync(this.home, { recursive: true });
  }
}

/** 判断路径是否为绝对路径，否则相对 cwd 解析 */
export function toAbsolute(input) {
  return isAbsolute(input) ? input : resolve(process.cwd(), input);
}
