import { isAreaSwitch, lines, recordedReviewPrefix } from './language.mjs';
import { HEALTH_EXPECTATIONS } from './diagnostics.mjs';
import { createExpectation } from './recorded-create.mjs';

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
    option: '选项',
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
    if (action.kind === 'press') {
        if (!unattendedKeys.has(action.key)) return null;
        if (!action.target) return [`按下 ${action.key}`];
        if (
            !workbookText(name) ||
            action.target.rowAmbiguous ||
            action.target.row ||
            action.target.scope
        )
            return null;
        const label =
            { label: '标签', placeholder: '占位符', text: '文本' }[action.target.locator] ??
            `角色 ${role} 名称`;
        return [`按下 ${action.key}（${label}精确匹配「${name}」）`];
    }
    if (!workbookText(name) || action.target.rowAmbiguous) return null;
    if (action.kind === 'fill' && workbookText(action.value, true)) {
        const value = typeof values?.get(action) === 'string' ? values.get(action) : action.value;
        const scope = action.target.scope === '弹窗' ? '弹窗的' : '';
        if (action.target.locator === 'formNumber')
            return [`在${scope}「${name}」字段中输入数值「${value}」`];
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
    if (action.target.locator === 'cardTitle') return [`在弹窗中点击标题为「${name}」的卡片`];
    if (action.target.locator === 'namedNavIcon') return [`展开「${name}」导航菜单`];
    if (action.target.locator === 'navIcon')
        return workbookText(action.target.childLink)
            ? [`展开导航图标「${name}」以显示「${action.target.childLink}」链接`]
            : null;
    if (isAreaSwitch(action.target)) return [`切换到「${name}」区域`];
    const steps = [];
    if (action.target.row) {
        const header = action.target.rowHeader ?? list(action.before)?.header;
        if (!workbookText(header) || !workbookText(action.target.row)) return null;
        const matchesFixture = row?.header === header && row?.original === action.target.row;
        if (row && !matchesFixture && writeControl.test(name)) return null;
        const key = matchesFixture ? row.fixture : action.target.row;
        steps.push(`在「${header}」列中定位值为「${key}」的唯一记录`);
    }
    if (action.target.locator === 'fieldSelect') {
        const scope = action.target.scope === '弹窗' ? '在弹窗中' : '';
        return [...steps, `${scope}点击「${name}」字段的下拉框`];
    }
    if (
        action.target.locator === 'selectOption' &&
        workbookText(action.target.field?.name) &&
        !action.target.field.row
    ) {
        const scope = action.target.field.scope === '弹窗' ? '在弹窗的' : '在';
        return [...steps, `${scope}「${action.target.field.name}」字段下拉框中点击「${name}」选项`];
    }
    const scope = action.target.scope === '弹窗' && role === 'button' ? '在弹窗中' : '';
    if (action.target.locator === 'namedIcon') return [...steps, `${scope}点击操作图标「${name}」`];
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

function possibleWrite(action) {
    return (
        action.kind === 'click' &&
        !isAreaSwitch(action.target) &&
        writeControl.test(action.target?.name ?? '')
    );
}

function orderedSteps(actions) {
    return actions.flatMap((action) => {
        const steps = actionStep(action);
        if (steps) return steps;
        const target = workbookText(action.target?.name) ? `「${action.target.name}」` : '';
        return [recordedReviewPrefix + (action.reason || `${target}操作缺少可回放的目标或参数。`)];
    });
}

const sceneNames = {
    login: '登录',
    navigate: '区域切换',
    create: '新增配置',
    edit: '编辑记录',
    delete: '删除记录',
    search: '查询',
    custom: '录制流程',
};

function sceneTrigger(step) {
    if (step.startsWith('展开导航图标「') || /^展开「.+」导航菜单$/.test(step)) return 'navigate';
    if (/^切换到「.+」区域$|^点击「.+」(?:链接|标签页|菜单项)$/.test(step)) return 'navigate';
    const button =
        step.match(/^(?:在弹窗中)?点击「(.+)」按钮$/)?.[1] ||
        step.match(/^(?:在弹窗中)?点击操作图标「(.+)」$/)?.[1];
    if (!button) return null;
    if (/^(?:登\s*录|login|log in|sign in)$/i.test(button)) return 'login';
    if (searchControl.test(button)) return 'search';
    return writeKind(button);
}

function navigationSteps(steps) {
    const navigation = steps.filter((step) => !step.startsWith('检查步骤预期：'));
    if (
        !navigation.length ||
        navigation.some((step) => {
            if (step.startsWith('打开网址 ')) return false;
            if (sceneTrigger(step) !== 'navigate') return true;
            const control = step.match(/^点击「([^」]+)」(链接|菜单项)$/);
            return control && writeControl.test(control[1]);
        })
    )
        return null;
    return navigation;
}

function navigationDestination(steps, url, origin) {
    const navigation = navigationSteps(steps);
    if (!navigation) return null;
    const last = navigation.at(-1);
    if (!/^切换到「|^点击「.+」(?:标签页|菜单项|链接)$|^打开网址 /.test(last)) return null;
    const area = last.match(/^切换到「([^」]+)」区域$|^点击「([^」]+)」标签页$/);
    const target = workbookUrl(url || last.match(/^打开网址 (.+)$/)?.[1], origin);
    const destination = {};
    if (
        target &&
        ![...new URL(target).searchParams.keys()].some((key) =>
            /token|secret|password|auth|credential/i.test(key),
        )
    )
        destination.url = target;
    if (area) destination.area = area[1] || area[2];
    return destination.url || destination.area ? destination : null;
}

function destinationExpectations(destination) {
    return [
        destination?.url && `已到达录制页面「${destination.url}」`,
        destination?.area && `已选中录制区域「${destination.area}」`,
    ].filter(Boolean);
}

function sceneOf(c) {
    try {
        return JSON.parse(c.data || '{}').recordedScene;
    } catch {
        return null;
    }
}

// Original scenario workbooks only stored the entry URL of the following, dependent case.
// Resolve it before --cases selection so a navigation case has the same oracle on its own.
export function restoreNavigationDestinations(cases, url) {
    if (!url || !URL.canParse(url)) return cases;
    return cases.map((c, index) => {
        const scene = sceneOf(c);
        if (
            scene?.kind !== 'navigate' ||
            scene.destination ||
            !lines(c.expected).includes(pendingExpectation)
        )
            return c;
        const successor = cases[index + 1];
        const next = successor && sceneOf(successor);
        const steps = lines(c.steps);
        const entry =
            scene.url ||
            steps.find((step) => step.startsWith('打开网址 '))?.slice('打开网址 '.length);
        const linked =
            next?.previous === c.id &&
            next.account === scene.account &&
            !lines(successor.steps)[0]?.startsWith('打开网址 ');
        const observed =
            linked && ((entry && next.url !== entry) || /^切换到「|」标签页$/.test(steps.at(-1)))
                ? next.url
                : null;
        const destination = navigationDestination(steps, observed, new URL(url).origin);
        if (!destination) return c;
        const expected = lines(c.expected);
        const autoHealth =
            expected.includes(HEALTH_EXPECTATIONS.page) &&
            expected.includes(HEALTH_EXPECTATIONS.browser);
        const api =
            autoHealth &&
            expected.find(
                (text) => text === HEALTH_EXPECTATIONS.api || text === optionalApiExpectation,
            );
        return {
            ...c,
            data: JSON.stringify({
                ...JSON.parse(c.data),
                recordedScene: {
                    ...scene,
                    destination: { ...destination, ...(api && { automaticApi: api }) },
                },
            }),
            expected: [
                ...expected.filter((text) => text !== pendingExpectation),
                ...destinationExpectations(destination),
            ].join('\n'),
        };
    });
}

export function assessNavigationHealth(c, result) {
    const scene = sceneOf(c);
    const destination = scene?.destination;
    const api = destination?.automaticApi;
    if (
        scene?.kind !== 'navigate' ||
        !result.stepsCompleted ||
        !navigationSteps(lines(c.steps)) ||
        ![HEALTH_EXPECTATIONS.api, optionalApiExpectation].includes(api) ||
        lines(c.expected).filter((text) => text === api).length !== 1 ||
        result.network_errors?.some((event) => event.status >= 400)
    )
        return;
    const expected = destinationExpectations(destination);
    if (
        !expected.length ||
        !expected.every((text) =>
            result.assertions.some((a) => a.text === text && a.status === '通过'),
        )
    )
        return;
    const check = result.health_checks?.find((a) => a.kind === 'api' && a.text === api);
    if (!check || check.status === '通过') return;
    const events = (result.browser_events || []).filter((event) =>
        ['api-body', 'http', 'requestfailed'].includes(event.kind),
    );
    if (!events.length && !(check.status === '未验证' && check.reason === '本轮未观察到接口请求。'))
        return;
    if (
        !events.every(
            (event) =>
                event.kind === 'api-body' &&
                ['GET', 'HEAD'].includes(event.method) &&
                event.status >= 200 &&
                event.status < 300 &&
                !/^(?:401|403|5\d\d)(?:\d{3})?\b|登录|未授权|无权限|unauthori[sz]ed|unauthenticated|forbidden|denied|(?:token|session)\s+(?:has\s+)?expired/i.test(
                    event.detail || '',
                ),
        )
    )
        return;
    for (const event of events) event.severity = 'info';
    for (const item of new Set([
        check,
        ...result.assertions.filter((a) => a.kind === 'api' && a.text === api),
    ])) {
        item.observedStatus = item.status;
        item.status = '提示';
        item.severity = 'info';
    }
    const unresolved = result.assertions.filter(
        (a) => a.status !== '通过' && a.severity !== 'info',
    );
    result.status = unresolved.some((a) => a.status === '失败')
        ? '失败'
        : unresolved.length
          ? '部分验证'
          : '通过';
    result.category =
        result.status === '通过'
            ? '无'
            : result.status === '失败'
              ? '断言不符合预期，需复核'
              : '部分预期尚不能自动验证';
    result.reason =
        unresolved.map((a) => a.text + '：' + a.reason).join('；') ||
        '已验证导航目标，后台读取接口的诊断已保留。';
}

// Both freshly captured events and the previous ordered workbook use this step grammar.
// Each line belongs to exactly one scene, including unrecognized actions and checkpoints.
function groupRecordedSteps(entries) {
    const groups = [];
    let current;
    let closed = false;
    for (const [index, entry] of entries.entries()) {
        const trigger =
            sceneTrigger(entry.step) ||
            (entry.step.startsWith('在「') && entry.step.includes('列中定位值为')
                ? sceneTrigger(entries[index + 1]?.step || '')
                : null);
        if (
            !current ||
            (trigger &&
                ((current.kind &&
                    current.kind !== trigger &&
                    !(trigger === 'navigate' && mutationKinds.has(current.kind) && !closed)) ||
                    (closed && mutationKinds.has(trigger))))
        ) {
            current = { kind: trigger, entries: [] };
            groups.push(current);
            closed = false;
        }
        current.kind ||= trigger;
        current.entries.push(entry);
        const button = entry.step.match(/^(?:在弹窗中)?点击「(.+)」按钮$/)?.[1];
        if (button && (closeControl.test(button) || commitControl.test(button))) closed = true;
    }
    return groups;
}

function createSaveEntries(group) {
    const saves = new Set();
    if (group.kind !== 'create') return saves;
    let creating = !group.entries.some((entry) => sceneTrigger(entry.step) === 'create');
    for (const entry of group.entries) {
        const trigger = sceneTrigger(entry.step);
        if (trigger === 'create') creating = true;
        if (trigger === 'edit' || trigger === 'delete') creating = false;
        const name = entry.step.match(/^(?:在弹窗中)?点击「([^」]+)」按钮$/)?.[1];
        if (name && closeControl.test(name)) creating = false;
        if (creating && /^(?:save|submit|保存|提交|保存并关闭)$/i.test(name || ''))
            saves.add(entry);
    }
    return saves;
}

export function addCreateVerification(steps) {
    const entries = steps.map((step) => ({ step }));
    const saves = createSaveEntries({ kind: 'create', entries });
    return entries.map((entry) => entry.step + (saves.has(entry) ? '并验证新增记录' : ''));
}

export function recordedCreateActions(actions) {
    const entries = actions.flatMap((action) =>
        orderedSteps([action]).map((step) => ({ step, action })),
    );
    return new Set(
        groupRecordedSteps(entries).flatMap((group) =>
            [...createSaveEntries(group)].map((entry) => entry.action),
        ),
    );
}

export function recordedScenarios(url, entries, notices = [], authenticatedAccount) {
    const groups = groupRecordedSteps(entries);
    const login = groups.find((group) => group.kind === 'login');
    const account = login?.entries
        .map(({ step }) => step.match(/^在「([^」]+)」输入框中输入「([^」]+)」$/))
        .find((match) => match && /account|user|email|账号|账户|用户名|邮箱/i.test(match[1]))?.[2];
    const skipped = [...notices];
    const cases = groups.map(({ kind, entries }, i) => {
        const id = `REC-${String(i + 1).padStart(3, '0')}`;
        const actions = entries.map((e) => e.action).filter(Boolean);
        const saves = createSaveEntries({ kind, entries });
        const steps = entries.map((entry, j) => {
            const step = entry.step + (saves.has(entry) ? '并验证新增记录' : '');
            if (step.startsWith(recordedReviewPrefix)) skipped.push(`${id} 第 ${j + 1} 步 ${step}`);
            return `${j + 1}. ${step}`;
        });
        const write =
            actions.some(possibleWrite) ||
            entries.some(({ step }) => {
                const button = step.match(/^(?:在弹窗中)?点击「(.+)」按钮$/)?.[1];
                return button && writeControl.test(button);
            });
        const scene = {
            kind: kind || 'custom',
            previous: i ? `REC-${String(i).padStart(3, '0')}` : '',
        };
        if (authenticatedAccount || account) scene.account = authenticatedAccount || account;
        const entryUrl = workbookUrl(actions[0]?.before?.url, new URL(url).origin);
        if (entryUrl) scene.url = entryUrl;
        const health = caseHealth(actions);
        const hasCheckpoint = entries.some(({ step }) => step.startsWith('检查步骤预期：'));
        let destination;
        if (kind === 'navigate' && !hasCheckpoint) {
            const last = actions.filter((action) => action.kind !== 'assert').at(-1);
            const after = last?.after?.url;
            const following = groups[i + 1]?.entries[0]?.action;
            const next = following?.kind !== 'goto' ? following?.before?.url : null;
            const steps = entries.map((entry) => entry.step);
            const switched = /^切换到「|」标签页$/.test(
                steps.filter((step) => !step.startsWith('检查步骤预期：')).at(-1) || '',
            );
            const observed =
                after && (switched || (last.before?.url && after !== last.before.url))
                    ? after
                    : next && (switched || (last?.before?.url && next !== last.before.url))
                      ? next
                      : null;
            destination = navigationDestination(steps, observed, new URL(url).origin);
            if (destination) scene.destination = { ...destination, automaticApi: health.at(-1) };
        }
        return {
            id,
            title: sceneNames[scene.kind],
            preconditions: write ? writePrecondition : '',
            data: JSON.stringify({ recordedScene: scene }),
            steps: steps.join('\n'),
            expected: [
                ...health,
                ...destinationExpectations(destination),
                ...(saves.size ? [createExpectation] : []),
                ...(hasCheckpoint
                    ? ['录制设置的步骤预期全部满足']
                    : saves.size || destination
                      ? []
                      : [pendingExpectation]),
            ].join('\n'),
        };
    });
    return {
        url,
        cases,
        skipped,
        requiresWrite: cases.some((c) => c.preconditions === writePrecondition),
    };
}

/** Record the actual sequence unless independent regression cases were requested. */
export function generateRecordedCases(recording, { splitCases = false } = {}) {
    const initial = workbookUrl(
        recording.url ?? recording.actions.find((a) => a.kind === 'goto')?.url,
    );
    if (!initial) throw Error('录制缺少可回放的页面入口。');
    if (!splitCases) {
        const actions = recording.actions;
        if (!actions.some((action) => action.kind !== 'goto'))
            throw Error('录制中没有可转换的用户操作。');
        const entries = actions.flatMap((action) =>
            orderedSteps([action]).map((step) => ({ action, step })),
        );
        if (actions[0]?.kind !== 'goto') entries.unshift({ step: `打开网址 ${initial}` });
        return recordedScenarios(initial, entries, recording.skipped, recording.account);
    }
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

        const warnings =
            issue ||
            (!steps ? '部分录制动作缺少可回放的控件定位。' : '') ||
            (!mutationKinds.has(kind) && actions.some(possibleWrite)
                ? '操作可能改变数据，尚缺少对应的业务结果证据。'
                : '');
        const health = caseHealth(steps && !warnings ? actions : []);
        const data = warnings
            ? {
                  录制诊断: warnings,
                  录制动作总数: actions.length,
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
            steps: [
                ...entry,
                ...(warnings ? [recordedReviewPrefix + warnings, ...orderedSteps(actions)] : steps),
            ]
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
        const kind = action.kind === 'click' && !isAreaSwitch(action.target) && writeKind(name);
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
        const mayWrite = intent || segment.some(possibleWrite);
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
