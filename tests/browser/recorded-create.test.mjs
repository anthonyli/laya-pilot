import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { chromium } from 'playwright';
import { expect } from 'playwright/test';
import { Engine } from '../../scripts/lib/engine.mjs';
import {
    createExpectation,
    readCreateState,
    compareCreateStates,
    verifyCreateClick,
} from '../../scripts/lib/recorded-create.mjs';
import {
    generateRecordedCases,
    addCreateVerification,
} from '../../scripts/lib/recording-cases.mjs';
import { renderRecordingSpec } from '../../scripts/lib/recording-spec.mjs';
import { recordedDialogSelector } from '../../scripts/lib/form.mjs';
import { describe } from '../../scripts/lib/language.mjs';

test('only creation saves acquire an explicit business check in Excel and standalone specs', () => {
    const click = (name) => ({ kind: 'click', target: { role: 'button', name } });
    const actions = [click('Add'), click('Save'), click('Edit'), click('Save')];
    const recording = { url: 'http://app.example/', actions };
    const [create, edit] = generateRecordedCases(recording).cases;
    assert.ok(create.expected.includes(createExpectation));
    assert.equal(
        describe(
            create.steps
                .split('\n')
                .at(-1)
                .replace(/^\d+\. /, ''),
        ).verifyCreate,
        true,
    );
    assert.ok(!edit.steps.includes('并验证新增记录'));
    assert.equal(
        renderRecordingSpec(recording).match(/const result = await verifyCreateClick\(/g).length,
        1,
    );
    assert.deepEqual(addCreateVerification(['点击「Add」按钮', '在弹窗中点击「Save」按钮']), [
        '点击「Add」按钮',
        '在弹窗中点击「Save」按钮并验证新增记录',
    ]);
    assert.deepEqual(addCreateVerification(['在弹窗中点击「Save」按钮']), [
        '在弹窗中点击「Save」按钮并验证新增记录',
    ]);
    assert.deepEqual(
        addCreateVerification(['点击「取消」按钮', '点击「编辑」按钮', '点击「保存」按钮']),
        ['点击「取消」按钮', '点击「编辑」按钮', '点击「保存」按钮'],
    );
});

test('checks generated identity, pager total and compound cells against both sides of Save', async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    const fixture = `<div class="ant-table-wrapper">
        <div class="ant-table-body"><table><thead><tr><th></th><th>Indicator Name</th></tr></thead><tbody>
        <tr data-row-key="old"><td></td><td>Old record</td></tr></tbody></table></div>
        <div class="ant-table-fixed-right"><div class="ant-table-body-inner"><table><thead><tr><th>Operation</th></tr></thead></table></div></div>
        <div class="ant-pagination">Total 4 Record(s)</div>
        </div><div class="ant-tabs-tabpane-inactive" aria-hidden="true"><table><thead><tr><th>Indicator Name</th></tr></thead></table></div>
        <table><thead><tr><th>Other Name</th></tr></thead><tbody><tr><td>Another item</td></tr></tbody></table>
        <div class="ant-drawer-open"><div class="ant-drawer-content">
        <div class="ant-form-item"><div class="ant-form-item-label"><label>ID</label></div><input disabled value="id-42"></div>
        <div class="ant-form-item"><div class="ant-form-item-label"><label>Name</label></div><input disabled value="Recent 33 Second_Current Login Account_ count_ukkrp"></div>
        <button id="save">Save</button></div></div>`;
    await page.route('http://test.local/', (route) =>
        route.fulfill({ contentType: 'text/html', body: fixture }),
    );
    await page.goto('http://test.local/');
    const check = () =>
        verifyCreateClick(
            page,
            () => page.locator('#save').click(),
            readCreateState,
            compareCreateStates,
            recordedDialogSelector,
            650,
        );
    const update = async (mode) =>
        page.evaluate((mode) => {
            document.querySelector('#save').onclick = () => {
                window.saveClicks = (window.saveClicks || 0) + 1;
                document.querySelector('.ant-pagination').textContent = 'Total 5 Record(s)';
                document
                    .querySelector('tbody')
                    .insertAdjacentHTML(
                        'afterbegin',
                        `<tr data-row-key="${mode === 'reused-row' ? 'old' : 'new'}"><td></td><td><div><span>Saved</span>${mode === 'wrong-name' ? 'Other' : 'Recent 33 Second_Current Login Account_ count_ukkrp'}</div><div class="code">Identification:</div></td></tr>`,
                    );
                document
                    .querySelector('.code')
                    .append(document.createTextNode(mode === 'wrong-id' ? 'wrong' : 'id-42'));
                if (mode === 'error')
                    document.body.insertAdjacentHTML(
                        'beforeend',
                        '<div role="status">Saved</div><div class="ant-message-error">Save failed</div>',
                    );
                if (mode === 'invalid')
                    document.querySelector('input').setAttribute('aria-invalid', 'true');
                if (mode === 'rejected' || mode === 'business-code')
                    void fetch('/save', { method: 'POST' });
            };
        }, mode);
    await update('ok');
    assert.equal((await check()).status, '通过');
    assert.equal(await page.evaluate(() => window.saveClicks), 1);
    assert.equal((await page.evaluate(readCreateState, recordedDialogSelector)).tables.length, 2);
    // A duplicate or already-visible key cannot certify that another record was created.
    assert.notEqual((await check()).status, '通过');
    for (const mode of [
        'wrong-name',
        'wrong-id',
        'error',
        'invalid',
        'rejected',
        'business-code',
        'reused-row',
    ]) {
        await page.reload();
        if (mode === 'rejected')
            await page.route('**/save', (route) => route.fulfill({ json: { success: false } }));
        if (mode === 'business-code')
            await page.route('**/save', async (route) => {
                await new Promise((resolve) => setTimeout(resolve, 320));
                await route.fulfill({ status: 200, json: { code: '400001', msg: 'No data' } });
            });
        await update(mode);
        assert.equal((await check()).status, mode === 'reused-row' ? '未验证' : '失败', mode);
        assert.equal(await page.evaluate(() => window.saveClicks), 1, mode);
    }
    await page.reload();
    await page.locator('input').evaluateAll((els) => els.forEach((el) => el.remove()));
    await update('ok');
    assert.equal((await check()).status, '未验证');
});

