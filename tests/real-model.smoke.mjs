// Explicit offline smoke test: unlike browser fixtures, this loads actual weights.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Laya } from '../scripts/lib/model.mjs';
import { Workflow } from '../scripts/lib/workflow.mjs';
import { loadLocalEnvironment } from '../scripts/lib/project-config.mjs';
import { matchReplayTarget } from '../scripts/lib/replay-model.mjs';

test(
    'real local Laya grounds replay actions and fields with production confidence gates',
    { timeout: 120000 },
    async (t) => {
        await loadLocalEnvironment(fileURLToPath(new URL('..', import.meta.url)));
        process.env.HF_HUB_OFFLINE = '1';
        process.env.TRANSFORMERS_OFFLINE = '1';
        const out = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-real-model-'));
        const laya = new Laya(
            process.env.LAYA_TEST_PYTHON || process.env.LAYA_PYTHON || 'python3',
            fileURLToPath(new URL('../scripts/worker.py', import.meta.url)),
            process.env.LAYA_TEST_MODEL || process.env.LAYA_MODEL,
            path.join(out, 'decisions.ndjson'),
        );
        try {
            await laya.request({ action: 'load' });
            const locator = { count: async () => 1, isVisible: async () => true };
            const snapshot = {
                frames: [{ locator: () => locator }],
                url: 'https://fixture.invalid',
            };
            for (const [role, name] of [
                ['button', '添加用户'],
                ['button', '确定'],
                ['button', '图标：form'],
                ['button', '删除'],
                ['textbox', '输入登录账号搜索'],
            ]) {
                await t.test(name, async () => {
                    const verb = role === 'textbox' ? '填写' : '点击';
                    const found = await Workflow.prototype.chooseFromSnapshot.call(
                        { mode: 'execute', config: {}, laya },
                        snapshot,
                        [{ name, role, context: '', frame: 0, ref: 'live' }],
                        `${verb}「${name}」`,
                    );
                    assert.equal(found.locator, locator);
                });
            }
            for (const [action, expected, names] of [
                ['填写', '登录账号', ['用户名', '登录账号', '电话']],
                ['选择', '机构', ['角色', '渠道', '机构']],
                ['选择', '渠道', ['渠道', '角色', '机构']],
            ]) {
                await t.test(expected, async () => {
                    const found = await matchReplayTarget(
                        laya,
                        action,
                        expected,
                        names.map((name) => ({ name })),
                    );
                    assert.equal(found.name, expected);
                });
            }
            assert.ok(laya.records.every((r) => r.phase === 'replay-target' && !r.cache_hit));
            console.log('Real model decisions: ' + path.join(out, 'decisions.ndjson'));
        } finally {
            laya.close();
        }
    },
);
