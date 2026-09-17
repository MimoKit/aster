/**
 * 插件宿主测试：加载、匹配、权限、错误隔离、重载。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { normalizeEvent } from './event.ts';
import { Logger } from './logger.ts';
import { Bot, BotRegistry } from './onebot11.ts';
import { definePlugin, normalizePlugin } from './plugin.ts';
import { PluginHost, permissionAllows } from './plugin-host.ts';
import { Stats } from './stats.ts';
import type { AsterEvent, MessageEvent } from './types.ts';

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'aster-host-'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 静默 logger */
function quietLogger(): Logger {
  return new Logger({ level: 'silent', maxLength: 4096, showBase64: false, color: false }, 100);
}

/** 造一个宿主，插件目录指向给定目录 */
function makeHost(pluginDir: string, masters: string[] = []): PluginHost {
  return new PluginHost({
    dirs: [pluginDir],
    logger: quietLogger(),
    stats: new Stats(),
    registry: new BotRegistry(),
    version: '0.0.0-test',
    address: () => null,
    masters,
    commandPrefix: '',
    hotReload: false,
  });
}

/** 造一个群消息事件 */
function groupEvent(
  text: string,
  options: { role?: string; userId?: string; selfId?: string } = {},
): MessageEvent {
  const event: AsterEvent = normalizeEvent({
    time: Math.floor(Date.now() / 1000),
    self_id: options.selfId ?? 10001,
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: 1,
    user_id: options.userId ?? 20002,
    group_id: 30003,
    message: text,
    sender: { user_id: options.userId ?? 20002, nickname: '小明', role: options.role ?? 'member' },
  });
  if (event.type !== 'message') throw new Error('应为消息事件');
  return event;
}

/** 造一个私聊消息事件 */
function privateEvent(text: string): MessageEvent {
  const event: AsterEvent = normalizeEvent({
    time: Math.floor(Date.now() / 1000),
    self_id: 10001,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 1,
    user_id: 20002,
    message: text,
    sender: { user_id: 20002, nickname: '小明' },
  });
  if (event.type !== 'message') throw new Error('应为消息事件');
  return event;
}

/** 写一个插件文件，返回目录 */
function writePlugin(name: string, source: string): string {
  const pluginDir = mkdtempSync(join(dir, `${name}-`));
  writeFileSync(join(pluginDir, `${name}.ts`), source, 'utf8');
  return pluginDir;
}

/** 一个只记录调用、不做别的的插件 */
function recorderPlugin(
  name: string,
  matcher: string,
  extra: { permission?: string; scope?: string } = {},
): string {
  return `
import { definePlugin } from 'aster-bot'

export default definePlugin({
  name: ${JSON.stringify(name)},
  desc: '测试用',
  rules: [
    {
      name: '规则',
      ${matcher},
      ${extra.permission ? `permission: ${JSON.stringify(extra.permission)},` : ''}
      ${extra.scope ? `scope: ${JSON.stringify(extra.scope)},` : ''}
      async handler(ctx) {
        globalThis.__calls = globalThis.__calls ?? []
        globalThis.__calls.push({ plugin: ${JSON.stringify(name)}, args: ctx.args, text: ctx.text })
      },
    },
  ],
})
`;
}

/** 清空调用记录 */
function resetCalls(): void {
  (globalThis as Record<string, unknown>).__calls = [];
}

/** 读取调用记录 */
function calls(): { plugin: string; args: string; text: string }[] {
  return ((globalThis as Record<string, unknown>).__calls ?? []) as {
    plugin: string;
    args: string;
    text: string;
  }[];
}

/** 分发一条消息 */
async function dispatch(host: PluginHost, event: MessageEvent): Promise<boolean> {
  const bot = new Bot(new BotRegistry(), event.selfId);
  return host.dispatch({ event, bot });
}

