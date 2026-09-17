/**
 * 启动器：把 Rust 可执行文件**前台直启**，日志直接输出到当前终端。
 *
 * 这里刻意不做进程守护、不写 PID 文件、不做后台化——
 * 持久化运行交给用户自己用 systemd / screen / tmux / nohup 处理，
 * 和大多数 Bot 框架保持一致。
 *
 * 可执行文件的解析顺序：
 *
 * 1. 环境变量 `ASTER_BINARY`
 * 2. npm 包内 `target/release/aster`（已编译过）
 * 3. 包内 `target/debug/aster`
 * 4. 包内 `vendor/aster`（随包分发的预编译产物）
 * 5. 都没有则用 `cargo build --release` 现场编译
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { PACKAGE_ROOT, Paths, binaryName } from './paths.js';
import { ConfigManager, validate } from './config.js';

/**
 * 解析可执行文件路径
 * @param {{ build?: boolean }} options build=false 时找不到不自动编译
 * @returns {{ path: string|null, built: boolean }}
 */
export function resolveBinary({ build = true } = {}) {
  const candidates = [];
  if (process.env.ASTER_BINARY) candidates.push(process.env.ASTER_BINARY);
  candidates.push(join(PACKAGE_ROOT, 'target', 'release', binaryName()));
  candidates.push(join(PACKAGE_ROOT, 'target', 'debug', binaryName()));
  candidates.push(join(PACKAGE_ROOT, 'vendor', binaryName()));

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return { path: candidate, built: true };
  }

  if (!build) return { path: null, built: false };
  return { path: buildBinary(), built: true };
}

/** 用 cargo 编译，返回产物路径 */
export function buildBinary({ release = true } = {}) {
  const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
  if (cargo.status !== 0) {
    throw new Error(
      '未找到 cargo，无法编译 Rust 可执行文件。\n' +
        '请先安装 Rust：https://rustup.rs\n' +
        '或用 ASTER_BINARY 指定已编译好的可执行文件路径。',
    );
  }

  const args = ['build'];
  if (release) args.push('--release');
  const result = spawnSync('cargo', args, { cwd: PACKAGE_ROOT, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`cargo build 失败（退出码 ${result.status}）`);

  const output = join(PACKAGE_ROOT, 'target', release ? 'release' : 'debug', binaryName());
  if (!existsSync(output)) throw new Error(`编译完成但未找到产物：${output}`);
  return output;
}

/**
 * 前台启动，继承当前终端。
 *
 * @param {string} home 数据目录
 * @param {{ build?: boolean }} options
 * @returns {Promise<number>} 进程退出码
 */
export async function run(home, { build = true } = {}) {
  const paths = new Paths(home);
  const config = new ConfigManager(home);

  paths.ensure();
  config.ensure();

  // 启动前校验配置，避免带着明显错误跑起来
  const problems = validate(config.read());
  if (problems.length) {
    throw new Error(`配置有问题：\n  - ${problems.join('\n  - ')}`);
  }

  const { path: binary } = resolveBinary({ build });
  if (!binary) throw new Error('未找到 Aster 可执行文件');

  const env = { ...process.env, ASTER_HOME: paths.home };
  const child = spawn(binary, [], { cwd: paths.home, env, stdio: 'inherit' });

  // 转发退出信号，保证 Ctrl-C 能正常关闭子进程
  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  const onInt = () => forward('SIGINT');
  const onTerm = () => forward('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);

  return await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      if (signal) {
        process.stdout.write(`\n已终止（${signal}）\n`);
        resolve(0);
        return;
      }
      resolve(code ?? 0);
    });
  });
}
