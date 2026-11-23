# 录制操作并回放

以下命令在 skill 目录执行（或使用脚本绝对路径）。完成 `node scripts/setup.mjs` 和模型 API 配置后，运行：

```bash
node scripts/run.mjs record 'https://test.example/customers' --out recorded-cases/filter.spec.cjs
node scripts/run.mjs replay recorded-cases/filter.xlsx --url 'https://test.example/customers' --headless
```

1. 在打开的浏览器完成操作。Laya 观察列表、表单和弹窗的变化。也可以用「添加检查点」标记可见文本或输入值。
2. 点击「完成录制」或关闭浏览器，保存 `.xlsx` 和 `.spec.cjs`。Excel 按登录、区域切换、新增、查询等业务场景分别编号，仍按录制顺序连续回放。长场景的续行显示相同编号。当时的输入值、手动检查点和待补录步骤保留在原位置。同源刷新后继续录制。遇到无法定位的操作或敏感输入，Excel 和脚本都会在原位置标出「待补录」并保留后续步骤。回放到此处会停止，补齐后可重新执行。右上角工具条可用「移至底部」或「移至顶部」避开页面按钮。
3. 若要按已观察到的业务结果拆成独立用例，录制时加 `--split-cases`。拆分后可用 `--cases REC-003` 单独回放某条用例。编辑和删除同次录制中新增的记录时，用例会在自己的步骤里先创建一条独立测试记录。仅录了对既有数据的编辑或删除时，Excel 会注明缺少可复用的准备步骤。涉及写入时，在专用测试环境显式加 `--allow-write`。
4. 执行 `node scripts/run.mjs report` 打开最新报告，查看结论和每一步的截图。用 `report RUN_DIR` 查看指定一轮。目录说明见 [测试报告怎么看](reports.md)。指定 `--out DIR` 可选择产物目录。

默认录制识别到登录成功后，按站点（协议、主机、端口）和账号在本地保存浏览器会话。CLI 使用 `~/.laya/.auth/recordings/`，设置了 `LAYA_HOME` 时使用该目录；skill 使用自己的 `.auth/recordings/`。下次录制或回放 Excel 会先打开登录后的页面验证会话。已认证时，登录场景在报告中标为「不适用」，后续场景继续执行。录制中成功登录后，账号密码及登录控件信息会按站点和账号加密保存。会话过期时，录制和 Excel 回放会自动使用对应凭据登录，验证通过后更新 auth 并继续用例。`record --auth-reset` 开启新的登录会话。多个账号可用 `--user` 选择，自定义登录页可用 `--user` 和 `--auth-check` 指定账号及登录后唯一可见的标记。已有显式回放配置 `--auth-state` 优先。

凭据位于数据目录的 `.auth/credentials/`，本地密钥是 `.auth/credentials.key`，文件权限为当前用户可读写。密码通过独立的凭据通道保存，录制用例中的密码输入仍标记为敏感步骤。旧版只保存了会话，需要在录制浏览器里再成功登录一次，或通过 `--user` 配合隐藏输入或 `TEST_PASSWORD` 登录，以建立可续期凭据。验证码或多因素验证需要人工完成。

录制会分别保留打开下拉框和点选具体值两个动作，并把选项关联到对应字段。对于同时包含数值和单位的字段，两者分别记录。回放在新增场景点击「保存」或「提交」前读取本次表单的名称或标识，点击后核对列表总数增加一条，且能找到唯一匹配的新行。保存失败或证据不足时，报告会显示原因。

Excel 观察页面错误、浏览器异常、请求失败以及接口返回的业务错误。有业务请求的录制会生成接口成功检查。无业务请求时检查是否出现请求失败。自动生成的记录操作要求按列和值唯一定位，重名或多个列表无法区分时需要复核。

此前录下的文件可用 `node scripts/run.mjs export-excel FILE.spec.cjs --out FILE.xlsx` 转成同一模板。当前转换支持单页录制的导航、点击、输入、Enter／Escape／Tab／上下方向键，以及部分可见性／输入值断言。单独按下的 CapsLock、Shift、Ctrl、Alt 等键不影响页面，转换时跳过并在结果中列出。遇到无法表达的动作、断言或依赖文件，会保留原录制并指出对应位置。

只需 Playwright 文件时，用 `node scripts/setup.mjs --recording` 准备浏览器，再传 `--code-only` 录制。`node scripts/run.mjs replay FILE.spec.cjs --out RUN_DIR` 使用 Playwright Test，`node scripts/run.mjs report RUN_DIR` 在浏览器里开报告。此方式无需 Python 或模型 API。需要录制登录态时，可在代码模式用 `--storage-state FILE`，只使用测试数据。

## 接入其他 UI 组件库

有可访问名称的标准控件按 HTML 和 ARIA 语义识别。工具内置了 Ant Design、TNTD 和 Element 的常见表单结构。新组件库使用自己的字段容器、浮层或表格标识时，可以在项目里放一个 JSON 适配文件。下面的属性名用于示例，接入时换成页面实际提供的 CSS 选择器，只填写需要扩展的部分。

```json
{
    "name": "project-widgets",
    "dialog": "[data-drawer]",
    "form": { "item": "[data-field]", "label": "[data-field-label]" },
    "select": {
        "shell": "[data-picker]",
        "trigger": "[data-trigger]",
        "popup": "[data-options]",
        "option": "[data-choice]"
    },
    "table": { "wrapper": "[data-list]", "pagination": "[data-pager]", "id": "[data-record-id]" }
}
```

```sh
laya record "$TEST_URL" --ui-adapter ./ui-adapter.json
laya replay recorded-cases/case.xlsx --url "$TEST_URL" --ui-adapter ./ui-adapter.json
```

Excel 保留字段名称和选项值，回放时加载当前项目的适配文件。配套的 Playwright 脚本内嵌录制时的选择器。自定义弹层可以通过 `aria-controls` 指向页面其他位置的选项列表。无法唯一确认字段、选项或表格记录时，录制会在原位标记待补录，回放会在对应步骤说明原因。

下拉选项的名称与可见性由通用适配层统一处理，录制、Excel 回放和独立脚本使用同一规则：优先读取选项自身的 `aria-labelledby` / `aria-label`，其次读取可见文字和标题。子图标的无障碍名称不会拼入选项值，隐藏或 `aria-hidden` 的副本不参与匹配；所属列表中存在多个同名选项时仍会停止。

独立安装的 `laya` 命令用法相同，把 `node scripts/run.mjs` 换成 `laya`、`node scripts/setup.mjs` 换成 `laya setup` 即可；两者的配置互不共享。
