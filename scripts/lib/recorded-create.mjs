import { businessResponseFailed } from './diagnostics.mjs';

// These helpers are embedded in standalone recordings as well as used by Excel replay.
export const createExpectation = '保存后列表新增与本次表单标识匹配的唯一记录';

export function readCreateState(adapters) {
    const ui = typeof adapters === 'string' ? { dialog: adapters } : adapters || {};
    const dialogSelector =
        ui.dialog || 'dialog[open],[role=dialog],.ant-drawer-open .ant-drawer-content';
    const formItem = ui.form?.item || '.ant-form-item,.el-form-item';
    const formLabel = ui.form?.label || 'label';
    const tableWrapper = ui.table?.wrapper || '.ant-table-wrapper';
    const pagination =
        ui.table?.pagination || '.ant-pagination,.el-pagination,[aria-label="pagination" i]';
    const tableSelector = 'table,[role=table],[role=grid],[role=treegrid]';
    const normalize = (value) =>
        String(value || '')
            .replace(/\s+/g, ' ')
            .trim();
    const visible = (element) =>
        element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible';
    const shown = (root, selector) => [...root.querySelectorAll(selector)].filter(visible);
    function identity(label) {
        const name = normalize(label)
            .replace(/^\*\s*|\s*[:：*]$/g, '')
            .toLowerCase();
        if (/^(?:(?:[\w-]+\s+)*(?:name|title)|名称|.+名称|订单名|指标名)$/.test(name))
            return 'name';
        if (
            /^(?:(?:[\w-]+\s+)*(?:id|identifier|identification|code)|标识|编号|.+(?:标识|编号))$/.test(
                name,
            )
        )
            return 'id';
        return null;
    }
    const dialogs = shown(document, dialogSelector);
    const forms = shown(document, 'form');
    const scope =
        dialogs.length === 1 ? dialogs[0] : !dialogs.length && forms.length === 1 ? forms[0] : null;
    const fields = { name: [], id: [] };
    for (const input of scope ? shown(scope, 'input:not([type]),input[type=text],textarea') : []) {
        const label =
            input.getAttribute('aria-label') ||
            [...(input.labels || [])].map((el) => el.innerText).join(' ') ||
            input.closest(formItem)?.querySelector(formLabel)?.innerText ||
            input.placeholder;
        const key = identity(label);
        const value = normalize(input.value);
        if (key && value && fields[key].indexOf(value) < 0) fields[key].push(value);
    }
    const errors = shown(
        document,
        '[role=alert],[role=status],.ant-message-error,.ant-notification-notice-error,.el-message--error',
    )
        .map((el) => normalize(el.innerText))
        .filter((value) =>
            /失败|错误|已存在|重复|必填|error|failed|invalid|required|already exists|duplicate|denied/i.test(
                value,
            ),
        );
    const invalid =
        !!scope &&
        shown(
            scope,
            '[aria-invalid=true],.ant-form-item-has-error,.ant-form-item .has-error,.ant-form-item-explain-error:not(:empty),.el-form-item.is-error',
        ).length > 0;
    const tables = [];
    const tableIds = (window[Symbol.for('laya.create-check.tables')] ??= {
        ids: new WeakMap(),
        next: 0,
    });
    for (const table of shown(document, tableSelector)) {
        if (
            table.closest(dialogSelector) ||
            table.closest(
                '[hidden],[role=tabpanel][aria-hidden=true],.ant-tabs-tabpane-inactive,.ant-table-fixed-left,.ant-table-fixed-right,.ant-table-header,.ant-table-body-inner',
            )
        )
            continue;
        const owner = table.closest(tableWrapper) || table;
        const headersOf = (el) =>
            [...el.querySelectorAll('thead th:not([scope=row]),[role=columnheader]')].map((cell) =>
                normalize(cell.textContent),
            );
        let headers = headersOf(table);
        if (!headers.length && owner !== table) {
            const header = owner.querySelector('.ant-table-header');
            if (header) headers = headersOf(header);
        }
        const columns = headers.map(identity);
        if (!columns.some(Boolean) && !ui.table?.name && !ui.table?.id) continue;
        const rowValues = [];
        for (const row of shown(table, 'tbody tr,[role=row]')) {
            if (
                row.closest(tableSelector) !== table ||
                row.closest('thead') ||
                row.querySelector('[role=columnheader]') ||
                row.matches('.ant-table-placeholder,.ant-table-measure-row')
            )
                continue;
            const cells = [...row.children];
            if (!cells.length || (cells.length === 1 && cells[0].colSpan > 1)) continue;
            const values = { name: [], id: [], rowKey: row.getAttribute('data-row-key') };
            const sources = columns.flatMap((key, i) =>
                key && cells[i] ? [{ key, cell: cells[i] }] : [],
            );
            for (const key of ['name', 'id']) {
                const selector = ui.table?.[key];
                if (!selector) continue;
                const targets = shown(row, selector).filter(
                    (el) =>
                        el.closest(tableSelector) === table && el.closest('tr,[role=row]') === row,
                );
                if (targets.length === 1) sources.push({ key, cell: targets[0] });
                if (targets.length > 1) values.ambiguous = true;
            }
            for (const { key, cell } of sources) {
                const pieces = new Set([normalize(cell.innerText)]);
                const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
                while (walker.nextNode()) {
                    if (visible(walker.currentNode.parentElement)) {
                        pieces.add(normalize(walker.currentNode.nodeValue));
                        pieces.add(normalize(walker.currentNode.parentElement.innerText));
                    }
                }
                for (const part of pieces) {
                    if (!part) continue;
                    const code = part.match(
                        /^(?:Identification|ID|Identifier|标识|编号)\s*[:：]\s*(.+)$/i,
                    );
                    if (code) values.id.push(normalize(code[1]));
                    else values[key].push(part);
                }
            }
            rowValues.push(values);
        }
        const pagers = shown(owner, pagination);
        const pager = pagers.length === 1 ? pagers[0] : null;
        const summary = normalize(pager?.innerText);
        const count = summary.match(/(?:total\s*|共\s*)([\d,]+)\s*(?:条|records?|items?|$)/i);
        const rowCount = table.getAttribute('aria-rowcount');
        const virtual =
            rowCount !== null && (Number(rowCount) < 0 || Number(rowCount) > rowValues.length + 1);
        if (!tableIds.ids.has(owner)) tableIds.ids.set(owner, ++tableIds.next);
        tables.push({
            key: tableIds.ids.get(owner),
            headers,
            rows: rowValues,
            total: count
                ? Number(count[1].replaceAll(',', ''))
                : pagers.length || virtual
                  ? null
                  : rowValues.length,
        });
    }
    return {
        fields,
        tables,
        errors,
        invalid,
        url: location.href,
        documentTime: performance.timeOrigin,
    };
}

