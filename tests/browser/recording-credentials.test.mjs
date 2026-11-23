import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { loadLoginCredentials } from '../../scripts/lib/credentials.mjs';
import { captureRecording } from '../../scripts/lib/recording-capture.mjs';
import { findRecordingAuth } from '../../scripts/lib/recording-auth.mjs';
import { generateRecordedCases } from '../../scripts/lib/recording-cases.mjs';
import { renderRecordingSpec } from '../../scripts/lib/recording-spec.mjs';

test('commit an autofilled login with Enter, preserve the password on rejection and exclude one-time codes', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-captured-login-'));
    t.after(() => fs.rm(root, { force: true, recursive: true }));
    const server = http.createServer((req, res) => {
        const screen = new URL(req.url, 'http://localhost').pathname;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        if (screen === '/desk') return res.end('<h1>Dashboard</h1>');
        if (screen === '/login-revealed')
            return res.end(`<form class="ant-form ant-form-tntd ant-form-horizontal">
            <input type="text" id="account" placeholder="Enter the login account">
            <input type="password" id="password" placeholder="Enter the password">
            <span aria-label="Show password" onclick="document.querySelector('#password').type='text'">Eye</span>
            <button type="button" class="ant-btn submit tnt-btn ant-btn-primary ant-btn-lg"
             onclick="if(document.querySelector('#password').value==='rejected-value') {document.querySelector('h1').hidden=false; return} document.cookie='session=fixture;path=/';location.href='/desk'"><span>Login</span></button>
            <h1 hidden>Attention needed</h1></form>`);
        const otp = screen === '/login-otp';
        res.end(`<form onsubmit="event.preventDefault(); if (this.elements.secret.value==='rejected-value') {document.querySelector('[role=alert]').textContent='Invalid credentials'; return} document.cookie='session=fixture;path=/'; location.href='/desk'">
          <input autocomplete="username" aria-label="Account">
          <input type="password" name="secret" placeholder="${otp ? 'One-time code' : 'Password'}" autocomplete="${otp ? 'one-time-code' : 'current-password'}">
          <button>Sign in</button><span role="alert"></span></form>`);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        server.closeAllConnections();
        return new Promise((resolve) => server.close(resolve));
    });
    const origin = 'http://127.0.0.1:' + server.address().port;
    const account = 'fixture-user';
    const first = 'autofilled-test-value';
    const otp = '492761';
    const run = (url, onReady) =>
        captureRecording({
            url,
            authRoot: root,
            authReset: true,
            authCheck: 'h1',
            headless: true,
            playwright: { chromium },
            onReady,
        });
    async function submit(page, value, success) {
        // Password managers may populate the inputs without firing input or change.
        await page.getByLabel('Account').evaluate((el, val) => {
            el.value = val;
        }, account);
        const field = page.locator('input[type=password]');
        await field.evaluate((el, val) => {
            el.value = val;
        }, value);
        await field.press('Enter');
        if (success) await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
        else await page.getByRole('alert').getByText('Invalid credentials').waitFor();
        await page.getByRole('button', { name: '完成录制' }).click();
    }
    const url = origin + '/login';
    const recorded = await run(url, (page) => submit(page, first, true));
    const saved = await loadLoginCredentials(root, url, account);
    assert.equal(saved.password, first);
    assert.deepEqual(saved.recipe, {
        account: { kind: 'label', name: 'Account' },
        password: { kind: 'placeholder', name: 'Password' },
        submit: { kind: 'role', name: 'Sign in', role: 'button' },
    });
    const rejected = await run(url, (page) => submit(page, 'rejected-value', false));
    assert.equal((await loadLoginCredentials(root, url, account)).password, first);
    const otpLogin = await run(origin + '/login-otp', (page) => submit(page, otp, true));
    assert.equal((await loadLoginCredentials(root, url, account)).password, first);
    async function revealed(value, success) {
        return run(origin + '/login-revealed', async (page) => {
            await page.getByPlaceholder('Enter the login account').fill(account);
            await page.getByText('Eye').click();
            await page.getByPlaceholder('Enter the password').fill(value);
            await page.getByRole('button', { name: 'Login' }).click();
            if (success) await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
            else await page.getByRole('heading', { name: 'Attention needed' }).waitFor();
            await page.getByRole('button', { name: '完成录制' }).click();
        });
    }
    const deniedWithEye = await revealed('rejected-value', false);
    assert.equal((await loadLoginCredentials(root, url, account)).password, first);
    const afterEye = 'verified-reveal-value';
    const acceptedWithEye = await revealed(afterEye, true);
    const updated = await loadLoginCredentials(root, url, account);
    assert.equal(updated.password, afterEye);
    assert.equal(updated.landingUrl, origin + '/desk');
    assert.equal(updated.check, 'h1');
    const session = await findRecordingAuth(root, url, account);
    const outputs = [await fs.readFile(session.authState, 'utf8')];
    for (const r of [recorded, rejected, otpLogin, deniedWithEye, acceptedWithEye])
        outputs.push(
            JSON.stringify(r),
            renderRecordingSpec(r),
            JSON.stringify(generateRecordedCases(r)),
        );
    for (const output of outputs)
        for (const secret of [first, otp, 'rejected-value', afterEye])
            assert.equal(
                output.includes(secret),
                false,
                'recording or auth state included a login secret',
            );
});
