import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../scripts/lib/engine.mjs';
import { chromium } from 'playwright';
import { BrowserDiagnostics, HEALTH_EXPECTATIONS } from '../../scripts/lib/diagnostics.mjs';
import { expectation, lines } from '../../scripts/lib/language.mjs';
import { verifyRecordedDestination } from '../../scripts/lib/recorded-destination.mjs';
import {
    assessNavigationHealth,
    restoreNavigationDestinations,
} from '../../scripts/lib/recording-cases.mjs';

test('uses the exact recorded destination and observed area selection before classifying background read errors', async (t) => {
    const origin = 'http://navigation.test';
    const url = origin + '/metrics?mode=real&sort=name#configuration';
    const entry = origin + '/dashboard';
    const [nav] = restoreNavigationDestinations(
        [
            {
                id: 'REC-001',
                data: JSON.stringify({ recordedScene: { kind: 'navigate', url: entry } }),
                steps: [
                    `打开网址 ${entry}`,
                    '点击「Realtime Indicator」链接',
                    '切换到「Edit Area」区域',
                ].join('\n'),
                expected: [
                    ...Object.values(HEALTH_EXPECTATIONS),
                    '业务结果待补充（录制时未设置预期）',
                ].join('\n'),
            },
            {
                id: 'REC-002',
                data: JSON.stringify({
                    recordedScene: { kind: 'create', previous: 'REC-001', url },
                }),
            },
        ],
        entry,
    );
    const destinations = lines(nav.expected).filter((text) =>
        expectation(text).kind.startsWith('navigation-'),
    );
    assert.deepEqual(destinations, [`已到达录制页面「${url}」`, '已选中录制区域「Edit Area」']);
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const context = await browser.newContext();
    const diagnostics = new BrowserDiagnostics(context, { checkBusinessResponses: true });
    const page = await context.newPage();
    await page.route('**/*', (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.startsWith('/api/'))
            return route.fulfill({
                status: 200,
                json:
                    path === '/api/auth'
                        ? { code: 401, message: 'Unauthorized' }
                        : { code: 400001, message: 'No data' },
            });
        return route.fulfill({
            contentType: 'text/html',
            body: '<button role="tab" aria-selected="true">Edit Area</button>',
        });
    });
    const verify = (text) => verifyRecordedDestination(page, text, expectation(text), 150);
    await page.goto(url);
    const location = await verify(destinations[0]);
    const selected = await verify(destinations[1]);
    assert.equal(location.status, '通过');
    assert.equal(selected.status, '通过');
    await page.evaluate(() => history.replaceState({}, '', '?sort=name&mode=real#configuration'));
    assert.equal((await verify(destinations[0])).status, '通过');
    for (const other of [
        '/metrics-other?mode=real&sort=name#configuration',
        '/metrics?mode=demo&sort=name#configuration',
        '/metrics?mode=real&sort=name#summary',
    ]) {
        await page.evaluate((path) => history.replaceState({}, '', path), other);
        assert.equal((await verify(destinations[0])).status, '失败');
    }
    await page.goto(url);
    await page.getByRole('tab').evaluate((el) => el.setAttribute('aria-selected', 'false'));
    const inactive = await verify(destinations[1]);
    assert.equal(inactive.status, '失败');
    await page.getByRole('tab').evaluate((el) => el.remove());
    const absent = await verify(destinations[1]);
    assert.equal(absent.status, '未验证');

    async function checkRead(method, path, area) {
        diagnostics.begin('REC-001');
        await page.evaluate(async ({ method, path }) => (await fetch(path, { method })).json(), {
            method,
            path,
        });
        const events = await diagnostics.end();
        assert.equal(events.length, 1);
        assert.equal(events[0].kind, 'api-body');
        assert.equal(events[0].status, 200);
        const check = {
            text: HEALTH_EXPECTATIONS.api,
            kind: 'api',
            status: '失败',
            reason: events[0].detail,
        };
        const result = {
            status: '失败',
            stepsCompleted: true,
            assertions: [location, area, { ...check }],
            health_checks: [check],
            browser_events: events,
        };
        assessNavigationHealth(nav, result);
        return result;
    }
    const passed = await checkRead('GET', '/api/config', selected);
    assert.equal(passed.status, '通过');
    assert.equal(passed.health_checks[0].status, '提示');
    assert.equal(passed.browser_events[0].severity, 'info');
    assert.match(passed.browser_events[0].detail, /No data/);
    for (const [method, path, area] of [
        ['GET', '/api/config', inactive],
        ['GET', '/api/config', absent],
        ['POST', '/api/config', selected],
        ['GET', '/api/auth', selected],
    ]) {
        const result = await checkRead(method, path, area);
        assert.equal(result.status, '失败');
        assert.equal(result.health_checks[0].status, '失败');
        assert.notEqual(result.browser_events[0].severity, 'info');
    }
});

test('verified deep links skip entry clicks and an app requiring menu state replays them', async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-entry-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const base = 'http://business.test',
        start = base + '/home',
        url = base + '/reports';
    for (const mode of ['direct', 'menu-state']) {
        const ctx = await browser.newContext();
        try {
            const page = await ctx.newPage();
            const visits = [];
            page.on('request', (req) => {
                if (req.isNavigationRequest()) visits.push(new URL(req.url()).pathname);
            });
            await page.route(base + '/**', (route) =>
                route.fulfill({
                    contentType: 'text/html',
                    body:
                        new URL(route.request().url()).pathname === '/home'
                            ? '<nav><a href="/reports" onclick="sessionStorage.followed=1">Reports</a></nav>'
                            : '<h1>Reports</h1><div id="tab" role="tab" aria-selected="true">Edit</div><script>if (' +
                              JSON.stringify(mode) +
                              '==="menu-state"&&!sessionStorage.followed) document.querySelector("#tab").remove()</script>',
                }),
            );
            const e = new Engine(page, null, {
                url: start,
                origins: [base],
                out: root,
                delay: 0,
                confirmedDelay: 0,
                assertTimeout: 250,
                maxSteps: 10,
            });
            const prefix = ['点击「Reports」链接'];
            const c = {
                id: 'NAV',
                title: '进页',
                steps: prefix.concat('切换到「Edit」区域').join('\n'),
                expected: '页面显示「Reports」',
                data: '{}',
                url: start,
            };
            const result = await e.runCase(c, {
                businessEntry: { url, prefix, anchor: 'Edit', roles: ['tab'], resetAtEntry: true },
            });
            assert.equal(result.status, '通过', result.reason);
            const direct = mode === 'direct';
            assert.deepEqual(visits, direct ? ['/reports'] : ['/reports', '/home', '/reports']);
            assert.equal(
                result.actions.some((x) => x.action === 'direct-entry'),
                direct,
            );
            assert.equal(
                result.actions.some((x) => x.action === 'entry-fallback'),
                !direct,
            );
            assert.equal(
                result.actions.some((x) => x.action === 'click' && x.control.name === 'Reports'),
                !direct,
            );
            assert.ok(
                result.actions.some((x) => x.action === 'click' && x.control.name === 'Edit'),
            );
            assert.equal(
                await page.evaluate(() => sessionStorage.followed),
                direct ? undefined : '1',
            );
        } finally {
            await ctx.close();
        }
    }
});
