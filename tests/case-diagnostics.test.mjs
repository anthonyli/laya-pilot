import test from 'node:test';
import assert from 'node:assert/strict';
import {
    inspectCase,
    compileExpectation,
    stepDiagnostic,
} from '../scripts/lib/case-diagnostics.mjs';

test('inspection distinguishes values, variables, business oracles and live planning', () => {
    const c = {
        id: '001',
        key: '业务:2',
        sheet: '业务',
        row: 2,
        data: '{"customer":"甲"}',
        steps: '查询条件输入合法数据\n在“客户编号”输入“${customer}”\n将“名称”改成“乙”\n打开网址',
        expected:
            '列表按查询条件刷新，返回数据与条件一致，无报错\n页面显示“${missing}”\n页面显示“${runId}”',
    };
    const before = JSON.stringify(c);
    const result = inspectCase(c);
    assert.equal(JSON.stringify(c), before);
    const codes = result.diagnostics.map((d) => d.code);
    for (const code of [
        'missing-test-value',
        'needs-live-target',
        'needs-action-planning',
        'missing-navigation-url',
        'missing-business-oracle',
        'missing-variable',
        'runtime-variable',
    ])
        assert.ok(codes.includes(code), code);
    assert.ok(result.diagnostics.every((d) => d.sheet === '业务' && d.row === 2 && d.id === '001'));
    assert.equal(result.compilation[0].text, c.expected.split('\n')[0]);
    assert.equal(result.compilation[0].assertions[0].kind, 'unsupported');
    assert.equal(inspectCase({ ...c, data: '任意数据' }).diagnostics[0].code, 'invalid-test-data');
    assert.equal(stepDiagnostic('在名称输入“”').code, 'needs-live-target');
});

test('conjunction compiler preserves quoted content and refuses to invent scope or business rules', () => {
    assert.equal(compileExpectation('页面显示“甲且乙 and 丙”').length, 1);
    const original = '弹窗显示“保存”按钮且页面显示“搜索”按钮';
    const parts = compileExpectation(original);
    assert.equal(parts.length, 2);
    assert.ok(parts.every((p) => p.source === original));
    assert.equal(parts[0].scope, '弹窗');
    assert.equal(parts[1].target, '搜索');
    const mixed = compileExpectation('页面显示“搜索”按钮且数据正确');
    assert.equal(mixed[0].kind, 'controlVisible');
    assert.equal(mixed[1].diagnostic.code, 'missing-business-oracle');
    assert.equal(
        compileExpectation('弹窗显示“保存”按钮且显示“删除”按钮')[1].diagnostic.code,
        'missing-assertion-scope',
    );
    assert.equal(compileExpectation('表格表头包含：名称、状态').length, 1);
    assert.equal(
        compileExpectation('page shows "Search" and contains "Delete"')[1].diagnostic.code,
        'missing-assertion-scope',
    );
});
