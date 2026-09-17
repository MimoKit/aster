/**
 * 端到端测试：真实 WebSocket 连接 → 事件归一化 → 插件分发 → API 回复。
 *
 * 不 mock 任何内部模块，起真实的 HTTP/WS 服务，用 `ws` 客户端扮演协议端。
 * 每个用例都通过 {@link withApp} 包裹，失败也保证服务被关掉。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { WebSocket } from 'ws';

import { App, type StartResult } from './app.ts';
import { type AsterConfig, defaultConfig } from './config.ts';

let dataDir: string;

before(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'aster-e2e-'));
});

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/** 测试配置：端口交给系统分配，关掉 WebUI 与热重载 */
function testConfig(patch: (config: AsterConfig) => void = () => undefined): AsterConfig {
  const config = defaultConfig();
  config.onebot11.port = 0;
  config.webui.enable = false;
  config.log.level = 'silent';
  config.log.color = false;
  config.plugin.hotReload = false;
  patch(config);
  return config;
}

/**
 * 起一个应用，跑完用例后无论成败都关闭。
 *
 * 服务不关会让测试进程挂住（事件循环还有句柄），所以必须 finally。
 */
async function withApp(
  config: AsterConfig,
  fn: (app: App, onebotUrl: string) => Promise<void>,
): Promise<void> {
  const app = await App.create({ dataDir, config });
  try {
    const started: StartResult = await app.start();
    const { onebot } = started;
    // 断言在这里做一次，用例里就不用到处写非空断言
    assert.ok(onebot, '适配器应已启动');
    await fn(app, onebot.url);
  } finally {
    await app.stop();
  }
}

/** 等待某一帧满足条件 */
function waitForFrame(
  ws: WebSocket,
  predicate: (frame: Record<string, unknown>) => boolean,
  timeout = 3000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('等待帧超时'));
    }, timeout);

    const onMessage = (data: unknown): void => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!predicate(frame)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(frame);
    };

    ws.on('message', onMessage);
  });
}

/** 收集一段时间内出现的发送请求 */
function collectSends(ws: WebSocket): () => Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = [];
  ws.on('message', (data: unknown) => {
    try {
      const frame = JSON.parse(String(data)) as Record<string, unknown>;
      if (typeof frame.action === 'string' && String(frame.action).startsWith('send_')) {
        frames.push(frame);
      }
    } catch {
      /* 忽略非 JSON */
    }
  });
  return () => frames;
}

