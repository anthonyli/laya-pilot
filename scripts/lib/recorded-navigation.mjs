// Only one CSS class token from a navigation icon can enter a recorded selector.
export const navigationScope = ':is(nav, aside, [role=navigation], [role=menu], [role=menubar])';
export const iconClassPattern = /^[a-zA-Z_][a-zA-Z0-9_-]{0,79}$/;

export function navigationIconSelector(token) {
    if (!iconClassPattern.test(token)) throw Error('导航图标类名无效。');
    return `${navigationScope} svg.${token}`;
}

// These functions are also embedded in standalone Playwright recordings.
export function readNavigationIconClass(clicked, { navigationScope, iconClassSource }) {
    if (!clicked?.closest(navigationScope) || getComputedStyle(clicked).cursor !== 'pointer')
        return null;
    const visible = (el) =>
        el.getClientRects().length &&
        getComputedStyle(el).visibility === 'visible' &&
        !el.closest('[aria-hidden=true],[inert]');
    const icon = clicked.closest('svg');
    const icons = icon ? [icon] : [...clicked.querySelectorAll('svg')].filter(visible);
    if (icons.length !== 1) return null;
    const tokenPattern = new RegExp(iconClassSource);
    const tokens = [...icons[0].classList]
        .filter(
            (token) =>
                tokenPattern.test(token) &&
                /(?:menu|nav)/i.test(token) &&
                !/(?:^|[-_])(?:active|hover|selected|disabled|focus)(?:$|[-_])/i.test(token),
        )
        .sort((a, b) => b.length - a.length);
    return tokens.find(
        (token) =>
            [...document.querySelectorAll(`${navigationScope} svg.${token}`)].filter(visible)
                .length === 1,
    );
}

export function iconOwner(element) {
    const graphics = 'svg, img, i, [role=img]';
    const icon =
        element?.closest(graphics) ||
        element?.querySelector(':scope > :is(svg, img, i, [role=img])');
    if (!icon) return null;
    const button = icon.closest('button, a[href], [role=button], [role=link], [role=menuitem]');
    if (button) return button;
    const wrapper = icon.parentElement;
    if (getComputedStyle(icon).cursor !== 'pointer') return null;
    return wrapper?.matches('div, span, i, a, li') &&
        wrapper.children.length === 1 &&
        getComputedStyle(wrapper).cursor === 'pointer'
        ? wrapper
        : icon;
}

export function declaredIconName(owner) {
    const label = (el) =>
        el?.getAttribute('aria-label') ||
        el?.getAttribute('title') ||
        (el?.getAttribute('aria-labelledby') || '')
            .split(/\s+/)
            .filter(Boolean)
            .map((id) => el.getRootNode().getElementById(id)?.textContent)
            .filter(Boolean)
            .join(' ');
    const graphics = 'svg, img, i, [role=img]';
    const graphic = owner.matches(graphics) ? owner : owner.querySelector(graphics);
    const described = (owner.getAttribute('aria-describedby') || '')
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => owner.getRootNode().getElementById(id))
        .filter((el) => el?.getAttribute('role') === 'tooltip');
    const name =
        label(owner) ||
        label(graphic) ||
        graphic?.getAttribute('alt') ||
        owner.querySelector('svg title, title')?.textContent ||
        (described.length === 1 && described[0].textContent) ||
        '';
    return name.trim().replace(/\s+/g, ' ');
}

