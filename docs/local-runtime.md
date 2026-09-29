# 本地无头运行与状态保存

本轮优先级是准确、快速、稳定。浏览器继续使用 Playwright；默认决策来源为本地 Laya，不自动切换外部模型。**本地模型默认启动即预热**，与浏览器准备、登录态恢复并行；业务测试开始前等待模型就绪，避免在表单中途首次加载。控制台和结果中的 `modelStartup` 单独报告预热状态与耗时。每次独立 CLI 进程仍需一次冷启动，当前没有跨进程常驻模型服务。

回放时，点击、填表、日期和下拉字段均经模型匹配当前页面目标，唯一匹配也会进入决策入口；纯断言不调用模型。相同请求可以命中本轮缓存，`modelCalls` 与 `cacheHits` 分开统计，决策日志阶段为 `replay-target`。可显式传 `--lazy-model` 或配置 `"lazyModel": true` 使用按需加载；API 来源不发送预热请求。Excel 读写仍需 Python + `openpyxl`；CI 的浏览器回归使用明确的模型替身与 `--lazy-model`，真实权重推理需单独验收。

## 操作范围与数据

```bash
node runner.mjs --mode generate --headless \
  --url http://127.0.0.1:8765/customers \
  --operations table,filters,create,search,view,edit,delete \
  --case-file generated-cases/customers.xlsx
node runner.mjs --mode execute --headless \
  --case-file generated-cases/customers.xlsx
```

`--operations` 也可在 JSON 配置中写成数组。省略时仍使用完整生成策略；`--read-only` 将范围限制为 `tabs,tab-switch,table,filters`。其中 `filters` 验证名称/账号筛选输入框，以及页面提供的搜索、重置控件可见，不代表筛选业务逻辑通过。只读是执行器允许的步骤范围，不是网络层阻止所有写请求。

`search/view/edit/delete` 只操作本轮创建的数据，必须同时选择 `create`。`create,delete` 可以独立运行，不必先编辑。未选 `delete` 时保留本轮记录，报告显示 `retainedRecord`；删除失败或写入结果不确定时保留证据，不进行猜测性清理。回放时若工作簿包含超出当前范围的用例，会整体拒绝，不静默跳过。

默认根据表单字段生成数据：记录名与登录账号使用每轮唯一值，账号和可修改的用户名分别保存；按账号筛选时，修改用户名后仍使用原账号查询。过期日期默认为次日，生成 Excel 保留 `${expiryDate}`，回放时重新计算；支持已识别表单的原生日期输入以及带日期标题的 Ant 日历单元格。

下拉值来自页面真实候选。生成阶段由本地 Laya 判断选项类别，组内采用稳定顺序选择并优先叶节点。实际选择路径写入 Excel，回放由模型匹配下拉字段，再按原路径精确选择。字段判断不确定、指定值缺失或重名时失败，不自行更换用例数据。角色名称中的管理员候选不参与自动生成选择，但名称分类不能证明角色的实际权限，也不是通用业务规划模型。

`--data fields.local.json` 或配置中的 `data` 对象可选地覆盖必填文本和下拉路径，例如 `{"联系电话":"13800000000","级别":"标准"}`。它不是生成用例的前置要求。普通字段值会固化到生成的 Excel；改变这些值需重新生成。当前不提供任意数据生成脚本或跨账号清理规则。

原生 `select` 在已识别的 Ant/Element 表单项内通过 `selectOption` 选择并读取结果验证；重名选项会失败。虚拟列表、任意自定义下拉和新弹窗结构尚未获得通用支持。

## 登录态复用

首次使用可自动登录，复杂登录页可先进行一次可见的手动登录：

```bash
node runner.mjs --mode generate --config config.local.json \
  --manual-login --auth-state .auth/tester.json \
  --auth-check '[data-testid="current-user"]' --read-only

node runner.mjs --mode generate --config config.local.json --headless \
  --auth-state .auth/tester.json \
  --auth-check '[data-testid="current-user"]' --read-only
```

`authCheck` 必须是目标页登录后才出现的唯一标记。建议使用能区分测试账号的标记；仅有“没有密码框”不能证明登录成功。`--user`、配置中的 `user` 或 `TEST_USER` 是登录态账号标识，两轮须一致。文件绑定目标 origin 和该账号标识；路径仍须到达目标模块。账号标识不会取代服务端身份校验。

