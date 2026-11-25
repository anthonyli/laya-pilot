import { loadUiAdapter, validateUiAdapterSelectors } from './lib/ui-adapters.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Laya, beginModelWarmup, waitModelWarmup } from './lib/model.mjs';
import { resultExitCode } from './lib/run-state.mjs';
import {
    ensureAuthentication,
    saveAuthState,
    captureFailureScreenshot,
} from './lib/auth-state.mjs';
import {
    BrowserDiagnostics,
    eventLabel,
    registerSecret,
    safeText,
    safeUrl,
} from './lib/diagnostics.mjs';
import { authRoute, findRecordingAuth, rememberRecordingAuth } from './lib/recording-auth.mjs';
import { openBrowser } from './lib/browser-provider.mjs';
import { assessNavigationHealth, restoreNavigationDestinations } from './lib/recording-cases.mjs';
import {
    loadLocalEnvironment,
    loadProjectConfig,
    configured,
    configuredFlag,
    environmentData,
} from './lib/project-config.mjs';
import { Engine } from './lib/engine.mjs';
import { describe, expectation, lines } from './lib/language.mjs';
import { validateControlBindings } from './lib/control-bindings.mjs';
import { settle } from './lib/dom.mjs';
import { dataRoot, venvPython } from './lib/entry.mjs';
import { RUN_FILES, logFile, uniqueRunDirectory } from './lib/run-layout.mjs';
import { finalizeRun, writeCaseWorkbook } from './lib/run-index.mjs';
import { CaseTraces } from './lib/case-trace.mjs';
import { inspectCase, compileExpectation } from './lib/case-diagnostics.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    args = process.argv.slice(2);
const arg = (n, d) => {
    const i = args.indexOf(n);
    if (i < 0) return d;
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(n + '缺少参数');
    return args[i + 1];
};
const flag = (n) => args.includes(n);
await loadLocalEnvironment(dataRoot);
const fileConfig = await loadProjectConfig(arg('--config', ''));
const option = (cli, env, key, fallback) => configured(arg, cli, env, fileConfig[key], fallback);
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const config = {
    credentialRoot: dataRoot,
    url: option('--url', 'TEST_URL', 'url', ''),
    excel: option('--excel', 'TEST_EXCEL', 'excel', ''),
    user: option('--user', 'TEST_USER', 'user', ''),
    python: option('--python', 'LAYA_PYTHON', 'python', venvPython),
    model: option('--model', 'LAYA_MODEL', 'model', 'convaiinnovations/laya-multilingual'),
    provider: option('--provider', 'LAYA_PROVIDER', 'provider', 'local'),
    lazyModel: configuredFlag(args, '--lazy-model', 'LAYA_LAZY_MODEL', fileConfig.lazyModel),
    apiBase: option('--api-base', 'LAYA_API_BASE', 'apiBase', ''),
    apiModel: option('--api-model', 'LAYA_API_MODEL', 'apiModel', 'laya-decision'),
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
        'TEST_AUTH_SESSION_STORAGE',
        fileConfig.authSessionStorage,
    ),
    operations: option('--operations', 'TEST_OPERATIONS', 'operations', ''),
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
    data: arg('--data', '') ? {} : environmentData(fileConfig.data || {}),
    runId,
    out: path.resolve(
        option(
            '--out',
            'TEST_OUTPUT',
            'out',
            uniqueRunDirectory(path.join(process.cwd(), 'runs', 'laya-pilot')),
        ),
    ),
};
config.preferPassword = Boolean(config.user && process.env.TEST_PASSWORD);

