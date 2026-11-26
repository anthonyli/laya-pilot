# LayaPilot 工作流程

[English](workflow.en.md) · [返回 README](../README.md)

## 总览

```mermaid
flowchart TD
    skill["AI skill<br/>node scripts/run.mjs<br/>配置：skill 目录/.env.local"]
    cli["命令行 fa<br/>bin/fa.mjs<br/>配置：~/.falcon/.env.local"]
    skill --> entry
    cli --> entry
    entry["lib/entry.mjs + common.mjs<br/>决定配置目录与命令写法<br/>读取配置：命令行 > 环境变量 > .env.local > 默认值"]
    entry --> dispatch{"run.mjs<br/>按子命令分发"}

    dispatch -->|"setup / check"| setup["setup.mjs<br/>Python 环境 + openpyxl<br/>Chromium · 本地模型（按需）"]
    dispatch -->|"record / replay / report / export-excel"| rec["录制流程<br/>lib/recording.mjs"]
    dispatch -->|"--mode plan"| plan["review-plan.mjs<br/>离线整理草稿，不访问页面"]
    dispatch -->|"--mode reviewed"| reviewed["runner.mjs<br/>核对 --approved-hash"]
    dispatch -->|"--excel / --mode generate"| runner["runner.mjs<br/>识别 Excel 格式"]

    plan --> draft["草稿计划 + SHA-256"]
    draft -->|"用户审核批准"| reviewed
    reviewed --> workflow

    runner -->|"普通用例（六列模板）"| worker["worker.py<br/>读取并校验 Excel"]
    runner -->|"结构化计划 / generate"| workflow["lib/workflow.mjs<br/>页面发现 · 写操作策略 · 回放与断言"]
    worker --> engine["lib/engine.mjs<br/>逐步执行 + Laya 模型决策<br/>（默认 API，本地需 --provider local）"]

    rec --> codegen["record URL<br/>Playwright Codegen：用户操作 + 标记断言"]
    codegen --> spec["FILE.spec.cjs<br/>原始 Playwright 用例"]
    codegen --> xlsx["FILE.xlsx<br/>六列模板的自然语言用例"]
    xlsx -->|"replay FILE.xlsx = --excel"| runner
    spec -->|"replay FILE.spec.cjs"| pwtest["Playwright Test<br/>HTML 报告 + results.json"]

    engine --> out
    workflow --> out
    pwtest --> out
    out[("产物：当前目录/runs/laya-pilot/日期_时间/<br/>index.html · summary.md · results.json/xlsx<br/>cases/ 每一步的截图与失败用例轨迹 · logs/<br/>原始工作簿不改写")]
```

## 各环节说明

| 环节       | 入口                                    | 做什么                                                                  |
| ---------- | --------------------------------------- | ----------------------------------------------------------------------- |
| 安装与检查 | `fa setup` / `fa check`                 | 安装 Python 环境、openpyxl、Chromium；检查依赖和 API 配置是否齐全       |
| 检查用例   | `fa run --excel FILE --inspect`         | 只解析和诊断 Excel，不打开浏览器、不调用模型                            |
| 回归 Excel | `fa run --excel FILE --url URL`         | 普通用例经 `worker.py` 读取后由 Engine 执行；结构化计划由 workflow 执行 |
| 生成用例   | `fa run --mode generate --url URL`      | 探索页面并实际执行，只导出断言通过的用例                                |
| 审核后执行 | `--mode plan` → `--mode reviewed`       | 先离线出草稿和摘要，用户批准该摘要后才执行，审核和执行分开              |
| 录制       | `fa record URL`                         | 浏览器中操作并标记断言，同时保存 Excel 和 Playwright 脚本               |
| 回放       | `fa replay FILE.xlsx` / `FILE.spec.cjs` | Excel 交给 Laya 执行器；`.spec.cjs` 交给 Playwright Test                |

skill 中把 `fa X` 换成 `node scripts/run.mjs X`，`fa setup` 换成 `node scripts/setup.mjs`。

## 关键规则

- **两个入口，一套执行代码。** skill 和命令行只在配置目录与命令写法上不同，配置互不读取。
- **`--excel` 自动分流。** 结构化计划校验失败直接报错，不降级为普通用例执行。
- **写操作需授权。** 新增、修改、删除必须显式加 `--allow-write`，录制回放同样适用。
- **模型默认走 API。** 只有每次运行显式传 `--provider local` 才使用本地模型。
- **产物写在当前目录。** 报告在 `runs/laya-pilot/<日期_时间>/`，从 `index.html` 开始看（见 [测试报告怎么看](../references/reports.md)），录制在 `recorded-cases/`，生成用例在 `generated-cases/`，都相对于执行命令时所在的目录。
