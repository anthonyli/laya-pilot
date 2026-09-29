import { inspectForm, findFormItem } from './form.mjs';
import { waitForReady } from './readiness.mjs';

const SEARCH = /搜索|查询|search|query/i;
const RESET = /^(重置|清空|reset|clear)$/i;
const CREATE = /新增|新建|创建|添加|\badd\b|\bnew\b|\bcreate\b/i;
const CANCEL = /^(取消|关闭|cancel|close)$/i;
const searchField = /名称|姓名|用户名|账号|账户|name|account|搜索|查询|search/i;
const target = ({ name, role }) => ({ name, role });
const keyOf = (c) => `${c.role}:${c.name}`;

export function discoveryCandidates(snapshot, form) {
    const controls = snapshot.controls.filter((c) => !c.disabled);
    const unique = (items) =>
        items.filter((c) => items.filter((x) => keyOf(x) === keyOf(c)).length === 1);
    const fields = unique(
        controls.filter((c) => c.role === 'textbox' && !c.readonly && searchField.test(c.name)),
    );
    let searches = unique(controls.filter((c) => c.role === 'button' && SEARCH.test(c.name)));
    const explicitSearch = searches.filter((c) => /^(搜索|查询|search|query)$/i.test(c.name));
    if (explicitSearch.length === 1) searches = explicitSearch;
    const resets = unique(controls.filter((c) => c.role === 'button' && RESET.test(c.name)));
    const candidates = [];
    const query =
        fields.length === 1 && searches.length <= 1
            ? { field: target(fields[0]), ...(searches[0] ? { search: target(searches[0]) } : {}) }
            : null;
    if (query) {
        const base = query;
        candidates.push({
            check: 'filter-empty',
            ...base,
            title: '不存在的关键词查询显示空结果',
            evidence: `${fields[0].name}；${searches[0]?.name || '输入后筛选'}`,
        });
        if (resets.length === 1)
            candidates.push({
                check: 'filter-reset',
                ...base,
                reset: target(resets[0]),
                title: '筛选重置清空条件并恢复列表',
                evidence: `${fields[0].name}；${resets[0].name}`,
            });
    }
    if (form?.create && form.cancel && form.fields.length) {
        const base = { create: form.create, cancel: form.cancel };
        const field = form.fields.find(
            (f) =>
                !f.combo && f.inputs.some((i) => !i.readonly && ['text', 'input'].includes(i.type)),
        );
        if (field && query)
            candidates.push({
                check: 'cancel-create',
                ...base,
                ...query,
                label: field.label,
                title: '填写新增表单后取消，不产生新记录',
                evidence: `${form.create.name}；${field.label}；${form.cancel.name}`,
            });
        for (const f of form.fields.filter((f) => !f.combo)) {
            const input = f.inputs[0];
            if (f.inputs.length !== 1 || !input || input.readonly) continue;
            if (input.type === 'email')
                candidates.push({
                    check: 'field-invalid',
                    ...base,
                    label: f.label,
                    constraint: 'email',
                    title: `${f.label}拒绝非法邮箱格式`,
                    evidence: `${f.label}：type=email`,
                });
            if (input.type === 'number') {
                for (const constraint of ['min', 'max']) {
                    const bound = input[constraint];
                    if (bound !== '' && bound != null && Number.isFinite(Number(bound)))
                        candidates.push({
                            check: 'field-invalid',
                            ...base,
                            label: f.label,
                            constraint,
                            bound: Number(bound),
                            title: `${f.label}校验${constraint === 'min' ? '下' : '上'}界`,
                            evidence: `${f.label}：${constraint}=${bound}`,
                        });
                }
            }
        }
    }
    return candidates;
}

