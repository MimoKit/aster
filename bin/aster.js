#!/usr/bin/env node
/**
 * aster 命令行入口。
 *
 * 这个文件保持极薄：只负责调用 lib/cli.js 并把退出码传给系统。
 */

import { main } from '../lib/cli.js';

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`错误：${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
