import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { chromium } from 'playwright';
import { expect } from 'playwright/test';
import { captureRecording } from '../../scripts/lib/recording-capture.mjs';
import { generateRecordedCases } from '../../scripts/lib/recording-cases.mjs';
import { renderRecordingSpec } from '../../scripts/lib/recording-spec.mjs';
import { Engine } from '../../scripts/lib/engine.mjs';
import { lines } from '../../scripts/lib/language.mjs';

async function servePage(t, html) {
    const server = http.createServer((_, res) =>
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html),
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        server.closeAllConnections();
        return new Promise((resolve) => server.close(resolve));
    });
    return `http://127.0.0.1:${server.address().port}/`;
}

test('record and replay a composite field and its virtual portaled option beside an identical visible option', async (t) => {
    const html = `<style>[role=combobox],button,.ant-select-arrow,.ant-select-item-option{display:inline-block;padding:8px;cursor:pointer}</style>
      <div class="ant-drawer-open"><div class="ant-drawer-content"><div class="ant-form-item">
        <div class="ant-form-item-label"><label><span>Time Slice</span></label></div>
        <input type="number" placeholder="Count">
        <div class="ant-select" onclick="document.querySelector('#popup').hidden=false">
          <div class="ant-select-selection" role="combobox" aria-controls="choice-list">
            <span class="ant-select-selection__placeholder">Please select</span></div>
          <span class="ant-select-arrow">▾</span>
        </div></div></div></div>
      <div class="ant-select-dropdown" id="popup" hidden>
        <div role="listbox" id="choice-list" hidden><div role="option">Second(s)</div></div>
        <div class="ant-select-item-option" onclick="document.body.dataset.value='right';this.parentElement.hidden=true"><span>Second(s)</span></div>
      </div>
      <div role="listbox"><div role="option" onclick="document.body.dataset.value='wrong'">Second(s)</div></div>`;
    const url = await servePage(t, html);
    const recording = await captureRecording({
        url,
        playwright: { chromium },
        headless: true,
        async onReady(page) {
            await page.getByRole('spinbutton').pressSequentially('33');
            await page.locator('.ant-select-arrow').click();
            await page.locator('#popup .ant-select-item-option span').click();
            await page.getByRole('button', { name: '完成录制' }).click();
        },
    });
    const steps = generateRecordedCases(recording).cases.flatMap((item) => lines(item.steps));
    assert.deepEqual(steps, [
        `打开网址 ${url}`,
        '在弹窗的「Time Slice」字段中输入数值「33」',
        '在弹窗中点击「Time Slice」字段的下拉框',
        '在弹窗的「Time Slice」字段下拉框中点击「Second(s)」选项',
    ]);
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(url);
    const engine = new Engine(page, null, {
        url,
        origins: [new URL(url).origin],
        delay: 0,
        assertTimeout: 500,
    });
    for (const step of steps.slice(1)) await engine.step(step);
    assert.equal(await page.getByRole('spinbutton').inputValue(), '33');
    assert.equal(await page.locator('body').getAttribute('data-value'), 'right');
    // Execute the standalone spec body independently of the Excel interpreter.
    let run;
    new Function('require', renderRecordingSpec(recording))(() => ({
        test: (_title, fn) => {
            run = fn;
        },
    }));
    await run({ page });
    assert.equal(await page.getByRole('spinbutton').inputValue(), '33');
    assert.equal(await page.locator('body').getAttribute('data-value'), 'right');
});