async function secret(label = '登录密码', envName = 'TEST_PASSWORD') {
    if (process.env[envName]) return registerSecret(process.env[envName]);
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
                    resolve(registerSecret(value));
                    return;
                }
                if (c === '\u007f') value = value.slice(0, -1);
                else value += c;
            }
        };
        process.stdin.on('data', on);
    });
}
async function report(results, laya, source, warnings) {
    const counts = {};
    for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
    const actual = laya.records.filter((r) => !r.cache_hit),
        times = actual.map((x) => x.inference_ms).sort((a, b) => a - b);
    const summary = {
        source,
        input: path.basename(config.excel),
        url: safeUrl(config.url),
        selection: config.selection,
        workbookFormat: 'natural-language',
        ...(config.reviewPlan ? { reviewPlan: config.reviewPlan } : {}),
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
    await fs.writeFile(path.join(config.out, RUN_FILES.results), JSON.stringify(summary, null, 2));
    await writeCaseWorkbook(config.out, summary, config.python);
    const clean = (s) => String(s).replace(/[|\n\r]/g, ' ');
    let md = `# 通用版执行结果\n\n输入：${path.basename(config.excel)}；可见浏览器：${!config.headless}；推理来源：${config.provider}。\n\n${Object.entries(
        counts,
    )
        .map(([k, v]) => k + ' ' + v)
        .join(
            '，',
        )}。通过要求步骤完整执行且全部预期有明确断言；跳过不计通过。\n\n|编号|用例|结果|原因|截图|\n|---|---|---|---|---|\n`;
    for (const r of results)
        md += `|${clean(r.id)}|${clean(r.title)}|${r.status}|${clean(r.reason)}${r.screenshot_error ? '；' + clean(r.screenshot_error) : ''}|${r.screenshot ? `[截图](${r.screenshot})` : ''}|\n`;
    if (results.some((r) => r.health_checks?.length)) {
        md += '\n## 执行环境与错误检查\n\n';
        md += '|用例|观察项|状态|证据|\n|---|---|---|---|\n';
        for (const r of results)
            for (const check of r.health_checks || [])
                md += `|${clean(r.id)}|${clean(check.text)}|${check.status}|${clean(check.reason)}|\n`;
        for (const r of results)
            for (const event of r.browser_events || [])
                md += `\n- ${clean(r.id)}${event.step ? ` 第 ${event.step.index} 步` : ''} ${clean(eventLabel(event))}\n`;
        md += `\n本次 Laya 模型实际调用 ${summary.metrics.model_calls} 次，缓存命中 ${summary.metrics.cache_hits} 次。\n`;
    }
    md +=
        '\n## 步骤与断言证据\n\n每张图是对应步骤或断言结束时的页面快照；动作完成不等于业务断言通过。未完成步骤的图仅表示停止现场。\n';
    for (const r of results) {
        if (!r.evidence?.length) continue;
        md += `\n### ${clean(r.sheet)} / 第${r.row}行 / ${clean(r.id)} ${clean(r.title)}\n\n`;
        md += '|序号|阶段|原文|范围|状态|采集时间|截图|\n|---|---|---|---|---|---|---|\n';
        for (const e of r.evidence)
            md += `|${e.sequence}|${e.phase === 'step' ? '步骤' : '预期'} ${e.index}|${clean(e.text)}|${clean(e.scope ?? '')}|${clean(e.status)}|${clean(e.at)}|${e.screenshot ? `[截图](${e.screenshot})` : clean(e.screenshot_error || '未采集')}|\n`;
    }
    const diagnosticsOf = (r) =>
        (r.input_diagnostics || []).filter((d) => d.code !== 'needs-live-target');
    if (results.some((r) => diagnosticsOf(r).length))
        md += '\n## 用例可执行性诊断\n\n诊断保留原业务意图；语法可解释不代表页面或测试通过。\n';
    for (const r of results) {
        for (const d of diagnosticsOf(r)) {
            md += `\n- ${clean(r.sheet)} 第${r.row}行 / ${clean(r.id)} / ${d.field} ${d.index}${d.clause ? ' 子句' + d.clause : ''}：${clean(d.text ?? '')}；${clean(d.message)}；${clean(d.suggestion)}\n`;
        }
    }
    if (
        results.some(
            (r) => r.unidentified_controls?.length || r.control_binding_diagnostics?.length,
        )
    )
        md +=
            '\n## 未识别控件与绑定诊断\n\n已发现但无可靠语义的控件不能按位置猜测操作。下列信息对应每条用例结束时的页面，结合该用例目录中的截图和 controls.json 复核。\n';
    for (const r of results) {
        for (const c of r.unidentified_controls || [])
            md += `\n- ${clean(r.id)}：frame ${c.frame} / ${clean(c.tag)} / ${clean(c.role)} / id=${clean(c.elementId)} / 行=${clean(c.rowKey)} / 上下文=${clean(c.context)}；${clean(c.suggestion)}\n`;
        for (const d of r.control_binding_diagnostics || [])
            md += `\n- ${clean(r.id)}：绑定 ${clean(d.name)} / ${clean(d.selector)}：${clean(d.code)}，本次没有应用该绑定。\n`;
    }
    await fs.writeFile(path.join(config.out, RUN_FILES.summary), md);
    return summary;
}
let laya, browser, activePage;
async function main() {
    if (flag('--help')) {
        console.log(
            'LayaPilot · 用例回归\n执行：node scripts/runner.mjs --excel 用例.xlsx --url 页面地址 --headless；自动识别普通用例或结构化计划\n检查：node scripts/runner.mjs --excel 用例.xlsx --inspect\n生成：node scripts/runner.mjs --mode generate --url 页面地址 [--template-excel 模板.xlsx] [--case-file 用例.xlsx]\n旧命令兼容：node scripts/runner.mjs --mode execute --case-file 用例.xlsx [--url 页面地址]\n--allow-write：允许已授权的写操作；--cases：仅普通Excel编号筛选。\n--config 配置.json；--provider local|api；--browser-provider playwright；--browser-channel chrome|chromium；--headless。API地址和模型名称需自行配置，密钥由LAYA_API_KEY或隐藏输入提供。',
        );
        console.log(
            '--auth-state 文件：保存/复用登录态；--auth-reset：重新登录；--auth-check CSS：登录成功标记；--auth-session-storage：保存当前站点 sessionStorage',
        );
        console.log(
            '--excel 自动识别工作簿并默认执行全部用例，不按历史结果或类型筛选；普通Excel可用--cases指定编号。',
        );
        console.log(
            '--operations tabs,tab-switch,table,filters,form-validation,form-invalid,create,search,view,edit,delete,discover；discover：模板完成后由模型选择补充测试；--read-only：只读检查；--data JSON文件：明确覆盖字段值',
        );
        console.log(
            '本地模型默认启动预热，与浏览器准备并行；--lazy-model 改为按需加载。退出码：0 全部选中用例通过（不适用除外），1 失败/阻断/无用例，130 SIGINT，143 SIGTERM。',
        );
        return;
    }
    if (arg('--mode', '') === 'plan') {
        const { createReviewPlan } = await import('./lib/review-plan.mjs');
        await createReviewPlan(args);
        return;
    }
    if (arg('--plan-source', '')) throw Error('--plan-source 需要 --mode plan');
    let review;
    if (arg('--mode', '') === 'reviewed') {
        const { loadReviewedPlan } = await import('./lib/review-plan.mjs');
        review = await loadReviewedPlan(args, config.dryRun);
        config.url = review.plan.url;
        config.allowWrite = review.plan.allowWrite;
        config.readOnly = !review.plan.allowWrite;
        config.data = {};
        config.operations = '';
        config.excel = '';
        config.reviewPlan = {
            sha256: review.sha256,
            url: review.plan.url,
            allowWrite: review.plan.allowWrite,
            status: config.dryRun ? 'inspected-unverified' : 'approved-for-execution',
        };
    }
    if (arg('--review-plan', '') && !review) throw Error('--review-plan 需要 --mode reviewed');
    if (arg('--approved-hash', '') && !review) throw Error('--approved-hash 需要 --mode reviewed');
    if (!config.excel && !arg('--mode', '')) throw Error('请通过--excel指定用例文件');
    if (!['local', 'api'].includes(config.provider))
        throw Error('--provider仅支持local或api，默认local');
    if (config.provider === 'api' && !config.dryRun && (!config.apiBase || !config.apiModel))
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
    config.uiAdapters = await loadUiAdapter(arg('--ui-adapter', ''));
    if (arg('--control-bindings', ''))
        config.controlBindings = validateControlBindings(
            JSON.parse(await fs.readFile(arg('--control-bindings', ''), 'utf8')),
        );
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
    if (review) {
        const { materializeReviewedPlan } = await import('./lib/review-plan.mjs');
        config.excel = await materializeReviewedPlan(review, config.python, config.out);
        await fs.writeFile(
            logFile(config.out, 'review-plan-approval.json'),
            JSON.stringify(config.reviewPlan, null, 2),
        );
    }
    let workflowMode = review ? '' : arg('--mode', '');
    if (!workflowMode && config.excel) {
        const { workbookCommand } = await import('./lib/workflow.mjs');
        const detected = await workbookCommand(config, 'detect', {
            path: path.resolve(config.excel),
        });
        if (detected.format === 'structured') {
            workflowMode = 'execute';
            config.unifiedExecution = true;
        }
    }
    if (workflowMode) {
        if (config.controlBindings)
            throw Error('--control-bindings 当前只用于普通 Excel 回归；结构化生成/重放需专项适配');
        config.caseFile = config.unifiedExecution
            ? config.excel
            : option('--case-file', 'TEST_CASE_FILE', 'caseFile', '');
        config.templateExcel = option(
            '--template-excel',
            'TEST_TEMPLATE_EXCEL',
            'templateExcel',
            '',
        );
        const { runWorkflow, inspectReplay } = await import('./lib/workflow.mjs');
        if (config.dryRun) {
            if (workflowMode !== 'execute') throw Error('--inspect 只用于检查已有用例文件');
            await inspectReplay(config);
            return;
        }
        const summary = await runWorkflow(config, workflowMode, secret, ROOT);
        await finalizeRun(config.out);
        process.exitCode = summary.exitCode;
        return summary;
    }
    if (config.operations) throw Error('--operations 只适用于生成或带结构化计划的工作簿');
    await fs.mkdir(config.out, { recursive: true });
    let apiKey =
        config.provider === 'api' && !config.dryRun
            ? await secret('API密钥', 'LAYA_API_KEY')
            : undefined;
    laya = new Laya(
        config.python,
        path.join(ROOT, 'scripts', 'worker.py'),
        config.model,
        logFile(config.out, 'decisions.ndjson'),
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
    input.cases = restoreNavigationDestinations(input.cases, config.url);
    const selected = input.cases.filter(
        (c) =>
            !config.cases.length ||
            config.cases.some((x) => x === c.id || x.padStart(3, '0') === c.id || x === c.key),
    );
    config.selection = {
        only_source_pass: false,
        total: input.cases.length,
        eligible: input.cases.length,
        selected: selected.length,
        excluded: [],
    };
    await fs.writeFile(
        logFile(config.out, 'selection.json'),
        JSON.stringify(config.selection, null, 2),
    );
    if (!selected.length) throw Error('没有匹配的用例编号，请检查 --cases 指定的范围');
    const inspection = selected.map((c) => ({
        id: c.id,
        key: c.key,
        title: c.title,
        preconditions: c.preconditions,
        steps: lines(c.steps).map((text) => ({ text, ...describe(text) })),
        expected: lines(c.expected).map((text) => {
            const assertions = compileExpectation(text);
            return assertions.length > 1
                ? { text, kind: 'conjunction', assertions }
                : { text, ...expectation(text) };
        }),
        sheet: c.sheet,
        row: c.row,
        ...inspectCase(c, config.data),
    }));
    await fs.writeFile(
        logFile(config.out, 'excel-inspection.json'),
        JSON.stringify(
            { workbookFormat: 'natural-language', warnings: input.warnings, cases: inspection },
            null,
            2,
        ),
    );
    console.log(`读取${input.cases.length}条，本轮${selected.length}条。`);

    if (config.dryRun) {
        console.log('Excel检查结果：' + logFile(config.out, 'excel-inspection.json'));
        if (config.reviewPlan) console.log('REVIEW_PLAN ' + JSON.stringify(config.reviewPlan));
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

    const sceneFor = (c) => {
        try {
            return JSON.parse(c.data || '{}').recordedScene;
        } catch {
            return null;
        }
    };
    const accounts = new Set(selected.map((c) => sceneFor(c)?.account).filter(Boolean));
    if (accounts.size > 1 || (accounts.size && config.user && !accounts.has(config.user)))
        throw Error('本次用例的录制账号与所选账号不一致，请选择同一账号的用例。');
    const recordedAccount = [...accounts][0];
    config.authAccount ||= config.user || recordedAccount;
    const requestedUrl = config.url;
    const managed =
        !config.authState &&
        !config.authReset &&
        (await findRecordingAuth(dataRoot, requestedUrl, config.user || recordedAccount));
    if (managed) {
        console.log('AUTH 已找到此站点和账号的登录态，正在验证：' + managed.authState);
        config.authState = managed.authState;
        config.authAccount = managed.account;
        config.authCheck ||= managed.info.check;
        config.authSessionStorage = true;
        config.recordedLogin = managed.info;
        config.url = managed.info.landingUrl;
    }
    const modelWarmup = beginModelWarmup(laya, config);
    const { browser: opened, context, page, authRestored } = await openBrowser(config);
    browser = opened;
    activePage = page;
    await validateUiAdapterSelectors(page, config.uiAdapters);
    const engine = new Engine(
        page,
        laya,
        config,
        new BrowserDiagnostics(context, { checkBusinessResponses: true }),
    );
    await engine.navigate(config.url);
    const authStatus = await ensureAuthentication(
        page,
        config,
        secret,
        (name, kind) => engine.chooseTarget(name, kind),
        authRestored,
    );
    config.authenticated = authStatus !== 'not-required';
    if (config.authState) await saveAuthState(context, page, config);
    else if (authStatus === 'logged-in' && (config.authAccount || config.user)) {
        const saved = await rememberRecordingAuth(
            dataRoot,
            context,
            page,
            { url: requestedUrl, account: config.authAccount || config.user },
            config.authCheck,
        );
        console.log(saved ? 'AUTH 已保存此站点和账号的登录态。' : 'AUTH 未验证到可复用的登录态。');
    }
    if (config.recordedLogin && authRoute(requestedUrl) !== config.recordedLogin.loginUrl) {
        config.url = requestedUrl;
        await engine.navigate(config.url);
    }
    await waitModelWarmup(modelWarmup);
    // Traces start per case, after login: never record login/password entry.
    const traces = new CaseTraces(context, config.out);
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
        const scene = sceneFor(c);
        const previous = results.at(-1);
        const followsPrevious = !!scene?.previous && previous?.id === scene.previous;
        let r;
        if (scene?.kind === 'login' && config.authenticated) {
            r = {
                ...c,
                status: '不适用',
                category: '已在回放前认证',
                reason: '本轮已验证登录态，未重复执行录制的登录操作。',
                actions: [],
                assertions: [],
                duration_ms: 0,
                page_navigations: 0,
            };
        } else if (
            followsPrevious &&
            !previous.stepsCompleted &&
            previous.category !== '已在回放前认证'
        ) {
            r = {
                ...c,
                status: '未执行',
                category: '前序场景未完成',
                reason: `尚未完成 ${previous.id}，无法从录制时的页面状态继续。`,
                actions: [],
                assertions: [],
                duration_ms: 0,
                page_navigations: 0,
            };
        } else {
            await traces.begin();
            const startUrl =
                scene?.url &&
                URL.canParse(scene.url) &&
                new URL(scene.url).origin === new URL(config.url).origin
                    ? scene.url
                    : c.url;
            r = await engine.runCase(
                { ...c, url: startUrl },
                {
                    continueRecording: followsPrevious,
                    useRecordedStepCount: Boolean(scene?.kind) && !flag('--max-steps'),
                },
            );
            assessNavigationHealth(c, r);
            await traces.end(r, r.evidence_dir);
        }
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
    await traces.stop();
    const summary = await report(results, laya, input.cases.length, input.warnings);
    await finalizeRun(config.out);
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
    const errorMessage = safeText(e.message, 1200);
    console.error('停止：' + errorMessage);
    await fs.mkdir(config.out, { recursive: true }).catch(() => {});
    const screenshot = 'run/startup-failure.png';
    const captured = await captureFailureScreenshot(activePage, path.join(config.out, screenshot));
    // Keep a results.json so readers and index.html can explain why nothing ran.
    const hasResults = await fs.access(path.join(config.out, RUN_FILES.results)).then(
        () => true,
        () => false,
    );
    if (!hasResults)
        await fs
            .writeFile(
                path.join(config.out, RUN_FILES.results),
                JSON.stringify(
                    {
                        source: config.excel ? path.basename(config.excel) : null,
                        runStatus: 'failed',
                        error: {
                            category: e.category || '启动失败',
                            message: errorMessage,
                            url: activePage ? safeUrl(activePage.url()) : null,
                            screenshot: captured ? screenshot : null,
                        },
                        counts: {},
                        results: [],
                    },
                    null,
                    2,
                ),
            )
            .catch(() => {});
    await finalizeRun(config.out).catch(() => {});
    laya?.close();
    await browser?.close().catch(() => {});
    process.exitCode = e.exitCode || 1;
});
