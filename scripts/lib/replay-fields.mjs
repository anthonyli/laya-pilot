import { modelOrRules } from './replay-model.mjs';
import { randomInt } from 'node:crypto';
import { optionPurpose } from './test-data.mjs';
import { Halt } from './language.mjs';
import {
    recordedFormItem,
    recordedSelectSearch,
    recordedSelectTrigger,
} from './recorded-select.mjs';

// The model sees names and the requested purpose. Its result is always mapped back
// to one of the supplied live controls or options before the browser acts.
export async function chooseReplayName(laya, prompt, names, config, meta) {
    if (!laya?.choose) throw new Halt('缺少决策模型', '按用途选择需要 Laya 决策。');
    const options = new Map(
        names.map((name) => [
            meta.phase === 'dynamic-option'
                ? `${optionPurpose(name) || '其他可用选项'}（${name}）`
                : name,
            name,
        ]),
    );
    let stop = '停止';
    while (options.has(stop)) stop += '（无匹配）';
    const decision = await laya.choose(
        prompt,
        {
            ...Object.fromEntries(
                [...options].map(([key, name]) => [
                    key,
                    meta.phase === 'dynamic-option' ? name : `选择「${name}」`,
                ]),
            ),
            [stop]: '不执行',
        },
        meta,
    );
    const name = options.get(decision.choice);
    if (
        !name ||
        !(decision.probabilities?.[decision.choice] >= (config.minProbability ?? 0.68)) ||
        !(decision.margin >= (config.minMargin ?? 0.18))
    )
        throw new Halt('Laya选择不确定', `当前候选不能确定匹配目标：${prompt}`);
    return name;
}

function fieldLocator(scope, page, name, markup, kind) {
    if (kind === 'select') return recordedSelectTrigger(scope, page, name, markup);
    if (kind === 'native') {
        const select = scope.locator('select');
        return scope
            .getByLabel(name, { exact: true })
            .or(scope.getByRole('combobox', { name, exact: true }))
            .and(select)
            .or(recordedFormItem(scope, page, name, markup).locator('select'))
            .filter({ visible: true });
    }
    if (kind === 'search') return recordedSelectSearch(scope, page, name, markup);
    const options = { name, exact: true };
    const inputs =
        kind === 'number'
            ? 'input[type=number],input[role=spinbutton]'
            : 'input:not([type=hidden],[type=password],[type=checkbox],[type=radio],[type=file],[type=submit],[type=button]),textarea';
    return recordedFormItem(scope, page, name, markup)
        .locator(inputs)
        .or(scope.getByRole('textbox', options))
        .or(scope.getByRole('spinbutton', options))
        .or(scope.getByLabel(name, { exact: true }))
        .or(scope.getByPlaceholder(name, { exact: true }))
        .and(scope.locator(inputs))
        .filter({ visible: true });
}

export async function stillMatched(locator, handle) {
    return locator
        .evaluateAll((els, chosen) => els.length === 1 && els[0] === chosen, handle)
        .catch(() => false);
}

