#!/usr/bin/env node
/**
 * 发布前校验（npm prepack 钩子）。
 *
 * 检查项：
 * 1. package.json 与 Cargo.toml 的版本号一致
 * 2. 必要文件都在（bin / lib / src / 默认配置 / Cargo.toml）
 * 3. Node 测试通过（可通过 SKIP_TESTS=1 跳过）
 *
 * 任一失败都以非零码退出，阻止发布。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const problems = [];

function fail(message) {
  problems.push(message);
}

function readJson(relative) {
  return JSON.parse(readFileSync(join(ROOT, relative), 'utf8'));
}

// 1. 版本号一致性
const pkg = readJson('package.json');
const cargoText = readFileSync(join(ROOT, 'Cargo.toml'), 'utf8');
const cargoVersion = cargoText.match(/^version\s*=\s*"([^"]+)"/m)?.[1];

if (!cargoVersion) {
  fail('无法从 Cargo.toml 解析版本号');
} else if (cargoVersion !== pkg.version) {
  fail(
    `版本号不一致：package.json=${pkg.version}，Cargo.toml=${cargoVersion}\n` +
      `  请同步后重试（或运行 npm version <x.y.z> 一并更新）`,
  );
}

// 2. 必要文件
const required = [
  'bin/aster.js',
  'lib/index.js',
  'lib/cli.js',
  'lib/config.js',
  'lib/paths.js',
  'lib/process.js',
  'src/main.rs',
  'src/lib.rs',
  'Cargo.toml',
  'config/default.toml',
  'README.md',
  'LICENSE',
];
for (const relative of required) {
  if (!existsSync(join(ROOT, relative))) fail(`缺少必要文件：${relative}`);
}

// 3. 测试
if (process.env.SKIP_TESTS !== '1') {
  try {
    execFileSync('node', ['--test', 'test/'], { cwd: ROOT, stdio: 'pipe' });
    process.stdout.write('✓ Node 测试通过\n');
  } catch (err) {
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    fail(`Node 测试未通过：\n${output.split('\n').slice(-20).join('\n')}`);
  }
}

if (problems.length) {
  process.stderr.write('\n发布前校验失败：\n');
  for (const problem of problems) process.stderr.write(`  ✗ ${problem}\n`);
  process.stderr.write('\n');
  process.exit(1);
}

process.stdout.write(`✓ 发布前校验通过（aster-bot@${pkg.version}）\n`);
