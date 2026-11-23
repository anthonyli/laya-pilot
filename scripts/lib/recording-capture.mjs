import {
    authRoute,
    findRecordingAuth,
    rememberRecordingAuth,
    loginPasswordSelector,
} from './recording-auth.mjs';
import {
    loadAuthState,
    restoreSessionStorage,
    ensureAuthentication,
    saveAuthState,
} from './auth-state.mjs';
import { randomBytes } from 'node:crypto';
import { resolveUiAdapters, validateUiAdapterSelectors } from './ui-adapters.mjs';
import { selectOptionName } from './ui-adapter-select.mjs';
import { formItemLabel, onlyExpandedSelect, selectSelectors } from './recorded-select.mjs';
import {
    navigationScope,
    iconClassPattern,
    iconOwner,
    declaredIconName,
} from './recorded-navigation.mjs';
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
function installRecorder(
    {
        origin,
        binding,
        snapshotKey,
        credentialBinding,
        credentialNonce,
        loginPasswordSelector,
        navigationScope,
        iconClassSource,
        dialogSelector,
        cardTitleSelector,
        selectMarkup,
    },
    iconOwner,
    declaredIconName,
    formItemLabel,
    onlyExpandedSelect,
    selectOptionName,
) {
    if (location.origin !== origin) return;
    const actionControls =
        'button, a[href], input:not([type=hidden]), textarea, select, summary, [contenteditable=true], [role=button], [role=link], [role=tab], [role=checkbox], [role=radio], [role=switch], [role=menuitem], [role=option], [role=combobox]';
    const tableSelector = 'table, [role=table], [role=grid], [role=treegrid]';
    const rowSelector = 'tr, [role=row]';
    const cellSelector = 'td, [role=cell], [role=gridcell], [role=rowheader]';
    const maximumRows = 30;
    const toolAttribute = 'data-laya-recording-tools';
    const otpField =
        /one[-_ ]?time|(?:^|[^a-z])(?:otp|mfa|2fa|totp)(?:[^a-z]|$)|verification.?code|authenticator.?code|captcha|验证码|动态(?:码|口令)/i;
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
    function namedDialogCard(element) {
        const dialog = element?.closest(dialogSelector);
        if (!dialog || visibleElements(document, dialogSelector).length !== 1) return null;
        const titles = visibleElements(dialog, cardTitleSelector);
        const clicked = titles.filter((title) => title.parentElement.contains(element));
        if (clicked.length !== 1 || getComputedStyle(clicked[0].parentElement).cursor !== 'pointer')
            return null;
        const name = visibleText(clicked[0]);
        if (
            !name ||
            name.length >= 180 ||
            titles.filter((title) => visibleText(title) === name).length !== 1
        )
            return null;
        return { role: 'button', locator: 'cardTitle', scope: '弹窗', name };
    }
    const iconToken = new RegExp(iconClassSource);
    const tooltipNames = () => visibleElements(document, '[role=tooltip]').map(visibleText);
    let hoveredIcon;
    let previousTips = [];
    addEventListener(
        'pointerover',
        (event) => {
            const el = event.composedPath()[0];
            if (!event.isTrusted || !(el instanceof Element)) return;
            const owner = iconOwner(el);
            if (owner !== hoveredIcon) {
                hoveredIcon = owner;
                previousTips = owner ? tooltipNames() : [];
            }
        },
        true,
    );
    function namedIcon(el) {
        const owner = iconOwner(el);
        if (!owner || !owner.contains(el) || text(owner.innerText)) return null;
        const tips = owner === hoveredIcon ? tooltipNames() : [];
        const label = declaredIconName(owner);
        const name =
            label && !/^(?:icon|图标)\s*[:：]/i.test(label)
                ? label
                : tips.length === 1 && !previousTips.includes(tips[0]) && tips[0];
        if (!name || name.length > 100 || /^(?:icon|图标)\s*[:：]/i.test(name)) return null;
        const nav = !!owner.closest(navigationScope) && !owner.closest(rowSelector);
        return targetFor(owner, {
            role: nav ? 'navigation' : 'button',
            name,
            locator: nav ? 'namedNavIcon' : 'namedIcon',
        });
    }
    function navigationIcon(clicked) {
        if (!clicked?.closest(navigationScope) || getComputedStyle(clicked).cursor !== 'pointer')
            return null;
        const icons = clicked.closest('svg')
            ? [clicked.closest('svg')]
            : visibleElements(clicked, 'svg');
        if (icons.length !== 1) return null;
        const tokens = [...icons[0].classList]
            .filter(
                (token) =>
                    iconToken.test(token) &&
                    /(?:menu|nav)/i.test(token) &&
                    !/(?:^|[-_])(?:active|hover|selected|disabled|focus)(?:$|[-_])/i.test(token),
            )
            .sort((a, b) => b.length - a.length);
        const iconClass = tokens.find(
            (token) => visibleElements(document, `${navigationScope} svg.${token}`).length === 1,
        );
        if (!iconClass) return null;
        const links = visibleElements(document, 'a[href], [role=link]');
        if (links.length > 160) return null;
        return { iconClass, visibleLinks: links.map((el) => identify(el)?.name) };
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
        if (
            element.matches('input[type=number],input[role=spinbutton]') &&
            !element.closest(tableSelector)
        ) {
            const item = element.closest(selectMarkup.item);
            const itemName = item && formItemLabel(element, selectMarkup);
            if (itemName) {
                const container = item.closest(dialogSelector) || document;
                if (
                    visibleElements(item, 'input[type=number],input[role=spinbutton]').length ===
                        1 &&
                    visibleElements(container, selectMarkup.item).filter(
                        (el) => formItemLabel(el, selectMarkup) === itemName,
                    ).length === 1
                )
                    return { role: 'spinbutton', name: itemName, locator: 'formNumber' };
                if (!label) return null;
            }
        }
        const field = ['textbox', 'combobox'].includes(role);
        const name =
            label ||
            (field ? placeholder : visibleText(element)) ||
            text(element.getAttribute('title')) ||
            (tag === 'input' && role === 'button' ? text(element.value) : '');
        if (!role || !name) return null;
        if (
            role === 'button' &&
            !label &&
            name === visibleText(element) &&
            element.querySelector('i[aria-label^="icon:" i], svg[aria-label^="icon:" i]')
        )
            return { role, name, locator: 'buttonText' };
        const locator = field && label ? 'label' : field && placeholder ? 'placeholder' : 'role';
        return { role, name, locator };
    }
    const knownPasswordFields = new WeakSet();
    addEventListener(
        'focusin',
        (event) => {
            if (event.target instanceof HTMLInputElement && event.target.type === 'password')
                knownPasswordFields.add(event.target);
        },
        true,
    );
    function passwordField(element) {
        return (
            element instanceof HTMLInputElement &&
            (knownPasswordFields.has(element) || element.matches(loginPasswordSelector))
        );
    }
    function privateField(element, target) {
        return (
            passwordField(element) ||
            ['file', 'hidden'].includes(element.type) ||
            /(?:current-password|new-password|one-time-code|cc-)/i.test(
                element.autocomplete || '',
            ) ||
            otpField.test(
                [element.id, element.name, target?.name, element.placeholder].join(' '),
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
    function targetFor(element, target = identify(element)) {
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
    let openedField;
    function comboboxName(element) {
        return text(
            labelled(element, 'aria-labelledby') ||
                element.getAttribute('aria-label') ||
                [...(element.labels || [])].map(visibleText).join(' ') ||
                element.getAttribute('title'),
        );
    }
    function recordSelectClick(clicked) {
        const option = clicked.closest(selectMarkup.option);
        if (
            option &&
            !option.matches('option') &&
            option.closest(selectMarkup.popup + ',[role=listbox]')
        ) {
            const field = openedField;
            openedField = null;
            const childControl = clicked.closest('button, a[href], input, [role=button]');
            if (childControl && childControl !== option && option.contains(childControl))
                return false;
            const optionName = selectOptionName;
            const name = optionName(option);
            if (!name || option.closest('[aria-disabled=true]')) return false;
            const popup = option.closest(selectMarkup.popup) || option.closest('[role=listbox]');
            if (
                visibleElements(popup, selectMarkup.option).filter((el) => optionName(el) === name)
                    .length !== 1
            ) {
                emit({
                    kind: 'unsupported',
                    reason: `展开列表中有多个同名选项「${name}」，无法唯一回放。`,
                });
                return true;
            }
            const target = targetFor(option, { role: 'option', name, locator: 'selectOption' });
            if (field && field.control.isConnected) {
                const aria = field.control.matches('[aria-controls],[aria-owns]')
                    ? field.control
                    : field.control.querySelector('[aria-controls],[aria-owns]');
                const owned = [aria?.getAttribute('aria-controls'), aria?.getAttribute('aria-owns')]
                    .filter(Boolean)
                    .join(' ')
                    .split(/\s+/)
                    .map((id) => id && document.getElementById(id))
                    .filter(Boolean);
                const uniquePopup =
                    !owned.length &&
                    onlyExpandedSelect(field.control) &&
                    visibleElements(document, selectMarkup.popup).length === 1 &&
                    popup.matches(selectMarkup.popup);
                if (
                    field.item?.contains(option) ||
                    uniquePopup ||
                    owned.some(
                        (node) => node === popup || popup.contains(node) || node.contains(option),
                    )
                ) {
                    target.field = field.target;
                    openedField = field;
                }
            }
            if (!target.field) {
                const scope =
                    option.closest(rowSelector) || option.closest(dialogSelector) || document;
                if (
                    visibleElements(scope, selectMarkup.option).filter(
                        (el) => optionName(el) === name,
                    ).length !== 1
                ) {
                    emit({
                        kind: 'unsupported',
                        reason: `多个列表含有「${name}」选项，无法确定所属字段。`,
                    });
                    return true;
                }
            }
            if (target.rowAmbiguous) return false;
            emit({ kind: 'click', target });
            return true;
        }
        openedField = null;
        const semantic = clicked.closest('[role=combobox]:not(select)');
        const button = clicked.closest('button,[role=button]');
        if (
            clicked.closest('select,option,[role=listbox],' + selectMarkup.popup) ||
            (button && button !== semantic) ||
            (selectMarkup.ignore && clicked.closest(selectMarkup.ignore))
        )
            return false;
        const shell = clicked.closest(selectMarkup.shell) || clicked.closest(selectMarkup.trigger);
        if (!shell) return false;
        const item = shell.closest(selectMarkup.item);
        const container = shell.closest(rowSelector) || shell.closest(dialogSelector) || document;
        const formName = item && formItemLabel(item, selectMarkup);
        const name = formName || (semantic && comboboxName(semantic));
        if (!name) {
            if (!semantic) return false;
            emit({ kind: 'unsupported', reason: '下拉框缺少可唯一回放的字段名称。' });
            return true;
        }
        const fields = visibleElements(container, selectMarkup.item).filter(
            (candidate) => formItemLabel(candidate, selectMarkup) === name,
        );
        const controls = visibleElements(container, selectMarkup.trigger).filter(
            (candidate) =>
                (candidate.matches('[role=combobox]') && comboboxName(candidate) === name) ||
                fields.some((field) => field.contains(candidate)),
        );
        if (controls.length !== 1 || !shell.contains(controls[0])) {
            emit({ kind: 'unsupported', reason: `字段「${name}」的下拉框无法唯一定位。` });
            return true;
        }
        const target = targetFor(controls[0], { role: 'combobox', name, locator: 'fieldSelect' });
        if (target.rowAmbiguous) {
            emit({ kind: 'unsupported', reason: `无法唯一定位「${name}」下拉框所在的行。` });
            return true;
        }
        emit({ kind: 'click', target });
        openedField = { control: controls[0], item, target };
        return true;
    }
    function emit(action, before = state()) {
        void globalThis[binding]({ ...action, before }).catch(() => {});
    }
    // Passwords travel only over the private binding. A committed field edit is staged
    // in memory before navigation. Only a trusted submission can claim that draft.
    const documentId = Array.from(crypto.getRandomValues(new Uint32Array(3))).join('-');
    let draft;
    let draftVersion = 0;
    function noteLogin(source, submitted, submitter) {
        if (!credentialBinding || !(source instanceof Element)) return;
        const form = source.form || source.closest('form');
        const scope = form || document;
        const secrets = visibleElements(scope, 'input').filter(
            (el) => passwordField(el) || /one-time-code/i.test(el.autocomplete),
        );
        if (!secrets.length || (!submitted && !source.matches('input'))) return;
        const passwords = secrets.filter(
            (el) =>
                passwordField(el) &&
                !otpField.test(
                    [el.id, el.name, el.autocomplete, el.placeholder, identify(el)?.name].join(' '),
                ),
        );
        const password = passwords.length === 1 ? passwords[0] : null;
        const login = /^(?:登\s*录|log\s*in|sign\s*in)$/i;
        const buttons = visibleElements(
            scope,
            'button,input[type=submit],input[type=button],[role=button]',
        );
        const named = buttons.filter((el) => login.test(identify(el)?.name || ''));
        const submit = submitter || (named.length === 1 ? named[0] : undefined);
        const purpose = [
            location.pathname,
            location.hash.split('?')[0],
            form?.getAttribute('action'),
            submit && identify(submit)?.name,
        ].join(' ');
        // Never mistake registration, password changes or a different form for a login.
        if (
            passwords.length > 1 ||
            secrets.some((el) => /new-password/i.test(el.autocomplete)) ||
            /sign[-_/ ]?up|register|registration|(?:reset|change|forgot|recover)[-_/ ]?(?:password|passwd)|(?:password|passwd)[-_/ ]?(?:reset|change)|注册|(?:重置|修改|找回)密码/i.test(
                purpose,
            ) ||
            (password?.form && password.form !== form) ||
            (!named.length &&
                !/login|signin|sign-in|登录/i.test(location.pathname + location.hash) &&
                password?.autocomplete !== 'current-password')
        )
            return;
        const fields = visibleElements(
            scope,
            'input:not([type]),input[type=text],input[type=email],input[autocomplete=username]',
        ).filter((el) => !privateField(el, identify(el)) && el.value);
        const accounts = fields.filter((el) =>
            /account|user|email|账号|账户|邮箱|用户名/i.test(
                [el.name, el.autocomplete, identify(el)?.name].join(' '),
            ),
        );
        const candidates = accounts.length ? accounts : fields;
        const field = candidates.length === 1 ? candidates[0] : null;
        if (!submitted && source !== password && source !== field) return;
        const account = field?.value;
        const value = password?.value;
        const send = (event) => {
            void globalThis[credentialBinding]({
                ...event,
                nonce: credentialNonce,
                documentId,
                url: location.href,
            }).catch(() => {});
        };
        let key;
        if (value && account) {
            if (
                !draft ||
                draft.password !== value ||
                draft.account !== account ||
                draft.field !== password
            ) {
                draft = { password: value, account, field: password, key: ++draftVersion };
                send({ kind: 'draft', key: draft.key, account, password: value });
            }
            key = draft.key;
        } else if (!submitted) {
            draft = undefined;
            send({ kind: 'discard' });
        }
        if (!submitted) return;
        const recipe = {};
        for (const [key, el] of Object.entries({ account: field, password, submit })) {
            if (!el) continue;
            const target = identify(el);
            if (
                !target?.name ||
                !['label', 'placeholder', 'role'].includes(target.locator) ||
                (value && target.name.includes(value))
            )
                continue;
            const peers = visibleElements(document, actionControls).filter((peer) => {
                const other = identify(peer);
                return (
                    other?.locator === target.locator &&
                    other.name === target.name &&
                    (target.locator !== 'role' || target.role === other.role)
                );
            });
            if (peers.length === 1)
                recipe[key] = {
                    kind: target.locator,
                    name: target.name,
                    ...(target.locator === 'role' && { role: target.role }),
                };
        }
        send({
            kind: 'submit',
            key,
            account,
            recipe,
            publicLabels: visibleElements(
                document,
                'a[href],[role=tab],h1,h2,[role=heading],button',
            )
                .slice(0, 64)
                .map((el) => text(el.getAttribute('aria-label') || el.textContent)),
        });
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
    addEventListener(
        'change',
        (event) => {
            if (event.isTrusted) noteLogin(event.target, false);
        },
        true,
    );
    addEventListener(
        'submit',
        (event) => {
            if (event.isTrusted) noteLogin(event.target, true, event.submitter);
        },
        true,
    );
    let mark = null;
    let lastEnter = -1000;
    // One placeholder per field edit; even the password length must stay private.
    const redactedInputs = new WeakSet();
    addEventListener('focusout', (event) => redactedInputs.delete(event.composedPath()[0]), true);
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
                    else emit({ kind: 'unsupported', reason: '检查点缺少可识别的文本。' });
                } else emit({ kind: 'unsupported', reason: '敏感控件的检查点需要独立配置。' });
                return;
            }
            if (
                /^(?:登\s*录|log\s*in|sign\s*in)$/i.test(
                    element ? identify(element)?.name || '' : visibleText(path[0]),
                )
            )
                noteLogin(element || path[0], true, element);
            if (recordSelectClick(path[0])) return;
            const controlName = element && identify(element)?.name;
            const icon =
                !controlName || /^(?:icon|图标)\s*[:：]/i.test(controlName)
                    ? namedIcon(path[0])
                    : null;
            if (
                icon &&
                !icon.rowAmbiguous &&
                (!element || element.matches('button, a, [role=button], [role=menuitem]'))
            ) {
                emit({ kind: 'click', target: icon });
                return;
            }
            if (!element) {
                // Native labels forward their click to the associated control.
                if (path[0]?.closest('label')?.control) return;
                const card = namedDialogCard(path[0]);
                if (card) {
                    emit({ kind: 'click', target: card });
                    return;
                }
                const candidate = navigationIcon(path[0]);
                emit({
                    kind: 'unsupported',
                    reason: '可点击元素没有可识别的控件角色。',
                    ...(candidate && { navigationCandidate: candidate }),
                });
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
            if (
                element.matches(
                    'input[type=checkbox], input[type=radio], input[type=range], input[type=file]',
                )
            )
                return;
            if (privateField(element, identify(element))) {
                if (redactedInputs.has(element)) return;
                redactedInputs.add(element);
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
            if (!(element instanceof Element)) return;
            if (element.matches('input[type=file]')) {
                emit({ kind: 'unsupported', reason: '文件操作需要独立的测试数据配置。' });
                return;
            }
            if (privateField(element, identify(element))) return;
            if (element.matches('select')) {
                if (element.multiple) {
                    emit({ kind: 'unsupported', reason: '暂不支持多选下拉框。' });
                    return;
                }
                const label = element.selectedOptions[0]?.label;
                if (
                    label === undefined ||
                    label.length > 500 ||
                    [...element.options].filter((option) => option.label === label).length !== 1
                ) {
                    emit({ kind: 'unsupported', reason: '无法按显示标签唯一回放下拉选项。' });
                    return;
                }
                record({ kind: 'select', value: label }, element);
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
            if (
                !(element instanceof Element) ||
                event
                    .composedPath()
                    .some((item) => item instanceof Element && item.hasAttribute(toolAttribute))
            )
                return;
            if (event.key === 'Enter')
                noteLogin(
                    element,
                    true,
                    element.matches('button,input[type=submit]') ? element : undefined,
                );
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
            :host{position:fixed;right:12px;top:12px;bottom:auto;z-index:2147483647;display:flex;gap:6px;padding:6px;border:1px solid #536475;border-radius:8px;background:#142338;color:white}
            :host([data-bottom]){top:auto;bottom:12px}
            button{border:1px solid #8293a4;border-radius:5px;padding:6px 9px;background:#142338;color:white;font:13px system-ui;cursor:pointer}
            button[aria-pressed=true],button:last-child{background:#fff;color:#142338}
        </style><button type="button" aria-pressed="false">添加检查点</button><button type="button" data-move></button><button type="button">完成录制</button>`;
        [mark] = view.querySelectorAll('button');
        const move = view.querySelector('[data-move]');
        const positionKey = binding + '_toolbarBottom';
        function setPosition(bottom) {
            host.toggleAttribute('data-bottom', bottom);
            move.textContent = bottom ? '移至顶部' : '移至底部';
        }
        setPosition(false);
        try {
            setPosition(sessionStorage.getItem(positionKey) === '1');
        } catch {
            /* Storage may be disabled in this page. */
        }
        move.addEventListener('click', () => {
            const bottom = !host.hasAttribute('data-bottom');
            setPosition(bottom);
            try {
                if (bottom) sessionStorage.setItem(positionKey, '1');
                else sessionStorage.removeItem(positionKey);
            } catch {
                /* Moving the toolbar still works without storage. */
            }
        });
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
    authRoot,
    user,
    authReset,
    authCheck,
    uiAdapters = [],
    onAuth = () => {},
    headless = false,
}) {
    const ui = resolveUiAdapters(uiAdapters);
    const address = new URL(url);
    const origin = address.origin;
    if (!['http:', 'https:'].includes(address.protocol) || !recordableUrl(address.href, origin))
        throw Error('录制需要同源 HTTP(S) 地址，地址中不能有账号或令牌。');
    const suffix = randomBytes(8).toString('hex');
    const binding = `__layaRecord_${suffix}`;
    const snapshotKey = `__layaSnapshot_${suffix}`;
    const credentialBinding = authRoot
        ? `__layaLogin_${randomBytes(16).toString('hex')}`
        : undefined;
    const credentialNonce = credentialBinding && randomBytes(24).toString('hex');
    const browser = await playwright.chromium.launch({ headless, ...(channel && { channel }) });
    const actions = [];
    const requestActions = new WeakMap();
    const recentRequests = [];
    let wake;
    const stopped = new Promise((resolve) => {
        wake = resolve;
    });
    let ending = false;
    let active;
    let activeAt = 0;
    let job;
    let authTimer;
    let entryUrl = address.href;
    let account;
    function finish() {
        ending = true;
        wake();
    }
    function stateAt(value) {
        if (!value?.url || !recordableUrl(value.url, origin)) return null;
        return value;
    }
    try {
        const cached =
            authRoot &&
            !storageState &&
            !authReset &&
            (await findRecordingAuth(authRoot, url, user));
        let saved =
            cached &&
            (await loadAuthState({ url, user: cached.account, authState: cached.authState }));
        let context = await browser.newContext({
            storageState: saved?.storageState ?? storageState,
        });
        if (saved) await restoreSessionStorage(context, saved, { authSessionStorage: true });
        let page = await context.newPage();
        await validateUiAdapterSelectors(page, uiAdapters);
        if (saved) {
            const info = cached.info;
            await page.goto(info.landingUrl, { waitUntil: 'domcontentloaded' });
            const valid = await ensureAuthentication(
                page,
                {
                    url: info.landingUrl,
                    authCheck: info.check,
                    pageTimeout: 5000,
                    credentialRoot: authRoot,
                    authAccount: cached.account,
                    authState: cached.authState,
                    recordedLogin: info,
                    authSessionStorage: true,
                },
                null,
                null,
                true,
            ).then(
                () => true,
                () => false,
            );
            if (valid) {
                if (authRoute(entryUrl) === info.loginUrl) entryUrl = info.landingUrl;
                await saveAuthState(context, page, {
                    url,
                    authState: cached.authState,
                    authAccount: cached.account,
                    authSessionStorage: true,
                    recordedLogin: info,
                });
                account = cached.account;
                onAuth('已验证并复用此站点的登录态。');
            } else {
                saved = null;
                await context.close();
                context = await browser.newContext();
                page = await context.newPage();
                onAuth('此站点的登录态已失效，请在浏览器中重新登录。');
            }
        }
        let attempt = !saved && user && authCheck ? { url, account: user } : null;
        let draft;
        let saving;
        let saveError;
        const persistLogin = () => {
            if (!attempt || !authRoot) return;
            if (saving) return saving;
            const pending = attempt;
            saving = rememberRecordingAuth(
                authRoot,
                context,
                page,
                pending,
                authCheck,
                () => attempt === pending,
            )
                .then((ok) => {
                    if (ok && attempt === pending) {
                        attempt = undefined;
                        draft = undefined;
                        account = pending.account;
                        onAuth('已保存此站点和账号的登录态。');
                    }
                })
                .catch((error) => {
                    saveError = error;
                })
                .finally(() => {
                    saving = undefined;
                });
            return saving;
        };
        if (authRoot) authTimer = setInterval(persistLogin, 350);
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
        if (credentialBinding) {
            await context.exposeBinding(credentialBinding, ({ page: source, frame }, event) => {
                if (
                    source !== page ||
                    event?.nonce !== credentialNonce ||
                    frame !== page.mainFrame() ||
                    ending ||
                    !recordableUrl(frame.url(), origin) ||
                    !recordableUrl(event?.url, origin) ||
                    typeof event.documentId !== 'string'
                )
                    return;
                if (event.kind === 'discard' || event.kind === 'draft') {
                    attempt = undefined;
                    draft = undefined;
                    if (
                        event.kind === 'draft' &&
                        typeof event.password === 'string' &&
                        event.password.length &&
                        event.password.length <= 4096 &&
                        typeof event.account === 'string' &&
                        event.account.length <= 256
                    )
                        draft = {
                            key: event.key,
                            documentId: event.documentId,
                            url: event.url,
                            account: event.account,
                            password: event.password,
                        };
                    return;
                }
                if (event.kind !== 'submit') return;
                const matching =
                    draft &&
                    draft.key === event.key &&
                    draft.documentId === event.documentId &&
                    draft.url === event.url &&
                    draft.account === event.account;
                // A second-factor form has no reusable password. Keep the first factor
                // pending until the site has actually authenticated the account.
                if (!event.account && attempt?.credentials) return;
                if (event.account || user) {
                    if (!attempt || attempt.account !== (event.account || user))
                        onAuth('已识别登录提交，正在验证登录结果。');
                    attempt = {
                        url: event.url,
                        account: event.account || user,
                        publicLabels: event.publicLabels,
                        ...(matching && {
                            credentials: {
                                password: draft.password,
                                ...(event.recipe?.account &&
                                    event.recipe?.password &&
                                    event.recipe?.submit && { recipe: event.recipe }),
                            },
                        }),
                    };
                }
            });
        }
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
            append({ ...event, before });
        });
        const recorderOptions = {
            credentialBinding,
            credentialNonce,
            loginPasswordSelector,
            origin,
            binding,
            snapshotKey,
            navigationScope,
            iconClassSource: iconClassPattern.source,
            dialogSelector: ui.dialog,
            cardTitleSelector: ui.cardTitle,
            selectMarkup: selectSelectors(ui),
        };
        await context.addInitScript({
            content: `(${installRecorder})(${JSON.stringify(recorderOptions)}, ${iconOwner}, ${declaredIconName}, ${formItemLabel}, ${onlyExpandedSelect}, ${selectOptionName})`,
        });
        await page.goto(entryUrl, { waitUntil: 'domcontentloaded' });
        const initial = await readState();
        if (!initial) throw Error('页面跳转到录制地址之外，无法开始录制。');
        append({ kind: 'goto', url: entryUrl, before: null });
        active.after = initial;
        page.on('framenavigated', (frame) => {
            if (frame !== page.mainFrame() || ending) return;
            const url = recordableUrl(frame.url(), origin);
            const followsAction =
                Date.now() - activeAt < observationMs &&
                ['click', 'press', 'select'].includes(active?.kind);
            if (!url) {
                append({
                    kind: 'unsupported',
                    reason: '页面已离开本次录制的来源。',
                    before: active?.after,
                });
            } else if (followsAction) {
                // A navigation can settle after the opener's first observation finished.
                job = readSettledState(active);
            } else {
                // Preserve the navigation's position even if the next document is clicked immediately.
                append({ kind: 'goto', url, before: active?.after });
            }
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
        await job;
        // Promote an anonymous icon only when the user's very next click follows a newly
        // revealed link. A CSS match on its own says nothing about what the click did.
        for (const [i, action] of actions.entries()) {
            const candidate = action.navigationCandidate;
            if (!candidate) continue;
            delete action.navigationCandidate;
            const next = actions[i + 1];
            if (
                next?.kind === 'click' &&
                next.target?.role === 'link' &&
                action.before?.url === next.before?.url &&
                !candidate.visibleLinks.includes(next.target.name)
            ) {
                action.kind = 'click';
                action.target = {
                    locator: 'navIcon',
                    role: 'navigation',
                    name: candidate.iconClass,
                    childLink: next.target.name,
                };
                delete action.reason;
            } else {
                action.reason = `导航图标「${candidate.iconClass}」的展开目标未确认。`;
            }
        }
        await persistLogin();
        if (attempt)
            onAuth(
                saveError
                    ? '写入登录态失败，请检查本地 .auth 目录。'
                    : '未验证到登录后的页面，本次未保存新的登录态。',
            );
        return {
            url: entryUrl,
            actions,
            ...(account && { account }),
            ...(uiAdapters.length && { uiAdapters }),
        };
    } finally {
        clearInterval(authTimer);
        await browser.close().catch(() => {});
    }
}
