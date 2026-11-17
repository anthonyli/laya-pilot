import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const option = (args, name) => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw Error(`${name} 缺少参数`);
    return args[index + 1];
};
const object = (value, allowed, location) => {
    if (!value || Array.isArray(value) || typeof value !== 'object')
        throw Error(`${location} 必须是对象`);
    if (Object.keys(value).some((key) => !allowed.includes(key)))
        throw Error(`${location} 包含未知字段`);
};
const text = (value, location, optional = false) => {
    if (optional && value === undefined) return '';
    if (typeof value !== 'string' || (!optional && !value.trim()))
        throw Error(`${location} 需要明确文本`);
    return value;
};
const list = (value, location) => {
    if (!Array.isArray(value) || value.some((s) => typeof s !== 'string' || !s.trim()))
        throw Error(`${location} 必须是文本数组`);
    return value;
};

export function validateReviewPlan(source, saved = false) {
    object(
        source,
        [
            'url',
            'allowWrite',
            'cases',
            'uncovered',
            ...(saved ? ['schemaVersion', 'kind', 'status'] : []),
        ],
        'plan',
    );
    if (
        saved &&
        (source.schemaVersion !== 1 ||
            source.kind !== 'laya-review-plan' ||
            source.status !== 'draft-unverified')
    )
        throw Error('不是受支持的未验证审核草稿');
    const url = text(source.url, 'url');
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw Error('url 必须是完整 HTTP(S) 地址');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
        throw Error('url 必须是无嵌入凭据的 HTTP(S) 地址');
    if (typeof source.allowWrite !== 'boolean') throw Error('allowWrite 必须显式为 true 或 false');
    if (!Array.isArray(source.cases) || !source.cases.length) throw Error('cases 不能为空');
    const ids = new Set();
    const cases = source.cases.map((c, index) => {
        const where = `cases[${index}]`;
        object(c, ['id', 'title', 'preconditions', 'data', 'steps', 'expected', 'pending'], where);
        const id = text(c.id, `${where}.id`);
        if (ids.has(id)) throw Error('用例编号重复');
        ids.add(id);
        return {
            id,
            title: text(c.title, `${where}.title`),
            preconditions: text(c.preconditions, `${where}.preconditions`, true),
            data: text(c.data, `${where}.data`, true),
            steps: text(c.steps, `${where}.steps`),
            expected: text(c.expected, `${where}.expected`),
            pending: list(c.pending, `${where}.pending`),
        };
    });
    return {
        schemaVersion: 1,
        kind: 'laya-review-plan',
        status: 'draft-unverified',
        url,
        allowWrite: source.allowWrite,
        uncovered: list(source.uncovered, 'uncovered'),
        cases,
    };
}

export async function createReviewPlan(args) {
    const sourceFile = option(args, '--plan-source');
    if (!sourceFile) throw Error('--mode plan 需要 --plan-source JSON，不能从地址自动执行探索');
    for (const forbidden of [
        '--excel',
        '--url',
        '--allow-write',
        '--review-plan',
        '--approved-hash',
        '--inspect',
    ])
        if (args.includes(forbidden)) throw Error(`草稿范围来自 plan-source，不接受 ${forbidden}`);
    const plan = validateReviewPlan(
        JSON.parse(await fs.readFile(path.resolve(sourceFile), 'utf8')),
    );
    const bytes = JSON.stringify(plan, null, 2) + '\n';
    const digest = hash(bytes);
    const out = path.resolve(option(args, '--out') || path.join('review-plans', randomUUID()));
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.mkdir(out); // Never replace an already reviewed plan.
    await fs.writeFile(path.join(out, 'draft-plan.json'), bytes, { flag: 'wx' });
    const md = [
        '# 未验证用例草稿',
        '',
        '本文件未访问页面、未执行测试。审核目标地址、操作范围、步骤、预期及待补充项后，才可批准对应 SHA-256 的执行。',
        '',
        `SHA-256: ${digest}`,
        '',
        JSON.stringify(
            { url: plan.url, allowWrite: plan.allowWrite, uncovered: plan.uncovered },
            null,
            2,
        ),
        '',
        ...plan.cases.flatMap((c) => ['```json', JSON.stringify(c, null, 2), '```', '']),
        '修改草稿后必须重新核对内容与摘要；pending 非空的草稿不能执行。',
        '',
    ];
    await fs.writeFile(path.join(out, 'draft-cases.md'), md.join('\n'), { flag: 'wx' });
    console.log(
        JSON.stringify({
            status: plan.status,
            directory: out,
            sha256: digest,
            cases: plan.cases.length,
            browserStarted: false,
        }),
    );
}

export async function loadReviewedPlan(args, inspect = false) {
    const file = option(args, '--review-plan');
    if (!file) throw Error('--mode reviewed 需要 --review-plan');
    for (const forbidden of [
        '--excel',
        '--url',
        '--case-file',
        '--cases',
        '--data',
        '--labels',
        '--control-bindings',
        '--operations',
        '--allow-write',
        '--read-only',
        '--include-approval',
        '--plan-source',
        '--config',
    ])
        if (args.includes(forbidden))
            throw Error(`审核执行不接受 ${forbidden} 覆盖已审核范围；请修订草稿后重新审核`);
    const bytes = await fs.readFile(path.resolve(file));
    const digest = hash(bytes);
    const plan = validateReviewPlan(JSON.parse(bytes.toString('utf8')), true);
    if (!inspect && option(args, '--approved-hash') !== digest)
        throw Error(`需要用户明确批准本版本后传 --approved-hash ${digest}；摘要不符时不执行`);
    if (!inspect && plan.cases.some((c) => c.pending.length))
        throw Error('草稿仍有 pending 待补充项，不能执行');
    return { plan, sha256: digest };
}

export async function materializeReviewedPlan(review, python, out) {
    await fs.mkdir(out, { recursive: true });
    const file = path.join(out, `reviewed-cases-${randomUUID()}.xlsx`);
    const script = fileURLToPath(new URL('./review_plan_excel.py', import.meta.url));
    await new Promise((resolve, reject) => {
        const child = spawn(python, [script, file], { stdio: ['pipe', 'ignore', 'pipe'] });
        let error = '';
        child.stderr.on('data', (chunk) => {
            error = (error + chunk).slice(-2000);
        });
        child.once('error', reject);
        child.once('close', (code) =>
            code === 0 ? resolve() : reject(Error('审核用例转换失败：' + error)),
        );
        child.stdin.on('error', reject);
        child.stdin.end(JSON.stringify(review.plan));
    });
    return file;
}
