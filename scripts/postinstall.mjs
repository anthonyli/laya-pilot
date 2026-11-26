#!/usr/bin/env node
// Prepare the CLI runtime right after `npm install -g laya-pilot` or `npm link`,
// so the first `fa` command works without a separate setup step.
//
// Best effort by design: this never fails the npm install. Skipped for:
//   - development installs inside the source repository (npm install / npm ci),
//   - the AI skill (its packaged package.json has no postinstall),
//   - CI, root/sudo installs (state would be owned by root), and LAYA_SKIP_SETUP=1.
// Run `fa setup` at any time to repeat or finish it.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installedAsPackage = root.split(path.sep).includes('node_modules');
const linked = process.env.npm_command === 'link';
const skip =
    process.env.LAYA_SKIP_SETUP === '1'
        ? 'LAYA_SKIP_SETUP=1'
        : process.env.CI
          ? 'CI'
          : process.getuid?.() === 0
            ? 'root 用户安装（避免 ~/.falcon 归 root 所有）'
            : !(installedAsPackage || linked)
              ? 'development'
              : '';

if (skip === 'development') process.exit(0);
if (skip) {
    console.log(`fa CLI: 跳过自动准备运行环境（${skip}），之后运行 fa setup。`);
    process.exit(0);
}

console.log('fa CLI: 准备运行环境（Python、openpyxl、浏览器），可随时用 fa setup 重新执行…');
const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'setup.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, LAYA_ENTRY: 'cli' },
});
if (result.status !== 0)
    console.log('fa CLI: 运行环境没有准备完成，安装本身不受影响。请运行 fa setup 查看原因。');
process.exit(0);
