// These DOM helpers also run in the recorder and the standalone Playwright script.
export function treeNodePath(node) {
    const path = [];
    const tree = node.closest('[role=tree]');
    for (
        let item = node;
        item && item.closest('[role=tree]') === tree;
        item = item.parentElement?.closest('[role=treeitem]')
    ) {
        const title = item.querySelector(
            ':scope > .ant-tree-node-content-wrapper .ant-tree-title, :scope > .ant-tree-title',
        );
        const name = title?.innerText.trim() || item.getAttribute('aria-label');
        if (!name) return null;
        path.unshift(name);
    }
    return path;
}

// Store a rendered line number and character boundary. Recompute pixels in the playback viewport.
export function editorPoint(root, point) {
    const margins = [...root.querySelectorAll('.margin-view-overlays .line-numbers')];
    for (const line of root.querySelectorAll('.view-lines > .view-line')) {
        const rect = line.getBoundingClientRect();
        const margin = margins.find((el) => el.parentElement.style.top === line.style.top);
        const number = Number(margin?.textContent);
        if (!Number.isSafeInteger(number) || number < 1) continue;
        if (
            point.line !== undefined
                ? number !== point.line
                : point.y < rect.top || point.y >= rect.bottom
        )
            continue;
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        if (line.textContent.length > 8192) return null;
        const range = document.createRange();
        let column = 1,
            closest = 1,
            distance = Infinity;
        let x = rect.left;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const target = point.column === 'end' ? node.length : point.column - column;
            const first = point.line === undefined ? 0 : Math.max(0, target);
            const last = point.line === undefined ? node.length : Math.min(node.length, target);
            for (let offset = first; offset <= last; offset++) {
                range.setStart(node, offset);
                range.collapse(true);
                const box = range.getBoundingClientRect();
                if (!box.height) continue;
                x = box.left;
                if (point.line !== undefined && column + offset === point.column)
                    return { x, y: rect.top + rect.height / 2 };
                const delta = Math.abs(point.x - x);
                if (delta < distance) {
                    closest = column + offset;
                    distance = delta;
                }
            }
            column += node.length;
        }
        if (point.line === undefined)
            return { line: number, column: closest === column ? 'end' : closest };
        if (point.column === column || point.column === 'end')
            return { x, y: rect.top + rect.height / 2 };
    }
    return null;
}

export const editorKeys = [
    'Backspace',
    'Delete',
    'Enter',
    'Tab',
    'Escape',
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
    'Home',
    'End',
    'ControlOrMeta+a',
    'ControlOrMeta+z',
    'ControlOrMeta+Shift+z',
    'Shift+ArrowLeft',
    'Shift+ArrowRight',
    'Shift+ArrowUp',
    'Shift+ArrowDown',
    'Shift+Home',
    'Shift+End',
];

export function editorStep(operation) {
    // Keep literal template expressions in recorded source separate from workbook variables.
    return '编辑器操作 ' + JSON.stringify(operation).replaceAll('$', '\\u0024');
}

export async function replayEditorOperation(page, op, data = {}, timeout = 5000) {
    if (op.type === 'tree') {
        const nodes = page.locator('[role=tree] [role=treeitem]:visible');
        const matches = [];
        const handles = await nodes.elementHandles();
        try {
            for (const node of handles)
                if (JSON.stringify(await node.evaluate(treeNodePath)) === JSON.stringify(op.path))
                    matches.push(node);
            if (matches.length !== 1) throw Error('无法唯一定位树节点：' + JSON.stringify(op.path));
            const branch = op.part === 'toggle';
            if (!branch && op.part !== 'title') throw Error('树节点操作无法识别');
            const target = await matches[0].$(
                branch
                    ? ':scope > .ant-tree-switcher:not(.ant-tree-switcher-noop)'
                    : ':scope > .ant-tree-node-content-wrapper',
            );
            if (!target) throw Error('找不到树节点的展开按钮或标题');
            try {
                const expanded = () =>
                    matches[0].evaluate(
                        (el) =>
                            el.getAttribute('aria-expanded') === 'true' ||
                            el.classList.contains('ant-tree-treenode-switcher-open'),
                    );
                if (branch && typeof op.expanded !== 'boolean') throw Error('树节点缺少展开状态');
                if (!branch || (await expanded()) !== op.expanded) await target.click({ timeout });
                if (branch && (await expanded()) !== op.expanded)
                    throw Error('树节点展开状态未生效');
            } finally {
                await target.dispose();
            }
        } finally {
            await Promise.all(handles.map((node) => node.dispose()));
        }
        return;
    }
    const root = page.locator('.monaco-editor').filter({ visible: true });
    await root.waitFor({ state: 'visible', timeout });
    const input = root.locator('textarea.inputarea');
    if (op.type === 'suggest') {
        const label = page.locator('.label-name').and(page.getByText(op.name, { exact: true }));
        const row = root
            .locator(
                '.suggest-widget.visible [role=option], .suggest-widget.visible .monaco-list-row',
            )
            .filter({ visible: true, has: label });
        await row.click({ timeout });
        return;
    }
    if (!(await input.isEditable({ timeout }))) throw Error('Monaco 编辑器不可编辑');
    if (op.type === 'cursor') {
        await root.scrollIntoViewIfNeeded({ timeout });
        const locate = async (point) => {
            if (
                !Number.isSafeInteger(point?.line) ||
                point.line < 1 ||
                (point.column !== 'end' &&
                    (!Number.isSafeInteger(point.column) || point.column < 1))
            )
                throw Error('编辑器光标位置无效');
            const pos = await root.evaluate(editorPoint, point);
            if (
                !pos ||
                !(await root.evaluate(
                    (el, p) => el.contains(document.elementFromPoint(p.x, p.y)),
                    pos,
                ))
            )
                throw Error('录制的编辑位置不可见');
            return pos;
        };
        const start = await locate(op.from);
        if (op.to) {
            const end = await locate(op.to);
            await page.mouse.move(start.x, start.y);
            await page.mouse.down();
            try {
                await page.mouse.move(end.x, end.y, { steps: 6 });
            } finally {
                await page.mouse.up();
            }
        } else await page.mouse.click(start.x, start.y);
        return;
    }
    await input.focus({ timeout });
    if (op.type === 'key' && editorKeys.includes(op.key)) {
        await input.press(op.key, { timeout });
    } else if (op.type === 'text') {
        const value = op.parameter ? data[op.parameter] : op.value;
        if (typeof value !== 'string' || value.length > 4096)
            throw Error('编辑器输入缺少有效的文本参数');
        if (op.input === 'insert') await page.keyboard.insertText(value);
        else await page.keyboard.type(value);
    } else throw Error('无法回放这项编辑器操作');
}
