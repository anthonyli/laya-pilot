import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveNavigationMenu } from '../../scripts/lib/replay-navigation.mjs';
import { chromium } from 'playwright';
import {
    declaredIconName,
    findNamedIcon,
    iconOwner,
} from '../../scripts/lib/recorded-navigation.mjs';

test('waits for late SPA navigation icons and rejects duplicate visible matches', async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    const locate = () =>
        findNamedIcon(page, page.locator('nav'), 'Reports', iconOwner, declaredIconName, 3000);
    const icon = (name) =>
        `<button aria-label="${name}"><svg width="20" height="20"></svg></button>`;
    for (const existing of ['', icon('Overview')]) {
        await page.setContent(`<nav>${existing}</nav>`);
        await page.evaluate((markup) => {
            setTimeout(
                () => document.querySelector('nav').insertAdjacentHTML('beforeend', markup),
                350,
            );
        }, icon('Reports'));
        const target = await locate();
        assert.equal(await target.getAttribute('aria-label'), 'Reports');
        await target.dispose();
    }
    await page.setContent('<nav></nav>');
    await page.evaluate((markup) => {
        setTimeout(() => {
            document.querySelector('nav').innerHTML = markup;
        }, 350);
    }, icon('Reports').repeat(2));
    await assert.rejects(locate(), /找到 2 个匹配项/);
});

test('old recordings learn a tooltip icon and verify only that icon on later runs', async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-replay-menu-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const config = { credentialRoot: root, excel: 'recording.xlsx', assertTimeout: 1000 };
    const el = (token, label) =>
        `<button data-tip="${label}" style="cursor:pointer"><svg width="20" height="20" class="menu-icon-${token}"></svg></button>`;
    const reset = async (names) => {
        await page.setContent(
            `<nav>${names.map(([token, label]) => el(token, label)).join('')}</nav><div id=tip role=tooltip hidden></div>`,
        );
        await page.evaluate(() => {
            window.probed = [];
            const tip = document.querySelector('#tip');
            for (const el of document.querySelectorAll('button')) {
                el.onmouseenter = () => {
                    window.probed.push(el.dataset.tip);
                    tip.textContent = el.dataset.tip;
                    tip.hidden = false;
                };
                el.onmouseleave = () => {
                    tip.hidden = true;
                };
            }
        });
        await page.mouse.move(0, 0);
    };
    const model = {
        choose: () => {
            throw Error('exact replay called the model');
        },
    };
    const locate = () =>
        resolveNavigationMenu(page, page.locator('nav'), 'Reports', null, config, model, {});
    await reset([
        ['home', 'Home'],
        ['chart', 'Reports'],
        ['gear', 'Settings'],
    ]);
    let result = await locate();
    assert.equal(result.strategy, 'scan');
    assert.equal(await result.locator.getAttribute('data-tip'), 'Reports');
    await result.locator.dispose();

    await reset([
        ['gear', 'Settings'],
        ['home', 'Home'],
        ['chart', 'Reports'],
    ]);
    result = await locate();
    assert.equal(result.strategy, 'cached-icon');
    assert.equal(await result.locator.getAttribute('data-tip'), 'Reports');
    assert.deepEqual(await page.evaluate(() => window.probed), ['Reports']);
    await result.locator.dispose();

    await reset([
        ['chart', 'Home'],
        ['newchart', 'Reports'],
    ]);
    result = await locate();
    assert.equal(result.strategy, 'scan');
    assert.equal(await result.locator.getAttribute('data-tip'), 'Reports');
    await result.locator.dispose();
    result = await locate();
    assert.equal(result.strategy, 'cached-icon');
    await result.locator.dispose();
});

test('missing navigation names use Laya once within the sidebar and recheck the chosen target', async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent(
        '<button>Reports</button><nav><button>Overview</button><button>Reporting Center</button><button disabled>Old Reports</button></nav>',
    );
    const calls = [];
    let replace = false,
        uncertain = false;
    const model = {
        choose: async (_prompt, choices, meta) => {
            calls.push(meta.phase);
            assert.deepEqual(Object.keys(choices), ['Overview', 'Reporting Center', '停止']);
            if (replace)
                await page
                    .getByRole('button', { name: 'Reporting Center' })
                    .evaluate((el) => el.replaceWith(el.cloneNode(true)));
            return {
                choice: 'Reporting Center',
                probabilities: { 'Reporting Center': uncertain ? 0.51 : 0.97 },
                margin: uncertain ? 0.02 : 0.94,
            };
        },
    };
    const locate = (name) =>
        resolveNavigationMenu(
            page,
            page.locator('nav'),
            name,
            null,
            { assertTimeout: 500 },
            model,
            {},
        );
    let result = await locate('Overview');
    assert.equal(result.strategy, 'accessible-name');
    await result.locator.dispose();
    assert.deepEqual(calls, []);
    result = await locate('Reports');
    assert.equal(result.strategy, 'model');
    assert.equal(result.actual, 'Reporting Center');
    assert.equal(await result.locator.innerText(), 'Reporting Center');
    await result.locator.dispose();
    assert.deepEqual(calls, ['navigation-match']);
    uncertain = true;
    await assert.rejects(
        () => locate('Reports'),
        (error) => error.category === 'Laya选择不确定',
    );
    uncertain = false;
    replace = true;
    await assert.rejects(() => locate('Reports'), /发生变化/);
    await page.setContent('<nav><button>Reports</button><button>Reports</button></nav>');
    await assert.rejects(() => locate('Reports'), /多个同名/);
    assert.equal(calls.length, 3);
});
