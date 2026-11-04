export const OPERATIONS = [
    'tabs',
    'tab-switch',
    'table',
    'filters',
    'form-validation',
    'form-invalid',
    'create',
    'search',
    'view',
    'edit',
    'delete',
    'discover',
];
export const READ_OPERATIONS = ['tabs', 'tab-switch', 'table', 'filters'];

export function workflowPolicy(config) {
    const supplied = config.operations !== undefined && config.operations !== '';
    const operations = supplied
        ? Array.isArray(config.operations)
            ? config.operations
            : String(config.operations)
                  .split(',')
                  .map((op) => op.trim())
        : config.readOnly
          ? READ_OPERATIONS
          : OPERATIONS;
    if (!operations.length || operations.some((op) => !OPERATIONS.includes(op)))
        throw Error('--operations 包含不支持的操作；允许：' + OPERATIONS.join(','));
    if (config.readOnly && operations.some((op) => !READ_OPERATIONS.includes(op)))
        throw Error('--read-only 只允许 tabs,tab-switch,table,filters');
    const allowed = new Set(operations);
    for (const op of ['search', 'view', 'edit', 'delete']) {
        if (allowed.has(op) && !allowed.has('create'))
            throw Error(`${op} 依赖本轮 create，请同时选择 create；只读检查使用 table,filters`);
    }
    return allowed;
}

export function enforceReplayPolicy(file, config) {
    const allowed = workflowPolicy(config);
    for (const c of file.cases) {
        if (!allowed.has(c.operation)) throw Error(`回放用例 ${c.id} 超出 --operations 范围`);
        if (config.readOnly) {
            for (const step of c.steps) {
                const assertion = [
                    'assert-control',
                    'assert-selected',
                    'assert-headers',
                    'assert-disabled',
                    'assert-text',
                ].includes(step.kind);
                const tab =
                    step.kind === 'click' && step.purpose === 'tab' && step.target?.role === 'tab';
                if (!assertion && !tab && step.kind !== 'reload')
                    throw Error('只读回放包含不允许的步骤：' + step.kind);
            }
        }
    }
    return allowed;
}
