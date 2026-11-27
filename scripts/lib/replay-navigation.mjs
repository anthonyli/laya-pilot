import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { writePrivateJson } from './run-state.mjs';
import { authRoute } from './recording-auth.mjs';
import { Halt } from './language.mjs';
import { chooseReplayName } from './replay-fields.mjs';
import {
    declaredIconName,
    findNamedIcon,
    iconClassPattern,
    iconOwner,
    navigationIconSelector,
    navigationScope,
    readNavigationIconClass,
} from './recorded-navigation.mjs';

export async function resolveNavigationMenu(
    page,
    scope,
    requested,
    recordedHint,
    config,
    laya,
    meta,
) {
    if (!recordedHint && config.decisionStrategy !== 'model-first') {
        const options = { name: requested, exact: true };
        const named = await scope
            .getByRole('button', options)
            .or(scope.getByRole('menuitem', options))
            .filter({ visible: true })
            .elementHandles();
        if (named.length === 1 && (await named[0].isEnabled()))
            return { locator: named[0], actual: requested, strategy: 'accessible-name' };
        if (named.length) {
            await Promise.all(named.map((handle) => handle.dispose()));
            throw new Halt(
                '导航菜单不可用',
                `菜单「${requested}」${named.length > 1 ? '存在多个同名目标' : '已禁用'}`,
            );
        }
    }
    const key = JSON.stringify([
        config.authAccount || '',
        config.excel || '',
        authRoute(page.url()),
        requested,
        recordedHint || '',
    ]);
    const file =
        config.credentialRoot &&
        path.join(
            config.credentialRoot,
            'cache',
            'navigation',
            createHash('sha256').update(key).digest('hex') + '.json',
        );
    let cached;
    if (file) {
        try {
            const value = JSON.parse(await fs.readFile(file, 'utf8'));
            if (typeof value === 'string' && iconClassPattern.test(value)) cached = value;
        } catch {
            /* A missing or unreadable hint only affects lookup time. */
        }
    }
    const hint = cached || recordedHint;
    let actual = requested;
    let strategy = 'scan';
    const locator = await findNamedIcon(
        page,
        scope,
        requested,
        iconOwner,
        declaredIconName,
        config.assertTimeout || 4000,
        hint && navigationIconSelector(hint),
        {
            menu: true,
            preferModel: config.decisionStrategy === 'model-first',
            onExactFallback() {
                actual = requested;
                strategy = 'scan';
            },
            onMatch(hinted) {
                if (hinted) strategy = cached ? 'cached-icon' : 'recorded-icon';
            },
            choose:
                config.decisionStrategy !== 'off' &&
                laya?.choose &&
                (async (names) => {
                    actual = await chooseReplayName(
                        laya,
                        `展开「${requested}」导航菜单`,
                        names,
                        config,
                        {
                            ...meta,
                            phase: 'navigation-match',
                            recorded_menu: requested,
                        },
                    );
                    strategy = 'model';
                    return actual;
                }),
        },
    );
    if (file && strategy === 'scan') {
        try {
            const token = await locator.evaluate(readNavigationIconClass, {
                navigationScope,
                iconClassSource: iconClassPattern.source,
            });
            if (token && token !== cached) writePrivateJson(file, token);
        } catch {
            /* The verified live element remains usable without persistence. */
        }
    }
    return { locator, actual, strategy };
}
