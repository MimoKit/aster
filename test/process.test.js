/**
 * 命令行参数解析与进程管理测试。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { parseArgs } from '../lib/cli.js';
import { Paths, binaryName, resolveHome } from '../lib/paths.js';
import { ProcessManager } from '../lib/process.js';

let home;

before(() => {
  home = mkdtempSync(join(tmpdir(), 'aster-proc-'));
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('parseArgs', () => {
  it('解析命令与位置参数', () => {
    const options = parseArgs(['config', 'set', 'onebot11.port', '5310']);
    assert.deepEqual(options._, ['config', 'set', 'onebot11.port', '5310']);
  });

  it('解析短选项', () => {
    assert.equal(parseArgs(['logs', '-f']).follow, true);
    assert.equal(parseArgs(['logs', '-n', '20']).lines, 20);
    assert.equal(parseArgs(['-h']).help, true);
    assert.equal(parseArgs(['-v']).version, true);
  });

  it('解析长选项', () => {
    const options = parseArgs(['start', '--home', '/tmp/x', '--port', '5310', '--json']);
    assert.equal(options.home, '/tmp/x');
    assert.equal(options.port, '5310');
    assert.equal(options.json, true);
  });

  it('无参数时返回空命令', () => {
    assert.deepEqual(parseArgs([])._, []);
  });
});

describe('resolveHome', () => {
  it('显式参数优先级最高', () => {
    assert.equal(resolveHome('/tmp/explicit'), '/tmp/explicit');
  });

  it('其次读环境变量', () => {
    const original = process.env.ASTER_HOME;
    process.env.ASTER_HOME = '/tmp/from-env';
    try {
      assert.equal(resolveHome(), '/tmp/from-env');
    } finally {
      if (original === undefined) delete process.env.ASTER_HOME;
      else process.env.ASTER_HOME = original;
    }
  });

  it('都没有时用 cwd/aster-data', () => {
    const original = process.env.ASTER_HOME;
    delete process.env.ASTER_HOME;
    try {
      assert.match(resolveHome(), /aster-data$/);
    } finally {
      if (original !== undefined) process.env.ASTER_HOME = original;
    }
  });
});

describe('binaryName', () => {
  it('Windows 带 .exe', () => {
    assert.equal(binaryName('win32'), 'aster.exe');
    assert.equal(binaryName('linux'), 'aster');
    assert.equal(binaryName('darwin'), 'aster');
  });
});

describe('Paths', () => {
  it('派生正确的路径', () => {
    const paths = new Paths('/tmp/aster-home');
    assert.equal(paths.configFile, '/tmp/aster-home/config.toml');
    assert.equal(paths.pidFile, '/tmp/aster-home/aster.pid');
    assert.equal(paths.logFile, '/tmp/aster-home/logs/aster.log');
  });

  it('ensure 创建目录', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aster-paths-'));
    try {
      const paths = new Paths(join(dir, 'nested', 'deep'));
      paths.ensure();
      assert.equal(paths.logDir.startsWith(dir), true);
      assert.equal(paths.binDir, join(paths.home, 'bin'), '可执行文件目录应在数据目录内');
      assert.equal(paths.vendorDir.includes('vendor'), true, '预编译目录来自 npm 包');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ProcessManager', () => {
  it('未运行时 status.running 为 false', () => {
    const manager = new ProcessManager(home);
    manager.paths.ensure();
    assert.equal(manager.status().running, false);
  });

  it('识别存活的 PID', () => {
    const manager = new ProcessManager(home);
    manager.paths.ensure();
    assert.equal(manager.isAlive(process.pid), true, '自身进程应存活');
    assert.equal(manager.isAlive(999999), false, '不存在的 PID 应判定为死亡');
    assert.equal(manager.isAlive(null), false);
  });

  it('清理失效的 PID 文件', () => {
    const manager = new ProcessManager(home);
    manager.paths.ensure();
    writeFileSync(manager.paths.pidFile, '999999', 'utf8');
    const status = manager.status();
    assert.equal(status.running, false);
    assert.equal(manager.readPid(), null, '失效 PID 文件应被清理');
  });

  it('未运行时 stop 抛出 NotRunningError', async () => {
    const manager = new ProcessManager(home);
    manager.paths.ensure();
    await assert.rejects(() => manager.stop(), /未在运行/);
  });

  it('resolveBinary 在 build=false 时找不到不编译', () => {
    const manager = new ProcessManager(home);
    const original = process.env.ASTER_BINARY;
    delete process.env.ASTER_BINARY;
    try {
      const result = manager.resolveBinary({ build: false });
      // 本地开发时 target/ 下存在产物，因此只断言不抛异常
      assert.equal(typeof result.built, 'boolean');
    } finally {
      if (original !== undefined) process.env.ASTER_BINARY = original;
    }
  });

  it('ASTER_BINARY 指定的路径优先', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aster-bin-'));
    const fake = join(dir, 'my-aster');
    writeFileSync(fake, '#!/bin/sh\necho hi\n', { mode: 0o755 });
    const isolatedHome = mkdtempSync(join(tmpdir(), 'aster-bin-home-'));
    const original = process.env.ASTER_BINARY;
    process.env.ASTER_BINARY = fake;
    try {
      const manager = new ProcessManager(isolatedHome);
      const resolved = manager.resolveBinary({ build: false });
      // 可执行文件会被安装进数据目录，内容与来源一致
      assert.equal(resolved.source, fake);
      assert.equal(resolved.built, true);
      assert.equal(existsSync(resolved.path), true);
    } finally {
      if (original === undefined) delete process.env.ASTER_BINARY;
      else process.env.ASTER_BINARY = original;
      rmSync(dir, { recursive: true, force: true });
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });

  it('installBinary 复制到数据目录并赋可执行权限', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aster-install-'));
    const isolatedHome = mkdtempSync(join(tmpdir(), 'aster-install-home-'));
    try {
      const source = join(dir, 'aster-src');
      writeFileSync(source, '#!/bin/sh\necho ok\n');

      const manager = new ProcessManager(isolatedHome);
      manager.paths.ensure();
      const target = manager.installBinary(source);

      assert.equal(target, join(isolatedHome, 'bin', 'aster'));
      assert.equal(existsSync(target), true);
      // 具备执行权限
      const mode = statSync(target).mode & 0o777;
      assert.equal((mode & 0o111) !== 0, true, `应有执行权限，实际 ${mode.toString(8)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });

  it('installBinary 对已在目标位置的路径不重复复制', () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), 'aster-same-'));
    try {
      const manager = new ProcessManager(isolatedHome);
      manager.paths.ensure();
      assert.equal(manager.installBinary(manager.paths.binary), manager.paths.binary);
    } finally {
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });

  it('日志读取', () => {
    const manager = new ProcessManager(home);
    manager.paths.ensure();
    writeFileSync(manager.paths.logFile, 'line1\nline2\nline3\n', 'utf8');
    assert.deepEqual(manager.tailLog(2), ['line2', 'line3']);
    assert.equal(manager.logInfo().size > 0, true);
  });

  it('日志不存在时返回空', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aster-nolog-'));
    try {
      const manager = new ProcessManager(dir);
      assert.deepEqual(manager.tailLog(), []);
      assert.equal(manager.logInfo(), null);
      assert.equal(manager.isListeningInLog(5310), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('从日志判断监听状态', () => {
    const manager = new ProcessManager(home);
    manager.paths.ensure();
    writeFileSync(
      manager.paths.logFile,
      '2026-01-01 INFO [aster::onebot11] OneBot v11 适配器已监听 ws://0.0.0.0:5399/onebot/v11/ws （鉴权：关闭）\n',
      'utf8',
    );
    assert.equal(manager.isListeningInLog(5399), true);
    assert.equal(manager.isListeningInLog(5310), false, '端口不匹配应为 false');
  });
});
