# 插件开发

插件是普通的 TypeScript 模块，放在数据目录的 `plugins/` 下即可被加载。

```text
my-bot/
├── config.toml
└── plugins/
    ├── hello.ts      ← 写在这里
    └── weather/
        └── index.ts  ← 也可以一个插件一个目录
```

> [!NOTE]
> 文件名以 `_` 或 `.` 开头会被跳过（当作草稿），方便你临时禁用某个插件。

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
        return ctx.reply(`你好，${ctx.displayName}！`);
      },
    },
  ],
});
```

存盘后终端会打印重载日志，**不需要重启**：

```text
2026-09-17 15:21:03.412 INFO  [plugin] 插件已重载：2 → 3 个，共 3 条规则
```

## 元信息

```ts
export default definePlugin({
  name: 'weather',        // 必填，唯一。只允许字母数字与 - _
  desc: '查天气',          // 选填，显示在 WebUI 插件页
  author: '你的名字',      // 选填
  priority: 100,          // 选填，默认 5000。越小越先执行
  rules: [ /* ... */ ],
});
```

`priority` 决定**多个插件都想处理同一条消息**时谁先来。内置的 `status` 是 100、`echo` 是 200，想插到它们前面就写个更小的值。

## 匹配规则

一条规则必须指定**且只能指定一种**匹配方式。

| 写法 | 说明 | 例子 |
|------|------|------|
| `command: 'as'` | 命令词独立成词 | 命中 `as`、`as 详细`；不命中 `asd`、`xas` |
| `prefix: '#as'` | 以此为开头 | 命中 `#as`、`#asd` |
| `exact: '状态'` | 完全相等 | 只命中 `状态` |
| `contains: '状态'` | 包含子串 | 命中 `看看状态如何` |
| `regex: /^echo\s+(.+)$/` | 正则 | 捕获组会作为 `ctx.matches` |
| `any: true` | 任意消息 | 通常配合权限或范围收窄 |

**`command` 是绝大多数场景该用的**，因为它按词边界匹配，不会出现 `asd` 误触发 `as` 这种问题。

<details>
<summary><b>关于 <code>ctx.args</code></b></summary>

参数会自动从命令词后面截取并 `trim()`：

| 收到的消息 | 命中 | `ctx.args` |
|-----------|------|-----------|
| `as` | ✅ | `''` |
| `as 详细` | ✅ | `'详细'` |
| `echo 你好 世界` | ✅ | `'你好 世界'` |
| `[CQ:at,qq=机器人] as 详细` | ✅ | `'详细'` |

消息开头的 `@机器人` 会被自动去掉，所以 `@bot as` 和 `as` 等价。

</details>

<details>
<summary><b>正则的捕获组</b></summary>

```ts
{
  name: '点歌',
  regex: /^点歌\s+(.+?)(?:\s+by\s+(.+))?$/,
  async handler(ctx) {
    const [, 歌名, 歌手] = ctx.matches;
    return ctx.reply(歌手 ? `想听 ${歌手} 的《${歌名}》` : `想听《${歌名}》`);
  },
}
```

`ctx.matches[0]` 是整体匹配，之后依次是捕获组。

</details>

## 上下文 API

`ctx` 是处理函数的唯一入口。

### 事件与身份

```ts
ctx.event        // 完整的归一化事件对象
ctx.text         // 可读文本（图片等变成 [图片]）
ctx.args         // 命令参数
ctx.matches      // 正则捕获组，非正则匹配时是 [全文]
ctx.isGroup      // 是否群聊
ctx.isPrivate    // 是否私聊
ctx.groupId      // 群号，私聊为 null
ctx.userId       // 发送者账号
ctx.selfId       // 机器人账号
ctx.sessionId    // 群聊是群号，私聊是账号
ctx.displayName  // 优先群名片，其次昵称
ctx.bot          // 触发事件的账号句柄
ctx.plugin       // 当前插件名
ctx.rule         // 当前规则名
```

### 回复

```ts
await ctx.reply('普通回复');
await ctx.replyAt('会先 @ 一下发送者');
await ctx.replyQuote('会引用原消息');
```

三个方法的参数都接受三种形态：

```ts
ctx.reply('字符串');                                  // 纯文本
ctx.reply([seg.at(ctx.userId), seg.text(' 你好')]);   // 消息段数组
ctx.reply(seg.image('https://example.com/a.jpg'));    // 单个消息段
```

### 消息段构造器

```ts
import { seg } from 'aster-bot';

seg.text('文本')
seg.at('123456')              // @ 某人
seg.atAll()                   // @ 全体成员
seg.image('https://...')      // 图片，也接受 base64:// 与本地路径
seg.record('https://...')     // 语音
seg.video('https://...')      // 视频
seg.file('路径', '显示名')      // 文件
seg.face('1')                 // QQ 表情
seg.reply('消息ID')            // 引用
seg.json('{"app":"..."}')     // 卡片消息
seg.poke('123456')            // 戳一戳
seg.node([...], { nickname: '小明' })  // 合并转发节点
```

### 调用任意 API

```ts
await ctx.call('set_group_ban', {
  group_id: ctx.groupId,
  user_id: ctx.userId,
  duration: 600,
});
```

