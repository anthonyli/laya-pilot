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
    await assert.rejects(replay('failed'), { code: 1, stdout: /未通过/ });
    const failure = await results('failed');
    assert.equal(failure.stats.unexpected, 1);
    const attachments = failure.suites[0].specs[0].tests[0].results[0].attachments;
    for (const name of ['screenshot', 'trace']) {
        const file = attachments.find((item) => item.name === name)?.path;
        assert.ok(file, `Missing ${name} attachment`);
        await fs.access(file);
    }
});

test('replay reports agree on skipped, expected and flaky Playwright outcomes', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-replay-outcomes-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const spec = 'outcomes.spec.cjs';
    const env = { ...process.env, LAYA_HOME: path.join(dir, 'state'), BROWSER_CHANNEL: '' };
    const run = async (name, body, expected) => {
        await fs.writeFile(
            path.join(dir, spec),
            `const { test, expect } = require('playwright/test');\n${body}`,
        );
        const { stdout } = await exec(process.execPath, [cli, 'replay', spec, '--out', name], {
            cwd: dir,
            env,
        });
        const read = (...file) => fs.readFile(path.join(dir, ...file), 'utf8');
        const index = await read(name, 'index.html');
        const summary = await read(name, 'summary.md');
        const latest = JSON.parse(await read('runs', 'laya-pilot', 'latest.json'));
        assert.ok(stdout.includes(expected.verdict));
        assert.ok(index.includes(`<h2>${expected.verdict}</h2>`));
        assert.ok(summary.startsWith(`# ${expected.verdict}\n`));
        for (const [key, value] of Object.entries(expected)) assert.equal(latest[key], value, key);
        return { stdout, index, summary };
    };

    const skipped = await run('skipped', "test.skip('skipped', async () => {});", {
        verdict: '未执行',
        passed: 0,
        failed: 0,
        skipped: 1,
        flaky: 0,
    });
    assert.doesNotMatch(skipped.index, /全部用例通过|通过，证据完整/);
    assert.match(skipped.stdout, /0 passed · 0 failed · 1 skipped/);

    const mixed = await run(
        'mixed',
        `
        test('passes', async () => { expect(true).toBe(true); });
        test.skip('skipped', async () => {});
        test('expected failure', async () => {
            test.fail();
            expect('known issue').toBe('success');
        });`,
        {
            verdict: '通过，证据完整',
            passed: 2,
            failed: 0,
            skipped: 1,
            flaky: 0,
        },
    );
    assert.match(mixed.summary, /预期失败/);
    assert.match(mixed.stdout, /2 passed · 0 failed · 1 skipped/);

    const flaky = await run(
        'flaky',
        `
        test.describe.configure({ retries: 1 });
        test('flaky browser test', async ({ page }, info) => {
            await page.setContent('<button>Retry fixture</button>');
            expect(info.retry, 'first attempt evidence').toBe(1);
        });`,
        {
            verdict: '结果不稳定，需要复核',
            passed: 0,
            failed: 0,
            skipped: 0,
            flaky: 1,
        },
    );
    assert.match(flaky.stdout, /0 passed · 0 failed · 0 skipped · 1 flaky/);
    assert.match(flaky.index, /first attempt evidence/);
    assert.match(flaky.summary, /first attempt evidence/);
    for (const name of ['test-failed-1.png', 'trace.zip']) {
        const link = [...flaky.index.matchAll(/href="([^"]+)"/g)].find(([, href]) =>
            href.endsWith(name),
        );
        assert.ok(link, `missing first attempt ${name} link`);
        await fs.access(path.join(dir, 'flaky', decodeURIComponent(link[1])));
    }
});
