import { selectOptionChoices } from './ui-adapter-select.mjs';

export const selectSearchInput =
    'input[role=combobox]:is([type=search],[type=text],:not([type])):not(:disabled,[readonly],[aria-disabled=true],[aria-readonly=true])';

export function selectSelectors(uiAdapters) {
    // Ant can put the semantic input inside its clickable surface and nest popup wrappers.
    const surface = `:is(${uiAdapters.select.trigger})`;
    const popup = `:is(${uiAdapters.select.popup})`;
    return {
        ...uiAdapters.form,
        ...uiAdapters.select,
        searchInput: selectSearchInput,
        trigger: `${surface},[role=combobox]:not(select):not(${surface} *):not(:has(${surface}))`,
        popup: `${popup}:not(:has(${popup}))`,
        option: `[role=option],${uiAdapters.select.option}`,
    };
}

// These helpers are embedded in the recording browser or the standalone Playwright case.
export function formItemLabel(element, markup) {
    const item = element.closest(markup.item);
    if (!item) return '';
    const labels = [...item.querySelectorAll(markup.label)].filter(
        (label) =>
            label.closest(markup.item) === item &&
            label.getClientRects().length &&
            getComputedStyle(label).visibility === 'visible',
    );
    if (labels.length !== 1) return '';
    return labels[0].innerText
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^\*\s*|\s*[:：]$/g, '')
        .trim();
}

// A few Cascaders expose an aria-controls ID for a list they never mount. A single
// popup can still be attributed to its opener when no other combobox is expanded.
export function onlyExpandedSelect(opener) {
    const expanded = [...document.querySelectorAll('[role=combobox][aria-expanded=true]')].filter(
        (el) => el.getClientRects().length && getComputedStyle(el).visibility === 'visible',
    );
    return (
        expanded.length > 0 && expanded.every((el) => opener.contains(el) || el.contains(opener))
    );
}

export function recordedFormItem(scope, page, name, markup) {
    const escaped = name
        .trim()
        .split(/\s+/)
        .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp('^\\s*\\*?\\s*' + escaped.join('\\s+') + '\\s*[:：]?\\s*$');
    // Exclude titles belonging to a nested item, while keeping duplicate sibling titles ambiguous.
    const directLabel = `:scope :is(${markup.label}):not(:scope :is(${markup.item}) *)`;
    const label = page.locator(directLabel).filter({ visible: true, hasText: pattern });
    return scope.locator(markup.item).filter({ has: label });
}

export async function recordedSelectOption(
    page,
    name,
    opener,
    markup,
    scope = page,
    timeout = 4000,
) {
    const choices = (within) => selectOptionChoices(page, within, name, markup);
    if (!opener) {
        const deadline = Date.now() + timeout;
        do {
            const { target } = await choices(scope);
            if (target) return target;
            if (Date.now() >= deadline) break;
            await new Promise((resolve) =>
                setTimeout(resolve, Math.min(50, deadline - Date.now())),
            );
        } while (Date.now() <= deadline);
        throw Error(`展开的下拉框中无法唯一定位选项「${name}」`);
    }

    // An ancestor chain is ordered from root to leaf. Its last matching item is the
    // nearest owner, including when the adapter uses attributes or compound selectors.
    const item = opener.locator('xpath=ancestor-or-self::*').and(page.locator(markup.item)).last();
    const local = item
        .locator(`:scope :is(${markup.popup},[role=listbox]):not(:scope :is(${markup.item}) *)`)
        .filter({ visible: true });
    const popups = page.locator(markup.popup).filter({ visible: true });
    const deadline = Date.now() + timeout;
    // Mounting the portal, closing the previous popup and populating virtual options
    // can happen on separate renders. Re-evaluate ownership until the choice exists.
    do {
        const id = await opener.evaluate((el) => {
            const aria = el.matches('[aria-controls],[aria-owns]')
                ? el
                : el.querySelector('[aria-controls],[aria-owns]');
            const ids = [aria?.getAttribute('aria-controls'), aria?.getAttribute('aria-owns')]
                .filter(Boolean)
                .join(' ');
            const id = ids.split(/\s+/).find((id) => id && document.getElementById(id));
            return id && CSS.escape(id);
        });
        let owner;
        if (id) {
            const owned = page.locator('#' + id);
            // A virtual select may render the accessible list beside the clickable rows.
            const dropdown = popups.filter({ has: owned });
            owner = (await dropdown.count()) === 1 ? dropdown : owned;
        } else if ((await local.count()) > 0) {
            owner = local;
        } else if ((await popups.count()) === 1 && (await opener.evaluate(onlyExpandedSelect))) {
            // A popup belonging to a different form item can still be fading out.
            owner = popups.and(page.locator(`:not(:is(${markup.item}) *)`));
        }
        if (owner) {
            const { target } = await choices(owner);
            if (target) return target;
        }
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
    } while (Date.now() <= deadline);
    throw Error(`展开的下拉框中无法唯一定位选项「${name}」`);
}

// Standard ARIA fields can expose their name directly. Some component libraries
// instead put it on a form item and expose a separate clickable surface.
export function recordedSelectTrigger(scope, page, name, markup) {
    const surfaces = scope.locator(markup.trigger);
    const named = scope.getByRole('combobox', { name, exact: true }).and(surfaces);
    const inField = recordedFormItem(scope, page, name, markup).locator(markup.trigger);
    return named.or(inField).filter({ visible: true });
}

export async function clickRecordedSelectTrigger(trigger, markup) {
    // Some single-select trees keep the popup open after committing a choice.
    // Move focus to the requested field if that popup intercepts its click.
    await trigger.evaluate((el, popup) => {
        const box = el.getBoundingClientRect();
        const hit = el.ownerDocument.elementFromPoint(
            box.x + box.width / 2,
            box.y + box.height / 2,
        );
        if (!hit || el.contains(hit) || !hit.closest(popup)) return;
        const input = el.matches('[role=combobox]') ? el : el.querySelector('[role=combobox]');
        input?.focus({ preventScroll: true });
    }, markup.popup);
    await trigger.click();
}

export function recordedSelectSearch(scope, page, name, markup) {
    const inputs = scope.locator(markup.searchInput);
    const named = scope.getByRole('combobox', { name, exact: true });
    const placeholder = scope.getByPlaceholder(name, { exact: true });
    const inField = recordedFormItem(scope, page, name, markup).locator(markup.searchInput);
    return inputs.and(named.or(placeholder).or(inField)).filter({ visible: true });
}
