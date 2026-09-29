import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Workflow } from '../lib/workflow.mjs';

function setup() {
    const page = new EventEmitter();
    Object.assign(page, {
        url: () => 'https://app.test/records',
        waitForLoadState: async () => {},
        waitForTimeout: async () => {},
        screenshot: async () => {},
        locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
    });
    const diagnostics = { begin: () => {}, end: async () => [], setStep: () => {} };
    const workflow = new Workflow(
        page,
        {},
        { out: '/tmp', pageTimeout: 50 },
        'execute',
        diagnostics,
    );
    workflow.modalPresent = async () => false;
    workflow.assertModuleAccess = async () => {};
    workflow.case = { id: 'test', operation: 'create', steps: [], attempts: [] };
    return { page, workflow };
}

test('a transient observation recovers on the third attempt with full history', async () => {
    const { workflow } = setup();
    let calls = 0;
    workflow.snapshot = async () => ({
        controls: ++calls === 3 ? [{ name: '保存', role: 'button', disabled: true }] : [],
    });
    await workflow.replayStep({
        kind: 'assert-disabled',
        target: { name: '保存', role: 'button' },
    });
    assert.equal(calls, 3);
    assert.deepEqual(
        workflow.case.attempts.map((x) => x.status),
        ['失败', '失败', '通过'],
    );
    assert.equal(workflow.case.steps.length, 1);
});

test('nested helpers share three attempts rather than multiplying retry counts', async () => {
    const { workflow } = setup();
    let calls = 0;
    workflow.snapshot = async () => {
        calls++;
        throw Error('not ready');
    };
    await assert.rejects(
        workflow.replayStep({ kind: 'assert-control', target: { name: '搜索', role: 'button' } }),
        /尝试3次/,
    );
    assert.equal(calls, 3);
    assert.equal(workflow.case.attempts.length, 3);
    assert.ok(workflow.case.attempts.every((x) => x.evidence));
});

test('failed case does not stop later independent cases; dependent writes are skipped', async () => {
    const { workflow } = setup();
    let missing = 0;
    workflow.snapshot = async () => {
        missing++;
        return { controls: [] };
    };
    workflow.assertHeaders = async () => {};
    const results = await workflow.replay({
        cases: [
            {
                id: 'create',
                operation: 'create',
                steps: [{ kind: 'assert-control', target: { name: 'missing', role: 'button' } }],
            },
            {
                id: 'delete',
                operation: 'delete',
                steps: [
                    {
                        kind: 'click',
                        purpose: 'delete',
                        target: { name: '删除', role: 'button', scope: 'owned-row' },
                    },
                ],
            },
            {
                id: 'table',
                operation: 'table',
                steps: [{ kind: 'assert-headers', value: ['名称'] }],
            },
        ],
    });
    assert.deepEqual(
        results.map((x) => x.status),
        ['失败', '未执行（依赖阻断）', '通过'],
    );
    assert.equal(missing, 3);
    assert.equal(results[0].failedStep.number, 1);
});

test('write timeout triggers result verification without resending the click', async () => {
    const { workflow } = setup();
    let clicks = 0,
        checks = 0;
    const step = { kind: 'click', purpose: 'save', target: { name: '保存', role: 'button' } };
    workflow.verifyWrite = async () => ++checks === 2;
    await workflow.withAttempts('save', async () => {
        await workflow.dispatchClick(
            {
                click: async (options) => {
                    if (options.trial) return;
                    clicks++;
                    throw Error('response timeout');
                },
            },
            step,
        );
    });
    assert.equal(clicks, 1);
    assert.equal(checks, 2);
    assert.equal(workflow.case.attempts.length, 3);
    assert.deepEqual(workflow.case.steps, [step]);
});

