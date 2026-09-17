# 插件开发

插件是放在数据目录 `plugins/` 下的 TypeScript 文件，保存后自动加载。

```text
my-bot/
├── config.toml
└── plugins/
    ├── hello.ts
    └── weather/index.ts    # 也可以一个插件一个目录
```

文件名以 `_` 或 `.` 开头会被跳过，用来临时禁用插件。

## 最小插件

```ts
import { definePlugin } from 'aster-bot';

export default definePlugin({
  name: 'hello',
  desc: '打个招呼',
  rules: [
    {
      name: '打招呼',
      command: 'hi',
      async handler(ctx) {
        return ctx.reply(`你好，${ctx.displayName}`);
      },
    },
  ],
});
```

## 元信息

```ts
export default definePlugin({
  name: 'weather',     // 必填，唯一。只允许字母数字与 - _
  desc: '查天气',       // 选填
  author: '你的名字',   // 选填
  priority: 100,       // 选填，默认 5000，越小越先执行
  rules: [],
});
```

`priority` 决定多个插件都要处理同一条消息时谁先来。内置的 status 是 100，echo 是 200。

## 匹配规则

一条规则只能指定一种匹配方式。

| 写法 | 说明 |
|---|---|
| `command: 'as'` | 命令词独立成词。命中 `as`、`as 详细`，不命中 `asd` |
| `prefix: '#as'` | 以此为开头 |
| `exact: '状态'` | 完全相等 |
| `contains: '状态'` | 包含子串 |
| `regex: /^echo\s+(.+)$/` | 正则 |
| `any: true` | 任意消息 |

一般用 `command`，它按词边界匹配，不会有 `asd` 触发 `as` 的问题。

参数从命令词后面截取并去掉首尾空格：

| 消息 | `ctx.args` |
|---|---|
| `as` | `''` |
| `as 详细` | `'详细'` |
| `[CQ:at,qq=机器人] as 详细` | `'详细'` |

消息开头的 `@机器人` 会自动去掉，所以 `@bot as` 和 `as` 等价。

正则的捕获组放在 `ctx.matches`，`[0]` 是整体匹配：

```ts
{
  regex: /^点歌\s+(.+?)(?:\s+by\s+(.+))?$/,
  async handler(ctx) {
    const [, name, singer] = ctx.matches;
    return ctx.reply(singer ? `${singer} 的《${name}》` : `《${name}》`);
  },
}
```

## 上下文

事件与身份：

```ts
ctx.event        // 完整的归一化事件
ctx.text         // 可读文本，图片等会变成 [图片]
ctx.args         // 命令参数
ctx.matches      // 正则捕获组
ctx.isGroup      // 是否群聊
ctx.isPrivate    // 是否私聊
ctx.groupId      // 群号，私聊为 null
ctx.userId       // 发送者账号
ctx.selfId       // 机器人账号
ctx.sessionId    // 群聊是群号，私聊是账号
ctx.displayName  // 优先群名片，其次昵称
ctx.bot          // 触发事件的账号
ctx.plugin       // 当前插件名
ctx.rule         // 当前规则名
```

回复：

```ts
await ctx.reply('普通回复');
await ctx.replyAt('会 @ 发送者');
await ctx.replyQuote('会引用原消息');
```

三个方法的参数都接受字符串、消息段数组、单个消息段：

```ts
ctx.reply('文本');
ctx.reply([seg.at(ctx.userId), seg.text(' 你好')]);
ctx.reply(seg.image('https://example.com/a.jpg'));
```

消息段构造器：

```ts
import { seg } from 'aster-bot';

seg.text('文本')
seg.at('123456')          // @ 某人
seg.atAll()               // @ 全体
seg.image('https://...')  // 也接受 base64:// 与本地路径
seg.record('https://...')
seg.video('https://...')
seg.file('路径', '显示名')
seg.face('1')             // QQ 表情
seg.reply('消息ID')
seg.json('{"app":"..."}')
seg.poke('123456')
seg.node([...], { nickname: '小明' })   // 合并转发节点
```

调用任意 API：

```ts
await ctx.call('set_group_ban', {
  group_id: ctx.groupId,
  user_id: ctx.userId,
  duration: 600,
});
```

