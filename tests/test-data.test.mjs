import test from 'node:test';
import assert from 'node:assert/strict';
import {
    optionGroups,
    chooseTestOption,
    chooseFieldValue,
    tomorrowDate,
} from '../lib/test-data.mjs';

test('candidate generation excludes administrator roles and preserves observed values', async () => {
    const options = ['超级管理员', '普通用户', '测试用户'].map((name) => ({ name }));
    const groups = optionGroups('角色', options);
    assert.equal(
        [...groups.values()].flat().some((x) => x.name === '超级管理员'),
        false,
    );
    const laya = {
        choose: async (_, criteria) => {
            assert.equal(JSON.stringify(criteria).includes('超级管理员'), false);
            return {
                choice: '普通或只读选项',
                probabilities: { 普通或只读选项: 0.9 },
                margin: 0.8,
            };
        },
    };
    assert.equal((await chooseTestOption(laya, '角色', options)).name, '普通用户');
    await assert.rejects(chooseTestOption(laya, '角色', [{ name: '超级管理员' }]), /没有适合/);
});

test('equivalent test options prefer a visible leaf and low confidence stops selection', async () => {
    const options = [
        { name: 'test', branch: true },
        { name: 'test_leaf', branch: false },
    ];
    const laya = {
        choose: async (_, criteria, meta) => {
            assert.equal(meta.phase, 'form-option');
            assert.ok(criteria['测试用途选项']);
            return { choice: '测试用途选项', probabilities: { 测试用途选项: 0.9 }, margin: 0.8 };
        },
    };
    assert.equal((await chooseTestOption(laya, '机构', options)).name, 'test_leaf');
    await assert.rejects(
        chooseTestOption(
            {
                choose: async () => ({
                    choice: '测试用途选项',
                    probabilities: { 测试用途选项: 0.3 },
                    margin: 0.02,
                }),
            },
            '角色',
            options,
        ),
        /模型未能确定/,
    );
});

test('field semantics reach the model and preserve fresh replay variables', async () => {
    const calls = [];
    const model = {
        choose: async (state, criteria, meta) => {
            calls.push(meta);
            assert.ok(criteria.账号);
            return { choice: '账号', probabilities: { 账号: 0.92 }, margin: 0.8 };
        },
    };
    assert.equal((await chooseFieldValue(model, { label: '登录账号' })).value, '${recordAccount}');
    assert.equal(calls[0].phase, 'form-field');
    await assert.rejects(
        chooseFieldValue(
            { choose: async () => ({ choice: '编造', probabilities: { 编造: 1 }, margin: 1 }) },
            { label: '未知' },
        ),
        /模型未能确定/,
    );
});

test('relative expiry rolls into the following month and year', () => {
    assert.equal(tomorrowDate(new Date(2026, 8, 30, 12)), '2026-10-01');
    assert.equal(tomorrowDate(new Date(2026, 11, 31, 12)), '2027-01-01');
});
