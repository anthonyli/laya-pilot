import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../scripts/run.mjs', import.meta.url));
const require = createRequire(import.meta.url);

test('replays one portable spec and keeps evidence when its assertion fails', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-replay-test-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const name = 'filter [recorded].spec.cjs';
    const source = `const { test, expect } = require('playwright/test');
test('filter results', async ({ page }) => {
    await page.setContent('<input aria-label="Filter">');
    const filter = page.getByRole('textbox', { name: 'Filter' });
    await filter.fill('sample');
    await expect(filter).toHaveValue('sample', { timeout: 500 });
});`;
    const replay = (out) =>
        exec(process.execPath, [cli, 'replay', name, '--out', out], { cwd: dir });
    const results = async (out) =>
        JSON.parse(await fs.readFile(path.join(dir, out, 'results.json'), 'utf8'));
    await fs.writeFile(path.join(dir, name), source);
    await fs.writeFile(
        path.join(dir, 'unselected.spec.cjs'),
        "throw Error('Unselected spec ran');",
    );

    await replay('passed');
    assert.equal((await results('passed')).stats.expected, 1);
    assert.equal(await fs.readFile(path.join(dir, name), 'utf8'), source);
    await fs.access(path.join(dir, 'passed', 'playwright-report', 'index.html'));
    await fs.access(path.join(dir, 'passed', 'index.html'));

    // A separate installed CLI and workspace may have two physical copies of Playwright.
    for (const name of ['playwright', 'playwright-core']) {
        await fs.cp(
            path.dirname(require.resolve(`${name}/package.json`)),
            path.join(dir, 'node_modules', name),
            { recursive: true },
        );
    }
    await fs.writeFile(
        path.join(dir, name),
        source.replace("toHaveValue('sample'", "toHaveValue('other'"),
    );
    await assert.rejects(replay('failed'), { code: 1 });
    const failure = await results('failed');
    assert.equal(failure.stats.unexpected, 1);
    const attachments = failure.suites[0].specs[0].tests[0].results[0].attachments;
    for (const name of ['screenshot', 'trace']) {
        const file = attachments.find((item) => item.name === name)?.path;
        assert.ok(file, `Missing ${name} attachment`);
        await fs.access(file);
    }
});
