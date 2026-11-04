# 安装环境与配置

本 skill 目录包含独立运行代码，无需克隆原项目。保留整个目录结构；依赖在用户机器上安装，ZIP 中不包含 node_modules、Python 虚拟环境、浏览器二进制或模型权重。

## 默认 API 模式

| 组件           | 要求                                               | 安装方式                         |
| -------------- | -------------------------------------------------- | -------------------------------- |
| Node.js 与 npm | Node.js 20+，含 npm                                | 用户先安装到系统                 |
| Python         | 3.10+，含 venv/pip；建议 3.11 或 3.12              | 用户先安装到系统                 |
| 浏览器驱动     | Playwright，版本由包内 lockfile 固定               | 安装脚本执行 `npm ci --omit=dev` |
| 浏览器         | Playwright Chromium                                | 安装脚本安装对应版本             |
| Excel 读写     | Python openpyxl，范围见 `runtime/requirements.txt` | 安装到 skill 内 `.venv/`         |
| 模型           | 用户提供的 HTTPS API、模型名称和密钥               | 用户配置，无本地权重下载         |

在解压后的 skill 目录执行：

```bash
node scripts/setup.mjs
```

安装脚本会创建 `.venv/`、安装 Node/Python 依赖和 Chromium，并在 skill 根目录分别从 `assets/.env.example`、`assets/config.example.json` 创建 `.env.local`、`config.local.json`，与 `SKILL.md` 同级。已有文件保留原样。它不安装本地 Laya、不下载模型权重。需要选择 Python 时使用：

```bash
node scripts/setup.mjs --python /absolute/path/to/python3.11
```

Windows 也使用同一 Node 入口；脚本会选择 `.venv\Scripts\python.exe`，并支持系统 `python` 或 `py -3`。可通过 `--python` 指定 Python 可执行文件。Linux 如缺少 `venv` 或浏览器系统库，先安装对应系统组件；浏览器库可由管理员执行 `node runtime/node_modules/playwright/cli.js install-deps chromium` 安装。安装脚本不会自行提权。

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

检查和运行共用配置解析：命令行优先，其次为 shell 环境变量、skill 的 `.env.local`、所选 JSON 配置和默认值。模型名默认 `laya-decision`，可覆盖。`setup.mjs --check --config /absolute/path/config.json` 可检查独立配置。启动输出的 `CONFIG` 包括 skill 路径、版本摘要、配置文件、provider、模型和登录态文件状态；密钥仅显示是否设置。用 `node scripts/run.mjs --version` 核对版本与内容摘要。

维护者可在仓库执行 `python3 scripts/package_skill.py --install-to /absolute/path/installed-skill` 显式升级指定副本；不指定安装目录时只更新仓库内的打包产物。升级只替换分发文件，保留 `.env.local`、`config.local.json`、`.auth`、依赖和模型。使用 `--check --install-to` 可只比较版本，不改动安装副本。

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

`--local-model` 安装 `runtime/requirements-local.txt` 中的 Laya 及其推理依赖，并通过 Hugging Face 下载 `convaiinnovations/laya-multilingual` 到 skill 内 `models/laya-multilingual/`。需要额外网络、磁盘和内存；已有模型可以通过 `LAYA_MODEL` 或运行时 `--model` 指定路径。使用已有模型时自行安装所需本地依赖即可，无须重复执行下载命令。

每次本地测试都显式传 `--provider local`。未传时仍使用 API；安装过本地模型也不会改变默认来源。

## 目标系统、模板和 demo

在 skill 根目录自动创建的 `config.local.json` 中填写 `excel`（现有或生成用例文件的绝对路径）、`url` 及运行选项。无论从哪个工作目录启动，`scripts/run.mjs` 都默认加载 skill 根目录的这个文件；无须再传 `--config`。普通或生成工作簿都使用同一入口，自动选择执行方式。填写后可直接运行 `node scripts/run.mjs --headless` 执行回归；也可以用 `--excel`、`--url` 临时指定本轮输入。需要切换配置时，用 `--config /absolute/path/another-config.json` 显式覆盖。密码和密钥仍通过环境变量或同目录的 `.env.local` 提供。

现有 Excel 回归直接读取用户用例，无须先生成或下载模板；至少要能识别步骤和预期结果表头。只有用户明确要求生成新用例时，生成器才使用内置 17 列结构；用户指定自定义生成模板时使用 `--template-excel /absolute/path/template.xlsx`。

公开 demo 已包含在包内：

```bash
node runtime/examples/demo-server.mjs
```

保持该进程运行，在另一个终端使用 `scripts/run.mjs` 测试 `http://127.0.0.1:8765/customers`。实际使用示例见 [workflows.md](workflows.md)。
