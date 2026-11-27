import { modelOrRules } from './replay-model.mjs';
import { randomBytes } from 'node:crypto';
import { Halt, norm } from './language.mjs';
import { controlBindingsFor } from './control-bindings.mjs';
import { selectSearchInput } from './recorded-select.mjs';
const ATTR = 'data-laya-live-ref';
export async function observe(page) {
    const nonce = randomBytes(5).toString('hex'),
        controls = [],
        unidentifiedControls = [],
        bindingDiagnostics = [];
    const frames = page.frames();
    for (let fi = 0; fi < frames.length; fi++) {
        // A frame's own document cannot see a hidden/inert/modal-blocked host.
        let available = true;
        for (let frame = frames[fi]; frame.parentFrame(); frame = frame.parentFrame()) {
            const host = await frame.frameElement().catch(() => null);
            if (!host) {
                available = false;
                break;
            }
            try {
                available =
                    (await host.isVisible()) &&
                    (await host.evaluate((e) => {
                        if (e.closest('[inert],[aria-hidden="true"]')) return false;
                        const modals = [
                            ...document.querySelectorAll(
                                'dialog[open],[role="dialog"],[role="alertdialog"],[data-slot="dialog-content"],[data-slot="alert-dialog-content"],.ant-drawer-open .ant-drawer-content,.el-dialog',
                            ),
                        ].filter((node) => {
                            const rect = node.getBoundingClientRect(),
                                style = getComputedStyle(node);
                            return (
                                rect.width > 0 &&
                                rect.height > 0 &&
                                style.visibility !== 'hidden' &&
                                style.display !== 'none'
                            );
                        });
                        return !modals.length || modals.at(-1).contains(e);
                    }));
            } catch {
                available = false;
            } finally {
                await host.dispose();
            }
            if (!available) break;
        }
        if (!available) continue;
        const items = await frames[fi]
            .evaluate(
                ({ nonce, fi, attr, bindings, selectSearchInput }) => {
                    const visible = (e) => {
                        const s = getComputedStyle(e),
                            r = e.getBoundingClientRect();
                        return (
                            s.display !== 'none' &&
                            s.visibility !== 'hidden' &&
                            r.width > 0 &&
                            r.height > 0 &&
                            !e.closest('[inert],[aria-hidden="true"]')
                        );
                    };
                    const text = (e) =>
                        (e?.innerText || e?.textContent || '').replace(/\s+/g, ' ').trim();
                    const roots = [document];
                    for (let i = 0; i < roots.length; i++)
                        for (const e of roots[i].querySelectorAll('*'))
                            if (e.shadowRoot) roots.push(e.shadowRoot);
                    const selector =
                        'button,a[href],input:not([type="hidden"]),textarea,select,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[role="combobox"],[role="checkbox"],[role="radio"],[role="switch"],[tabindex],[contenteditable="true"],summary';
                    let elements = roots
                        .flatMap((root) => [...root.querySelectorAll(selector)])
                        .filter(visible);
                    // Some enterprise navigation bars have clickable divs with no ARIA roles.
                    const pointer = roots
                        .flatMap((root) => [...root.querySelectorAll('div,span,li')])
                        .filter(
                            (e) =>
                                visible(e) &&
                                getComputedStyle(e).cursor === 'pointer' &&
                                text(e).length > 0 &&
                                text(e).length < 45 &&
                                !e.closest(selector) &&
                                !e.querySelector(selector) &&
                                ![...e.children].some(
                                    (c) => getComputedStyle(c).cursor === 'pointer',
                                ),
                        );
                    // Icon actions may have a label and pointer cursor without a
                    // tabindex. Keep labelled leaf icons, not decorative children
                    // of an already-discovered native button.
                    const icons = roots
                        .flatMap((root) => [...root.querySelectorAll('i[aria-label]')])
                        .filter(
                            (e) =>
                                visible(e) &&
                                getComputedStyle(e).cursor === 'pointer' &&
                                !e.closest(selector),
                        );
                    elements = [...new Set([...elements, ...pointer, ...icons])];
                    // A menuitem wrapping its same-named link is one action, not two Laya
                    // candidates. Keep the inner native control and retain distinct siblings.
                    elements = elements.filter(
                        (e) =>
                            !(
                                e.getAttribute('role') === 'menuitem' &&
                                [...e.querySelectorAll('a[href],button')].some(
                                    (child) => visible(child) && text(child) === text(e),
                                )
                            ),
                    );
                    const modals = roots
                        .flatMap((root) => [
                            ...root.querySelectorAll(
                                'dialog[open],[role="dialog"],[role="alertdialog"],[data-slot="dialog-content"],[data-slot="alert-dialog-content"],.ant-drawer-open .ant-drawer-content,.el-dialog',
                            ),
                        ])
                        .filter(visible);
                    const modal = modals.at(-1);
                    // Options can be portaled outside their owning dialog.
                    if (modal)
                        elements = elements.filter(
                            (e) =>
                                modal.contains(e) ||
                                e.closest(
                                    '[role="listbox"],.ant-select-dropdown,.el-select-dropdown',
                                ),
                        );
                    const bindingErrors = [];
                    const bound = new Map();
                    for (const binding of bindings) {
                        let matches;
                        try {
                            matches = roots.flatMap((root) => [
                                ...root.querySelectorAll(binding.selector),
                            ]);
                        } catch {
                            bindingErrors.push({ ...binding, code: 'invalid-selector' });
                            continue;
                        }
                        if (matches.length !== 1 || !elements.includes(matches[0])) {
                            bindingErrors.push({
                                ...binding,
                                code:
                                    matches.length > 1
                                        ? 'ambiguous-binding'
                                        : 'binding-target-unavailable',
                            });
                            continue;
                        }
                        const element = matches[0];
                        if (bound.has(element)) {
                            bound.set(element, null);
                            bindingErrors.push({ ...binding, code: 'conflicting-bindings' });
                        } else bound.set(element, binding);
                    }
                    const items = elements.slice(0, 800).map((e, i) => {
                        const tag = e.tagName.toLowerCase(),
                            type = e.getAttribute('type') || '';
                        let role =
                            e.getAttribute('role') ||
                            {
                                button: 'button',
                                a: 'link',
                                textarea: 'textbox',
                                select: 'combobox',
                                summary: 'button',
                            }[tag] ||
                            (tag === 'input'
                                ? {
                                      checkbox: 'checkbox',
                                      radio: 'radio',
                                      number: 'spinbutton',
                                      password: 'password',
                                  }[type] || 'textbox'
                                : 'button');
                        const labelled = (e.getAttribute('aria-labelledby') || '')
                            .split(/\s+/)
                            .map((id) => text(e.getRootNode().getElementById(id)))
                            .join(' ')
                            .trim();
                        const labels = e.labels ? [...e.labels].map(text).join(' ') : '';
                        const parentLabel = text(
                            e.closest('.ant-form-item,.el-form-item')?.querySelector('label'),
                        );
                        let sibLabel = '';
                        if (['input', 'textarea', 'select'].includes(tag)) {
                            let n = e.previousElementSibling;
                            while (n) {
                                if (/^label$/i.test(n.tagName)) {
                                    sibLabel = text(n);
                                    break;
                                }
                                n = n.previousElementSibling;
                            }
                            if (!sibLabel) {
                                n = e.parentElement?.previousElementSibling || null;
                                while (n) {
                                    if (/^label$/i.test(n.tagName)) {
                                        sibLabel = text(n);
                                        break;
                                    }
                                    n = n.previousElementSibling;
                                }
                            }
                        }
                        const selectBox = e.closest(
                            '.ant-select,.tntd-rc-select,.el-select,[role="combobox"]',
                        );
                        const selectHint =
                            text(
                                selectBox?.querySelector(
                                    '.ant-select-selection__placeholder,.ant-select-selection-placeholder,.tntd-rc-select-selection-placeholder,.el-input__inner',
                                ),
                            ) || text(selectBox);
                        const clone = e.cloneNode(true);
                        const descendants = [...e.querySelectorAll('*')];
                        [...clone.querySelectorAll('*')].forEach((child, index) => {
                            const original = descendants[index],
                                style = getComputedStyle(original);
                            if (
                                original.matches('svg,[aria-hidden="true"],script,style') ||
                                style.display === 'none' ||
                                style.visibility === 'hidden'
                            )
                                child.remove();
                        });
                        const ownText = ['input', 'textarea'].includes(tag) ? '' : text(clone);
                        // Icon-only native buttons inherit their labelled child icon.
                        // Keep the button as the target rather than a decorative SVG.
                        const iconLabels = ['button', 'link'].includes(role)
                            ? [
                                  ...new Set(
                                      [
                                          ...[
                                              ...e.querySelectorAll(
                                                  'i[aria-label]:not([aria-hidden="true"]),svg[aria-label]:not([aria-hidden="true"])',
                                              ),
                                          ]
                                              .filter(visible)
                                              .map((icon) =>
                                                  icon.getAttribute('aria-label').trim(),
                                              ),
                                          ...[
                                              ...e.querySelectorAll(
                                                  'svg:not([aria-hidden="true"]) title',
                                              ),
                                          ]
                                              .filter((title) => visible(title.closest('svg')))
                                              .map(text),
                                      ].filter(Boolean),
                                  ),
                              ]
                            : [];
                        const iconLabel = iconLabels.length === 1 ? iconLabels[0] : '';
                        const describedTips = (e.getAttribute('aria-describedby') || '')
                            .split(/\s+/)
                            .map((id) => e.getRootNode().getElementById(id))
                            .filter((tip) => tip?.getAttribute('role') === 'tooltip' && text(tip));
                        const cachedTip = globalThis[Symbol.for('laya.tooltipLabels')]?.get(e);
                        const fingerprint = e.outerHTML.replace(/ data-laya-live-ref="[^"]*"/g, '');
                        const tooltip =
                            describedTips.length === 1
                                ? text(describedTips[0])
                                : cachedTip?.fingerprint === fingerprint
                                  ? cachedTip.label
                                  : '';
                        const tooltipAction = tooltip.match(/不支持(.+?)(?:操作)?$/)?.[1];
                        let name = (
                            e
                                .getAttribute('aria-label')
                                ?.trim()
                                .replace(/^图标[:：].*$/, '') ||
                            labelled ||
                            labels ||
                            parentLabel ||
                            sibLabel ||
                            e.getAttribute('placeholder') ||
                            e.getAttribute('title') ||
                            ownText ||
                            tooltipAction ||
                            tooltip ||
                            iconLabel ||
                            selectHint ||
                            e.getAttribute('aria-label') ||
                            e.getAttribute('name') ||
                            ''
                        )
                            .replace(/^\*\s*/, '')
                            .trim()
                            .slice(0, 130);
                        const binding = bound.get(e);
                        let appliedBinding;
                        if (binding) {
                            if (!name || /^图标[:：]/.test(name)) {
                                name = binding.name;
                                appliedBinding = binding;
                            } else if (name !== binding.name) {
                                bindingErrors.push({ ...binding, code: 'binding-label-conflict' });
                            }
                        }
                        const row = e.closest('tr,[role="row"]'),
                            group = e.closest('fieldset,[role="group"],form');
                        const rowKey = row?.getAttribute('data-row-key') || '';
                        // Fixed operation columns have rows containing only icons. Join their live
                        // data-row-key to the main table, rather than mistaking all icons for one row.
                        const peers = rowKey
                            ? [...document.querySelectorAll('tr[data-row-key]')].filter(
                                  (r) => r.getAttribute('data-row-key') === rowKey,
                              )
                            : [];
                        const rowText = [
                            ...new Set([text(row), ...peers.map(text)].filter(Boolean)),
                        ]
                            .sort((a, b) => b.length - a.length)
                            .join(' | ');
                        const context = row
                            ? rowText.slice(0, 500)
                            : text(group?.querySelector('legend,h1,h2,h3')).slice(0, 70);
                        const ref = nonce + '-' + fi + '-' + i;
                        e.setAttribute(attr, ref);
                        if (appliedBinding) {
                            const key = Symbol.for('laya.controlBindings');
                            globalThis[key] ||= new WeakMap();
                            globalThis[key].set(e, {
                                ref,
                                fingerprint,
                                rowFingerprint: (row?.outerHTML || '').replace(
                                    / data-laya-live-ref="[^"]*"/g,
                                    '',
                                ),
                            });
                        }
                        return {
                            ref,
                            frame: fi,
                            tag,
                            role,
                            name,
                            tooltip,
                            ...(appliedBinding ? { binding: appliedBinding } : {}),
                            ...(!name
                                ? {
                                      code: 'unidentified-control',
                                      elementId: e.id || '',
                                      title: e.getAttribute('title') || '',
                                      suggestion:
                                          '补充可核实的标签，或通过 --control-bindings 显式绑定；不能按位置猜测操作。',
                                  }
                                : {}),
                            rowKey,
                            placeholder: e.getAttribute('placeholder') || '',
                            context,
                            inPanel: !!e.closest('[role="tabpanel"]'),
                            disabled:
                                e.matches(':disabled') ||
                                e.hasAttribute('disabled') ||
                                e.getAttribute('aria-disabled') === 'true' ||
                                !!e.closest(
                                    '.ant-select-disabled,[aria-disabled="true"],.disabled,.is-disabled',
                                ) ||
                                (role === 'menuitem' &&
                                    !!e.querySelector(
                                        'a[disabled],button[disabled],a.disabled,button.disabled',
                                    )),
                            readonly: e.readOnly === true,
                            ...(e.matches(selectSearchInput) && { editableCombobox: true }),
                            selected:
                                e.getAttribute('aria-selected') === 'true' ||
                                e.classList.contains('ant-menu-item-selected') ||
                                !!e.closest('.ant-menu-item-selected'),
                            checked:
                                e.checked === true || e.getAttribute('aria-checked') === 'true',
                            href: e.getAttribute('href') || '',
                            value:
                                type === 'password'
                                    ? '[REDACTED]'
                                    : ('value' in e ? String(e.value) : '').slice(0, 160),
                        };
                    });
                    return { items, bindingDiagnostics: bindingErrors };
                },
                {
                    nonce,
                    fi,
                    attr: ATTR,
                    selectSearchInput,
                    bindings:
                        fi === 0
                            ? controlBindingsFor(page).filter((b) => b.url === page.url())
                            : [],
                },
            )
            .catch(() => ({ items: [], bindingDiagnostics: [] }));
        controls.push(...items.items.filter((c) => c.name || c.role === 'password'));
        unidentifiedControls.push(...items.items.filter((c) => !c.name && c.role !== 'password'));
        bindingDiagnostics.push(...items.bindingDiagnostics);
    }
    for (const binding of controlBindingsFor(page))
        if (binding.url !== page.url())
            bindingDiagnostics.push({ ...binding, code: 'binding-url-mismatch' });
    return { url: page.url(), controls, unidentifiedControls, bindingDiagnostics, frames };
}
export function score(target, c) {
    const t = norm(target),
        n = norm(c.name),
        p = norm(c.placeholder),
        context = norm(c.context);
    if (!t) return 0;
    let s = n === t ? 120 : n.includes(t) ? 85 : t.includes(n) && n.length > 1 ? 65 : 0;
    if (p && p.includes(t)) s = Math.max(s, 75);
    if (context.includes(t)) s += 30;
    const a = new Set([...t]);
    s += ([...new Set([...n])].filter((x) => a.has(x)).length / Math.max(1, a.size)) * 12;
    return s;
}
export async function discoverRowLabels(page, rowKey) {
    let snap = await observe(page);
    const icons = [
        ...snap.controls.filter((c) => /^图标[:：]/.test(c.name)),
        ...snap.unidentifiedControls,
    ].filter(
        (c) =>
            c.rowKey === rowKey && !c.disabled && ['button', 'link', 'menuitem'].includes(c.role),
    );
    // Only hover real DOM controls, never click an unknown icon to discover it.
    for (const icon of icons.slice(0, 12)) {
        const loc = snap.frames[icon.frame].locator(`[${ATTR}="${icon.ref}"]`);
        try {
            await page.mouse.move(0, 0);
            const tips = snap.frames[icon.frame].locator(
                '[role="tooltip"]:visible,.ant-tooltip:visible,.el-tooltip__popper:visible',
            );
            await tips
                .first()
                .waitFor({ state: 'hidden', timeout: 900 })
                .catch(() => {});
            if (await tips.count()) continue; // Unrelated existing tips cannot label this control.
            await loc.hover({ timeout: 1500 });
            await tips
                .first()
                .waitFor({ state: 'visible', timeout: 650 })
                .catch(() => {});
            await page.waitForTimeout(350);
            // Unlabelled controls require an explicit tooltip relationship. Legacy
            // labelled icons also accept a single tip that appears only after hover.
            if (
                (await tips.count()) === 1 &&
                (icon.name || (await loc.getAttribute('aria-describedby')))
            ) {
                const label = ((await tips.first().textContent()) || '').trim();
                if (label && label.length < 100 && icon.name)
                    await loc.evaluate((e, label) => {
                        const key = Symbol.for('laya.tooltipLabels');
                        globalThis[key] ||= new WeakMap();
                        globalThis[key].set(e, {
                            label,
                            fingerprint: e.outerHTML.replace(/ data-laya-live-ref="[^"]*"/g, ''),
                        });
                    }, label);
            }
        } catch {}
    }
    await page.mouse.move(0, 0);
    return observe(page);
}
async function chooseLiveTarget(
    laya,
    intent,
    kind,
    candidates,
    snap,
    { ordinal, instruction, minProbability, minMargin, meta },
) {
    const ranked = candidates
        .map((c) => ({ ...c, rank: score(intent, c) }))
        .sort((a, b) => b.rank - a.rank);
    const unique = [];
    for (const c of ranked) {
        // A nested accessible input within its combobox is not a second target.
        if (
            unique.some(
                (x) =>
                    x.name === c.name &&
                    x.context === c.context &&
                    x.role === c.role &&
                    x.frame === c.frame &&
                    x.href === c.href,
            )
        )
            continue;
        unique.push(c);
    }
    const shortlist = unique.slice(0, 5);
    const exactContexts = [
        ...new Set(ranked.filter((c) => c.name === intent).map((c) => c.context)),
    ];
    const source = norm(instruction || intent);
    if (
        exactContexts.length > 1 &&
        !exactContexts.some((context) => context && source.includes(norm(context)))
    )
        throw new Halt('目标不唯一', `多个区域存在“${intent}”，请在步骤写明记录名称或区域。`);
    const en = /[a-z]/i.test(intent) && !/[\u4e00-\u9fff]/.test(intent);
    const prefix = en
        ? {
              fill: 'Fill ',
              clear: 'Clear ',
              select: 'Select ',
              option: 'Choose ',
              check: 'Check ',
              uncheck: 'Uncheck ',
              hover: 'Hover over ',
              click: 'Click ',
          }[kind] || 'Find '
        : {
              fill: '填写',
              clear: '清空',
              select: '选择',
              option: '选择',
              check: '勾选',
              uncheck: '取消勾选',
              hover: '悬停在',
              click: '点击',
          }[kind] || '查看';
    const keyed = shortlist.map((c, i) => ({
        key:
            c.name.slice(0, 36) +
            (['停止', 'Stop'].includes(c.name.slice(0, 36)) ||
            shortlist.filter((x) => x.name.slice(0, 36) === c.name.slice(0, 36)).length > 1
                ? ' [' + (c.context.slice(0, 16) || c.role) + '] #' + i
                : ''),
        control: c,
    }));
    const recordedAction = ordinal ? `点击第 ${ordinal} 个「${intent}」按钮` : null;
    const criteria = Object.fromEntries(
        keyed.map(({ key, control: c }) => [
            key,
            recordedAction ||
                [prefix + c.name.slice(0, 60), c.role, c.context?.slice(0, 45)]
                    .filter(Boolean)
                    .join(' · '),
        ]),
    );
    const stopKey = en ? 'Stop' : '停止';
    criteria[stopKey] = en ? 'Do not perform any action' : '不执行';
    const state = recordedAction
        ? `用户录制的步骤：${recordedAction}。已在当前页面按名称核对按钮顺序，候选对应此位置。`
        : instruction || prefix + intent;
    const decision = await laya.choose(state, criteria, {
        ...meta,
        phase: 'target',
        url: snap.url,
        candidate_count: snap.controls.length,
        candidates: shortlist.map(({ ref, ...c }) => c),
    });
    if (decision.choice === stopKey)
        throw new Halt('Laya无法判断', `Laya未找到匹配控件：${intent}`);
    const c = keyed.find((x) => x.key === decision.choice)?.control;
    if (!c) throw new Halt('模型结果无效', '模型返回无法映射到当前DOM的目标');
    if (
        (decision.probabilities?.[decision.choice] || 0) < minProbability ||
        decision.margin < minMargin
    )
        throw new Halt('Laya选择不确定', `目标“${intent}”的候选评分或差距不足，停止本步。`);
    return { control: c, decision };
}

