import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { captureRecording } from '../../scripts/lib/recording-capture.mjs';
import { generateRecordedCases } from '../../scripts/lib/recording-cases.mjs';
import { attachRecordedCases, exportRecording } from '../../scripts/lib/recorded-excel.mjs';
import { renderRecordingSpec } from '../../scripts/lib/recording-spec.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const python = process.env.LAYA_TEST_PYTHON || process.env.LAYA_PYTHON || 'python3';

test(
    'records multiple modules and replays each generated write case with its own data',
    { timeout: 90000 },
    async (t) => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-split-recording-'));
        const demo = (await fs.readFile(path.join(root, 'examples/demo.html'), 'utf8')).replace(
            '__SAVE_ERROR__',
            'false',
        );
        const server = http.createServer((_, response) =>
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(demo),
        );
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        t.after(async () => {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
            await fs.rm(directory, { recursive: true, force: true });
        });
        const url = `http://127.0.0.1:${server.address().port}/`;
        const recording = await captureRecording({
            playwright: { chromium },
            url,
            headless: true,
            async onReady(page) {
                const button = (name) => page.getByRole('button', { name, exact: true });
                const row = (name) =>
                    page.getByRole('row').filter({
                        has: page.getByRole('cell', { name, exact: true }),
                    });
                await page.getByLabel('客户名称', { exact: true }).fill('常规客户乙');
                await button('搜索').click();
                await row('常规客户丙').waitFor({ state: 'hidden' });
                await button('重置').click();
                await button('新增客户').click();
                await page.getByRole('dialog').getByLabel('客户名称').fill('录制甲');
                await button('保存').click();
                await row('录制甲').getByRole('button', { name: '编辑' }).click();
                await page.getByRole('dialog').getByLabel('客户名称').fill('录制乙');
                await button('保存').click();
                await row('录制乙').getByRole('button', { name: '删除' }).click();
                await button('确定').click();
                await page.getByRole('link', { name: /订单管理/ }).click();
                const status = page.getByLabel('订单状态');
                // Expand the headless native control so a real click emits a trusted change.
                await status.evaluate((element) => {
                    element.size = 3;
                });
                await page.getByRole('option', { name: '待处理' }).click();
                assert.equal(await status.inputValue(), '待处理');
                await button('查询').click();
                await row('订单B').waitFor({ state: 'hidden' });
                await button('完成录制').click();
            },
        });
        const generated = generateRecordedCases(recording, { splitCases: true });
        const create = generated.cases.find((entry) => /新增/.test(entry.title));
        const edit = generated.cases.find((entry) => /编辑/.test(entry.title));
        const remove = generated.cases.find((entry) => /删除/.test(entry.title));
        const orderSearch = generated.cases.find(
            (entry) => /\/orders\b/.test(entry.steps) && /查询$/.test(entry.title),
        );
        assert.ok(
            create && edit && remove && orderSearch,
            generated.cases.map((entry) => entry.title).join(' / '),
        );
        assert.match(orderSearch.title, /订单管理/);
        assert.ok(generated.cases.length >= 5);
        assert.equal(
            new Set(generated.cases.map((entry) => entry.id)).size,
            generated.cases.length,
        );
        const workbook = path.join(directory, 'split.xlsx');
        const spec = path.join(directory, 'split.spec.cjs');
        await fs.writeFile(spec, attachRecordedCases(renderRecordingSpec(recording), generated));
        assert.deepEqual(await exportRecording(spec, workbook, python), generated);

        const env = Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !/^(LAYA_|TEST_|BROWSER_)/.test(key)),
        );
        env.LAYA_HOME = path.join(directory, 'runtime');
        env.PYTHONPATH = path.join(root, 'tests/fixtures/local-model');
        for (const entry of generated.cases) {
            const out = path.join(directory, entry.id);
            const { stdout } = await exec(
                process.execPath,
                [
                    path.join(root, 'bin/laya.mjs'),
                    'replay',
                    workbook,
                    '--url',
                    url,
                    '--cases',
                    entry.id,
                    '--headless',
                    '--python',
                    python,
                    '--provider',
                    'local',
                    '--allow-write',
                    '--lazy-model',
                    '--delay',
                    '0',
                    '--out',
                    out,
                ],
                { cwd: directory, env },
            ).catch((error) => {
                assert.fail(`${entry.title}\n${error.stdout}\n${error.stderr}`);
            });
            const result = JSON.parse(
                await fs.readFile(path.join(out, 'results.json'), 'utf8'),
            ).results;
            assert.deepEqual(
                result.map((item) => item.id),
                [entry.id],
            );
            assert.equal(result[0].status, '通过', stdout);
        }
    },
);