可用的 action 取决于协议端，列表见 [OneBot v11 API](https://github.com/botuniverse/onebot-11/blob/master/api/README.md)。
常用的几个 `ctx.bot` 上有封装：

```ts
ctx.bot.sendGroupMsg(groupId, '内容')
ctx.bot.sendPrivateMsg(userId, '内容')
ctx.bot.deleteMsg(messageId)
ctx.bot.setGroupBan(groupId, userId, 600)
ctx.bot.setFriendAddRequest(flag, true)
ctx.bot.setGroupAddRequest(flag, 'invite', true)
```

日志与状态：

```ts
ctx.log('普通信息');
ctx.log('出问题了', 'warn');   // trace | debug | info | warn | error
```

日志进终端，也进 WebUI 的日志页，带插件名前缀。

```ts
const s = ctx.status();
s.uptimeText;   // "1小时2分3秒"
s.events;       // 已处理事件数
ctx.bots;       // 所有账号（含离线）
ctx.address;    // 适配器监听地址
ctx.version;    // 框架版本
```

## 权限与范围

```ts
{
  command: 'ban',
  permission: 'admin',   // all | master | admin | owner
  scope: 'group',        // any | group | private
  async handler(ctx) {},
}
```

| `permission` | 谁能触发 |
|---|---|
| `all`（默认） | 所有人 |
| `master` | `bot.masters` 里配的主人 |
| `admin` | 主人，或群管理员、群主 |
| `owner` | 主人，或群主 |

主人始终绕过权限检查。权限不足时插件不执行，但会记一条日志。

## 控制流

返回值决定要不要继续：

| 返回值 | 行为 |
|---|---|
| `false` | 视为未处理，继续尝试后面的规则与插件 |
| 其它（含 `undefined`） | 视为已处理，停止 |

```ts
async handler(ctx) {
  if (ctx.args !== '详细') return false;   // 放行
  await ctx.reply('详细信息...');           // 没 return，停止
}
```

处理函数抛错不会中断其他插件，错误记进日志后继续尝试后面的规则。

## 完整例子

```ts
import { definePlugin, seg } from 'aster-bot';

const counters = new Map<string, number>();

export default definePlugin({
  name: 'counter',
  desc: '群消息计数器',
  priority: 1000,
  rules: [
    {
      name: '计数',
      command: 'count',
      scope: 'group',
      async handler(ctx) {
        const groupId = ctx.groupId as string;

        if (ctx.args === '重置') {
          counters.set(groupId, 0);
          return ctx.reply('已归零');
        }

        const next = (counters.get(groupId) ?? 0) + 1;
        counters.set(groupId, next);
        return ctx.reply([seg.at(ctx.userId), seg.text(` 本群已计数 ${next} 次`)]);
      },
    },
    {
      name: '排行',
      command: 'top',
      permission: 'admin',
      scope: 'group',
      async handler(ctx) {
        const entries = [...counters.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
        if (entries.length === 0) return ctx.reply('还没有数据');
        return ctx.reply(entries.map(([id, n], i) => `${i + 1}. ${id} — ${n}`).join('\n'));
      },
    },
  ],
});
```

## 调试

列出已加载插件与加载失败原因：

```bash
aster plugin
```

```text
已加载 2 个插件、2 条规则

  status 优先级 100 — 查询 Aster 运行状态
    · 运行状态         命令 as                all / any

1 个插件加载失败：
  ✗ /home/me/my-bot/plugins/bad.ts
    语法错误：Unexpected token
```

命令没反应时按顺序查：

1. `command` 是词边界匹配，`asd` 不会触发 `as`
2. 权限不足 —— 日志里会写「权限不足（需要 admin）」
3. `scope` 不匹配 —— `scope: 'group'` 在私聊里不触发
4. 优先级更高的插件返回了非 `false`，流程提前停止
5. 调 `log.level = "debug"` 看匹配过程

插件里要用 npm 包，在数据目录 `npm install <包名>` 即可，模块解析和普通 Node 项目一样。
`.js`、`.mjs`、`.ts`、`.mts` 都能加载。

## 类型提示

类型随包发布，`import` 后编辑器自动补全：

```ts
import type { PluginContext } from 'aster-bot';

async function handle(ctx: PluginContext) {
  return ctx.reply('hi');
}
```

框架加载插件时会把 `aster-bot` 映射到自身，运行不受影响。若编辑器找不到类型，
在数据目录执行 `npm link aster-bot` 即可。
