import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const maximumActions = 300;
const observationMs = 2200;
const minimumObservationMs = 600;
const sensitive =
    /pass(?:word|wd)?|token|secret|api.?key|cookie|authorization|密码|口令|密钥|验证码/i;

function recordableUrl(value, origin) {
    try {
        const url = new URL(value);
        if (url.origin !== origin || url.username || url.password) return '';
        if ([...url.searchParams.keys()].some((key) => sensitive.test(key))) return '';
        if (
            /auth|callback|signin|sso/i.test(url.pathname) &&
            (url.searchParams.has('code') || url.searchParams.has('state'))
        )
            return '';
        if (sensitive.test(url.hash.split('?')[1] || '')) return '';
        return url.href;
    } catch {
        return '';
    }
}

// This function is serialized into the recording browser by Playwright.
function installRecorder({ origin, binding, snapshotKey }) {
    if (location.origin !== origin) return;
    const actionControls =
        'button, a[href], input:not([type=hidden]), textarea, select, summary, [contenteditable=true], [role=button], [role=link], [role=tab], [role=checkbox], [role=radio], [role=switch], [role=menuitem], [role=option], [role=combobox]';
    const tableSelector = 'table, [role=table], [role=grid], [role=treegrid]';
    const rowSelector = 'tr, [role=row]';
    const cellSelector = 'td, [role=cell], [role=gridcell], [role=rowheader]';
    const dialogSelector = 'dialog[open], [role=dialog], [role=alertdialog]';
    const maximumRows = 30;
    const toolAttribute = 'data-laya-recording-tools';
    const secretField =
        /pass(?:word|wd)?|token|secret|api.?key|cookie|authorization|密码|口令|密钥|验证码/i;
    const labelled = (element, attribute) =>
        (element.getAttribute(attribute) || '')
            .split(/\s+/)
            .map((id) => visibleText(element.getRootNode().getElementById(id)))
            .filter(Boolean)
            .join(' ');
    function text(value) {
        return (value || '').trim().replace(/\s+/g, ' ').slice(0, 180);
    }
    function visibleText(element) {
        return text(element?.innerText || element?.textContent);
    }
    function visible(element) {
        return (
            element.getClientRects().length > 0 &&
            getComputedStyle(element).visibility === 'visible' &&
            !element.closest('[aria-hidden=true], [inert]')
        );
    }
    function visibleElements(scope, selector) {
        return [...scope.querySelectorAll(selector)].filter(visible);
    }
    function identify(element) {
        const tag = element.tagName.toLowerCase();
        const type = element.getAttribute('type') || '';
        const role =
            element.getAttribute('role') ||
            {
                a: 'link',
                button: 'button',
                summary: 'button',
                textarea: 'textbox',
                select: 'combobox',
                input: ['checkbox', 'radio'].includes(type)
                    ? type
                    : ['button', 'submit', 'reset'].includes(type)
                      ? 'button'
                      : 'textbox',
            }[tag] ||
            (element.isContentEditable ? 'textbox' : '');
        const label = text(
            [...(element.labels || [])].map(visibleText).join(' ') ||
                labelled(element, 'aria-labelledby') ||
                element.getAttribute('aria-label'),
        );
        const placeholder = text(element.getAttribute('placeholder'));
        const field = ['textbox', 'combobox'].includes(role);
        const name =
            label ||
            (field ? placeholder : visibleText(element)) ||
            text(element.getAttribute('title')) ||
            (tag === 'input' && role === 'button' ? text(element.value) : '');
        if (!role || !name) return null;
        const locator = field && label ? 'label' : field && placeholder ? 'placeholder' : 'role';
        return { role, name, locator };
    }
    function privateField(element, target) {
        return (
            ['password', 'file', 'hidden'].includes(element.type) ||
            /(?:current-password|new-password|one-time-code|cc-)/i.test(
                element.autocomplete || '',
            ) ||
            secretField.test(target?.name || '') ||
            secretField.test(element.name || '')
        );
    }
    function headers(table) {
        return visibleElements(table, 'th:not([scope=row]), [role=columnheader]')
            .filter((element) => element.closest(tableSelector) === table)
            .slice(0, 10)
            .map(visibleText);
    }
    function rowCells(row, names) {
        return visibleElements(row, cellSelector)
            .filter((element) => element.closest(rowSelector) === row)
            .slice(0, 10)
            .map((element, index) =>
                secretField.test(names[index] || '') ? '' : visibleText(element),
            );
    }
    function scopeName(element) {
        return (
            labelled(element, 'aria-labelledby') ||
            text(element.getAttribute('aria-label')) ||
            visibleText(element.querySelector('caption, h1, h2, h3, [role=heading]'))
        );
    }
    function moduleHeading(table, headings) {
        if (!table) return '';
        for (let parent = table.parentElement; parent; parent = parent.parentElement) {
            const heading = headings.findLast(
                (candidate) =>
                    parent.contains(candidate) &&
                    candidate.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING,
            );
            if (heading) return visibleText(heading);
        }
        return '';
    }
    function state() {
        const tables = visibleElements(document, tableSelector);
        const headings = visibleElements(document, 'h1, h2, h3, [role=heading]').slice(0, 12);
        const currentModule = tables.length === 1 ? moduleHeading(tables[0], headings) : '';
        const rows = [];
        let rowsComplete =
            tables.length <= 3 &&
            !visibleElements(
                document,
                '.ant-pagination, .el-pagination, [aria-label="pagination" i], [aria-label="分页"]',
            ).length;
        for (const table of tables.slice(0, 3)) {
            const names = headers(table);
            const dataRows = visibleElements(table, rowSelector).filter(
                (row) => row.closest(tableSelector) === table && row.querySelector(cellSelector),
            );
            if (dataRows.length + rows.length > maximumRows) rowsComplete = false;
            const rowCount = Number(table.getAttribute('aria-rowcount'));
            if (rowCount < 0 || rowCount > dataRows.length + 1) rowsComplete = false;
            const scope = scopeName(table);
            for (const row of dataRows.slice(0, maximumRows - rows.length)) {
                const cells = rowCells(row, names);
                rows.push({
                    text: cells.filter(Boolean).join(' '),
                    cells,
                    ...(scope && { scope }),
                });
            }
        }
        const messages = visibleElements(
            document,
            '[role=alert], [role=status], [aria-live=polite], [aria-live=assertive], .ant-message-notice, .el-message',
        )
            .slice(0, 16)
            .map((element) => ({
                role: element.getAttribute('role') || 'status',
                text: visibleText(element),
            }))
            .filter((message) => message.text);
        return {
            url: location.href,
            tableCount: tables.length,
            headers: tables.length === 1 ? headers(tables[0]) : [],
            rows,
            rowsComplete,
            dialogs: visibleElements(document, dialogSelector).slice(0, 4).map(scopeName),
            messages,
            fields: visibleElements(document, 'input:not([type=hidden]), textarea, select')
                .slice(0, 30)
                .map((element) => ({ element, target: identify(element) }))
                .filter(({ element, target }) => target && !privateField(element, target))
                .map(({ element, target }) => ({
                    name: target.name,
                    ...(entered.has(element) && {
                        value: String(element.value || '').slice(0, 500),
                    }),
                })),
            headings: [...new Set([currentModule, ...headings.map(visibleText)].filter(Boolean))],
            selectedTabs: visibleElements(document, '[role=tab][aria-selected=true]')
                .map((element) => identify(element)?.name)
                .filter(Boolean)
                .slice(0, 12),
            errors: messages
                .filter((message) =>
                    /失败|错误|无效|error\b|failed|invalid|denied/i.test(message.text),
                )
                .map((message) => message.text),
        };
    }
    const entered = new WeakSet();
    const beforeInput = new WeakMap();
    function targetFor(element) {
        const target = identify(element);
        if (!target) return null;
        if (target.role === 'textbox') {
            const pattern = element.getAttribute('pattern');
            if (element.type) target.inputType = element.type;
            if (element.maxLength > 0) target.maxLength = element.maxLength;
            if (pattern && pattern.length <= 180) target.pattern = pattern;
        }
        const table = element.closest(tableSelector);
        const row = element.closest(rowSelector);
        if (table && row) {
            const names = headers(table);
            const rowLabel = rowCells(row, names)[0];
            const matching =
                rowLabel &&
                names[0] &&
                !/^(?:#|no\.?|序号|行号)$/i.test(names[0]) &&
                visibleElements(table, rowSelector).filter(
                    (entry) =>
                        entry.closest(tableSelector) === table &&
                        rowCells(entry, names)[0] === rowLabel,
                );
            if (matching?.length === 1) {
                target.row = rowLabel;
                target.rowHeader = names[0];
            } else target.rowAmbiguous = true;
            const scope = scopeName(table);
            if (scope) target.scope = scope;
        } else {
            const dialog = element.closest(dialogSelector);
            if (dialog) target.scope = '弹窗';
        }
        return target;
    }
    function emit(action, before = state()) {
        void globalThis[binding]({ ...action, before }).catch(() => {});
    }
    function record(action, element, before) {
        const target = targetFor(element);
        if (!target || target.rowAmbiguous) {
            emit({ kind: 'unsupported', reason: '操作目标缺少唯一可回放的名称或记录。' }, before);
        } else emit({ ...action, target }, before);
    }
    globalThis[snapshotKey] = state;
    if (window !== window.top) {
        addEventListener(
            'click',
            (event) => {
                if (event.isTrusted)
                    emit({ kind: 'unsupported', reason: '当前录制无法定位内嵌页面的操作。' });
            },
            true,
        );
        return;
    }
    let mark = null;
    let lastEnter = -1000;
    addEventListener(
        'click',
        (event) => {
            if (!event.isTrusted) return;
            if (event.detail === 0 && performance.now() - lastEnter < 100) return;
            const path = event.composedPath().filter((item) => item instanceof Element);
            if (path.some((element) => element.hasAttribute(toolAttribute))) return;
            const element = path.find((item) => item.matches(actionControls));
            if (mark?.getAttribute('aria-pressed') === 'true') {
                event.preventDefault();
                event.stopImmediatePropagation();
                mark.setAttribute('aria-pressed', 'false');
                mark.textContent = '添加检查点';
                const field =
                    element?.matches('input, textarea, select') &&
                    !privateField(element, identify(element));
                if (field) {
                    record(
                        {
                            kind: 'assert',
                            assertion: 'value',
                            value: String(element.value || '').slice(0, 500),
                        },
                        element,
                    );
                } else if (!element || !privateField(element, identify(element))) {
                    const label = visibleText(path[0]);
                    if (label)
                        emit({
                            kind: 'assert',
                            assertion: 'visible',
                            target: { role: 'text', name: label, locator: 'text' },
                        });
                }
                return;
            }
            if (!element) {
                if (
                    path.some(
                        (item) =>
                            item.matches('[tabindex], [onclick]') ||
                            getComputedStyle(item).cursor === 'pointer',
                    )
                )
                    emit({ kind: 'unsupported', reason: '可点击元素没有可识别的控件角色。' });
                return;
            }
            // Native fields are represented by their eventual change. Sensitive fields never emit values.
            if (
                element.matches(
                    'input:not([type=button]):not([type=submit]):not([type=reset]), textarea, select, [contenteditable=true]',
                )
            )
                return;
            record({ kind: 'click' }, element);
        },
        true,
    );
    addEventListener(
        'beforeinput',
        (event) => {
            const element = event.composedPath()[0];
            if (
                event.isTrusted &&
                element instanceof Element &&
                !privateField(element, identify(element))
            )
                beforeInput.set(element, state());
        },
        true,
    );
    addEventListener(
        'input',
        (event) => {
            if (!event.isTrusted) return;
            const element = event.composedPath()[0];
            if (
                !(element instanceof Element) ||
                !element.matches('input, textarea, [contenteditable=true]')
            )
                return;
            if (element.matches('input[type=checkbox], input[type=radio], input[type=range]'))
                return;
            if (privateField(element, identify(element))) {
                emit({
                    kind: 'unsupported',
                    reason: '敏感输入或文件操作需要独立的测试数据配置。',
                });
                return;
            }
            const before = beforeInput.get(element);
            beforeInput.delete(element);
            entered.add(element);
            const value = element.isContentEditable ? element.innerText : element.value;
            if (typeof value === 'string' && value.length <= 500)
                record({ kind: 'fill', value }, element, before);
            else emit({ kind: 'unsupported', reason: '输入内容超出可回放范围。' }, before);
        },
        true,
    );
    addEventListener(
        'change',
        (event) => {
            if (!event.isTrusted) return;
            const element = event.composedPath()[0];
            if (!(element instanceof Element) || privateField(element, identify(element))) return;
            if (element.matches('select')) {
                if (element.multiple) emit({ kind: 'unsupported', reason: '暂不支持多选下拉框。' });
                else
                    record(
                        { kind: 'select', value: visibleText(element.selectedOptions[0]) },
                        element,
                    );
            } else if (element.matches('input[type=checkbox], input[type=radio]')) {
                record({ kind: element.checked ? 'check' : 'uncheck' }, element);
            } else if (element.matches('input[type=range]'))
                emit({ kind: 'unsupported', reason: '暂不支持滑块。' });
        },
        true,
    );
    addEventListener(
        'keydown',
        (event) => {
            if (!event.isTrusted || event.altKey || event.metaKey || event.ctrlKey) return;
            if (!['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
            const element = event.composedPath()[0];
            if (!(element instanceof Element) || element.closest(`[${toolAttribute}]`)) return;
            if (element.matches('select') && event.key !== 'Tab') return;
            if (
                event.key === 'Enter' &&
                element.matches('button, a[href], input[type=submit], input[type=button]')
            )
                return;
            const target = identify(element);
            if (target && !privateField(element, target)) {
                if (event.key === 'Enter') lastEnter = performance.now();
                record({ kind: 'press', key: event.key }, element);
            } else if (event.key === 'Escape') emit({ kind: 'press', key: event.key });
        },
        true,
    );
    function showTools() {
        const host = document.createElement('aside');
        host.setAttribute(toolAttribute, '');
        const view = host.attachShadow({ mode: 'open' });
        view.innerHTML = `<style>
            :host{position:fixed;right:12px;bottom:12px;z-index:2147483647;display:flex;gap:6px;padding:6px;border:1px solid #536475;border-radius:8px;background:#142338;color:white}
            button{border:1px solid #8293a4;border-radius:5px;padding:6px 9px;background:#142338;color:white;font:13px system-ui;cursor:pointer}
            button[aria-pressed=true],button:last-child{background:#fff;color:#142338}
        </style><button type="button" aria-pressed="false">添加检查点</button><button type="button">完成录制</button>`;
        [mark] = view.querySelectorAll('button');
        mark.addEventListener('click', () => {
            const active = mark.getAttribute('aria-pressed') !== 'true';
            mark.setAttribute('aria-pressed', String(active));
            mark.textContent = active ? '点击要检查的内容' : '添加检查点';
        });
        view.querySelector('button:last-child').addEventListener('click', () =>
            emit({ kind: 'stop' }),
        );
        const placeTools = () => {
            const parent = document.querySelector('dialog:modal') || document.body;
            if (host.parentElement !== parent) parent.append(host);
        };
        placeTools();
        new MutationObserver(placeTools).observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['open'],
        });
    }
    if (document.body) showTools();
    else addEventListener('DOMContentLoaded', showTools, { once: true });
}

export async function captureRecording({
    playwright,
    url,
    channel,
    storageState,
    onReady,
    headless = false,
}) {
    const address = new URL(url);
    const origin = address.origin;
    if (!['http:', 'https:'].includes(address.protocol) || !recordableUrl(address.href, origin))
        throw Error('录制需要同源 HTTP(S) 地址，地址中不能有账号或令牌。');
    const suffix = randomBytes(8).toString('hex');
    const binding = `__layaRecord_${suffix}`;
    const snapshotKey = `__layaSnapshot_${suffix}`;
    const browser = await playwright.chromium.launch({ headless, ...(channel && { channel }) });
    const actions = [];
    const requestActions = new WeakMap();
    const recentRequests = [];
    let wake;
    const stopped = new Promise((resolve) => {
        wake = resolve;
    });
    let ending = false;
    let addedNavigation = null;
    let active;
    let activeAt = 0;
    let job;
    function finish() {
        ending = true;
        wake();
    }
    function stateAt(value) {
        if (!value?.url || !recordableUrl(value.url, origin)) return null;
        return value;
    }
    try {
        const context = await browser.newContext({ ...(storageState && { storageState }) });
        const page = await context.newPage();
        const readState = async () =>
            stateAt(
                await page.evaluate((key) => globalThis[key]?.(), snapshotKey).catch(() => null),
            );
        const readSettledState = async (action) => {
            const begin = Date.now();
            const end = begin + observationMs;
            let previous = '';
            let stable = 0;
            while (active === action && !page.isClosed() && Date.now() < end) {
                await delay(120);
                if (active !== action || page.isClosed()) break;
                const state = await readState();
                if (!state || active !== action) continue;
                action.after = state;
                const signature = JSON.stringify(state);
                stable = signature === previous ? stable + 1 : 0;
                previous = signature;
                if (
                    Date.now() - begin >= minimumObservationMs &&
                    stable >= 2 &&
                    action.requests.every((request) => request.ok !== undefined)
                )
                    break;
            }
        };
        function append(action) {
            if (active && action.before) active.after = action.before;
            const requests = [];
            const previousAt = activeAt;
            active = { ...action, after: action.before, requests };
            activeAt = Date.now();
            for (const request of recentRequests.splice(0)) {
                if (Date.now() - request.at <= 60) requests.push(request.state);
            }
            const previous = actions.at(-1);
            const sameFill =
                action.kind === 'fill' &&
                previous?.kind === 'fill' &&
                activeAt - previousAt < 700 &&
                previous.before?.url === action.before?.url &&
                JSON.stringify(previous.target) === JSON.stringify(action.target);
            if (sameFill) {
                active.before = previous.before;
                active.requests = [...previous.requests, ...requests].slice(-16);
                actions[actions.length - 1] = active;
            } else actions.push(active);
            job = readSettledState(active);
        }
        browser.on('disconnected', finish);
        page.on('close', finish);
        context.on('request', (request) => {
            const kind = request.resourceType();
            if (!['fetch', 'xhr'].includes(kind) || !recordableUrl(request.url(), origin)) return;
            const state = { kind };
            requestActions.set(request, state);
            if (active?.requests.length < 16 && Date.now() - activeAt < observationMs)
                active.requests.push(state);
            else if (!active && recentRequests.length < 16)
                recentRequests.push({ at: Date.now(), state });
        });
        context.on('response', (response) => {
            const observed = requestActions.get(response.request());
            if (observed) Object.assign(observed, { ok: response.ok(), status: response.status() });
        });
        context.on('requestfailed', (request) => {
            const observed = requestActions.get(request);
            if (observed) observed.ok = false;
        });
        await context.exposeBinding(binding, ({ page: source, frame }, event) => {
            if (source !== page || ending || !event || JSON.stringify(event).length > 100000)
                return;
            const before = stateAt(event.before);
            if (!before) return;
            if (event.kind === 'stop' && frame === page.mainFrame()) {
                if (active) active.after = before;
                finish();
                return;
            }
            if (actions.length >= maximumActions) {
                append({
                    kind: 'unsupported',
                    reason: '录制已达到可保存的操作数量，请分段录制。',
                    before,
                });
                finish();
                return;
            }
            if (
                ![
                    'click',
                    'fill',
                    'press',
                    'check',
                    'uncheck',
                    'select',
                    'assert',
                    'unsupported',
                ].includes(event.kind)
            )
                return;
            if (frame !== page.mainFrame()) {
                append({ kind: 'unsupported', reason: '当前录制无法定位内嵌页面的操作。', before });
                return;
            }
            if (event.target?.rowAmbiguous) return;
            append({ ...event, before });
        });
        await context.addInitScript(installRecorder, { origin, binding, snapshotKey });
        await page.goto(address.href, { waitUntil: 'domcontentloaded' });
        const initial = await readState();
        if (!initial) throw Error('页面跳转到录制地址之外，无法开始录制。');
        append({ kind: 'goto', url: address.href, before: null });
        active.after = initial;
        page.on('framenavigated', (frame) => {
            if (frame !== page.mainFrame() || ending) return;
            const url = recordableUrl(frame.url(), origin);
            const linkedAction =
                Date.now() - activeAt < observationMs &&
                ['click', 'press', 'select'].includes(active?.kind)
                    ? active
                    : null;
            addedNavigation = (async () => {
                await delay(100);
                if (ending) return;
                if (!url) {
                    append({
                        kind: 'unsupported',
                        reason: '页面已离开本次录制的来源。',
                        before: active?.after,
                    });
                    return;
                }
                if (linkedAction === active) job = readSettledState(linkedAction);
                else if (!linkedAction) append({ kind: 'goto', url, before: active?.after });
            })();
        });
        page.on('popup', () => {
            if (!ending)
                append({
                    kind: 'unsupported',
                    reason: '当前录制无法回放新标签页。',
                    before: active?.after,
                });
        });
        await onReady?.(page);
        await stopped;
        await addedNavigation;
        await job;
        return { url: address.href, actions };
    } finally {
        await browser.close().catch(() => {});
    }
}
