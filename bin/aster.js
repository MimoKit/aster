#!/usr/bin/env node
/**
 * aster 命令行入口。
 *
 * 优先加载构建产物（dist），开发场景下回落到 TS 源码
 * （Node 22+ 原生支持直接运行 TypeScript）。
 */

const entry = await import('../dist/cli.js').catch(() => import('../src/cli.ts'));

const code = await entry.main();
process.exitCode = code;
