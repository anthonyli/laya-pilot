import test from 'node:test';
import assert from 'node:assert/strict';
import { discoveryCandidates, selectDiscovery, validateDiscovery } from '../lib/discovery.mjs';
import { validateWorkflow } from '../lib/workflow.mjs';
import { enforceReplayPolicy } from '../lib/workflow-policy.mjs';

const form = {
    create: { role: 'button', name: '新增' },
    cancel: { role: 'button', name: '取消' },
    fields: [
        { label: '邮箱', inputs: [{ type: 'email', readonly: false }] },
        { label: '数量', inputs: [{ type: 'number', min: '1', max: '20', readonly: false }] },
    ],
};
test('discovery is grounded in visible constraints and ambiguous filters are excluded', () => {
    const controls = [
        { role: 'textbox', name: '客户名称' },
        { role: 'button', name: '搜索' },
        { role: 'button', name: '重置' },
    ];
    const candidates = discoveryCandidates({ controls }, form);
    assert.deepEqual(
        candidates.map((c) => c.check),
        ['filter-empty', 'filter-reset', 'field-invalid', 'field-invalid', 'field-invalid'],
    );
    assert.deepEqual(
        candidates.filter((c) => c.bound).map((c) => c.bound),
        [1, 20],
    );
    assert.equal(discoveryCandidates({ controls: [...controls, controls[0]] }, null).length, 0);
    assert.equal(discoveryCandidates({ controls: [] }, null).length, 0);
});
test('model may reject a discovered case and an invalid recipe cannot become a write', async () => {
    const c = discoveryCandidates({ controls: [] }, form)[0];
    const decision = await selectDiscovery(
        {
            choose: async (_, criteria, meta) => {
                assert.ok(criteria.跳过);
                assert.equal(meta.phase, 'test-discovery');
                return { choice: '跳过', probabilities: { 跳过: 0.95 }, margin: 0.9 };
            },
        },
        c,
    );
    assert.equal(decision.selected, false);
    assert.throws(
        () =>
            validateDiscovery({
                kind: 'assert-discovery',
                spec: { ...c, cancel: { role: 'button', name: '保存' } },
            }),
        /明确控件/,
    );
    assert.throws(
        () => validateDiscovery({ kind: 'assert-discovery', spec: { ...c, check: 'delete' } }),
        /不支持/,
    );
});
test('discovery workbook steps obey operation scope and read-only boundaries', () => {
    const c = discoveryCandidates({ controls: [] }, form)[0];
    const file = {
        schemaVersion: 1,
        moduleUrl: 'http://example.test/users',
        cases: [
            { id: 'extra', operation: 'discover', steps: [{ kind: 'assert-discovery', spec: c }] },
        ],
    };
    assert.equal(validateWorkflow(file), file);
    assert.throws(() => enforceReplayPolicy(file, { readOnly: true }), /范围/);
    file.cases[0].steps.push({
        kind: 'click',
        purpose: 'save',
        target: { role: 'button', name: '保存', scope: 'form' },
    });
    assert.throws(() => validateWorkflow(file), /受限/);
});
