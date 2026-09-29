import { fileURLToPath } from 'node:url';
import { PendingWrites } from './pending-writes.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Laya, beginModelWarmup, waitModelWarmup } from './model.mjs';
import { openBrowser } from './browser-provider.mjs';
import { matchReplayTarget } from './replay-model.mjs';
import { observe, discoverRowLabels, settle } from './dom.mjs';
import { ensureAuthentication, saveAuthState } from './auth-state.mjs';
import { RunJournal, watchInterruption, resultExitCode, writePrivateJson } from './run-state.mjs';
import { workflowPolicy, enforceReplayPolicy } from './workflow-policy.mjs';
import {
    accountField,
    expiryField,
    chooseTestOption,
    chooseFieldValue,
    tomorrowDate,
} from './test-data.mjs';
import {
    discoverTests,
    executeDiscovery,
    validateDiscovery,
    observeFormEvidence,
} from './discovery.mjs';
import { waitForReady } from './readiness.mjs';
import {
    BrowserDiagnostics,
    diagnoseFailure,
    eventLabel,
    severeEvent,
    safeText,
} from './diagnostics.mjs';
import {
    inspectForm,
    findFormItem,
    inspectLooseRequired,
    looseInputRef,
    formErrors,
    visibleOptions,
    invalidExampleValue,
} from './form.mjs';

const MODAL_SEL =
    'dialog[open]:visible,[role="dialog"]:visible,[role="alertdialog"]:visible,[data-slot="dialog-content"]:visible,[data-slot="alert-dialog-content"]:visible,.ant-drawer-open .ant-drawer-content:visible,.el-dialog:visible';
const LIVE_REF = 'data-laya-live-ref';
const actions = {
    create: /新增|新建|创建|添加|\badd\b|\bnew\b|\bcreate\b/i,
    search: /搜索|查询|查找|\bsearch\b|\bquery\b|\bfind\b/i,
    view: /查看|详情|\bview\b|\bdetail\b|图标[:：]\s*profile/i,
    edit: /编辑|修改|\bedit\b|\bupdate\b|图标[:：]\s*form/i,
    delete: /删除|移除|\bdelete\b|\bremove\b/i,
    save: /保存|提交|创建|添加|新增|\bsave\b|\bsubmit\b|^(确定|确认|confirm|ok)$/i,
    confirm: /^(确定|确认|是|确认删除|删除|delete|confirm|yes)$/i,
    close: /^(取消|关闭|close|cancel)$/i,
    more: /更多|\bmore\b|图标[:：]\s*more/i,
    area: /编辑区|编辑区域|草稿区|\bdraft\b|\bedit area\b/i,
    tab: /./,
};
const nameField = /名称|姓名|用户名|登录账号|标题|name|title/i;
const isAction = (c) =>
    ['button', 'link', 'menuitem'].includes(c.role) &&
    !c.disabled &&
    c.name.length > 0 &&
    c.name.length <= 50;
const safeKey = (s) =>
    s
        .replace(/[^a-z0-9_-]/gi, '-')
        .replace(/-+/g, '-')
        .slice(0, 85);
