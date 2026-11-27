import { selectOptionChoices } from './ui-adapter-select.mjs';
import {
    awaitReplayLogin,
    navigateReplayPage,
    pauseForReplayRedirect,
    runReplayOperation,
} from './interactive-replay.mjs';
import { randomInt } from 'node:crypto';
import { resolveNavigationMenu } from './replay-navigation.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { moduleRouteFor } from './project-config.mjs';
import { CaseDirectories, slug } from './run-layout.mjs';
import { resolveUiAdapters } from './ui-adapters.mjs';
import { replayEditorOperation } from './recorded-editor.mjs';
import {
    clickRecordedSelectTrigger,
    recordedSelectOption,
    selectSelectors,
} from './recorded-select.mjs';
import {
    chooseReplayName,
    chooseNativeOption,
    committedSelection,
    replayInteger,
    resolveReplayField,
    stillMatched,
} from './replay-fields.mjs';
import { addCreateVerification } from './recording-cases.mjs';
import {
    createExpectation,
    saveConfirmationButton,
    cancelConfirmationButton,
    needsSaveFollowup,
    readCreateState,
    compareCreateStates,
    verifyCreateClick,
} from './recorded-create.mjs';
import { verifyRecordedDestination } from './recorded-destination.mjs';
import { findDialogCard } from './recorded-card.mjs';
import {
    navigationIconSelector,
    navigationScope,
    findNamedIcon,
    iconOwner,
    declaredIconName,
} from './recorded-navigation.mjs';
import {
    eventLabel,
    HEALTH_EXPECTATIONS,
    OPTIONAL_API_EXPECTATION,
    observePageErrors,
    safeText,
    safeUrl,
} from './diagnostics.mjs';
import {
    Halt,
    isAreaSwitch,
    expectation,
    lines,
    variables,
    parseData,
    replayData,
    norm,
    quoted,
} from './language.mjs';
import { observe, target, settle, assertionTarget, discoverRowLabels } from './dom.mjs';
import { waitForReady, readTables } from './readiness.mjs';
import { configureControlBindings } from './control-bindings.mjs';
import { matchReplayTarget, modelOrRules } from './replay-model.mjs';
import { expandStep, semanticStep, scopeNames, approvalOperation } from './planner.mjs';
import { exactRecordRow, verifyExactRecord } from './exact-record.mjs';
import {
    inspectCase,
    compileExpectation,
    stepDiagnostic,
    assertionDiagnostic,
} from './case-diagnostics.mjs';
const writeName =
    /(?:删除|移除|保存|提交|新增|创建|修改|编辑|上线|下线|授权|发布|导入|发送|支付|购买|确定|确认|应用|delete|remove|save|submit|create|edit|publish|send|pay|buy|import|confirm|apply)/i;
const healthAssertions = new Map([
    ...Object.entries(HEALTH_EXPECTATIONS).map(([kind, text]) => [text, kind]),
    [OPTIONAL_API_EXPECTATION, 'api'],
]);

function healthAssertion(text, health, completed, pageObserved) {
    const kind = healthAssertions.get(text);
    const matching = {
        page: ['ui-error'],
        browser: ['pageerror', 'console', 'crash'],
        api: ['http', 'requestfailed', 'api-body'],
    }[kind];
    const events = health?.events.filter((event) => matching.includes(event.kind)) ?? [];
    if (events.length)
        return { text, kind, status: '失败', reason: events.map(eventLabel).join('；') };
    if (!health || !completed || (kind === 'page' && !pageObserved))
        return { text, kind, status: '未验证', reason: '未完成该项观察。' };
    if (health.truncated)
        return { text, kind, status: '未验证', reason: '错误事件已达到采集上限。' };
    if (text === OPTIONAL_API_EXPECTATION && !health.apiRequests)
        return { text, kind, status: '通过', reason: '本轮没有业务接口请求，未观察到请求失败。' };
    if (kind === 'api' && (!health.apiRequests || health.apiResponses < health.apiRequests))
        return {
            text,
            kind,
            status: '未验证',
            reason: health.apiRequests ? '有接口请求未观察到成功响应。' : '本轮未观察到接口请求。',
        };
    return {
        text,
        kind,
        status: '通过',
        reason:
            kind === 'api'
                ? `观察到 ${health.apiResponses} 条成功响应，未发现请求错误。`
                : '在已执行步骤中未检测到此类错误。',
    };
}

