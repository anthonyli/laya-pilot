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