export function compareCreateStates(before, after) {
    const uncertain = (reason) => ({ status: '未验证', reason });
    if (after.invalid || after.errors.some((error) => !before.errors.includes(error)))
        return { status: '失败', reason: '保存后出现表单校验或页面错误。' };
    if (before.url !== after.url) return uncertain('保存后页面地址发生了变化，无法核对同一列表。');
    const pairs = [];
    for (const current of after.tables) {
        const schema = JSON.stringify(current.headers);
        const sameSchema = before.tables.filter(
            (table) => JSON.stringify(table.headers) === schema,
        );
        const sameTable =
            before.documentTime === after.documentTime &&
            sameSchema.find((table) => table.key === current.key);
        if (sameTable) pairs.push([sameTable, current]);
        else if (
            sameSchema.length === 1 &&
            after.tables.filter((table) => JSON.stringify(table.headers) === schema).length === 1
        )
            pairs.push([sameSchema[0], current]);
    }
    if (!pairs.length) return uncertain('无法唯一确定保存前后的业务列表。');
    const results = pairs.map(([original, current]) => {
        if ([...original.rows, ...current.rows].some((row) => row.ambiguous))
            return uncertain('业务表格中存在无法唯一定位的行标识。');
        const keys = ['id', 'name'].filter(
            (key) =>
                before.fields[key].length === 1 &&
                [...original.rows, ...current.rows].some((row) => row[key].length),
        );
        if (!keys.length) return uncertain('未取得可以与列表核对的本次表单 ID 或名称。');
        const matches = (row) => keys.every((key) => row[key].includes(before.fields[key][0]));
        const identity = keys[0];
        if (original.rows.some((row) => row[identity].includes(before.fields[identity][0])))
            return uncertain('保存前已经存在与本次表单标识匹配的记录。');
        if (original.total === null || current.total === null)
            return uncertain('分页列表未提供可核对的记录总数。');
        const matching = current.rows.filter(matches);
        if (matching.length === 1 && current.total === original.total + 1) {
            if ([...original.rows, ...current.rows].every((row) => row.rowKey)) {
                const previousKeys = new Set(original.rows.map((row) => row.rowKey));
                const added = current.rows.filter((row) => !previousKeys.has(row.rowKey));
                if (added.length !== 1 || added[0] !== matching[0])
                    return uncertain('列表行标识还存在其他变动，无法将新增行唯一归因于本次保存。');
            }
            return {
                status: '通过',
                reason: `记录总数由 ${original.total} 增至 ${current.total}，已找到与本次表单${keys.includes('id') ? '标识' : '名称'}匹配的唯一新行。`,
            };
        }
        if (current.total > original.total + 1 || matching.length > 1)
            return uncertain('观察到多条变动，无法唯一归因于本次保存。');
        return {
            status: '失败',
            reason: '保存后未同时观察到记录总数增加一条及与本次表单标识匹配的新行。',
        };
    });
    const passed = results.filter((result) => result.status === '通过');
    if (passed.length > 1) return uncertain('多个列表均新增了匹配记录，无法唯一确定目标列表。');
    return passed[0] || results.find((result) => result.status === '未验证') || results[0];
}

