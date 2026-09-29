// Candidate values always come from the visible form. The model chooses a
// semantic group; equivalent options use a stable tie break for reproducibility.
export const accountField = /^(登录账号|登录账户|账号|账户|login|account|username)$/i;
export const expiryField = /过期|到期|有效期|expiry|expiration|expires/i;
const privileged = /管理员|超级|全部|所有|admin|superuser|root|full.access/i;
const testing = /测试|自动化|test|sandbox|demo/i;
const ordinary = /只读|查看者|普通|访客|read.only|viewer|guest|basic/i;

export function optionGroups(label, options) {
    const permission = /角色|权限|role|permission/i.test(label);
    const groups = new Map();
    for (const option of options) {
        if (/^(全部|所有|请选择|无)$/.test(option.name)) continue;
        if (permission && privileged.test(option.name)) continue;
        const group = ordinary.test(option.name)
            ? '普通或只读选项'
            : testing.test(option.name)
              ? '测试用途选项'
              : '其他可用选项';
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(option);
    }
    for (const values of groups.values())
        values.sort(
            (a, b) =>
                Number(!!a.branch) - Number(!!b.branch) ||
                a.name.length - b.name.length ||
                a.name.localeCompare(b.name),
        );
    return groups;
}

export async function chooseTestOption(laya, label, options) {
    const groups = optionGroups(label, options);
    if (!groups.size) throw Error(`「${label}」没有适合自动生成测试数据的选项`);
    const criteria = Object.fromEntries(
        [...groups].map(([group, values]) => [
            group,
            `为「${label}」选择${group}，页面实际可选值：${values.map((x) => x.name).join('、')}`,
        ]),
    );
    criteria['停止'] = '没有适合临时测试记录的可用选项，停止填写';
    const decision = await laya.choose(
        `正在生成可清理的临时测试记录。「${label}」优先使用普通或只读选项，其次使用测试用途选项；只有没有这些选项时使用其他可用选项。应选择哪组？`,
        criteria,
        {
            phase: 'form-option',
            purpose: '生成表单测试数据',
            field: label,
            candidates: options.map(({ name, branch }) => ({ name, branch })),
        },
    );
    const group = groups.get(decision.choice);
    if (!group || (decision.probabilities?.[decision.choice] || 0) < 0.5 || decision.margin < 0.1)
        throw Error(`模型未能确定「${label}」的测试数据，未提交表单`);
    return group[0];
}

// Laya selects a data recipe from observed field semantics. The executor creates
// the value, so record identifiers remain unique and replay can bind fresh data.
export async function chooseFieldValue(laya, field, { name = '${recordName}', index = 0 } = {}) {
    const criteria = {
        账号: '填写登录账号、登录账户或 account 标识',
        名称: '填写名称、姓名、用户名或标题',
        邮箱: '填写电子邮箱 email 地址',
        电话: '填写手机号码或联系电话',
        数值: '填写数字、数量或数值区间',
        日期: '填写过期日期、到期时间或有效期',
        文本: '填写普通文本、描述或备注',
        停止: '字段用途不明确，无法生成测试值',
    };
    const decision = await laya.choose(
        `填写「${field.label || field.placeholder}」${field.placeholder ? '，提示：' + field.placeholder : ''}${field.type && !['input', 'text', 'textarea'].includes(field.type) ? '，输入类型：' + field.type : ''}`,
        criteria,
        { phase: 'form-field', field: field.label, input: { ...field, value: undefined } },
    );
    if (
        !Object.hasOwn(criteria, decision.choice) ||
        decision.choice === '停止' ||
        (decision.probabilities?.[decision.choice] || 0) < 0.5 ||
        decision.margin < 0.1
    )
        throw Error(`模型未能确定「${field.label || field.placeholder}」的填表策略`);
    const interval = `${field.label} ${field.placeholder}`.match(
        /\[\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\)/,
    );
    const minimum = field.min === '' || field.min == null ? 1 : Number(field.min);
    const maximum = field.max === '' || field.max == null ? Infinity : Number(field.max);
    const values = {
        账号: '${recordAccount}',
        名称: name,
        邮箱: '${recordAccount}@example.com',
        电话: '13800000000',
        数值: interval?.[0] || String(Math.min(minimum, maximum)),
        日期: '${expiryDate}',
        文本: index ? `${name}_${index + 1}` : name,
    };
    return {
        kind: decision.choice === '日期' ? 'date' : 'fill',
        value: values[decision.choice],
        strategy: decision.choice,
    };
}

export function tomorrowDate(now = new Date()) {
    const date = new Date(now);
    date.setDate(date.getDate() + 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
