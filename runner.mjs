import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Laya, beginModelWarmup, waitModelWarmup } from './lib/model.mjs';
import { resultExitCode } from './lib/run-state.mjs';
import { ensureAuthentication, saveAuthState } from './lib/auth-state.mjs';
import { openBrowser } from './lib/browser-provider.mjs';
import {
    loadLocalEnvironment,
    loadProjectConfig,
    configured,
    configuredFlag,
} from './lib/project-config.mjs';
import { Engine } from './lib/engine.mjs';
import { describe, expectation, lines } from './lib/language.mjs';
import { settle } from './lib/dom.mjs';
const ROOT = path.dirname(fileURLToPath(import.meta.url)),
    args = process.argv.slice(2);
const arg = (n, d) => {
    const i = args.indexOf(n);
    if (i < 0) return d;
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(n + '缺少参数');
    return args[i + 1];
};
const flag = (n) => args.includes(n);
await loadLocalEnvironment(ROOT);
const fileConfig = await loadProjectConfig(arg('--config', ''));
const option = (cli, env, key, fallback) => configured(arg, cli, env, fileConfig[key], fallback);
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const config = {
    url: option('--url', 'TEST_URL', 'url', ''),
    excel: option('--excel', 'TEST_EXCEL', 'excel', ''),
    user: option('--user', 'TEST_USER', 'user', ''),
    python: option('--python', 'LAYA_PYTHON', 'python', path.join(ROOT, '.venv', 'bin', 'python')),
    model: option('--model', 'LAYA_MODEL', 'model', 'convaiinnovations/laya-multilingual'),
    provider: option('--provider', 'LAYA_PROVIDER', 'provider', 'local'),
    lazyModel: configuredFlag(args, '--lazy-model', null, fileConfig.lazyModel),
    apiBase: option('--api-base', 'LAYA_API_BASE', 'apiBase', ''),
    apiModel: option('--api-model', 'LAYA_API_MODEL', 'apiModel', ''),
    apiTimeout: Number(option('--api-timeout', 'LAYA_API_TIMEOUT', 'apiTimeout', 30000)),
    browserProvider: option(
        '--browser-provider',
        'BROWSER_PROVIDER',
        'browserProvider',
        'playwright',
    ),
    browserChannel: option('--browser-channel', 'BROWSER_CHANNEL', 'browserChannel', ''),
    authState: option('--auth-state', 'TEST_AUTH_STATE', 'authState', ''),
    authCheck: option('--auth-check', 'TEST_AUTH_CHECK', 'authCheck', ''),
    authReset: flag('--auth-reset'),
    authSessionStorage: configuredFlag(
        args,
        '--auth-session-storage',
        null,
        fileConfig.authSessionStorage,
    ),
    operations: option('--operations', null, 'operations', ''),
    headless: configuredFlag(args, '--headless', 'BROWSER_HEADLESS', fileConfig.headless),
    allowWrite: flag('--allow-write') && !flag('--read-only'),
    readOnly: flag('--read-only'),
    includeApproval: flag('--include-approval'),
    manualLogin: flag('--manual-login'),
    keepOpen: flag('--keep-open'),
    dryRun: flag('--inspect'),
    reloadEachCase: flag('--reload-each-case'),
    language: option('--language', 'TEST_LANGUAGE', 'language', 'auto'),
    pageTimeout: Number(arg('--page-timeout', '18000')),
    delay: Number(arg('--delay', '180')),
    assertTimeout: Number(arg('--assert-timeout', '4000')),
    maxSteps: Number(arg('--max-steps', '25')),
    minProbability: Number(arg('--min-probability', '0.68')),
    minMargin: Number(arg('--min-margin', '0.18')),
    cases: arg('--cases', '').split(',').filter(Boolean),
    data: fileConfig.data || {},
    runId,
    out: path.resolve(option('--out', 'TEST_OUTPUT', 'out', path.join(ROOT, 'runs', runId))),
};
async function secret(label = '登录密码', envName = 'TEST_PASSWORD') {
    if (process.env[envName]) return process.env[envName];
    if (!process.stdin.isTTY) throw Error('需要交互终端输入' + label + '，或设置' + envName);
    process.stdout.write(label + '（隐藏输入）：');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    return new Promise((resolve, reject) => {
        let value = '';
        const done = () => {
            process.stdin.off('data', on);
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdout.write('\n');
        };
        const on = (b) => {
            for (const c of String(b)) {
                if (c === '\u0003') {
                    done();
                    reject(Error('已取消'));
                    return;
                }
                if (c === '\r' || c === '\n') {
                    done();
                    resolve(value);
                    return;
                }
                if (c === '\u007f') value = value.slice(0, -1);
                else value += c;
            }
        };
        process.stdin.on('data', on);
    });
}
function csv(v) {
    let s = String(v ?? '');
    if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
}
async function report(results, laya, source, warnings) {
    const counts = {};
    for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
    const actual = laya.records.filter((r) => !r.cache_hit),
        times = actual.map((x) => x.inference_ms).sort((a, b) => a - b);
    const summary = {
        source,
        selection: config.selection,
        import_warnings: warnings,
        mode: config.headless ? 'headless' : 'headed',
        provider: config.provider,
        model: config.provider === 'api' ? config.apiModel : config.model,
        modelStartup: laya.startup || null,
        ...(config.provider === 'api' ? { api_base: config.apiBase } : {}),
        engine:
            '通用DOM候选 + ' +
            (config.provider === 'api' ? 'API Laya' : '本地Laya') +
            '选择 + 确定性断言',
        counts,
        metrics: {
            model_calls: actual.length,
            model_errors: laya.errors?.length || 0,
            cache_hits: laya.records.length - actual.length,
            p50_ms: times[Math.floor(times.length / 2)] ?? null,
        },
        results,
    };
    await fs.writeFile(path.join(config.out, 'results.json'), JSON.stringify(summary, null, 2));
    const rows = [
        [
            '工作表',
            '编号',
            '用例',
            '结果',
            '原因分类',
            '说明',
            '完成动作数',
            '通过断言数',
            '断言总数',
            '截图',
        ],
        ...results.map((r) => [
            r.sheet,
            r.id,
            r.title,
            r.status,
            r.category,
            r.reason,
            r.actions.length,
            r.assertions.filter((a) => a.status === '通过').length,
            r.assertions.length,
            r.screenshot,
        ]),
    ];
    await fs.writeFile(
        path.join(config.out, '结果.csv'),
        '\uFEFF' + rows.map((r) => r.map(csv).join(',')).join('\r\n'),
    );
    const clean = (s) => String(s).replace(/[|\n\r]/g, ' ');
    let md = `# 通用版执行结果\n\n输入：${path.basename(config.excel)}；可见浏览器：${!config.headless}；推理来源：${config.provider}。\n\n${Object.entries(
        counts,
    )
        .map(([k, v]) => k + ' ' + v)
        .join(
            '，',
        )}。通过要求步骤完整执行且全部预期有明确断言；跳过不计通过。\n\n|编号|用例|结果|原因|\n|---|---|---|---|\n`;
    for (const r of results)
        md += `|${clean(r.id)}|${clean(r.title)}|${r.status}|${clean(r.reason)}|\n`;
    await fs.writeFile(path.join(config.out, '报告.md'), md);
    await fs.writeFile(
        path.join(ROOT, 'latest-run.json'),
        JSON.stringify({ directory: config.out, counts }, null, 2),
    );
    return summary;
}
let laya, browser, activePage;
async function main() {
    if (flag('--help')) {
        console.log(
            'LayaPilot\n生成：./run.sh --mode generate --url 页面地址 [--template-excel 模板.xlsx] [--case-file 用例.xlsx]\n回放：./run.sh --mode execute --case-file 用例.xlsx [--url 页面地址]\n原有Excel：./run.sh --excel 用例.xlsx --url 页面地址 [--cases 001,002]\n--config 配置.json；--provider local|api；--browser-provider playwright；--browser-channel chrome|chromium；--headless。API地址和模型名称需自行配置，密钥由LAYA_API_KEY或隐藏输入提供。',
        );
        console.log(
            '--auth-state 文件：保存/复用登录态；--auth-reset：重新登录；--auth-check CSS：登录成功标记；--auth-session-storage：保存当前站点 sessionStorage',
        );
        console.log(
            '--operations tabs,tab-switch,table,filters,form-validation,form-invalid,create,search,view,edit,delete,discover；discover：模板完成后由模型选择补充测试；--read-only：只读检查；--data JSON文件：明确覆盖字段值',
        );
        console.log(
            '本地模型默认启动预热，与浏览器准备并行；--lazy-model 改为按需加载。退出码：0 全部选中用例通过（不适用除外），1 失败/阻断/无用例，130 SIGINT，143 SIGTERM。',
        );
        return;
    }
    if (!config.excel && !arg('--mode', '')) throw Error('请通过--excel指定用例文件');
    if (!['local', 'api'].includes(config.provider))
        throw Error('--provider仅支持local或api，默认local');
    if (config.provider === 'api' && (!config.apiBase || !config.apiModel))
        throw Error('API模式需配置 LAYA_API_BASE 和 LAYA_API_MODEL');
    if (config.browserProvider !== 'playwright')
        throw Error('当前只实现 playwright 浏览器驱动；browser-use 等适配器尚未实现');
    if (!Number.isFinite(config.apiTimeout) || config.apiTimeout <= 0)
        throw Error('--api-timeout必须大于0');
    for (const key of [
        'delay',
        'assertTimeout',
        'pageTimeout',
        'maxSteps',
        'minProbability',
        'minMargin',
    ])
        if (!Number.isFinite(config[key]) || config[key] < 0) throw Error('参数无效：' + key);
    if (!['auto', 'zh-CN', 'en', 'none'].includes(config.language))
        throw Error('--language仅支持auto、zh-CN、en、none');
    if (!config.data || typeof config.data !== 'object' || Array.isArray(config.data))
        throw Error('data 必须是 JSON 对象');
    if (config.authState && !config.authCheck)
        throw Error('--auth-state 需要 --auth-check 指定登录成功后的唯一页面标记');
    if ((config.authReset || config.authSessionStorage) && !config.authState)
        throw Error('--auth-reset / --auth-session-storage 需要 --auth-state');
    if (!arg('--mode', '') && config.operations) throw Error('--operations 仅用于生成和回放');
    if (arg('--labels', '')) {
        config.labels = JSON.parse(await fs.readFile(arg('--labels', ''), 'utf8'));
        if (
            !config.labels ||
            Array.isArray(config.labels) ||
            typeof config.labels !== 'object' ||
            Object.values(config.labels).some((v) => typeof v !== 'string' || !v.trim())
        )
            throw Error('--labels需要名称映射JSON对象');
    }
    if (arg('--data', '')) {
        const d = JSON.parse(await fs.readFile(arg('--data', ''), 'utf8'));
        if (!d || typeof d !== 'object' || Array.isArray(d)) throw Error('--data必须是JSON对象');
        config.data = d;
    }
    const workflowMode = arg('--mode', '');
    if (workflowMode) {
        config.caseFile = option('--case-file', 'TEST_CASE_FILE', 'caseFile', '');
        config.templateExcel = option(
            '--template-excel',
            'TEST_TEMPLATE_EXCEL',
            'templateExcel',
            config.excel || '',
        );
        const { runWorkflow } = await import('./lib/workflow.mjs');
        const summary = await runWorkflow(config, workflowMode, secret, ROOT);
        process.exitCode = summary.exitCode;
        return summary;
    }
    await fs.mkdir(path.join(config.out, 'evidence'), { recursive: true });
    let apiKey =
        config.provider === 'api' && !config.dryRun
            ? await secret('API密钥', 'LAYA_API_KEY')
            : undefined;
    laya = new Laya(
        config.python,
        path.join(ROOT, 'worker.py'),
        config.model,
        path.join(config.out, 'decisions.ndjson'),
        {
            provider: config.dryRun ? 'local' : config.provider,
            base: config.apiBase,
            model: config.apiModel,
            key: apiKey,
            timeout: config.apiTimeout,
        },
    );
    apiKey = null;
    const input = await laya.request({ action: 'read_excel', path: path.resolve(config.excel) });
    if (!input.cases.length) throw Error('Excel未读取到用例：' + input.warnings.join('；'));
    const onlyPass = !flag('--all-cases');
    const eligible = input.cases.filter(
        (c) =>
            !onlyPass ||
            String(c.source_result || '')
                .trim()
                .toLowerCase() === 'pass',
    );
    const selected = eligible.filter(
        (c) =>
            !config.cases.length ||
            config.cases.some((x) => x === c.id || x.padStart(3, '0') === c.id || x === c.key),
    );
    config.selection = {
        only_source_pass: onlyPass,
        total: input.cases.length,
        eligible: eligible.length,
        selected: selected.length,
        excluded: input.cases
            .filter((c) => !eligible.includes(c))
            .map((c) => ({ id: c.id, sheet: c.sheet, source_result: c.source_result })),
    };
    await fs.writeFile(
        path.join(config.out, 'selection.json'),
        JSON.stringify(config.selection, null, 2),
    );
    if (!selected.length)
        throw Error(
            '没有匹配的pass用例或指定编号；其他工作簿需要执行非pass用例时显式使用--all-cases',
        );
    const inspection = selected.map((c) => ({
        id: c.id,
        key: c.key,
        title: c.title,
        preconditions: c.preconditions,
        steps: lines(c.steps).map((text) => ({ text, ...describe(text) })),
        expected: lines(c.expected).map((text) => ({ text, ...expectation(text) })),
    }));
    await fs.writeFile(
        path.join(config.out, 'excel-inspection.json'),
        JSON.stringify({ warnings: input.warnings, cases: inspection }, null, 2),
    );
    console.log(`读取${input.cases.length}条，本轮${selected.length}条。`);
    if (onlyPass)
        console.log(
            `仅执行原Excel“实际执行结果”为pass的用例；排除${input.cases.length - eligible.length}条。`,
        );

    if (config.dryRun) {
        console.log('Excel检查结果：' + path.join(config.out, 'excel-inspection.json'));
        laya.close();
        return;
    }
    if (!config.url) throw Error('请通过--url指定起始页面');
    config.origins = [new URL(config.url).origin];
    if (!['auto', 'generic'].includes(arg('--engine', 'auto')))
        throw Error('公开版只支持通用引擎；--engine 可选 auto 或 generic');
    console.log(
        '执行方案：generic；' +
            (config.allowWrite ? '已启用写入' : '只读模式，不创建测试数据') +
            '；推理来源：' +
            config.provider,
    );
    if (config.language === 'auto')
        config.language = selected.some((c) => /[\u4e00-\u9fff]/.test(c.steps)) ? 'zh-CN' : 'en';
    if (config.manualLogin && config.headless) throw Error('手动登录需要可见浏览器');

    const modelWarmup = beginModelWarmup(laya, config);
    const { browser: opened, context, page, authRestored } = await openBrowser(config);
    browser = opened;
    activePage = page;
    const engine = new Engine(page, laya, config);
    await engine.navigate(config.url);
    const authStatus = await ensureAuthentication(
        page,
        config,
        secret,
        (name, kind) => engine.chooseTarget(name, kind),
        authRestored,
    );
    config.authenticated = authStatus !== 'not-required';
    await saveAuthState(context, page, config);
    await waitModelWarmup(modelWarmup);
    // Never record login/password entry in Playwright traces.
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    const results = [];
    // A login portal is not necessarily the module under test. Use only an
    // explicit, full menu path from the selected Excel, never an invented route.
    const entry = selected
        .flatMap((c) => lines(c.steps))
        .find((s) => {
            const d = describe(s);
            return d.verb === 'path' && d.path.length > 1;
        });
    if (entry) {
        console.log('进入Excel指定模块：' + entry);
        await engine.step(entry);
        config.url = page.url();
        console.log('本轮模块地址：' + config.url);
    }
    for (const [index, c] of selected.entries()) {
        console.log('RUN ' + c.id + ' ' + c.title);
        const r = await engine.runCase(c);
        results.push(r);
        console.log(r.status + ' ' + c.id + ' ' + r.reason.slice(0, 170));
        await report(results, laya, input.cases.length, input.warnings);
        if (
            [
                '页面资源加载失败',
                '页面尚未就绪',
                '登录会话失效',
                '环境接口故障',
                '模型API错误',
            ].includes(r.category)
        ) {
            console.log('页面、会话或模型服务故障，停止后续浏览器操作。');
            for (const pending of selected.slice(index + 1))
                results.push({
                    ...pending,
                    status: '未执行（会话中止）',
                    category: r.category,
                    reason: '前序用例遇到页面/会话故障，本条未尝试：' + r.reason,
                    actions: [],
                    assertions: [],
                    duration_ms: 0,
                    page_navigations: 0,
                });
            break;
        }
    }
    await context.tracing.stop({ path: path.join(config.out, 'trace.zip') });
    const summary = await report(results, laya, input.cases.length, input.warnings);
    console.log(
        'RESULT ' +
            JSON.stringify({
                directory: config.out,
                counts: summary.counts,
                metrics: summary.metrics,
            }),
    );
    process.exitCode = resultExitCode(results);
    laya.close();
    if (config.keepOpen && !config.headless) {
        console.log('浏览器保留，关闭窗口后退出。');
        await new Promise((resolve) => browser.on('disconnected', resolve));
    } else await browser.close();
}
main().catch(async (e) => {
    console.error('停止：' + e.message);
    await fs.mkdir(config.out, { recursive: true }).catch(() => {});
    await fs
        .writeFile(
            path.join(config.out, '启动失败.json'),
            JSON.stringify(
                { category: e.category || '启动失败', message: e.message, url: activePage?.url() },
                null,
                2,
            ),
        )
        .catch(() => {});
    if (activePage)
        await activePage
            .screenshot({ path: path.join(config.out, '启动失败.png') })
            .catch(() => {});
    laya?.close();
    await browser?.close().catch(() => {});
    process.exitCode = e.exitCode || 1;
});