可用的 action 取决于协议端实现，参见 [OneBot v11 API 列表](https://github.com/botuniverse/onebot-11/blob/master/api/README.md)。

常用的几个 `ctx.bot` 上已有封装：

```ts
await ctx.bot.sendGroupMsg(groupId, '内容');
await ctx.bot.sendPrivateMsg(userId, '内容');
await ctx.bot.deleteMsg(messageId);
await ctx.bot.setGroupBan(groupId, userId, 600);
await ctx.bot.setFriendAddRequest(flag, true);
await ctx.bot.setGroupAddRequest(flag, 'invite', true);
```

### 日志与状态

```ts
ctx.log('普通信息');
ctx.log('出问题了', 'warn');     // trace | debug | info | warn | error
```

日志会带上插件名前缀，同时进入 WebUI 的日志页：

```text
2026-09-17 15:24:11.008 WARN  [plugin] [myplugin] 出问题了
```

```ts
const status = ctx.status();
status.uptimeText;   // "1小时2分3秒"
status.events;       // 已处理事件数
ctx.bots;            // 所有账号（含离线）
ctx.address;         // 适配器监听地址
ctx.version;         // 框架版本
```

## 权限与范围

```ts
{
  name: '禁言',
  command: 'ban',
  permission: 'admin',   // all | master | admin | owner
  scope: 'group',        // any | group | private
  async handler(ctx) { /* ... */ },
}
```

| `permission` | 谁能触发 |
|--------------|---------|
| `all`（默认） | 所有人 |
| `master` | `bot.masters` 里配置的主人账号 |
| `admin` | 主人，或群管理员、群主 |
| `owner` | 主人，或群主 |

> [!IMPORTANT]
> **主人始终绕过权限检查**。权限不足时插件不会执行，但会在日志里记录一次，
> 方便排查「为什么我的命令没反应」。

## 控制流

处理函数的返回值决定要不要继续：

```ts
async handler(ctx) {
  if (ctx.args !== '详细') return false;   // 放行，交给后面的规则
  await ctx.reply('详细信息...');
  // 没有 return，或返回其它值 → 已处理，停止后续规则
}
```

| 返回值 | 行为 |
|--------|------|
| `false` | 视为未处理，继续尝试后续规则与插件 |
| 其它任意值（含 `undefined`） | 视为已处理，**停止** |

**处理函数抛错不会中断其他插件**，错误会记进日志，然后继续尝试后面的规则。

## 一个完整的例子

```ts
import { definePlugin, seg } from 'aster-bot';

/** 内存里的计数器，进程重启后归零 */
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

        return ctx.reply([
          seg.at(ctx.userId),
          seg.text(` 本群已计数 ${next} 次`),
        ]);
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
        return ctx.reply(
          entries.map(([id, count], i) => `${i + 1}. ${id} — ${count}`).join('\n'),
        );
      },
    },
  ],
});
```

## 调试技巧

<details>
<summary><b>插件没被加载</b></summary>

打开 `log.level = "debug"`，或者直接用命令查看加载结果：

```bash
aster plugin
```

会列出所有已加载插件、规则，以及**加载失败的文件与原因**：

```text
已加载 2 个插件、2 条规则

  status 优先级 100 — 查询 Aster 运行状态
    · 运行状态         命令 as                all / any

1 个插件加载失败：
  ✗ /home/me/my-bot/plugins/bad.ts
    语法错误：Unexpected token
```

</details>

<details>
<summary><b>命令没反应</b></summary>

按顺序排查：

1. **命令词独立成词** —— `asd` 不会触发 `as`，这是设计如此
2. **权限不足** —— 日志里会写「权限不足（需要 admin）」，或者把 `permission` 临时改成 `all` 验证
3. **范围不匹配** —— `scope: 'group'` 的规则在私聊里不触发
4. **前面的插件吃掉了** —— 优先级更高（数字更小）的插件返回了非 `false`，流程就停了
5. **看不到日志** —— 默认级别是 `info`，调到 `debug` 能看到匹配过程

</details>

<details>
<summary><b>想临时禁用一个插件</b></summary>

把文件名前面加下划线：`hello.ts` → `_hello.ts`，重载后就不会被加载。

</details>

<details>
<summary><b>插件里能用 npm 包吗</b></summary>

可以。在数据目录执行 `npm install <包名>` 即可 —— 插件由 jiti 加载，
模块解析和普通 Node 项目一致。

</details>

<details>
<summary><b>能用 .js 写吗</b></summary>

可以。`.js`、`.mjs`、`.ts`、`.mts` 都会被加载。

</details>

## 类型提示

本包自带类型声明，插件里 `import` 后自动获得补全：

```ts
import type { PluginContext, PluginRule } from 'aster-bot';

// 想单独给处理函数写类型
async function handle(ctx: PluginContext) {
  return ctx.reply('hi');
}
```

如果编辑器找不到类型，确认：

```bash
npm install -g aster-bot     # 类型随包发布
```

在插件目录里也需要能解析到 `aster-bot`。全局安装时可以在数据目录建个软链：

```bash
cd ~/my-bot && npm link aster-bot
```

> [!TIP]
> 框架在加载插件时会把 `aster-bot` 映射到自身，因此**插件运行不受影响**；
> 上面的软链只是为了让编辑器的类型提示正常工作。
