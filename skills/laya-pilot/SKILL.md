---
name: laya-pilot
description: Run browser regression tests from user-provided Excel test cases for enterprise admin applications, preserving their steps and expected results and producing reports and failure evidence. Use for executing existing workbooks and analyzing regression runs. Case generation is optional and requires a user request. API access is the default; local model downloads require an explicit user request.
---

# LayaPilot

主要功能是执行用户已有的 Excel 测试用例做浏览器回归：读取用例，按原步骤和预期执行，输出报告与失败证据。本目录包含独立运行所需的代码、依赖清单和 demo，可以单独复制或分发，无需原项目仓库。

## 两个用户入口

| 功能               | 输入与入口                                   | 工作流                                                      | 输出                                                                    |
| ------------------ | -------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| 执行用例（主功能） | 用户现有或 LayaPilot 生成的 Excel；`--excel` | 自动识别格式 → 解析/校验 → 按步骤和预期执行 → 汇总报告      | JSON、Markdown 与浏览器证据；普通用例另有 CSV，结构化用例另有结果 Excel |
| 生成用例（按需）   | 测试地址和允许的范围；`--mode generate`      | 观察页面 → 选择支持的测试 → 实际执行和断言 → 导出已验证用例 | 可执行 Excel、全部尝试结果表格和证据                                    |

用户不需要区分普通 Excel 执行与结构化回放：`--excel` 根据隐藏计划或生成标记自动选择内部执行器；结构化计划校验失败就报错，不降级到普通解析。新生成文件移除隐藏计划后也会拒绝执行。旧 `--mode execute --case-file` 保留兼容，日常使用统一的 `--excel`。

`config.local.json` 的 `excel` 是执行输入；`--case-file` 在生成时是输出，不自动充当模板。`--inspect` 是执行前检查，`--headless` 和 API/本地模型是运行选项。详细步骤见 [references/workflows.md](references/workflows.md)。

## 主流程：已有用例回归

1. 获取用户提供的 Excel，或读取 skill 根目录 `config.local.json` 中的 `excel` 路径；从配置或用户说明确定目标地址和登录方式。用户要求回归却未提供用例时，先补齐用例文件，不自动改成从页面生成用例。
2. 使用 `scripts/run.mjs --excel ... --inspect` 自动识别工作簿并检查解析、计划校验、用例数与导入警告。默认包含全部读取到的用例；未识别的工作表或步骤要明确报告，不能算作已覆盖。
3. 执行这些现有用例；常用无头回归命令为 `scripts/run.mjs --excel ... --url ... --headless`。按原用例保留数据、步骤和预期；只有用户明确要求修订时才修改原用例。登录前检查已配置的 `authState` 和登录后唯一标记 `authCheck`，优先复用并验证已有登录态；失效后再登录。
4. 读取本轮报告，按用例给出结果、失败步骤与证据路径。普通用例输出 JSON、CSV、Markdown；结构化用例输出独立结果 Excel、JSON、Markdown。浏览器证据按实际产物提供，原始工作簿保持不变。

只有用户明确要求生成或补充新用例时，才进入 `--mode generate`。生成完成后仍使用 `--excel` 执行输出工作簿。

## 工作入口

- 仅解读已有报告：直接读取用户指定的 `results.json` 和证据，无须安装依赖、配置 API 或重新测试。
- 安装、检查环境或配置模型：按需读取 [references/setup.md](references/setup.md)。
- 执行已有用例回归、登录和结果解释：读取 [references/workflows.md](references/workflows.md) 的主流程；按需查看其中的生成流程和内部格式说明。

## 环境与默认行为