export async function target(
    page,
    laya,
    intent,
    {
        kind = 'click',
        decisionStrategy = laya?.decisionStrategy,
        instruction,
        role,
        meta = {},
        rowKey,
        ordinal,
        allowDisabled = false,
        requireMenu = false,
        minProbability = 0.68,
        minMargin = 0.18,
    } = {},
) {
    let snap = await observe(page);
    const namedMenu = (c) =>
        !c.rowKey &&
        ['link', 'menuitem', 'button', 'tab', 'treeitem'].includes(c.role) &&
        norm(c.name) === norm(intent);
    const eligible = (c) => {
        if (
            c.role === 'password' ||
            (role && c.role !== role) ||
            (!allowDisabled && c.disabled) ||
            (rowKey && c.rowKey !== rowKey)
        )
            return false;
        if (requireMenu) return namedMenu(c);
        if (['fill', 'clear', 'value', 'empty'].includes(kind))
            return (
                !c.readonly &&
                (['textbox', 'spinbutton'].includes(c.role) ||
                    (['fill', 'clear'].includes(kind) && c.editableCombobox && c.name === intent))
            );
        if (kind === 'select') return c.role === 'combobox' || c.tag === 'select';
        if (['check', 'uncheck', 'checked'].includes(kind))
            return ['checkbox', 'radio', 'switch'].includes(c.role);
        if (kind === 'option') return ['option', 'menuitem', 'button'].includes(c.role);
        return true;
    };
    const named = (c) => eligible(c) && score(intent, c) >= 65;
    const disabledExact = (snapshot) =>
        !allowDisabled &&
        snapshot.controls.some(
            (c) => c.name === intent && c.disabled && eligible({ ...c, disabled: false }),
        ) &&
        !snapshot.controls.some((c) => c.name === intent && eligible(c));
    const orderedLocator =
        ordinal && page.getByRole('button', { name: intent, exact: true }).nth(ordinal - 1);
    const hasIcons = (snapshot) =>
        ['click', 'hover'].includes(kind) &&
        (snapshot.controls.some((c) => c.rowKey === (rowKey || '') && /^图标[:：]/.test(c.name)) ||
            snapshot.unidentifiedControls.some((c) => c.rowKey === (rowKey || '')));
    const choices = (snapshot) =>
        snapshot.controls.filter((c) => eligible(c) && c.name && !/^图标[:：]/.test(c.name));
    const decisionOptions = { ordinal, instruction, minProbability, minMargin, meta };
    const retryRules = () =>
        target(page, laya, intent, {
            kind,
            decisionStrategy: 'off',
            instruction,
            role,
            meta,
            rowKey,
            ordinal,
            allowDisabled,
            requireMenu,
            minProbability,
            minMargin,
        });
    let selection, earlyRejection;
    const initial = choices(snap);
    const sameChoices = (current) =>
        current.length === initial.length &&
        current.every((c, i) =>
            ['name', 'role', 'rowKey', 'context', 'href', 'frame'].every(
                (key) => c[key] === initial[i][key],
            ),
        );
    // Give a populated UI to Laya immediately. If it declines, allow late-rendered
    // exact controls and tooltip-only actions to appear before giving up.
    if (
        decisionStrategy !== 'off' &&
        !ordinal &&
        !requireMenu &&
        !disabledExact(snap) &&
        !snap.controls.some(named) &&
        initial.length
    ) {
        try {
            selection = await chooseLiveTarget(laya, intent, kind, initial, snap, decisionOptions);
        } catch (error) {
            if (decisionStrategy === 'model-first') return retryRules();
            if (!['Laya无法判断', 'Laya选择不确定'].includes(error.category)) throw error;
            earlyRejection = error;
        }
    }
    if (!selection && !snap.controls.some(named)) {
        if (hasIcons(snap)) snap = await discoverRowLabels(page, rowKey || '');
        for (
            let i = 0;
            i < 8 && !snap.controls.some(named) && !(requireMenu && snap.controls.some(namedMenu));
            i++
        ) {
            await page.waitForTimeout(250);
            snap = await observe(page);
            const current = choices(snap);
            if (
                decisionStrategy !== 'off' &&
                !requireMenu &&
                !disabledExact(snap) &&
                current.length &&
                (!earlyRejection || !sameChoices(current))
            ) {
                earlyRejection = null;
                break;
            }
        }
    }
    if (requireMenu) {
        const menus = snap.controls.filter(namedMenu);
        if (!menus.length) return null;
        if (menus.every((c) => c.disabled))
            throw new Halt('菜单不可用', '目标菜单已禁用：' + intent);
    }
    if (disabledExact(snap)) throw new Halt('控件不可用', `目标控件已禁用：${intent}`);
    let candidates = snap.controls.filter(eligible);
    if (orderedLocator) {
        const ref = await orderedLocator.getAttribute(ATTR, { timeout: 1200 }).catch(() => null);
        candidates = candidates.filter((c) => ref && c.frame === 0 && c.ref === ref);
        if (!candidates.length)
            throw new Halt('录制位置未确认', `没有找到第 ${ordinal} 个可用的「${intent}」按钮。`);
    }
    if (!selection && !candidates.some(named)) {
        if (earlyRejection) throw earlyRejection;
        const unknown = snap.unidentifiedControls.filter(
            (c) => (!rowKey || c.rowKey === rowKey) && !c.disabled,
        );
        candidates = candidates.filter((c) => c.name && !/^图标[:：]/.test(c.name));
        if (!candidates.length && unknown.length)
            throw new Halt(
                '控件语义不明确',
                `已发现 ${unknown.length} 个无标签控件，但不能确认“${intent}”的目标；请查看未识别控件诊断并提供标签或显式绑定。`,
            );
    }
    if (!candidates.length)
        throw new Halt('页面控件不足', `当前页面没有可用于${kind}的控件：${intent}`);
    if (!selection) {
        const exact = candidates.filter((c) => c.name === intent);
        if (exact.length === 1 && decisionStrategy === 'model-first') {
            // A model refusal or transport error can only fall back to a freshly verified exact match.
            const preferred = await modelOrRules(
                () => chooseLiveTarget(laya, intent, kind, candidates, snap, decisionOptions),
                () => null,
            );
            if (
                !preferred ||
                preferred.control.ref !== exact[0].ref ||
                preferred.control.frame !== exact[0].frame
            )
                return retryRules();
            selection = preferred;
        } else if (exact.length === 1) selection = { control: exact[0], decision: null };
        else if (decisionStrategy === 'off')
            throw new Halt(
                '决策模型已关闭',
                `规则无法唯一定位「${intent}」，请补充控件名称或所在区域。`,
            );
        else {
            const choose = () =>
                chooseLiveTarget(laya, intent, kind, candidates, snap, decisionOptions);
            selection =
                decisionStrategy === 'model-first'
                    ? await modelOrRules(choose, () => null)
                    : await choose();
            if (!selection) return retryRules();
        }
    }
    // A component can be relabelled or replaced while the model is deciding.
    // Re-observe and keep the same element identity and action semantics.
    if (selection.decision && !selection.control.binding && !ordinal) {
        const chosen = selection.control;
        const frame = snap.frames[chosen.frame];
        const handles = await frame.locator(`[${ATTR}="${chosen.ref}"]`).elementHandles();
        try {
            snap = await observe(page);
            const ref = handles.length === 1 && (await handles[0].getAttribute(ATTR));
            candidates = snap.controls.filter(eligible);
            const live = candidates.find((c) => snap.frames[c.frame] === frame && c.ref === ref);
            if (
                !live ||
                ['name', 'role', 'rowKey', 'context', 'href'].some(
                    (key) => live[key] !== chosen[key],
                )
            )
                throw new Halt('DOM已变化', '模型判断期间目标控件发生变化，当前步骤停止。');
            const exact = candidates.filter((c) => c.name === intent);
            if (exact.length && live.name !== intent) {
                if (exact.length !== 1) throw new Halt('目标不唯一', `多个控件匹配“${intent}”。`);
                selection = { control: exact[0], decision: null };
            } else selection.control = live;
        } finally {
            await Promise.all(handles.map((h) => h.dispose()));
        }
    }
    const { control: c, decision } = selection;
    const locator = snap.frames[c.frame].locator(`[${ATTR}="${c.ref}"]`);
    if ((await locator.count()) !== 1 || !(await locator.isVisible()))
        throw new Halt('DOM已变化', '决定完成后DOM已变化，当前步骤停止，避免误点。');
    if (
        orderedLocator &&
        (await orderedLocator.getAttribute(ATTR, { timeout: 1200 }).catch(() => null)) !== c.ref
    )
        throw new Halt('DOM已变化', '模型判断期间同名按钮的位置发生变化，当前步骤停止。');
    if (c.binding) {
        const valid =
            page.url() === c.binding.url &&
            (await locator.evaluate((e, c) => {
                const roots = [document];
                for (let i = 0; i < roots.length; i++)
                    for (const node of roots[i].querySelectorAll('*'))
                        if (node.shadowRoot) roots.push(node.shadowRoot);
                const matches = roots.flatMap((root) => [
                    ...root.querySelectorAll(c.binding.selector),
                ]);
                return (
                    matches.length === 1 &&
                    matches[0] === e &&
                    globalThis[Symbol.for('laya.controlBindings')]?.get(e)?.ref === c.ref &&
                    e.outerHTML.replace(/ data-laya-live-ref="[^"]*"/g, '') ===
                        globalThis[Symbol.for('laya.controlBindings')]?.get(e)?.fingerprint &&
                    (e.closest('tr,[role="row"]')?.outerHTML || '').replace(
                        / data-laya-live-ref="[^"]*"/g,
                        '',
                    ) === globalThis[Symbol.for('laya.controlBindings')]?.get(e)?.rowFingerprint
                );
            }, c));
        if (!valid)
            throw new Halt('DOM已变化', '显式控件绑定在决策期间发生变化，停止本步并重新校验。');
    }
    // Distinct identical controls require an explicit row/region, not a guessed index.
    const identical = candidates.filter(
        (x) => x.name === c.name && x.role === c.role && x.context === c.context,
    );
    if (identical.length > 1) {
        let nested = true;
        for (const other of identical) {
            if (other.ref === c.ref) continue;
            const rel = await snap.frames[c.frame].evaluate(
                ({ a, b, attr }) => {
                    const x = document.querySelector(`[${attr}="${a}"]`),
                        y = document.querySelector(`[${attr}="${b}"]`);
                    return x && y && (x.contains(y) || y.contains(x));
                },
                { a: c.ref, b: other.ref, attr: ATTR },
            );
            if (!rel) nested = false;
        }
        if (!nested)
            throw new Halt('目标不唯一', `存在多个同名同上下文控件“${c.name}”，需要补充区域。`);
    }
    return { locator, control: c, decision };
}
export async function settle(page, ms = 250) {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(ms);
    // Avoid networkidle: polling/WebSocket applications may never become idle.
    await page
        .locator('[aria-busy="true"]:visible,.ant-spin-spinning:visible,.el-loading-mask:visible')
        .first()
        .waitFor({ state: 'hidden', timeout: 5000 })
        .catch(() => {});
}
export async function assertionTarget(page, name, kind, { rowKey } = {}) {
    const snap = await observe(page);
    let items = snap.controls.filter((c) => c.role !== 'password');
    if (rowKey) items = items.filter((c) => c.rowKey === rowKey);
    if (['empty', 'value'].includes(kind))
        items = items.filter((c) => ['textbox', 'spinbutton', 'combobox'].includes(c.role));
    if (kind === 'checked')
        items = items.filter((c) => ['checkbox', 'radio', 'switch'].includes(c.role));
    if (kind === 'selected') items = items.filter((c) => c.role === 'tab');
    const exact = items.filter((c) => norm(c.name) === norm(name));
    const matches = exact.length
        ? exact
        : items.filter(
              (c) => norm(c.placeholder) === norm(name) || norm(c.name) === norm('请输入' + name),
          );
    if (matches.length !== 1)
        throw new Halt(
            '断言目标不唯一',
            `预期中的“${name}”对应${matches.length}个明确控件，无法证明断言`,
        );
    const control = matches[0],
        locator = snap.frames[control.frame].locator(`[${ATTR}="${control.ref}"]`);
    return { control, locator };
}
