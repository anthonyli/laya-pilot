import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunJournal, resultExitCode, writePrivateJson } from '../lib/run-state.mjs';
import { loadAuthState } from '../lib/auth-state.mjs';
import { workflowPolicy, enforceReplayPolicy } from '../lib/workflow-policy.mjs';
import { Laya, beginModelWarmup, waitModelWarmup } from '../lib/model.mjs';

function temporary(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-state-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test('local model preloads immediately while setup can proceed; failures surface at readiness', async () => {
    let release,
        calls = 0;
    const model = {
        request: (request) => {
            calls++;
            assert.equal(request.action, 'load');
            return new Promise((resolve) => {
                release = resolve;
            });
        },
    };
    const warmup = beginModelWarmup(model, { provider: 'local' }, () => {});
    assert.equal(calls, 1);
    assert.equal(model.startup.status, 'loading');
    release({ load_ms: 12 });
    await waitModelWarmup(warmup);
    assert.equal(model.startup.status, 'ready');
    const failure = beginModelWarmup(
        {
            request: async () => {
                throw Error('model unavailable');
            },
        },
        { provider: 'local' },
        () => {},
    );
    await assert.rejects(waitModelWarmup(failure), /model unavailable/);
});

test('API and explicit lazy mode never make preload requests', async () => {
    for (const config of [{ provider: 'api' }, { provider: 'local', lazyModel: true }]) {
        const model = {
            request: () => {
                throw Error('unexpected API or local request');
            },
        };
        await waitModelWarmup(beginModelWarmup(model, config, () => {}));
        assert.equal(model.startup.status, 'skipped');
    }
});

test('exit codes distinguish verified success, empty coverage, blocked and failed cases', () => {
    const cases = (statuses) => statuses.map((status) => ({ status }));
    assert.equal(resultExitCode(cases(['通过', '不适用'])), 0);
    assert.equal(resultExitCode(cases(['已验证'])), 0);
    for (const statuses of [
        [],
        ['不适用'],
        ['已验证', '未生成'],
        ['通过', '未执行（依赖阻断）'],
        ['中断'],
    ])
        assert.equal(resultExitCode(cases(statuses)), 1);
});

test('checkpoint preserves active step and uncertain write before case completes', (t) => {
    const out = temporary(t),
        journal = new RunJournal(out, { mode: 'generate' });
    const pendingWrite = { caseId: 'create', operation: 'create' };
    journal.checkpoint({ pendingWrite, activeCase: { id: 'create', steps: [{ kind: 'fill' }] } });
    const snapshot = JSON.parse(fs.readFileSync(path.join(out, 'checkpoint.json')));
    assert.deepEqual(snapshot.pendingWrite, pendingWrite);
    assert.equal(snapshot.activeCase.steps.length, 1);
    journal.completeCase({ id: 'create', status: '中断' }, { currentName: 'owned' });
    journal.finish({ results: journal.results, exitCode: 143 }, 'interrupted');
    const final = JSON.parse(fs.readFileSync(path.join(out, 'checkpoint.json')));
    assert.equal(final.status, 'interrupted');
    assert.equal(final.results.length, 1);
    assert.deepEqual(final.pendingWrite, pendingWrite);
    assert.equal(final.activeCase, null);
    journal.close();
});

test('concurrent and completed output directories cannot be overwritten', (t) => {
    const out = temporary(t),
        first = new RunJournal(out, {});
    assert.throws(() => new RunJournal(out, {}), /EEXIST/);
    first.close();
    assert.throws(() => new RunJournal(out, {}), /已有运行记录/);
    assert.equal(fs.existsSync(path.join(out, '.run.lock')), false);
});

test('private JSON stays valid and private when replacing an existing file', (t) => {
    const file = path.join(temporary(t), 'auth.json');
    writePrivateJson(file, { value: 'old' });
    writePrivateJson(file, { value: 'new' });
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), { value: 'new' });
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('saved auth is bound to exact origin/account and reset explicitly bypasses it', async (t) => {
    const authState = path.join(temporary(t), 'auth.json');
    const config = { url: 'https://app.test/records', user: 'tester', authState };
    assert.equal(await loadAuthState(config), null);
    writePrivateJson(authState, {
        schemaVersion: 1,
        origin: 'https://app.test',
        account: 'tester',
        storageState: { cookies: [], origins: [] },
    });
    assert.ok(await loadAuthState(config));
    await assert.rejects(loadAuthState({ ...config, user: 'other' }), /不匹配/);
    await assert.rejects(loadAuthState({ ...config, url: 'http://app.test/records' }), /不匹配/);
    assert.equal(await loadAuthState({ ...config, user: 'other', authReset: true }), null);
});

test('operation policy checks dependencies and inspects read-only replay steps', () => {
    assert.deepEqual(
        [...workflowPolicy({ readOnly: true })],
        ['tabs', 'tab-switch', 'table', 'filters'],
    );
    assert.deepEqual([...workflowPolicy({ operations: 'create,delete' })], ['create', 'delete']);
    assert.throws(() => workflowPolicy({ operations: 'delete' }), /依赖/);
    assert.throws(() => workflowPolicy({ readOnly: true, operations: 'create' }), /只允许/);
    assert.throws(() => workflowPolicy({ operations: ['unknown'] }), /不支持/);
    assert.throws(
        () =>
            enforceReplayPolicy(
                { cases: [{ id: 'bad', operation: 'table', steps: [{ kind: 'fill' }] }] },
                { readOnly: true },
            ),
        /只读回放/,
    );
    assert.throws(
        () =>
            enforceReplayPolicy(
                { cases: [{ id: 'extra', operation: 'create', steps: [] }] },
                { operations: 'table' },
            ),
        /超出/,
    );
});

test('local model is not started for deterministic work and cannot restart after close', async (t) => {
    const model = new Laya(
        '/not-installed-python',
        '/no-worker',
        '/no-model',
        path.join(temporary(t), 'model.ndjson'),
    );
    assert.equal(model.proc, undefined);
    model.close();
    await assert.rejects(model.choose('test', { A: 'a' }), /已关闭/);
    assert.equal(model.proc, undefined);
});