test('matches the open Cascader with an unmounted aria-controls target, refusing duplicate choices across columns', async (t) => {
    const html = `<div role="dialog"><div class="ant-form-item"><div class="ant-form-item-label"><label>Category</label></div>
      <div class="tntd-rc-select"><div class="tntd-rc-select-selector" tabindex="0" role="combobox" aria-expanded="false" aria-controls="catalogPath_list"
       onclick="openCategory(this)">Please select</div></div></div></div>
      <div class="ant-form-item"><div class="ant-select-dropdown" hidden><div role="option" onclick="document.body.dataset.value='wrong'">Default</div></div></div>
      <div class="tntd-cascader-menus" hidden>
        <ul class="tntd-cascader-menu" role="menu">
          <li class="tntd-cascader-menu-item" role="menuitemcheckbox" title="Default"><span>Default</span></li>
          <li class="tntd-cascader-menu-item" role="menuitemcheckbox">Repeated</li></ul>
        <ul class="tntd-cascader-menu" role="menu"><li class="tntd-cascader-menu-item" role="menuitemcheckbox">Repeated</li></ul>
      </div><div role="menu"><div role="menuitemcheckbox">Default</div></div><button>Next</button>
      <script>document.querySelector('.tntd-cascader-menu-item').onclick=()=>document.body.dataset.value='Default';
        function openCategory(opener) {
          const previous=document.querySelector('.ant-select-dropdown');
          previous.hidden=false;
          opener.setAttribute('aria-expanded','true');
          setTimeout(()=>document.querySelector('.tntd-cascader-menus').hidden=false,100);
          setTimeout(()=>previous.hidden=true,180);
        }
      </script>`;
    const url = await servePage(t, html);
    const recording = await captureRecording({
        url,
        playwright: { chromium },
        headless: true,
        async onReady(page) {
            await page.getByRole('combobox').click();
            await page.locator('.ant-select-dropdown').waitFor({ state: 'hidden' });
            await page.locator('.tntd-cascader-menu-item span').click();
            await page
                .locator('.tntd-cascader-menu-item')
                .filter({ hasText: 'Repeated' })
                .last()
                .click();
            await page.getByRole('button', { name: 'Next' }).click();
            await page.getByRole('button', { name: '完成录制' }).click();
        },
    });
    const steps = generateRecordedCases(recording).cases.flatMap((item) => lines(item.steps));
    assert.deepEqual(steps.slice(1, 3), [
        '在弹窗中点击「Category」字段的下拉框',
        '在弹窗的「Category」字段下拉框中点击「Default」选项',
    ]);
    assert.match(steps[3], /待补录.*多个同名选项/);
    assert.match(steps[4], /Next/);
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(url);
    const engine = new Engine(page, null, {
        url,
        origins: [new URL(url).origin],
        delay: 0,
        assertTimeout: 500,
    });
    await engine.step(steps[1]);
    await engine.step(steps[2]);
    assert.equal(await page.locator('body').getAttribute('data-value'), 'Default');
});

test('replays the visible option name beside a decorative icon and respects explicit option names and ambiguity', async (t) => {
    const value = '[Field] Login Account';
    const url = await servePage(
        t,
        `
      <div role="dialog"><div class="ant-form-item">
        <div class="ant-form-item-label"><label>Primary Dimension</label></div>
        <div class="ant-select"><div class="ant-select-selection" role="combobox"
             aria-controls="dimensions" onclick="document.querySelector('.ant-select-dropdown').hidden=false">Choose</div></div>
      </div></div>
      <div class="ant-select-dropdown" hidden><div id="dimensions"><ul role="listbox">
        <li role="option" class="ant-select-dropdown-menu-item" aria-label="Previous login account"
            title="${value}" data-value="previous">${value}</li>
        <li role="option" class="ant-select-dropdown-menu-item" title="${value}" data-value="requested"><i aria-label="icon: string"><svg aria-hidden="true"></svg></i>${value}</li>
      </ul></div></div>
      <script>document.querySelector('[role=listbox]').onclick = event => {
          document.body.dataset.selected=event.target.closest('[role=option]').dataset.value;
      }</script>`,
    );
    const recording = await captureRecording({
        url,
        playwright: { chromium },
        headless: true,
        async onReady(page) {
            await page.getByRole('combobox').click();
            await page.locator('[data-value=requested]').click();
            await page.getByRole('button', { name: '完成录制' }).click();
        },
    });
    const steps = generateRecordedCases(recording).cases.flatMap((entry) => lines(entry.steps));
    assert.deepEqual(steps.slice(1), [
        '在弹窗中点击「Primary Dimension」字段的下拉框',
        `在弹窗的「Primary Dimension」字段下拉框中点击「${value}」选项`,
    ]);
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    const engine = new Engine(page, null, {
        url,
        origins: [new URL(url).origin],
        delay: 0,
        assertTimeout: 500,
    });
    await page.goto(url);
    await engine.step(steps[1]);
    await engine.step(steps[2]);
    assert.equal(await page.locator('body').getAttribute('data-selected'), 'requested');

    let run;
    new Function('require', renderRecordingSpec(recording))(() => ({
        test: (_title, fn) => {
            run = fn;
        },
    }));
    await run({ page });
    assert.equal(await page.locator('body').getAttribute('data-selected'), 'requested');

    await page.goto(url);
    await engine.step(steps[1]);
    await page.locator('[data-value=requested]').evaluate((el) => el.after(el.cloneNode(true)));
    await assert.rejects(() => engine.step(steps[2]));
    assert.equal(await page.locator('body').getAttribute('data-selected'), null);

    // After removal the sole remaining text/title match has a different explicit name.
    await page
        .locator('[data-value=requested]')
        .evaluateAll((options) => options.forEach((el) => el.remove()));
    await assert.rejects(() => engine.step(steps[2]));
    assert.equal(await page.locator('body').getAttribute('data-selected'), null);
});

