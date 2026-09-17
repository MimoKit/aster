/**
 * 配置模块测试。
 *
 * 运行：node --test test/
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ConfigManager, DEFAULT_CONFIG, coerce, validate } from '../lib/config.js';

let home;

before(() => {
  home = mkdtempSync(join(tmpdir(), 'aster-cfg-'));
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('ConfigManager', () => {
  it('首次读取时生成配置文件', () => {
    const manager = new ConfigManager(home);
    const config = manager.read();
    assert.equal(config.onebot11.port, 5310);
    assert.equal(readFileSync(manager.paths.configFile, 'utf8').length > 0, true);
  });

  it('读取嵌套配置项', () => {
    const manager = new ConfigManager(home);
    assert.equal(manager.get('onebot11.port'), 5310);
    assert.equal(manager.get('bot.name'), 'Aster');
    assert.equal(manager.get('onebot11.path'), '/onebot/v11/ws');
    assert.equal(manager.get('不存在的键'), undefined);
  });

  it('写入并按原类型转换', () => {
    const manager = new ConfigManager(home);
    manager.set('onebot11.port', '5399');
    assert.equal(manager.get('onebot11.port'), 5399, '端口应转为数字');

    manager.set('onebot11.enable', 'false');
    assert.equal(manager.get('onebot11.enable'), false, '布尔值应被解析');

    manager.set('onebot11.access_token', 'secret');
    assert.equal(manager.get('onebot11.access_token'), 'secret');
  });

  it('修改后重新读取保持一致', () => {
    const manager = new ConfigManager(home);
    manager.set('log.level', 'debug');
    assert.equal(new ConfigManager(home).get('log.level'), 'debug');
  });

  it('支持写入原先不存在的键', () => {
    const manager = new ConfigManager(home);
    manager.set('onebot11.新字段', '5');
    assert.equal(manager.get('onebot11.新字段'), 5);
  });

  it('拒绝空配置键', () => {
    const manager = new ConfigManager(home);
    assert.throws(() => manager.set('', 'x'), /不能为空/);
  });

  it('flatten 摊平嵌套结构', () => {
    const manager = new ConfigManager(home);
    const flat = manager.flatten();
    assert.equal(flat['onebot11.port'], manager.get('onebot11.port'));
    assert.ok('log.level' in flat);
  });
});

describe('coerce', () => {
  it('按原值类型转换', () => {
    assert.equal(coerce('42', 1), 42);
    assert.equal(coerce('true', false), true);
    assert.equal(coerce('OFF', true), false);
    assert.deepEqual(coerce('a, b ,c', []), ['a', 'b', 'c']);
  });

  it('原值缺失时按字面量推断', () => {
    assert.equal(coerce('123', undefined), 123);
    assert.equal(coerce('true', undefined), true);
    assert.equal(coerce('hello', undefined), 'hello');
  });

  it('非法输入抛错', () => {
    assert.throws(() => coerce('abc', 1), /需要数字/);
    assert.throws(() => coerce('maybe', true), /需要布尔值/);
  });
});

describe('validate', () => {
  it('默认配置无问题', () => {
    assert.deepEqual(validate(DEFAULT_CONFIG), []);
  });

  it('识别特权端口', () => {
    const problems = validate({ onebot11: { port: 531, path: '/x' } });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /特权端口/);
  });

  it('识别非法端口与路径', () => {
    assert.match(validate({ onebot11: { port: 99999 } })[0], /非法/);
    assert.match(validate({ onebot11: { path: 'no-slash' } })[0], /应以 \/ 开头/);
  });

  it('识别非法日志级别', () => {
    assert.match(validate({ log: { level: 'verbose' } })[0], /log.level 非法/);
  });

  it('容忍不完整配置', () => {
    assert.deepEqual(validate({}), []);
    assert.deepEqual(validate(null), []);
  });
});

describe('配置文件损坏', () => {
  it('抛出可读的错误', () => {
    const brokenHome = mkdtempSync(join(tmpdir(), 'aster-broken-'));
    try {
      const manager = new ConfigManager(brokenHome);
      manager.ensure();
      writeFileSync(manager.paths.configFile, '这不是 TOML {{{', 'utf8');
      assert.throws(() => manager.read(), /解析 .* 失败/);
    } finally {
      rmSync(brokenHome, { recursive: true, force: true });
    }
  });
});
