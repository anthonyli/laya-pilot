import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { chromium } from 'playwright';
import { captureRecording } from '../../scripts/lib/recording-capture.mjs';
import { generateRecordedCases } from '../../scripts/lib/recording-cases.mjs';
import { renderRecordingSpec } from '../../scripts/lib/recording-spec.mjs';
import { Engine } from '../../scripts/lib/engine.mjs';
import { lines } from '../../scripts/lib/language.mjs';

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
    const server = http.createServer((_, res) =>
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html),
    );
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
    const server = http.createServer((_, res) =>
        res.writeHead(200, { 'content-type': 'text/html' }).end(html),
    );
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