export async function resolveReplayField(
    scope,
    page,
    requested,
    kind,
    markup,
    laya,
    config,
    meta,
    previous,
) {
    const expected = config.labels?.[requested] || requested;
    let multipleDialogs = false;
    if (scope === page) {
        const dialog = page.locator(markup.dialog).filter({ visible: true });
        const count = await dialog.count();
        if (count === 1) scope = dialog;
        multipleDialogs = count > 1;
    }
    const locate = (name) => fieldLocator(scope, page, name, markup, kind);
    const available = (control) =>
        ['select', 'native'].includes(kind) ? control.isEnabled() : control.isEditable();
    const original = locate(expected);
    const preferModel = config.decisionStrategy === 'model-first';
    if (
        config.decisionStrategy === 'off' ||
        (!preferModel && (await original.count())) ||
        !laya?.choose ||
        multipleDialogs
    )
        return { locator: original, name: expected };
    if (
        !preferModel &&
        previous &&
        (await stillMatched(locate(previous.name), previous.handle)) &&
        (await available(locate(previous.name)))
    )
        return { ...previous, locator: locate(previous.name), reused: true };
    // Read labels in the original field's scope, then intersect them with the same
    // role-specific locator used for exact replay. Off-scope twins cannot be proposed.
    const labels = await scope
        .locator(`${markup.label},label,[aria-label],[aria-labelledby],[placeholder]`)
        .filter({ visible: true })
        .evaluateAll(
            (nodes, labelSelector) => [
                ...new Set(
                    nodes
                        .flatMap((el) => [
                            el.matches(labelSelector) ? el.innerText : '',
                            el.getAttribute('aria-label'),
                            el.getAttribute('placeholder'),
                            (el.getAttribute('aria-labelledby') || '')
                                .split(/\s+/)
                                .map((id) => el.getRootNode().getElementById(id)?.textContent || '')
                                .join(' '),
                        ])
                        .filter(Boolean)
                        .map((name) => name.trim().replace(/^\*\s*|\s*[:：]$/g, ''))
                        .filter((name) => name && name.length <= 130),
                ),
            ],
            `label,${markup.label}`,
        );
    const handles = new Map();
    try {
        for (const name of new Set([expected, ...labels])) {
            const matches = await locate(name).elementHandles();
            if (matches.length === 1 && (await available(matches[0])))
                handles.set(name, matches[0]);
            else await Promise.all(matches.map((handle) => handle.dispose()));
        }
        if (!handles.size || (!preferModel && (await original.count())))
            return { locator: original, name: expected };
        const choose = () =>
            chooseReplayName(
                laya,
                `操作「${expected}」${{ select: '下拉框', native: '下拉框', search: '搜索框', number: '数值输入框', text: '输入框' }[kind]}`,
                [...handles.keys()],
                config,
                { ...meta, phase: 'field-match', recorded_field: requested },
            );
        const name = preferModel ? await modelOrRules(choose, () => expected) : await choose();
        if (name === expected || (await original.count()))
            return { locator: original, name: expected };
        const locator = locate(name);
        if (!(await stillMatched(locator, handles.get(name))) || !(await available(locator)))
            throw new Halt('DOM已变化', `字段「${name}」在匹配期间发生变化。`);
        const handle = handles.get(name);
        handles.delete(name);
        return { locator, name, requested, matched: true, handle, original };
    } finally {
        await Promise.all([...handles.values()].map((handle) => handle.dispose()));
    }
}

// Native option elements are normally not layout-visible while the select is closed.
export async function chooseNativeOption(select, choose, useRecordedFallback, timeout = 4000) {
    const options = () =>
        select.evaluate((el) => {
            const options = [...el.options];
            const counts = new Map();
            for (const option of options)
                counts.set(option.label, (counts.get(option.label) || 0) + 1);
            return options
                .filter(
                    (o) =>
                        o.value &&
                        o.label &&
                        counts.get(o.label) === 1 &&
                        !o.matches(':disabled') &&
                        !o.closest('[hidden],[inert],[aria-disabled=true]') &&
                        getComputedStyle(o).display !== 'none' &&
                        getComputedStyle(o).visibility === 'visible' &&
                        (!o.parentElement.matches('optgroup') ||
                            getComputedStyle(o.parentElement).display !== 'none'),
                )
                .map((o) => o.label);
        });
    let names = await options();
    const deadline = Date.now() + timeout;
    while (!names.length && useRecordedFallback && Date.now() < deadline) {
        await select.page().waitForTimeout(50);
        names = await options();
    }
    if (!names.length && !useRecordedFallback)
        throw new Halt('没有可用选项', '当前下拉框没有唯一可选的有效值。');
    let value = names.length ? await choose(names) : undefined;
    const available = await options();
    if (!available.includes(value)) {
        if (!useRecordedFallback) throw new Halt('DOM已变化', `选项「${value}」已变化。`);
        value = useRecordedFallback();
        if (!available.includes(value))
            throw new Halt('没有可用选项', `当前下拉框也无法选择录制值「${value}」。`);
    }
    await select.selectOption({ label: value });
    if ((await select.evaluate(committedSelection, value)) !== 'matched')
        throw new Halt('选值未确认', `下拉框未确认选中「${value}」。`);
    return value;
}

