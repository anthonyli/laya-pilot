import assert from 'node:assert/strict';
import test from 'node:test';
import { describe, lines } from '../scripts/lib/language.mjs';
import { stepDiagnostic } from '../scripts/lib/case-diagnostics.mjs';
import { Engine } from '../scripts/lib/engine.mjs';
import { generateRecordedCases } from '../scripts/lib/recording-cases.mjs';

const splitCases = (recording) => generateRecordedCases(recording, { splitCases: true });

const url = 'http://127.0.0.1:8765/orders';
const headers = ['订单名', '状态'];
const state = (cells, dialogs = []) => ({
    url,
    headings: ['订单管理'],
    dialogs,
    tableCount: 1,
    headers,
    rowsComplete: true,
    rows: cells.map((row) => ({ cells: row })),
});
const event = (kind, name, before, after, options = {}) => ({
    kind,
    before,
    after,
    target: {
        role: 'button',
        name,
        ...(options.row && { row: options.row, rowHeader: headers[0] }),
        ...(options.scope && { scope: options.scope }),
        ...(options.role && { role: options.role }),
    },
    ...(options.value !== undefined && { value: options.value }),
    ...(options.requests && { requests: options.requests }),
});
const click = (...args) => event('click', ...args);

test('preserves the option role when a portaled dropdown choice becomes an Excel step', () => {
    const name = '[Field] Login Account';
    const snapshot = state([]);
    const result = generateRecordedCases({
        url,
        actions: [click(name, snapshot, snapshot, { role: 'option' })],
    });
    const step = lines(result.cases[0].steps).at(-1);
    assert.deepEqual(describe(step), { verb: 'click', target: name, recordedRole: 'option' });
});

test('an independently generated edit verifies the changed field of the same exact record', () => {
    const initial = state([['示例订单', '处理中']]);
    const add = state([['示例订单', '处理中']], ['新增订单']);
    const beforeEdit = state([
        ['示例订单', '处理中'],
        ['新订单', '待支付'],
    ]);
    const edit = state(
        [
            ['示例订单', '处理中'],
            ['新订单', '待支付'],
        ],
        ['编辑订单'],
    );
    const updated = state([
        ['示例订单', '处理中'],
        ['新订单', '已发货'],
    ]);
    const result = splitCases({
        url,
        actions: [
            click('新增订单', initial, add),
            event('fill', '订单名', add, add, { role: 'textbox', scope: '弹窗', value: '新订单' }),
            click('保存', add, beforeEdit, { scope: '弹窗' }),
            click('编辑', beforeEdit, edit, { row: '新订单' }),
            event('select', '状态', edit, edit, { role: 'combobox', value: '已发货' }),
            click('保存', edit, updated, { scope: '弹窗' }),
        ],
    });
    assert.equal(result.requiresWrite, true);
    assert.deepEqual(result.skipped, []);
    assert.equal(result.cases.length, 2);
    const [createCase, editCase] = result.cases;
    assert.match(createCase.title, /新增$/);
    assert.match(editCase.title, /编辑$/);
    assert.match(editCase.preconditions, /需要写入授权/);
    assert.match(
        editCase.steps,
        /在弹窗的「订单名」输入框中输入「新订单-rec-002-fixture-\$\{runId\}」/,
    );
    assert.match(
        editCase.steps,
        /在「订单名」列中定位值为「新订单-rec-002-fixture-\$\{runId\}」的唯一记录/,
    );
    assert.match(editCase.steps, /在弹窗中点击「保存」按钮/);
    assert.match(editCase.steps, /检查步骤预期：.*唯一记录中「状态」列值为「待支付」/);
    assert.match(editCase.expected, /唯一记录中「状态」列值为「已发货」/);
    assert.doesNotMatch(editCase.expected, /不存在值/);
});

