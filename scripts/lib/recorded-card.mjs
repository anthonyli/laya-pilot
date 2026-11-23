// Roleless cards can be clicked on their title, description, or padding. Exclude
// cards with nested actions because clicking a title would change the recorded intent.
const card = ':is(.item,.card,.ant-card,article,li):not([role],[aria-disabled=true],[inert])';
const nestedAction =
    'a[href],button,input,select,textarea,summary,[tabindex],[contenteditable=true],[role=button],[role=link],[role=option],[role=combobox],[role=switch],[role=checkbox],[role=radio],[role=menuitem]';
export const cardTitleSelector = `${card}:not(:has(${nestedAction})) > :is(.title,.card-title,h2,h3,h4,[role=heading])`;

// Also embedded in standalone Playwright recordings.
export async function findDialogCard(dialog, name, selector) {
    await dialog.waitFor({ state: 'visible' });
    const words = name
        .trim()
        .split(/\s+/)
        .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const title = dialog.locator(selector).filter({
        visible: true,
        hasText: new RegExp('^\\s*' + words.join('\\s+') + '\\s*$'),
    });
    await title.waitFor({ state: 'visible' });
    if (!(await title.evaluate((el) => getComputedStyle(el.parentElement).cursor === 'pointer')))
        throw Error(`卡片「${name}」无法点击。`);
    return title;
}