test('generated standalone spec rejects an optimistic insertion on business error and submits only once', async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    const url = 'http://test.local/';
    await page.route(url, (route) =>
        route.fulfill({
            contentType: 'text/html',
            body: `<table><thead><tr><th>Name</th></tr></thead><tbody></tbody></table>
        <button onclick="document.querySelector('form').hidden=false">Add</button>
        <form hidden><label>Name<input value="runtime-identity"></label>
        <button type="button" onclick="document.querySelector('tbody').insertAdjacentHTML('beforeend','<tr><td>runtime-identity</td></tr>'); fetch('/save',{method:'POST'})">Save</button></form>`,
        }),
    );
    let requests = 0;
    let body = { code: '400001', msg: 'No data' };
    await page.route('**/save', async (route) => {
        requests++;
        await route.fulfill({ status: 200, json: body });
    });
    const click = (name) => ({ kind: 'click', target: { role: 'button', name } });
    let run;
    const register = (_title, fn) => {
        run = fn;
    };
    register.skip = (condition, message) => assert.equal(condition, false, message);
    runInNewContext(renderRecordingSpec({ url, actions: [click('Add'), click('Save')] }), {
        require: () => ({ test: register, expect }),
        URL,
        setTimeout,
    });
    await assert.rejects(run({ page }), /保存请求明确返回失败/);
    assert.equal(requests, 1);
    body = { code: 200 };
    await run({ page });
    assert.equal(requests, 2);
});

test('component adapters scope generated fields, row identities and paginated counts to their owners', async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    const adapters = {
        dialog: '.app-sheet',
        form: { item: '.app-field', label: '.app-label' },
        table: {
            wrapper: '.app-list',
            name: '.business-name',
            id: '.business-id',
            pagination: '.app-pager',
        },
    };
    await page.setContent(`
        <div class="app-list"><div role="grid"><div role="row"><div role="columnheader">Attribute</div></div>
        <div role="row" data-row-key="existing"><div role="gridcell"><span class="business-name">Old</span> <b class="business-id">old-id</b></div></div>
        </div><div class="app-pager">Total 16 Records</div></div>
        <aside class="app-sheet"><div class="app-field"><span class="app-label">Name</span><input disabled value="runtime name"></div>
        <div class="app-field"><span class="app-label">ID</span><input disabled value="runtime id"></div>
        <table><thead><tr><th>ID</th></tr></thead><tbody><tr><td>dialog list</td></tr></tbody></table></aside>
    `);
    const before = await page.evaluate(readCreateState, adapters);
    assert.equal(before.tables.length, 1);
    assert.equal(before.tables[0].total, 16);
    assert.deepEqual(before.fields, { name: ['runtime name'], id: ['runtime id'] });
    await page
        .locator('[role=grid]')
        .evaluate((grid) =>
            grid.insertAdjacentHTML(
                'beforeend',
                '<div role="row" data-row-key="created"><div role="gridcell"><span class="business-name">runtime name</span> <b class="business-id">runtime id</b></div></div>',
            ),
        );
    await page.locator('.app-pager').evaluate((el) => (el.textContent = 'Total 17 Records'));
    const after = await page.evaluate(readCreateState, adapters);
    assert.equal(compareCreateStates(before, after).status, '通过');
    await page
        .locator('[data-row-key=created] [role=gridcell]')
        .evaluate((el) =>
            el.insertAdjacentHTML('beforeend', '<b class="business-id">extra id</b>'),
        );
    const ambiguous = await page.evaluate(readCreateState, adapters);
    assert.equal(compareCreateStates(before, ambiguous).status, '未验证');
});