test('later edits and deletion recreate the same recorded changes on their own fixture', () => {
    const table = (name, status, dialogs) => state(name ? [[name, status]] : [], dialogs);
    const editing = (name, status) => table(name, status, ['编辑订单']);
    const addForm = state([], ['新增订单']);
    const deleteForm = table('已改名', '已签收', ['删除订单']);
    const clickSave = (before, after) => click('保存', before, after, { scope: '弹窗' });
    const setStatus = (snapshot, value) =>
        event('select', '状态', snapshot, snapshot, { role: 'combobox', value });
    const setName = (snapshot, value) =>
        event('fill', '订单名', snapshot, snapshot, { role: 'textbox', scope: '弹窗', value });
    const edit = (name, status) =>
        click('编辑', table(name, status), editing(name, status), { row: name });
    const result = splitCases({
        url,
        actions: [
            click('新增订单', state([]), addForm),
            setName(addForm, '录制订单'),
            clickSave(addForm, table('录制订单', '待支付')),
            edit('录制订单', '待支付'),
            setStatus(editing('录制订单', '待支付'), '已发货'),
            clickSave(editing('录制订单', '待支付'), table('录制订单', '已发货')),
            edit('录制订单', '已发货'),
            setName(editing('录制订单', '已发货'), '已改名'),
            clickSave(editing('录制订单', '已发货'), table('已改名', '已发货')),
            edit('已改名', '已发货'),
            setStatus(editing('已改名', '已发货'), '已签收'),
            clickSave(editing('已改名', '已发货'), table('已改名', '已签收')),
            click('删除', table('已改名', '已签收'), deleteForm, { row: '已改名' }),
            click('确定', deleteForm, state([]), { scope: '弹窗' }),
        ],
    });
    assert.deepEqual(result.skipped, []);
    assert.equal(result.cases.length, 5);
    const [, , , secondEdit, deletion] = result.cases;
    assert.match(
        secondEdit.steps,
        /选择「已发货」[\s\S]*输入「已改名-rec-004-prep2-\$\{runId\}」[\s\S]*「状态」列值为「已发货」[\s\S]*选择「已签收」/,
    );
    assert.match(secondEdit.expected, /已改名-rec-004-prep2-\$\{runId\}.*「状态」列值为「已签收」/);
    assert.match(
        deletion.steps,
        /选择「已签收」[\s\S]*「状态」列值为「已签收」[\s\S]*定位值为「已改名-rec-005-prep2-\$\{runId\}」的唯一记录/,
    );
    assert.match(deletion.expected, /不存在值为「已改名-rec-005-prep2-\$\{runId\}」/);
    assert.doesNotMatch(deletion.steps, /rec-00[1-4]/);
});

test('a deletion without recorded preparation is reviewable without replaying the original row', () => {
    const initial = state([['真实订单', '处理中']]);
    const confirm = state([['真实订单', '处理中']], ['删除订单']);
    const removed = state([]);
    const result = splitCases({
        url,
        actions: [
            click('删除', initial, confirm, { row: '真实订单' }),
            click('确定', confirm, removed, { scope: '弹窗' }),
        ],
    });
    const [disabled] = result.cases;
    assert.equal(result.requiresWrite, false);
    assert.match(disabled.title, /删除$/);
    assert.match(disabled.steps, /待补录：.*\n.*真实订单[\s\S]*点击「删除」/);
    assert.match(disabled.expected, /业务结果待补充/);

    assert.match(result.skipped[0], /补充测试数据/);
});

test('a search against a non-key column uses captured results and correlated request evidence', () => {
    const initial = state([
        ['订单 A', '待处理'],
        ['订单 B', '已关闭'],
    ]);
    const filtered = state([['订单 A', '待处理']]);
    const actions = [
        event('select', '订单状态', initial, initial, { role: 'combobox', value: '待处理' }),
        click('查询', initial, filtered, { requests: [{ kind: 'xhr', ok: true }] }),
    ];
    const [found] = splitCases({ url, actions }).cases;
    assert.match(found.expected, /列表中「状态」列的全部记录值为「待处理」/);
    assert.match(found.expected, /接口请求成功/);

    const ambiguous = { ...filtered, tableCount: 2 };
    const [review] = splitCases({
        url,
        actions: [actions[0], click('查询', initial, ambiguous)],
    }).cases;
    assert.match(review.expected, /业务结果待补充/);
    assert.match(review.data, /无法确认本次查询/);
});

test('a long sequence keeps every repeated switch and the actions after a review marker', async () => {
    const snapshot = state([]);
    const actions = Array.from({ length: 98 }, (_, i) =>
        click(i % 2 ? 'Run Area' : 'Edit Area', snapshot, snapshot),
    );
    actions.splice(30, 0, { kind: 'unsupported', reason: '缺少定位' });
    const result = generateRecordedCases({ url, actions });
    assert.equal(result.requiresWrite, false);
    const steps = lines(result.cases[0].steps);
    assert.deepEqual(steps, [
        `打开网址 ${url}`,
        ...actions.map((action) =>
            action.target ? `切换到「${action.target.name}」区域` : '待补录：缺少定位',
        ),
    ]);
    assert.equal(stepDiagnostic(steps[31]).code, 'unresolved-recorded-action');
    const engine = new Engine({ on() {} }, null, { allowWrite: false });
    await assert.rejects(engine.step(steps[31]), /缺少定位/);
    engine.guard(actions[0].target, steps[1]);
    assert.throws(
        () => engine.guard({ ...actions[0].target, rowKey: 'existing' }, steps[1]),
        /只读/,
    );
    assert.equal(
        generateRecordedCases({
            url,
            actions: [click('Edit Area', snapshot, snapshot, { row: 'existing' })],
        }).requiresWrite,
        true,
    );
});