test('unconfirmed writes stay failed after three attempts and never resend', async () => {
    const { workflow } = setup();
    let clicks = 0;
    workflow.verifyWrite = async () => false;
    await assert.rejects(
        workflow.withAttempts('save', async () =>
            workflow.dispatchClick(
                {
                    click: async (options) => {
                        if (options.trial) return;
                        clicks++;
                        throw Error('timeout');
                    },
                },
                { purpose: 'save', target: { name: '保存' } },
            ),
        ),
        /尝试3次/,
    );
    assert.equal(clicks, 1);
    assert.equal(workflow.case.attempts.length, 3);
});

test('write verification requires matching page, successful request and expected record', async () => {
    const { workflow, page } = setup();
    workflow.attemptState = { writeSequence: 0 };
    workflow.snapshot = async () => ({ controls: [{ name: '新增' }] });
    page.getByText = () => ({});
    page.locator = () => ({ filter: () => ({ count: async () => 1 }) });
    const step = { purpose: 'save' };
    assert.equal(await workflow.verifyWrite(step), false);
    workflow.pendingWrites.completed.push({ sequence: 1, status: 200, failed: false });
    assert.equal(await workflow.verifyWrite(step), true);
    page.url = () => 'https://app.test/login';
    assert.equal(await workflow.verifyWrite(step), false);
});

test('an unresolved write blocks later mutation without discarding its identity', async () => {
    const { workflow } = setup();
    const pending = { caseId: 'previous', operation: 'form-validation' };
    workflow.pendingWrite = pending;
    let clicks = 0;
    await assert.rejects(
        workflow.dispatchClick(
            { click: async () => clicks++ },
            { purpose: 'save', target: { name: '保存' } },
        ),
        /未确认写入/,
    );
    assert.equal(clicks, 0);
    assert.equal(workflow.pendingWrite, pending);
});

test('generation reports a failed case and still runs a subsequent case', async () => {
    const { workflow } = setup();
    let tries = 0;
    const first = await workflow.runCase('one', 'first', 'table', () =>
        workflow.withAttempts('observe', async () => {
            tries++;
            throw Error('missing table');
        }),
    );
    const second = await workflow.runCase('two', 'second', 'table', async () => {});
    assert.equal(tries, 3);
    assert.equal(first.status, '未生成');
    assert.equal(second.status, '已验证');
});

test('creation entry probing stops at three and observes fresh controls each time', async () => {
    const { workflow, page } = setup();
    let observed = 0;
    const clicked = [];
    workflow.snapshot = async () => {
        observed++;
        return {
            controls: ['新增甲', '新增乙', '新增丙', '新增丁'].map((name, i) => ({
                name,
                role: 'button',
                ref: observed + '-' + i,
                frame: 0,
            })),
            frames: [
                {
                    locator: (ref) => ({
                        count: async () => 1,
                        isVisible: async () => true,
                        click: async () => clicked.push(ref),
                    }),
                },
            ],
        };
    };
    workflow.waitForModal = async () => {};
    await assert.rejects(workflow.clickCreate(), /尝试3次/);
    assert.equal(observed, 3);
    assert.equal(clicked.length, 3);
    assert.ok(clicked[0].includes('1-0'));
    assert.ok(clicked[1].includes('2-1'));
    assert.ok(clicked[2].includes('3-2'));
});

test('failed edit blocks updated-name deletion but leaves independent assertions runnable', async () => {
    const { workflow } = setup();
    workflow.created = true;
    workflow.snapshot = async () => ({ controls: [] });
    workflow.assertHeaders = async () => {};
    const results = await workflow.replay({
        cases: [
            {
                id: 'edit',
                operation: 'edit',
                steps: [{ kind: 'assert-control', target: { name: 'missing', role: 'button' } }],
            },
            {
                id: 'delete',
                operation: 'delete',
                steps: [{ kind: 'assert-row', value: '${updatedName}' }],
            },
            {
                id: 'table',
                operation: 'table',
                steps: [{ kind: 'assert-headers', value: ['名称'] }],
            },
        ],
    });
    assert.deepEqual(
        results.map((x) => x.status),
        ['失败', '未执行（依赖阻断）', '通过'],
    );
});
