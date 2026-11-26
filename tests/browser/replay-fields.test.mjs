import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { Engine } from '../../scripts/lib/engine.mjs';
import { committedSelection } from '../../scripts/lib/replay-fields.mjs';

async function form(t, markup, choose) {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent(markup);
    return {
        page,
        engine: new Engine(page, choose && { choose }, {
            url: 'about:blank',
            delay: 0,
            assertTimeout: 180,
            origins: [],
        }),
    };
}

const selectorForm = `
<button role=combobox aria-label="Category" id=outside>Behind dialog</button>
<div role=dialog>
<button role=combobox aria-label="Metric Category" aria-controls=choices aria-expanded=false
    onclick="this.setAttribute('aria-expanded','true');choices.hidden=false">
    <span class="ant-select-selection-selected-value">Choose</span>
</button>
<div id=choices role=listbox hidden>
    <button role=option aria-disabled=true>Disabled</button>
    <button role=option hidden>Hidden</button>
    <button role=option>Production</button>
    <button role=option>Sandbox</button>
</div>
</div>
<script>
document.querySelector('#choices').onclick = (event) => {
    document.querySelector('.ant-select-selection-selected-value').textContent = event.target.innerText;
    document.querySelector('[aria-controls]').setAttribute('aria-expanded','false');
    event.currentTarget.hidden = true;
};
</script>`;
const openCategory = '在弹窗中点击「Category」字段的下拉框';
const goalCategory = '在弹窗的「Category」字段下拉框中选择符合「测试环境」的选项';
const sure = (choice) => ({ choice, probabilities: { [choice]: 0.98 }, margin: 0.96 });

test('a renamed field stays in its dialog and a purpose selects only enabled owned options', async (t) => {
    const calls = [];
    const { engine, page } = await form(t, selectorForm, (_prompt, criteria, meta) => {
        calls.push(meta.phase);
        if (meta.phase === 'field-match') {
            assert.deepEqual(Object.keys(criteria), ['Metric Category', '停止']);
            return sure('Metric Category');
        }
        assert.deepEqual(Object.values(criteria), ['Production', 'Sandbox', '不执行']);
        return sure(Object.keys(criteria).find((key) => criteria[key] === 'Sandbox'));
    });
    await engine.step(openCategory);
    await engine.step(goalCategory);
    assert.deepEqual(calls, ['field-match', 'dynamic-option']);
    assert.equal(
        await page.locator('[aria-controls]').evaluate(committedSelection, 'Sandbox'),
        'matched',
    );
    assert.equal(await page.locator('#outside').innerText(), 'Behind dialog');
    assert.ok(engine.events.some((e) => e.from === 'Category' && e.to === 'Metric Category'));
    assert.ok(engine.events.some((e) => e.action === 'dynamic-option' && e.value === 'Sandbox'));
});

test('uncertain choices and replaced fields stop before acting', async (t) => {
    let replace = false;
    const { engine, page } = await form(t, selectorForm, async () => {
        if (!replace)
            return {
                choice: 'Metric Category',
                probabilities: { 'Metric Category': 0.51 },
                margin: 0.02,
            };
        await page.locator('[aria-controls]').evaluate((el) => el.replaceWith(el.cloneNode(true)));
        return sure('Metric Category');
    });
    await assert.rejects(
        () => engine.step(openCategory),
        (e) => e.category === 'Laya选择不确定',
    );
    replace = true;
    await assert.rejects(
        () => engine.step(openCategory),
        (e) => e.category === 'DOM已变化',
    );
    assert.equal(await page.locator('#choices').isVisible(), false);
});

test('an acknowledged wrong value fails and does not count as a selected option', async (t) => {
    const { engine, page } = await form(t, selectorForm);
    await engine.step('在弹窗中点击「Metric Category」字段的下拉框');
    await page.locator('#choices').evaluate((el) => (el.onclick = () => (el.hidden = true)));
    await assert.rejects(
        () => engine.step('在弹窗的「Metric Category」字段下拉框中点击「Sandbox」选项'),
        (e) => e.category === '选值未确认',
    );
    assert.ok(!engine.events.some((e) => e.action === 'dynamic-option'));
});

