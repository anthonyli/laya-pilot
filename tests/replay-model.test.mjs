import test from 'node:test';
import assert from 'node:assert/strict';
import { matchReplayTarget } from '../lib/replay-model.mjs';
import { Workflow } from '../lib/workflow.mjs';

test('replay grounds the recorded option among live alternatives with at most eight criteria', async () => {
    const candidates = Array.from({ length: 12 }, (_, i) => ({ name: `选项${i}` }));
    let calls = 0;
    const model = {
        choose: async (state, criteria, meta) => {
            calls++;
            assert.equal(state, '我要选择选项「选项11」。');
            assert.equal(Object.keys(criteria).length, 8);
            assert.equal(meta.phase, 'replay-target');
            assert.equal(meta.field, '渠道');
            assert.ok(meta.candidates.some((c) => c.name === '选项11'));
            return { choice: '目标1', probabilities: { 目标1: 0.98 }, margin: 0.96 };
        },
    };
    assert.equal(
        await matchReplayTarget(model, '选择选项', '选项11', candidates, {}, { field: '渠道' }),
        candidates[11],
    );
    assert.equal(calls, 1);
});

test('missing or duplicate recorded options cannot be replaced by the model', async () => {
    const model = { choose: () => assert.fail('invalid page must stop before inference') };
    for (const candidates of [[], [{ name: '其他' }], [{ name: '指定值' }, { name: '指定值' }]])
        await assert.rejects(
            matchReplayTarget(model, '选择选项', '指定值', candidates),
            /不唯一或已不存在/,
        );
});

test('replay rejects alternative values, stop decisions and unconfident or malformed scores', async () => {
    for (const result of [
        { choice: '目标2', probabilities: { 目标2: 0.99 }, margin: 0.98 },
        { choice: '停止', probabilities: { 停止: 0.99 }, margin: 0.98 },
        { choice: '目标1', probabilities: { 目标1: 0.6 }, margin: 0.2 },
        { choice: '目标1', probabilities: { 目标1: 0.8 }, margin: 0.1 },
        { choice: '目标1', probabilities: { 目标1: 0.99 } },
    ])
        await assert.rejects(
            matchReplayTarget({ choose: async () => result }, '选择选项', '指定值', [
                { name: '指定值' },
                { name: '其他值' },
            ]),
            /未改选其他值/,
        );
});

test('a unique replay control still calls Laya and a refusal prevents target dispatch', async () => {
    const locator = { count: async () => 1, isVisible: async () => true };
    const control = { name: '保存', role: 'button', context: '', frame: 0, ref: 'live' };
    const snapshot = { url: 'https://test.local', frames: [{ locator: () => locator }] };
    let calls = 0;
    const workflow = {
        mode: 'execute',
        config: {},
        laya: {
            choose: async (state, criteria, meta) => {
                calls++;
                assert.equal(state, '我要点击保存。');
                assert.equal(criteria['保存'], '点击「保存」控件');
                assert.equal(meta.phase, 'replay-target');
                assert.equal(Object.keys(criteria).length, 2);
                return { choice: '停止', probabilities: { 停止: 0.99 }, margin: 0.98 };
            },
        },
    };
    await assert.rejects(
        Workflow.prototype.chooseFromSnapshot.call(workflow, snapshot, [control], '点击保存'),
        /未能确定/,
    );
    assert.equal(calls, 1);
    workflow.mode = 'generate';
    assert.equal(
        (
            await Workflow.prototype.chooseFromSnapshot.call(
                workflow,
                snapshot,
                [control],
                '点击保存',
            )
        ).locator,
        locator,
    );
    assert.equal(calls, 1);
});
