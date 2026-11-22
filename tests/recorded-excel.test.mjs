import assert from 'node:assert/strict';
import test from 'node:test';
import { recordedCase } from '../scripts/lib/recorded-excel.mjs';
import { describe, lines } from '../scripts/lib/language.mjs';

const recording = (body) => `const { test, expect } = require('playwright/test');
test('客户查询', async ({ page }) => {
    await page.goto('http://127.0.0.1:8765/customers');
    ${body}
});`;

test('captures exact values and position in readable steps, with the check in its original order', () => {
    const converted = recordedCase(
        recording(`
        await page.getByRole('textbox', { name: '客户名称' }).fill('ni hao ');
        await page.getByRole('button', { name: '查看' }).nth(1).click();
        await expect(page.getByText('客户详情')).toBeVisible();
        await page.getByRole('button', { name: '关闭' }).click();
    `),
    );
    const steps = lines(converted.steps);
    assert.equal(steps[1], '在「客户名称」输入框中输入「ni hao 」');
    assert.deepEqual(describe(steps[2]), { verb: 'click', target: '查看', ordinal: 2 });
    assert.equal(steps[3], '检查步骤预期：页面显示「客户详情」');
    assert.equal(steps[4], '点击「关闭」按钮');
    assert.match(converted.expected, /录制设置的步骤预期全部满足/);
    const withoutCheckpoint = recordedCase(
        recording(`await page.getByRole('button', { name: '搜索' }).click();`),
    );
    assert.match(withoutCheckpoint.expected, /业务结果待补充/);
});

test('unsupported code or a nonrepresentable assertion cannot silently become a replayable Excel case', () => {
    assert.throws(
        () => recordedCase(recording(`await page.getByRole('row').toHaveCount(3);`)),
        /无法转换/,
    );
    assert.throws(
        () =>
            recordedCase(
                "test.use({ storageState: 'state.json' });\n" +
                    recording(`await page.getByRole('button', { name: '搜索' }).click();`),
            ),
        /无法转换/,
    );
});

test('stray modifier keys are skipped, replayable keys become steps, others stay unsupported', () => {
    const converted = recordedCase(
        recording(`
        await page.getByPlaceholder('请输入客户名称').fill('test');
        await page.getByPlaceholder('请输入客户名称').press('CapsLock');
        await page.getByPlaceholder('请输入客户名称').press('Enter');
    `),
    );
    const steps = lines(converted.steps);
    assert.equal(steps.length, 3);
    assert.equal(steps[2], '按下 Enter（占位符包含「请输入客户名称」）');
    // The Excel executor understands the converted key step.
    assert.equal(describe(steps[2]).verb, 'press');
    assert.deepEqual(converted.skipped, ['第 6 行按下 CapsLock（不影响页面）']);
    assert.throws(
        () => recordedCase(recording(`await page.getByPlaceholder('名称').press('Control+a');`)),
        (error) =>
            /第 4 行无法转换/.test(error.message) && /press\('Control\+a'\)/.test(error.message),
    );
});

test('legacy key export preserves the locator type and its string matching mode', () => {
    const { steps } = recordedCase(
        recording(`
        await page.getByRole('textbox', { name: '第二项', exact: true }).press('ArrowDown');
        await page.getByLabel('Search').press('Escape');
        await page.getByText('Next').press('Tab');
    `),
    );
    assert.deepEqual(lines(steps).slice(1), [
        '按下 ArrowDown（角色 textbox 名称精确匹配「第二项」）',
        '按下 Escape（标签包含「Search」）',
        '按下 Tab（文本包含「Next」）',
    ]);
    assert.deepEqual(describe(lines(steps)[1]), {
        verb: 'press',
        value: 'ArrowDown',
        locator: '角色 textbox 名称',
        role: 'textbox',
        target: '第二项',
        exact: true,
    });
    assert.deepEqual(describe('按下 Escape'), { verb: 'press', value: 'Escape' });
    assert.throws(
        () =>
            recordedCase(
                recording(
                    `await page.getByRole('textbox', { name: 'A', exact: flag }).press('Tab');`,
                ),
            ),
        /无法转换/,
    );
});
