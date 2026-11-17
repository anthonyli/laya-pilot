const byPage = new WeakMap();

export function validateControlBindings(bindings) {
    if (!Array.isArray(bindings) || bindings.length > 100)
        throw Error('--control-bindings 必须是最多 100 项的 JSON 数组');
    return bindings.map((binding) => {
        if (
            !binding ||
            typeof binding !== 'object' ||
            Array.isArray(binding) ||
            Object.keys(binding).some((key) => !['url', 'selector', 'name'].includes(key)) ||
            ['url', 'selector', 'name'].some(
                (key) => typeof binding[key] !== 'string' || !binding[key].trim(),
            )
        )
            throw Error('每个控件绑定必须且只能包含 url、selector、name');
        const url = new URL(binding.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
            throw Error('控件绑定 url 必须是不含凭据的 HTTP(S) 完整地址');
        if (
            binding.name.length > 100 ||
            /^图标[:：]/.test(binding.name) ||
            /:(?:nth|first|last|only)-|data-laya-|>>/.test(binding.selector)
        )
            throw Error('控件绑定需要明确名称和稳定 CSS 选择器，不能使用位置或临时引用');
        return { url: url.href, selector: binding.selector.trim(), name: binding.name.trim() };
    });
}

export function configureControlBindings(page, bindings = []) {
    byPage.set(page, validateControlBindings(bindings));
}

export function controlBindingsFor(page) {
    return byPage.get(page) || [];
}
