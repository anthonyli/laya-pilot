import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { BrowserDiagnostics, OPTIONAL_API_EXPECTATION } from '../../scripts/lib/diagnostics.mjs';
import { Engine } from '../../scripts/lib/engine.mjs';

const bind = '在「名称」列中定位值为「A」的唯一记录';
const absent = '列表中「名称」列不存在值为「A」的记录';
const removal = '点击「删除」按钮';
const row = (name, note, id) =>
    `<tr><td>${name}</td><td>${note}</td><td><button onclick="this.closest('tr').remove(); document.body.dataset.clicked='${id}'">删除</button></td></tr>`;
const table = (...rows) =>
    '<table><thead><tr><th>名称</th><th>备注</th><th>操作</th></tr></thead><tbody>' +
    rows.join('') +
    '</tbody></table>';

test('recorded case checks exact column values and confines changing a record to its row', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        const engine = new Engine(
            page,
            {},
            {
                allowWrite: true,
                assertTimeout: 250,
                pageTimeout: 2000,
                maxSteps: 10,
                delay: 0,
            },
        );
        await page.setContent(
            '<button onclick="document.body.dataset.clicked=\'global\'">删除</button>' +
                table(row('AB', 'A', 'other'), row('A', 'AB', 'target')),
        );
        assert.equal(
            (await engine.verify('列表中「名称」列存在值为「A」的唯一记录')).status,
            '通过',
        );
        assert.equal(
            (await engine.verify('列表中「名称」列值为「A」的唯一记录中「备注」列值为「AB」'))
                .status,
            '通过',
        );
        assert.equal(
            (await engine.verify('列表中「名称」列值为「A」的唯一记录中「备注」列值为「A」'))
                .status,
            '失败',
        );
        await engine.step(bind);
        await page.locator('tbody').evaluate((body) => body.prepend(body.lastElementChild));
        await engine.step(removal);
        assert.equal(await page.locator('body').getAttribute('data-clicked'), 'target');
        assert.equal((await engine.verify(absent)).status, '通过');
        assert.equal((await engine.verify('列表中「名称」列的全部记录值为「AB」')).status, '通过');

        await page.setContent(table(row('A', 'X', 'first'), row('A', 'Y', 'second')));
        await assert.rejects(engine.step(bind), { category: '无法唯一定位记录' });
        await page.setContent(
            '<button onclick="document.body.dataset.clicked=\'global\'">删除</button>' +
                table(row('A', '', 'target').replace('>删除</button>', '>查看</button>')),
        );
        await engine.step(bind);
        await assert.rejects(engine.step(removal), { category: '记录操作范围不明确' });
        assert.equal(await page.locator('body').getAttribute('data-clicked'), null);

        await page.setContent(table(row('B', '', 'one')) + table(row('C', '', 'two')));
        assert.equal((await engine.verify(absent)).status, '未验证');
        await page.setContent(`<main aria-busy="true">${table()}</main>`);
        assert.equal((await engine.verify(absent)).status, '未验证');
    } finally {
        await browser.close();
    }
});

test('recorded dialog actions stay in the unique visible dialog', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(
            `<input placeholder="名称" value="列表值"><button onclick="document.body.dataset.clicked='global'">确定</button>
             <dialog open><input placeholder="名称"><button onclick="document.body.dataset.clicked='dialog'">确定</button></dialog>`,
        );
        const engine = new Engine(
            page,
            {},
            {
                allowWrite: true,
                assertTimeout: 250,
                pageTimeout: 2000,
                maxSteps: 5,
                delay: 0,
            },
        );
        await engine.step('在弹窗的「名称」输入框中输入「修改值」');
        assert.equal(await page.locator('dialog input').inputValue(), '修改值');
        assert.equal(await page.locator('body > input').inputValue(), '列表值');
        await engine.step('清空弹窗的「名称」输入框');
        assert.equal(await page.locator('dialog input').inputValue(), '');
        await engine.step('在弹窗中点击「确定」按钮');
        assert.equal(await page.locator('body').getAttribute('data-clicked'), 'dialog');
        await page.locator('dialog').evaluate((dialog) => dialog.remove());
        await assert.rejects(engine.step('在弹窗中点击「确定」按钮'), {
            category: '弹窗操作范围不明确',
        });
        assert.equal(await page.locator('body').getAttribute('data-clicked'), 'dialog');
    } finally {
        await browser.close();
    }
});

test('generated case gating and optional network health respect observed errors', async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-recorded-health-'));
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        const url = 'http://recorded.test/';
        let requestFailure = false;
        await page.route(`${url}**`, (route) =>
            route.request().url() === url
                ? route.fulfill({
                      contentType: 'text/html',
                      body:
                          '<button>查询</button>' +
                          (requestFailure ? '<script>fetch("/api/query")</script>' : ''),
                  })
                : route.fulfill({
                      status: 500,
                      contentType: 'application/json',
                      body: '{"success":false}',
                  }),
        );
        const engine = new Engine(
            page,
            {},
            {
                url,
                origins: [new URL(url).origin],
                out,
                maxSteps: 5,
                pageTimeout: 2500,
                assertTimeout: 250,
                delay: 0,
            },
            new BrowserDiagnostics(page.context(), { checkBusinessResponses: true }),
        );
        const c = {
            id: 'REC-001',
            key: '测试用例:2',
            title: '查询记录',
            steps: '观察页面',
            expected: OPTIONAL_API_EXPECTATION,
        };
        const readOnly = await engine.runCase({ ...c, preconditions: '本用例需要写入授权' });
        assert.equal(readOnly.category, '写入未启用');
        const local = await engine.runCase(c);
        assert.equal(local.status, '通过');
        assert.match(local.health_checks[0].reason, /没有业务接口请求/);
        requestFailure = true;
        const failure = await engine.runCase(c);
        assert.equal(failure.status, '失败');
        assert.match(failure.health_checks[0].reason, /HTTP.*500/);
    } finally {
        await browser.close();
        await fs.rm(out, { force: true, recursive: true });
    }
});