1. 以本 `SKILL.md` 所在目录作为 skill 目录。调用本包的 `scripts/setup.mjs` 和 `scripts/run.mjs`，使用脚本绝对路径，保持用户工作目录。从用户接收的配置和工作簿路径先相对于用户工作目录解析。
2. 需要 Node.js 20+（含 npm）、Python 3.10+（含 venv/pip）、Playwright Chromium、Python openpyxl。`setup.mjs` 安装包内固定版本的 Playwright、浏览器及私有 Python 环境；系统 Node/Python 缺失时先按安装说明处理。API 模式无需显卡或本地模型。
3. 安装脚本在 skill 根目录创建 `.env.local` 与 `config.local.json`，已有文件保留。优先使用这份 skill 的配置；用户指定其他配置时再传 `--config`，不要借用工作目录中无关项目的配置。默认通过 API 调用模型，默认模型名 `laya-decision` 可被显式配置覆盖。配置 `LAYA_API_BASE`、`LAYA_API_MODEL`、`LAYA_API_KEY`；密钥通过环境变量或 `.env.local` 提供，不放进命令行、JSON 配置或回复。启动时的 `CONFIG` 显示实际配置来源和模型，秘密只显示是否存在。
4. 未收到用户明确要求时，不安装本地 Laya，不下载模型权重，也不因 API 故障改用本地模型。用户明确要求本地运行后，才使用 `setup.mjs --local-model` 安装并下载模型，并在测试时传 `--provider local`。配置文件或继承的环境变量不会自动切换到本地模式。
   用户说“本机的”可能指本机已有的 API 配置，不等于选择本地推理；含义不明时保持 API 默认值并补齐服务地址和模型配置。
5. 用户已有 Excel 按支持的步骤、预期结果等表头解析，无须转换成生成器的 17 列模板。生成新用例时才使用内置 17 列格式；用户明确指定自定义生成模板时才传 `--template-excel`。

首次安装（下面脚本路径相对于 skill 目录，执行时换成实际绝对路径）：

```bash
node scripts/setup.mjs
node scripts/setup.mjs --check
```

先引导用户配置 API，再开始需要模型的测试。检查已有 Excel 使用 `scripts/run.mjs --excel ... --inspect`，不需要 API 凭据、浏览器启动或模型权重。

## 确认任务范围

从用户说明、配置或工作簿确认目标模块、登录方式及操作范围。仅解读报告或检查 Excel 时不要求目标 URL；缺少会阻止当前任务的信息时，只询问必要信息。

用户要求记住登录时，使用现有 `.auth` 功能：在 skill 根目录下按站点和账号选取独立文件，将 `authState` 和登录后唯一的 `authCheck` 保存到当前配置，验证下一次新浏览器的 `authStatus` 为 `reused`。依赖 sessionStorage 的系统另设 `authSessionStorage: true`。保存登录态即可，不把密码写进长期记忆；详细参数见 [references/workflows.md](references/workflows.md)。

执行入口默认只读。对业务页面的新增、修改和删除，使用用户指定的测试环境和授权范围；已有明确授权就加 `--allow-write` 继续。范围不明时先用 `--inspect` 核对现有用例中的操作，补齐所需范围信息。不要用生成器的只读页面检查替代用户要求的回归。

## 执行与交付

- 所有测试通过 `scripts/run.mjs` 启动，保留现有页面断言、用例数据和工作簿完整性校验。生成文件的 `__laya_steps__` 隐藏页不一致时停止，不绕过校验或改预期来制造通过。
- `--excel` 默认执行所有读取到的用例，不按历史结果或用例类型筛选。只有用户明确指定部分编号时才使用 `--cases`；目前仅普通 Excel 支持编号筛选，结构化计划需完整执行，不支持时应明确报错。
- 输出默认保存到用户当前工作目录下的新 `runs/laya-pilot/` 目录；生成文件使用新的 `generated-cases/laya-pilot-*.xlsx` 文件名。需要指定位置时用 `--out` 和 `--case-file`。
- 读取本轮实际报告，分别说明通过、失败、不适用、阻断和未执行情况，提供实际存在的用例、结果表格、报告和失败证据路径。Excel 解析成功、只读检查成功与完整业务测试成功要明确区分。
- 如有 `pendingWrite` 或 `retainedRecord`，先核对 `checkpoint.json` 与证据再决定后续操作，不盲目重复保存、删除或清理。进度文件不支持自动断点续跑。
- API 失败时说明连接、响应或协议问题；本包调用 HTTPS Chat Completions 接口，模型必须返回本项目要求的候选决策 JSON，细节见安装说明。不会自动更换服务或模型。
