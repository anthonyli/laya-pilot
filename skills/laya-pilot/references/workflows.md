# 执行与生成工作流

主要功能是执行用户已有用例做回归。用户只需区分“执行用例”和“生成用例”；普通 Excel 执行和结构化回放由程序内部识别。下列脚本路径相对于 skill 目录，实际调用使用绝对路径并保持用户工作目录。报告默认保存到新的 `runs/laya-pilot/` 目录。

## 入口与文件参数

| 用户功能           | 输入                                                     | 入口                         | 工作流                                          |
| ------------------ | -------------------------------------------------------- | ---------------------------- | ----------------------------------------------- |
| 执行用例（主功能） | 现有 Excel 或 LayaPilot 生成的 Excel、测试地址与登录方式 | `--excel` 或配置中的 `excel` | 自动识别 → 解析/校验 → 执行 → 断言 → 报告       |
| 生成用例（按需）   | 页面地址与允许的操作范围                                 | `--mode generate`            | 观察 → 选择测试 → 实际执行验证 → 导出用例与结果 |

- `--excel` / 配置中的 `excel`：统一执行输入，不作为生成模板。
- `--case-file`：生成时的输出路径。旧 `--mode execute --case-file` 仍接受生成文件作为输入，保留兼容。
- `--template-excel`：用户明确指定生成模板时使用。
- `--inspect`：只检查文件、步骤与计划，不启动浏览器或模型，不是独立模式。
- `--headless`、登录参数和 API/本地模型配置：共用运行选项。

## 执行用例：统一入口

用户提供普通测试 Excel、生成工作簿，或在 skill 根目录 `config.local.json` 的 `excel` 中设置绝对路径，都使用同一个入口：

```bash
node scripts/run.mjs --excel '/absolute/path/cases.xlsx' --inspect
node scripts/run.mjs --excel '/absolute/path/cases.xlsx' \
  --url 'https://your-test-app.example/customers' --headless
```

配置已填好 `excel` 和目标地址时，可直接运行 `node scripts/run.mjs --headless`。普通工作簿需要测试地址；生成工作簿也可使用计划中保存的模块地址，覆盖地址时须保持相同模块路径。

执行顺序：

1. **识别文件。** 有 `__laya_steps__` 隐藏计划或 LayaPilot 生成标记时，选择结构化执行器；其他工作簿进入自然语言解析。
2. **解析或校验。** 普通 Excel 按支持的步骤、预期结果等表头读取，无须套用生成器的 17 列模板。结构化 Excel 必须通过隐藏计划、可见内容摘要和步骤语法校验。校验失败报错，不换执行器重试；新生成文件删除隐藏计划后也会被生成标记识别并拒绝执行。
3. **核对范围。** `excel-inspection.json` 标明 `workbookFormat`（`natural-language` / `structured`），`selection.json` 标明读取与选中数量。默认包含全部用例，不按历史结果或类型筛选。导入警告、未知步骤和未识别工作表要明确报告。
4. **登录并执行。** 使用原步骤、数据和预期，重新定位当前页面控件并执行断言。自动登录可用 `TEST_USER`、`TEST_PASSWORD`；人工登录使用可见浏览器。
5. **输出报告。** 汇总通过、失败、阻断和未执行情况，提供失败步骤与证据位置，保留输入工作簿原样。

统一执行入口默认只读。用户已授权测试环境和用例中的写操作后加 `--allow-write`。结构化工作簿中若含超出只读范围的操作，未授权写入时会在浏览器启动前拒绝，不悄悄略过。`--read-only` 与 `--operations` 可对结构化计划施加范围约束，超出范围会整体拒绝。

`--cases 001,002` 目前只支持普通 Excel 的编号筛选；结构化计划仍需完整执行，传该选项会明确报错。结构化用例内部的依赖、唯一测试记录和写入核对规则继续保留。

## 生成用例：仅在用户要求时

输入是页面地址与允许的测试范围，无须先提供回归工作簿。

工作流：打开页面并登录 → 观察控件 → 选择支持的测试 → 实际执行并做页面断言 → 导出已验证用例及全部尝试结果。

生成只读检查用例：

```bash
node scripts/run.mjs --mode generate \
  --url 'https://your-test-app.example/customers' --read-only \
  --case-file generated-cases/customers-readonly.xlsx
```