保存 Cookies、localStorage、IndexedDB；依赖 sessionStorage 的系统需在保存与复用时都加 `--auth-session-storage`。它只保存当前目标 origin 的 sessionStorage，不是完整浏览器 profile，不包含扩展和全部标签页。状态文件在登录校验通过后原子替换，POSIX 权限为 `0600`。`.auth/` 已忽略，不要将登录态文件提交到仓库。

失效后有 `--user` 时尝试重新登录，密码来自 `TEST_PASSWORD` 或隐藏输入；无登录方式时明确失败。`--auth-reset` 忽略旧状态，在新登录验证成功后才覆盖。自动登录支持可识别账号框、单一密码框和登录按钮；验证码、MFA、复杂 SSO 仍需要手动登录或专项适配。

## 进度、中断与退出码

以下进度文件用于 `--mode generate/execute`，每次运行使用独立 `--out` 目录：

| 文件                       | 内容                                                       |
| -------------------------- | ---------------------------------------------------------- |
| `checkpoint.json`          | 已完成用例、当前用例步骤、唯一记录名、待核对写入；原子替换 |
| `progress.ndjson`          | 用例完成、步骤完成、写入意图的顺序日志                     |
| `results.json` / `报告.md` | 最终或中断结果、运行/用例耗时、模型调用与错误数            |
| `trace.zip` / `evidence/`  | 登录校验完成后的浏览器轨迹与用例截图                       |

写入意图在保存、删除和确认点击之前落盘。已尝试的写操作只复查结果，不自动重复提交；未确认写入会阻止后续用例继续写入，独立只读检查仍可进行。运行目录锁阻止并发覆盖；已有结果的目录也拒绝复用。

SIGINT/SIGTERM 会尽力保存部分结果与 trace 并关闭浏览器；SIGKILL、断电不能执行收尾，但之前写下的 checkpoint 可用于核对。无法保存 trace 时记录 `轨迹保存失败.json`。中断的输出目录可保留锁，改用新目录运行。

**当前没有自动断点续跑。** checkpoint 用于核对已经发生的操作，不能证明服务端尚未提交。先核对 `pendingWrite` 与运行记录名，再决定清理或重跑；重新运行会使用新的记录名。`--excel` 通用执行器复用登录态和按需模型加载，但仍沿用其原有逐用例报告，不具备上述 workflow 中断账本。

| 退出码        | 含义                                                    |
| ------------- | ------------------------------------------------------- |
| `0`           | 至少一条用例通过，其他结果仅有通过、不适用或未选择      |
| `1`           | 用例失败、未生成、依赖阻断、无有效覆盖，或启动/导出失败 |
| `130` / `143` | workflow 收到 SIGINT / SIGTERM                          |

没有区间格式输入框时，该格式校验标为“不适用”，不会被计为通过或写入可执行用例。`metrics.modelCalls` 包括失败请求；`inferenceMs` 仅累计成功请求返回的耗时，不是完整任务耗时。

页面显示“暂无权限”等拒绝访问提示时，生成和回放会在业务步骤前失败并保存截图；没有发现所选范围内的用例也会明确失败，不把空报告当作通过。

## 可复现回归

```bash
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
LAYA_TEST_PYTHON=/path/to/python-with-openpyxl npm run test:browser
npm run test:model # 使用 config.local.json 的本地 Python 和已下载权重，强制离线
```

浏览器回归仅访问临时启动的 `127.0.0.1` 站点或内存测试页面，使用真实无头 Chromium：覆盖生成→Excel→新会话回放、动态 DOM ID、操作范围、HTTP 500、写入期间中断、Cookie/localStorage/sessionStorage/IndexedDB 复用与失效、原生下拉、重复记录与同名前缀、独立账号/用户名、相对日期、固定操作列和没有 tabindex 的图标。产物保留在 `runs/browser-regression-*`，不调用外部模型。

浏览器回归验证执行器协议与本地 fixture，不证明任意内网站点的成功率。`test:model` 使用真实本地权重验证回放提示、控件和字段匹配及默认置信度门槛，可通过 `LAYA_TEST_CONFIG`、`LAYA_TEST_PYTHON`、`LAYA_TEST_MODEL` 指定本机配置；不会访问业务系统。真实业务页面、较慢网络、分页/虚拟列表与歧义控件仍需单独验收。本地或内网通用模型尚未进行 Browser Use 对比，见[评估记录](browser-use-evaluation.md)。