describe('加载', () => {
  test('加载单文件插件', async () => {
    const dir_ = writePlugin('one', recorderPlugin('one', `command: 'hi'`));
    const host = makeHost(dir_);
    await host.load();

    assert.equal(host.count, 1);
    assert.equal(host.ruleCount, 1);
    assert.equal(host.errors.length, 0);
    host.destroy();
  });

  test('按优先级排序', async () => {
    const pluginDir = mkdtempSync(join(dir, 'order-'));
    writeFileSync(
      join(pluginDir, 'a.ts'),
      `import { definePlugin } from 'aster-bot'\nexport default definePlugin({ name: 'a', priority: 900, rules: [{ command: 'x', handler: () => undefined }] })`,
      'utf8',
    );
    writeFileSync(
      join(pluginDir, 'b.ts'),
      `import { definePlugin } from 'aster-bot'\nexport default definePlugin({ name: 'b', priority: 100, rules: [{ command: 'x', handler: () => undefined }] })`,
      'utf8',
    );

    const host = makeHost(pluginDir);
    await host.load();
    assert.deepEqual(
      host.plugins.map((p) => p.name),
      ['b', 'a'],
      '优先级小的排前面',
    );
    host.destroy();
  });

  test('语法错误的插件被隔离', async () => {
    const pluginDir = mkdtempSync(join(dir, 'broken-'));
    writeFileSync(join(pluginDir, 'bad.ts'), 'this is not valid typescript {{{', 'utf8');
    writeFileSync(
      join(pluginDir, 'good.ts'),
      `import { definePlugin } from 'aster-bot'\nexport default definePlugin({ name: 'good', rules: [{ command: 'ok', handler: () => undefined }] })`,
      'utf8',
    );

    const host = makeHost(pluginDir);
    await host.load();

    assert.equal(host.count, 1, '好插件应正常加载');
    assert.equal(host.errors.length, 1, '坏插件应被记录');
    assert.ok(host.errors[0]?.file.includes('bad.ts'));
    host.destroy();
  });

  test('缺少 name 的插件被拒绝', async () => {
    const pluginDir = mkdtempSync(join(dir, 'noname-'));
    writeFileSync(join(pluginDir, 'x.ts'), `export default { rules: [] }`, 'utf8');

    const host = makeHost(pluginDir);
    await host.load();
    assert.equal(host.count, 0);
    assert.equal(host.errors.length, 1);
    host.destroy();
  });

  test('跳过下划线开头的文件', async () => {
    const pluginDir = mkdtempSync(join(dir, 'skip-'));
    writeFileSync(
      join(pluginDir, '_draft.ts'),
      `export default { name: 'draft', rules: [{ command: 'x', handler: () => undefined }] }`,
      'utf8',
    );
    const host = makeHost(pluginDir);
    await host.load();
    assert.equal(host.count, 0);
    assert.equal(host.errors.length, 0, '被跳过的文件不应报错');
    host.destroy();
  });
});

