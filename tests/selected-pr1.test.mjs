import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { PendingWrites } from '../lib/pending-writes.mjs';
import { Workflow, validateWorkflow } from '../lib/workflow.mjs';
import { observe } from '../lib/dom.mjs';
import { inspectLooseRequired, looseInputRef, formErrors } from '../lib/form.mjs';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const quietPage = () => ({
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
});
test('sibling labels name input fields without renaming save/cancel buttons', async () => {
    const node = (tag, text, previous = null) => ({
        tagName: tag,
        innerText: text,
        previousElementSibling: previous,
        parentElement: null,
        getAttribute: () => null,
        hasAttribute: () => false,
        setAttribute: () => {},
        closest: () => null,
        querySelector: () => null,
        matches: () => false,
        getBoundingClientRect: () => ({ width: 100, height: 30 }),
        classList: { contains: () => false },
    });
    const label = node('LABEL', '名称'),
        input = node('INPUT', '', label),
        save = node('BUTTON', '保存', input),
        cancel = node('BUTTON', '取消', save);
    const document = {
        querySelectorAll: (selector) =>
            selector === '*'
                ? [label, input, save, cancel]
                : selector.startsWith('button,a[href],input')
                  ? [input, save, cancel]
                  : [],
        getElementById: () => null,
    };
    const frame = {
        evaluate: async (fn, args) =>
            vm.runInNewContext(`(${fn.toString()})(args)`, {
                args,
                document,
                getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
            }),
    };
    const result = await observe({ frames: () => [frame], url: () => 'https://test.local' });
    assert.deepEqual(
        result.controls.map((c) => c.name),
        ['名称', '保存', '取消'],
    );
});

test('create retries use fresh refs and reach the second live entry', async () => {
    let generation = 0;
    const clicked = [];
    const fake = {
        checkInterrupted: () => {},
        page: quietPage(),
        snapshot: async () => {
            generation++;
            return {
                controls: ['新增甲', '新增乙'].map((name, i) => ({
                    name,
                    role: 'button',
                    ref: generation + '-' + i,
                    frame: 0,
                })),
                frames: [
                    {
                        locator: (selector) => ({
                            count: async () => (selector.includes('"' + generation + '-') ? 1 : 0),
                            isVisible: async () => true,
                        }),
                    },
                ],
            };
        },
        safeClick: async (_, name) => clicked.push(name),
        record: () => {},
        waitForModal: async () => {},
        modalPresent: async () => clicked.includes('新增乙'),
        dismissModal: async () => {},
    };
    await Workflow.prototype.withAttempts.call(fake, 'clickCreate', () =>
        Workflow.prototype.clickCreate.call(fake),
    );
    assert.deepEqual(clicked, ['新增甲', '新增乙']);
});

test('disabled assertions reject enabled and ambiguous targets and never click', async () => {
    const step = { kind: 'assert-disabled', target: { name: '保存', role: 'button' } };
    for (const states of [[true], [false], [true, false], []]) {
        const fake = {
            snapshot: async () => ({
                controls: states.map((disabled) => ({ name: '保存', role: 'button', disabled })),
            }),
            record: () => {},
            safeClick: () => assert.fail('assertion clicked'),
        };
        if (states.length === 1 && states[0]) await Workflow.prototype.replayStep.call(fake, step);
        else await assert.rejects(Workflow.prototype.replayStep.call(fake, step));
    }
});

test('writes wait for completion while GET polling does not block', async () => {
    const page = new EventEmitter(),
        writes = new PendingWrites(page),
        post = { method: () => 'POST' },
        poll = { method: () => 'GET' };
    page.emit('request', post);
    page.emit('request', poll);
    let finished = false;
    const waiting = writes.wait().then(() => {
        finished = true;
    });
    await tick();
    assert.equal(finished, false);
    page.emit('requestfinished', post);
    await waiting;
    assert.equal(finished, true);
    const deletion = { method: () => 'DELETE' };
    page.emit('request', deletion);
    await assert.rejects(writes.wait(5), /拒绝刷新/);
    page.emit('requestfailed', deletion);
    await writes.wait();
});