const ownName = () => `LayaAuto_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
const controlInfo = (c) => ({ name: c.name, role: c.role, scope: c.scope || 'page' });
const message = (e) => safeText(e?.message || String(e), 1200);

export function validateWorkflow(file) {
    if (file?.schemaVersion !== 1 || !Array.isArray(file.cases) || !file.cases.length)
        throw Error('用例文件没有可执行的已验证用例');
    if (!file.moduleUrl || !/^https?:\/\//.test(file.moduleUrl))
        throw Error('用例文件缺少有效页面地址');
    const allowed = new Set([
        'click',
        'fill',
        'form-fill',
        'form-fill-required',
        'form-select',
        'form-date',
        'assert-form-errors',
        'assert-input-invalid',
        'assert-row',
        'assert-absent',
        'assert-text',
        'assert-control',
        'assert-selected',
        'assert-headers',
        'assert-disabled',
        'reload',
        'assert-discovery',
    ]);
    for (const c of file.cases) {
        if (
            ![
                'tabs',
                'tab-switch',
                'table',
                'filters',
                'form-validation',
                'form-invalid',
                'create',
                'search',
                'view',
                'edit',
                'delete',
                'discover',
            ].includes(c.operation) ||
            !Array.isArray(c.steps) ||
            !c.steps.length
        )
            throw Error('用例包含不支持的操作：' + c.id);
        for (const step of c.steps) {
            if (c.operation === 'discover') {
                if (step.kind !== 'assert-discovery') throw Error('补充测试只允许受限的验证步骤');
                validateDiscovery(step);
                continue;
            }
            if (step.kind === 'assert-discovery') throw Error('补充测试步骤必须属于 discover');
            if (!allowed.has(step.kind)) throw Error('用例包含不支持的步骤：' + step.kind);
            if (step.kind === 'assert-disabled' && (!step.target?.name || !step.target?.role))
                throw Error('禁用态断言缺少控件名称和角色');
            if (['click', 'fill'].includes(step.kind) && (!step.target?.name || !step.target?.role))
                throw Error('用例步骤缺少控件名称和角色');
            if (
                step.kind === 'form-date' &&
                (!step.target?.label || typeof step.value !== 'string')
            )
                throw Error('日期步骤缺少字段或日期值');
            if (
                step.kind === 'form-fill' &&
                (!step.target?.label ||
                    !Number.isInteger(step.target.index) ||
                    step.target.index < 0 ||
                    typeof step.value !== 'string')
            )
                throw Error('表单填写步骤缺少字段、序号或值');
            if (
                step.kind === 'form-fill-required' &&
                (!Number.isInteger(step.target?.index) ||
                    step.target.index < 0 ||
                    typeof step.target.placeholder !== 'string' ||
                    typeof step.value !== 'string')
            )
                throw Error('必填输入步骤缺少提示、序号或值');
            if (
                step.kind === 'form-select' &&
                (!step.target?.label ||
                    !Array.isArray(step.path) ||
                    !step.path.length ||
                    step.path.some((x) => typeof x !== 'string' || !x))
            )
                throw Error('表单选择步骤缺少字段或选项路径');
            if (
                step.kind === 'assert-form-errors' &&
                (!Array.isArray(step.value) ||
                    !step.value.length ||
                    step.value.some((x) => typeof x !== 'string'))
            )
                throw Error('表单校验步骤缺少已验证错误字段');
            if (
                step.kind === 'assert-input-invalid' &&
                (!Number.isInteger(step.target?.index) ||
                    step.target.index < 0 ||
                    typeof step.target.placeholder !== 'string')
            )
                throw Error('格式校验步骤缺少目标输入框');
            if (
                step.target?.scope === 'owned-row' &&
                !['view', 'edit', 'delete'].includes(c.operation)
            )
                throw Error('独立记录操作不属于查看、修改或删除用例');
            if (step.kind === 'click') {
                const purpose = step.purpose;
                if (!actions[purpose]?.test(step.target.name))
                    throw Error('点击步骤与其操作意图不一致：' + step.target.name);
                if (purpose === 'tab' && step.target.role !== 'tab')
                    throw Error('Tab切换只能使用页面Tab控件');
                if (purpose === 'confirm' && step.target.role !== 'button')
                    throw Error('确认操作只能点击确认按钮');
                if (
                    ['view', 'edit', 'delete', 'more'].includes(purpose) &&
                    step.target.scope !== 'owned-row'
                )
                    throw Error('查看、修改和删除只能定位本轮独立记录');
                if (
                    ['save'].includes(purpose) &&
                    !['create', 'edit', 'form-validation', 'form-invalid'].includes(c.operation)
                )
                    throw Error('保存步骤不属于写入或表单校验用例');
                if (
                    purpose === 'save' &&
                    /^(确定|确认|confirm|ok)$/i.test(step.target.name) &&
                    step.target.scope !== 'form'
                )
                    throw Error('表单确认提交只能定位当前表单');
                if (
                    (purpose === 'delete' && c.operation !== 'delete') ||
                    (purpose === 'edit' && c.operation !== 'edit') ||
                    (purpose === 'create' &&
                        !['create', 'form-validation', 'form-invalid'].includes(c.operation)) ||
                    (purpose === 'confirm' && c.operation !== 'delete')
                )
                    throw Error('用例操作顺序不受支持');
            }
            if (
                c.operation === 'form-validation' &&
                ['form-fill', 'form-fill-required', 'form-select', 'form-date'].includes(step.kind)
            )
                throw Error('空表单校验用例不能填入数据');
        }
    }
    return file;
}

export class Workflow {
    constructor(page, laya, config, mode, diagnostics) {
        this.page = page;
        this.laya = laya;
        this.config = config;
        this.mode = mode;
        this.diagnostics = diagnostics;
        this.variables = { recordName: ownName() };
        this.variables.recordAccount = this.variables.recordName.toLowerCase();
        this.variables.expiryDate = tomorrowDate();
        this.variables.updatedName = this.variables.recordName + '_edited';
        this.log = [];
        this.created = false;
        this.currentName = this.variables.recordName;
        this.pendingWrites = new PendingWrites(page);
        this.startUrl = page.url();
        this.journal = config.journal;
        this.allowed = workflowPolicy(config);
        this.results = [];
        this.pendingWrite = null;
        // One retry budget per logical step; nested helpers share the same budget.
        for (const name of [
            'click',
            'clickCreate',
            'field',
            'fill',
            'formFill',
            'formFillRequired',
            'formSelect',
            'formDate',
            'assertInputInvalid',
            'assertFormErrors',
            'row',
            'reload',
            'assertControl',
            'assertHeaders',
            'clickTab',
            'replayStep',
        ]) {
            const operation = this[name].bind(this);
            this[name] = (...args) => this.withAttempts(name, () => operation(...args));
        }
    }
    checkInterrupted() {
        this.config.signal?.throwIfAborted();
    }
    async assertModuleAccess() {
        const denied = this.page.getByText(
            /^(暂无权限|无权限访问|没有访问权限|access denied|forbidden|not authorized)$/i,
        );
        for (const marker of await denied.all()) {
            if (await marker.isVisible())
                throw Error('页面显示无访问权限，未执行业务用例；请检查账号、业务空间或页面授权');
        }
    }
    runtime() {
        return { variables: this.variables, created: this.created, currentName: this.currentName };
    }
    completeCase(c) {
        this.results.push(c);
        this.journal?.completeCase(c, this.runtime());
    }
    ownedRows(name) {
        return this.page
            .locator('table tbody tr:visible,[role="rowgroup"] [role="row"]:visible')
            .filter({ has: this.page.getByText(name, { exact: true }) });
    }
    async ownedActionRows(name) {
        const row = this.ownedRows(name);
        if ((await row.count()) !== 1) throw Error('本轮独立记录不唯一：' + name);
        const key = await row.getAttribute('data-row-key');
        if (!key) return row;
        const table = row.locator(
            'xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " ant-table ")][1]',
        );
        if ((await table.count()) !== 1) return row;
        const peers = table.locator(
            `.ant-table-fixed-right tr[data-row-key=${JSON.stringify(key)}]:visible,.ant-table-fixed-left tr[data-row-key=${JSON.stringify(key)}]:visible`,
        );
        return row.or(peers);
    }
    resolve(value) {
        if (typeof value === 'object' && value?.fixture) {
            if (!Object.hasOwn(this.config.data, value.fixture))
                throw Error('执行需要 --data 中的字段：' + value.fixture);
            return String(this.config.data[value.fixture]);
        }
        if (typeof value !== 'string') throw Error('用例值格式不受支持');
        return value.replace(/\$\{([^}]+)\}/g, (_, key) => {
            if (!Object.hasOwn(this.variables, key)) throw Error('未知数据变量：' + key);
            return this.variables[key];
        });
    }
    async snapshot() {
        return observe(this.page);
    }
    async modalPresent() {
        return await this.page
            .locator(MODAL_SEL)
            .last()
            .isVisible()
            .catch(() => false);
    }
    async waitForModal(timeout = 3000) {
        await this.page
            .locator(MODAL_SEL)
            .last()
            .waitFor({ state: 'visible', timeout })
            .catch(() => {});
    }
    async waitModalClosed(timeout = 8000) {
        await this.page.locator(MODAL_SEL).last().waitFor({ state: 'hidden', timeout });
    }
    async safeClick(locator) {
        await locator.click({ timeout: 4000 });
    }
    async dispatchClick(locator, step) {
        this.checkInterrupted();
        if (
            step.purpose === 'save' &&
            /^(确定|确认|confirm|ok)$/i.test(step.target.name) &&
            !(await this.modalPresent())
        )
            throw Error('表单确认提交前必须有当前可见表单');
        // Trial checks actionability without dispatching a click. Once dispatched,
        // retry observations only: a timeout is not proof that a write failed.
        if (['save', 'delete', 'confirm'].includes(step.purpose)) {
            if (this.pendingWrite && this.pendingWrite.caseId !== this.case?.id)
                throw Error('前序用例有未确认写入，停止后续写入，请核对 checkpoint.json');
            await locator.click({ trial: true, timeout: 4000 });
            this.pendingWrite = { caseId: this.case?.id, operation: this.case?.operation, step };
            this.journal?.event('write-intent', this.pendingWrite);
            this.journal?.checkpoint({ pendingWrite: this.pendingWrite, runtime: this.runtime() });
            if (this.attemptState) {
                this.attemptState.write = step;
                this.attemptState.writeSequence = this.pendingWrites.sequence;
            }
        }
        await this.safeClick(locator, step.target.name);
    }
    async verifyWrite(step) {
        await this.pendingWrites.wait(this.config.pageTimeout || 8000);
        const op = this.case?.operation;
        if (step.purpose === 'delete' && (await this.modalPresent())) return true; // confirmation still to execute
        if (step.purpose === 'save' && op === 'form-validation') {
            const errors = await formErrors(this.page);
            return errors.open && errors.labels.length > 0;
        }
        if (await this.modalPresent()) return false;
        const deleting = ['delete', 'confirm'].includes(step.purpose) && op === 'delete';
        const name =
            op === 'create'
                ? this.variables.recordName
                : op === 'edit'
                  ? this.variables.updatedName
                  : this.currentName;
        if (!name || (!deleting && !['create', 'edit'].includes(op))) return false;
        // A rendered list is required before absence can prove a successful deletion.
        const snap = await this.snapshot();
        if (!snap.controls.length) return false;
        if (this.page.url() !== this.startUrl) return false;
        if (
            !this.pendingWrites.completed.some(
                (r) =>
                    r.sequence > this.attemptState.writeSequence &&
                    r.status >= 200 &&
                    r.status < 300 &&
                    !r.failed,
            )
        )
            return false;
        const count = await this.ownedRows(name).count();
        return deleting ? this.created && count === 0 : count === 1;
    }
    async withAttempts(label, operation) {
        this.checkInterrupted();
        if (this.attemptState) return operation();
        const state = { write: null };
        this.attemptState = state;
        const group = (this.case?.attempts?.length || 0) + 1;
        try {
            for (let attempt = 1; attempt <= 3; attempt++) {
                this.checkInterrupted();
                state.attempt = attempt;
                const entry = { step: label, attempt, status: '通过', reason: '', evidence: '' };
                try {
                    let result;
                    if (state.write) {
                        if (!(await this.verifyWrite(state.write)))
                            throw Error('写操作已尝试发送，尚未证实成功；仅复查结果，不重复提交');
                        if (!this.case?.steps.includes(state.write)) this.record(state.write);
                        result = state.write;
                    } else result = await operation();
                    this.case?.attempts?.push(entry);
                    return result;
                } catch (error) {
                    this.checkInterrupted();
                    entry.status = '失败';
                    entry.reason = message(error);
                    if (this.case) {
                        entry.evidence = `evidence/${safeKey(this.case.id)}-step-${group}-attempt-${attempt}.png`;
                        await this.page
                            .screenshot({
                                path: path.join(this.config.out, entry.evidence),
                                timeout: 5000,
                            })
                            .catch(() => {
                                entry.evidence = '';
                            });
                        this.case.attempts ??= [];
                        this.case.attempts.push(entry);
                    }
                    if (attempt === 3)
                        throw Error(`${label} 尝试3次未成功：${entry.reason}`, { cause: error });
                    await settle(this.page, 250).catch(() => {});
                }
            }
        } finally {
            this.attemptState = null;
        }
    }
    async clickCreate() {
        // withAttempts owns the three-attempt budget; retain tried names between observations.
        const tried = this.attemptState ? (this.attemptState.createTried ??= new Set()) : new Set();
        if (await this.modalPresent()) {
            if (this.attemptState?.createClicked) return;
            if (!(await this.dismissModal())) throw Error('旧弹窗未关闭，不能选择新的创建入口');
        }
        let snap = await this.snapshot();
        let candidates = snap.controls.filter((c) => isAction(c) && actions.create.test(c.name));
        if (!candidates.length) {
            await this.click('area');
            snap = await this.snapshot();
            candidates = snap.controls.filter((c) => isAction(c) && actions.create.test(c.name));
        }
        const c = candidates.find((c) => !tried.has(c.name)) || candidates[0];
        if (!c) throw Error('页面上没有创建类控件');
        const locator = snap.frames[c.frame].locator(`[${LIVE_REF}="${c.ref}"]`);
        if ((await locator.count()) !== 1 || !(await locator.isVisible()))
            throw Error('创建入口已变化');
        tried.add(c.name);
        await this.safeClick(locator, c.name);
        if (this.attemptState) this.attemptState.createClicked = true;
        this.record({
            kind: 'click',
            target: { ...controlInfo(c), scope: 'page' },
            purpose: 'create',
        });
        await settle(this.page, 150);
        await this.waitForModal(1800);
        if (!(await this.modalPresent())) throw Error('创建入口「' + c.name + '」未打开表单弹窗');
        await observeFormEvidence(this, c);
    }
    async dismissModal() {
        await this.page.keyboard.press('Escape').catch(() => {});
        if (!(await this.modalPresent())) return true;
        const close = this.page
            .locator(MODAL_SEL)
            .last()
            .locator('button:visible')
            .filter({ hasText: /^(取消|关闭|close|cancel)$/i });
        if ((await close.count()) === 1) await close.click({ timeout: 1500 });
        return !(await this.modalPresent());
    }
    async chooseFromSnapshot(snap, candidates, purpose) {
        if (!candidates.length) throw Error('页面上没有可操作的' + purpose + '控件');
        // Replay grounds actions through Laya even for a single live match.
        // DOM scope guards and assertions still determine what may run and pass.
        if (candidates.length === 1 && this.mode !== 'execute') {
            const control = candidates[0],
                locator = snap.frames[control.frame].locator(`[${LIVE_REF}="${control.ref}"]`);
            if ((await locator.count()) !== 1 || !(await locator.isVisible()))
                throw Error('决策后页面控件已变化：' + purpose);
            return { control, locator };
        }
        const shortlist = candidates.slice(0, 7),
            criteria = {},
            byChoice = new Map();
        shortlist.forEach((c, i) => {
            const key =
                shortlist.filter((x) => x.name === c.name).length === 1
                    ? c.name
                    : `${c.name} [${c.context.slice(0, 25) || c.role}] ${i + 1}`;
            criteria[key] =
                this.mode === 'execute'
                    ? `${['textbox', 'spinbutton', 'password'].includes(c.role) ? '填写' : '点击'}「${c.name}」控件${shortlist.filter((x) => x.name === c.name).length > 1 && c.context ? '，属于 ' + c.context.slice(0, 65) : ''}`
                    : `${purpose}时操作页面上的「${c.name}」${c.context ? '，属于 ' + c.context.slice(0, 65) : ''}`;
            byChoice.set(key, c);
        });
        criteria[this.mode === 'execute' ? '停止' : '无法判断'] =
            this.mode === 'execute'
                ? '没有匹配的控件，停止操作'
                : '页面控件与本次操作不匹配，不执行';
        const result = await this.laya.choose(
            this.mode === 'execute' ? `我要${purpose}。` : `要${purpose}，应选择哪个页面控件？`,
            criteria,
            {
                phase: this.mode === 'execute' ? 'replay-target' : 'target',
                mode: this.mode,
                purpose,
                url: snap.url,
                candidates: shortlist.map(({ ref, ...c }) => c),
            },
        );
        const control = byChoice.get(result.choice);
        if (!control) throw Error('Laya未能确定' + purpose + '控件');
        if (
            !(result.probabilities?.[result.choice] >= (this.config.minProbability ?? 0.68)) ||
            !(result.margin >= (this.config.minMargin ?? 0.18))
        )
            throw Error('Laya选择' + purpose + '控件的把握不足');
        const locator = snap.frames[control.frame].locator(`[${LIVE_REF}="${control.ref}"]`);
        if ((await locator.count()) !== 1 || !(await locator.isVisible()))
            throw Error('决策后页面控件已变化：' + purpose);
        return { control, locator };
    }
    async action(op, { rowName, optional = false } = {}) {
        if (op === 'save' && !(await this.modalPresent()))
            throw Error('保存表单前必须有当前可见表单');
        let snap = await this.snapshot();
        let owned;
        if (rowName) {
            owned = await this.ownedActionRows(rowName);
            const key = await this.ownedRows(rowName).getAttribute('data-row-key');
            if (key) snap = await discoverRowLabels(this.page, key);
        }
        const matching = () =>
            snap.controls.filter(
                (c) =>
                    (op === 'area' ? c.role === 'tab' && !c.disabled : isAction(c)) &&
                    actions[op].test(c.name) &&
                    (op !== 'confirm' || c.role === 'button') &&
                    (!rowName || c.context.includes(rowName)),
            );
        const inOwnedRow = async (items) => {
            if (!owned) return items;
            const scoped = [];
            for (const c of items)
                if (await owned.locator(`[${LIVE_REF}="${c.ref}"]`).count()) scoped.push(c);
            return scoped;
        };
        let candidates = await inOwnedRow(matching());
        if (op === 'confirm') {
            const confirmation = this.page.locator(MODAL_SEL + ',.ant-popover:visible');
            const scoped = [];
            for (const c of candidates)
                if (await confirmation.locator(`[${LIVE_REF}="${c.ref}"]`).count()) scoped.push(c);
            candidates = scoped;
        }
        if (op === 'search') {
            const explicit = candidates.filter((c) =>
                /^(搜索|查询|查找|search|query|find)$/i.test(c.name),
            );
            if (explicit.length === 1) candidates = explicit;
        }
        if (op === 'close' && (await this.modalPresent())) {
            const cancel = candidates.filter((c) => /^(取消|cancel)$/i.test(c.name));
            if (cancel.length === 1) candidates = cancel;
        }
        if (!candidates.length && rowName && ['edit', 'delete', 'view'].includes(op)) {
            const more = await inOwnedRow(
                snap.controls.filter(
                    (c) => isAction(c) && actions.more.test(c.name) && c.context.includes(rowName),
                ),
            );
            if (more.length) {
                const opened = await this.chooseFromSnapshot(
                    snap,
                    more,
                    '展开本轮独立记录的更多操作',
                );
                await opened.locator.click();
                await settle(this.page, 100);
                this.record({
                    kind: 'click',
                    target: { ...controlInfo(opened.control), scope: 'owned-row' },
                    purpose: 'more',
                });
                snap = await this.snapshot();
                candidates = snap.controls.filter((c) => isAction(c) && actions[op].test(c.name));
            }
        }
        if (!candidates.length && optional) return null;
        const selected = await this.chooseFromSnapshot(
            snap,
            candidates,
            {
                area: '进入可编辑区域',
                create: '创建独立记录',
                search: '搜索记录',
                view: '查看独立记录',
                edit: '修改独立记录',
                delete: '删除独立记录',
                save: '保存表单',
                confirm: '确认删除',
                close: '关闭详情',
            }[op],
        );
        const scope = rowName
            ? 'owned-row'
            : op === 'save' || op === 'confirm' || op === 'close'
              ? 'form'
              : 'page';
        return {
            ...selected,
            // Preserve the exact owned-row identity while letting Playwright resolve
            // a replacement DOM node between trial and dispatch. Icon-only controls
            // without a matching accessible name retain the observed live reference.
            locator:
                owned &&
                selected.control.role !== 'menuitem' &&
                (await owned
                    .getByRole(selected.control.role, { name: selected.control.name, exact: true })
                    .count()) === 1
                    ? owned.getByRole(selected.control.role, {
                          name: selected.control.name,
                          exact: true,
                      })
                    : selected.locator,
            step: {
                kind: 'click',
                target: { ...controlInfo(selected.control), scope },
                purpose: op,
            },
        };
    }
    async click(op, options) {
        const found = await this.action(op, options);
        if (!found) return null;
        await this.dispatchClick(found.locator, found.step);
        this.record(found.step);
        await settle(this.page, 120);
        return found.step;
    }
    async field(purpose, { name } = {}) {
        const snap = await this.snapshot();
        const fields = snap.controls.filter(
            (c) => ['textbox', 'spinbutton'].includes(c.role) && !c.disabled && !c.readonly,
        );
        const matches = fields.filter((c) => (name ? c.name === name : nameField.test(c.name)));
        return this.chooseFromSnapshot(snap, matches, purpose);
    }
    record(step) {
        if (this.case) this.case.steps.push(step);
        this.log.push({ at: new Date().toISOString(), step, url: this.page.url() });
        this.journal?.event('step-completed', { caseId: this.case?.id, step });
        this.journal?.checkpoint({ activeCase: this.case, runtime: this.runtime() });
    }
    async fill(field, value, scope = 'form') {
        if (this.attemptState?.attempt > 1) {
            const snap = await this.snapshot();
            field = await this.chooseFromSnapshot(
                snap,
                snap.controls.filter(
                    (c) =>
                        c.name === field.control.name &&
                        c.role === field.control.role &&
                        !c.disabled &&
                        !c.readonly,
                ),
                '重新定位输入框',
            );
        }
        const actual = this.resolve(value);
        await field.locator.fill(actual);
        if ((await field.locator.inputValue()) !== actual)
            throw Error('输入值没有进入' + field.control.name);
        this.record({ kind: 'fill', target: { ...controlInfo(field.control), scope }, value });
        await settle(this.page, 80);
    }
    async matchFormTarget(label, kind = 'fill', index = 0) {
        if (this.mode !== 'execute') return;
        const fields = (await inspectForm(this.page)).filter((f) =>
            kind === 'select'
                ? f.combo
                : !f.combo &&
                  f.inputs.filter((i) => i.type !== 'search')[index] &&
                  (kind === 'date' || !f.inputs.filter((i) => i.type !== 'search')[index].readonly),
        );
        await matchReplayTarget(
            this.laya,
            kind === 'select' ? '选择' : '填写',
            label,
            fields.map((f) => ({
                name: f.label,
                description:
                    kind === 'select'
                        ? '下拉选择框'
                        : `第${index + 1}个输入框，类型 ${f.inputs.filter((i) => i.type !== 'search')[index].type}`,
            })),
            this.config,
            { field: label, targetType: 'field' },
        );
    }
    async formFill(label, index, value) {
        await this.matchFormTarget(label, 'fill', index);
        const { item } = await findFormItem(this.page, label);
        const inputs = item.locator(
            'input:not([type="hidden"]):not([type="search"]):visible,textarea:visible',
        );
        if ((await inputs.count()) <= index)
            throw Error(`表单「${label}」第${index + 1}个输入框已变化`);
        const input = inputs.nth(index),
            actual = this.resolve(value);
        if (!(await input.isEditable()))
            throw Error(`表单「${label}」第${index + 1}个输入框不可编辑`);
        await input.fill(actual);
        if ((await input.inputValue()) !== actual) throw Error(`表单「${label}」的输入值未生效`);
        this.record({ kind: 'form-fill', target: { label, index }, value });
        await settle(this.page, 90);
    }
    async formFillRequired(target, value) {
        const actual = this.resolve(value),
            name = target.label || target.placeholder || '必填项';
        const ref = await looseInputRef(this.page, target);
        if (!ref) throw Error(`必填输入框「${name}」已变化或不可定位`);
        const input = this.page.locator(`[data-laya-form-ref="${ref}"]`);
        if (this.mode === 'execute') {
            const type = await input.getAttribute('type');
            await matchReplayTarget(
                this.laya,
                '填写',
                name,
                [{ name, description: `输入框，类型 ${type || 'text'}` }],
                this.config,
            );
        }
        if (!(await input.isEditable())) throw Error(`必填输入框「${name}」不可编辑`);
        await input.fill(actual);
        if ((await input.inputValue()) !== actual) throw Error(`必填输入框「${name}」输入值未生效`);
        this.record({
            kind: 'form-fill-required',
            target: {
                label: target.label || '',
                placeholder: target.placeholder || '',
                index: target.index || 0,
            },
            value,
        });
        await settle(this.page, 90);
    }
    async assertInputInvalid(target) {
        const ref = await looseInputRef(this.page, target);
        if (!ref) throw Error(`必填输入框「${target.label || target.placeholder}」已变化`);
        const input = this.page.locator(`[data-laya-form-ref="${ref}"]`);
        const invalid = await input.evaluate(
            (e) =>
                e.getAttribute('aria-invalid') === 'true' ||
                !!e.closest('.ant-form-item-has-error,.has-error,.is-error') ||
                !e.checkValidity(),
        );
        if (!invalid)
            throw Error(`「${target.label || target.placeholder}」非法格式未显示字段校验错误`);
        this.record({
            kind: 'assert-input-invalid',
            target: {
                label: target.label || '',
                placeholder: target.placeholder || '',
                index: target.index || 0,
            },
        });
    }
    async formSelect(label, savedPath) {
        await this.matchFormTarget(label, 'select');
        const { item } = await findFormItem(this.page, label);
        const control = item.locator('[role="combobox"]:visible,select:visible');
        if ((await control.count()) !== 1)
            throw Error('「' + label + '」没有可识别的下拉或树选择控件');
        if (await control.evaluate((e) => e.tagName === 'SELECT')) {
            const options = await control.evaluate((e) =>
                [...e.options]
                    .filter(
                        (o) =>
                            !o.disabled &&
                            !o.closest('optgroup[disabled]') &&
                            o.value &&
                            !/^(全部|所有|请选择|无)$/.test(o.label.trim()),
                    )
                    .map((o) => ({ label: o.label.trim(), value: o.value })),
            );
            const choice =
                savedPath?.[0] ||
                (
                    await chooseTestOption(
                        this.laya,
                        label,
                        options.map((o) => ({ ...o, name: o.label })),
                        this.config,
                    )
                ).name;
            const matches = options.filter((o) => o.label === choice);
            if ((savedPath && savedPath.length !== 1) || matches.length !== 1)
                throw Error(`「${label}」没有唯一可选项：${choice || '空'}`);
            // The model grounds the field; a saved option is test data, bound exactly.
            await control.selectOption({ label: choice });
            const selected = await control.evaluate((e) =>
                [...e.selectedOptions].map((o) => o.label.trim()),
            );
            if (selected.length !== 1 || selected[0] !== choice)
                throw Error(`「${label}」选择未生效`);
            this.record({ kind: 'form-select', target: { label }, path: [choice] });
            return [choice];
        }
        await control.click();
        await settle(this.page, 120);
        const path = [],
            seen = new Set(),
            max = savedPath?.length || 5;
        for (let depth = 0; depth < max; depth++) {
            let options = [];
            const deadline = Date.now() + (this.config.pageTimeout || 8000);
            do {
                options = (await visibleOptions(this.page)).filter(
                    (x) => !seen.has(x.name) && !/^(全部|所有|请选择|无)$/.test(x.name),
                );
                if (options.length) break;
                await this.page.waitForTimeout(100);
            } while (Date.now() < deadline);
            const choice =
                savedPath?.[depth] ||
                (await chooseTestOption(this.laya, label, options, this.config)).name;
            if (!choice || !options.some((x) => x.name === choice))
                throw Error(
                    `「${label}」没有可用的${savedPath ? '指定' : '可选'}选项：${choice || '空'}`,
                );
            if (options.filter((x) => x.name === choice).length !== 1)
                throw Error(`「${label}」选项重名，无法安全选择：${choice}`);
            const selected = options.find((x) => x.name === choice),
                match = this.page.locator(`[data-laya-option-ref="${selected.ref}"]`);
            if ((await match.count()) !== 1 || !(await match.isVisible()))
                throw Error(`「${label}」选项在点击前已变化：${choice}`);
            await match.click();
            path.push(choice);
            seen.add(choice);
            await settle(this.page, 130);
            if (savedPath) continue;
            const current = (await findFormItem(this.page, label)).info;
            const shown = current.sectionText.replace(current.label, '').trim();
            if (current.chosen || shown === choice) break;
        }
        if (!path.length) throw Error('「' + label + '」未选中任何选项');
        const header = this.page.locator(
            '.ant-drawer-title:visible,.el-dialog__title:visible,[role="dialog"] h2:visible',
        );
        if (await header.count())
            await header
                .last()
                .click()
                .catch(() => {});
        const final = (await findFormItem(this.page, label)).info;
        if (!final.sectionText.includes(path.at(-1)))
            throw Error(`「${label}」选择后未显示指定值：${path.at(-1)}`);
        this.record({ kind: 'form-select', target: { label }, path });
        return path;
    }
    async formDate(label, value = '${expiryDate}') {
        await this.matchFormTarget(label, 'date');
        const actual = this.resolve(value);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(actual)) throw Error('日期值必须为 YYYY-MM-DD');
        let { item } = await findFormItem(this.page, label);
        let input = item.locator('input:visible');
        if ((await input.count()) !== 1) throw Error(`「${label}」日期输入框不唯一`);
        if (await input.isEditable()) {
            await input.fill(actual);
            await input.press('Tab');
        } else {
            await input.click();
            const [year, month, day] = actual.split('-').map(Number);
            const calendar = this.page.locator('.ant-calendar:visible,.ant-picker-panel:visible');
            await calendar.waitFor({ state: 'visible', timeout: this.config.assertTimeout });
            const cell = calendar
                .locator(`[title="${year}年${month}月${day}日"],[title="${actual}"]`)
                .filter({ visible: true });
            if (
                (await cell.count()) !== 1 ||
                (await cell.evaluate(
                    (e) =>
                        e.matches(
                            '[aria-disabled="true"],.ant-calendar-disabled-cell,.ant-picker-cell-disabled',
                        ) || !!e.querySelector('[aria-disabled="true"]'),
                ))
            )
                throw Error(`「${label}」日历中没有唯一可用日期：${actual}`);
            await cell.click();
        }
        ({ item } = await findFormItem(this.page, label));
        input = item.locator('input:visible');
        if ((await input.inputValue()).replaceAll('/', '-') !== actual)
            throw Error(`「${label}」日期选择未生效`);
        this.record({ kind: 'form-date', target: { label }, value });
    }
    async fillRecordName(value) {
        const fields = (await inspectForm(this.page)).filter(
            (x) =>
                nameField.test(x.label) &&
                !accountField.test(x.label) &&
                x.inputs.some((i) => !i.readonly && i.type !== 'search'),
        );
        if (fields.length === 1) {
            const plan = await chooseFieldValue(
                this.laya,
                { ...fields[0].inputs[0], label: fields[0].label },
                { name: value },
            );
            if (plan.strategy !== '名称') throw Error('模型未将记录名称字段识别为名称');
            await this.formFill(fields[0].label, 0, value);
            return fields[0].label;
        }
        const field = await this.field('填写记录名称');
        const plan = await chooseFieldValue(
            this.laya,
            { label: field.control.name },
            { name: value },
        );
        if (plan.strategy !== '名称') throw Error('模型未将记录名称字段识别为名称');
        await this.fill(field, value);
        return null;
    }
    async populateForm(nameLabel) {
        const fields = (await inspectForm(this.page)).filter(
            (x) => x.required && x.label !== nameLabel,
        );
        for (const original of fields) {
            const { info } = await findFormItem(this.page, original.label);
            if (info.combo) {
                const configured = this.config.data?.[info.label];
                if (!info.chosen)
                    await this.formSelect(
                        info.label,
                        configured
                            ? Array.isArray(configured)
                                ? configured
                                : [String(configured)]
                            : undefined,
                    );
                continue;
            }
            if (expiryField.test(info.label) && info.inputs.length === 1) {
                if (!info.inputs[0].value) {
                    const plan = await chooseFieldValue(this.laya, {
                        ...info.inputs[0],
                        label: info.label,
                    });
                    if (plan.kind !== 'date') throw Error('模型未将日期字段识别为日期');
                    await this.formDate(info.label, plan.value);
                }
                continue;
            }
            const editable = info.inputs.filter((x) => !x.readonly && x.type !== 'search');
            if (!editable.length) continue;
            for (let index = 0; index < editable.length; index++) {
                if (editable[index].value) continue;
                const plan = Object.hasOwn(this.config.data || {}, info.label)
                    ? { kind: 'fill', value: String(this.config.data[info.label]) }
                    : await chooseFieldValue(
                          this.laya,
                          { ...editable[index], label: info.label },
                          { index },
                      );
                if (plan.kind === 'date') await this.formDate(info.label, plan.value);
                else await this.formFill(info.label, index, plan.value);
            }
        }
        // 动态循环：React 受控表单填写后可能摘掉已填字段的 required 属性，固定序号必然
        // 漂移。每轮重新探测、只填当前为空的项，label 优先定位，guard 防死循环。
        for (let guard = 0; guard < 15; guard++) {
            const remaining = (await inspectLooseRequired(this.page)).filter((x) => !x.value);
            if (!remaining.length) break;
            const input = remaining[0];
            const value = Object.hasOwn(this.config.data || {}, input.label)
                ? String(this.config.data[input.label])
                : (await chooseFieldValue(this.laya, input, { index: input.index })).value;
            await this.formFillRequired(input, value);
        }
    }
    async assertFormErrors(labels) {
        const actual = await formErrors(this.page);
        if (!actual.open || !actual.labels.length)
            throw Error('空表单保存后未出现可识别的字段校验错误');
        if (labels?.length) {
            const missing = labels.filter((x) => !actual.labels.includes(x));
            if (missing.length) throw Error('缺少原先观察到的必填错误字段：' + missing.join('、'));
        }
        this.record({ kind: 'assert-form-errors', value: actual.labels });
        return actual;
    }
    async row(value, present = true) {
        const name = this.resolve(value),
            rows = this.ownedRows(name);
        if (present) await rows.first().waitFor({ timeout: this.config.assertTimeout });
        else {
            // A missing list or a loading page is not proof of deletion.
            await this.page
                .locator('table:visible,[role="grid"]:visible')
                .first()
                .waitFor({ state: 'visible', timeout: this.config.assertTimeout });
            await rows.first().waitFor({ state: 'hidden', timeout: this.config.assertTimeout });
        }
        const count = await rows.count();
        if ((present && count !== 1) || (!present && count !== 0))
            throw Error(`列表独立记录数量不符合预期：${name} (${count})`);
        this.record({ kind: present ? 'assert-row' : 'assert-absent', value });
    }
    async query(value, { assert = true } = {}) {
        const search = await this.field('按名称查询独立记录');
        const byAccount = /登录账号|登录账户|account|login/i.test(search.control.name);
        await this.fill(search, byAccount ? '${recordAccount}' : value, 'page');
        const button = await this.action('search', { optional: true });
        if (button) {
            await button.locator.click();
            this.record(button.step);
            await settle(this.page, 180);
        }
        if (assert) await this.row(value, true);
    }
    async reload() {
        const lastClick = this.case?.steps.findLast((step) => step.kind === 'click');
        if (['save', 'delete', 'confirm'].includes(lastClick?.purpose))
            await this.waitModalClosed();
        await this.pendingWrites.wait(this.config.pageTimeout || 8000);
        await this.page.reload({ waitUntil: 'domcontentloaded' });
        await waitForReady(this.page, { timeout: this.config.pageTimeout });
        this.record({ kind: 'reload' });
    }
    async assertControl(role, name, selected = false) {
        const snap = await this.snapshot(),
            matches = snap.controls.filter(
                (c) => c.role === role && c.name === name && !c.disabled,
            );
        if (matches.length !== 1)
            throw Error(`页面中的「${name}」${role}控件数量为${matches.length}，不能明确断言`);
        if (selected && !matches[0].selected) throw Error(`「${name}」Tab没有选中`);
        this.record({
            kind: selected ? 'assert-selected' : 'assert-control',
            target: { role, name },
        });
    }
    async assertHeaders(headers) {
        const visible = [
            ...new Set(
                (await this.page.locator('table:visible thead th:visible').allTextContents())
                    .map((x) => x.replace(/\s+/g, ' ').trim())
                    .filter(Boolean),
            ),
        ];
        const missing = headers.filter((x) => !visible.includes(x));
        if (missing.length) throw Error('列表缺少列头：' + missing.join('、'));
        this.record({ kind: 'assert-headers', value: headers });
    }
    async clickTab(name) {
        const snap = await this.snapshot(),
            matches = snap.controls.filter(
                (c) => c.role === 'tab' && c.name === name && !c.disabled,
            );
        const found = await this.chooseFromSnapshot(snap, matches, '切换到「' + name + '」Tab');
        await found.locator.click();
        this.record({
            kind: 'click',
            target: { ...controlInfo(found.control), scope: 'page' },
            purpose: 'tab',
        });
        await settle(this.page, 180);
    }
    async runCase(id, title, operation, fn) {
        this.checkInterrupted();
        const started = performance.now();
        const c = {
            id,
            title,
            operation,
            steps: [],
            status: '生成中',
            reason: '',
            evidence: '',
            attempts: [],
        };
        this.case = c;
        this.diagnostics.begin(id);
        this.journal?.checkpoint({ activeCase: c, runtime: this.runtime() });
        try {
            await fn();
            c.status = '已验证';
            c.reason = '生成时已实际执行并通过页面断言';
        } catch (e) {
            this.checkInterrupted();
            c.status = e.notApplicable ? '不适用' : '未生成';
            c.reason = message(e);
        }
        // Capture evidence before closing any remaining form for the next case.
        c.evidence = `evidence/${id}.png`;
        await this.page
            .screenshot({ path: path.join(this.config.out, c.evidence), timeout: 5000 })
            .catch(() => {
                c.evidence = '';
            });
        await this.page.waitForTimeout(150).catch(() => {});
        c.browserEvents = await this.diagnostics.end();
        const severe = severeEvent(c.browserEvents);
        if (c.status === '已验证' && severe) {
            c.status = '未生成';
            c.reason = '页面断言通过，但本用例期间发现 ' + eventLabel(severe);
        }
        c.diagnosis = c.status === '未生成' ? diagnoseFailure(c.reason, c.browserEvents) : null;
        if (await this.modalPresent().catch(() => false)) {
            try {
                await this.pendingWrites.wait(this.config.pageTimeout || 8000);
                await this.dismissModal();
            } catch {}
        }
        if (c.status === '已验证' && this.pendingWrite?.caseId === c.id) this.pendingWrite = null;
        this.journal?.checkpoint({ pendingWrite: this.pendingWrite });
        c.durationMs = Math.round(performance.now() - started);
        this.case = null;
        return c;
    }
    async generate() {
        await this.assertModuleAccess();
        const results = this.results,
            add = async (...args) => {
                this.checkInterrupted();
                if (!this.allowed.has(args[2])) return false;
                const r = await this.runCase(...args);
                this.completeCase(r);
                console.log(`${r.status} ${r.id}: ${r.reason}`);
                return r.status === '已验证';
            };
        const initial = await this.snapshot(),
            tabs = initial.controls.filter(
                (c) => c.role === 'tab' && c.name && c.name.length <= 30,
            ),
            selectedTab = tabs.find((c) => c.selected)?.name;
        if (tabs.length >= 2) {
            await add('tabs', '页签入口可见', 'tabs', async () => {
                for (const tab of tabs.slice(0, 4)) await this.assertControl('tab', tab.name);
            });
            if (selectedTab)
                await add('tab-switch', '页签切换后可见并可切回', 'tab-switch', async () => {
                    const other = tabs.find((c) => c.name !== selectedTab);
                    await this.clickTab(other.name);
                    await this.assertControl('tab', other.name, true);
                    await this.clickTab(selectedTab);
                    await this.assertControl('tab', selectedTab, true);
                });
        }
        const headers = [
            ...new Set(
                (await this.page.locator('table:visible thead th:visible').allTextContents())
                    .map((x) => x.replace(/\s+/g, ' ').trim())
                    .filter(Boolean),
            ),
        ].slice(0, 20);
        if (headers.length >= 2)
            await add('table', '列表列头可见', 'table', async () => {
                await this.assertHeaders(headers);
            });
        const filterSnap = await this.snapshot(),
            nameFilter = filterSnap.controls.find(
                (c) => c.role === 'textbox' && nameField.test(c.name),
            ),
            search = filterSnap.controls.find((c) => isAction(c) && actions.search.test(c.name)),
            reset = filterSnap.controls.find((c) => isAction(c) && /^(重置|reset)$/i.test(c.name));
        if (nameFilter)
            await add('filters', '筛选控件可见', 'filters', async () => {
                await this.assertControl(nameFilter.role, nameFilter.name);
                if (search) await this.assertControl(search.role, search.name);
                if (reset) await this.assertControl(reset.role, reset.name);
            });
        await add(
            'form-validation',
            '新增表单必填项为空时阻止保存',
            'form-validation',
            async () => {
                const snap = await this.snapshot();
                if (!snap.controls.some((c) => isAction(c) && actions.create.test(c.name)))
                    await this.click('area');
                await this.clickCreate();
                const saveControls = (await this.snapshot()).controls.filter(
                    (c) => actions.save.test(c.name) && c.role === 'button',
                );
                if (saveControls.length === 1 && saveControls[0].disabled) {
                    await this.replayStep({
                        kind: 'assert-disabled',
                        target: controlInfo(saveControls[0]),
                    });
                    await this.click('close');
                    return;
                }
                await this.click('save');
                await this.assertFormErrors();
                await this.click('close');
            },
        );
        await add('form-invalid', '数值区间示例的非法括号触发校验', 'form-invalid', async () => {
            await this.clickCreate();
            try {
                const formatTarget = (await inspectLooseRequired(this.page)).find((x) =>
                    invalidExampleValue(x.placeholder),
                );
                if (!formatTarget) {
                    const error = Error('页面没有区间格式输入框，本项不适用');
                    error.notApplicable = true;
                    throw error;
                }
                const name = await this.field('填写校验记录名称');
                await this.fill(name, '${recordName}_invalid');
                await this.populateForm('名称');
                const target = (await inspectLooseRequired(this.page)).find((x) =>
                    invalidExampleValue(x.placeholder),
                );
                if (!target) throw Error('格式校验输入框在填写后发生变化');
                await this.formFillRequired(target, invalidExampleValue(target.placeholder));
                await this.click('save');
                await this.assertInputInvalid(target);
            } finally {
                if ((await formErrors(this.page)).open) await this.click('close').catch(() => {});
            }
        });
        const created = await add('create', '新增独立测试记录', 'create', async () => {
            let snap = await this.snapshot();
            if (!snap.controls.some((c) => isAction(c) && actions.create.test(c.name))) {
                await this.click('area');
                snap = await this.snapshot();
            }
            await this.clickCreate();
            const nameLabel = await this.fillRecordName('${recordName}');
            await this.populateForm(nameLabel);
            await this.click('save');
            await this.reload();
            await this.query('${recordName}');
            this.created = true;
        });
        if (created) {
            await add('search', '按名称查询刚创建的记录', 'search', async () => {
                await this.query('${recordName}');
            });
            await add('view', '查看独立测试记录', 'view', async () => {
                if (!(await this.click('view', { rowName: this.currentName, optional: true })))
                    throw Error('列表没有可识别的查看详情入口');
                await this.page
                    .locator(MODAL_SEL)
                    .last()
                    .getByText(this.currentName, { exact: false })
                    .first()
                    .waitFor({ timeout: this.config.assertTimeout });
                this.record({ kind: 'assert-text', value: '${recordName}', scope: 'form' });
                await this.click('close');
            });
            const edited = await add('edit', '修改独立测试记录名称', 'edit', async () => {
                await this.query('${recordName}');
                await this.click('edit', { rowName: this.currentName });
                await this.fillRecordName('${updatedName}');
                await this.click('save');
                await this.reload();
                await this.query('${updatedName}');
                this.currentName = this.variables.updatedName;
            });
            if (edited || !this.allowed.has('edit'))
                await add('delete', '删除独立测试记录', 'delete', async () => {
                    const value = edited ? '${updatedName}' : '${recordName}';
                    await this.query(value);
                    await this.click('delete', { rowName: this.currentName });
                    const dialog = this.page.locator(MODAL_SEL + ',.ant-popover:visible');
                    if (await dialog.count()) await this.click('confirm');
                    await this.reload();
                    await this.query(value, { assert: false });
                    await this.row(value, false);
                    this.created = false;
                });
            else if (this.allowed.has('delete'))
                this.completeCase({
                    id: 'delete',
                    title: '删除独立测试记录',
                    operation: 'delete',
                    status: '未执行（依赖阻断）',
                    reason: '修改未验证成功，记录状态未确认',
                    steps: [],
                    attempts: [],
                    evidence: '',
                });
        }
        if (!created)
            for (const id of ['search', 'view', 'edit', 'delete'].filter((op) =>
                this.allowed.has(op),
            ))
                this.completeCase({
                    id,
                    title: id,
                    operation: id,
                    status: '未执行（依赖阻断）',
                    reason: '新增未验证成功，缺少本轮独立记录',
                    steps: [],
                    attempts: [],
                    evidence: '',
                });
        if (this.allowed.has('discover')) await discoverTests(this);
        if (!results.length)
            throw Error(
                '当前页面未发现所选范围的可验证用例；请检查页面是否为目标模块及 --operations 配置',
            );
        return results;
    }
    async replayStep(step) {
        if (step.kind === 'assert-discovery') return executeDiscovery(this, step);
        if (step.kind === 'assert-control' || step.kind === 'assert-selected')
            return this.assertControl(
                step.target.role,
                step.target.name,
                step.kind === 'assert-selected',
            );
        if (step.kind === 'assert-disabled') {
            const snap = await this.snapshot();
            const matches = snap.controls.filter(
                (c) => c.name === step.target.name && c.role === step.target.role,
            );
            if (matches.length !== 1) throw Error('禁用态断言目标不唯一：' + step.target.name);
            if (!matches[0].disabled)
                throw Error(
                    '「' + step.target.name + '」控件未被禁用（表单必填项为空时未阻止保存）',
                );
            this.record(step);
            return;
        }
        if (step.kind === 'assert-headers') return this.assertHeaders(step.value);
        if (step.kind === 'assert-form-errors') return this.assertFormErrors(step.value);
        if (step.kind === 'assert-input-invalid') return this.assertInputInvalid(step.target);
        if (step.kind === 'form-fill')
            return this.formFill(step.target.label, step.target.index, step.value);
        if (step.kind === 'form-fill-required')
            return this.formFillRequired(step.target, step.value);
        if (step.kind === 'form-select') return this.formSelect(step.target.label, step.path);
        if (step.kind === 'form-date') return this.formDate(step.target.label, step.value);
        if (step.kind === 'reload') return this.reload();
        if (step.kind === 'assert-row' || step.kind === 'assert-absent')
            return this.row(step.value, step.kind === 'assert-row');
        if (step.kind === 'assert-text') {
            const text = this.resolve(step.value),
                root =
                    step.scope === 'form'
                        ? this.page.locator(MODAL_SEL).last()
                        : this.page.locator('body');
            await root
                .getByText(text, { exact: false })
                .first()
                .waitFor({ timeout: this.config.assertTimeout });
            this.record(step);
            return;
        }
        const target = step.target;
        const rowMenu =
            target.scope === 'owned-row' &&
            target.role === 'menuitem' &&
            this.case?.steps.at(-1)?.purpose === 'more' &&
            this.case.steps.at(-1).target?.scope === 'owned-row';
        if (target.scope === 'owned-row') {
            if (!this.created) throw Error('尚未创建本轮独立记录，不能修改或删除');
            const rows = this.ownedRows(this.currentName);
            if ((await rows.count()) !== 1) throw Error('找不到本轮独立记录：' + this.currentName);
        }
        let snap = await this.snapshot();
        if (target.scope === 'owned-row' && !rowMenu) {
            const key = await this.ownedRows(this.currentName).getAttribute('data-row-key');
            if (key) snap = await discoverRowLabels(this.page, key);
        }
        const matches = snap.controls.filter(
            (c) =>
                c.name === target.name &&
                c.role === target.role &&
                !c.disabled &&
                !c.readonly &&
                (target.scope !== 'owned-row' || rowMenu || c.context.includes(this.currentName)),
        );
        const scoped = [];
        for (const c of matches) {
            if (
                target.scope !== 'owned-row' ||
                rowMenu ||
                (await (
                    await this.ownedActionRows(this.currentName)
                )
                    .locator(`[${LIVE_REF}="${c.ref}"]`)
                    .count())
            )
                scoped.push(c);
        }
        const found = await this.chooseFromSnapshot(
            snap,
            scoped,
            (step.kind === 'fill' ? '填写' : '点击') + '「' + target.name + '」',
        );
        if (target.scope === 'owned-row' && !rowMenu) {
            const stable = (await this.ownedActionRows(this.currentName)).getByRole(target.role, {
                name: target.name,
                exact: true,
            });
            if ((await stable.count()) === 1) found.locator = stable;
        }
        if (step.kind === 'fill') {
            const value = this.resolve(step.value);
            await found.locator.fill(value);
            if ((await found.locator.inputValue()) !== value) throw Error('回放输入值未生效');
        } else await this.dispatchClick(found.locator, step);
        this.record(step);
        await settle(this.page, 120);
    }
    async replay(file) {
        await this.assertModuleAccess();
        const results = this.results;
        let editFailed = false;
        for (const saved of file.cases) {
            this.checkInterrupted();
            const started = performance.now();
            const c = {
                id: saved.id,
                title: saved.title,
                operation: saved.operation,
                status: '执行中',
                reason: '',
                steps: [],
                evidence: '',
                failedStep: null,
                attempts: [],
            };
            this.case = c;
            this.diagnostics.begin(c.id);
            this.journal?.checkpoint({ activeCase: c, runtime: this.runtime() });
            if (
                ['search', 'view', 'edit', 'delete'].includes(saved.operation) &&
                (!this.created ||
                    (editFailed && JSON.stringify(saved.steps).includes('${updatedName}')))
            ) {
                c.status = '未执行（依赖阻断）';
                c.reason = '前置新增或修改未通过，本条所需的记录状态未确认';
            } else
                try {
                    for (const [index, step] of saved.steps.entries()) {
                        c.failedStep = {
                            number: index + 1,
                            action: step.kind,
                            target: step.target?.name || '',
                        };
                        this.diagnostics.setStep(c.failedStep);
                        await this.replayStep(step);
                        c.failedStep = null;
                        this.diagnostics.setStep(null);
                    }
                    c.status = '通过';
                    c.reason = '全部记录步骤和断言已重新执行';
                } catch (e) {
                    this.checkInterrupted();
                    c.status = '失败';
                    c.reason = message(e);
                }
            c.evidence = `evidence/${c.id}.png`;
            await this.page
                .screenshot({ path: path.join(this.config.out, c.evidence), timeout: 5000 })
                .catch(() => {
                    c.evidence = '';
                });
            await this.page.waitForTimeout(150).catch(() => {});
            c.browserEvents = await this.diagnostics.end();
            const severe = severeEvent(c.browserEvents);
            if (c.status === '通过' && severe) {
                c.status = '失败';
                c.reason = '页面断言通过，但本用例期间发现 ' + eventLabel(severe);
            }
            if (c.status === '失败' && !c.failedStep && severe?.step) c.failedStep = severe.step;
            c.diagnosis =
                c.status === '失败'
                    ? diagnoseFailure(c.reason, c.browserEvents)
                    : c.status === '未执行（依赖阻断）'
                      ? {
                            category: '依赖阻断',
                            assessment: '前置新增用例失败，本条没有执行浏览器步骤',
                            primary: null,
                            observed: [],
                        }
                      : null;
            if (c.status === '通过' && saved.operation === 'create') this.created = true;
            if (saved.operation === 'edit') editFailed = c.status !== '通过';
            if (c.status === '通过' && saved.operation === 'edit')
                this.currentName = this.variables.updatedName;
            if (await this.modalPresent().catch(() => false)) {
                try {
                    await this.pendingWrites.wait(this.config.pageTimeout || 8000);
                    await this.dismissModal();
                } catch {}
            }
            if (c.status === '通过') {
                if (this.pendingWrite?.caseId === c.id) this.pendingWrite = null;
                if (saved.operation === 'delete') this.created = false;
            }
            this.journal?.checkpoint({ pendingWrite: this.pendingWrite });
            c.durationMs = Math.round(performance.now() - started);
            this.case = null;
            this.completeCase(c);
            console.log(`${c.status} ${c.id}: ${c.reason}`);
        }
        return results;
    }
}

export async function runWorkflow(config, mode, readSecret, root) {
    if (!['generate', 'execute'].includes(mode)) throw Error('--mode 只支持 generate 或 execute');
    workflowPolicy(config);
    if (config.authState && !config.authCheck)
        throw Error('--auth-state 需要 --auth-check 指定登录成功后的唯一页面标记');
    if (config.manualLogin && config.headless) throw Error('手动登录需要可见浏览器');
    let input = null;
    if (mode === 'execute') {
        if (!config.caseFile) throw Error('执行模式请指定 --case-file 生成的 Excel 文件');
        input = validateWorkflow(
            await workbookCommand(config, 'read', { path: path.resolve(config.caseFile) }),
        );
        enforceReplayPolicy(input, config);
    }
    const requested = config.url || input?.moduleUrl || '';
    if (!requested) throw Error('请指定 --url 页面地址');
    const url = new URL(requested);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw Error('页面地址必须是不含账号密码的 HTTP(S) URL');
    if (input && new URL(input.moduleUrl).pathname !== url.pathname)
        throw Error('执行地址的路径与生成用例的模块不一致');
    const caseFile = path.resolve(
        config.caseFile ||
            path.join(root, 'generated-cases', safeKey(url.host + url.pathname) + '.xlsx'),
    );
    if (path.extname(caseFile).toLowerCase() !== '.xlsx')
        throw Error('--case-file 必须是 .xlsx 文件');
    const module = new URL(url);
    module.search = '';
    module.hash = '';
    const moduleUrl = module.href;
    const journal = new RunJournal(config.out, { mode, moduleUrl, provider: config.provider });
    try {
        let browser,
            context,
            page,
            diagnostics,
            workflow,
            laya,
            traceStarted = false,
            tracePromise;
        const stopTrace = () => {
            if (!traceStarted) return Promise.resolve();
            return (tracePromise ??= (async () => {
                let timer;
                try {
                    await Promise.race([
                        context.tracing.stop({ path: path.join(config.out, 'trace.zip') }),
                        new Promise((_, reject) => {
                            timer = setTimeout(() => reject(Error('保存 trace 超时')), 5000);
                        }),
                    ]);
                } catch (error) {
                    writePrivateJson(path.join(config.out, '轨迹保存失败.json'), {
                        message: message(error),
                    });
                } finally {
                    clearTimeout(timer);
                }
            })());
        };
        const interruption = watchInterruption(async () => {
            journal.checkpoint({ status: 'interrupted' });
            laya?.close();
            // Give tracing a bounded chance to flush before closing the browser to unblock actions.
            let timer;
            try {
                await Promise.race([
                    stopTrace(),
                    new Promise((resolve) => {
                        timer = setTimeout(resolve, 3000);
                    }),
                ]);
            } finally {
                clearTimeout(timer);
            }
            await browser?.close().catch(() => {});
        });
        config = { ...config, url: url.href, journal, signal: interruption.signal };
        let savedCaseFile = null,
            failure = null,
            status = 'completed',
            authStatus = 'not-required',
            runEvidence = '';
        try {
            await fs.mkdir(path.join(config.out, 'evidence'), { recursive: true });
            let apiKey =
                config.provider === 'api' ? await readSecret('API密钥', 'LAYA_API_KEY') : undefined;
            laya = new Laya(
                config.python,
                path.join(root, 'worker.py'),
                config.model,
                path.join(config.out, 'decisions.ndjson'),
                {
                    provider: config.provider,
                    base: config.apiBase,
                    model: config.apiModel,
                    key: apiKey,
                    timeout: config.apiTimeout,
                },
            );
            apiKey = null;
            console.log(
                `模式：${mode}；模型：${config.provider}；浏览器：${config.headless ? '无头' : '可见'}`,
            );
            const modelWarmup = beginModelWarmup(laya, config);
            config.signal.throwIfAborted();
            let authRestored;
            ({ browser, context, page, authRestored } = await openBrowser(config));
            config.signal.throwIfAborted();
            diagnostics = new BrowserDiagnostics(context);
            diagnostics.begin('startup');
            await page.goto(url.href, { waitUntil: 'domcontentloaded' });
            await waitForReady(page, { timeout: config.pageTimeout });
            const { target } = await import('./dom.mjs');
            authStatus = await ensureAuthentication(
                page,
                config,
                readSecret,
                (name, kind) =>
                    target(page, laya, name, {
                        kind,
                        minProbability: config.minProbability,
                        minMargin: config.minMargin,
                    }),
                authRestored,
            );
            await saveAuthState(context, page, config);
            await waitModelWarmup(modelWarmup);
            writePrivateJson(path.join(config.out, '启动浏览器事件.json'), await diagnostics.end());
            config.signal.throwIfAborted();
            workflow = new Workflow(page, laya, config, mode, diagnostics);
            journal.checkpoint({ runtime: workflow.runtime(), authStatus });
            // Authentication is complete before screenshots/traces/progress are recorded.
            await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
            traceStarted = true;
            const results =
                mode === 'generate' ? await workflow.generate() : await workflow.replay(input);
            config.signal.throwIfAborted();
            await stopTrace();
            if (mode === 'generate') {
                const file = {
                    schemaVersion: 1,
                    generatedAt: new Date().toISOString(),
                    moduleUrl,
                    cases: results
                        .filter((r) => r.status === '已验证')
                        .map(({ status, reason, evidence, attempts, ...c }) => c),
                    coverage: results.map(({ id, operation, status, reason }) => ({
                        id,
                        operation,
                        status,
                        reason,
                    })),
                };
                if (file.cases.length) {
                    validateWorkflow(file);
                    await fs.mkdir(path.dirname(caseFile), { recursive: true });
                    await workbookCommand(config, 'write', {
                        path: caseFile,
                        template: config.templateExcel,
                        file,
                    });
                    savedCaseFile = caseFile;
                }
            } else {
                await workbookCommand(config, 'results', {
                    path: path.resolve(config.caseFile),
                    output: path.join(config.out, '执行结果.xlsx'),
                    results,
                });
                savedCaseFile = caseFile;
            }
            config.signal.throwIfAborted();
        } catch (error) {
            failure = config.signal.aborted ? config.signal.reason : error;
            status = config.signal.aborted ? 'interrupted' : 'failed';
            if (traceStarted) {
                runEvidence = 'evidence/run-failure.png';
                await page
                    .screenshot({ path: path.join(config.out, runEvidence), timeout: 3000 })
                    .catch(() => {
                        runEvidence = '';
                    });
            }
            if (workflow?.case) {
                const c = workflow.case;
                c.status = status === 'interrupted' ? '中断' : '失败';
                c.reason = message(failure);
                if (diagnostics?.active) c.browserEvents = await diagnostics.end().catch(() => []);
                workflow.completeCase(c);
                workflow.case = null;
            } else if (diagnostics?.active) {
                writePrivateJson(
                    path.join(config.out, '启动浏览器事件.json'),
                    await diagnostics.end().catch(() => []),
                );
            }
            console.error('停止：' + message(failure));
        } finally {
            await stopTrace();
            await interruption.dispose();
            laya?.close();
            if (!(config.keepOpen && !config.headless && !failure))
                await browser?.close().catch(() => {});
        }
        {
            const results = workflow?.results || [];
            const resultFile = path.join(config.out, '执行结果.xlsx');
            let savedResultFile = mode === 'execute' && !failure ? resultFile : null;
            if (mode === 'generate' || failure) {
                try {
                    await workbookCommand({ ...config, signal: undefined }, 'report', {
                        output: resultFile,
                        mode,
                        moduleUrl,
                        results: results.length
                            ? results
                            : [
                                  {
                                      id: 'startup',
                                      title: '运行启动',
                                      status: '失败',
                                      reason: message(failure || '没有可执行用例'),
                                      steps: [],
                                  },
                              ],
                    });
                    savedResultFile = resultFile;
                } catch (exportError) {
                    console.error('结果表格导出失败：' + message(exportError));
                    failure ||= exportError;
                    status = 'failed';
                }
            }
            const actualCalls = (laya?.records || []).filter((r) => !r.cache_hit);
            const exitCode = failure?.exitCode || (failure ? 1 : resultExitCode(results));
            if (exitCode && status === 'completed') status = 'failed';
            const summary = journal.finish(
                {
                    mode,
                    provider: config.provider,
                    moduleUrl,
                    caseFile: savedCaseFile,
                    resultFile: savedResultFile,
                    authStatus,
                    runDataPrefix: workflow?.variables.recordName || null,
                    exitCode,
                    error: failure ? message(failure) : null,
                    runEvidence,
                    pendingWrite: workflow?.pendingWrite || null,
                    retainedRecord: workflow?.created ? workflow.currentName : null,
                    modelStartup: laya?.startup || null,
                    discovery: workflow?.discovery || null,
                    metrics: {
                        modelCalls: actualCalls.length + (laya?.errors?.length || 0),
                        modelErrors: laya?.errors?.length || 0,
                        cacheHits: (laya?.records.length || 0) - actualCalls.length,
                        inferenceMs: actualCalls.reduce((sum, r) => sum + (r.inference_ms || 0), 0),
                    },
                    results,
                    counts: Object.fromEntries(
                        [...new Set(results.map((r) => r.status))].map((s) => [
                            s,
                            results.filter((r) => r.status === s).length,
                        ]),
                    ),
                },
                status,
            );
            await writeWorkflowReport(config.out, summary);
            console.log(
                'RESULT ' +
                    JSON.stringify({
                        mode,
                        directory: config.out,
                        caseFile: savedCaseFile,
                        resultFile: savedResultFile,
                        counts: summary.counts,
                        exitCode,
                        runStatus: status,
                        durationMs: summary.durationMs,
                        metrics: summary.metrics,
                    }),
            );
            if (config.keepOpen && !config.headless && !failure) {
                console.log('浏览器保持打开；关闭窗口即可结束。');
                if (browser.isConnected())
                    await new Promise((resolve) => browser.on('disconnected', resolve));
            }
            return summary;
        }
    } finally {
        journal.close();
    }
}

async function writeWorkflowReport(out, summary) {
    const { results } = summary;
    await fs.writeFile(
        path.join(out, 'browser-events.ndjson'),
        results
            .flatMap((r) =>
                (r.browserEvents || []).map((e) => JSON.stringify({ caseId: r.id, ...e })),
            )
            .join('\n') + '\n',
    );
    const clean = (s) =>
        String(s ?? '')
            .replace(/[|\n\r]/g, ' ')
            .slice(0, 420);
    const md = [
        '# ' + (summary.mode === 'generate' ? '用例生成' : '用例执行') + '结果',
        '',
        `页面：${summary.moduleUrl}`,
        `运行状态：${summary.runStatus}；退出码：${summary.exitCode}`,
        `用例文件：${summary.caseFile || '未生成'}`,
        `结果表格：${summary.resultFile || '未生成'}`,
        `耗时：${summary.durationMs}ms；模型调用：${summary.metrics.modelCalls}`,
        `模型启动：${summary.modelStartup?.mode || '未知'} / ${summary.modelStartup?.status || '未知'}；预热：${summary.modelStartup?.elapsedMs ?? 0}ms`,
        `保留的测试记录：${summary.retainedRecord || '无已确认记录'}`,
        `未确认写操作：${summary.pendingWrite ? '有，请核对 checkpoint.json 后处理，禁止盲目重跑' : '无'}`,
        summary.error ? `运行错误：${clean(summary.error)}` : '',
        summary.runEvidence ? `运行截图：${summary.runEvidence}` : '',
        '',
        `补充测试发现：${summary.discovery?.status || '未启用'}；候选 ${summary.discovery?.candidates?.length || 0} 个`,
        ...(summary.discovery?.candidates || []).map(
            (c) =>
                `- ${clean(c.title)}：${c.selected ? c.status || '尚未完成' : '模型跳过'}；${clean(c.reason || c.evidence)}`,
        ),
        ...(summary.discovery?.unsupported?.length
            ? ['尚无执行能力的页面操作：' + summary.discovery.unsupported.map(clean).join('、')]
            : []),
        '',
        '|操作|结果|原因分类|失败步骤|执行错误|同期证据|',
        '|---|---|---|---|---|---|',
        ...results.map(
            (r) =>
                `|${clean(r.title)}|${r.status}|${clean(r.diagnosis?.category)}|${r.failedStep?.number || ''}|${clean(r.reason)}|${clean(r.diagnosis?.primary || r.browserEvents?.map(eventLabel).join('；'))}|`,
        ),
        '',
        '## 尝试记录',
        ...results.flatMap((r) =>
            (r.attempts || []).map(
                (a) =>
                    `- ${clean(r.id)} / ${clean(a.step)} 第${a.attempt}次：${a.status}${a.reason ? '；' + clean(a.reason) : ''}${a.evidence ? '；截图：' + a.evidence : ''}`,
            ),
        ),
    ];
    await fs.writeFile(path.join(out, '报告.md'), md.join('\n') + '\n');
}

function workbookCommand(config, command, payload) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            config.python,
            [fileURLToPath(new URL('./workflow_excel.py', import.meta.url)), command],
            { stdio: ['pipe', 'pipe', 'pipe'], signal: config.signal, timeout: 60000 },
        );
        let stdout = '',
            stderr = '';
        child.stdout.on('data', (b) => (stdout += b));
        child.stderr.on('data', (b) => (stderr += b));
        child.on('error', reject);
        child.stdin.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) {
                reject(Error('Excel ' + command + ' 失败：' + stderr.trim().slice(-1500)));
                return;
            }
            try {
                resolve(stdout.trim() ? JSON.parse(stdout) : null);
            } catch {
                reject(Error('Excel ' + command + ' 返回格式无效'));
            }
        });
        child.stdin.end(JSON.stringify(payload));
    });
}
