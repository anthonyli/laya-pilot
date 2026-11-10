# LayaPilot · 企业管理后台自动化测试

[English](README.en.md) · [详细用法](skills/laya-pilot/references/workflows.md) · [架构](docs/architecture.md) · [Roadmap](ROADMAP.md)

读取 Excel 测试用例，在浏览器中执行原步骤和预期，输出结果、报告与失败证据；也支持从页面生成经过实际验证的新用例。主要适用于表格、筛选、表单和增删改查等后台页面。

**推荐通过 AI skill 使用**，由 AI 协助配置、登录、执行和分析报告。也可以直接使用仓库代码运行 `run.sh`。

两种方式都需要 **Node.js 20+（含 npm）、Python 3.10+（含 venv/pip）**。使用 API 不需要显卡或本地模型权重。

## 方式一：使用 skill（推荐）

### 1. 安装完整 skill 目录

将本仓库的整个 [skills/laya-pilot/](skills/laya-pilot/) 目录复制到 AI 工具的 skill 安装目录，或解压维护者提供的 `laya-pilot-skill.zip` 后安装。入口是 [SKILL.md](skills/laya-pilot/SKILL.md)，目录内自带运行代码，无需保留原仓库。

在**安装后的 skill 目录**执行一次：

```bash
node scripts/setup.mjs
```

它会安装 Playwright、Chromium 和 openpyxl，并创建以下本机配置文件：

| 文件                | 填写内容                                          |
| ------------------- | ------------------------------------------------- |
| `.env.local`        | API 地址、模型名、密钥；可选的测试账号和密码      |
| `config.local.json` | 测试页面 URL；可选的 Excel 路径、账号和登录态设置 |

### 2. 配置 API 和目标页面

skill 默认使用 API，默认模型为 `laya-decision`，可按服务实际支持的模型覆盖。在 skill 的 `.env.local` 中填写：

```dotenv
LAYA_API_BASE=https://your-gateway.example/v1
LAYA_API_MODEL=laya-decision
LAYA_API_KEY=your-api-key
```

API 需要支持本项目的候选决策 JSON 协议，详见 [安装与 API 配置](skills/laya-pilot/references/setup.md)。

在同目录的 `config.local.json` 中设置目标页面；执行已有用例时，还可填写 `excel` 的绝对路径：

```json
{
    "url": "https://your-test-app.example/module"
}
```

检查配置与实际安装版本：

```bash
node scripts/setup.mjs --check
node scripts/run.mjs --version
```

配置文件始终位于安装后的 skill 目录。运行时会显示配置来源、API 模型和登录态文件状态；API 密钥只显示是否设置。仅在明确选择本地推理时使用 `--provider local`，安装方法见 [配置说明](skills/laya-pilot/references/setup.md)。

### 3. 直接告诉 AI 要做什么

在支持 `$skill-name` 的工具中，可以这样发起任务：

```text
用 $laya-pilot 执行 /absolute/path/cases.xlsx 的全部用例。
先检查解析结果，再使用已配置的测试地址无头执行，提供报告和失败证据。

用 $laya-pilot 为 https://your-test-app.example/module 生成只读测试用例。
登录成功后记住登录态，方便下次复用。

用 $laya-pilot 分析 /absolute/path/run/results.json，说明失败步骤和原因。
```

已有 Excel 和生成的 Excel 都使用 `--excel` 执行，不需要另选回放模式。生成仅在明确要求时进行，默认不把现有 Excel 当生成模板。

首次登录可以人工完成，或通过 `.env.local` 中的 `TEST_USER`、`TEST_PASSWORD` 自动登录。要求记住登录后，skill 会配置 `.auth` 文件及登录成功标记，后续先校验并复用登录态；过期后重新登录。密码和密钥不放进 JSON、命令行或聊天示例。

## 方式二：使用仓库代码和 run.sh（可选）

适合希望自行配置、运行脚本或开发适配的用户。以下命令在**仓库根目录**执行，`python3` 需满足 3.10+：

```bash
git clone https://github.com/anthonyli/laya-pilot.git
cd laya-pilot
npm ci
npx playwright install chromium
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cp .env.example .env.local
```

在仓库根目录的 `.env.local` 填写上面的 API 配置。仓库 CLI 保留本地模型默认值，下面示例显式使用 `--provider api`：

```bash
# 检查已有 Excel，不访问业务页面
bash run.sh --provider api --excel /absolute/path/cases.xlsx --inspect

# 执行已有或生成的 Excel
bash run.sh --provider api --excel /absolute/path/cases.xlsx \
  --url https://your-test-app.example/module --headless

# 从页面生成只读用例
bash run.sh --provider api --mode generate \
  --url https://your-test-app.example/module --read-only
```

执行含新增、修改、删除的用例前，先确定测试环境和授权范围，再加 `--allow-write`；生成 CRUD 用例的操作范围见 [工作流说明](skills/laya-pilot/references/workflows.md)。`run.sh` 使用 Bash，适用于 macOS/Linux；Windows 可使用 `node runner.mjs`。本地模型安装和完整参数见 [仓库运行指南](docs/local-runtime.md)，命令帮助用 `bash run.sh --help` 查看。

## 结果与适用范围

- 用例生成到 `generated-cases/`；每轮报告和证据写入 `runs/`。skill 的运行目录为 `runs/laya-pilot/<本轮>/`。
- 报告包含 JSON、Markdown 和实际产生的浏览器证据；普通 Excel 执行另有 CSV，生成和结构化执行另有独立的 `执行结果.xlsx`。原始输入工作簿保持不变。
- 生成的用例文件只收录实际执行且页面断言通过的用例；全部尝试及未覆盖原因保留在结果报告。固定规则检查可能不调用模型，实际 API 调用次数见报告。

当前使用 Playwright 与 Laya 决策协议。复杂审批、多账号权限、文件导入、Canvas 等流程需要适配。只读筛选检查验证控件可见，不代表查询结果和重置行为已通过业务验证。

## 演示、升级与开发

运行 `npm run demo` 后，可对 `http://127.0.0.1:8765/customers` 体验测试。演示页面和现有用例位于 [examples/](examples/)。

![公开 demo](docs/demo.png)

[介绍视频](https://github.com/user-attachments/assets/940b2562-41ff-47ed-a6e0-e179d4d0847d) · [YouTube](https://www.youtube.com/watch?v=aIZEEcTGM0w)

维护者在仓库根目录打包、检查或显式升级指定安装副本：

```bash
npm run skill:package
npm run skill:check
npm run skill:package -- --install-to /absolute/path/installed-skill
```

升级命令保留 `.env.local`、`config.local.json`、`.auth`、依赖和模型。直接删除旧 skill 目录会同时删除这些本机数据，重新安装后需要再次配置。分发包的 `manifest.json` 记录版本和内容摘要，不包含本机配置和登录态；该文件由打包脚本按当前源码生成，不纳入版本控制，安装副本从 ZIP 中获得。

开发验证使用 `npm test`、`npm run format:check`；Python 和浏览器测试命令见 [运行指南](docs/local-runtime.md)。

MIT License。Laya、Playwright 及模型权重遵循各自许可证。
