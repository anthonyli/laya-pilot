const TABLE = 'table,[role="table"],[role="grid"],[role="treegrid"]';
const ROW = 'tr,[role="row"]';
const HEADER = 'th:not([scope="row"]),[role="columnheader"]';
const CELL = 'td,th[scope="row"],[role="cell"],[role="gridcell"],[role="rowheader"]';

function readRecords(tables, { column, value, match, fieldColumn, fieldValue, selectors }) {
    const visible = (element) => {
        const style = getComputedStyle(element);
        return (
            element.getClientRects().length > 0 &&
            style.display !== 'none' &&
            style.visibility === 'visible' &&
            !element.closest('[aria-hidden="true"],[inert]')
        );
    };
    const text = (element) => element.innerText.replace(/\s+/g, ' ').trim();
    const tablesInUse = tables.filter(visible);
    if (tablesInUse.length !== 1)
        return { reason: `当前可见的数据表数量为 ${tablesInUse.length}，无法唯一确定目标列表` };
    const [table] = tablesInUse;
    if (
        [
            ...document.querySelectorAll(
                '[aria-busy="true"],[role="progressbar"],.ant-spin-spinning,.el-loading-mask',
            ),
        ].some(visible) ||
        document.body.innerText
            .split('\n')
            .some((line) => /^(?:loading\.{0,3}|加载中[.。…]*|正在加载[.。…]*)$/i.test(line.trim()))
    )
        return { reason: '页面仍在加载，无法核对目标记录' };

    const rows = [...table.querySelectorAll(selectors.row)].filter(
        (row) =>
            row.closest(selectors.table) === table &&
            (visible(row) || [...row.children].some(visible)),
    );
    const headers = rows.filter((row) =>
        [...row.children].some((cell) => visible(cell) && cell.matches(selectors.header)),
    );
    if (headers.length !== 1) return { reason: '无法确定唯一的列表表头' };
    const [header] = headers;
    const headerCells = [...header.children];
    const findColumn = (name) =>
        headerCells.flatMap((cell, index) =>
            visible(cell) && cell.matches(selectors.header) && text(cell) === name ? [index] : [],
        );
    const columns = findColumn(column);
    if (columns.length !== 1) return { reason: `表头中无法唯一识别「${column}」列` };
    const [index] = columns;
    const fieldColumns = fieldColumn === undefined ? [] : findColumn(fieldColumn);
    if (match === 'field' && fieldColumns.length !== 1)
        return { reason: `表头中无法唯一识别「${fieldColumn}」列` };
    const [fieldIndex] = fieldColumns;
    const simpleCell = (cell, position) =>
        (cell.colSpan || 1) === 1 &&
        (cell.rowSpan ?? 1) === 1 &&
        Number(cell.getAttribute('aria-colspan') || 1) === 1 &&
        Number(cell.getAttribute('aria-rowspan') || 1) === 1 &&
        Number(cell.getAttribute('aria-colindex') || position + 1) === position + 1;
    if (!headerCells.every(simpleCell)) return { reason: '合并或重排列的表头无法严格定位' };

    let count = 0;
    let total = 0;
    let matchingField = 0;
    for (const row of rows) {
        if (row === header) continue;
        const cells = [...row.children];
        if (
            cells.length === 1 &&
            /^(?:暂无数据|无数据|暂无记录|无记录|没有数据|没有匹配(?:的)?(?:数据|记录)|no (?:data|results|records)(?: found)?)$/i.test(
                text(cells[0]),
            )
        )
            continue;
        if (
            !cells[index]?.matches(selectors.cell) ||
            !visible(cells[index]) ||
            (fieldIndex !== undefined &&
                (!cells[fieldIndex]?.matches(selectors.cell) || !visible(cells[fieldIndex]))) ||
            cells.length !== headerCells.length ||
            !cells.every(simpleCell)
        )
            return { reason: '列表存在无法按列核对的可见行' };
        total += 1;
        if (text(cells[index]) === value) {
            count += 1;
            if (fieldIndex !== undefined && text(cells[fieldIndex]) === fieldValue)
                matchingField += 1;
        }
    }
    const rowCount = table.getAttribute('aria-rowcount');
    if (
        ['absent', 'all'].includes(match) &&
        rowCount !== null &&
        (Number(rowCount) < 0 || Number(rowCount) > rows.length)
    )
        return { reason: '列表只呈现部分行，无法验证全部结果' };
    return { index, count, total, matchingField };
}

async function findRecords(table, spec) {
    const clean = (value) => value.replace(/\s+/g, ' ').trim();
    return table.evaluateAll(readRecords, {
        column: clean(spec.column),
        value: clean(spec.value),
        match: spec.match,
        fieldColumn: spec.fieldColumn === undefined ? undefined : clean(spec.fieldColumn),
        fieldValue: spec.fieldValue === undefined ? undefined : clean(spec.fieldValue),
        selectors: { table: TABLE, row: ROW, header: HEADER, cell: CELL },
    });
}

export async function verifyExactRecord(page, spec, timeout) {
    const table = page.locator(TABLE).filter({ visible: true });
    const deadline = Date.now() + timeout;
    const steadyFor = Math.min(200, timeout / 2);
    let stableSince = null;
    for (;;) {
        const reading = await findRecords(table, spec);
        const { count, total, matchingField, reason } = reading;
        const actual = { count, total, ...(spec.match === 'field' ? { matchingField } : {}) };
        const passed =
            !reason &&
            {
                present: count > 0,
                unique: count === 1,
                absent: count === 0,
                all: total > 0 && count === total,
                field: count === 1 && matchingField === 1,
            }[spec.match];
        const now = Date.now();
        stableSince = passed ? (stableSince ?? now) : null;
        if (passed && now - stableSince >= steadyFor)
            return { status: '通过', actual, reason: '已核对列表列值' };
        if (now >= deadline) {
            if (reason || passed) return { status: '未验证', reason: reason || '目标列表尚未稳定' };
            return {
                status: '失败',
                actual,
                reason: '当前列表的实际记录与预期不符',
            };
        }
        await page.waitForTimeout(Math.min(70, Math.max(1, deadline - now)));
    }
}

export async function exactRecordRow(page, spec) {
    const table = page.locator(TABLE).filter({ visible: true });
    const { index, count, reason } = await findRecords(table, spec);
    if (reason || count !== 1)
        return {
            reason: reason || `「${spec.column}」列有 ${count} 条精确匹配记录，不能定位唯一记录`,
        };

    const exactText = (value) =>
        new RegExp(
            '^\\s*' +
                value
                    .trim()
                    .split(/\s+/)
                    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                    .join('\\s+') +
                '\\s*$',
        );
    const position = `:nth-child(${index + 1})`;
    const header = page
        .locator(`:is(${HEADER})${position}`)
        .filter({ hasText: exactText(spec.column), visible: true });
    const cell = page
        .locator(`:is(${CELL})${position}`)
        .filter({ hasText: exactText(spec.value), visible: true });
    const row = table.filter({ has: header }).locator(ROW).filter({ has: cell, visible: true });
    if ((await row.count()) !== 1) return { reason: '页面变化后无法唯一定位记录' };
    return { row };
}