test('save and delete-confirm replay cannot reload until modal and writes finish', async () => {
    for (const purpose of ['save', 'confirm', 'delete']) {
        const page = new EventEmitter(),
            writes = new PendingWrites(page),
            request = { method: () => 'POST' };
        page.emit('request', request);
        const events = [];
        page.reload = async () => {
            events.push('reload');
            throw Error('reached reload');
        };
        const fake = {
            case: { steps: [{ kind: 'click', purpose }] },
            config: { pageTimeout: 1000 },
            page,
            pendingWrites: writes,
            waitModalClosed: async () => events.push('modal closed'),
        };
        const attempt = assert.rejects(Workflow.prototype.reload.call(fake), /reached reload/);
        await tick();
        assert.deepEqual(events, ['modal closed']);
        page.emit('requestfinished', request);
        await attempt;
        assert.deepEqual(events, ['modal closed', 'reload']);
    }
});

test('modal timeout and intercepted clicks remain failures', async () => {
    let reloaded = false;
    await assert.rejects(
        Workflow.prototype.reload.call({
            case: { steps: [{ kind: 'click', purpose: 'save' }] },
            waitModalClosed: async () => {
                throw Error('modal timeout');
            },
            page: {
                reload: () => {
                    reloaded = true;
                },
            },
        }),
        /modal timeout/,
    );
    assert.equal(reloaded, false);
    let attempts = 0;
    await assert.rejects(
        Workflow.prototype.safeClick.call(
            {},
            {
                click: async () => {
                    throw Error(++attempts === 1 ? 'intercepts pointer events' : 'detached');
                },
                evaluate: async () => true,
            },
        ),
        /intercepts pointer events/,
    );
});

test('native required inputs retain stable label identity after required is removed', async () => {
    const attributes = new Map();
    let required = true;
    const label = { tagName: 'LABEL', innerText: '邮箱' };
    const input = {
        tagName: 'INPUT',
        previousElementSibling: label,
        value: '',
        disabled: false,
        readOnly: false,
        getBoundingClientRect: () => ({ width: 100, height: 30 }),
        closest: () => null,
        getAttribute: (name) =>
            name === 'placeholder'
                ? 'email'
                : name === 'type'
                  ? 'email'
                  : attributes.get(name) || null,
        setAttribute: (name, value) => attributes.set(name, value),
    };
    const root = {
        getBoundingClientRect: input.getBoundingClientRect,
        querySelectorAll: (selector) => (selector === 'input,textarea' || required ? [input] : []),
    };
    const document = { querySelectorAll: () => [root] };
    const page = {
        evaluate: async (fn, args) =>
            vm.runInNewContext(`(${fn.toString()})(args)`, {
                args,
                document,
                getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
            }),
    };
    const fields = await inspectLooseRequired(page);
    assert.equal(fields.length, 1);
    assert.equal(fields[0].label, '邮箱');
    required = false;
    input.value = 'a@example.com';
    assert.ok(await looseInputRef(page, fields[0]));
    assert.equal((await inspectLooseRequired(page)).length, 0);
});

test('native validity messages identify inputs without component error wrappers', async () => {
    const input = {
        tagName: 'INPUT',
        labels: [],
        previousElementSibling: { tagName: 'LABEL', innerText: '邮箱' },
        validationMessage: 'Please fill out this field.',
        getAttribute: () => null,
        getBoundingClientRect: () => ({ width: 50, height: 20 }),
    };
    const root = {
        getBoundingClientRect: input.getBoundingClientRect,
        querySelectorAll: (selector) =>
            selector === 'input:invalid,textarea:invalid,select:invalid' ? [input] : [],
    };
    const page = {
        evaluate: async (fn, args) =>
            vm.runInNewContext(`(${fn.toString()})(args)`, {
                args,
                document: { querySelectorAll: () => [root] },
                getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
            }),
    };
    const errors = await formErrors(page);
    assert.equal(errors.open, true);
    assert.equal(errors.labels[0], '邮箱');
    assert.equal(errors.messages[0], input.validationMessage);
});

test('saved disabled assertions reject missing targets and legacy required steps still validate', () => {
    const file = {
        schemaVersion: 1,
        moduleUrl: 'https://app.test',
        cases: [
            {
                id: 'validation',
                operation: 'form-validation',
                steps: [{ kind: 'assert-disabled', target: { name: '保存', role: 'button' } }],
            },
        ],
    };
    assert.equal(validateWorkflow(file), file);
    delete file.cases[0].steps[0].target;
    assert.throws(() => validateWorkflow(file), /禁用态断言/);
    file.cases = [
        {
            id: 'create',
            operation: 'create',
            steps: [
                {
                    kind: 'form-fill-required',
                    target: { placeholder: '邮箱', index: 0 },
                    value: 'a@example.com',
                },
            ],
        },
    ];
    assert.equal(validateWorkflow(file), file);
});
