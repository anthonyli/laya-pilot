import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parse } from 'acorn';
import { cmd, resolveSkillSettings, skillRoot } from '../common.mjs';
import { HEALTH_EXPECTATIONS } from './diagnostics.mjs';

const actionNames = { click: '点击', check: '勾选', uncheck: '取消勾选', hover: '悬停在' };
const recordedRoles = {
    button: '按钮',
    textbox: '输入框',
    link: '链接',
    tab: '标签页',
    checkbox: '复选框',
    combobox: '下拉框',
    menuitem: '菜单项',
};

function unsupported(node) {
    throw Error(
        `录制文件第 ${node?.loc?.start.line ?? '?'} 行无法转换为 Excel 步骤，请查看保留的 Playwright 用例。`,
    );
}

function literal(node) {
    if (node?.type !== 'Literal' || typeof node.value !== 'string') unsupported(node);
    // The Excel grammar uses quotes and line breaks to delimit values and steps.
    if (/[\r\n「」“”『』"]/.test(node.value) || /\$\{/.test(node.value)) unsupported(node);
    return node.value;
}

function method(call) {
    return call?.type === 'CallExpression' &&
        call.callee.type === 'MemberExpression' &&
        !call.callee.computed
        ? call.callee.property.name
        : undefined;
}

function locator(call) {
    let ordinal = null;
    if (method(call) === 'first' && !call.arguments.length) {
        ordinal = 1;
        call = call.callee.object;
    } else if (method(call) === 'nth' && call.arguments.length === 1) {
        const index = call.arguments[0].value;
        if (!Number.isSafeInteger(index) || index < 0 || index >= 1000) unsupported(call);
        ordinal = index + 1;
        call = call.callee.object;
    }
    if (call?.callee?.object?.name !== 'page') unsupported(call);
    const [target, options] = call.arguments;
    let role, name;
    if (
        method(call) === 'getByRole' &&
        call.arguments.length === 2 &&
        options?.type === 'ObjectExpression'
    ) {
        role = literal(target);
        if (
            !Object.hasOwn(recordedRoles, role) ||
            options.properties.some(
                (p) =>
                    p.type !== 'Property' || p.computed || !['name', 'exact'].includes(p.key.name),
            )
        )
            unsupported(call);
        name = literal(options.properties.find((p) => p.key.name === 'name')?.value);
    } else if (
        ['getByPlaceholder', 'getByLabel', 'getByText'].includes(method(call)) &&
        call.arguments.length === 1
    ) {
        role = method(call) === 'getByText' ? 'text' : 'textbox';
        name = literal(target);
    } else unsupported(call);
    if (!name.trim() || (ordinal !== null && role !== 'button')) unsupported(call);
    return { name, role, ordinal };
}

export function recordedCase(source) {
    const program = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
    const calls = program.body.filter((s) => s.expression?.callee?.name === 'test');
    if (calls.length !== 1) throw Error('请选择包含一条测试的 Playwright 录制文件。');
    for (const statement of program.body) {
        if (statement === calls[0]) continue;
        const declaration = statement.declarations?.[0];
        if (
            statement.type === 'VariableDeclaration' &&
            statement.declarations.length === 1 &&
            declaration.init?.callee?.name === 'require' &&
            declaration.init.arguments?.[0]?.value === 'playwright/test'
        )
            continue;
        if (statement.type === 'ImportDeclaration' && statement.source.value === '@playwright/test')
            continue;
        const use = statement.expression;
        const properties = use?.arguments?.[0]?.properties;
        if (
            method(use) === 'use' &&
            use.callee.object.name === 'test' &&
            use.arguments.length === 1 &&
            properties?.length === 1 &&
            properties[0].key?.name === 'channel' &&
            ['chromium', 'chrome', 'msedge'].includes(properties[0].value?.value)
        )
            continue;
        unsupported(statement);
    }
    const [title, callback] = calls[0].expression.arguments;
    if (!callback?.async || callback.body?.type !== 'BlockStatement') unsupported(callback);
    const steps = [],
        data = {},
        expected = Object.values(HEALTH_EXPECTATIONS);
    let url,
        assertions = 0;
    for (const statement of callback.body.body) {
        const call =
            statement.expression?.type === 'AwaitExpression' && statement.expression.argument;
        const action = method(call);
        if (!action) unsupported(statement);
        const object = call.callee.object;
        if (action === 'goto' && object.name === 'page' && call.arguments.length === 1) {
            const address = new URL(literal(call.arguments[0]));
            if (
                !['http:', 'https:'].includes(address.protocol) ||
                address.username ||
                address.password ||
                (url && new URL(url).origin !== address.origin)
            )
                unsupported(call);
            url ??= address.href;
            steps.push(`打开网址 ${address.href}`);
            continue;
        }
        if (object.callee?.name === 'expect' && object.arguments.length === 1) {
            const { name, role, ordinal } = locator(object.arguments[0]);
            let assertion;
            if (
                ordinal === null &&
                action === 'toBeVisible' &&
                !call.arguments.length &&
                ['button', 'text'].includes(role)
            )
                assertion = `页面显示「${name}」${role === 'button' ? '按钮' : ''}`;
            if (
                ordinal === null &&
                role === 'textbox' &&
                action === 'toHaveValue' &&
                call.arguments.length === 1
            )
                assertion = `「${name}」输入框的值为「${literal(call.arguments[0])}」`;
            if (
                ordinal === null &&
                role === 'textbox' &&
                action === 'toBeEmpty' &&
                !call.arguments.length
            )
                assertion = `「${name}」输入框为空`;
            if (!assertion) unsupported(call);
            steps.push(`检查步骤预期：${assertion}`);
            assertions++;
            continue;
        }
        const { name, role, ordinal } = locator(object);
        if (action === 'fill' && role === 'textbox' && call.arguments.length === 1) {
            if (/密码|password|passwd|token|api[\s_-]*key/i.test(name)) unsupported(call);
            const value = literal(call.arguments[0]);
            const key = `输入${Object.keys(data).length + 1}（${name}）`;
            data[key] = value;
            steps.push(
                value === '' ? `清空「${name}」输入框` : `在「${name}」输入框中输入「${value}」`,
            );
        } else if (ordinal !== null && action === 'click' && !call.arguments.length) {
            steps.push(`点击第 ${ordinal} 个「${name}」按钮`);
        } else if (
            ordinal === null &&
            Object.hasOwn(actionNames, action) &&
            !call.arguments.length
        ) {
            steps.push(`${actionNames[action]}「${name}」${recordedRoles[role] ?? ''}`);
        } else unsupported(call);
    }
    if (!url || steps.length < 2) throw Error('录制至少需要一个明确的网址和一项操作或预期。');
    expected.push(assertions ? '录制设置的步骤预期全部满足' : '业务结果待补充（录制时未设置预期）');
    const name = literal(title);
    return {
        url,
        id: 'REC-001',
        title: /^(test|录制用例)$/i.test(name) ? '浏览器录制流程' : name,
        preconditions: '',
        data: Object.keys(data).length ? JSON.stringify(data, null, 2) : '',
        steps: steps.map((step, index) => `${index + 1}. ${step}`).join('\n'),
        expected: expected.join('\n'),
    };
}

export async function exportRecording(file, output, python) {
    const source = await fs.readFile(file, 'utf8');
    const testCase = recordedCase(source);
    const settings = !python && (await resolveSkillSettings([])).settings;
    python ||= settings.python;
    if (!python)
        throw Error(
            `生成 Excel 需要现有 Excel 运行环境。请运行 ${cmd('setup')}，或用 --python 指定已安装 openpyxl 的 Python。`,
        );
    const script = fileURLToPath(new URL('./recording_excel.py', import.meta.url));
    const template = path.join(skillRoot, 'assets', 'test-cases-template.xlsx');
    await fs.mkdir(path.dirname(output), { recursive: true });
    await new Promise((resolve, reject) => {
        const child = spawn(python, [script, template, output], {
            stdio: ['pipe', 'ignore', 'pipe'],
        });
        let details = '';
        child.stderr.on('data', (chunk) => {
            details = (details + chunk).slice(-1500);
        });
        child.once('error', reject);
        child.once('close', (code) =>
            code === 0 ? resolve() : reject(Error(`Excel 导出失败：${details}`)),
        );
        child.stdin.on('error', reject);
        child.stdin.end(JSON.stringify(testCase));
    });
    return testCase;
}