describe('匹配', () => {
  test('命令词独立成词', async () => {
    resetCalls();
    const host = makeHost(writePlugin('cmd', recorderPlugin('cmd', `command: 'as'`)));
    await host.load();

    await dispatch(host, groupEvent('as'));
    await dispatch(host, groupEvent('as 详细'));
    await dispatch(host, groupEvent('asd'));
    await dispatch(host, groupEvent('xas'));
    await dispatch(host, groupEvent('as'));

    assert.equal(calls().length, 3, 'as / as 详细 / as 应命中，asd 与 xas 不应命中');
    assert.equal(calls()[1]?.args, '详细', '参数应被提取');
    host.destroy();
  });

  test('@机器人后仍能触发', async () => {
    resetCalls();
    const host = makeHost(writePlugin('atcmd', recorderPlugin('atcmd', `command: 'as'`)));
    await host.load();

    await dispatch(host, groupEvent('[CQ:at,qq=10001] as'));
    assert.equal(calls().length, 1, '@ 之后应仍能触发');
    host.destroy();
  });

  test('前缀匹配', async () => {
    resetCalls();
    const host = makeHost(writePlugin('pfx', recorderPlugin('pfx', `prefix: '#as'`)));
    await host.load();

    await dispatch(host, groupEvent('#as'));
    await dispatch(host, groupEvent('#asd'));
    await dispatch(host, groupEvent('as'));

    assert.equal(calls().length, 2, '前缀只要开头匹配即可');
    host.destroy();
  });

  test('完全匹配', async () => {
    resetCalls();
    const host = makeHost(writePlugin('ex', recorderPlugin('ex', `exact: '状态'`)));
    await host.load();

    await dispatch(host, groupEvent('状态'));
    await dispatch(host, groupEvent('状态啊'));

    assert.equal(calls().length, 1);
    host.destroy();
  });

  test('包含匹配', async () => {
    resetCalls();
    const host = makeHost(writePlugin('ct', recorderPlugin('ct', `contains: '状态'`)));
    await host.load();

    await dispatch(host, groupEvent('看看状态如何'));
    assert.equal(calls().length, 1);
    host.destroy();
  });

  test('正则匹配与捕获组', async () => {
    resetCalls();
    const host = makeHost(writePlugin('re', recorderPlugin('re', `regex: /^echo\\s+(.+)$/`)));
    await host.load();

    await dispatch(host, groupEvent('echo 你好'));
    await dispatch(host, groupEvent('echo'));

    assert.equal(calls().length, 1);
    assert.equal(calls()[0]?.args, '你好', '捕获组应作为参数');
    host.destroy();
  });

  test('any 匹配所有消息', async () => {
    resetCalls();
    const host = makeHost(writePlugin('any', recorderPlugin('any', `any: true`)));
    await host.load();

    await dispatch(host, groupEvent('随便什么'));
    assert.equal(calls().length, 1);
    host.destroy();
  });

  test('机器人自己发的消息不触发', async () => {
    resetCalls();
    const host = makeHost(writePlugin('self', recorderPlugin('self', `command: 'as'`)));
    await host.load();

    const event = normalizeEvent({
      time: 1,
      self_id: 10001,
      post_type: 'message_sent',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 1,
      user_id: 10001,
      target_id: 30003,
      message: 'as',
      sender: { user_id: 10001 },
    });
    if (event.type !== 'message') throw new Error('应为消息事件');

    await dispatch(host, event);
    assert.equal(calls().length, 0, '不应自问自答');
    host.destroy();
  });
});

describe('范围与权限', () => {
  test('scope 限制会话类型', async () => {
    resetCalls();
    const host = makeHost(
      writePlugin('onlygroup', recorderPlugin('onlygroup', `command: 'x'`, { scope: 'group' })),
    );
    await host.load();

    await dispatch(host, groupEvent('x'));
    await dispatch(host, privateEvent('x'));

    assert.equal(calls().length, 1, '只应群聊触发');
    host.destroy();
  });

  test('私聊限定', async () => {
    resetCalls();
    const host = makeHost(
      writePlugin('onlypriv', recorderPlugin('onlypriv', `command: 'x'`, { scope: 'private' })),
    );
    await host.load();

    await dispatch(host, groupEvent('x'));
    await dispatch(host, privateEvent('x'));

    assert.equal(calls().length, 1);
    host.destroy();
  });

  test('admin 权限认可管理员与群主', async () => {
    resetCalls();
    const host = makeHost(
      writePlugin('adm', recorderPlugin('adm', `command: 'x'`, { permission: 'admin' })),
    );
    await host.load();

    await dispatch(host, groupEvent('x', { role: 'member' }));
    await dispatch(host, groupEvent('x', { role: 'admin' }));
    await dispatch(host, groupEvent('x', { role: 'owner' }));

    assert.equal(calls().length, 2, '管理员与群主应放行，普通成员拒绝');
    host.destroy();
  });

  test('owner 权限只认群主', async () => {
    resetCalls();
    const host = makeHost(
      writePlugin('own', recorderPlugin('own', `command: 'x'`, { permission: 'owner' })),
    );
    await host.load();

    await dispatch(host, groupEvent('x', { role: 'admin' }));
    await dispatch(host, groupEvent('x', { role: 'owner' }));

    assert.equal(calls().length, 1);
    host.destroy();
  });

  test('主人绕过权限限制', async () => {
    resetCalls();
    const host = makeHost(
      writePlugin('mst', recorderPlugin('mst', `command: 'x'`, { permission: 'owner' })),
      ['20002'],
    );
    await host.load();

    await dispatch(host, groupEvent('x', { role: 'member', userId: '20002' }));
    assert.equal(calls().length, 1, '主人即便不是群主也应放行');
    host.destroy();
  });

  test('permissionAllows 纯函数', () => {
    const member = groupEvent('x', { role: 'member' });
    const admin = groupEvent('x', { role: 'admin' });
    const owner = groupEvent('x', { role: 'owner' });

    assert.equal(permissionAllows('all', member, []), true);
    assert.equal(permissionAllows('master', owner, []), false);
    assert.equal(permissionAllows('master', member, ['20002']), true);
    assert.equal(permissionAllows('admin', member, []), false);
    assert.equal(permissionAllows('admin', admin, []), true);
    assert.equal(permissionAllows('owner', admin, []), false);
    assert.equal(permissionAllows('owner', owner, []), true);
  });
});

