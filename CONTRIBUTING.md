# 贡献指南

欢迎提 issue 和 PR。这份文档说明本地怎么跑起来、以及提交时的一些约定。

## 环境

- **Node.js 20.11+**（开发用 22 或更高更省事，原生支持直接运行 TypeScript）
- npm（仓库只支持 npm，不混用 pnpm/yarn，避免 lockfile 冲突）

```bash
git clone https://github.com/MimoKit/aster.git
cd aster
npm install
```

## 常用命令

```bash
# 直接跑（Node 原生执行 TS，改完就能跑，不需要构建）
npm start

# 测试
npm test
npm run test:watch

# 类型检查 / 规范 / 格式化
npm run typecheck
npm run lint
npm run lint:fix
npm run format

# 构建产物（发布用）
npm run build

# 前端
npm --prefix webui install
npm --prefix webui run dev     # 开发模式，API 自动代理到 5311
npm --prefix webui run build
```

> 开发期不需要 `npm run build`。Node 22+ 能直接执行 `.ts`，
> 插件也由 jiti 在运行时加载，改完存盘即生效。

## 代码约定

**格式与规范由 Biome 管**，不用手动纠结：

```bash
npm run lint:fix
```

**类型**：`strict` 全开，包括 `noUncheckedIndexedAccess`。数组下标访问要先判空。

**注释写「为什么」，不写「是什么」**：

```ts
// 好：解释了一个不明显的决策
// 端口配置为 0 时由系统分配，必须读回真实端口，否则对外给出的地址是错的
const bound = this.#server.address();

// 差：把代码翻译了一遍
// 获取服务器地址
const bound = this.#server.address();
```

**错误信息要能指导下一步**，不要只说失败了：

```ts
// 好
throw new Error(
  `监听 ${host}:${port} 失败：端口已被占用。\n` +
    `可能是另一个 Aster 还在跑，用 ss -ltnp | grep ${port} 查看。`,
);

// 差
throw new Error('listen failed');
```

**不要吞异常**。要么处理，要么往上抛，不要 `catch {}` 了事。

## 测试

用 Node 内置的测试运行器，不引入额外框架：

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('命令词独立成词', async () => {
  // ...
});
```

要求：

- **新功能必须有测试**。改了 `message.ts` / `event.ts` 这类纯逻辑，测试要覆盖边界（空输入、类型不符、超长内容）
- **修 bug 先写复现测试**，再改代码——不然以后会再犯
- 涉及网络与文件系统的测试，用 `finally` 保证清理，否则测试进程会挂住
- 端口一律用 `0` 让系统分配，不要写死

跑单个文件：

```bash
node --test src/message.test.ts
```

## 提交信息

用约定式前缀，一次提交只做一件事：

```text
feat: 插件支持热重载
fix: 端口被占用时静默挂起
docs: 补充 WebUI 部署说明
refactor: 抽出事件归一化
test: 补 CQ 码边界用例
chore: 升级 TypeScript 到 5.9
```

正文里说清**动机**和**影响面**，特别是破坏性变更。

## 目录约定

```text
src/           内核（TypeScript）
  message.ts     消息段与 CQ 码
  event.ts       事件归一化
  onebot11.ts    适配器
  plugin.ts      插件定义 API
  plugin-host.ts 加载与分发
  webui.ts       HTTP API
  app.ts         装配
plugins/       内置插件（同样是普通插件，不享受特殊待遇）
webui/         前端（React + Vite）
docs/          文档
```

**内置插件不要走特权路径**。它们应该只用公开 API，这样也能顺带验证 API 够不够用。

## 文档

行为变更要同步 `docs/`。文档里的代码示例会被读者直接抄，**确保示例能跑**。

## 提 PR 前

```bash
npm run typecheck && npm test && npm run lint
```

三条都过了再提。CI 会跑同样的检查。

## 行为准则

参与即表示同意 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。