test('replays a custom option without a role by its explicit name across identical visible labels', async (t) => {
    const uiAdapters = [{ name: 'choices', select: { option: '[data-choice]' } }];
    const url = await servePage(
        t,
        `<button role="combobox" aria-label="Dimension" aria-controls="choices"
        onclick="document.querySelector('#choices').hidden=false">Choose</button>
      <span id="actor" hidden>Login actor</span>
      <div role="listbox" id="choices" hidden>
        <div data-choice="1" aria-label="Login account">Login</div>
        <div data-choice="2" aria-labelledby="actor" aria-label="Login account">Login</div>
      </div>
      <script>document.querySelector('#choices').onclick=event=>{
          document.body.dataset.history=(document.body.dataset.history||'')+event.target.dataset.choice;
      }</script>`,
    );
    const recording = await captureRecording({
        url,
        uiAdapters,
        playwright: { chromium },
        headless: true,
        async onReady(page) {
            await page.getByRole('combobox').click();
            await page.locator('[data-choice="1"]').click();
            await page.locator('[data-choice="2"]').click();
            await page.getByRole('button', { name: '完成录制' }).click();
        },
    });
    const steps = generateRecordedCases(recording).cases.flatMap((entry) => lines(entry.steps));
    assert.deepEqual(steps.slice(1), [
        '点击「Dimension」字段的下拉框',
        '在「Dimension」字段下拉框中点击「Login account」选项',
        '在「Dimension」字段下拉框中点击「Login actor」选项',
    ]);
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    const engine = new Engine(page, null, {
        url,
        origins: [new URL(url).origin],
        uiAdapters,
        delay: 0,
        assertTimeout: 500,
    });
    for (const step of steps) await engine.step(step);
    assert.equal(await page.locator('body').getAttribute('data-history'), '12');
});

test('recorded options ignore icon names, hidden glyph text and layout-visible aria-hidden copies', async (t) => {
    const url = await servePage(
        t,
        `<button role="combobox" aria-label="Country" aria-controls="countries"
        onclick="document.querySelector('#countries').hidden=false">Choose</button>
      <ul role="listbox" id="countries" hidden>
        <li role="option" id="flag">Flag Canada</li>
        <li role="option" id="country"><i aria-label="Flag"></i> Canada</li>
        <li role="option" id="greece"><i aria-label="Flag"><span hidden>glyph</span></i> Greece</li>
        <li role="option" id="copy" aria-hidden="true">Greece</li>
        <li role="option" id="icon" title="Other"><svg aria-hidden="true" width="12" height="12"></svg><span hidden>Flag Canada</span></li>
      </ul>
      <script>document.querySelector('#countries').onclick=event=>{
        document.body.dataset.history=(document.body.dataset.history||'')+'/'+event.target.closest('li').id;
      }</script>`,
    );
    const recording = await captureRecording({
        url,
        playwright: { chromium },
        headless: true,
        async onReady(page) {
            await page.getByRole('combobox').click();
            await page.locator('#flag').click();
            await page.locator('#greece').click();
            await page.locator('#icon').click();
            await page.getByRole('button', { name: '完成录制' }).click();
        },
    });
    const steps = generateRecordedCases(recording).cases.flatMap((entry) => lines(entry.steps));
    assert.deepEqual(steps.slice(1), [
        '点击「Country」字段的下拉框',
        '在「Country」字段下拉框中点击「Flag Canada」选项',
        '在「Country」字段下拉框中点击「Greece」选项',
        '在「Country」字段下拉框中点击「Other」选项',
    ]);
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    const engine = new Engine(page, null, {
        url,
        origins: [new URL(url).origin],
        delay: 0,
        assertTimeout: 500,
    });
    await page.goto(url);
    await engine.step(steps[1]);
    // The remaining Canada row has an accessible name of "Flag Canada", yet
    // the recorder identifies it as Canada. Losing the requested row must stop replay.
    await page.locator('#flag').evaluate((el) => el.remove());
    assert.equal(
        await page.getByRole('option', { name: 'Flag Canada', exact: true }).getAttribute('id'),
        'country',
    );
    await assert.rejects(() => engine.step(steps[2]));
    assert.equal(await page.locator('body').getAttribute('data-history'), null);

    await page.reload();
    for (const step of steps.slice(1)) await engine.step(step);
    assert.equal(await page.locator('body').getAttribute('data-history'), '/flag/greece/icon');
    const target = recording.actions.findLast(
        (action) => action.target?.locator === 'selectOption',
    ).target;
    const withCheckpoint = {
        ...recording,
        actions: [...recording.actions, { kind: 'assert', assertion: 'visible', target }],
    };
    let run;
    new Function('require', renderRecordingSpec(withCheckpoint))(() => ({
        expect,
        test: (_title, fn) => {
            run = fn;
        },
    }));
    await run({ page });
    assert.equal(await page.locator('body').getAttribute('data-history'), '/flag/greece/icon');
});
