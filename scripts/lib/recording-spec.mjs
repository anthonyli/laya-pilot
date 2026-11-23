import { recordedReviewPrefix } from './language.mjs';
import { resolveUiAdapters } from './ui-adapters.mjs';
import { selectOptionName, selectOptionChoices } from './ui-adapter-select.mjs';
import { businessResponseFailed } from './diagnostics.mjs';
import {
    recordedFormItem,
    recordedSelectOption,
    recordedSelectTrigger,
    onlyExpandedSelect,
    selectSelectors,
} from './recorded-select.mjs';
import { recordedCreateActions } from './recording-cases.mjs';
import { readCreateState, compareCreateStates, verifyCreateClick } from './recorded-create.mjs';
import { findDialogCard } from './recorded-card.mjs';
import {
    navigationIconSelector,
    navigationScope,
    findNamedIcon,
    iconOwner,
    declaredIconName,
} from './recorded-navigation.mjs';

const actionMethods = {
    click: 'click',
    fill: 'fill',
    press: 'press',
    check: 'check',
    uncheck: 'uncheck',
    select: 'selectOption',
};

function recordedLocator(target, ui) {
    if (!target?.name) return null;
    const exact = '{ exact: true }';
    const name = JSON.stringify(target.name);
    let scope = 'page';
    if (target.row && !target.rowAmbiguous) {
        const cell = JSON.stringify(target.row);
        scope += `.getByRole('row').filter({ has: page.getByText(${cell}, ${exact}) })`;
    } else if (target.scope === 'dialog' || target.scope === '弹窗') {
        scope += `.locator(${JSON.stringify(ui.dialog)}).filter({ visible: true })`;
    }
    if (target.rowAmbiguous) return null;
    if (target.locator === 'fieldSelect')
        return `recordedSelectTrigger(${scope}, page, ${name}, selectMarkup)`;
    if (target.locator === 'selectOption') {
        const opener = target.field ? recordedLocator(target.field, ui) : 'null';
        return `(await recordedSelectOption(page, ${name}, ${opener}, selectMarkup, ${scope}))`;
    }
    if (target.locator === 'buttonText') {
        const escaped = target.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return `${scope}.getByRole('button').filter({ hasText: new RegExp(${JSON.stringify('^\\s*' + escaped + '\\s*$')}) , visible: true })`;
    }
    if (target.locator === 'formNumber')
        return `recordedFormItem(${scope}, page, ${name}, selectMarkup).locator('input[type=number],input[role=spinbutton]').filter({ visible: true })`;
    if (target.locator === 'cardTitle')
        return `(await findDialogCard(${scope}, ${name}, ${JSON.stringify(ui.cardTitle)}))`;
    if (['namedNavIcon', 'namedIcon'].includes(target.locator)) {
        if (target.locator === 'namedNavIcon')
            scope += `.locator(${JSON.stringify(navigationScope)})`;
        return `(await findNamedIcon(page, ${scope}, ${name}, iconOwner, declaredIconName))`;
    }
    if (target.locator === 'navIcon')
        return `${scope}.locator(${JSON.stringify(navigationIconSelector(target.name))}).filter({ visible: true })`;
    if (target.locator === 'label') return `${scope}.getByLabel(${name}, ${exact})`;
    if (target.locator === 'placeholder') return `${scope}.getByPlaceholder(${name}, ${exact})`;
    if (target.locator === 'text' || !target.role) return `${scope}.getByText(${name}, ${exact})`;
    return `${scope}.getByRole(${JSON.stringify(target.role)}, { name: ${name}, exact: true })`;
}

export function renderRecordingSpec(recording, channel) {
    const ui = resolveUiAdapters(recording.uiAdapters);
    const selectMarkup = selectSelectors(ui);
    const statements = ["const { test, expect } = require('playwright/test');"];
    if (
        recording.actions.some(
            (action) =>
                ['formNumber', 'fieldSelect'].includes(action.target?.locator) ||
                action.target?.field,
        )
    )
        statements.push(recordedFormItem.toString());
    if (
        recording.actions.some(
            (action) => action.target?.locator === 'fieldSelect' || action.target?.field,
        )
    )
        statements.push(recordedSelectTrigger.toString());
    if (
        recording.actions.some((action) =>
            ['formNumber', 'fieldSelect', 'selectOption'].includes(action.target?.locator),
        )
    )
        statements.push(`const selectMarkup = ${JSON.stringify(selectMarkup)};`);
    if (recording.actions.some((action) => action.target?.locator === 'selectOption'))
        statements.push(
            selectOptionName.toString(),
            selectOptionChoices.toString(),
            onlyExpandedSelect.toString(),
            recordedSelectOption.toString(),
        );
    const creates = recordedCreateActions(recording.actions);
    if (creates.size)
        statements.push(
            businessResponseFailed.toString(),
            readCreateState.toString(),
            compareCreateStates.toString(),
            verifyCreateClick.toString(),
        );
    if (recording.actions.some((action) => action.target?.locator === 'cardTitle'))
        statements.push(findDialogCard.toString());
    if (
        recording.actions.some((action) =>
            ['namedNavIcon', 'namedIcon'].includes(action.target?.locator),
        )
    )
        statements.push(
            iconOwner.toString(),
            declaredIconName.toString(),
            findNamedIcon.toString(),
        );
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
        const target = recordedLocator(action.target, ui);
        if (
            target &&
            action.target.locator === 'selectOption' &&
            ['click', 'assert'].includes(action.kind)
        ) {
            statements.push('    {', `        const option = ${target};`, '        try {');
            if (action.kind === 'assert') {
                const check =
                    action.assertion === 'value'
                        ? `expect(await option.inputValue()).toBe(${JSON.stringify(action.value)})`
                        : 'expect(await option.isVisible()).toBe(true)';
                statements.push(`            ${check};`);
            } else statements.push('            await option.click();');
            statements.push(
                '        } finally {',
                '            await option.dispose();',
                '        }',
                '    }',
            );
            continue;
        }
        if (target && creates.has(action)) {
            statements.push(
                '    {',
                `        const result = await verifyCreateClick(page, () => ${target}.click(), readCreateState, compareCreateStates, ${JSON.stringify(ui)});`,
                "        test.skip(result.status === '未验证', result.reason);",
                "        expect(result.status, result.reason).toBe('通过');",
                '    }',
            );
            continue;
        }
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
            statements.push(
                `    throw new Error(${JSON.stringify(recordedReviewPrefix + reason)});`,
            );
            continue;
        }
        let argument = action.value;
        if (action.kind === 'press') argument = action.key;
        if (action.kind === 'select') argument = { label: action.value };
        statements.push(`    await ${target}.${method}(${JSON.stringify(argument) ?? ''});`);
    }
    return [...statements, '});', ''].join('\n');
}
