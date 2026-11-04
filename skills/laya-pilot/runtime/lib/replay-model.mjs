// Ground recorded actions in the live page without changing their test data.
export async function matchReplayTarget(
    laya,
    action,
    expected,
    candidates,
    config = {},
    meta = {},
) {
    const matches = candidates.filter((c) => c.name === expected);
    if (matches.length !== 1) throw Error(`用例目标「${expected}」在当前页面不唯一或已不存在`);
    const names = new Set([expected]);
    const shortlist = [matches[0]];
    for (const candidate of candidates) {
        if (names.has(candidate.name)) continue;
        names.add(candidate.name);
        shortlist.push(candidate);
        if (shortlist.length === 7) break;
    }
    const criteria = {},
        byChoice = new Map();
    shortlist.forEach((candidate, i) => {
        const key = `目标${i + 1}`;
        criteria[key] = `${action}「${candidate.name}」控件`;
        byChoice.set(key, candidate);
    });
    criteria['停止'] = '没有匹配的控件，停止操作';
    const result = await laya.choose(`我要${action}「${expected}」。`, criteria, {
        ...meta,
        phase: 'replay-target',
        mode: 'execute',
        action,
        expected,
        candidates: shortlist.map(({ name, description }) => ({ name, description })),
    });
    const selected = byChoice.get(result.choice);
    if (
        selected?.name !== expected ||
        !(result.probabilities?.[result.choice] >= (config.minProbability ?? 0.68)) ||
        !(result.margin >= (config.minMargin ?? 0.18))
    )
        throw Error(`Laya 未能匹配用例指定的回放目标「${expected}」，未改选其他值`);
    return selected;
}
