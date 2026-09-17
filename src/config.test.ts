/**
 * 配置读写与校验测试。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import {
  DEFAULT_CONFIG_TOML,
  defaultConfig,
  getByPath,
  loadConfig,
  normalizePath,
  resolvePluginDir,
  saveConfig,
  setByPath,
  validateConfig,
} from './config.ts';

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'aster-config-'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('默认配置', () => {
  test('关键默认值', () => {
    const config = defaultConfig();
    assert.equal(config.onebot11.port, 5310);
    assert.equal(config.webui.port, 5311);
    assert.equal(config.webui.host, '127.0.0.1', 'WebUI 默认只监听本机');
    assert.equal(config.plugin.hotReload, true);
    assert.equal(config.bot.commandPrefix, '');
  });

  test('默认配置本身没有校验问题', () => {
    assert.deepEqual(validateConfig(defaultConfig()), []);
  });

  test('模板包含全部配置节', () => {
    for (const section of ['[bot]', '[log]', '[onebot11]', '[webui]', '[plugin]']) {
      assert.ok(DEFAULT_CONFIG_TOML.includes(section), `模板应包含 ${section}`);
    }
  });
});

describe('加载', () => {
  test('首次加载生成带注释的配置', () => {
    const target = mkdtempSync(join(dir, 'fresh-'));
    const loaded = loadConfig(target);

    assert.equal(loaded.created, true);
    assert.ok(existsSync(loaded.path));

    const text = readFileSync(loaded.path, 'utf8');
    assert.ok(text.includes('#'), '生成的配置应带注释');
    assert.ok(text.includes('[webui]'));
  });

  test('二次加载不覆盖已有文件', () => {
    const target = mkdtempSync(join(dir, 'keep-'));
    const first = loadConfig(target);
    const edited = { ...first.config, bot: { ...first.config.bot, name: '改过的' } };
    saveConfig(first, edited);

    const second = loadConfig(target);
    assert.equal(second.created, false);
    assert.equal(second.config.bot.name, '改过的');
  });

  test('未知字段被忽略（前向兼容）', () => {
    const target = mkdtempSync(join(dir, 'unknown-'));
    writeFileSync(join(target, 'config.toml'), '[bot]\nname = "X"\nfuture_option = true\n', 'utf8');
    const loaded = loadConfig(target);
    assert.equal(loaded.config.bot.name, 'X');
  });

  test('语法错误给出可读提示', () => {
    const target = mkdtempSync(join(dir, 'broken-'));
    writeFileSync(join(target, 'config.toml'), '这不是 TOML {{{', 'utf8');
    assert.throws(() => loadConfig(target), /解析 .* 失败/);
  });
});

describe('校验', () => {
  test('识别非法端口', () => {
    const config = defaultConfig();
    config.onebot11.port = 99999;
    assert.ok(validateConfig(config).some((p) => p.includes('端口非法')));
  });

  test('识别特权端口', () => {
    const config = defaultConfig();
    config.onebot11.port = 531;
    assert.ok(validateConfig(config).some((p) => p.includes('特权端口')));
  });

  test('识别端口冲突', () => {
    const config = defaultConfig();
    config.webui.port = config.onebot11.port;
    assert.ok(validateConfig(config).some((p) => p.includes('端口相同')));
  });

  test('识别非法路径', () => {
    const config = defaultConfig();
    config.onebot11.path = 'no-slash';
    assert.ok(validateConfig(config).some((p) => p.includes('应以 / 开头')));
  });

  test('识别非法日志级别', () => {
    const config = defaultConfig();
    config.log.level = 'verbose';
    assert.ok(validateConfig(config).some((p) => p.includes('log.level 非法')));
  });

  test('WebUI 对外暴露且无 token 会被警告', () => {
    const config = defaultConfig();
    config.webui.host = '0.0.0.0';
    config.webui.accessToken = '';
    assert.ok(
      validateConfig(config).some((p) => p.includes('access_token')),
      '应提示缺少 token',
    );

    config.webui.accessToken = 'x';
    assert.ok(
      !validateConfig(config).some((p) => p.includes('webui 监听')),
      '设了 token 就不应再提示',
    );
  });

  test('onebot11 的暴露提示交给服务端，不在配置校验里重复', () => {
    const config = defaultConfig();
    config.onebot11.host = '0.0.0.0';
    config.onebot11.accessToken = '';
    assert.ok(
      !validateConfig(config).some((p) => p.includes('onebot11 监听')),
      '避免与 OneBot11Server 启动时的提示重复',
    );
  });

  test('非法主人账号被提示', () => {
    const config = defaultConfig();
    config.bot.masters = ['not-a-qq'];
    assert.ok(validateConfig(config).some((p) => p.includes('不像 QQ 号')));
  });
});

describe('点路径访问', () => {
  test('读取嵌套值', () => {
    const config = defaultConfig();
    assert.equal(getByPath(config, 'onebot11.port'), 5310);
    assert.equal(getByPath(config, 'bot.name'), 'Aster');
    assert.equal(getByPath(config, 'nope.nope'), undefined);
  });

  test('写入嵌套值且不改原对象', () => {
    const config = defaultConfig();
    const next = setByPath(config, 'onebot11.port', 5399);

    assert.equal(getByPath(next, 'onebot11.port'), 5399);
    assert.equal(getByPath(config, 'onebot11.port'), 5310, '原对象不应被改动');
  });

  test('自动创建中间层', () => {
    const config = defaultConfig();
    const next = setByPath(config, 'brandnew.nested.value', 1);
    assert.equal(getByPath(next, 'brandnew.nested.value'), 1);
  });

  test('空路径被拒绝', () => {
    assert.throws(() => setByPath(defaultConfig(), '', 1), /不能为空/);
  });
});

describe('路径工具', () => {
  test('normalizePath 规范化', () => {
    assert.equal(normalizePath('onebot/v11/ws'), '/onebot/v11/ws');
    assert.equal(normalizePath('/onebot/v11/ws/'), '/onebot/v11/ws');
    assert.equal(normalizePath('//a//b//'), '//a//b');
    assert.equal(normalizePath('/'), '/');
  });

  test('resolvePluginDir 展开相对路径', () => {
    assert.equal(resolvePluginDir('plugins', '/data'), '/data/plugins');
    assert.equal(resolvePluginDir('/abs/plugins', '/data'), '/abs/plugins');
  });
});
