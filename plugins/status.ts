/**
 * 状态查询插件。
 *
 * | 命令 | 作用 |
 * |------|------|
 * | `as` | 简要状态 |
 * | `as 详细` / `as detail` | 详细信息 |
 * | `as 帮助` / `as help` | 命令列表 |
 *
 * 命令词独立成词，因此 `asd`、`asdf` 不会误触发。
 */

import { definePlugin, type PluginContext } from 'aster-bot';

/** 简要状态 */
function brief(ctx: PluginContext): string {
  const status = ctx.status();
  const online = ctx.bots.filter((bot) => bot.online).length;

  const lines = [
    '【Aster 运行状态】',
    `版本：v${status.version}`,
    `运行：${status.uptimeText}`,
    `在线账号：${online} 个`,
    `已处理事件：${status.events} 条`,
    `插件：${status.plugins} 个（${status.commands} 次命中）`,
  ];
  return lines.join('\n');
}

/** 详细状态 */
function detailed(ctx: PluginContext): string {
  const status = ctx.status();
  const address = ctx.address;

  const lines = [
    '【Aster 详细状态】',
    '── 基本信息 ──',
    `版本：v${status.version}`,
    `启动：${status.startedAt}`,
    `运行：${status.uptimeText}`,
    '',
    '── 事件统计 ──',
    `总计：${status.events}`,
    `消息：${status.messages}`,
    `通知：${status.notices}`,
    `请求：${status.requests}`,
    `元事件：${status.metaEvents}`,
    `命令命中：${status.commands}`,
    '',
    '── 账号 ──',
  ];

  if (ctx.bots.length === 0) {
    lines.push('暂无账号连接');
  } else {
    for (const bot of ctx.bots) {
      const mark = bot.online ? '在线' : '离线';
      lines.push(`· ${bot.nickname ?? '未命名'}（${bot.uin}）${mark}`);
    }
  }

  lines.push('', '── 环境 ──');
  lines.push(`插件：${status.plugins} 个`);
  lines.push(`监听：${address ? address.url : '未启动'}`);

  return lines.join('\n');
}

const HELP = [
  '【Aster 状态命令】',
  'as        查看运行状态',
  'as 详细   查看详细信息',
  'as 帮助   显示本帮助',
].join('\n');

export default definePlugin({
  name: 'status',
  desc: '查询 Aster 运行状态',
  author: 'aster',
  priority: 100,
  rules: [
    {
      name: '运行状态',
      command: 'as',
      permission: 'all',
      scope: 'any',
      async handler(ctx) {
        const args = ctx.args;

        if (/^(帮助|help)/i.test(args)) {
          await ctx.reply(HELP);
          return;
        }
        if (args.includes('详细') || args.includes('detail')) {
          await ctx.reply(detailed(ctx));
          return;
        }

        await ctx.reply(brief(ctx));
      },
    },
  ],
});