test('replay parameters share one short value across fills, checkpoints and the saved row', async () => {
    const { parameterizeRecordedFields } = await import('../scripts/lib/recording-cases.mjs');
    const { replayData, variables } = await import('../scripts/lib/language.mjs');
    const { renderRecordingSpec } = await import('../scripts/lib/recording-spec.mjs');
    const s = state([]),
        name = 'demo';
    const fill = event('fill', 'Function Name', s, s, { role: 'textbox', value: name });
    const check = { ...fill, kind: 'assert', assertion: 'value' };
    const edit = click('Edit', s, s, { row: name });
    edit.target.rowHeader = 'Function Name';
    const recording = {
        url,
        actions: [click('Add', s, s), fill, check, click('Save', s, s), edit],
    };
    const bound = parameterizeRecordedFields(recording);
    const generated = generateRecordedCases(bound);
    const data = replayData(bound.parameters, {}, '2026-11-25T12-11-22-123Z');
    const again = replayData(bound.parameters, {}, '2026-11-25T12-11-22-124Z');
    assert.match(data.recordName1, /^demo[a-z0-9]+$/);
    assert.notEqual(again.recordName1, data.recordName1);
    const steps = variables(generated.cases.map((c) => c.steps).join('\n'), data);
    assert.equal(steps.split(data.recordName1).length - 1, 3);
    assert.equal(
        replayData(bound.parameters, { recordName1: 'specific' }, 'run-2').recordName1,
        'specific',
    );
    assert.equal((renderRecordingSpec(bound).match(/data\["recordName1"\]/g) ?? []).length, 3);
    assert.equal(fill.parameter, undefined);
    const description = event('fill', 'Description', s, s, { role: 'textbox', value: 'desc' });
    const withDescription = parameterizeRecordedFields({
        ...recording,
        actions: [recording.actions[0], fill, description, ...recording.actions.slice(2)],
    });
    assert.deepEqual(withDescription.parameters, {
        recordName1: 'demo${runKey}',
        recordDescription1: 'desc${runKey}',
    });
    assert.deepEqual(
        parameterizeRecordedFields({
            ...recording,
            actions: [...recording.actions, click(name, s, s, { role: 'option' })],
        }).parameters,
        {},
    );
    assert.deepEqual(
        parameterizeRecordedFields({
            ...recording,
            actions: [
                recording.actions[0],
                { ...fill, target: { ...fill.target, maxLength: 6 } },
                recording.actions[3],
            ],
        }).parameters,
        {},
    );
});

test('unfinished create recordings get fresh names and dropdowns while asserted selections stay fixed', async () => {
    const { parameterizeRecordedFields } = await import('../scripts/lib/recording-cases.mjs');
    const s = state([]);
    const fill = event('fill', 'Function Name', s, s, { role: 'textbox', value: 'test' });
    const select = event('select', 'Organization', s, s, { role: 'combobox', value: 'Original' });
    const raw = { url, actions: [click('Add', s, s), select, fill] };
    const recorded = parameterizeRecordedFields(raw);
    assert.equal(recorded.parameters.recordName1, 'test${runKey}');
    assert.match(
        generateRecordedCases(recorded).cases.at(-1).steps,
        /随机选择，无法随机时使用录制值「Original」/,
    );
    const asserted = parameterizeRecordedFields({
        ...raw,
        actions: [...raw.actions, { ...select, kind: 'assert', assertion: 'value' }],
    });
    assert.equal(asserted.actions[1].randomOption, undefined);
});

test('editor steps preserve literal syntax, line breaks and semicolons in formulas', async () => {
    const { editorStep } = await import('../scripts/lib/recorded-editor.mjs');
    const { variables } = await import('../scripts/lib/language.mjs');
    const op = { type: 'text', value: '"a";\n${literal};' };
    const step = editorStep(op);
    const steps = lines(variables('1. ' + step + '\n2. 点击「Test」按钮', {}));
    assert.equal(steps.length, 2);
    assert.deepEqual(describe(steps[0]).operation, op);
    assert.equal(stepDiagnostic('编辑器操作 {oops}').status, 'needs-review');
});