/** 连接协议端并上报 lifecycle */
async function connectAdapter(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  ws.send(
    JSON.stringify({
      time: Math.floor(Date.now() / 1000),
      self_id: 10001,
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
      sub_type: 'connect',
    }),
  );

  // 框架会主动拉登录信息，回一个响应
  void waitForFrame(ws, (frame) => frame.action === 'get_login_info')
    .then((frame) => {
      ws.send(
        JSON.stringify({
          status: 'ok',
          retcode: 0,
          data: { user_id: 10001, nickname: '测试Bot' },
          echo: frame.echo,
        }),
      );
    })
    .catch(() => {
      /* 测试可能已经结束 */
    });

  await sleep(200);
  return ws;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 构造一条群消息 */
function groupMessage(text: string, id = 1): string {
  return JSON.stringify({
    time: Math.floor(Date.now() / 1000),
    self_id: 10001,
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: id,
    user_id: 20002,
    group_id: 30003,
    raw_message: text,
    message: text,
    sender: { user_id: 20002, nickname: '小明', role: 'member' },
  });
}

describe('端到端', () => {
  test('内置 status 插件响应 as 命令', async () => {
    await withApp(testConfig(), async (app, onebotUrl) => {
      const ws = await connectAdapter(onebotUrl);
      try {
        assert.ok(app.server.registry.first(), '账号应已登记');

        const reply = waitForFrame(ws, (frame) => frame.action === 'send_group_msg');
        ws.send(groupMessage('as'));

        const frame = await reply;
        const params = frame.params as Record<string, unknown>;
        assert.equal(params.group_id, '30003', '应回复到原群');

        const message = String(params.message);
        assert.ok(message.includes('Aster 运行状态'), `应含状态标题，实际：${message}`);
        assert.ok(message.includes('版本'), `应含版本，实际：${message}`);
      } finally {
        ws.close();
      }
    });
  });

  test('as 详细 返回更多信息', async () => {
    await withApp(testConfig(), async (_app, onebotUrl) => {
      const ws = await connectAdapter(onebotUrl);
      try {
        const reply = waitForFrame(ws, (frame) => frame.action === 'send_group_msg');
        ws.send(groupMessage('as 详细'));

        const frame = await reply;
        const text = String((frame.params as Record<string, unknown>).message);
        assert.ok(text.includes('详细状态'), `应返回详细状态，实际：${text}`);
        assert.ok(text.includes('事件统计'), `应含事件统计，实际：${text}`);
      } finally {
        ws.close();
      }
    });
  });

  test('as 帮助 列出命令', async () => {
    await withApp(testConfig(), async (_app, onebotUrl) => {
      const ws = await connectAdapter(onebotUrl);
      try {
        const reply = waitForFrame(ws, (frame) => frame.action === 'send_group_msg');
        ws.send(groupMessage('as 帮助'));

        const text = String((await reply).params.message ?? '');
        assert.ok(text.includes('as'), `应列出命令，实际：${text}`);
      } finally {
        ws.close();
      }
    });
  });

  test('echo 插件复读参数', async () => {
    await withApp(testConfig(), async (_app, onebotUrl) => {
      const ws = await connectAdapter(onebotUrl);
      try {
        const reply = waitForFrame(ws, (frame) => frame.action === 'send_group_msg');
        ws.send(groupMessage('echo 你好世界'));

        const text = String((await reply).params.message ?? '');
        assert.equal(text, '你好世界');
      } finally {
        ws.close();
      }
    });
  });

  test('echo 我的名片 读取发送者信息', async () => {
    await withApp(testConfig(), async (_app, onebotUrl) => {
      const ws = await connectAdapter(onebotUrl);
      try {
        const reply = waitForFrame(ws, (frame) => frame.action === 'send_group_msg');
        ws.send(groupMessage('echo 我的名片'));

        const text = String((await reply).params.message ?? '');
        assert.ok(text.includes('小明'), `应含昵称，实际：${text}`);
        assert.ok(text.includes('20002'), `应含账号，实际：${text}`);
      } finally {
        ws.close();
      }
    });
  });

  test('非命令消息不产生回复', async () => {
    await withApp(testConfig(), async (_app, onebotUrl) => {
      const ws = await connectAdapter(onebotUrl);
      try {
        const sends = collectSends(ws);
        ws.send(groupMessage('这是一句普通聊天'));
        await sleep(400);
        assert.equal(sends().length, 0, '普通消息不应有回复');
      } finally {
        ws.close();
      }
    });
  });

  test('命令词独立成词：asd / xas 不触发', async () => {
    await withApp(testConfig(), async (_app, onebotUrl) => {
      const ws = await connectAdapter(onebotUrl);
      try {
        const sends = collectSends(ws);
        for (const [index, text] of ['asd', 'asdf 详细', 'xas'].entries()) {
          ws.send(groupMessage(text, 10 + index));
        }
        await sleep(400);
        assert.equal(sends().length, 0, '这些输入都不应触发命令');
      } finally {
        ws.close();
      }
    });
  });

  test('@机器人后跟命令同样触发', async () => {
    await withApp(testConfig(), async (_app, onebotUrl) => {
      const ws = await connectAdapter(onebotUrl);
      try {
        const reply = waitForFrame(ws, (frame) => frame.action === 'send_group_msg');
        ws.send(groupMessage('[CQ:at,qq=10001] as'));

        const text = String((await reply).params.message ?? '');
        assert.ok(text.includes('Aster 运行状态'), `@ 之后应仍能触发，实际：${text}`);
      } finally {
        ws.close();
      }
    });
  });

  test('统计随事件累加', async () => {
    await withApp(testConfig(), async (app, onebotUrl) => {
      const ws = await connectAdapter(onebotUrl);
      try {
        const before = app.stats.snapshot(app.version);
        ws.send(groupMessage('随便说点什么'));
        await sleep(300);

        const after = app.stats.snapshot(app.version);
        assert.equal(after.messages, before.messages + 1, '消息计数应 +1');
      } finally {
        ws.close();
      }
    });
  });

  test('鉴权：token 缺失被拒、正确则放行', async () => {
    await withApp(
      testConfig((config) => {
        config.onebot11.accessToken = 'secret';
      }),
      async (_app, onebotUrl) => {
        const url = onebotUrl;

        const noToken = new WebSocket(url);
        const rejected = await new Promise<boolean>((resolve) => {
          noToken.once('error', () => resolve(true));
          noToken.once('open', () => resolve(false));
          setTimeout(() => resolve(false), 1500);
        });
        assert.equal(rejected, true, '缺少 token 应被拒绝');

        const withToken = new WebSocket(`${url}?access_token=secret`);
        const accepted = await new Promise<boolean>((resolve) => {
          withToken.once('open', () => resolve(true));
          withToken.once('error', () => resolve(false));
          setTimeout(() => resolve(false), 1500);
        });
        assert.equal(accepted, true, '正确 token 应被接受');
        withToken.close();
      },
    );
  });

  test('路径不匹配被拒绝', async () => {
    await withApp(testConfig(), async (_app, onebotUrl) => {
      const wrong = onebotUrl.replace('/onebot/v11/ws', '/wrong');
      const ws = new WebSocket(wrong);
      const rejected = await new Promise<boolean>((resolve) => {
        ws.once('error', () => resolve(true));
        ws.once('open', () => resolve(false));
        setTimeout(() => resolve(false), 1500);
      });
      assert.equal(rejected, true, '错误路径应被拒绝');
    });
  });

  test('断开后离线，重连后恢复', async () => {
    await withApp(testConfig(), async (app, onebotUrl) => {
      const ws1 = await connectAdapter(onebotUrl);
      assert.equal(app.server.registry.get('10001')?.online, true);

      ws1.close();
      await sleep(400);
      assert.equal(app.server.registry.get('10001')?.online, false, '断开后应离线');

      // 重连后句柄仍可用，call 会走新连接
      const ws2 = await connectAdapter(onebotUrl);
      try {
        assert.equal(app.server.registry.get('10001')?.online, true, '重连后应恢复在线');

        const reply = waitForFrame(ws2, (frame) => frame.action === 'send_group_msg');
        ws2.send(groupMessage('as'));
        assert.ok(await reply, '重连后应仍能正常回复');
      } finally {
        ws2.close();
      }
    });
  });
});
