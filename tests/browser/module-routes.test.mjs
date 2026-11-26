import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { Engine } from '../../scripts/lib/engine.mjs';
import { resolveModuleRoutes } from '../../scripts/lib/project-config.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));

async function fixture(t) {
    const visits = [];
    const server = http.createServer((req, res) => {
        visits.push(req.url);
        res.setHeader('content-type', 'text/html; charset=utf-8');
        const content = {
            '/': '<a href="/orders">订单列表</a>',
            '/orders': '<button>订单筛选</button>',
            '/refunds': '<h1>已进入退款列表</h1><button>退款筛选</button>',
            '/disabled': '<button disabled>退款列表</button>',
        }[req.url];
        if (!content) res.statusCode = 404;
        res.end(content || '<button>未找到</button>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        server.closeAllConnections();
        return new Promise((resolve) => server.close(resolve));
    });
    return { url: 'http://127.0.0.1:' + server.address().port, visits };
}

test('public CLI replays a URL-free Excel case using a visible menu then a configured destination', async (t) => {
    const { url, visits } = await fixture(t);
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-module-routes-'));
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));
    const python = process.env.LAYA_TEST_PYTHON || process.env.LAYA_PYTHON || 'python3';
    await exec(
        python,
        [
            '-c',
            `
from openpyxl import Workbook
w = Workbook()
s = w.active
s.title = "测试用例"
s.append(["用例编号","用例名称","前置条件","测试数据","测试步骤","预期结果"])
s.append(["001","验证跨模块","","","进入订单列表\\n进入「财务管理」 → 「退款列表」","页面显示「已进入退款列表」"])
w.save("legacy.xlsx")
`,
        ],
        { cwd },
    );
    await fs.writeFile(
        path.join(cwd, 'routes.json'),
        JSON.stringify({
            moduleRoutes: {
                订单列表: '/unused',
                '财务管理 → 退款列表': '/refunds',
            },
        }),
    );
    const env = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !/^(LAYA_|TEST_|BROWSER_)/.test(name)),
    );
    env.LAYA_ENTRY = 'cli';
    env.LAYA_HOME = path.join(cwd, 'state');
    env.PYTHONPATH = path.join(root, 'tests/fixtures/local-model');
    for (const [out, entry] of [
        ['cli', [path.join(root, 'bin/fa.mjs'), 'run', '--module-routes']],
        ['runner', [path.join(root, 'scripts/runner.mjs'), '--config']],
    ]) {
        await exec(
            process.execPath,
            [
                ...entry,
                'routes.json',
                '--excel',
                'legacy.xlsx',
                '--url',
                url,
                '--out',
                out,
                '--python',
                python,
                '--provider',
                'local',
                '--lazy-model',
                '--headless',
                '--delay',
                '0',
            ],
            { cwd, env },
        ).catch((error) => assert.fail(error.stdout + '\n' + error.stderr));
        const { results } = JSON.parse(await fs.readFile(path.join(cwd, out, 'results.json')));
        assert.equal(results[0].status, '通过');
        assert.deepEqual(
            results[0].actions
                .filter((a) => ['module-route', 'path'].includes(a.action))
                .map((a) => a.action),
            ['path', 'module-route'],
        );
    }
    assert.ok(visits.indexOf('/refunds') > visits.indexOf('/orders'));
    assert.ok(!visits.includes('/unused'));
});

test('a mapping does not replace failed assertions, disabled menus, or an unavailable destination', async (t) => {
    const { url, visits } = await fixture(t);
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    const engine = new Engine(
        page,
        { choose: async () => ({ choice: '停止' }) },
        {
            url,
            origins: [url],
            moduleRoutes: resolveModuleRoutes(
                { 退款列表: '/refunds', 未上线: '/unavailable' },
                url,
            ),
            maxSteps: 30,
            pageTimeout: 2000,
            assertTimeout: 50,
            delay: 0,
        },
    );
    await page.goto(url);
    assert.equal((await engine.verify('页面显示「退款列表」')).status, '失败');
    await assert.rejects(engine.step('点击「退款列表」'), { category: 'Laya无法判断' });
    await assert.rejects(engine.step('进入未配置的模块'), { category: 'Laya无法判断' });
    await assert.rejects(engine.checkPrecondition('已拥有退款列表菜单权限', {}), {
        category: '前置条件未验证',
    });
    await page.goto(url + '/disabled');
    await assert.rejects(engine.step('进入退款列表'), { category: '菜单不可用' });
    assert.ok(!visits.includes('/refunds'));
    await assert.rejects(engine.step('进入未上线'), { category: '模块页面未到达' });
});