用户已允许在专用测试环境验证 CRUD 时：

```bash
node scripts/run.mjs --mode generate \
  --url 'https://your-test-app.example/customers' \
  --operations table,filters,create,search,view,edit,delete \
  --case-file generated-cases/customers.xlsx
```

`search/view/edit/delete` 依赖本轮 `create`，只操作本轮记录；未选 `delete` 会保留记录。省略 `--operations` 使用默认策略，包括有边界的 `discover` 补充测试，不扩大用户已经限定的范围。

只有实际执行并通过页面断言的用例会进入生成工作簿；`执行结果.xlsx` 记录全部生成尝试，包括失败和不适用项。`--case-file` 是输出，模板默认使用内置 17 列结构，用户指定时才使用 `--template-excel`。配置中的 `excel` 回归文件不会被借作模板。

生成后的用例仍走统一执行入口：

```bash
node scripts/run.mjs --excel generated-cases/customers.xlsx \
  --url 'https://your-test-app.example/customers' --headless --allow-write
```

上例的 `--allow-write` 对应已经授权的 CRUD 测试；只读生成工作簿无需此选项。旧命令 `--mode execute --case-file generated-cases/customers.xlsx` 保留原有结构化回放及范围语义，日常使用无需选择它。

## 配置、登录与产物

默认读取 skill 根目录的 `config.local.json` 和 `.env.local`；`--config` 可切换 JSON 文件。密码和 API 密钥只通过环境变量、`.env.local` 或隐藏输入提供，不写进命令行、JSON 配置或回复。

登录态使用 `--auth-state` 配合登录后唯一标记 `--auth-check`。复杂登录用可见浏览器和 `--manual-login`，不能同时加 `--headless`；需要用户完成交互时保留进程。公开 demo 使用 `node runtime/examples/demo-server.mjs` 启动，本次任务结束后关闭由自己启动的进程。

用户要求保留登录后，可在 skill 的 `config.local.json` 中设置以下字段；实际选择器需要从目标登录后的页面确定，不直接照抄示例：

```json
{
    "authState": "/absolute/path/to/laya-pilot/.auth/site-account.json",
    "authCheck": "[data-testid=\"authenticated-user\"]",
    "authSessionStorage": true
}
```

`authSessionStorage` 仅在系统需要时启用。登录态绑定站点 origin 和 `user` 账号标识；文件权限为 `0600`。首次登录成功后保存，下次无需 `--manual-login`，先验证再复用。失效时重新登录，`--auth-reset` 可显式忽略旧状态。报告的 `authStatus` 区分 `reused`、`logged-in`、`not-required` 与 `failed`；登录失败记为阻断，并保存遮罩后的证据，不录制登录过程的 trace。

只读生成的 `filters` 验证控件可见，不证明查询结果或重置行为正确。无法唯一识别的筛选入口会明确记录未覆盖；需要验证业务查询结果时，提供相应步骤和预期。

产物按内部执行方式略有区别，读实际文件后交付：

| 输入类型     | 报告与结果                                                     | 状态与证据                                       |
| ------------ | -------------------------------------------------------------- | ------------------------------------------------ |
| 普通 Excel   | `results.json`、`结果.csv`、`报告.md`                          | 逐用例动作/断言、实际截图、`trace.zip`、决策日志 |
| 结构化 Excel | `results.json`、`报告.md`、独立 `执行结果.xlsx`                | 失败步骤、浏览器事件、截图、轨迹、进度与写入账本 |
| 生成用例     | 已验证用例工作簿、全部尝试 `执行结果.xlsx`、JSON/Markdown 报告 | 覆盖状态、跳过/失败原因、截图、轨迹和进度        |

`--inspect` 成功仅表示文件检查通过。页面断言才决定测试通过，模型选中控件不能代替断言。如果产物中有 `pendingWrite` 或 `retainedRecord`，先核对 `checkpoint.json` 与证据，不盲目重复保存、删除或清理；进度不提供自动断点续跑。普通 Excel 执行器没有结构化执行器的完整中断账本。

当前覆盖主要是后台表格、筛选、表单和 CRUD。审批、多账号权限、文件导入、Canvas 等超出通用支持的流程需专项适配；不得在报告中算作已覆盖。
