const actionMethods = {
    click: 'click',
    fill: 'fill',
    press: 'press',
    check: 'check',
    uncheck: 'uncheck',
    select: 'selectOption',
};

function recordedLocator(target) {
    if (!target?.name) return null;
    const exact = '{ exact: true }';
    const name = JSON.stringify(target.name);
    let scope = 'page';
    if (target.row && !target.rowAmbiguous) {
        const cell = JSON.stringify(target.row);
        scope += `.getByRole('row').filter({ has: page.getByText(${cell}, ${exact}) })`;
    } else if (target.scope === 'dialog' || target.scope === '弹窗') {
        scope += ".getByRole('dialog')";
    }
    if (target.rowAmbiguous) return null;
    if (target.locator === 'label') return `${scope}.getByLabel(${name}, ${exact})`;
    if (target.locator === 'placeholder') return `${scope}.getByPlaceholder(${name}, ${exact})`;
    if (target.locator === 'text' || !target.role) return `${scope}.getByText(${name}, ${exact})`;
    return `${scope}.getByRole(${JSON.stringify(target.role)}, { name: ${name}, exact: true })`;
}

export function renderRecordingSpec(recording, channel) {
    const statements = ["const { test, expect } = require('playwright/test');"];
    if (channel) statements.push(`test.use({ channel: ${JSON.stringify(channel)} });`);
    statements.push('', "test('录制用例', async ({ page }) => {");
    if (recording.actions[0]?.kind !== 'goto')
        statements.push(`    await page.goto(${JSON.stringify(recording.url)});`);
    for (const action of recording.actions) {
        if (action.kind === 'goto') {
            statements.push(`    await page.goto(${JSON.stringify(action.url)});`);
            continue;
        }
        if (action.kind === 'press' && !action.target) {
            statements.push(`    await page.keyboard.press(${JSON.stringify(action.key)});`);
            continue;
        }
        const target = recordedLocator(action.target);
        if (target && action.kind === 'assert') {
            const check =
                action.assertion === 'value'
                    ? `toHaveValue(${JSON.stringify(action.value)})`
                    : 'toBeVisible()';
            statements.push(`    await expect(${target}).${check};`);
            continue;
        }
        const method = actionMethods[action.kind];
        if (!method || !target) {
            const reason = action.reason || '无法唯一定位录制控件';
            statements.push(`    throw new Error(${JSON.stringify(reason)});`);
            break;
        }
        let argument = action.value;
        if (action.kind === 'press') argument = action.key;
        if (action.kind === 'select') argument = { label: action.value };
        statements.push(`    await ${target}.${method}(${JSON.stringify(argument) ?? ''});`);
    }
    return [...statements, '});', ''].join('\n');
}
