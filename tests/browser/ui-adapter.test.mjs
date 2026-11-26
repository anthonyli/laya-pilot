import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { venvPython } from '../../scripts/lib/entry.mjs';
import { lines } from '../../scripts/lib/language.mjs';
import { createExpectation } from '../../scripts/lib/recorded-create.mjs';
import { attachRecordedCases, exportRecording } from '../../scripts/lib/recorded-excel.mjs';
import { captureRecording } from '../../scripts/lib/recording-capture.mjs';
import { generateRecordedCases } from '../../scripts/lib/recording-cases.mjs';
import { renderRecordingSpec } from '../../scripts/lib/recording-spec.mjs';
import { loadUiAdapter } from '../../scripts/lib/ui-adapters.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const exec = promisify(execFile);
const adapter = {
    name: 'attribute-widgets',
    dialog: '[data-sheet]',
    form: { item: '[data-field]', label: '[data-caption]' },
    select: {
        shell: '[data-picker]',
        trigger: '[data-trigger]',
        popup: '[data-options]',
        option: '[data-choice]',
    },
    table: {
        wrapper: '[data-list]',
        pagination: '[data-pager]',
        name: '[data-business-name]',
        id: '[data-business-id]',
    },
};

function fixture(identity) {
    return `<!doctype html><html><body>
      <section data-list><table><thead><tr><th>Attribute</th></tr></thead><tbody>
      <tr data-row-key="old"><td><span data-business-name>Prior</span><b data-business-id>old</b></td></tr>
      </tbody></table><div data-pager><span>Total 16 Records</span><button aria-label="Next page">›</button></div></section>
      <aside data-sheet><button id="add" onclick="document.querySelector('main').hidden=false;this.hidden=true">Add</button>
      <main hidden><div data-field><span data-caption>Name</span><input disabled value="Entry ${identity}"></div>
      <div data-field><span data-caption>ID</span><input disabled value="${identity}"></div>
      <div data-field><span data-caption>Time Slice</span><input type="number">
        <div data-picker><div data-trigger tabindex="0" aria-controls="unit-list" onclick="document.querySelector('#unit-list').hidden=false">Choose unit</div></div>
      </div><button id="save">Save</button></main></aside>
      <section data-options id="unit-list" hidden><div data-choice><span>Days</span></div></section>
      <section data-options id="other-list"><div data-choice>Days</div></section>
      <script>
      let unit = '';
      document.querySelector('#unit-list [data-choice]').onclick = () => {unit='days';document.querySelector('#unit-list').hidden=true;};
      document.querySelector('#other-list [data-choice]').onclick = () => {unit='wrong';};
      document.querySelector('#save').onclick = async () => {
        const id = '${identity}', amount = document.querySelector('input[type=number]').value;
        await fetch('/save', {method:'POST',body:JSON.stringify({id,amount,unit})});
        if (amount !== '13' || unit !== 'days') {
          document.body.insertAdjacentHTML('beforeend','<div role="alert">Invalid configuration</div>');return;
        }
        document.querySelector('tbody').insertAdjacentHTML('afterbegin','<tr data-row-key="'+id+'"><td><span data-business-name>Entry '+id+'</span><b data-business-id>'+id+'</b></td></tr>');
        document.querySelector('[data-pager] span').textContent='Total 17 Records';
        document.querySelector('[data-sheet]').hidden=true;
      };
      </script></body></html>`;
}

