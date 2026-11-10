import test from 'node:test';
import assert from 'node:assert/strict';
import { describe, expectation, variables, lines, parseData } from '../lib/language.mjs';
test('Chinese/English values preserved, including empty strings', () => {
    assert.deepEqual(describe('在“客户名称”输入框输入“张三”'), {
        verb: 'fill',
        target: '客户名称',
        value: '张三',
    });
    assert.deepEqual(describe('在名称输入框输入「测试」'), {
        verb: 'fill',
        target: '名称',
        value: '测试',
    });
    assert.deepEqual(describe('Fill "Product name" with "Blue notebook"'), {
        verb: 'fill',
        target: 'Product name',
        value: 'Blue notebook',
    });
    assert.deepEqual(describe('在“订单状态”下拉框选择“待处理”'), {
        verb: 'select',
        target: '订单状态',
        value: '待处理',
    });
    assert.equal(describe('在“客户名称”输入框输入“”').value, '');
});
test('Unknown/missing data must never turn into an action or a pass', () => {
    assert.equal(describe('随便找个账户完成转账').verb, 'unsupported');
    assert.equal(expectation('一切正常').kind, 'unsupported');
    assert.throws(() => variables('输入${missing}', {}));
    assert.throws(() => parseData('任意写点数据'));
});
test('Negative, selected and count assertions are distinct', () => {
    assert.deepEqual(expectation('页面不显示“错误”'), {
        kind: 'absent',
        target: '错误',
        scope: '页面',
    });
    assert.deepEqual(expectation('“客户名称”为空'), { kind: 'empty', target: '客户名称' });
    assert.deepEqual(expectation('默认选中「运行区」Tab'), { kind: 'selected', target: '运行区' });
    assert.deepEqual(expectation('列表记录数为1'), { kind: 'rowcount', value: 1 });
    assert.equal(lines('1、点击“新增”\n2、查看页面').length, 2);
});

test('quoted semicolons stay in steps and expectations while outside separators split', () => {
    for (const [open, close] of [
        ['「', '」'],
        ['“', '”'],
        ['"', '"'],
    ]) {
        const step = `点击${open}a;b；c${close}`;
        const expected = `页面显示${open}a;b；c${close}`;
        assert.deepEqual(
            lines(`${step}；点击「下一步」;${step}`)
                .map(describe)
                .map((x) => x.target),
            ['a;b；c', '下一步', 'a;b；c'],
        );
        assert.deepEqual(
            lines(`${expected};${expected}`)
                .map(expectation)
                .map((x) => x.target),
            ['a;b；c', 'a;b；c'],
        );
    }
    assert.equal(describe(lines('Fill "name" with "a;b；c"')[0]).value, 'a;b；c');
    assert.equal(expectation(lines('page shows "a;b"')[0]).target, 'a;b');
});
