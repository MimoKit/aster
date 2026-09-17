/**
 * 进程生命周期管理：启动、停止、重启、状态查询。
 *
 * Aster 的 Rust 可执行文件来源按以下顺序解析：
 *
 * 1. 环境变量 `ASTER_BINARY` 指定的路径
 * 2. 包内 `vendor/aster`（预编译分发位置）
 * 3. 项目 `target/release/aster`（本地开发）
 * 4. 项目 `target/debug/aster`
 * 5. 都没有时，用 `cargo build --release` 现场编译
 *
 * 启动方式：以 detached 子进程运行，stdout/stderr 追加写入
 * `<数据目录>/logs/aster.log`，PID 写入 `<数据目录>/aster.pid`。
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';

import { PACKAGE_ROOT, Paths, binaryName } from './paths.js';
import { ConfigManager, validate } from './config.js';

/** 进程未运行的错误 */
export class NotRunningError extends Error {
  constructor(message = 'Aster 未在运行') {
    super(message);
    this.name = 'NotRunningError';
  }
}

export class ProcessManager {
  constructor(home) {
    this.paths = new Paths(home);
    this.config = new ConfigManager(home);
  }

  /**
   * 解析可执行文件路径。
   *
   * 查找顺序：
   * 1. `ASTER_BINARY` 环境变量
   * 2. 数据目录 `bin/aster`（已安装/已编译的副本）
   * 3. 包内 `vendor/aster`（随 npm 包分发的预编译产物）
   * 4. 项目 `target/release/aster`、`target/debug/aster`（本地开发）
   *
   * 找到项目内的产物后会复制到数据目录，避免 npm 全局安装时
   * 包目录只读导致无法就地编译。
   *
   * @param {{ build?: boolean }} options build=false 时找不到不触发编译
   */
  resolveBinary({ build = true } = {}) {
    const candidates = [this.paths.binary, join(this.paths.vendorDir, binaryName())];
    if (process.env.ASTER_BINARY) candidates.unshift(process.env.ASTER_BINARY);

    if (this.paths.home) {
      candidates.push(join(PACKAGE_ROOT, 'target', 'release', binaryName()));
      candidates.push(join(PACKAGE_ROOT, 'target', 'debug', binaryName()));
    }

    for (const candidate of candidates) {
      if (candidate && existsSync(candidate)) {
        const installed = this.installBinary(candidate);
        return { path: installed, built: true, source: candidate };
      }
    }

    if (!build) return { path: null, built: false };

    const built = this.build();
    return { path: this.installBinary(built), built: true, source: built };
  }

  /**
   * 把可执行文件复制到数据目录并赋予执行权限。
   * 若来源已经是目标路径则直接返回。
   */
  installBinary(source) {
    if (source === this.paths.binary) return source;

    // 项目内开发时直接用原路径，避免每次启动都复制
    const isDevTree = source.startsWith(join(PACKAGE_ROOT, 'target'));
    if (isDevTree && !process.env.ASTER_FORCE_INSTALL) return source;

    try {
      this.paths.ensure();
      copyFileSync(source, this.paths.binary);
      chmodSync(this.paths.binary, 0o755);
      return this.paths.binary;
    } catch (err) {
      // 复制失败（如只读文件系统）时退回原路径
      process.stderr.write(
        `提示：无法安装可执行文件到数据目录（${err.message}），将直接使用 ${source}\n`,
      );
      return source;
    }
  }

  /** 用 cargo 编译，返回产物路径 */
  build({ release = true } = {}) {
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
    const result = spawnSync('cargo', args, {
      cwd: PACKAGE_ROOT,
      stdio: 'inherit',
    });
    if (result.status !== 0) throw new Error(`cargo build 失败（退出码 ${result.status}）`);

    const output = join(PACKAGE_ROOT, 'target', release ? 'release' : 'debug', 'aster');
    if (!existsSync(output)) throw new Error(`编译完成但未找到产物：${output}`);
    return output;
  }

  /** 读取 PID 文件 */
  readPid() {
    if (!existsSync(this.paths.pidFile)) return null;
    const text = readFileSync(this.paths.pidFile, 'utf8').trim();
    const pid = Number.parseInt(text, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }

  /** 进程是否存活 */
  isAlive(pid) {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM 表示进程存在但无权限操作
      return err.code === 'EPERM';
    }
  }