export async function verifyCreateClick(page, click, snapshot, compare, adapters, timeout = 5000) {
    const before = await page.evaluate(snapshot, adapters);
    // Watch only writes initiated during this click. An optimistic row or a success toast must
    // not mask an explicit saving error. Response bodies never enter artifacts or messages.
    const writes = new Set();
    let rejected = false;
    const track = (req) => {
        if (
            ['xhr', 'fetch'].includes(req.resourceType()) &&
            !['GET', 'HEAD', 'OPTIONS'].includes(req.method()) &&
            new URL(req.url()).origin === new URL(page.url()).origin
        )
            writes.add(req);
    };
    const failed = (req) => {
        if (writes.delete(req)) rejected = true;
    };
    const finish = async (response) => {
        const req = response.request();
        if (!writes.has(req)) return;
        try {
            if (response.status() >= 400) rejected = true;
            else if (/json/i.test(response.headers()['content-type'] || '')) {
                const body = await response.json();
                if (businessResponseFailed(body)) rejected = true;
            }
        } catch {
        } finally {
            writes.delete(req);
        }
    };
    page.on('request', track);
    page.on('requestfailed', failed);
    page.on('response', finish);
    try {
        await click();
        const deadline = Date.now() + timeout;
        let stable = null;
        for (;;) {
            const after = await page.evaluate(snapshot, adapters);
            if (rejected) return { status: '失败', reason: '保存请求明确返回失败。' };
            const result = compare(before, after);
            if (after.invalid || after.errors.some((error) => !before.errors.includes(error)))
                return result;
            if (result.status === '通过' && !writes.size) {
                stable ??= Date.now();
                if (Date.now() - stable >= 250) return result;
            } else stable = null;
            if (Date.now() >= deadline)
                return writes.size || result.status === '通过'
                    ? { status: '未验证', reason: '保存请求或列表尚未稳定。' }
                    : result;
            await page.waitForTimeout(80);
        }
    } finally {
        page.off('request', track);
        page.off('requestfailed', failed);
        page.off('response', finish);
    }
}
