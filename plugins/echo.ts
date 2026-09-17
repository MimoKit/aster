/**
 * 示例插件：复读机。
 *
 * 用来演示插件 API 的主要能力，也是新人上手的第一个参照：
 *
 * | 命令 | 演示的能力 |
 * |------|-----------|
 * | `echo <内容>` | 回复文本、读取 `ctx.args` |
 * | `echo 我的名片` | 读取发送者与会话信息 |
 * | `echo 图片` | 构造并发送消息段 |
 * | `echo 撤回` | 调用任意 OneBot API |
 *
 * 命令词独立成词，`echofoo` 不会触发。
 */

import { definePlugin, type Segment, seg } from 'aster-bot';

export default definePlugin({
  name: 'echo',
  desc: '复读机：把收到的内容原样发回',
  author: 'aster',
  priority: 200,
  rules: [
    {
      name: '复读',
      command: 'echo',
      permission: 'all',
      scope: 'any',
      async handler(ctx) {
        const args = ctx.args.trim();

        if (args.length === 0) {
          await ctx.reply(
            [
              '用法：',
              '  echo <内容>    原样发回',
              '  echo 我的名片  查看发送者信息',
              '  echo 图片      发送一条带图片的消息段',
            ].join('\n'),
          );
          return;
        }

        // 演示：读取事件与发送者信息
        if (args === '我的名片') {
          const session = ctx.isGroup ? `群聊 ${ctx.groupId}` : '私聊';
          await ctx.reply(
            [
              `昵称：${ctx.displayName}`,
              `账号：${ctx.userId}`,
              `会话：${session}`,
              `身份：${ctx.event.sender.role ?? '未知'}`,
            ].join('\n'),
          );
          return;
        }

        // 演示：构造消息段发送
        if (args === '图片') {
          const content: Segment[] = [
            seg.text('这是一条带消息段的消息\n'),
            seg.at(ctx.userId),
            seg.text(' 收好'),
          ];
          await ctx.reply(content);
          return;
        }

        // 演示：调用任意 OneBot API（撤回自己刚发的消息）
        if (args === '撤回') {
          try {
            const sent = (await ctx.reply('这条消息马上会被撤回')) as { message_id?: string };
            const messageId = sent?.message_id;
            if (messageId === undefined) {
              await ctx.reply('未能取到 message_id，当前协议端可能不支持撤回');
              return;
            }
            // 等一秒再撤，让用户看得见
            await new Promise((resolve) => setTimeout(resolve, 1000));
            await ctx.call('delete_msg', { message_id: String(messageId) });
          } catch (err) {
            ctx.log(`撤回失败：${(err as Error).message}`, 'warn');
          }
          return;
        }

        await ctx.reply(args);
      },
    },
  ],
});