describe('控制流', () => {
  test('返回 false 放行后续规则', async () => {
    resetCalls();
    const pluginDir = mkdtempSync(join(dir, 'flow-'));
    writeFileSync(
      join(pluginDir, 'a.ts'),
      `import { definePlugin } from 'aster-bot'
export default definePlugin({ name: 'first', priority: 1, rules: [{ command: 'x', async handler() {
  globalThis.__calls = globalThis.__calls ?? []; globalThis.__calls.push({ plugin: 'first', args: '', text: '' })
  return false
} }] })`,
      'utf8',
    );
    writeFileSync(
      join(pluginDir, 'b.ts'),
      `import { definePlugin } from 'aster-bot'
export default definePlugin({ name: 'second', priority: 2, rules: [{ command: 'x', async handler() {
  globalThis.__calls = globalThis.__calls ?? []; globalThis.__calls.push({ plugin: 'second', args: '', text: '' })
} }] })`,
      'utf8',
    );

    const host = makeHost(pluginDir);
    await host.load();
    await dispatch(host, groupEvent('x'));

    assert.deepEqual(
      calls().map((c) => c.plugin),
      ['first', 'second'],
      'first 返回 false 后 second 应执行',
    );
    host.destroy();
  });

  test('默认返回值停止后续规则', async () => {
    resetCalls();
    const pluginDir = mkdtempSync(join(dir, 'stop-'));
    writeFileSync(
      join(pluginDir, 'a.ts'),
      `import { definePlugin } from 'aster-bot'
export default definePlugin({ name: 'first', priority: 1, rules: [{ command: 'x', async handler() {
  globalThis.__calls = globalThis.__calls ?? []; globalThis.__calls.push({ plugin: 'first', args: '', text: '' })
} }] })`,
      'utf8',
    );
    writeFileSync(
      join(pluginDir, 'b.ts'),
      `import { definePlugin } from 'aster-bot'
export default definePlugin({ name: 'second', priority: 2, rules: [{ command: 'x', async handler() {
  globalThis.__calls = globalThis.__calls ?? []; globalThis.__calls.push({ plugin: 'second', args: '', text: '' })
} }] })`,
      'utf8',
    );

    const host = makeHost(pluginDir);
    await host.load();
    await dispatch(host, groupEvent('x'));

    assert.deepEqual(
      calls().map((c) => c.plugin),
      ['first'],
      '默认应停止',
    );
    host.destroy();
  });

  test('抛错不阻断后续规则', async () => {
    resetCalls();
    const pluginDir = mkdtempSync(join(dir, 'err-'));
    writeFileSync(
      join(pluginDir, 'a.ts'),
      `import { definePlugin } from 'aster-bot'
export default definePlugin({ name: 'broken', priority: 1, rules: [{ command: 'x', async handler() {
  throw new Error('故意失败')
} }] })`,
      'utf8',
    );
    writeFileSync(
      join(pluginDir, 'b.ts'),
      `import { definePlugin } from 'aster-bot'
export default definePlugin({ name: 'ok', priority: 2, rules: [{ command: 'x', async handler() {
  globalThis.__calls = globalThis.__calls ?? []; globalThis.__calls.push({ plugin: 'ok', args: '', text: '' })
} }] })`,
      'utf8',
    );

    const host = makeHost(pluginDir);
    await host.load();
    await dispatch(host, groupEvent('x'));

    assert.deepEqual(
      calls().map((c) => c.plugin),
      ['ok'],
      '出错后应继续尝试',
    );
    host.destroy();
  });
});

