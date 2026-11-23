import {
    describe,
    expectation,
    lines,
    parseData,
    quoted,
    recordedReviewPrefix,
} from './language.mjs';
import { expandStep } from './planner.mjs';

export function assertionDiagnostic(text) {
    const business = /一致|正确|正常|按预期|成功|完整|无报错|无崩溃|无接口异常/.test(text);
    return {
        code: business ? 'missing-business-oracle' : 'unsupported-assertion',
        status: 'unverified',
        message: business ? '缺少可执行的业务判定依据' : '当前未支持该预期的断言语法',
        suggestion: business
            ? '补充要核对的数据、期望值、范围及判定规则；保留原业务预期，不能降级为控件可见。'
            : '补充可观察对象、范围与精确结果，或专项适配此断言；不能直接算作通过。',
    };
}

// Split conjunctions outside quoted literals only. Never invent an omitted scope.
export function compileExpectation(source) {
    const parts = [];
    let start = 0;
    const tokens = /[“「『"]([^”」』"]*)[”」』"]|并且|而且|且|\s+and\s+/gi;
    for (const match of source.matchAll(tokens)) {
        if (/^[“「『"]/.test(match[0])) continue;
        parts.push(source.slice(start, match.index).trim());
        start = match.index + match[0].length;
    }
    parts.push(source.slice(start).trim());
    return parts.map((text, index) => {
        const spec = expectation(text);
        let diagnostic;
        if (spec.kind === 'unsupported') diagnostic = assertionDiagnostic(text);
        else if (
            parts.length > 1 &&
            /^(?:显示|展示|包含|出现|不显示|不展示|不存在|不包含|shows\b|contains\b)/i.test(text)
        )
            diagnostic = {
                code: 'missing-assertion-scope',
                status: 'unverified',
                message: '复合预期的子句未明确页面、弹窗或列表范围',
                suggestion: '分别写明每个子句的范围，不自动继承或扩大前一子句范围。',
            };
        return { source, index: index + 1, text, ...spec, ...(diagnostic ? { diagnostic } : {}) };
    });
}

export function stepDiagnostic(text) {
    if (text.startsWith(recordedReviewPrefix))
        return {
            code: 'unresolved-recorded-action',
            status: 'needs-review',
            message: text,
            suggestion: '将此行替换为实际操作后再回放。',
        };
    const spec = describe(text);
    const expanded = expandStep(text);
    if (
        expanded.length &&
        !expanded.some(
            (s) =>
                (s.verb === 'navigate' && !s.target) ||
                (['fill', 'select'].includes(s.verb) && s.value === undefined),
        )
    )
        return {
            code: 'needs-live-target',
            status: 'needs-page',
            message: '动作语法可解释，目标及操作效果仍需页面验证',
            suggestion: '运行时根据当前页面定位；预检不证明控件存在或动作成功。',
        };
    if (/(?:输入|填写|填入)(?!框)|(?:下拉框|下拉列表).*选择/i.test(text) && quoted(text).length < 2)
        return {
            code: 'missing-test-value',
            status: 'needs-data',
            message: '没有可绑定到目标的明确输入值或选项',
            suggestion:
                '提供目标名称和精确值，或在测试数据中定义变量并在步骤引用；不自动猜测“合法数据”。',
        };
    if (spec.verb === 'navigate' && !spec.target)
        return {
            code: 'missing-navigation-url',
            status: 'needs-data',
            message: '导航步骤没有完整地址',
            suggestion: '填写本次范围内的完整 HTTP(S) URL。',
        };
    return {
        code: 'needs-action-planning',
        status: 'needs-page',
        message: '静态语法未覆盖，需页面上下文判断是否有可用动作',
        suggestion: '保留原步骤；运行时不能形成完整动作则报告执行能力不足，不认定用例错误。',
    };
}

export function inspectCase(c, overrides = {}, runId) {
    const location = { sheet: c.sheet, row: c.row, id: c.id, key: c.key };
    const diagnostics = [];
    let data = {};
    try {
        data = { ...parseData(c.data), ...overrides };
    } catch {
        diagnostics.push({
            ...location,
            field: 'data',
            index: 1,
            code: 'invalid-test-data',
            status: 'needs-data',
            message: '测试数据不能解析为 JSON 对象或名称=值',
            suggestion: '修正测试数据表达形式，保留其业务取值。',
        });
    }
    if (runId !== undefined) data.runId = runId;
    const resolve = (text, field, index) => {
        if (text.includes('${runId}') && !Object.hasOwn(data, 'runId'))
            diagnostics.push({
                ...location,
                field,
                index,
                text,
                code: 'runtime-variable',
                status: 'needs-run',
                message: 'runId 在运行时确定，当前仅检查表达形式',
                suggestion: '执行后从本轮结果核对实际值，不把预检算作通过。',
            });
        const missing = [
            ...new Set(
                [...text.matchAll(/\$\{([^}]+)\}/g)]
                    .map((m) => m[1])
                    .filter((key) => key !== 'runId' && !Object.hasOwn(data, key)),
            ),
        ];
        if (missing.length)
            diagnostics.push({
                ...location,
                field,
                index,
                text,
                code: 'missing-variable',
                status: 'needs-data',
                variables: missing,
                message: '缺少变量值：' + missing.join('、'),
                suggestion:
                    '在本例测试数据或显式任务数据中提供这些变量，不替换或删除原步骤和预期。',
            });
        return text.replace(/\$\{([^}]+)\}/g, (original, key) =>
            Object.hasOwn(data, key) ? String(data[key]) : original,
        );
    };
    lines(c.preconditions).forEach((text, index) => resolve(text, 'preconditions', index + 1));
    lines(c.steps).forEach((text, index) => {
        const resolved = resolve(text, 'steps', index + 1);
        diagnostics.push({
            ...location,
            field: 'steps',
            index: index + 1,
            text,
            ...stepDiagnostic(resolved),
        });
    });
    const compilation = lines(c.expected).map((text, index) => {
        const resolved = resolve(text, 'expected', index + 1);
        const assertions = compileExpectation(resolved);
        for (const assertion of assertions)
            if (assertion.diagnostic)
                diagnostics.push({
                    ...location,
                    field: 'expected',
                    index: index + 1,
                    clause: assertion.index,
                    text,
                    ...assertion.diagnostic,
                });
        return { text, resolved, index: index + 1, assertions };
    });
    return { diagnostics, compilation };
}
