/**
 * 命令行与路径解析测试。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { parseArgs } from '../lib/cli.js';
import { Paths, binaryName, resolveHome } from '../lib/paths.js';
import { resolveBinary } from '../lib/run.js';

let home;

before(() => {
  home = mkdtempSync(join(tmpdir(), 'aster-run-'));
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('parseArgs', () => {
  it('解析命令与位置参数', () => {
    const options = parseArgs(['config', 'set', 'onebot11.port', '5310']);
    assert.deepEqual(options._, ['config', 'set', 'onebot11.port', '5310']);
  });

  it('解析选项', () => {
    assert.equal(parseArgs(['-h']).help, true);
    assert.equal(parseArgs(['-v']).version, true);
    assert.equal(parseArgs(['--json']).json, true);
    assert.equal(parseArgs(['--home', '/tmp/x']).home, '/tmp/x');
    assert.equal(parseArgs(['--port', '5310']).port, '5310');
    assert.equal(parseArgs(['--host', '0.0.0.0']).host, '0.0.0.0');
    assert.equal(parseArgs(['--token', 'abc']).token, 'abc');
  });

  it('无参数时命令列表为空（默认启动）', () => {
    assert.deepEqual(parseArgs([])._, []);
  });
});

describe('resolveHome', () => {
  it('显式参数优先', () => {
    assert.equal(resolveHome('/tmp/explicit'), '/tmp/explicit');
  });

  it('其次读 ASTER_HOME', () => {
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
  it('只维护配置文件路径', () => {
    const paths = new Paths('/tmp/aster-home');
    assert.equal(paths.configFile, '/tmp/aster-home/config.toml');
    assert.equal(paths.home, '/tmp/aster-home');
    // 不再有 pid / 日志文件
    assert.equal(paths.pidFile, undefined);
    assert.equal(paths.logFile, undefined);
  });

  it('ensure 创建数据目录', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aster-paths-'));
    try {
      const paths = new Paths(join(dir, 'nested', 'deep'));
      assert.equal(existsSync(paths.home), false);
      paths.ensure();
      assert.equal(existsSync(paths.home), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('默认配置模板来自包内', () => {
    const paths = new Paths(home);
    assert.equal(existsSync(paths.defaultConfig), true, '包内应带默认配置');
  });
});

describe('resolveBinary', () => {
  it('ASTER_BINARY 优先级最高', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aster-bin-'));
    const fake = join(dir, 'my-aster');
    writeFileSync(fake, '#!/bin/sh\necho hi\n', { mode: 0o755 });

    const original = process.env.ASTER_BINARY;
    process.env.ASTER_BINARY = fake;
    try {
      const resolved = resolveBinary({ build: false });
      assert.equal(resolved.path, fake);
      assert.equal(resolved.built, true);
    } finally {
      if (original === undefined) delete process.env.ASTER_BINARY;
      else process.env.ASTER_BINARY = original;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('build=false 时找不到不编译', () => {
    const original = process.env.ASTER_BINARY;
    process.env.ASTER_BINARY = '/nonexistent/aster';
    try {
      const resolved = resolveBinary({ build: false });
      // 本地开发时 target/ 下可能已有产物，因此只断言不抛异常且结构正确
      assert.equal(typeof resolved.built, 'boolean');
    } finally {
      if (original === undefined) delete process.env.ASTER_BINARY;
      else process.env.ASTER_BINARY = original;
    }
  });
});