describe('重载', () => {
  test('改文件后重载生效', async () => {
    const pluginDir = mkdtempSync(join(dir, 'reload-'));
    const file = join(pluginDir, 'r.ts');

    writeFileSync(
      file,
      `import { definePlugin } from 'aster-bot'\nexport default definePlugin({ name: 'r', rules: [{ command: 'old', handler: () => undefined }] })`,
      'utf8',
    );

    const host = makeHost(pluginDir);
    await host.load();
    assert.equal(host.plugins[0]?.rules[0]?.value, 'old');

    writeFileSync(
      file,
      `import { definePlugin } from 'aster-bot'\nexport default definePlugin({ name: 'r', rules: [{ command: 'new', handler: () => undefined }] })`,
      'utf8',
    );

    await host.reload();
    assert.equal(host.plugins[0]?.rules[0]?.value, 'new', '重载后应读到新内容');
    host.destroy();
  });

  test('重载后插件数变化被反映', async () => {
    const pluginDir = mkdtempSync(join(dir, 'count-'));
    writeFileSync(
      join(pluginDir, 'a.ts'),
      `import { definePlugin } from 'aster-bot'\nexport default definePlugin({ name: 'a', rules: [{ command: 'x', handler: () => undefined }] })`,
      'utf8',
    );

    const host = makeHost(pluginDir);
    await host.load();
    assert.equal(host.count, 1);

    writeFileSync(
      join(pluginDir, 'b.ts'),
      `import { definePlugin } from 'aster-bot'\nexport default definePlugin({ name: 'b', rules: [{ command: 'y', handler: () => undefined }] })`,
      'utf8',
    );
    await host.reload();
    assert.equal(host.count, 2);

    rmSync(join(pluginDir, 'a.ts'));
    await host.reload();
    assert.equal(host.count, 1);
    host.destroy();
  });
});

describe('定义校验', () => {
  test('拒绝没有 name', () => {
    assert.throws(
      () => definePlugin({ name: '', rules: [{ command: 'x', handler: () => undefined }] }),
      /缺少 name/,
    );
  });

  test('拒绝非法 name', () => {
    assert.throws(
      () => definePlugin({ name: '有中文', rules: [{ command: 'x', handler: () => undefined }] }),
      /不合法/,
    );
  });

  test('拒绝空 rules', () => {
    assert.throws(() => definePlugin({ name: 'x', rules: [] }), /至少要有一条 rule/);
  });

  test('拒绝缺少 handler', () => {
    assert.throws(
      () =>
        definePlugin({
          name: 'x',
          rules: [{ command: 'x' } as unknown as { command: string; handler: () => void }],
        }),
      /缺少 handler/,
    );
  });

  test('拒绝没有匹配方式', () => {
    assert.throws(
      () => definePlugin({ name: 'x', rules: [{ handler: () => undefined }] }),
      /需要 command/,
    );
  });

  test('拒绝多种匹配方式', () => {
    assert.throws(
      () =>
        definePlugin({
          name: 'x',
          rules: [{ command: 'a', prefix: 'b', handler: () => undefined }],
        }),
      /只能指定一种/,
    );
  });

  test('拒绝非法正则', () => {
    assert.throws(
      () => definePlugin({ name: 'x', rules: [{ regex: '[unclosed', handler: () => undefined }] }),
      /正则不合法/,
    );
  });

  test('拒绝非法权限与范围', () => {
    assert.throws(
      () =>
        definePlugin({
          name: 'x',
          // biome-ignore lint/suspicious/noExplicitAny: 故意传非法值
          rules: [{ command: 'a', permission: 'nope' as any, handler: () => undefined }],
        }),
      /permission/,
    );
    assert.throws(
      () =>
        definePlugin({
          name: 'x',
          // biome-ignore lint/suspicious/noExplicitAny: 故意传非法值
          rules: [{ command: 'a', scope: 'nope' as any, handler: () => undefined }],
        }),
      /scope/,
    );
  });

  test('normalizePlugin 补齐默认值', () => {
    const plugin = normalizePlugin(
      definePlugin({ name: 'x', rules: [{ command: 'a', handler: () => undefined }] }),
    );
    assert.equal(plugin.priority, 5000);
    assert.equal(plugin.rules[0]?.permission, 'all');
    assert.equal(plugin.rules[0]?.scope, 'any');
    assert.equal(plugin.rules[0]?.log, true);
  });
});
