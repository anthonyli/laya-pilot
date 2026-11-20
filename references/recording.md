# 录制操作并回放

以下命令在 skill 目录执行（或使用脚本绝对路径）。完成 `node scripts/setup.mjs` 和模型 API 配置后，运行：

```bash
node scripts/run.mjs record 'https://test.example/customers' --out recorded-cases/filter.spec.cjs
node scripts/run.mjs replay recorded-cases/filter.xlsx --url 'https://test.example/customers' --headless
```

1. 在打开的浏览器完成操作。用工具栏标记要验证的可见内容或输入值，检查点会保留在录制的位置。
2. 关闭浏览器会保存 `.xlsx` 和 `.spec.cjs`。Excel 沿用六列模板，用自然语言写步骤、值和预期，可打开检查和修改。
3. 回放 Excel 时，Laya 依据当前页面选控件，执行器核对预期。涉及写入时，在专用测试环境显式加 `--allow-write`。
4. 每轮打开 `index.html` 查看可靠性结论、每一步的截图，以及 `summary.md`、`results.json` 和轨迹，可用 `node scripts/run.mjs report RUN_DIR` 打开。目录说明见 [测试报告怎么看](reports.md)。指定 `--out DIR` 可选择产物目录。

Excel 默认观察页面可见错误提示、浏览器脚本和控制台错误、崩溃，以及 HTTP 错误、请求失败与 JSON 明确返回 `success: false` 的情况。有明确错误就不计为通过；没有观察到接口请求时，接口状态为未验证。未标记业务预期时，Excel 会提示补充可观察结果。多项同名按钮按录制位置复核；如果重放对象需要固定，应在 Excel 中补充记录或范围。

此前录下的文件可用 `node scripts/run.mjs export-excel FILE.spec.cjs --out FILE.xlsx` 转成同一模板。当前转换支持单页录制的导航、点击、输入和部分可见性／输入值断言。遇到无法表达的动作、断言或依赖文件，会保留原录制并指出对应位置。

只需 Playwright 文件时，用 `node scripts/setup.mjs --recording` 准备浏览器，再传 `--code-only` 录制。`node scripts/run.mjs replay FILE.spec.cjs --out RUN_DIR` 使用 Playwright Test，`node scripts/run.mjs report RUN_DIR` 在浏览器里开报告。此方式无需 Python 或模型 API。需要录制登录态时，可在代码模式用 `--storage-state FILE`，只使用测试数据。

独立安装的 `laya` 命令用法相同，把 `node scripts/run.mjs` 换成 `laya`、`node scripts/setup.mjs` 换成 `laya setup` 即可；两者的配置互不共享。
