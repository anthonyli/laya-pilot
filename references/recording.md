# 录制操作并回放

以下命令在 skill 目录执行（或使用脚本绝对路径）。完成 `node scripts/setup.mjs` 和模型 API 配置后，运行：

```bash
node scripts/run.mjs record 'https://test.example/customers' --out recorded-cases/filter.spec.cjs
node scripts/run.mjs replay recorded-cases/filter.xlsx --url 'https://test.example/customers' --headless
```

1. 在打开的浏览器完成操作。Laya 观察列表、表单和弹窗的变化。也可以用「添加检查点」标记可见文本或输入值。
2. 点击「完成录制」或关闭浏览器，保存 `.xlsx` 和 `.spec.cjs`。Excel 按已观察到的业务结果拆成多条用例，每条包含自己的入口、步骤和断言。证据不足的操作保留在 Excel 里供复核。
3. 可用 `--cases REC-003` 单独回放某条用例。编辑和删除同次录制中新增的记录时，用例会在自己的步骤里先创建一条独立测试记录。仅录了对既有数据的编辑或删除时，Excel 会注明缺少可复用的准备步骤。涉及写入时，在专用测试环境显式加 `--allow-write`。
4. 执行 `node scripts/run.mjs report` 打开最新报告，查看结论和每一步的截图。用 `report RUN_DIR` 查看指定一轮。目录说明见 [测试报告怎么看](reports.md)。指定 `--out DIR` 可选择产物目录。

Excel 观察页面错误、浏览器异常、请求失败以及接口返回的业务错误。有业务请求的录制会生成接口成功检查。无业务请求时检查是否出现请求失败。自动生成的记录操作要求按列和值唯一定位，重名或多个列表无法区分时需要复核。

此前录下的文件可用 `node scripts/run.mjs export-excel FILE.spec.cjs --out FILE.xlsx` 转成同一模板。当前转换支持单页录制的导航、点击、输入、Enter／Escape／Tab／上下方向键，以及部分可见性／输入值断言。单独按下的 CapsLock、Shift、Ctrl、Alt 等键不影响页面，转换时跳过并在结果中列出。遇到无法表达的动作、断言或依赖文件，会保留原录制并指出对应位置。

只需 Playwright 文件时，用 `node scripts/setup.mjs --recording` 准备浏览器，再传 `--code-only` 录制。`node scripts/run.mjs replay FILE.spec.cjs --out RUN_DIR` 使用 Playwright Test，`node scripts/run.mjs report RUN_DIR` 在浏览器里开报告。此方式无需 Python 或模型 API。需要录制登录态时，可在代码模式用 `--storage-state FILE`，只使用测试数据。

独立安装的 `laya` 命令用法相同，把 `node scripts/run.mjs` 换成 `laya`、`node scripts/setup.mjs` 换成 `laya setup` 即可；两者的配置互不共享。