export function validateDiscovery(step) {
    const c = step.spec;
    if (
        step.kind !== 'assert-discovery' ||
        !c ||
        !['filter-empty', 'filter-reset', 'cancel-create', 'field-invalid'].includes(c.check)
    )
        throw Error('不支持的补充测试步骤');
    const named = (t, role, pattern) =>
        t?.role === role &&
        typeof t.name === 'string' &&
        t.name.length <= 150 &&
        pattern.test(t.name);
    if (c.check.startsWith('filter-')) {
        if (
            !named(c.field, 'textbox', searchField) ||
            (c.search && !named(c.search, 'button', SEARCH)) ||
            (c.check === 'filter-reset' && !named(c.reset, 'button', RESET))
        )
            throw Error('补充筛选测试缺少明确控件');
    } else if (
        !named(c.create, 'button', CREATE) ||
        !named(c.cancel, 'button', CANCEL) ||
        typeof c.label !== 'string' ||
        !c.label
    )
        throw Error('补充表单测试缺少明确控件');
    if (
        c.check === 'cancel-create' &&
        (!named(c.field, 'textbox', searchField) ||
            (c.search && !named(c.search, 'button', SEARCH)))
    )
        throw Error('取消新增测试缺少查询验证控件');
    if (
        c.check === 'field-invalid' &&
        (!['email', 'min', 'max'].includes(c.constraint) ||
            (c.constraint !== 'email' && !Number.isFinite(c.bound)))
    )
        throw Error('补充字段测试缺少页面约束');
    return c;
}

export async function selectDiscovery(laya, candidate) {
    const decision = await laya.choose(
        `测试「${candidate.title}」，页面已观察到：${candidate.evidence}`,
        {
            执行: `验证${candidate.title}；使用页面现有控件，能够断言结果`,
            跳过: '当前页面证据不足，无法执行或无法断言该测试',
        },
        { phase: 'test-discovery', candidate },
    );
    return {
        selected:
            decision.choice === '执行' &&
            (decision.probabilities?.执行 || 0) >= 0.5 &&
            decision.margin >= 0.1,
        choice: decision.choice,
        confidence: decision.probabilities?.[decision.choice] || 0,
    };
}

async function control(w, t) {
    const snap = await w.snapshot();
    return (
        await w.chooseFromSnapshot(
            snap,
            snap.controls.filter((c) => c.name === t.name && c.role === t.role && !c.disabled),
            `${['textbox', 'spinbutton'].includes(t.role) ? '填写' : '点击'}「${t.name}」`,
        )
    ).locator;
}
async function reload(w) {
    await w.page.reload({ waitUntil: 'domcontentloaded' });
    await waitForReady(w.page, { timeout: w.config.pageTimeout });
}
async function tableState(w) {
    const table = w.page.locator('table:visible,[role="grid"]:visible');
    // Fixed-column copies are not independent tables. Require a single main table.
    const main = table
        .filter({ hasNot: w.page.locator('table') })
        .locator(
            'xpath=self::*[not(ancestor::*[contains(@class,"ant-table-fixed-left") or contains(@class,"ant-table-fixed-right")])]',
        );
    if ((await main.count()) !== 1) throw Error('补充测试无法确定唯一主表格');
    return main
        .locator('tbody tr,[role="rowgroup"] [role="row"]')
        .filter({ visible: true })
        .evaluateAll((rows) =>
            rows
                .filter(
                    (r) =>
                        !r.matches('.ant-table-placeholder') &&
                        !r.querySelector('.ant-empty,.el-table__empty-block') &&
                        r.querySelectorAll('td,[role="cell"]').length > 1,
                )
                .map((r) => r.innerText),
        );
}
async function waitTable(w, check) {
    const deadline = Date.now() + (w.config.assertTimeout || 4000);
    do {
        await w.pendingWrites.wait(w.config.pageTimeout || 8000);
        const rows = await tableState(w);
        if (check(rows)) return rows;
        await w.page.waitForTimeout(100);
    } while (Date.now() < deadline);
    throw Error('补充测试的列表断言未通过');
}

