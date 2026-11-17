# 无标签控件诊断与显式绑定

页面中找不到可靠名称的可交互控件保留在 `observe().unidentifiedControls`，不会作为无名称候选交给模型。诊断包含本轮临时 ref、frame、元素类型、role、id、表格行标识与上下文；临时 ref 只用于定位当前快照，不用于跨运行绑定。

普通 Excel 的 `results.json`、CSV、Markdown 和用例 `*-controls.json` 均记录未识别控件及绑定失败原因，结合该用例截图复核。`控件语义不明确` 表示页面发现无标签候选，仍不能确认它就是所请求的动作；`页面控件不足` 表示当前筛选范围内没有可用候选。这些是定位诊断，不是产品业务失败。报告中的控件列表是用例结束时快照，不承诺记录此前消失的控件。

## 优先使用页面自身的明确语义

支持宿主控件的 ARIA 名称、关联标签、title，以及图标 SVG title。图标的标签只归到宿主按钮/链接，不重复加入装饰 SVG；有文字的按钮保留自己的名称。对没有名称的按钮，只有显式 `aria-describedby` 关联的单个 `role="tooltip"` 才用于恢复名称；可以有限悬停发现关系，不点击未知图标。原先带“图标:”标签的控件兼容悬停后出现的单个 tooltip，已有无关 tooltip 或多个 tooltip 不用于推断。悬停缓存绑定实际 DOM 节点及内容，替换节点后不会继承。

隐藏、inert、aria-hidden 控件及弹窗后的背景控件不会用于当前定位。模糊、同名或无法唯一对应的控件须补充语义或范围，不能按图标样式、序号、屏幕坐标猜测导出/删除。

## 页面没有标签时显式绑定

先由用户提供或人工核实按钮含义，再在任务目录创建 JSON；不能因某个 CSS 名称像 export 就自动赋予业务含义：

```json
[
    {
        "url": "https://example.test/customers",
        "selector": "#customer-export",
        "name": "导出"
    }
]
```

```bash
node scripts/run.mjs --excel /absolute/path/cases.xlsx --url https://example.test/customers --control-bindings /absolute/path/control-bindings.json --headless
```

绑定是本次任务参数，只支持普通 Excel 的主页面控件。完整 URL（含查询参数和 hash）必须匹配；不含凭据。选择器必须是稳定 CSS，不能是位置伪类、临时 ref 或 Playwright 序号表达式。每次观察重新要求选择器在当前主文档及开放 shadow root 中总共匹配唯一可用宿主控件，包含隐藏重复节点的多匹配也会拒绝；不绑定装饰子元素、背景弹窗控件或 iframe 内的元素。名称不能覆盖页面已有的不同明确标签。多个绑定指向同一元素也会拒绝。

页面 URL、标签或 DOM 在决策期间改变时，停止本步；下一次观察重新校验。绑定只提供名称，不绕过写操作授权、目标唯一性、模型置信度或业务断言。`--labels` 是已有名称的别名映射，与此处的 DOM 绑定用途不同。

结构化生成/回放收到 `--control-bindings` 会明确拒绝，不能把普通 Excel 绑定混入已验证结构化计划。专项组件适配仍需独立实现与验收。
