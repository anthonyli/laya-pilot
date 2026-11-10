# 安装环境与配置

仓库根目录和解压后的 skill 都包含同一份独立运行代码；可直接克隆仓库作为 skill，也可使用 ZIP。保留整个目录结构；依赖在用户机器上安装，ZIP 只包含 skill 运行所需文件，不含 demo、仓库开发文件、node_modules、Python 虚拟环境、浏览器二进制或模型权重。

## 默认 API 模式

| 组件           | 要求                                       | 安装方式                         |
| -------------- | ------------------------------------------ | -------------------------------- |
| Node.js 与 npm | Node.js 20+，含 npm                        | 用户先安装到系统                 |
| Python         | 3.10+，含 venv/pip；建议 3.11 或 3.12      | 用户先安装到系统                 |
| 浏览器驱动     | Playwright，版本由包内 lockfile 固定       | 安装脚本执行 `npm ci --omit=dev` |
| 浏览器         | Playwright Chromium                        | 安装脚本安装对应版本             |
| Excel 读写     | Python openpyxl，范围见 `requirements.txt` | 安装到 skill 内 `.venv/`         |
| 模型           | 用户提供的 HTTPS API、模型名称和密钥       | 用户配置，无本地权重下载         |

在解压后的 skill 目录执行：

```bash
node scripts/setup.mjs
```

安装脚本会创建 `.venv/`、安装 Node/Python 依赖和 Chromium，并在 skill 根目录从 `assets/.env.example` 创建唯一的 `.env.local` 配置文件，与 `SKILL.md` 同级。已有文件保留原样。它不安装本地 Laya、不下载模型权重。需要选择 Python 时使用：

```bash
node scripts/setup.mjs --python /absolute/path/to/python3.11
```

Windows 也使用同一 Node 入口；脚本会选择 `.venv\Scripts\python.exe`，并支持系统 `python` 或 `py -3`。可通过 `--python` 指定 Python 可执行文件。Linux 如缺少 `venv` 或浏览器系统库，先安装对应系统组件；浏览器库可由管理员执行 `node node_modules/playwright/cli.js install-deps chromium` 安装。安装脚本不会自行提权。

已有匹配 Chromium 的环境可以加 `--skip-browser`。这只跳过浏览器下载，不代表浏览器已经可用；之后用 `--check` 检查。

## 填写 API

在 skill 目录的 `.env.local` 中设置：

```dotenv
LAYA_API_BASE=https://your-gateway.example/v1
LAYA_API_MODEL=laya-decision
LAYA_API_KEY=your-secret-key
```

也可从运行环境提供同名变量；环境变量优先于 `.env.local`。AI 应让用户在本机填写密钥，核对是否设置即可，不把值输出到聊天或命令记录。测试系统账号和密码可选地通过 `TEST_USER`、`TEST_PASSWORD` 提供。

运行检查：

```bash
node scripts/setup.mjs --check
```

检查仅报告 Node、Python、openpyxl、Playwright、浏览器和 API 配置是否存在，不访问 API，也不安装依赖。退出码非零表示有待补齐项，检查成功不等于 API 已联网验证。

检查和运行共用配置解析：命令行优先，其次为 shell 环境变量、skill 的 `.env.local` 和默认值。模型名默认 `laya-decision`，可覆盖。skill 不再读取 JSON 配置或接受 `--config`。启动输出的 `CONFIG` 包括 skill 路径、版本摘要、配置文件、provider、模型和登录态文件状态；密钥仅显示是否设置。用 `node scripts/run.mjs --version` 核对版本与内容摘要。

