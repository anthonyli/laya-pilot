// Only one CSS class token from a navigation icon can enter a recorded selector.
export const navigationScope = ':is(nav, aside, [role=navigation], [role=menu], [role=menubar])';
export const iconClassPattern = /^[a-zA-Z_][a-zA-Z0-9_-]{0,79}$/;

export function navigationIconSelector(token) {
    if (!iconClassPattern.test(token)) throw Error('导航图标类名无效。');
    return `${navigationScope} svg.${token}`;
}

// These functions are also embedded in standalone Playwright recordings.
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

export async function findNamedIcon(page, scope, name, ownerOf, declaredName, timeout = 8000) {
    const candidates = scope.locator('svg, img, i, [role=img]').filter({ visible: true });
    const tips = page.getByRole('tooltip').filter({ visible: true });
    const deadline = Date.now() + timeout;

    async function scan(graphics) {
        const seen = await page.evaluateHandle(() => new WeakSet());
        const owners = [];
        const matches = [];
        let result = null;
        let hoverCount = 0;
        try {
            for (const graphic of graphics) {
                const handle = await graphic.evaluateHandle(ownerOf);
                const owner = handle.asElement();
                if (
                    !owner ||
                    !(await owner.evaluate(
                        (el, { seen, globalToolbar }) => {
                            if (
                                seen.has(el) ||
                                !el.isConnected ||
                                el.innerText?.trim() ||
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
                        { seen, globalToolbar: scope === page },
                    ))
                ) {
                    await handle.dispose();
                    continue;
                }
                owners.push(owner);
                const label = await owner.evaluate(declaredName);
                if (label === name) {
                    matches.push(owner);
                    continue;
                }
                if (label && !/^(?:icon|图标)\s*[:：]/i.test(label)) continue;
                if (++hoverCount > 48) throw Error('图标过多，无法在当前范围验证唯一目标。');
                await page.mouse.move(0, 0);
                await tips
                    .first()
                    .waitFor({ state: 'hidden', timeout: 1000 })
                    .catch(() => {});
                if (await tips.count()) continue;
                try {
                    await owner.hover({ timeout: 1500 });
                } catch (error) {
                    if (await owner.evaluate((el) => el.isConnected)) throw error;
                    continue;
                }
                await tips
                    .first()
                    .waitFor({ state: 'visible', timeout: 750 })
                    .catch(() => {});
                if (
                    (await tips.count()) === 1 &&
                    (await tips.first().innerText()).trim().replace(/\s+/g, ' ') === name
                )
                    matches.push(owner);
            }
            // SPA navigation can mount additional entries while their tooltips are being read.
            if ((await candidates.count()) !== graphics.length) return null;
            const live = [];
            for (const match of matches) {
                if (await match.evaluate((el) => el.isConnected && el.getClientRects().length))
                    live.push(match);
            }
            if (live.length > 1)
                throw Error(`无法唯一定位图标「${name}」，找到 ${live.length} 个匹配项。`);
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
    for (;;) {
        const graphics = await candidates.elementHandles();
        if (graphics.length) {
            const match = await scan(graphics);
            if (match) return match;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw Error(`无法唯一定位图标「${name}」，找到 0 个匹配项。`);
        await page.waitForTimeout(Math.min(150, remaining));
    }
}
