import assert from 'node:assert/strict';
import test from 'node:test';
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