升级时由维护者在源码仓库运行打包脚本，将分发文件更新到安装目录；保留 `.env.local`、`.auth`、依赖和模型，随后在安装目录执行 `node scripts/setup.mjs` 更新依赖。不要直接删除整个旧安装目录。打包及升级命令见 [项目仓库](https://github.com/anthonyli/laya-pilot#项目结构与维护)。

### API 协议

`LAYA_API_BASE` 为不含凭据、查询参数或片段的 HTTPS 基础地址。执行器向其追加 `/chat/completions`，以 Bearer 密钥发送非流式 Chat Completions 请求。例如基础地址 `https://gateway.example/v1` 对应 `https://gateway.example/v1/chat/completions`。

模型需要遵循请求中的 system 指令，从给定候选中选择并返回概率。Chat Completions 响应的 `choices[0].message.content` 必须是包含如下结构的 JSON 字符串：

```json
{
    "result": {
        "answers": {
            "scenario": {
                "choice": "候选A",
                "probabilities": { "候选A": 0.9, "候选B": 0.1 },
                "confidence": 0.9
            }
        }
    }
}
```

候选名必须与当前请求一致，概率需覆盖所有候选且归一化。接口路径兼容不代表模型一定满足此决策协议；连接失败、拒绝决策或非法响应会明确失败，不回退本地或切换服务。

## 仅在用户明确要求时：本地模型

默认流程不执行本节。用户明确要求下载模型、本地推理或离线运行后，才运行：

```bash
node scripts/setup.mjs --local-model
node scripts/setup.mjs --check --local-model
node scripts/run.mjs --provider local --excel '/absolute/path/regression-cases.xlsx' --headless
```

`--local-model` 安装 `requirements-local.txt` 中的 Laya 及其推理依赖，并通过 Hugging Face 下载 `convaiinnovations/laya-multilingual` 到 skill 内 `models/laya-multilingual/`。需要额外网络、磁盘和内存；已有模型可以通过 `LAYA_MODEL` 或运行时 `--model` 指定路径。使用已有模型时自行安装所需本地依赖即可，无须重复执行下载命令。

每次本地测试都显式传 `--provider local`。未传时仍使用 API；安装过本地模型也不会改变默认来源。

## 登录配置

`.env.local` 只保存 API 和需要复用的登录配置。账号密码可选；需要复用登录态时，配套设置状态文件与登录后唯一标记：

```dotenv
TEST_USER=
TEST_PASSWORD=
TEST_AUTH_STATE=
TEST_AUTH_CHECK=
```

登录态仍保存在 `.auth/` 中，绑定账号和站点 origin；每次执行前验证有效性。只有目标系统依赖 sessionStorage 时，才在 `.env.local` 额外加入 `TEST_AUTH_SESSION_STORAGE=true`。具体登录流程见 [workflows.md](workflows.md#配置登录与产物)。

## 每次任务的参数

每次由用户提供 Excel、目标 URL 和运行要求，AI 将它们传给命令行，不写入 `.env.local`：

```bash
node scripts/run.mjs --excel '/absolute/path/cases.xlsx' --inspect
node scripts/run.mjs --excel '/absolute/path/cases.xlsx' \
  --url 'https://your-test-app.example/module' --headless
```

`--inspect` 只检查工作簿，无须 URL 或 API。生成工作簿可以在确认属于当前任务后使用计划中保存的地址；普通 Excel 执行需要目标 URL。密码和密钥继续通过 `.env.local` 或环境变量提供，不放进命令行。

## 高级参数

这些选项按需使用，示例配置不再逐项列出。优先使用本轮命令行参数；自动化集成也可在启动进程时传入对应环境变量。旧版 `.env.local` 中的高级变量仍能读取以保持兼容，但建议移到任务命令中，避免影响后续任务。

| 本轮参数                                   | 对应环境变量                             | 用途与默认行为                                           |
| ------------------------------------------ | ---------------------------------------- | -------------------------------------------------------- |
| `--excel` / `--url`                        | `TEST_EXCEL` / `TEST_URL`                | 本次输入工作簿 / 目标页面                                |
| `--headless` / `--headed`                  | `BROWSER_HEADLESS`                       | 无头 / 可见浏览器，默认可见                              |
| `--browser-provider` / `--browser-channel` | `BROWSER_PROVIDER` / `BROWSER_CHANNEL`   | 驱动仅支持 `playwright`；默认使用安装的 Chromium         |
| `--language`                               | `TEST_LANGUAGE`                          | `auto`（默认）、`zh-CN`、`en` 或 `none`                  |
| `--operations`                             | `TEST_OPERATIONS`                        | 生成或结构化回放的操作范围；普通 Excel 执行留空          |
| `--data FILE`                              | `TEST_DATA`                              | 字段覆盖；命令行读取 JSON 文件，环境变量为内联 JSON 对象 |
| `--out`                                    | `TEST_OUTPUT`                            | 输出目录；默认每轮创建独立目录                           |
| `--case-file` / `--template-excel`         | `TEST_CASE_FILE` / `TEST_TEMPLATE_EXCEL` | 生成用例输出 / 用户明确指定的生成模板                    |
| `--python` / `--model`                     | `LAYA_PYTHON` / `LAYA_MODEL`             | Python / 本地模型路径                                    |
| `--lazy-model`                             | `LAYA_LAZY_MODEL`                        | 本地模型按需加载，默认预热；API 模式不需要               |
| `--api-timeout`                            | `LAYA_API_TIMEOUT`                       | API 超时，默认 `30000` 毫秒                              |
| `--auth-session-storage`                   | `TEST_AUTH_SESSION_STORAGE`              | 依赖 sessionStorage 的系统才启用，默认关闭               |

例如，只对当前任务调整 API 超时和输出目录：

```bash
node scripts/run.mjs --excel '/absolute/path/cases.xlsx' \
  --url 'https://your-test-app.example/module' --headless \
  --api-timeout 60000 --out '/absolute/path/reports/current-run'
```

省略可选参数使用默认值。路径建议使用绝对路径；相对路径按调用者工作目录解析。`.env.local` 的值按字面文本读取，不执行 Shell 展开，不支持行尾注释。API 始终为 skill 默认来源；本地模型只通过 `--provider local` 显式选择，写操作仍需本轮明确传入 `--allow-write`。

旧安装的 `config.local.json` 不再自动读取。迁移时只将 API、账号、密码和登录态设置放入 `.env.local`，保留已有非空凭据；Excel、URL、浏览器和输出选项改为任务参数。安装脚本不会自动清理已有配置，确认迁移后再删除旧 JSON 文件或 `.env.local` 中的任务变量。

## 用例模板

需要手工编写用例但没有模板时，复制 [内置 Excel 模板](../assets/test-cases-template.xlsx)，按 [填写说明](case-template.md)完成后通过 `--excel` 执行。模板随 skill 交付包提供，内含三条标注“【示例】”的 demo 用例；用于自己的系统前先修改或删除示例行。

现有 Excel 回归直接读取用户用例，无须先生成或下载模板；至少要能识别步骤和预期结果表头。只有用户明确要求生成新用例时，生成器才使用内置 17 列结构；用户指定自定义生成模板时使用 `--template-excel /absolute/path/template.xlsx`。

demo 页面、示例用例和启动脚本仅在 [源码仓库](https://github.com/anthonyli/laya-pilot#体验-demo) 中提供，不包含在 skill 交付包内。
