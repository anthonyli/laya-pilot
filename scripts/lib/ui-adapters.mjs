import fs from 'node:fs/promises';
import { antDesign, tntd } from './ui-adapter-ant.mjs';
import { element } from './ui-adapter-element.mjs';
import { cardTitleSelector } from './recorded-card.mjs';

const semanticDialog = 'dialog[open],[role="dialog"],[role="alertdialog"]';
const builtinAdapters = [
    { name: 'html', table: { pagination: '[aria-label="pagination" i]' } },
    antDesign,
    tntd,
    element,
];
const groups = {
    form: ['item', 'label'],
    select: ['shell', 'trigger', 'popup', 'option', 'ignore'],
    table: ['wrapper', 'pagination', 'name', 'id'],
};

export async function loadUiAdapter(file) {
    if (!file) return [];
    const adapter = JSON.parse(await fs.readFile(file, 'utf8'));
    resolveUiAdapters([adapter]);
    return [adapter];
}

export async function validateUiAdapterSelectors(page, adapters = []) {
    if (!adapters.length) return;
    const invalid = await page.evaluate((definitions) => {
        for (const { name, ...groups } of definitions) {
            for (const [group, value] of Object.entries(groups)) {
                const selectors =
                    typeof value === 'string'
                        ? [[group, value]]
                        : Object.entries(value).map(([key, selector]) => [
                              group + '.' + key,
                              selector,
                          ]);
                for (const [key, selector] of selectors) {
                    try {
                        document.querySelector(selector);
                    } catch {
                        return name + '.' + key;
                    }
                }
            }
        }
    }, adapters);
    if (invalid) throw Error(`UI 适配器的 CSS 选择器无效：${invalid}`);
}

// Merge only selectors. Locating, ordering actions and verifying their effects stay in the engine.
export function resolveUiAdapters(adapters = []) {
    if (!Array.isArray(adapters)) throw Error('UI 适配器列表必须是数组。');
    const combined = [...builtinAdapters, ...adapters];
    const names = new Set();
    for (const adapter of combined) {
        if (
            !adapter ||
            typeof adapter.name !== 'string' ||
            !adapter.name.trim() ||
            names.has(adapter.name)
        )
            throw Error('每个 UI 适配器必须提供唯一的 name。');
        names.add(adapter.name);
        for (const [key, value] of Object.entries(adapter)) {
            if (key === 'name') continue;
            if (key === 'cardTitle' || key === 'dialog') {
                validateSelector(value, key);
            } else if (
                Object.hasOwn(groups, key) &&
                value &&
                typeof value === 'object' &&
                !Array.isArray(value)
            ) {
                for (const [part, selector] of Object.entries(value)) {
                    if (!groups[key].includes(part))
                        throw Error(`未知 UI 适配器字段 ${key}.${part}`);
                    validateSelector(selector, `${key}.${part}`);
                }
            } else throw Error(`未知 UI 适配器字段 ${key}`);
        }
    }
    function collect(key, part) {
        const selectors = combined.map((adapter) => (part ? adapter[key]?.[part] : adapter[key]));
        return [...new Set(selectors.filter(Boolean))].join(',');
    }
    const result = {};
    for (const [group, keys] of Object.entries(groups))
        result[group] = Object.fromEntries(keys.map((key) => [key, collect(group, key)]));
    const customDialogs = collect('dialog');
    result.dialog = `${semanticDialog},:is(${customDialogs}):not(:is(${semanticDialog}) *):not(:has(${semanticDialog}))`;
    result.cardTitle = [cardTitleSelector, collect('cardTitle')].filter(Boolean).join(',');
    return result;
}

function validateSelector(value, key) {
    if (typeof value !== 'string' || !value.trim())
        throw Error(`UI 适配器字段 ${key} 需要非空 CSS 选择器。`);
}