// Shared by the wait and the final assertion. Native tables use tbody rows;
// ARIA tables accepted by getByRole('table') use role=row. Header rows are not
// records. A structure that does not expose those rows is unverified — never 0.
function countRowsInTable(table) {
    const visible = (element) => {
        const box = element.getBoundingClientRect(),
            style = getComputedStyle(element);
        return (
            box.width > 0 &&
            box.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none'
        );
    };
    const uncountable = () => ({
        countable: false,
        reason: '表格结构无法按数据行计数，不能把未知结构当成0行',
    });
    if (table.shadowRoot) return uncountable();
    const native = table.tagName === 'TABLE';
    if (!native) {
        for (const element of [table, ...table.querySelectorAll('*')]) {
            if (!visible(element) || element.closest('[role="row"]')) continue;
            if (element.shadowRoot) return uncountable();
            const role = element.getAttribute('role');
            if (element.closest('[role="caption"]')) continue;
            const looseText = [...element.childNodes].some(
                (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim(),
            );
            if (looseText) return uncountable();
            if (element === table || role === 'rowgroup') continue;
            if (role || !element.querySelector('[role="row"]')) return uncountable();
        }
    }
    const rows = [...table.querySelectorAll(native ? 'tbody tr' : '[role="row"]')].filter(visible);
    const ownRows = rows.filter((row) => row.closest('table,[role="table"]') === table);
    if (rows.length > 0 && ownRows.length === 0) return uncountable();
    let count = 0;
    for (const row of ownRows) {
        const belongs = (selector) =>
            [...row.querySelectorAll(selector)].some(
                (element) => element.closest('tr,[role="row"]') === row,
            );
        if (belongs('td,[role="cell"],[role="gridcell"]')) {
            count += 1;
            continue;
        }
        if (belongs('th,[role="columnheader"],[role="rowheader"]')) continue;
        if (!native) return uncountable();
    }
    return { countable: true, count };
}

async function readVisibleRowCount(page, expected, timeout) {
    const deadline = Date.now() + timeout;
    for (;;) {
        const tables = page.getByRole('table').filter({ visible: true });
        if ((await tables.count()) !== 1)
            return {
                countable: false,
                reason: '存在多个表格，需要写明目标表格，不能猜测行数',
            };
        const counted = await tables.evaluate(countRowsInTable);
        if (!counted.countable || counted.count === expected || Date.now() >= deadline)
            return counted;
        await page.waitForTimeout(Math.min(50, Math.max(1, deadline - Date.now())));
    }
}

export class Engine {
    constructor(page, laya, config, diagnostics = null) {
        this.page = page;
        this.laya = laya;
        this.config = config;
        this.ui = resolveUiAdapters(config.uiAdapters);
        this.selectMarkup = { ...selectSelectors(this.ui), dialog: this.ui.dialog };
        this.fieldMatches = new Map();
        this.diagnostics = diagnostics;
        configureControlBindings(page, config.controlBindings);
        this.events = [];
        this.actions = 0;
        this.current = null;
        this.failures = [];
        this.navigationCount = 0;
        this.baselines = new Map();
        this.phase = 'setup';
        this.navFailureStart = 0;
        this.dirtyAreas = new Map();
        this.caseDirectories = new CaseDirectories();
        page.on('response', (r) => {
            if (!config.replayLoginActive && r.status() >= 400) {
                const u = new URL(r.url());
                this.failures.push({
                    case: this.current?.key,
                    path: u.pathname,
                    status: r.status(),
                    resourceType: r.request().resourceType(),
                });
            }
        });
    }
    async chooseTarget(name, kind = 'click', extras = {}) {
        const actual = this.config.labels?.[name] || name;
        if (actual !== name) console.log('  站点名称映射：' + name + ' → ' + actual);
        return target(this.page, this.laya, actual, {
            kind,
            decisionStrategy: this.config.decisionStrategy,
            meta: { case: this.current?.key, step: this.actions, original_target: name },
            minProbability: this.config.minProbability,
            minMargin: this.config.minMargin,
            ...extras,
        });
    }
    isWriteControl(control, step) {
        if (control.role === 'tab') return false;
        if (!this.exactRecord && isAreaSwitch(control) && step === `切换到「${control.name}」区域`)
            return false;
        return writeName.test(control.name);
    }
    guard(control, step) {
        if (!this.isWriteControl(control, step)) return;
        if (!this.config.allowWrite)
            throw new Halt(
                '写入未启用',
                `当前为只读执行，步骤涉及“${control.name}”；在专用测试环境使用--allow-write才能执行。`,
            );
        if (!writeName.test(step))
            throw new Halt('动作与用例不符', '模型选择写入操作，但原始步骤没有对应写入意图。');
    }
    async exactDialog() {
        const dialog = this.page.locator(this.ui.dialog).filter({ visible: true });
        const count = await dialog.count();
        if (count === 1) return dialog;
        if (count === 0) {
            await dialog
                .first()
                .waitFor({ state: 'visible', timeout: this.config.assertTimeout ?? 4000 })
                .catch(() => {});
            if ((await dialog.count()) === 1) return dialog;
        }
        throw new Halt('弹窗操作范围不明确', '当前页面没有唯一可见的目标弹窗');
    }
    async replayField(scope, requested, kind) {
        const key = JSON.stringify([kind, requested]);
        const previous = this.fieldMatches.get(key);
        const field = await resolveReplayField(
            scope,
            this.page,
            requested,
            kind,
            this.selectMarkup,
            this.laya,
            this.config,
            { case: this.current?.key, step: this.actions },
            previous,
        );
        if (!field.reused && previous) {
            this.fieldMatches.delete(key);
            await previous.handle.dispose();
        }
        if (field.matched) {
            field.kind = kind;
            this.fieldMatches.set(key, field);
            this.noteFieldMatch(requested, field.name);
        }
        return field;
    }
    noteFieldMatch(from, to) {
        this.events.push({
            phase: this.phase,
            action: 'field-match',
            from,
            to,
            note: `Laya 字段匹配：${from} → ${to}`,
        });
    }
    async chooseOption(field, goal, names, recordedFallback) {
        if (!goal) {
            const any = () => names[randomInt(names.length)];
            if (recordedFallback !== undefined || this.config.decisionStrategy !== 'model-first')
                return any();
            return modelOrRules(
                () =>
                    chooseReplayName(this.laya, '选择任一可用选项', names, this.config, {
                        case: this.current?.key,
                        step: this.actions,
                        phase: 'dynamic-option',
                        field,
                    }),
                any,
            );
        }
        return chooseReplayName(this.laya, `选择${goal}的选项`, names, this.config, {
            case: this.current?.key,
            step: this.actions,
            phase: 'dynamic-option',
            field,
            goal,
        });
    }
    noteOption(field, goal, value) {
        this.events.push({
            phase: this.phase,
            action: 'dynamic-option',
            field,
            value,
            note: `动态选值：${field} → ${value}（${goal || '任一可用选项'}）`,
        });
    }
    async directClick(
        name,
        step,
        {
            ordinal,
            scope,
            recordedRole,
            field,
            iconClass,
            role,
            optionGoal,
            recordedFallback,
            nextLink,
        } = {},
    ) {
        let found;
        if (scope === 'dialog' || this.exactRecord || recordedRole) {
            let container = this.page;
            let location = '页面';
            if (this.exactRecord) {
                if (ordinal || scope === 'dialog')
                    throw new Halt('记录操作范围不明确', '按列定位后的第一步须在该记录中执行');
                const { row, reason } = await exactRecordRow(this.page, this.exactRecord);
                if (!row) throw new Halt('无法唯一定位记录', reason);
                container = row;
                location = '目标记录';
            } else if (scope === 'dialog') {
                container = await this.exactDialog();
                location = '目标弹窗';
            } else if (this.rowKey && (await this.targetRow(name))) {
                const escaped = await this.page.evaluate((key) => CSS.escape(key), this.rowKey);
                container = this.page.locator(`[data-row-key=${escaped}]`);
                location = '目标记录';
            }
            let actual = recordedRole === 'navIcon' ? name : this.config.labels?.[name] || name;
            let roles = ['button', 'link', 'menuitem'];
            if (recordedRole === 'link' || recordedRole === 'option') roles = [recordedRole];
            if (recordedRole === 'area')
                roles = isAreaSwitch({ role: 'button', name: actual })
                    ? ['tab', ...roles]
                    : ['tab'];
            const preferModel = this.config.decisionStrategy === 'model-first';
            const meta = { case: this.current?.key, step: this.actions };
            if (
                preferModel &&
                [undefined, 'link', 'labelledButton', 'area'].includes(recordedRole)
            ) {
                const byName = (label) => {
                    const options = { name: label, exact: true };
                    const control =
                        recordedRole === 'labelledButton'
                            ? container
                                  .getByRole('button', options)
                                  .and(container.getByLabel(label, { exact: true }))
                            : roles
                                  .map((role) => container.getByRole(role, options))
                                  .reduce((a, b) => a.or(b));
                    return control.filter({ visible: true });
                };
                const snapshot = await observe(this.page);
                const eligible = snapshot.controls.filter(
                    (c) => roles.includes(c.role) && c.name && !c.disabled,
                );
                const names = [];
                for (const label of new Set([actual, ...eligible.map((c) => c.name)])) {
                    const scoped = byName(label);
                    if ((await scoped.count()) === 1 && (await scoped.isEnabled()))
                        names.push(label);
                    if (names.length === 7) break;
                }
                if (names.length) {
                    const preferred = await modelOrRules(
                        () =>
                            chooseReplayName(this.laya, step, names, this.config, {
                                ...meta,
                                phase: 'replay-target',
                            }),
                        () => actual,
                    );
                    if (preferred === actual || !(await byName(actual).count())) actual = preferred;
                }
            }
            const options = { name: actual, exact: true };
            const timeout = this.config.assertTimeout || 4000;
            let locator, opener, navigation;
            try {
                if (recordedRole === 'fieldSelect' || recordedRole === 'fieldOption') {
                    const resolved = await this.replayField(container, field || name, 'select');
                    opener = resolved.locator;
                    await opener.waitFor({ state: 'visible', timeout });
                    if (recordedRole === 'fieldSelect') {
                        actual = resolved.name;
                        locator = opener;
                    } else {
                        const chooseName =
                            optionGoal === undefined
                                ? preferModel
                                    ? async (names) => {
                                          if (names.includes(actual)) {
                                              const selected = await matchReplayTarget(
                                                  this.laya,
                                                  '选择选项',
                                                  actual,
                                                  names.map((name) => ({ name })),
                                                  this.config,
                                                  meta,
                                              );
                                              return selected.name;
                                          }
                                          return actual;
                                      }
                                    : undefined
                                : async (names) => {
                                      actual = await this.chooseOption(
                                          resolved.name,
                                          optionGoal,
                                          names,
                                          recordedFallback,
                                      );
                                      if (
                                          recordedFallback &&
                                          names.length === 1 &&
                                          actual === recordedFallback
                                      )
                                          optionGoal = '仅有录制值可选';
                                      return actual;
                                  };
                        locator = await recordedSelectOption(
                            this.page,
                            chooseName ? null : actual,
                            opener,
                            this.selectMarkup,
                            container,
                            timeout,
                            chooseName,
                            recordedFallback &&
                                (() => {
                                    optionGoal = '回退到录制值';
                                    actual =
                                        this.config.labels?.[recordedFallback] || recordedFallback;
                                    return actual;
                                }),
                        );
                        await locator.waitForElementState('visible', { timeout });
                        if (
                            !(await locator.isEnabled()) ||
                            (await locator.evaluate(
                                (el) =>
                                    !!el.closest(
                                        '[aria-disabled=true],:disabled,.is-disabled,.ant-select-item-option-disabled',
                                    ),
                            ))
                        )
                            throw new Halt('控件不可用', `选项「${actual}」已禁用。`);
                    }
                } else if (recordedRole === 'option') {
                    if (preferModel) {
                        const { names } = await selectOptionChoices(
                            this.page,
                            container,
                            null,
                            this.selectMarkup,
                        );
                        if (names.includes(actual))
                            actual = (
                                await matchReplayTarget(
                                    this.laya,
                                    '选择选项',
                                    actual,
                                    names.map((name) => ({ name })),
                                    this.config,
                                    meta,
                                )
                            ).name;
                    }
                    locator = await recordedSelectOption(
                        this.page,
                        actual,
                        null,
                        this.selectMarkup,
                        container,
                    );
                    await locator.waitForElementState('visible', { timeout });
                } else if (recordedRole === 'labelledButton') {
                    locator = container
                        .getByRole('button', options)
                        .and(container.getByLabel(actual, { exact: true }));
                    await locator.waitFor({ state: 'visible', timeout });
                } else if (recordedRole === 'cardTitle') {
                    if (preferModel) {
                        const titles = await container
                            .locator(this.ui.cardTitle)
                            .filter({ visible: true })
                            .allInnerTexts();
                        const names = titles.map((title) => title.trim()).filter(Boolean);
                        if (names.length) {
                            const chosen = await modelOrRules(
                                () =>
                                    chooseReplayName(this.laya, step, names, this.config, {
                                        ...meta,
                                        phase: 'replay-target',
                                    }),
                                () => actual,
                            );
                            if (!names.includes(actual)) actual = chosen;
                        }
                    }
                    locator = await findDialogCard(container, actual, this.ui.cardTitle);
                } else if (recordedRole === 'namedNavIcon') {
                    navigation = await resolveNavigationMenu(
                        this.page,
                        container.locator(navigationScope),
                        actual,
                        iconClass,
                        this.config,
                        this.laya,
                        { case: this.current?.key, step: this.actions },
                    );
                    ({ locator, actual } = navigation);
                    this.events.push({
                        phase: this.phase,
                        action: 'navigation-target',
                        from: name,
                        to: actual,
                        strategy: navigation.strategy,
                        ...(navigation.strategy === 'model' && {
                            note: `Laya 菜单匹配：${name} → ${actual}`,
                        }),
                    });
                } else if (recordedRole === 'namedIcon') {
                    locator = await findNamedIcon(
                        this.page,
                        container,
                        actual,
                        iconOwner,
                        declaredIconName,
                        timeout,
                        iconClass && navigationIconSelector(iconClass),
                    );
                } else {
                    locator = (
                        recordedRole === 'navIcon'
                            ? container.locator(navigationIconSelector(name))
                            : roles
                                  .map((role) => container.getByRole(role, options))
                                  .reduce((a, b) => a.or(b))
                    ).filter({ visible: true });
                    await locator.waitFor({ state: 'visible', timeout });
                }
            } catch (error) {
                if (recordedRole === 'fieldOption' || recordedRole === 'option')
                    await locator?.dispose();
                if (error instanceof Halt) throw error;
                throw new Halt(
                    (this.exactRecord ? '记录' : scope === 'dialog' ? '弹窗' : '页面') +
                        '操作范围不明确',
                    recordedFallback
                        ? `${location}的「${field}」下拉框没有可用的随机选项，录制值「${recordedFallback}」也不可选`
                        : optionGoal !== undefined
                          ? `${location}的「${field}」下拉框无法唯一定位可用选项`
                          : `${location}内无法唯一定位「${name}」`,
                );
            }
            found = {
                locator,
                opener,
                nextLink:
                    navigation && nextLink
                        ? container
                              .locator(navigationScope)
                              .getByRole('link', { name: nextLink, exact: true })
                              .filter({ visible: true })
                        : null,
                decision: navigation?.strategy === 'model',
                optionGoal,
                field,
                control: {
                    name: actual,
                    role: ['navIcon', 'namedNavIcon'].includes(recordedRole)
                        ? 'navigation'
                        : await locator.evaluate(
                              (el, role) =>
                                  el.getAttribute('role') ||
                                  (role === 'fieldSelect'
                                      ? 'combobox'
                                      : role === 'fieldOption' || role === 'option'
                                        ? 'option'
                                        : el.tagName === 'A'
                                          ? 'link'
                                          : 'button'),
                              recordedRole,
                          ),
                    href: await locator.getAttribute('href', { timeout }),
                },
            };
        } else {
            if (!ordinal) await this.revealRowMenu(name);
            const rowKey = ordinal ? undefined : await this.targetRow(name);
            found = await this.chooseTarget(name, 'click', {
                rowKey,
                ordinal,
                instruction: step,
                role: role || (/「[^」]+」按钮$/.test(step) ? 'button' : undefined),
            });
        }
        return this.clickTarget(found, step, recordedRole);
    }
    async clickTarget(found, step, recordedRole) {
        try {
            this.guard(found.control, step);
            if (this.pendingPreconditions?.length && this.isWriteControl(found.control, step))
                throw new Halt(
                    '前置条件未验证',
                    '业务写入前仍有未证明的前提：' + this.pendingPreconditions.join('；'),
                );
            if (found.control.href) {
                const u = new URL(found.control.href, this.page.url());
                if (!this.config.origins.includes(u.origin))
                    throw new Halt('目标地址超出测试范围', '链接不属于本次配置的测试站点。');
            }
            console.log(
                (found.decision ? '  Laya → ' : '  直接定位 → ') +
                    found.control.name +
                    ' [' +
                    found.control.role +
                    ']',
            );
            this.navFailureStart = this.failures.length;
            const previousLabel =
                recordedRole === 'fieldOption'
                    ? await found.opener.innerText({ timeout: 250 }).catch(() => undefined)
                    : undefined;
            const opensLink = found.nextLink && (await found.nextLink.count()) === 0;
            if (recordedRole === 'fieldSelect')
                await clickRecordedSelectTrigger(found.locator, this.selectMarkup);
            else await found.locator.click();
            this.exactRecord = null;
            // Confirmed controls can proceed as soon as the UI acknowledges the action.
            // Keep the configured pacing for explicit --delay and opaque controls.
            const state = async () => {
                if (opensLink && (await found.nextLink.count()) === 1) return 'matched';
                if (recordedRole === 'fieldOption')
                    return found.opener
                        .evaluate(
                            committedSelection,
                            { value: found.control.name, before: previousLabel },
                            { timeout: 250 },
                        )
                        .catch(() => 'unknown');
                if (recordedRole !== 'area' && recordedRole !== 'fieldSelect') return 'unknown';
                const active = await found.locator
                    .evaluate(
                        (el, role) =>
                            role === 'area'
                                ? el.getAttribute('aria-selected') === 'true'
                                : el.matches('[aria-expanded=true]') ||
                                  !!el.querySelector('[role=combobox][aria-expanded=true]'),
                        recordedRole,
                        { timeout: 250 },
                    )
                    .catch(() => false);
                return active ? 'matched' : 'unknown';
            };
            const delay =
                (await state()) === 'matched'
                    ? (this.config.confirmedDelay ?? this.config.delay)
                    : this.config.delay;
            await settle(this.page, delay);
            let selected = await state();
            if (recordedRole === 'fieldOption') {
                if (selected !== 'matched') {
                    await this.ready();
                    selected = await state();
                    if (
                        selected === 'different' ||
                        (found.optionGoal !== undefined && selected !== 'matched')
                    ) {
                        const until = Date.now() + (this.config.assertTimeout ?? 4000);
                        while (selected !== 'matched' && Date.now() < until) {
                            await this.page.waitForTimeout(50);
                            selected = await state();
                        }
                        if (selected !== 'matched')
                            throw new Halt(
                                '选值未确认',
                                `「${found.field}」未确认选中「${found.control.name}」。`,
                            );
                    }
                } else await this.ready(0);
                if (found.optionGoal !== undefined)
                    this.noteOption(found.field, found.optionGoal, found.control.name);
            } else await this.ready(selected === 'matched' ? 0 : undefined);
            return found.control;
        } finally {
            if (['fieldOption', 'option', 'namedIcon', 'namedNavIcon'].includes(recordedRole))
                await found.locator.dispose();
        }
    }
    async followMenu(parts, text) {
        const route = moduleRouteFor(this.config.moduleRoutes, parts);
        const leaf = parts.at(-1);
        const snapshot = await observe(this.page);
        const actualLeaf = this.config.labels?.[leaf] || leaf;
        const candidates = snapshot.controls.filter((c) => norm(c.name) === norm(actualLeaf));
        let control;
        for (const part of candidates.length === 1 ? [leaf] : parts) {
            if (!route) {
                control = await this.directClick(part, text);
                continue;
            }
            const found = await this.chooseTarget(part, 'click', { requireMenu: true });
            if (found) {
                control = await this.clickTarget(found, text);
                continue;
            }
            await this.navigate(route);
            const failure = this.failures
                .slice(this.navFailureStart)
                .find((f) => f.resourceType === 'document' && f.path === new URL(route).pathname);
            if (failure || this.page.url() !== route)
                throw new Halt(
                    '模块页面未到达',
                    failure ? '模块页面 HTTP ' + failure.status : '页面已跳转到其它地址',
                );
            console.log('  菜单未找到，通过模块映射进入：' + parts.join(' → '));
            return { action: 'module-route' };
        }
        return { action: 'path', control };
    }
    async revealRowMenu(name) {
        if (!this.rowKey) return;
        const snap = await observe(this.page);
        if (
            snap.controls.some(
                (c) =>
                    norm(c.name) === norm(name) &&
                    (c.rowKey || !['menuitem', 'option'].includes(c.role)),
            )
        )
            return;
        const more = snap.controls.filter(
            (c) => c.rowKey === this.rowKey && /^(?:图标:\s*more|更多|more)$/i.test(c.name),
        );
        if (more.length !== 1) return;
        // This menu is click-triggered. Merely hovering revealed transient content
        // that disappeared during model inference, causing repeated 9-second waits.
        const menuItem = snap.controls.find(
            (c) => !c.rowKey && norm(c.name) === norm(name) && c.role === 'menuitem',
        );
        if (menuItem) {
            const item = await assertionTarget(this.page, name, 'visible');
            await item.locator.hover();
            return;
        }
        const found = await this.chooseTarget(more[0].name, 'click', { rowKey: this.rowKey });
        await found.locator.click();
        await this.page.waitForTimeout(180);
        this.events.push({
            phase: this.phase,
            action: 'open-menu',
            text: '展开当前记录的更多操作',
            rowKey: this.rowKey,
        });
    }
    async targetRow(name) {
        if (!this.rowKey) return undefined;
        const snap = await observe(this.page);
        // Dialog controls supersede the list-row binding. Exact global navigation
        // remains global; other operation buttons stay in the chosen record.
        if (!snap.controls.some((c) => c.rowKey === this.rowKey)) return undefined;
        if (snap.controls.some((c) => !c.rowKey && norm(c.name) === norm(name))) return undefined;
        return this.rowKey;
    }
    async bindRow(text) {
        const snap = await observe(this.page),
            all = [
                ...new Map(
                    snap.controls.filter((c) => c.rowKey && c.context).map((c) => [c.rowKey, c]),
                ).values(),
            ];
        const state = text.match(/(?:找到|存在)(.+?)状态/)?.[1];
        const quotedName = text.match(/名称(?:为|含)[「“"]([^」”"]+)[」”"]/)?.[1];
        const permission = text.includes('只读') ? '只读' : text.includes('读写') ? '读写' : null;
        const eligible = all.filter(
            (c) =>
                (!state || c.context.includes(state)) &&
                (!quotedName || c.context.includes(quotedName)) &&
                (!permission || c.context.includes(permission)),
        );
        if (!eligible.length)
            throw new Halt('缺少测试数据', '当前列表没有符合步骤条件的可定位记录：' + text);
        // Arbitrary-record UI checks may use the first eligible row; mutations may
        // only select a specifically named record or explicitly supplied fixture.
        const writes = /(?:点击|执行|确认|提交).{0,12}(?:删除|保存|上线|下线|发布)/.test(
            this.current?.steps || '',
        );
        const fixture = this.config.data?.recordName;
        const chosen = fixture ? eligible.find((c) => c.context.includes(fixture)) : eligible[0];
        if (!chosen) throw new Halt('缺少测试数据', '未找到配置的独立测试记录：' + fixture);
        if (writes && !fixture && !quotedName)
            throw new Halt(
                '缺少独立测试数据',
                '该用例会修改记录；需先准备独立测试数据并通过--data的recordName指定，不能对现有任意记录操作',
            );
        this.rowKey = chosen.rowKey;
        this.events.push({
            phase: this.phase,
            action: 'bind-row',
            text,
            rowKey: chosen.rowKey,
            record: chosen.context,
            selection: fixture ? 'configured-fixture' : 'first-eligible-live-row',
        });
        console.log('  绑定记录：' + chosen.context.slice(0, 100));
        await discoverRowLabels(this.page, this.rowKey);
    }
    async ready(minimum, timeout = this.config.pageTimeout || 18000) {
        return waitForReady(this.page, {
            minimum,
            timeout,
            failures: () => this.failures.slice(this.navFailureStart),
            pauseForRedirect: () => pauseForReplayRedirect(this.page),
        });
    }
    async navigate(url, { force = false, minimum, readyTimeout } = {}) {
        const u = new URL(url, this.config.url);
        if (!['http:', 'https:'].includes(u.protocol) || !this.config.origins.includes(u.origin))
            throw new Halt('目标地址超出测试范围', '步骤网址必须属于本次测试站点');
        const changed = force || this.page.url() !== u.href;
        if (changed) {
            this.navFailureStart = this.failures.length;
            this.navigationCount++;
            await navigateReplayPage(this.page, u.href);
        }
        await this.ready(minimum, readyTimeout);
        return changed;
    }
    async showArea(name) {
        const snap = await observe(this.page),
            tabs = snap.controls.filter((c) => c.role === 'tab' && norm(c.name) === norm(name));
        if (tabs.length !== 1) throw new Halt('页签无法确认', '找不到唯一页签：' + name);
        if (!tabs[0].selected) {
            const c = await this.directClick(name, '切换到' + name + 'Tab');
            this.events.push({
                phase: this.phase,
                action: 'click',
                text: '切换到' + name + 'Tab',
                control: { name: c.name, role: c.role },
                url: this.page.url(),
            });
        }
    }
    async closeOverlay() {
        const modal = this.page
            .locator('dialog[open],[role="dialog"]:visible,.ant-drawer-open .ant-drawer-content')
            .last();
        if (!(await modal.isVisible().catch(() => false))) return;
        // A header Close and a footer 关闭 can coexist. Prefer the explicit header
        // close label, then exact alternatives; never select a generic confirmation.
        for (const name of ['Close', '关闭', 'Cancel', '取消']) {
            const close = modal
                .getByRole('button', { name, exact: true })
                .filter({ visible: true });
            if ((await close.count()) !== 1) continue;
            await close.click();
            await modal.waitFor({ state: 'hidden', timeout: this.config.assertTimeout || 4000 });
            await this.ready();
            return;
        }
        throw new Halt('页面复位未完成', '存在未关闭弹窗，无法唯一确定取消/关闭按钮');
    }
    async resetCase(url, { force = false } = {}) {
        this.phase = 'setup';
        const desired = new URL(url, this.config.url),
            current = new URL(this.page.url());
        const sameModule =
            desired.origin === current.origin &&
            desired.pathname === current.pathname &&
            !desired.search &&
            !desired.hash;
        const changed =
            sameModule && !this.config.reloadEachCase && !force
                ? (await this.ready(), false)
                : await this.navigate(url, { force: !!this.config.reloadEachCase || force });
        const key = new URL(url, this.config.url).href;
        if (!this.baselines.has(key)) {
            const snap = await observe(this.page);
            this.baselines.set(
                key,
                snap.controls.filter((c) => c.role === 'tab' && c.selected).map((c) => c.name),
            );
            return;
        }
        if (!changed) {
            await this.closeOverlay();
            for (const area of this.dirtyAreas.values()) {
                for (const name of area) await this.showArea(name);
                const snap = await observe(this.page),
                    resets = snap.controls.filter(
                        (c) => c.role === 'button' && /^(重置|Reset)$/i.test(c.name),
                    );
                if (resets.length === 1) {
                    const c = await this.directClick(resets[0].name, '重置查询条件');
                    this.events.push({
                        phase: 'setup',
                        action: 'reset',
                        scope: area,
                        control: { name: c.name, role: c.role },
                    });
                } else {
                    await this.navigate(url, { force: true });
                    console.log('  上条改变了表单且页面没有重置入口，刷新一次恢复初始状态');
                    break;
                }
            }
            for (const name of this.baselines.get(key)) await this.showArea(name);
        }
        this.dirtyAreas.clear();
    }
    async checkPrecondition(p, c) {
        if (/^(?:无|无特殊要求|none|n\/a)$/i.test(p)) return;
        if (p === '本用例需要写入授权') {
            if (!this.config.allowWrite)
                throw new Halt(
                    '写入未启用',
                    '本用例包含业务写入，授权的测试环境请使用 --allow-write',
                );
            return;
        }
        if (/^(?:用户)?已登录(?:系统)?[，,]?\s*$/i.test(p)) {
            if (
                !this.config.authenticated ||
                (await this.page.locator('input[type="password"]:visible').count())
            )
                throw new Halt('登录前提不足', '本轮没有完成登录流程，或页面仍显示密码框');
            return;
        }
        const loginWith = p.match(/^(?:用户)?已登录(?:系统)?[，,](.+)$/);
        if (loginWith) {
            await this.checkPrecondition('已登录系统', c);
            return this.checkPrecondition(loginWith[1], c);
        }
        const role = p.match(/^(?:仅)?拥有(.+?)(只读|读写)权限$/);
        if (role) {
            const t = await readTables(this.page),
                i = t.headers.findIndex((h) => h.includes('权限'));
            if (i >= 0 && t.rows.some((r) => norm(r[i]) === norm(role[2]))) return;
            throw new Halt(
                '缺少权限场景',
                '当前列表没有证明所需的' + role[2] + '权限记录；需要对应授权或测试身份',
            );
        }
        if (/^进入/.test(p)) {
            await this.step(p);
            return;
        }
        const permission = p.match(/^已拥有(.+)菜单权限$/);
        if (permission) {
            const leaf = permission[1].split(/[_>＞→]/).at(-1),
                snap = await observe(this.page);
            if (snap.controls.some((x) => norm(x.name) === norm(leaf))) return;
            throw new Halt(
                '前置条件未验证',
                '未找到菜单“' +
                    leaf +
                    '”；先确认页面已加载且页面语言与Excel一致，不能据此判定账号无权限',
            );
        }
        const exists = p.match(/^系统存在(.+)数据$/);
        if (exists) {
            const moduleName = c.title.split(/\s+-\s+/)[0];
            let constraint = exists[1].replaceAll(moduleName, '').replace(/的/g, '');
            const snap = await observe(this.page),
                tabs = snap.controls.filter((x) => x.role === 'tab'),
                areas = tabs.filter((x) => constraint.includes(x.name)).map((x) => x.name);
            for (const area of areas) constraint = constraint.replaceAll(area, '');
            constraint = constraint.replace(/和|、/g, '');
            const state = constraint.match(/^(.+)状态$/),
                permissionValue = constraint.match(/^(.+)权限$/),
                named = constraint.match(/^名称含[「“"](.+)[」”"]$/);
            if (state && /^(?:各种|所有|多种|不同)$/.test(state[1]))
                throw new Halt(
                    '前置条件未验证',
                    '尚不能证明状态覆盖完整：' + p + '；需逐状态准备样本，不能把“各种”当成状态名称',
                );
            if (constraint && !state && !permissionValue && !named)
                throw new Halt(
                    '前置条件未验证',
                    '尚不能证明这个业务前提：' + p + '；请提供明确的数据条件，未将它当作通过',
                );
            const column = state ? '状态' : permissionValue ? '权限' : named ? '名称' : null,
                value = state?.[1] || permissionValue?.[1] || named?.[1];
            const check = async () => {
                const t = await readTables(this.page);
                if (!t.rows.length) return false;
                if (!column) return true;
                const index = t.headers.findIndex((h) => h.includes(column));
                return (
                    index >= 0 &&
                    t.rows.some((r) =>
                        named ? r[index]?.includes(value) : norm(r[index]) === norm(value),
                    )
                );
            };
            if (areas.length) {
                for (const area of areas) {
                    await this.showArea(area);
                    if (!(await check()))
                        throw new Halt('前置条件未验证', area + '当前可见记录未证明：' + p);
                }
                return;
            }
            if (await check()) return;
            // Data may live behind another visible tab. Probe at most three tabs, never all pages.
            for (const area of tabs.filter((t) => !t.selected).slice(0, 3)) {
                await this.showArea(area.name);
                if (await check()) return;
            }
            throw new Halt(
                '前置条件未验证',
                '当前可见记录未证明：' + p + '；没有查询全量后台数据，不能断言系统不存在该数据',
            );
        }
        const check = await this.verify(p);
        if (check.status !== '通过') {
            const error = new Halt('前置条件未验证', '未能验证前提：' + p + '；' + check.reason);
            error.pendingEvidence =
                check.status === '未验证' && ['unsupported', 'conjunction'].includes(check.kind);
            throw error;
        }
    }
    async step(text, nextText = '') {
        await awaitReplayLogin(this.page);
        const previousSave = this.verifiedCreate;
        this.verifiedCreate = null;
        const dialogButton = /^在弹窗中点击「([^」]+)」按钮$/;
        const followup = previousSave && text.match(dialogButton)?.[1];
        if (
            followup &&
            saveConfirmationButton.test(followup) &&
            !(await needsSaveFollowup(
                this.page,
                this.ui.dialog,
                this.config.labels?.[followup] || followup,
                previousSave.autoConfirmed,
            ))
        ) {
            this.events.push({
                phase: this.phase,
                text,
                action: 'save-confirmation',
                reason: previousSave.autoConfirmed
                    ? '已在保存时确认。'
                    : '直接保存成功，未出现确认框。',
            });
            return;
        }
        const diagnosis = stepDiagnostic(text);
        if (diagnosis.status === 'needs-review')
            throw new Halt('录制步骤待补录', diagnosis.message + '；' + diagnosis.suggestion);
        if (diagnosis.status === 'needs-data')
            throw new Halt('缺少测试数据', diagnosis.message + '；' + diagnosis.suggestion);
        const snap = await observe(this.page);
        let specs = expandStep(text, {
            controls: snap.controls,
            area: this.area,
            moduleRoutes: this.config.moduleRoutes,
        });
        if (!specs.length)
            specs = await semanticStep(text, snap, this.laya, {
                meta: { case: this.current?.key },
                minProbability: this.config.minProbability,
                minMargin: this.config.minMargin,
            });
        for (const spec of specs) {
            const uncertain = !['assertStep', 'bindRow', 'bindExactRecord', 'hover'].includes(
                spec.verb,
            );
            await runReplayOperation(
                this.page,
                text,
                uncertain,
                () => this.executeStep(text, spec, nextText),
                () =>
                    this.events.push({
                        phase: this.phase,
                        text,
                        action: 'operator-confirmed',
                        note: '重新登录后由操作者确认上一步已完成。',
                    }),
            );
        }
    }
    async executeStep(text, spec, nextText = '') {
        const limit = this.caseStepLimit ?? this.config.maxSteps;
        if (++this.actions > limit)
            throw new Halt('达到步骤上限', `本用例达到最大操作次数（${limit}），停止继续尝试`);
        console.log('  步骤：' + text);
        if (spec.verb === 'bindRow') {
            await this.bindRow(text);
            return;
        }
        if (spec.verb === 'bindExactRecord') {
            const { row, reason } = await exactRecordRow(this.page, spec);
            if (!row) throw new Halt('无法唯一定位记录', reason);
            this.exactRecord = spec;
            this.rowKey = null;
            this.events.push({
                phase: this.phase,
                action: 'bind-row',
                text,
                selection: 'exact-column',
            });
            return;
        }
        if (spec.verb === 'assertStep') {
            const actual = await this.verify(spec.target);
            this.events.push({ phase: this.phase, action: 'step-assertion', text, ...actual });
            if (actual.status !== '通过')
                throw new Halt(
                    actual.status === '失败' ? '步骤预期不符' : '执行能力不足',
                    actual.reason,
                );
            return;
        }
        if (spec.verb === 'emptyRequired') {
            const snap = await observe(this.page),
                fields = snap.controls.filter(
                    (c) =>
                        ['textbox', 'spinbutton', 'combobox'].includes(c.role) &&
                        !c.disabled &&
                        !c.readonly,
                );
            if (!fields.length || fields.some((c) => c.value))
                throw new Halt(
                    '前置条件未验证',
                    '当前必填字段为空尚未证明，不提交可能带有默认值的表单',
                );
            this.events.push({
                phase: this.phase,
                action: 'observe-empty-fields',
                text,
                fields: fields.map((c) => c.name),
            });
            return;
        }
        if (spec.verb === 'path') {
            const snap = await observe(this.page),
                leaf = spec.path.at(-1),
                current = new URL(this.page.url());
            const here = snap.controls.find((c) => {
                if (norm(c.name) !== norm(leaf) || !c.href) return false;
                const u = new URL(c.href, current);
                return (
                    u.href === current.href ||
                    (!u.search &&
                        !u.hash &&
                        u.origin === current.origin &&
                        u.pathname === current.pathname)
                );
            });
            if (here) {
                const event = {
                    phase: this.phase,
                    text,
                    action: 'already-on-page',
                    control: { name: here.name, role: here.role },
                    url: this.page.url(),
                };
                this.events.push(event);
                console.log('  已在目标页面，复用当前DOM');
                return event;
            }
        }
        // Explicit verbs need no second model vote ("点击查看" was being confused
        // with the observation verb). Laya still selects the real DOM target below.
        const verb = spec.verb;
        let control;
        let action = verb;
        if (verb === 'editor') {
            await replayEditorOperation(
                this.page,
                spec.operation,
                this.caseData,
                this.config.pageTimeout,
            );
            control = {
                name: spec.operation.name || spec.operation.path?.at(-1) || 'Monaco',
                role: spec.operation.type,
            };
        } else if (verb === 'navigate') {
            if (!spec.target) throw new Halt('缺少测试数据', '没有明确网址');
            await this.navigate(spec.target);
        } else if (verb === 'path') {
            ({ action, control } = await this.followMenu(spec.path, text));
        } else if (verb === 'observe') {
            const names = quoted(text);
            if (names.length === 1 && /按钮/.test(text)) {
                await this.revealRowMenu(names[0]);
                const found = await assertionTarget(this.page, names[0], 'visible', {
                    rowKey: await this.targetRow(names[0]),
                });
                control = found.control;
                this.observedName = names[0];
            }
            await settle(this.page, this.config.delay);
        } else if (verb === 'press') {
            if (spec.value.toLowerCase() === 'enter' && !this.config.allowWrite)
                throw new Halt('写入未启用', 'Enter可能提交当前表单；未启用写入时不猜测其行为');
            if (spec.locator) {
                const methods = {
                    标签: 'getByLabel',
                    占位符: 'getByPlaceholder',
                    文本: 'getByText',
                };
                const options = { exact: spec.exact };
                const locator = spec.role
                    ? this.page.getByRole(spec.role, { name: spec.target, ...options })
                    : this.page[methods[spec.locator]](spec.target, options);
                const timeout = { timeout: this.config.pageTimeout };
                if ((await locator.count()) !== 1)
                    throw new Halt('按键目标不明确', `无法唯一定位按键目标「${spec.target}」`);
                await locator.focus(timeout);
                const focused = await locator.evaluate(
                    (element) => element.getRootNode().activeElement === element,
                    undefined,
                    timeout,
                );
                if (!focused)
                    throw new Halt('按键目标无法聚焦', `无法聚焦按键目标「${spec.target}」`);
                control = { name: spec.target, role: spec.role };
            }
            await this.page.keyboard.press(spec.value);
            await settle(this.page, this.config.delay);
        } else if (verb === 'click') {
            if (!this.rowKey && /列表(?:中)?点击/.test(text)) await this.bindRow(text);
            const nextLink =
                spec.recordedRole === 'namedNavIcon' &&
                nextText.match(/^点击「([^」]+)」链接$/)?.[1];
            const click = () =>
                this.directClick(spec.target, text, nextLink ? { ...spec, nextLink } : spec);
            if (spec.verifyCreate) {
                const result = await verifyCreateClick(
                    this.page,
                    async () => {
                        control = await click();
                    },
                    readCreateState,
                    compareCreateStates,
                    this.ui,
                    this.config.assertTimeout || 5000,
                    Boolean(this.config.allowWrite) &&
                        !cancelConfirmationButton.test(
                            nextText.match(/^(?:在弹窗中)?点击「([^」]+)」按钮$/)?.[1] || '',
                        ),
                );
                this.events.push({
                    phase: this.phase,
                    text,
                    action: 'verify-create',
                    control,
                    ...result,
                });
                if (result.status !== '通过') {
                    const error = new Halt('新增保存验证', result.reason);
                    error.createResult = result;
                    throw error;
                }
                this.verifiedCreate = result;
            } else control = await click();
            if (spec.recordedRole === 'navIcon') {
                await this.page
                    .getByRole('link', { name: spec.childLink, exact: true })
                    .waitFor({ state: 'visible', timeout: this.config.assertTimeout || 4000 });
            }
        } else {
            if (['fill', 'clear', 'select', 'check', 'uncheck'].includes(verb)) {
                const snap = await observe(this.page),
                    area = snap.controls
                        .filter((c) => c.role === 'tab' && c.selected)
                        .map((c) => c.name);
                this.dirtyAreas.set(JSON.stringify(area), area);
            }
            let found;
            const fieldKind =
                { nativeSelect: 'native', selectSearch: 'search', formNumber: 'number' }[
                    spec.locator
                ] || (spec.scope === 'dialog' && ['fill', 'clear'].includes(verb) ? 'text' : null);
            if (fieldKind) {
                let scope = spec.scope === 'dialog' ? await this.exactDialog() : this.page;
                if (this.exactRecord) {
                    const { row, reason } = await exactRecordRow(this.page, this.exactRecord);
                    if (!row) throw new Halt('无法唯一定位记录', reason);
                    scope = row;
                    this.exactRecord = null;
                }
                const { name, locator } = await this.replayField(scope, spec.target, fieldKind);
                if ((await locator.count()) !== 1)
                    throw new Halt(
                        spec.scope === 'dialog' ? '弹窗操作范围不明确' : '字段操作范围不明确',
                        `无法唯一定位字段「${name}」`,
                    );
                const role = {
                    native: 'combobox',
                    search: 'combobox',
                    number: 'spinbutton',
                    text: 'textbox',
                }[fieldKind];
                found = {
                    locator,
                    control: { name, role, ...(fieldKind === 'native' && { tag: 'select' }) },
                };
            } else {
                found = await this.chooseTarget(spec.target, verb, {
                    role: spec.role,
                    rowKey: await this.targetRow(spec.target),
                    allowDisabled: verb === 'hover',
                });
            }
            control = found.control;
            if (
                ['fill', 'clear', 'select'].includes(verb) &&
                found.decision &&
                found.control.name !== (this.config.labels?.[spec.target] || spec.target)
            )
                this.noteFieldMatch(spec.target, found.control.name);
            if (verb === 'fill' || verb === 'clear') {
                if (spec.range) spec.value = await replayInteger(found.locator, spec.range);
                await found.locator.fill(verb === 'clear' ? '' : spec.value);
                if ((await found.locator.inputValue()) !== (verb === 'clear' ? '' : spec.value))
                    throw new Halt('操作未生效', '填写后的实际输入值不一致');
                if (spec.range)
                    this.events.push({
                        phase: this.phase,
                        action: 'dynamic-fill',
                        field: spec.target,
                        value: spec.value,
                        note: `动态填值：${spec.target} → ${spec.value}（${spec.range.join(' 到 ')}）`,
                    });
            } else if (verb === 'select') {
                if (spec.optionGoal !== undefined) {
                    let reason = spec.optionGoal;
                    const fallback =
                        this.config.labels?.[spec.recordedFallback] || spec.recordedFallback;
                    const value = await chooseNativeOption(
                        found.locator,
                        (names) => {
                            if (fallback && names.length === 1 && names[0] === fallback)
                                reason = '仅有录制值可选';
                            return this.chooseOption(
                                control.name,
                                spec.optionGoal,
                                names,
                                fallback,
                            );
                        },
                        fallback &&
                            (() => {
                                reason = '回退到录制值';
                                return fallback;
                            }),
                        this.config.assertTimeout,
                    );
                    this.noteOption(spec.target, reason, value);
                } else if (control.tag === 'select')
                    await found.locator.selectOption({ label: spec.value });
                else {
                    await found.locator.click();
                    await settle(this.page, this.config.delay);
                    const option = await this.chooseTarget(spec.value, 'option');
                    await option.locator.click();
                }
            } else if (verb === 'check' || verb === 'uncheck') {
                if (['input'].includes(control.tag))
                    await found.locator.setChecked(verb === 'check');
                else if (control.checked !== (verb === 'check')) await found.locator.click();
            } else if (verb === 'hover') await found.locator.hover();
            const filled = verb === 'fill' || verb === 'clear';
            await settle(
                this.page,
                filled ? (this.config.confirmedDelay ?? this.config.delay) : this.config.delay,
            );
        }
        const event = {
            phase: this.phase,
            text,
            action,
            ...(control
                ? { control: { name: control.name, role: control.role, context: control.context } }
                : {}),
            url: this.page.url(),
        };
        this.events.push(event);
        return event;
    }
    async verify(text) {
        if (text === createExpectation) {
            const results = this.events.filter((e) => e.action === 'verify-create');
            const result = results.find((e) => e.status !== '通过') || results.at(-1);
            return {
                text,
                kind: 'recorded-create',
                status: result?.status || '未验证',
                reason: result?.reason || '未执行新增保存验证。',
            };
        }
        if (text === '录制设置的步骤预期全部满足') {
            const assertions = this.events.filter((event) => event.action === 'step-assertion');
            const passed =
                assertions.length && assertions.every((entry) => entry.status === '通过');
            return {
                text,
                kind: 'recorded-checkpoints',
                status: passed ? '通过' : '未验证',
                reason: passed ? '所有录制检查点均通过。' : '缺少已验证的录制检查点。',
            };
        }
        if (text === '业务结果待补充（录制时未设置预期）')
            return {
                text,
                kind: 'business-expectation',
                status: '未验证',
                reason: '原录制没有业务预期，请补充可观察结果。',
            };
        const compiled = compileExpectation(text);
        if (compiled.length > 1) {
            const assertions = [];
            for (const part of compiled) {
                if (part.diagnostic)
                    assertions.push({
                        text: part.text,
                        status: '未验证',
                        reason: part.diagnostic.message + '；' + part.diagnostic.suggestion,
                    });
                else {
                    try {
                        assertions.push(await this.verify(part.text));
                    } catch (error) {
                        if (error.category === '模型API错误') throw error;
                        assertions.push({
                            text: part.text,
                            status: '未验证',
                            reason: error.message,
                        });
                    }
                }
            }
            const status = assertions.some((a) => a.status === '失败')
                ? '失败'
                : assertions.some((a) => a.status !== '通过')
                  ? '未验证'
                  : '通过';
            return {
                text,
                status,
                kind: 'conjunction',
                assertions,
                compilation: compiled,
                reason: assertions.map((a) => `${a.text}：${a.reason}`).join('；'),
            };
        }
        const spec = expectation(text),
            page = this.page;
        if (spec.kind === 'navigation-url' || spec.kind === 'navigation-area')
            return verifyRecordedDestination(page, text, spec, this.config.assertTimeout || 4000);
        if (spec.kind === 'exactRecord')
            return {
                text,
                kind: spec.kind,
                scope: '列表',
                ...(await verifyExactRecord(page, spec, this.config.assertTimeout || 4000)),
            };
        if (spec.kind === 'unsupported')
            return {
                text,
                kind: spec.kind,
                status: '未验证',
                reason:
                    assertionDiagnostic(text).message + '；' + assertionDiagnostic(text).suggestion,
            };
        // Button 「弹窗」is a container scope resolved below, not a tab name to activate.
        if (spec.scope && !['visible', 'absent', 'controlVisible'].includes(spec.kind))
            await this.showArea(spec.scope);
        let actual,
            passed = false;
        if (spec.kind === 'tooltip') {
            if (!this.observedName)
                return {
                    text,
                    status: '未验证',
                    reason: '没有明确的悬停目标，不能把任意提示作为本条证据',
                };
            await this.revealRowMenu(this.observedName);
            const found = await assertionTarget(page, this.observedName, 'visible', {
                rowKey: await this.targetRow(this.observedName),
            });
            await found.locator.hover();
            await page.waitForTimeout(400);
            actual = [
                ...new Set(
                    (
                        await page
                            .locator(
                                '[role="tooltip"]:visible,.ant-tooltip:visible,.el-tooltip__popper:visible',
                            )
                            .allTextContents()
                    ).map((s) => s.trim()),
                ),
            ];
            passed = actual.some((s) => s.includes(spec.target));
        } else if (spec.kind === 'controlVisible') {
            // Action candidates can have inferred roles; use accessibility semantics for assertions.
            // An explicit dialog scope uses the same unique visible dialog as text assertions.
            let root = page;
            if (spec.scope === '弹窗') {
                root = page
                    .locator('dialog[open],[role="dialog"],.ant-drawer-open .ant-drawer-content')
                    .filter({ visible: true });
                const count = await root.count();
                if (count !== 1)
                    return {
                        text,
                        status: '未验证',
                        kind: spec.kind,
                        scope: spec.scope,
                        reason: `无法唯一确定${spec.scope}范围（找到 ${count} 个）`,
                    };
            }
            const buttons = root
                .getByRole('button', { name: spec.target, exact: true })
                .filter({ visible: true });
            const count = await buttons.count();
            actual = Array.from({ length: count }, () => ({ name: spec.target, role: 'button' }));
            passed = count === 1;
        } else if (spec.kind === 'dialog') {
            const dialogs = page.locator(
                'dialog[open]:visible,[role="dialog"]:visible,.ant-drawer-open .ant-drawer-content:visible',
            );
            actual = await dialogs.allTextContents();
            passed = actual.some((s) => s.includes(spec.target));
        } else if (spec.kind === 'fixedColumns') {
            actual = await page
                .getByRole('columnheader')
                .filter({ visible: true })
                .evaluateAll(
                    (els, names) =>
                        Object.fromEntries(
                            names.map((name) => [
                                name,
                                els
                                    .filter((e) => e.innerText.trim() === name)
                                    .map((e) => ({
                                        position: getComputedStyle(e).position,
                                        left: getComputedStyle(e).left,
                                        right: getComputedStyle(e).right,
                                        fixedLeft: !!e.closest('.ant-table-fixed-left'),
                                        fixedRight: !!e.closest('.ant-table-fixed-right'),
                                    })),
                            ]),
                        ),
                    [spec.left, spec.right],
                );
            passed =
                actual[spec.left]?.some(
                    (c) => c.fixedLeft || (c.position === 'sticky' && c.left !== 'auto'),
                ) &&
                actual[spec.right]?.some(
                    (c) => c.fixedRight || (c.position === 'sticky' && c.right !== 'auto'),
                );
        } else if (spec.kind === 'columnValues') {
            const t = await readTables(page),
                i = t.headers.findIndex((h) => h.includes(spec.column));
            actual = i < 0 ? [] : t.rows.map((r) => r[i]);
            passed =
                actual.length > 0 &&
                actual.every((v) => spec.values.some((w) => norm(w) === norm(v)));
        } else if (spec.kind === 'fieldAbsent' || spec.kind === 'fields') {
            const snap = await observe(page),
                fields = snap.controls.filter(
                    (c) => ['textbox', 'combobox'].includes(c.role) && c.inPanel,
                );
            actual = fields.map((c) => ({ name: c.name, role: c.role }));
            passed =
                spec.kind === 'fieldAbsent'
                    ? !fields.some((c) => c.name.includes(spec.target))
                    : spec.targets.every((t) =>
                          fields.some((c) => c.role === t.role && c.name.includes(t.name)),
                      );
        } else if (spec.kind === 'visible' || spec.kind === 'absent') {
            // Check visible rendered text, not hidden DOM or a model's opinion.
            let root = page;
            if (spec.scope === '弹窗' || spec.scope === '列表') {
                root = page
                    .locator(
                        spec.scope === '弹窗'
                            ? 'dialog[open],[role="dialog"],.ant-drawer-open .ant-drawer-content'
                            : 'table,[role="table"],[role="grid"], [role="list"]',
                    )
                    .filter({ visible: true });
                const count = await root.count();
                if (count !== 1)
                    return {
                        text,
                        status: '未验证',
                        kind: spec.kind,
                        scope: spec.scope,
                        reason: `无法唯一确定${spec.scope}范围（找到 ${count} 个）`,
                    };
            }
            const locator = root.getByText(spec.target, { exact: false }).filter({ visible: true });
            if (spec.kind === 'visible')
                await locator
                    .first()
                    .waitFor({ timeout: this.config.assertTimeout })
                    .catch(() => {});
            else
                await locator
                    .first()
                    .waitFor({ state: 'hidden', timeout: this.config.assertTimeout })
                    .catch(() => {});
            actual = await locator.count();
            passed = spec.kind === 'visible' ? actual > 0 : actual === 0;
        } else if (spec.kind === 'tabs') {
            const snap = await observe(page),
                tabs = snap.controls.filter((c) => c.role === 'tab');
            actual = tabs.map((c) => c.name);
            passed = actual.length === spec.count && spec.targets.every((t) => actual.includes(t));
        } else if (spec.kind === 'columns') {
            actual = await page
                .getByRole('columnheader')
                .filter({ visible: true })
                .allTextContents();
            passed = spec.targets.every((t) => actual.some((a) => a.trim() === t));
        } else if (spec.kind === 'rowcount') {
            const timeout = Number.isFinite(this.config.assertTimeout)
                ? this.config.assertTimeout
                : 4000;
            const reading = await readVisibleRowCount(page, spec.value, timeout);
            if (!reading.countable)
                return { text, status: '未验证', kind: spec.kind, reason: reading.reason };
            actual = reading.count;
            passed = actual === spec.value;
        } else if (spec.kind === 'url') {
            actual = page.url();
            passed = actual.includes(spec.target);
        } else {
            let adapted;
            if (['value', 'empty'].includes(spec.kind)) {
                const matches = [...this.fieldMatches.values()].filter(
                    (f) =>
                        f.requested === spec.target &&
                        ['text', 'number', 'search'].includes(f.kind),
                );
                if (
                    matches.length === 1 &&
                    !(await matches[0].original.count()) &&
                    (await stillMatched(matches[0].locator, matches[0].handle))
                )
                    adapted = matches[0];
            }
            const found =
                adapted ||
                (await assertionTarget(page, spec.target, spec.kind, {
                    rowKey: await this.targetRow(spec.target),
                }));
            if (['value', 'empty'].includes(spec.kind)) {
                actual = await found.locator.inputValue();
                passed = actual === (spec.kind === 'empty' ? '' : spec.value);
            } else if (['disabled', 'enabled'].includes(spec.kind)) {
                actual = found.control.disabled;
                passed = spec.kind === 'disabled' ? actual : !actual;
            } else if (spec.kind === 'checked') {
                actual = found.control.checked;
                passed = actual === true;
            } else if (spec.kind === 'selected') {
                actual = found.control.selected;
                passed = actual === true;
            }
        }
        return {
            text,
            status: passed ? '通过' : '失败',
            kind: spec.kind,
            ...(spec.scope ? { scope: spec.scope } : {}),
            actual,
            reason: passed ? '明确断言满足' : '实际页面状态与该预期不符，需核对需求或定位证据',
        };
    }
    async enterRecordedPage(entry, resetUrl) {
        const source = this.page.url();
        try {
            await this.navigate(entry.url, {
                force: Boolean(resetUrl),
                minimum: 0,
                readyTimeout: Math.min(
                    this.config.pageTimeout || 18000,
                    this.config.assertTimeout || 4000,
                ),
            });
            const check = await verifyRecordedDestination(
                this.page,
                '',
                { kind: 'navigation-url', target: entry.url },
                this.config.assertTimeout ?? 4000,
            );
            if (check.status !== '通过') throw Error('目的地址与录制不一致');
            const arrived = this.page.url();
            const deadline = Date.now() + (this.config.assertTimeout ?? 4000);
            do {
                const { controls } = await observe(this.page);
                const targets = controls.filter(
                    (c) => c.name === entry.anchor && entry.roles.includes(c.role),
                );
                if (
                    targets.length === 1 &&
                    !targets[0].disabled &&
                    this.page.url() === arrived &&
                    !controls.some((c) => c.role === 'password')
                ) {
                    if (resetUrl) this.dirtyAreas.clear();
                    this.actions++;
                    this.events.push({
                        phase: this.phase,
                        action: 'direct-entry',
                        url: entry.url,
                        note: `业务入口已核实：${entry.anchor}。原录制的 ${entry.prefix.length} 个进页步骤由 URL 直达。`,
                    });
                    return true;
                }
                await this.page.waitForTimeout(75);
            } while (Date.now() < deadline);
            throw Error('无法确认入口控件「' + entry.anchor + '」');
        } catch (error) {
            this.events.push({
                phase: this.phase,
                action: 'entry-fallback',
                note: `直达未确认，改走录制菜单：${safeText(error.message)}`,
            });
            if (resetUrl) {
                const phase = this.phase;
                await this.resetCase(resetUrl, { force: true });
                this.phase = phase;
            } else if (this.page.url() !== source) await this.navigate(source);
            return false;
        }
    }
    async runCase(
        c,
        { continueRecording = false, useRecordedStepCount = false, businessEntry } = {},
    ) {
        this.current = c;
        this.actions = 0;
        this.caseStepLimit = useRecordedStepCount
            ? Math.max(this.config.maxSteps ?? 25, lines(c.steps).length)
            : this.config.maxSteps;
        this.events = [];
        this.rowKey = null;
        this.exactRecord = null;
        this.area = null;
        this.observedName = null;
        this.pendingPreconditions = [];
        const started = performance.now();
        const failuresAt = this.failures.length,
            navAt = this.navigationCount;
        let touchedPage = false,
            completed = false,
            pageObserved = true,
            healthExpected = [];
        const result = {
            ...c,
            status: '未执行',
            reason: '',
            category: '',
            actions: [],
            assertions: [],
            evidence: [],
            input_diagnostics: inspectCase(c, this.config.data, this.config.runId).diagnostics,
            started_at: new Date().toISOString(),
        };
        // One readable directory per executed case: cases/001-ID-TITLE/.
        const caseDir = this.caseDirectories.for(Symbol(), c.id, c.title);
        result.evidence_dir = caseDir;
        await fs.mkdir(path.join(this.config.out, caseDir), { recursive: true });
        const capture = async (details) => {
            const evidence = {
                sequence: result.evidence.length + 1,
                ...details,
                at: new Date().toISOString(),
            };
            result.evidence.push(evidence);
            if (this.config.replayLoginActive) return evidence.sequence;
            const label = { step: '步骤', assertion: '预期' }[evidence.phase] || evidence.phase;
            // e.g. 03-预期2-失败.png: order, phase and outcome are visible in the folder listing.
            const outcome = evidence.status ? `-${slug(evidence.status, 8)}` : '';
            const screenshot = `${caseDir}/${String(evidence.sequence).padStart(2, '0')}-${label}${evidence.index ?? ''}${outcome}.png`;
            try {
                evidence.url = safeUrl(this.page.url());
                const file = path.join(this.config.out, screenshot);
                await this.page.screenshot({ path: file, timeout: 5000 });
                if (!(await fs.stat(file)).size) throw Error('截图文件为空');
                evidence.screenshot = screenshot;
            } catch (error) {
                evidence.screenshot_error = `截图采集失败：${safeText(error?.message || String(error))}`;
            }
            return evidence.sequence;
        };
        try {
            if (c.import_error) throw new Halt('Excel内容不明确', c.import_error);
            if (!this.config.includeApproval && approvalOperation(c))
                throw new Halt(
                    '按要求跳过审批',
                    '用例包含审批流程操作或审批开关，不执行；仅展示审批状态的用例不按关键词排除',
                );
            const data = replayData(parseData(c.data), this.config.data, this.config.runId);
            this.caseData = data;
            let steps = lines(variables(c.steps, data));
            let expected = lines(variables(c.expected, data));
            const preconditions = lines(variables(c.preconditions, data));
            if (data.recordedScene?.kind === 'create') {
                steps = addCreateVerification(steps);
                if (
                    steps.some((step) => step.endsWith('按钮并验证新增记录')) &&
                    !expected.includes(createExpectation)
                ) {
                    expected = [
                        ...expected.filter((text) => text !== '业务结果待补充（录制时未设置预期）'),
                        createExpectation,
                    ];
                    // Keep recorded templates intact in reports, even when replay substituted secrets.
                    result.steps = addCreateVerification(lines(c.steps))
                        .map((step, i) => `${i + 1}. ${step}`)
                        .join('\n');
                    result.expected = [
                        ...lines(c.expected).filter(
                            (text) => text !== '业务结果待补充（录制时未设置预期）',
                        ),
                        createExpectation,
                    ].join('\n');
                }
            }
            if (!steps.length || !expected.length)
                throw new Halt('用例内容缺失', '需要明确的操作步骤和预期结果');
            healthExpected = expected.filter((text) => healthAssertions.has(text));
            if (healthExpected.length) this.diagnostics?.begin(c.id);
            touchedPage = true;
            const canEnterDirectly =
                businessEntry &&
                this.actions < (this.caseStepLimit ?? Infinity) &&
                businessEntry.prefix.every((step, i) => steps[i] === step);
            const resetUrl =
                !continueRecording && canEnterDirectly && businessEntry.resetAtEntry
                    ? c.url || this.config.url
                    : null;
            if (!continueRecording && !resetUrl)
                await this.resetCase(c.url || this.config.url, {
                    force: healthExpected.length > 0,
                });
            await awaitReplayLogin(this.page);
            this.phase = 'precondition';
            const titleAreas = resetUrl
                ? []
                : scopeNames(
                      c.title +
                          '\n' +
                          steps.filter((s) => /^切换/.test(s) && s.includes('/')).join('\n'),
                      (await observe(this.page)).controls,
                  );
            if (titleAreas.length === 1) await this.showArea(titleAreas[0]);
            result.precondition_checks = [];
            for (const p of preconditions) {
                try {
                    await this.checkPrecondition(p, c);
                    result.precondition_checks.push({ text: p, status: '通过' });
                } catch (e) {
                    if (
                        e.category !== '前置条件未验证' ||
                        !(e.pendingEvidence || /(?:尚不能证明|语法无法完整解释)/.test(e.message))
                    )
                        throw e;
                    this.pendingPreconditions.push(p);
                    result.precondition_checks.push({
                        text: p,
                        status: '待补证',
                        reason: e.message,
                    });
                    console.log('  前提待补证，继续可观察步骤：' + p);
                }
            }
            // Repeat read-only scenarios explicitly titled for multiple live tabs.
            // Never multiply potentially persistent writes across scopes automatically.
            if (titleAreas.length > 1 && this.config.allowWrite)
                throw new Halt(
                    '多页签写入范围不明确',
                    '用例标题涉及多个页签且允许写入，请拆成独立用例后执行',
                );
            for (const area of titleAreas.length ? titleAreas : [null]) {
                this.phase = 'step';
                this.verifiedCreate = null;
                this.area = area;
                this.rowKey = null;
                this.exactRecord = null;
                if (area) {
                    await this.closeOverlay();
                    await this.showArea(area);
                    console.log('  用例范围：' + area);
                }
                let replaced = 0;
                for (const [index, original] of steps.entries()) {
                    if (index < replaced) continue;
                    let text = original;
                    const stepStarted = performance.now();
                    const firstEvent = this.events.length;
                    let status = '已完成';
                    if (healthExpected.length)
                        this.diagnostics?.setStep({ index: index + 1, text });
                    try {
                        if (
                            index === 0 &&
                            !area &&
                            canEnterDirectly &&
                            this.actions < (this.caseStepLimit ?? Infinity) &&
                            (await this.enterRecordedPage(businessEntry, resetUrl))
                        ) {
                            replaced = businessEntry.prefix.length;
                            text = `直达录制业务入口 ${businessEntry.url}`;
                            console.log('  ' + text);
                        } else await this.step(text, steps[index + 1]);
                    } catch (error) {
                        status = '未完成';
                        throw error;
                    } finally {
                        const durationMs = Math.round(performance.now() - stepStarted);
                        if (
                            healthExpected.length &&
                            this.diagnostics &&
                            !this.config.replayLoginActive
                        ) {
                            try {
                                for (const detail of new Set(await observePageErrors(this.page)))
                                    this.diagnostics.add({
                                        kind: 'ui-error',
                                        detail: safeText(detail),
                                    });
                            } catch {
                                pageObserved = false;
                            }
                        }
                        const notes = this.events
                            .slice(firstEvent)
                            .map((event) => event.note)
                            .filter(Boolean);
                        const sequence = await capture({
                            durationMs,
                            ...(notes.length && { notes }),
                            phase: 'step',
                            index: index + 1,
                            text,
                            scope: area,
                            status,
                        });
                        for (const event of this.events.slice(firstEvent))
                            event.evidence_sequence = sequence;
                    }
                }
                this.phase = 'assertion';
                for (const [index, text] of expected.entries()) {
                    if (healthAssertions.has(text)) continue;
                    const assertionStarted = performance.now();
                    let assertion;
                    try {
                        assertion = await runReplayOperation(this.page, text, false, () =>
                            this.verify(text),
                        );
                    } catch (e) {
                        assertion = {
                            text,
                            status: '未验证',
                            reason: e.message,
                        };
                        if (e.category === '模型API错误') throw e;
                    } finally {
                        assertion = {
                            ...assertion,
                            scope: assertion?.scope ?? area,
                            durationMs: Math.round(performance.now() - assertionStarted),
                        };
                        assertion.evidence_sequence = await capture({
                            phase: 'assertion',
                            durationMs: assertion.durationMs,
                            index: index + 1,
                            text,
                            scope: assertion.scope,
                            status: assertion.status,
                        });
                        result.assertions.push(assertion);
                    }
                }
            }
            for (const p of this.pendingPreconditions)
                result.assertions.push({
                    text: '前提：' + p,
                    status: '未验证',
                    reason: '已继续执行可观察步骤，但该前提仍缺少证据，不能计为通过',
                });
            completed = true;
        } catch (e) {
            result.status = this.events.some(
                (x) => x.phase === 'step' && x.action !== 'already-on-page',
            )
                ? '部分执行（未完成）'
                : '跳过（未完成）';
            result.category = e.category || '执行器异常';
            result.reason = e.message;
            if (e.createResult) {
                result.status = e.createResult.status === '失败' ? '失败' : '部分验证';
                result.assertions.push({
                    text: createExpectation,
                    kind: 'recorded-create',
                    ...e.createResult,
                });
            }
        }
        if (this.config.replayLoginActive) throw Error('回放在手动登录期间中止');
        if (healthExpected.length) {
            const monitored = this.diagnostics?.active;
            if (monitored && completed) await this.page.waitForTimeout(150).catch(() => {});
            if (monitored) result.browser_events = await this.diagnostics.end();
            result.health_checks = healthExpected.map((text) =>
                healthAssertion(text, monitored, completed, pageObserved),
            );
            result.assertions.push(...result.health_checks);
            if (!completed && result.health_checks.some((check) => check.status === '失败')) {
                result.status = '失败';
                result.reason +=
                    '；' +
                    result.health_checks
                        .filter((check) => check.status === '失败')
                        .map((check) => check.reason)
                        .join('；');
            }
        }
        if (completed) {
            result.status = result.assertions.some((a) => a.status === '失败')
                ? '失败'
                : result.assertions.some((a) => a.status === '未验证')
                  ? '部分验证'
                  : '通过';
            result.category =
                result.status === '失败'
                    ? '断言不符合预期，需复核'
                    : result.status === '部分验证'
                      ? '部分预期尚不能自动验证'
                      : '无';
            result.reason =
                result.assertions
                    .filter((a) => a.status !== '通过')
                    .map((a) => a.text + '：' + a.reason)
                    .join('；') || '所有步骤已执行，所有预期断言通过';
        }
        result.stepsCompleted = completed;
        result.actions = this.events;
        result.network_errors = this.failures.slice(failuresAt);
        result.page_navigations = this.navigationCount - navAt;
        this.lastCaseUiChanged = this.events.some(
            (x) =>
                x.phase === 'step' &&
                ['fill', 'select', 'check', 'uncheck', 'clear'].includes(x.action),
        );
        result.evidence_scope = result.actions.length
            ? '操作后的页面快照'
            : '本条没有完成动作；截图仅表示停止时浏览器页面';
        if (result.status !== '通过' && result.network_errors.some((x) => x.status === 401)) {
            result.category = '登录会话失效';
            result.reason += '；捕获HTTP401，需重新登录';
        }
        if (
            ['页面资源加载失败', '页面尚未就绪'].includes(result.category) &&
            result.network_errors.some((x) => x.status >= 500)
        ) {
            result.category = '环境接口故障';
            result.reason += '；页面未就绪且捕获HTTP5xx，不能据此判定产品功能错误';
        }
        if (touchedPage && !this.config.replayLoginActive) {
            const screenshot = `${caseDir}/final.png`;
            try {
                await this.page.screenshot({ path: path.join(this.config.out, screenshot) });
                result.screenshot = screenshot;
            } catch (error) {
                result.screenshot_error = `截图采集失败：${safeText(error?.message || String(error))}`;
            }
            const snap = await observe(this.page);
            result.unidentified_controls = snap.unidentifiedControls;
            result.control_binding_diagnostics = snap.bindingDiagnostics;
            await fs.writeFile(
                path.join(this.config.out, caseDir, 'controls.json'),
                JSON.stringify(
                    {
                        url: snap.url,
                        controls: snap.controls,
                        unidentifiedControls: snap.unidentifiedControls,
                        bindingDiagnostics: snap.bindingDiagnostics,
                    },
                    null,
                    2,
                ),
            );
        }
        await Promise.all([...this.fieldMatches.values()].map((field) => field.handle.dispose()));
        this.fieldMatches.clear();
        result.duration_ms = Math.round(performance.now() - started);
        return result;
    }
}
