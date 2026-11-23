import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { ensureAuthentication } from '../../scripts/lib/auth-state.mjs';
import { saveLoginCredentials, loadLoginCredentials } from '../../scripts/lib/credentials.mjs';

const loginUrl = 'http://account.example.test/login';
const gateway = 'http://identity.example.test/login';
const form = `<label>Account<input name="user"></label><label>Password<input type="password"></label><button type="submit">Login</button>`;
const html = (body) => ({ contentType: 'text/html', body });
const config = { url: loginUrl, user: 'test-login', language: 'none', pageTimeout: 1500 };

test('a login form with a different submission origin is rejected before any fields are filled', async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.route(loginUrl, (route) =>
        route.fulfill(html(`<form action="${gateway}">${form}</form>`)),
    );
    await page.goto(loginUrl);
    await assert.rejects(
        ensureAuthentication(page, config, () => randomUUID(), null, false),
        /自动登录未成功/,
    );
    assert.equal(await page.getByLabel('Account').inputValue(), '');
    assert.equal(await page.getByLabel('Password').inputValue(), '');
});

test('an identity provider change during account entry does not receive the previous site password', async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.route(loginUrl, (route) =>
        route.fulfill(
            html(
                `<form>${form}</form><script>document.querySelector('[name=user]').oninput=()=>location.assign('${gateway}');</script>`,
            ),
        ),
    );
    await page.route(gateway, (route) => route.fulfill(html(`<form>${form}</form>`)));
    await page.goto(loginUrl);
    await assert.rejects(
        ensureAuthentication(page, config, () => randomUUID(), null, false),
        /自动登录未成功/,
    );
    await page.waitForURL(gateway);
    assert.equal(await page.getByLabel('Password').inputValue(), '');
});

test('an explicit rotated password overrides stored credentials and is written after verified login', async (t) => {
    const credentialRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-password-rotation-'));
    t.after(() => fs.rm(credentialRoot, { recursive: true, force: true }));
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    const previous = randomUUID(),
        current = randomUUID();
    const landingUrl = new URL('/app', loginUrl).href;
    await saveLoginCredentials(credentialRoot, loginUrl, config.user, {
        password: previous,
        loginUrl,
        landingUrl,
        check: '#verified',
    });
    await page.route(loginUrl, (route) =>
        route.fulfill(
            html(`<form>${form}</form><script>
        const submit=document.querySelector('button');
        submit.remove();
        document.querySelector('input[type=password]').oninput=()=>document.querySelector('form').append(submit);
        document.querySelector('form').onsubmit=event=>{
        event.preventDefault();
        if (document.querySelector('input[type=password]').value === ${JSON.stringify(current)}) location.assign('/app');
    };</script>`),
        ),
    );
    await page.route(landingUrl, (route) =>
        route.fulfill(html('<button id="verified">Signed in</button>')),
    );
    await page.goto(loginUrl);
    let reads = 0;
    const result = await ensureAuthentication(
        page,
        {
            ...config,
            url: landingUrl,
            authState: 'test',
            authCheck: '#verified',
            credentialRoot,
            preferPassword: true,
        },
        () => {
            reads++;
            return current;
        },
        null,
        false,
    );
    assert.equal(result, 'logged-in');
    assert.equal(reads, 1);
    assert.ok(
        (await loadLoginCredentials(credentialRoot, loginUrl, config.user)).password === current,
    );
});
