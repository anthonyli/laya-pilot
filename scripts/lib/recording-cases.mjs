import { HEALTH_EXPECTATIONS } from './diagnostics.mjs';

const pendingExpectation = '业务结果待补充（录制时未设置预期）';
const optionalApiExpectation = '未观察到接口请求失败';
const writePrecondition = '本用例需要写入授权';
const actionRoles = {
    button: '按钮',
    textbox: '输入框',
    link: '链接',
    tab: '标签页',
    checkbox: '复选框',
    combobox: '下拉框',
    menuitem: '菜单项',
};
const unattendedKeys = new Set(['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp']);
const writeControl =
    /保存|提交|确定|确认|应用|删除|移除|新增|添加|创建|编辑|修改|发布|启用|停用|审批|save|submit|confirm|apply|delete|remove|add|create|edit|update|publish|approve/i;
const commitControl =
    /^(?:保存|提交|确定|确认|完成|继续|删除|移除|save|submit|confirm|done|continue|delete|remove)(?:并关闭|删除|移除|编辑|修改)?$/i;
const searchControl = /^(?:查询|搜索|查找|筛选|检索|search|filter|find)$/i;
const resetControl = /^(?:重置|清除筛选|清空筛选|reset|clear filters)$/i;
const detailControl = /^(?:查看|详情|查看详情|预览|view|details|preview)$/i;
const closeControl = /^(?:关闭|取消|close|cancel)$/i;

