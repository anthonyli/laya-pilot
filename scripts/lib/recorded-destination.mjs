function exactUrl(value) {
    const url = new URL(value);
    url.searchParams.sort();
    return url.href;
}

export async function verifyRecordedDestination(page, text, spec, timeout = 4000) {
    const result = (status, reason, actual) => ({ text, kind: spec.kind, status, reason, actual });
    if (spec.kind === 'navigation-url') {
        const expected = exactUrl(spec.target);
        const arrived = await page
            .waitForURL((url) => exactUrl(url.href) === expected, { timeout, waitUntil: 'commit' })
            .then(
                () => true,
                () => false,
            );
        return result(
            arrived ? '通过' : '失败',
            arrived ? '当前浏览器地址与录制目标一致。' : '当前浏览器地址与录制目标不一致。',
            arrived ? spec.target : new URL(page.url()).pathname,
        );
    }
    const exact = { name: spec.target, exact: true };
    const controls = page
        .getByRole('tab', exact)
        .or(page.getByRole('button', exact))
        .or(page.getByRole('link', exact))
        .or(page.getByRole('menuitem', exact))
        .filter({ visible: true });
    const deadline = Date.now() + timeout;
    let state;
    do {
        state = await controls.evaluateAll((elements) => {
            if (elements.length !== 1) return 'ambiguous';
            const element = elements[0];
            for (const attr of ['aria-selected', 'aria-pressed', 'aria-current']) {
                const value = element.getAttribute(attr);
                if (value !== null) {
                    if (value === 'false' || !value) return 'inactive';
                    if (
                        value === 'true' ||
                        (attr === 'aria-current' &&
                            ['page', 'step', 'location', 'time', 'date'].includes(value))
                    )
                        return 'selected';
                    return 'unknown';
                }
            }
            const owned = element.getAttribute('aria-controls')?.split(/\s+/).filter(Boolean) || [];
            if (owned.length === 1) {
                const panel = document.getElementById(owned[0]);
                if (
                    panel?.matches('[role=tabpanel]') &&
                    panel.getAttribute('aria-labelledby')?.split(/\s+/).includes(element.id)
                ) {
                    const visible = (node) =>
                        node.getClientRects().length &&
                        !node.closest('[hidden],[aria-hidden=true],[inert]') &&
                        getComputedStyle(node).visibility === 'visible';
                    if (!visible(panel)) return 'inactive';
                    const tabs = element.closest('[role=tablist]')?.querySelectorAll('[role=tab]');
                    const peers = [...(tabs || [])].filter((tab) => tab !== element);
                    return peers.length &&
                        peers.every((tab) => {
                            const other = document.getElementById(
                                tab.getAttribute('aria-controls'),
                            );
                            return other?.matches('[role=tabpanel]') && !visible(other);
                        })
                        ? 'selected'
                        : 'unknown';
                }
            }
            return 'unknown';
        });
        if (state === 'selected')
            return result('通过', '已观察到指定区域处于选中状态。', spec.target);
        if (Date.now() < deadline) await page.waitForTimeout(Math.min(80, deadline - Date.now()));
    } while (Date.now() < deadline);
    return state === 'inactive'
        ? result('失败', '目标区域存在，但未处于选中状态。', false)
        : result('未验证', '未能从唯一控件或其关联面板确认目标区域处于选中状态。', null);
}
