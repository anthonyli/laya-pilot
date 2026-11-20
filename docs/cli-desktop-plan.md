# LayaPilot CLI 与桌面端方案

LayaPilot 的目标是让测试变简单。有人更容易说清楚需求，有人更容易在页面上演示一遍。两种方式最后都应得到用户能理解、能修改、能再次执行的用例，以及说明实际覆盖和失败位置的报告。

## 交付顺序

1. **先完成免费 CLI。** 保留已有 Excel 回归和页面生成用例，同时提供浏览器录制与回放。第一次使用应能按 README 完成安装、生成一条用例、自己运行并找到报告。
2. **再完善共同的运行接口。** 在 CLI 上明确用例文件、运行状态、报告和证据路径。继续补全“地址＋一句话”直接生成测试的体验，确认实际执行所需的范围和预期。
3. **最后开发桌面端。** 使用同一执行层，提供新建项目、保存历史会话、查看执行进度、预览产物和重跑。首次使用可以直接发起测试，项目用于保存和复用。桌面端计划采用授权码，**10 美元一次性买断**；模型服务仍通过配置使用。

## 技术决定

- **保留 Playwright。** 自动等待、断言和执行轨迹直接关系到回归测试能否稳定复跑，以及失败能否定位。继续使用 Node.js 执行层，CLI 由 `package.json` 的 `bin` 暴露为 `laya`。新功能可沿用 JavaScript，后续有需要再引入 TypeScript。
- **CLI 保留一个入口。** Go 原型原本负责启动 Node 执行器。`laya` 现在直接运行 `scripts/run.mjs`，安装、录制和回放通过这一个入口提供，无需构建 Go 或 Rust。
- **分开看运行时和浏览器。** Playwright 执行需要兼容的浏览器。可以复用本机 Chrome 或 Edge，也可安装固定版本的 Chromium。切换到 Go 外壳不会省掉测试浏览器，也不会替换当前 Node 执行层。现阶段优先减少安装步骤和重复维护，包体积作为打包时实测的指标。
- **用 Playwright 录制，用 Excel 管理用例。** Codegen 记录导航、点击、输入和用户标记的断言。关闭窗口同时保存六列模板的自然语言 Excel 和原始 `.spec.cjs`。Excel 交给原有 Laya 决策执行器，记录步骤及业务预期、页面、浏览器和接口检查。用户仍可独立运行 Playwright 用例。
- **保留现有 Excel 契约。** Excel 仍经 `--excel` 分流，结构化工作簿保持完整性校验。现有 Excel 读写仍使用 Python，用户选择的本地模型也可能需要 Python。若后续希望完整分发仅用 Node，先验证工作簿读写与校验等价，再迁移 Excel 层。
- **桌面端共用执行层。** 框架在 CLI 流程稳定后选定。若希望沿用 JavaScript／TypeScript，可评估 Electron。若希望使用系统 WebView，可评估 Rust + Tauri，由桌面应用启动 Node 执行进程。两个方案都需要安排 Playwright 的测试浏览器。当前录制和回放依赖 JavaScript 的 Codegen 与 Playwright Test，Rust 绑定不能直接运行已有 JavaScript 用例。([Electron](https://www.electronjs.org/docs/latest/why-electron) · [Tauri](https://v2.tauri.app/learn/sidecar-nodejs/))

## 录制流程验收

- 从网址开始录制一次筛选操作，添加一个能判定业务结果的断言。
- 保存后可编辑用例，可在另一轮执行中单独运行它。
- 通过和失败都能区分。失败时能找到具体断言、截图和执行轨迹。
- 录制回放与现有 Excel 入口均可用。每次执行生成独立产物，回放不会改写原用例。

使用说明见[录制与回放](../references/recording.md)。