  /** 当前运行状态 */
  status() {
    const pid = this.readPid();
    const alive = this.isAlive(pid);
    if (!alive && pid) {
      // 残留的 PID 文件
      rmSync(this.paths.pidFile, { force: true });
    }
    const config = (() => {
      try {
        return this.config.read();
      } catch {
        return null;
      }
    })();
    return {
      running: alive,
      pid: alive ? pid : null,
      home: this.paths.home,
      configFile: this.paths.configFile,
      logFile: this.paths.logFile,
      host: config?.onebot11?.host,
      port: config?.onebot11?.port,
      path: config?.onebot11?.path,
      token: Boolean(config?.onebot11?.access_token),
    };
  }

  /** 启动（若已在运行则报错） */
  start({ foreground = false, build = true } = {}) {
    const current = this.status();
    if (current.running) {
      throw new Error(`Aster 已在运行（PID ${current.pid}）`);
    }

    const { path: binary } = this.resolveBinary({ build });
    if (!binary) throw new Error('未找到 Aster 可执行文件');

    this.paths.ensure();
    this.config.ensure();

    const problems = (() => {
      try {
        return validate(this.config.read());
      } catch {
        return [];
      }
    })();
    if (problems.length) {
      throw new Error(`配置有问题：\n  - ${problems.join('\n  - ')}`);
    }

    const env = {
      ...process.env,
      ASTER_HOME: this.paths.home,
    };

    if (foreground) {
      const child = spawn(binary, [], { cwd: this.paths.home, env, stdio: 'inherit' });
      return { pid: child.pid, foreground: true, binary, child };
    }

    const out = openSync(this.paths.logFile, 'a');
    const child = spawn(binary, [], {
      cwd: this.paths.home,
      env,
      detached: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
    closeSync(out);

    writeFileSync(this.paths.pidFile, String(child.pid), 'utf8');
    return { pid: child.pid, foreground: false, binary, child };
  }

  /** 停止：先 SIGTERM，超时后 SIGKILL */
  async stop({ timeout = 5000 } = {}) {
    const pid = this.readPid();
    if (!pid || !this.isAlive(pid)) {
      rmSync(this.paths.pidFile, { force: true });
      throw new NotRunningError();
    }

    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      if (err.code === 'ESRCH') {
        rmSync(this.paths.pidFile, { force: true });
        return { pid, forced: false };
      }
      throw err;
    }

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (!this.isAlive(pid)) {
        rmSync(this.paths.pidFile, { force: true });
        return { pid, forced: false };
      }
      await sleep(100);
    }

    // 超时强杀
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已退出 */
    }
    rmSync(this.paths.pidFile, { force: true });
    return { pid, forced: true };
  }

  /** 重启 */
  async restart(options = {}) {
    try {
      await this.stop(options);
    } catch (err) {
      if (!(err instanceof NotRunningError)) throw err;
    }
    return this.start(options);
  }

  /** 读取日志尾部 */
  tailLog(lines = 50) {
    if (!existsSync(this.paths.logFile)) return [];
    const content = readFileSync(this.paths.logFile, 'utf8');
    return content.split('\n').filter(Boolean).slice(-lines);
  }

  /** 日志文件信息 */
  logInfo() {
    if (!existsSync(this.paths.logFile)) return null;
    const stat = statSync(this.paths.logFile);
    return { path: this.paths.logFile, size: stat.size, mtime: stat.mtime };
  }

  /**
   * 判断端口是否已就绪。
   *
   * 直接 TCP 连接会在 Rust 侧触发「WebSocket 握手失败」告警，
   * 因此这里改为读日志中的监听记录：启动成功时必然打印
   * `OneBot v11 适配器已监听 ws://<addr>:<port>`。
   *
   * @returns {boolean}
   */
  isListeningInLog(port) {
    if (!existsSync(this.paths.logFile)) return false;
    const lines = this.tailLog(200);
    const pattern = new RegExp(`已监听\\s+ws://[^\\s]*:${port}\\b`);
    return lines.some((line) => pattern.test(line));
  }

  /**
   * 等待服务就绪（轮询日志，避免产生握手告警）
   * @returns {Promise<boolean>}
   */
  async waitReady(_host, port, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.isListeningInLog(port)) return true;
      if (!this.status().running) return false;
      await sleep(150);
    }
    return false;
  }

  /**
   * 探测端口是否可连接（用于 status 展示）。
   *
   * 注意：这会与 Rust 服务建立一次裸 TCP 连接并立刻断开，
   * 服务端会记录一条握手失败告警，因此只在用户显式查看状态时使用。
   */
  async probe(host, port, timeout = 800) {
    const target = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    return new Promise((resolve) => {
      const socket = connect({ host: target, port });
      const done = (ok) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeout);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