test(
    'a JSON component adapter survives capture, workbook export, CLI Excel replay and standalone Playwright replay',
    { timeout: 60000 },
    async (t) => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-widget-adapter-'));
        t.after(() => fs.rm(directory, { recursive: true, force: true }));
        const adapterFile = path.join(directory, 'custom widgets.json');
        await fs.writeFile(adapterFile, JSON.stringify(adapter));
        const saves = [];
        let documentId = 0;
        const server = http.createServer(async (req, res) => {
            if (req.method === 'POST' && req.url === '/save') {
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                saves.push(JSON.parse(Buffer.concat(chunks).toString()));
                return res
                    .writeHead(200, { 'content-type': 'application/json' })
                    .end('{"success":true}');
            }
            if (req.url === '/')
                return res
                    .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
                    .end(fixture('entry-' + ++documentId));
            res.writeHead(req.url === '/favicon.ico' ? 204 : 404).end();
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        t.after(() => {
            server.closeAllConnections();
            return new Promise((resolve) => server.close(resolve));
        });
        const url = `http://127.0.0.1:${server.address().port}/`;
        const recording = await captureRecording({
            url,
            playwright: { chromium },
            headless: true,
            uiAdapters: await loadUiAdapter(adapterFile),
            async onReady(page) {
                await page.getByRole('button', { name: 'Add' }).click();
                await page.locator('input[type=number]').fill('13');
                await page.locator('[data-trigger]').click();
                await page.locator('#unit-list [data-choice] span').click();
                await page.getByRole('button', { name: 'Save' }).click();
                await page.locator('[data-sheet]').waitFor({ state: 'hidden' });
                await page.getByRole('button', { name: '完成录制' }).click();
            },
        });
        const generated = generateRecordedCases(recording);
        assert.deepEqual(generated.skipped, []);
        const [created] = generated.cases;
        const steps = lines(created.steps);
        assert.deepEqual(steps, [
            `打开网址 ${url}`,
            '在弹窗中点击「Add」按钮',
            '在弹窗的「Time Slice」字段中输入数值「13」',
            '在弹窗中点击「Time Slice」字段的下拉框',
            '在弹窗的「Time Slice」字段下拉框中点击「Days」选项',
            '在弹窗中点击「Save」按钮并验证新增记录',
        ]);
        assert.ok(lines(created.expected).includes(createExpectation));

        const spec = path.join(directory, 'adapter.spec.cjs');
        const workbook = path.join(directory, 'adapter.xlsx');
        const source = renderRecordingSpec(recording);
        // The standalone recording must work outside the project using only Playwright.
        assert.deepEqual(
            [...source.matchAll(/require\(([^)]+)\)/g)].map((match) => match[1]),
            ["'playwright/test'"],
        );
        await fs.writeFile(spec, attachRecordedCases(source, generated));
        const python =
            process.env.LAYA_TEST_PYTHON ||
            process.env.LAYA_PYTHON ||
            (existsSync(venvPython) ? venvPython : 'python3');
        await exportRecording(spec, workbook, python);
        const imported = JSON.parse(
            execFileSync(python, [path.join(root, 'scripts/worker.py')], {
                input: JSON.stringify({ id: 1, action: 'read_excel', path: workbook }) + '\n',
                encoding: 'utf8',
            }),
        );
        assert.equal(imported.cases.length, 1);
        assert.deepEqual(lines(imported.cases[0].steps), steps);
        const env = {
            ...Object.fromEntries(
                Object.entries(process.env).filter(([key]) => !/^(LAYA_|TEST_|BROWSER_)/.test(key)),
            ),
            LAYA_HOME: path.join(directory, 'runtime'),
            PYTHONPATH: path.join(root, 'tests/fixtures/local-model'),
        };
        const cli = path.join(root, 'bin/fa.mjs');
        const excelOut = path.join(directory, 'excel-report');
        await exec(
            process.execPath,
            [
                cli,
                'replay',
                workbook,
                '--ui-adapter',
                adapterFile,
                '--url',
                url,
                '--python',
                python,
                '--provider',
                'local',
                '--lazy-model',
                '--headless',
                '--allow-write',
                '--delay',
                '0',
                '--out',
                excelOut,
            ],
            { cwd: directory, env },
        );
        const excelResult = JSON.parse(
            await fs.readFile(path.join(excelOut, 'results.json'), 'utf8'),
        );
        assert.equal(excelResult.results.length, 1);
        const [replayed] = excelResult.results;
        assert.equal(replayed.status, '通过', replayed.reason);
        assert.equal(
            replayed.assertions.find((item) => item.text === createExpectation)?.status,
            '通过',
        );
        // The standalone file embeds the selectors, so the project JSON is no longer needed.
        await fs.unlink(adapterFile);
        const out = path.join(directory, 'spec-report');
        await exec(process.execPath, [cli, 'replay', spec, '--headless', '--out', out], {
            cwd: directory,
            env,
        });
        const { stats } = JSON.parse(await fs.readFile(path.join(out, 'results.json'), 'utf8'));
        assert.equal(stats.expected, 1);
        assert.equal(stats.skipped, 0);
        assert.deepEqual(
            saves.map(({ unit, amount }) => [unit, amount]),
            Array.from({ length: 3 }, () => ['days', '13']),
        );
        assert.equal(new Set(saves.map((save) => save.id)).size, 3);
    },
);
