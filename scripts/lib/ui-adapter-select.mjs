// Shared option naming for all component adapters. These functions are also
// serialized into the recorder and standalone Playwright cases.
export function selectOptionName(element) {
    if (
        !element.isConnected ||
        !element.getClientRects().length ||
        getComputedStyle(element).visibility !== 'visible' ||
        element.closest('[aria-hidden=true],[inert]')
    )
        return '';
    const text = (value) => (value || '').trim().replace(/\s+/g, ' ').slice(0, 180);
    const labelled = (element.getAttribute('aria-labelledby') || '')
        .split(/\s+/)
        .map((id) => {
            const label = element.getRootNode().getElementById(id);
            return text(label?.innerText || label?.textContent);
        })
        .filter(Boolean)
        .join(' ');
    return (
        labelled ||
        text(element.getAttribute('aria-label')) ||
        text(element.innerText ?? element.textContent) ||
        text(element.getAttribute('title'))
    );
}

export async function selectOptionChoices(page, within, name, markup) {
    // Adapter selectors may include the popup itself as an ancestor.
    const all = page.locator(markup.option);
    const options = within === page ? all : all.and(within.locator('*'));
    const candidates = await options.elementHandles();
    let target;
    try {
        // Use exactly the recorder's name, not the icon-enriched accessible name
        // or textContent (which can include hidden labels). Bind the unique DOM
        // element so a re-render cannot retarget an index to another option.
        const names = await Promise.all(
            candidates.map((option) => option.evaluate(selectOptionName)),
        );
        const matches = candidates.filter((_, index) => names[index] && names[index] === name);
        if ((await options.count()) !== candidates.length) return { count: 0 };
        if (matches.length === 1 && (await matches[0].evaluate(selectOptionName)) === name)
            target = matches[0];
        return { count: matches.length, target };
    } finally {
        await Promise.all(
            candidates.filter((option) => option !== target).map((option) => option.dispose()),
        );
    }
}