test('saved workbooks and generated specs confirm an optional duplicate prompt exactly once', async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    const url = 'http://test.local/';
    let mode = 'duplicate';
    const question = 'The indicator is repeated. Do you want to save it?';
    await page.route(url, (route) =>
        route.fulfill({
            contentType: 'text/html',
            body: `<meta charset="utf-8"><table><thead><tr><th>Name</th></tr></thead><tbody></tbody></table>
        <button onclick="editor.hidden=false">Add</button>
        <button onclick="throw Error('clicked a background button')">OK</button>
        <div id="editor" role="dialog" hidden><label>Name<input value="Metric 12h"></label>
        <button onclick="save()">Save</button></div>
        <div id="prompt" role="dialog" hidden><div role="document">
        <span>${question}</span><table><tbody><tr><td>Current Duplicate Indicator ID</td></tr></tbody></table>
        <button>Cancel</button><button onclick="finish()">OK</button></div></div>
        <div role="alertdialog" id="receipt" hidden>Receipt ready<button onclick="this.parentElement.hidden=true;window.received=true">OK</button></div>
        <script>
        window.confirms = 0;
        function finish() {
            window.confirms++;
            promptBox.hidden = true;
            editor.hidden = true;
            if (${JSON.stringify(mode)} === 'receipt') receipt.hidden = false;
            document.querySelector('tbody').insertAdjacentHTML('afterbegin','<tr><td>Metric 12h</td></tr>');
        }
        const promptBox = document.getElementById('prompt');
        function save() {
            if (${JSON.stringify(mode)} === 'direct') finish();
            else if (${JSON.stringify(mode)} === 'native') {
                if (confirm('指标重复，是否继续保存？')) finish();
            } else setTimeout(() => {
                if (${JSON.stringify(mode)} === 'nested') editor.append(promptBox);
                promptBox.hidden = false;
            }, 80);
        }
        </script>`,
        }),
    );
    const save = '在弹窗中点击「Save」按钮并验证新增记录';
    const ok = '在弹窗中点击「OK」按钮';
    const engine = new Engine(page, null, {
        url,
        origins: [new URL(url).origin],
        allowWrite: true,
        delay: 0,
        assertTimeout: 1500,
    });
    for (mode of ['duplicate', 'direct', 'native', 'nested', 'receipt']) {
        await page.goto(url);
        await page.getByRole('button', { name: 'Add' }).click();
        await engine.step(save);
        await engine.step(ok);
        const verified = engine.events.findLast((entry) => entry.action === 'verify-create');
        assert.equal(verified.status, '通过');
        assert.equal(!!verified.autoConfirmed, mode !== 'direct');
        assert.equal(await page.evaluate(() => window.confirms), 1);
        if (mode === 'receipt') assert.equal(await page.evaluate(() => window.received), true);
        else assert.equal(engine.events.at(-1).action, 'save-confirmation');
    }

    const button = (name, scope) => ({ kind: 'click', target: { name, role: 'button', scope } });
    for (const recordedOK of [true, false]) {
        const actions = [button('Add'), button('Save', 'dialog')];
        if (recordedOK) actions.push(button('OK', 'dialog'));
        let run;
        const register = (_name, callback) => {
            run = callback;
        };
        register.skip = (skip, reason) => assert.equal(skip, false, reason);
        runInNewContext(renderRecordingSpec({ url, actions }), {
            require: () => ({ test: register, expect }),
            URL,
            setTimeout,
        });
        for (mode of ['duplicate', 'direct']) {
            await run({ page });
            assert.equal(await page.evaluate(() => window.confirms), 1);
        }
    }
});

test('a duplicate error, an unrelated question or two affirmative buttons do not authorize a click', async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    for (const [message, buttons] of [
        ['Duplicate indicator. Cannot save.', ['OK']],
        ['The indicator is repeated. Do you want to overwrite it?', ['OK']],
        ['Do you want to delete this indicator?', ['OK']],
        ['指标重复，是否仍要保存？', ['确定', '继续保存']],
    ]) {
        await page.setContent(`<table><thead><tr><th>Name</th></tr></thead><tbody></tbody></table>
            <form><label>Name<input value="x"></label><button type="button" onclick="document.querySelector('aside').hidden=false">Save</button></form>
            <aside role="alertdialog" hidden>${message}${buttons.map((name) => `<button onclick="document.body.dataset.clicked='yes'">${name}</button>`).join('')}</aside>`);
        const result = await verifyCreateClick(
            page,
            () => page.getByText('Save', { exact: true }).click(),
            readCreateState,
            compareCreateStates,
            recordedDialogSelector,
            320,
        );
        assert.notEqual(result.status, '通过');
        assert.equal(await page.locator('body').getAttribute('data-clicked'), null);
    }
});