function workbookText(value, allowEmpty = false) {
    return (
        typeof value === 'string' &&
        (allowEmpty || !!value.trim()) &&
        value.length <= 500 &&
        !/[\r\n「」“”『』"]/.test(value) &&
        !value.includes('${')
    );
}

function workbookUrl(value, origin) {
    try {
        const url = new URL(value);
        if (
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            (origin && url.origin !== origin) ||
            !workbookText(url.href) ||
            /[;；]/.test(url.href)
        )
            return null;
        return url.href;
    } catch {
        return null;
    }
}

function list(snapshot) {
    const header = snapshot?.headers?.[0];
    if (
        snapshot?.tableCount !== 1 ||
        !snapshot.rowsComplete ||
        !workbookText(header) ||
        snapshot.headers.filter((name) => name === header).length !== 1
    )
        return null;
    const values = snapshot.rows.map((row) => row.cells?.[0]);
    if (!values.every((value) => workbookText(value))) return null;
    return { header, values, headers: snapshot.headers, rows: snapshot.rows };
}

function listChange(action) {
    const before = list(action.before);
    const after = list(action.after);
    if (!before || !after || before.header !== after.header) return null;
    return {
        before,
        after,
        added: after.values.filter((value) => !before.values.includes(value)),
        removed: before.values.filter((value) => !after.values.includes(value)),
    };
}

function recordExpectation(header, value, mode = 'present') {
    const verb = mode === 'absent' ? '不存在值为' : '存在值为';
    return `列表中「${header}」列${verb}「${value}」的${mode === 'unique' ? '唯一' : ''}记录`;
}

function fieldExpectation(header, key, field, value) {
    return `列表中「${header}」列值为「${key}」的唯一记录中「${field}」列值为「${value}」`;
}

function manualExpectation(action, replacements) {
    const { name, role } = action.target ?? {};
    if (!workbookText(name)) return null;
    if (action.assertion === 'visible')
        return `页面显示「${replacements?.get(name) ?? name}」${role === 'button' ? '按钮' : ''}`;
    if (action.assertion === 'value' && role === 'textbox' && workbookText(action.value, true)) {
        const value = replacements?.get(action.value) ?? action.value;
        return value ? `「${name}」输入框的值为「${value}」` : `「${name}」输入框为空`;
    }
    return null;
}

function actionStep(action, row, values, replacements) {
    const { name, role } = action.target ?? {};
    if (action.kind === 'goto') return workbookUrl(action.url) ? [`打开网址 ${action.url}`] : null;
    if (action.kind === 'assert') {
        const expected = manualExpectation(action, replacements);
        return expected ? [`检查步骤预期：${expected}`] : null;
    }
    if (action.kind === 'press')
        return unattendedKeys.has(action.key) ? [`按下 ${action.key}`] : null;
    if (!workbookText(name) || action.target.rowAmbiguous) return null;
    if (action.kind === 'fill' && workbookText(action.value, true)) {
        const value = typeof values?.get(action) === 'string' ? values.get(action) : action.value;
        const scope = action.target.scope === '弹窗' ? '弹窗的' : '';
        return [
            value
                ? `在${scope}「${name}」输入框中输入「${value}」`
                : `清空${scope}「${name}」输入框`,
        ];
    }
    if (action.kind === 'select' && workbookText(action.value))
        return [`在「${name}」下拉框中选择「${action.value}」`];
    if (action.kind === 'check' || action.kind === 'uncheck')
        return [`${action.kind === 'check' ? '勾选' : '取消勾选'}「${name}」复选框`];
    if (action.kind !== 'click') return null;
    const steps = [];
    if (action.target.row) {
        const header = action.target.rowHeader ?? list(action.before)?.header;
        if (!workbookText(header) || !workbookText(action.target.row)) return null;
        const matchesFixture = row?.header === header && row?.original === action.target.row;
        if (row && !matchesFixture && writeControl.test(name)) return null;
        const key = matchesFixture ? row.fixture : action.target.row;
        steps.push(`在「${header}」列中定位值为「${key}」的唯一记录`);
    }
    const scope = action.target.scope === '弹窗' && role === 'button' ? '在弹窗中' : '';
    return [...steps, `${scope}点击「${name}」${actionRoles[role] ?? ''}`];
}

function actionSteps(actions, row, values, replacements) {
    const result = [];
    for (const action of actions) {
        const steps = actionStep(action, row, values, replacements);
        if (!steps) return null;
        result.push(...steps);
    }
    return result;
}

function writeKind(name) {
    if (/^(?:新增|添加|创建|新建|add\b|create\b|new\b)/i.test(name)) return 'create';
    if (/^(?:编辑|修改|改名|edit\b|rename\b|update\b)/i.test(name)) return 'edit';
    if (/^(?:删除|移除|delete\b|remove\b)/i.test(name)) return 'delete';
    return null;
}

function identityFills(actions, name) {
    const last = actions.findLast((action) => action.kind === 'fill' && action.value === name);
    if (!last || (last.target.inputType && last.target.inputType !== 'text') || last.target.pattern)
        return null;
    const fills = actions.filter(
        (action) =>
            action.kind === 'fill' &&
            action.target.name === last.target.name &&
            action.value === name,
    );
    const fixtureLength = name.length + '-rec-999-fixture-2000-01-01T00-00-00-000Z'.length;
    if (fills.some(({ target }) => target.maxLength > 0 && target.maxLength < fixtureLength))
        return null;
    return fills;
}

function fixtureName(name, id, variant = '') {
    return `${name}-${id.toLowerCase()}${variant}-\${runId}`;
}

function fixtureValues(fills, value) {
    return new Map(fills.map((action) => [action, value]));
}

function renderCreate(recorded, value) {
    const replacements = new Map([[recorded.newValue, value]]);
    const steps = actionSteps(
        recorded.flow,
        null,
        fixtureValues(recorded.fills, value),
        replacements,
    );
    return { steps, replacements };
}

function renderChange(recorded, before, after) {
    const { kind, header, flow, oldValue, newValue, fills, fields } = recorded;
    const replacements = new Map([[oldValue, before]]);
    if (newValue) replacements.set(newValue, after);
    const body = actionSteps(
        flow,
        { header, original: oldValue, fixture: before },
        fixtureValues(fills, after),
        replacements,
    );
    if (!body) return null;
    const previous = fields.map((field) =>
        fieldExpectation(header, before, field.header, field.previous),
    );
    const checks = fields.map((field) =>
        fieldExpectation(header, before, field.header, field.value),
    );
    if (kind === 'delete' || newValue) checks.push(recordExpectation(header, before, 'absent'));
    if (newValue) checks.push(recordExpectation(header, after, 'unique'));
    return {
        steps: body,
        previous,
        checks,
        replacements,
    };
}

function inlineExpectation(check) {
    return `检查步骤预期：${check}`;
}

function prepareFixture(recipe, id) {
    const { create, edits } = recipe;
    let value = fixtureName(create.newValue, id, '-fixture');
    const initial = renderCreate(create, value);
    if (!initial.steps) return null;
    const steps = [
        ...initial.steps,
        inlineExpectation(recordExpectation(create.header, value, 'unique')),
    ];
    const actions = [...create.flow];
    // Each observed edit belongs to the same recorded row. Replay it only on
    // this case's new row and follow its new key after a rename.
    for (const [index, edit] of edits.entries()) {
        const after = edit.newValue ? fixtureName(edit.newValue, id, `-prep${index + 1}`) : value;
        const change = renderChange(edit, value, after);
        if (!change) return null;
        steps.push(...change.steps, ...change.checks.map(inlineExpectation));
        actions.push(...edit.flow);
        value = after;
    }
    return { steps, actions, value };
}

function updatedFields(before, after, row, actions) {
    const beforeCells = before.rows.find(({ cells }) => cells[0] === row)?.cells;
    const afterCells = after.rows.find(({ cells }) => cells[0] === row)?.cells;
    if (
        !beforeCells ||
        !afterCells ||
        after.values.filter((value) => value === row).length !== 1 ||
        before.headers.length !== after.headers.length ||
        !before.headers.every((header, index) => header === after.headers[index])
    )
        return [];
    return after.headers.flatMap((header, index) => {
        const value = afterCells[index];
        const previous = beforeCells[index];
        if (
            index === 0 ||
            !workbookText(header) ||
            !workbookText(value, true) ||
            !workbookText(previous, true) ||
            previous === value ||
            after.headers.filter((item) => item === header).length !== 1 ||
            !actions.some(
                (action) => ['fill', 'select'].includes(action.kind) && action.value === value,
            )
        )
            return [];
        return [{ header, previous, value }];
    });
}

function mutationEvidence(intent, actions, action) {
    const { kind, opener } = intent;
    const change = listChange(action);
    if (!change || action.before.url !== action.after.url) return null;
    const { before, after, added, removed } = change;
    if (opener.target.rowAmbiguous) return null;
    const row = opener.target.row;
    if (kind !== 'create' && (!row || before.values.filter((value) => value === row).length !== 1))
        return null;
    if (kind === 'edit' && !added.length && !removed.length) {
        const fields = updatedFields(before, after, row, actions);
        return fields.length ? { header: after.header, oldValue: row, fills: [], fields } : null;
    }
    if (kind !== 'create' && row !== removed[0]) return null;
    if (kind === 'create' && (added.length !== 1 || removed.length)) return null;
    if (kind === 'edit' && (added.length !== 1 || removed.length !== 1)) return null;
    if (kind === 'delete' && (removed.length !== 1 || added.length)) return null;
    const oldValue = removed[0];
    const newValue = added[0];
    if (newValue && after.values.filter((value) => value === newValue).length !== 1) return null;
    const fills = newValue ? identityFills(actions, newValue) : [];
    if (newValue && !fills) return null;
    return { header: after.header, oldValue, newValue, fills, fields: [] };
}

function queryExpectations(actions, action) {
    const change = listChange(action);
    if (!change) return [];
    const { before, after, removed } = change;
    if (before.values.length && !after.values.length) return ['列表记录数为0'];
    const filter = actions.findLast(
        (entry) => ['fill', 'select'].includes(entry.kind) && workbookText(entry.value),
    );
    const columns = after.headers.flatMap((header, index) =>
        workbookText(header) &&
        filter?.target.name.endsWith(header) &&
        after.headers.filter((item) => item === header).length === 1
            ? [{ header, index }]
            : [],
    );
    if (
        columns.length === 1 &&
        after.rows.length &&
        before.rows.some(({ cells }) => cells[columns[0].index] !== filter.value) &&
        after.rows.every(({ cells }) => cells[columns[0].index] === filter.value)
    )
        return [`列表中「${columns[0].header}」列的全部记录值为「${filter.value}」`];
    // A surviving row alone does not show a filter ran. Use both sides of a
    // captured result only when a narrowed list visibly removed other records.
    if (after.values.length === 1 && removed.length && before.values.includes(after.values[0]))
        return [
            recordExpectation(after.header, after.values[0]),
            recordExpectation(after.header, removed[0], 'absent'),
        ];
    return [];
}

function caseHealth(actions) {
    const observedApi = actions.some((action) =>
        action.requests?.some((request) => ['fetch', 'xhr'].includes(request.kind)),
    );
    return [
        HEALTH_EXPECTATIONS.page,
        HEALTH_EXPECTATIONS.browser,
        observedApi ? HEALTH_EXPECTATIONS.api : optionalApiExpectation,
    ];
}

function retainedActions(actions) {
    return actions.slice(0, 24).map(({ kind, target, url, value, key, reason }) => ({
        kind,
        ...(target && { target: target.name, ...(target.row && { row: target.row }) }),
        ...(kind === 'goto' && workbookUrl(url) && { url }),
        ...(workbookText(value, true) && { value }),
        ...(key && { key }),
        ...(reason && { reason }),
    }));
}

function searchTrigger(action) {
    return (
        (action?.kind === 'click' && searchControl.test(action.target?.name ?? '')) ||
        (action?.kind === 'press' && action.key === 'Enter')
    );
}

const titles = {
    search: '查询',
    reset: '重置查询条件',
    create: '新增',
    edit: '编辑',
    delete: '删除',
    detail: '查看详情',
    navigate: '打开模块',
    custom: '录制流程',
};
const mutationKinds = new Set(['create', 'edit', 'delete']);

/** Convert bounded, observed workflow outcomes into independently replayable Excel cases. */
export function generateRecordedCases(recording) {
    const initial = workbookUrl(
        recording.url ?? recording.actions.find((a) => a.kind === 'goto')?.url,
    );
    if (!initial) throw Error('录制缺少可回放的页面入口。');
    const origin = new URL(initial).origin;
    const cases = [];
    const skipped = [...(recording.skipped ?? [])];
    const lineage = new Map();
    let entry = [`打开网址 ${initial}`];
    let entryUrl = initial;
    let segment = [];
    let intent;
    let lastQuery;
    let lastCase;
    const nextId = () => `REC-${String(cases.length + 1).padStart(3, '0')}`;
    function add(kind, actions, steps, checks, issue, replacements) {
        const id = nextId();
        // Do not replay unverified writes, including ordinal-only row actions.
        // Retain what the user recorded in a visible cell for review.
        const possibleWrite = actions.some(
            (action) => action.kind === 'click' && writeControl.test(action.target?.name ?? ''),
        );
        const warnings =
            issue ||
            (!steps ? '部分录制动作缺少可回放的控件定位。' : '') ||
            (!mutationKinds.has(kind) && possibleWrite
                ? '操作可能改变数据，尚缺少对应的业务结果证据。'
                : '');
        const health = caseHealth(steps && !warnings ? actions : []);
        const data = warnings
            ? {
                  录制诊断: warnings,
                  录制动作总数: actions.length,
                  录制动作: retainedActions(actions),
              }
            : {};
        const named = [...actions].reverse().find((action) => action.after?.headings?.length)?.after
            .headings[0];
        const title = workbookText(named) ? `${named} · ${titles[kind]}` : titles[kind];
        const expected = [
            ...health,
            ...(warnings || !checks.length ? [pendingExpectation] : checks),
        ];
        if (!warnings && actions.some((action) => action.kind === 'assert'))
            expected.push('录制设置的步骤预期全部满足');
        const result = {
            id,
            title,
            preconditions: !warnings && mutationKinds.has(kind) ? writePrecondition : '',
            data: Object.keys(data).length ? JSON.stringify(data, null, 2) : '',
            steps: [...entry, ...(warnings ? [] : steps)]
                .map((step, index) => `${index + 1}. ${step}`)
                .join('\n'),
            expected: [...new Set(expected)].join('\n'),
        };
        cases.push(result);
        lastCase = warnings
            ? null
            : { kind, result, count: entry.length + steps.length, replacements };
        segment = [];
        intent = undefined;
        if (warnings) skipped.push(`${id} ${title}：${warnings}`);
        return !warnings;
    }

    function addMutation(kind, evidence) {
        const flow = segment.slice(intent.at);
        const id = nextId();
        const { header, oldValue, newValue } = evidence;
        const recorded = { kind, flow, ...evidence };
        const key = (value) => JSON.stringify([entry, header, value]);
        const resultValue = newValue
            ? fixtureName(newValue, id, kind === 'edit' ? '-edited' : '')
            : '';
        if (kind === 'create') {
            const { steps, replacements } = renderCreate(recorded, resultValue);
            const replayable = add(
                kind,
                flow,
                steps,
                [recordExpectation(header, resultValue, 'unique')],
                '',
                replacements,
            );
            if (replayable) lineage.set(key(newValue), { create: recorded, edits: [] });
            return;
        }
        const recipe = lineage.get(key(oldValue));
        if (!recipe) {
            add(kind, flow, null, [], '缺少本次录制中可独立准备的目标记录，请补充测试数据。');
            return;
        }
        const setup = prepareFixture(recipe, id);
        const change = setup && renderChange(recorded, setup.value, resultValue);
        if (!change) {
            add(kind, flow, null, [], '无法复现目标记录的已录制前置操作。');
            return;
        }
        const replayable = add(
            kind,
            [...setup.actions, ...flow],
            [...setup.steps, ...change.previous.map(inlineExpectation), ...change.steps],
            change.checks,
            '',
            change.replacements,
        );
        if (!replayable) return;
        if (kind === 'delete' || newValue) lineage.delete(key(oldValue));
        if (kind === 'edit')
            lineage.set(key(newValue ?? oldValue), {
                create: recipe.create,
                edits: [...recipe.edits, recorded],
            });
    }

    for (const [index, action] of recording.actions.entries()) {
        const url = action.kind === 'goto' ? workbookUrl(action.url, origin) : null;
        if (action.kind === 'goto' && url) {
            if (url === entryUrl && !segment.length) continue;
            if (segment.length) add(intent?.kind ?? 'custom', segment, null, []);
            entry = [`打开网址 ${url}`];
            entryUrl = url;
            lastQuery = undefined;
            lastCase = undefined;
            continue;
        }
        // An explicit toolbar checkpoint immediately after a recognized case
        // is part of the same flow, at the observed position.
        if (action.kind === 'assert' && !segment.length && lastCase && manualExpectation(action)) {
            const result = lastCase.result;
            const recordedAssertion = `检查步骤预期：${manualExpectation(action, lastCase.replacements)}`;
            result.steps += `\n${++lastCase.count}. ${recordedAssertion}`;
            if (!result.expected.includes('录制设置的步骤预期全部满足'))
                result.expected += '\n录制设置的步骤预期全部满足';
            continue;
        }
        const name = action.target?.name ?? '';
        if (
            !segment.length &&
            lastCase?.kind === 'detail' &&
            action.kind === 'click' &&
            action.target.scope === '弹窗' &&
            closeControl.test(name) &&
            action.before?.url === action.after?.url &&
            action.after?.dialogs?.length < action.before?.dialogs?.length
        ) {
            lastCase = undefined;
            continue;
        }
        segment.push(action);
        const kind = action.kind === 'click' && writeKind(name);
        if (kind && !intent) intent = { kind, opener: action, at: segment.length - 1 };
        if (intent) {
            const terminal =
                (action.kind === 'click' &&
                    (commitControl.test(name) || action === intent.opener)) ||
                (action.kind === 'press' &&
                    action.key === 'Enter' &&
                    action.target?.role === 'textbox');
            if (!terminal) continue;
            const evidence = mutationEvidence(intent, segment.slice(intent.at), action);
            if (evidence) addMutation(intent.kind, evidence);
            else if (commitControl.test(name) && action !== intent.opener) {
                if ((action.after?.dialogs?.length ?? 0) < (action.before?.dialogs?.length ?? 0))
                    add(intent.kind, segment, null, [], '未观察到唯一可验证的记录变化。');
            }
            continue;
        }
        const query =
            searchTrigger(action) &&
            (action.kind !== 'press' || segment.some((a) => a.kind === 'fill'));
        const observedFilter =
            ['fill', 'select'].includes(action.kind) &&
            !searchTrigger(recording.actions[index + 1]);
        const checks = query || observedFilter ? queryExpectations(segment, action) : [];
        if (query || checks.length) {
            const steps = actionSteps(segment);
            const flow = segment;
            const replayable = add(
                'search',
                flow,
                steps,
                checks,
                checks.length ? '' : '无法确认本次查询的结果变化。',
            );
            lastQuery = replayable ? { actions: flow, steps } : undefined;
        } else if (action.kind === 'click' && resetControl.test(name) && lastQuery) {
            const fields = (action.before?.fields ?? []).filter(
                (field) =>
                    field.value &&
                    workbookText(field.name) &&
                    action.after?.fields?.some(
                        (after) => after.name === field.name && after.value === '',
                    ),
            );
            const reset = actionSteps(segment);
            const checks = fields.map((field) => `「${field.name}」输入框为空`);
            add(
                'reset',
                [...lastQuery.actions, ...segment],
                reset && [...lastQuery.steps, ...reset],
                checks,
            );
            lastQuery = undefined;
        } else if (action.kind === 'click' && ['link', 'tab'].includes(action.target?.role)) {
            const destination = workbookUrl(action.after?.url, origin);
            if (!destination) continue;
            const changed = destination !== entryUrl;
            const heading = action.after?.headings?.find(
                (value) => workbookText(value) && !action.before?.headings?.includes(value),
            );
            const tab =
                action.target.role === 'tab' &&
                workbookText(name) &&
                action.after?.selectedTabs?.includes(name) &&
                !action.before?.selectedTabs?.includes(name);
            const steps = actionSteps(segment);
            const checks = heading ? [`页面显示「${heading}」`] : [];
            if (tab) checks.push(`「${name}」标签页已选中`);
            if (changed && !checks.length && new URL(destination).pathname !== '/')
                checks.push(`网址包含「${new URL(destination).pathname}」`);
            if (!changed && !tab && !checks.length) continue;
            const replayable = add('navigate', segment, steps, checks);
            entry = changed
                ? [`打开网址 ${destination}`]
                : replayable
                  ? [...entry, ...steps]
                  : entry;
            entryUrl = destination;
            lastQuery = undefined;
        } else if (action.kind === 'click' && detailControl.test(name)) {
            const dialog = action.after?.dialogs?.find(
                (value) => workbookText(value) && !action.before?.dialogs?.includes(value),
            );
            if (dialog) add('detail', segment, actionSteps(segment), [`弹窗显示「${dialog}」`]);
        }
    }
    if (segment.length) {
        const checked = segment.some(
            (action) => action.kind === 'assert' && manualExpectation(action),
        );
        const mayWrite =
            intent ||
            segment.some(
                (action) => action.kind === 'click' && writeControl.test(action.target?.name ?? ''),
            );
        const issue = mayWrite
            ? '未能验证写操作的结果或目标记录，请补充独立测试数据和业务预期。'
            : !checked
              ? '未观察到能自动生成业务预期的结果。'
              : '';
        add(
            intent?.kind ?? 'custom',
            segment,
            actionSteps(segment),
            checked ? ['录制设置的步骤预期全部满足'] : [],
            issue,
        );
    }
    if (!cases.length) throw Error('录制中没有可转换的用户操作。');
    const requiresWrite = cases.some((item) => item.preconditions === writePrecondition);
    return { url: initial, cases, skipped, requiresWrite };
}