test('a plain combobox showing a different value after committing fails the step', async (t) => {
    const { engine, page } = await form(t, selectorForm);
    const trigger = page.locator('[aria-controls]');
    await trigger.evaluate((el) => (el.textContent = 'Choose'));
    await engine.step('在弹窗中点击「Metric Category」字段的下拉框');
    await page.locator('#choices').evaluate(
        (el) =>
            (el.onclick = () => {
                el.hidden = true;
                const trigger = document.querySelector('[aria-controls]');
                trigger.setAttribute('aria-expanded', 'false');
                trigger.textContent = 'Production';
            }),
    );
    await assert.rejects(
        () => engine.step('在弹窗的「Metric Category」字段下拉框中点击「Sandbox」选项'),
        (e) => e.category === '选值未确认',
    );
});

test('integer recipes honor the live min/max/step and assertions follow the exact adapted field', async (t) => {
    const { engine, page } = await form(
        t,
        '<div role=dialog><input type=number aria-label=Duration min=3 max=9 step=3><input type=number aria-label=Disabled disabled></div>',
        (_p, criteria) => {
            assert.deepEqual(Object.keys(criteria), ['Duration', '停止']);
            return sure('Duration');
        },
    );
    await engine.step('在弹窗的「Time Slice」字段中输入 4 到 7 之间的整数');
    assert.equal(await page.locator('input').first().inputValue(), '6');
    assert.equal((await engine.verify('「Time Slice」输入框的值为「6」')).status, '通过');
    assert.ok(engine.events.some((e) => e.action === 'dynamic-fill' && e.value === '6'));
    await assert.rejects(
        () => engine.step('在弹窗的「Time Slice」字段中输入 1 到 2 之间的整数'),
        (e) => e.category === '测试数据范围无效',
    );
});

test('native random choice skips placeholder, hidden, duplicate and disabled options without a model', async (t) => {
    const { engine, page } = await form(
        t,
        `<label for=native>Category</label><select id=native>
      <option value="">Choose</option><option hidden>Hidden</option><optgroup disabled label="Disabled"><option>Forbidden</option></optgroup>
      <option>Duplicate</option><option>Duplicate</option><option>Sandbox</option></select>`,
    );
    await engine.step('在「Category」下拉框中选择任一可用选项');
    assert.equal(await page.locator('select').inputValue(), 'Sandbox');
});

test('confirmed dropdowns and inputs skip default pacing and retain an explicit delay', async (t) => {
    const { engine, page } = await form(
        t,
        selectorForm.replace(
            '</div>\n<script>',
            '<input aria-label="Description"></div>\n<script>',
        ),
    );
    engine.config.delay = 73;
    engine.config.confirmedDelay = 0;
    const waits = [];
    const wait = page.waitForTimeout.bind(page);
    page.waitForTimeout = (ms) => {
        waits.push(ms);
        return wait(ms);
    };
    await engine.step('在弹窗中点击「Metric Category」字段的下拉框');
    await engine.step('在弹窗的「Metric Category」字段下拉框中点击「Sandbox」选项');
    await engine.step('在弹窗的「Description」输入框中输入「first」');
    assert.equal(waits.includes(73), false);
    engine.config.confirmedDelay = 73;
    await engine.step('在弹窗的「Description」输入框中输入「second」');
    assert.ok(waits.includes(73));
});

test('a field waits for the newly opened dialog to mount', async (t) => {
    const { engine, page } = await form(t, '<main>Metrics</main>');
    engine.config.assertTimeout = 1000;
    await page.evaluate(() =>
        setTimeout(() => {
            const dialog = document.createElement('div');
            dialog.setAttribute('role', 'dialog');
            dialog.innerHTML = '<input aria-label="Description">';
            document.body.append(dialog);
        }, 50),
    );
    await engine.step('在弹窗的「Description」输入框中输入「metric」');
    assert.equal(await page.getByRole('textbox').inputValue(), 'metric');
});