// Only committed values exposed by the trigger count. Search text, placeholder
// text and options merely present in an open popup are not selection evidence.
export function committedSelection(el, expected) {
    const clean = (text) => (text || '').trim().replace(/\s+/g, ' ');
    const wanted = clean(typeof expected === 'string' ? expected : expected.value);
    const markers = [
        ...el.querySelectorAll(
            '.ant-select-selection-selected-value,.ant-select-selection-item,.ant-select-selection__choice__content,.tntd-rc-select-selection-item,.tntd-select-selection-item,.el-select__selected-item:not(.is-transparent),.ant-cascader-picker-label,.tntd-cascader-picker-label',
        ),
    ].filter((n) => n.getClientRects().length && getComputedStyle(n).visibility === 'visible');
    if (markers.length)
        return markers.some((n) => [n.innerText, n.title].some((v) => clean(v) === wanted))
            ? 'matched'
            : 'different';
    if (el instanceof HTMLSelectElement)
        return [...el.selectedOptions].some((o) => clean(o.label) === wanted)
            ? 'matched'
            : 'different';
    const input = el.matches('input[readonly]') ? el : el.querySelector('input[readonly]');
    if (input?.value) return clean(input.value) === wanted ? 'matched' : 'different';
    if (
        !el.querySelector(
            '[role=listbox],[role=option],[role=tree],[role=menu],input:not([readonly])',
        ) &&
        !(el instanceof HTMLInputElement)
    ) {
        const shown = clean(el.innerText);
        if (shown === wanted) return 'matched';
        if (
            typeof expected.before === 'string' &&
            el.getAttribute('aria-expanded') !== 'true' &&
            shown &&
            shown !== clean(expected.before)
        )
            return 'different';
    }
    return 'unknown';
}

export async function replayInteger(input, range) {
    const [lower, upper] = range;
    if (!Number.isSafeInteger(lower) || !Number.isSafeInteger(upper) || lower > upper)
        throw new Halt('测试数据范围无效', '整数范围需要有效的上下界。');
    const limits = await input.evaluate((el) => ({
        min: el.min,
        max: el.max,
        step: el.step,
        initial: el.defaultValue,
    }));
    const lo = Math.max(lower, limits.min ? Math.ceil(Number(limits.min)) : lower);
    const hi = Math.min(upper, limits.max ? Math.floor(Number(limits.max)) : upper);
    const step = limits.step === 'any' ? 1 : Number(limits.step || 1);
    const base = Number(limits.min || limits.initial || 0);
    // Number inputs can have fractional steps. Validate using the browser's own
    // step/base rules on a detached copy without firing any business input events.
    if (lo > hi || !Number.isSafeInteger(hi - lo + 1) || hi - lo + 1 >= 2 ** 48)
        throw new Halt('测试数据范围无效', '指定范围和页面允许的数值范围没有可生成的整数。');
    if (Number.isSafeInteger(step) && step > 0 && Number.isSafeInteger(base)) {
        const first = lo + ((((base - lo) % step) + step) % step);
        if (first <= hi)
            return String(first + step * randomInt(Math.floor((hi - first) / step) + 1));
    } else {
        const start = randomInt(hi - lo + 1);
        const valid = await input.evaluate(
            (el, { lo, hi, start }) => {
                const probe = el.cloneNode(false);
                for (let i = 0; i < Math.min(hi - lo + 1, 10000); i++) {
                    probe.value = String(lo + ((start + i) % (hi - lo + 1)));
                    if (probe.validity.valid) return probe.value;
                }
                return null;
            },
            { lo, hi, start },
        );
        if (valid !== null) return valid;
    }
    throw new Halt('测试数据范围无效', '没有找到同时满足用例范围和输入框步长的整数。');
}