// This bounded grammar never submits a form. Replay uses the recorded recipe;
// the model cannot introduce selectors, scripts, URLs or write operations.
export async function executeDiscovery(w, step) {
    const c = validateDiscovery(step);
    await reload(w);
    try {
        if (c.check.startsWith('filter-')) {
            const baseline = await tableState(w);
            if (!baseline.length) throw Error('列表原本为空，无法验证筛选及恢复');
            await (await control(w, c.field)).fill(`no_match_${w.variables.recordAccount}`);
            if (c.search) await (await control(w, c.search)).click();
            await waitTable(w, (rows) => rows.length === 0);
            if (c.check === 'filter-reset') {
                await (await control(w, c.reset)).click();
                if ((await (await control(w, c.field)).inputValue()) !== '')
                    throw Error('重置后筛选值未清空');
                await waitTable(
                    w,
                    (rows) => rows.length > 0 && rows.some((r) => baseline.includes(r)),
                );
            }
        } else {
            await (await control(w, c.create)).click();
            await w.waitForModal();
            if (w.mode === 'execute') await w.matchFormTarget(c.label);
            const { info, item } = await findFormItem(w.page, c.label);
            const input = item.locator('input:visible,textarea:visible');
            if ((await input.count()) !== 1 || !(await input.isEditable()))
                throw Error('补充测试字段已变化');
            if (c.check === 'cancel-create') {
                await input.fill(w.variables.recordAccount);
                await (await control(w, c.cancel)).click();
                await w.waitModalClosed();
                await reload(w);
                await (await control(w, c.field)).fill(w.variables.recordAccount);
                if (c.search) await (await control(w, c.search)).click();
                await waitTable(w, (rows) => rows.length === 0);
            } else {
                const observed = info.inputs[0];
                if (
                    (c.constraint === 'email' && observed.type !== 'email') ||
                    (c.constraint !== 'email' &&
                        (observed.type !== 'number' ||
                            observed[c.constraint] === '' ||
                            Number(observed[c.constraint]) !== c.bound))
                )
                    throw Error('原先记录的字段约束已变化');
                const value =
                    c.constraint === 'email'
                        ? 'not-an-email'
                        : String(c.bound + (c.constraint === 'min' ? -1 : 1));
                await input.fill(value);
                await input.press('Tab');
                const invalid = await input.evaluate(
                    (e, constraint) =>
                        constraint === 'email'
                            ? e.validity.typeMismatch
                            : constraint === 'min'
                              ? e.validity.rangeUnderflow
                              : e.validity.rangeOverflow,
                    c.constraint,
                );
                if (!invalid) throw Error('字段未按声明的约束拒绝非法值');
                await (await control(w, c.cancel)).click();
                await w.waitModalClosed();
            }
        }
    } finally {
        await reload(w);
    }
    w.record(step);
}

export async function discoverTests(w) {
    if (w.pendingWrite || w.created) {
        w.discovery = {
            status: 'blocked',
            reason: '仍有未确认写入或未清理测试记录',
            candidates: [],
        };
        return;
    }
    await reload(w);
    const snapshot = await w.snapshot();
    const candidates = discoveryCandidates(snapshot, w.formEvidence);
    w.discovery = {
        status: 'completed',
        candidates: [],
        unsupported: snapshot.controls
            .filter((c) => /导入|导出|上传|审批|审核|重置密码|启用|停用|批量/.test(c.name))
            .map((c) => c.name)
            .slice(0, 20),
    };
    for (const [i, c] of candidates.slice(0, 12).entries()) {
        w.checkInterrupted();
        const decision = await selectDiscovery(w.laya, c);
        const entry = { ...c, ...decision };
        w.discovery.candidates.push(entry);
        if (!decision.selected) continue;
        const result = await w.runCase(`discover-${i + 1}`, c.title, 'discover', async () => {
            await executeDiscovery(w, { kind: 'assert-discovery', spec: c });
        });
        entry.status = result.status;
        entry.reason = result.reason;
        w.completeCase(result);
        console.log(`${result.status} ${result.id}: ${result.reason}`);
    }
    w.discovery.truncated = Math.max(0, candidates.length - 12);
}

export async function observeFormEvidence(w, create) {
    const snap = await w.snapshot();
    const closes = snap.controls.filter(
        (c) => c.role === 'button' && CANCEL.test(c.name) && !c.disabled,
    );
    const explicitCancel = closes.filter((c) => /^(取消|cancel)$/i.test(c.name));
    const cancel = explicitCancel.length === 1 ? explicitCancel : closes;
    w.formEvidence = {
        create: target(create),
        cancel: cancel.length === 1 ? target(cancel[0]) : null,
        fields: await inspectForm(w.page),
    };
}