export async function findNamedIcon(
    page,
    scope,
    name,
    ownerOf,
    declaredName,
    timeout = 8000,
    hintSelector,
    replay = {},
) {
    const graphicsSelector = 'svg, img, i, [role=img]';
    const menuTriggers = 'button,[role=button],[role=menuitem],[aria-haspopup=true]';
    const candidates = scope
        .locator(replay.menu ? graphicsSelector + ',' + menuTriggers : graphicsSelector)
        .filter({ visible: true });
    const tips = page.getByRole('tooltip').filter({ visible: true });
    const deadline = Date.now() + timeout;

    // Tooltip animations often finish between Playwright's longer retry intervals.
    async function waitForTips(visible, ms) {
        const until = Date.now() + ms;
        while (Boolean(await tips.count()) !== visible && Date.now() < until)
            await page.waitForTimeout(35);
    }

    async function readTooltip(owner) {
        await page.mouse.move(0, 0);
        await waitForTips(false, 1000);
        if (await tips.count()) return '';
        try {
            await owner.hover({ timeout: 1500 });
        } catch (error) {
            if (await owner.evaluate((el) => el.isConnected)) throw error;
            return '';
        }
        await waitForTips(true, 750);
        return (await tips.count()) === 1
            ? (await tips.first().innerText()).trim().replace(/\s+/g, ' ')
            : '';
    }

    async function nameOf(owner) {
        const name = await owner.evaluate(declaredName);
        if (name && !/^(?:icon|图标)\s*[:：]/i.test(name)) return name;
        return replay.menu ? (await owner.innerText()).trim().replace(/\s+/g, ' ') : '';
    }

    async function scan(graphics, source) {
        const seen = await page.evaluateHandle(() => new WeakSet());
        const owners = [];
        const matches = [];
        const alternatives = new Map();
        let result = null;
        let hoverCount = 0;
        try {
            for (const graphic of graphics) {
                const handle =
                    replay.menu &&
                    (await graphic.evaluate((el, selectors) => el.matches(selectors), menuTriggers))
                        ? await graphic.evaluateHandle((el) => el)
                        : await graphic.evaluateHandle(ownerOf);
                const owner = handle.asElement();
                if (
                    !owner ||
                    !(await owner.evaluate(
                        (el, { seen, globalToolbar, menu }) => {
                            if (
                                seen.has(el) ||
                                !el.isConnected ||
                                (!menu && el.innerText?.trim()) ||
                                el.closest('[inert], :disabled, [aria-disabled=true]') ||
                                (globalToolbar &&
                                    el.closest(
                                        'nav,aside,[role=navigation],tr,[role=row],dialog,[role=dialog],[role=alertdialog]',
                                    ))
                            )
                                return false;
                            seen.add(el);
                            return true;
                        },
                        { seen, globalToolbar: scope === page, menu: replay.menu },
                    ))
                ) {
                    await handle.dispose();
                    continue;
                }
                owners.push(owner);
                let label = await nameOf(owner);
                if (!label) {
                    if (++hoverCount > 48) throw Error('图标过多，无法在当前范围验证唯一目标。');
                    label = await readTooltip(owner);
                }
                if (label === name) matches.push(owner);
                else if (label && replay.choose && source === candidates)
                    alternatives.set(label, alternatives.has(label) ? null : owner);
            }
            if (source !== candidates && matches.length) {
                // Hover can swap the SVG for its highlighted variant inside the same button.
                // Recheck that the recorded class still identifies this owner after pointer leave.
                await page.mouse.move(0, 0);
                await source
                    .first()
                    .waitFor({ state: 'visible', timeout: 500 })
                    .catch(() => {});
                const sameOwner = await source.evaluateAll(
                    (icons, owner) => icons.length === 1 && owner.contains(icons[0]),
                    matches[0],
                );
                if (!sameOwner) return null;
            } else if ((await source.count()) !== graphics.length) {
                // SPA navigation can mount additional entries while tooltips are being read.
                return null;
            }
            const live = [];
            for (const match of matches) {
                if (await match.evaluate((el) => el.isConnected && el.getClientRects().length))
                    live.push(match);
            }
            if (live.length > 1)
                throw Error(`无法唯一定位图标「${name}」，找到 ${live.length} 个匹配项。`);
            if (!live.length && source === candidates && replay.choose && !matches.length) {
                const names = [...alternatives.keys()].filter((key) => alternatives.get(key));
                if (names.length) {
                    const selected = await replay.choose(names);
                    const owner = alternatives.get(selected);
                    if (
                        !owner ||
                        !(await scope
                            .locator('*')
                            .evaluateAll(
                                (els, el) =>
                                    els.includes(el) &&
                                    el.getClientRects().length &&
                                    !el.closest('[inert],:disabled,[aria-disabled=true]'),
                                owner,
                            ))
                    )
                        throw Error('模型选择的菜单已发生变化。');
                    let label = await nameOf(owner);
                    if (!label) label = await readTooltip(owner);
                    if (label !== selected) throw Error('模型选择的菜单名称已变化。');
                    live.push(owner);
                }
            }
            if (live.length) replay.onMatch?.(source !== candidates);
            result = live[0] || null;
            return result;
        } finally {
            await Promise.all(
                [seen, ...graphics, ...owners.filter((owner) => owner !== result)].map((handle) =>
                    handle.dispose(),
                ),
            );
        }
    }
    const hinted = hintSelector && candidates.and(page.locator(hintSelector));
    for (;;) {
        if (hinted) {
            const graphics = await hinted.elementHandles();
            if (graphics.length === 1) {
                const match = await scan(graphics, hinted);
                if (match) return match;
            } else await Promise.all(graphics.map((graphic) => graphic.dispose()));
        }
        const graphics = await candidates.elementHandles();
        if (graphics.length) {
            const match = await scan(graphics, candidates);
            if (match) return match;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw Error(`无法唯一定位图标「${name}」，找到 0 个匹配项。`);
        await page.waitForTimeout(Math.min(150, remaining));
    }
}
