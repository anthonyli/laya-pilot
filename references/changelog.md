# 更新说明

## 0.2.2 — 2026-11-26

- 普通 Excel 回归支持 `laya run --module-routes routes.json`。旧用例可以只写菜单路径；引擎先查找菜单，缺少入口时才使用对应模块的同源 URL。菜单可见性断言仍按实际页面判断。
- 修复公式编辑器、树形选择器和长流程的录制与回放，录制导出的 Excel 会保留实际访问的页面。
- CLI 与桌面端共用新版 HTML 报告，支持在报告内放大步骤截图。

## 0.2.1 — 2026-11-24

- **录制与回放**。新录制默认把登录、区域切换和业务操作按实际顺序连续回放。需要沿用 0.2.0 的独立用例模式时，录制命令加 `--split-cases`。同源刷新后可继续录制，无法定位的步骤会在原位置标为「待补录」。
- **结果判定**。导航会核对目标页面或选中区域；新增操作会核对列表总数和唯一匹配的新行。下拉选项按所属字段和可见名称定位，旧 Playwright 录制导出为 Excel 时也会保留按键的目标控件。
- **登录续期**。成功录制登录后，按站点和账号在本机加密保存凭据，供录制和 Excel 回放在会话过期时重新登录。升级前仅保存过会话的用户，需要再成功登录一次才能启用续期。详见[录制与回放](recording.md)。
- **测试报告**。报告保留 Playwright 的回放结果与重试证据，区分中止和主动跳过，并按各检查项自身状态显示颜色。复制或移动项目后仍可用 `laya report` 打开最近一次报告。

## 0.2.0 — 2026-11-20

### 新增

- **独立的 `laya` 命令行**：`npm link` 后可在任意目录使用，配置、Python 环境和模型放在 `~/.laya/`（可用 `LAYA_HOME` 修改）。skill 与命令行各自安装，配置互不读取；skill 的帮助和提示只使用 `node scripts/*.mjs`。
- **录制自动拆分与断言**。`laya record` 根据列表、表单和弹窗在操作前后的变化生成多条 Excel 用例和断言，同时保存 Playwright 脚本。查询、新增、编辑和删除可用 `--cases` 单独回放。编辑或删除的准备步骤会复现本次录制中可追溯的新增和前序编辑，并按列值定位唯一测试记录。缺少可复现的前置数据、控件范围含糊或结果证据不足时，生成待复核用例。详见[录制与回放](recording.md)。
- **保留手动检查点和旧录制导出**。工具栏可标记可见文本和输入值。此前的 Playwright 录制可以用 `laya export-excel` 转成 Excel。Enter、Escape、Tab、上下方向键会转成可回放步骤，单独误按的 CapsLock、Shift 等修饰键会跳过。
- **统一的报告目录**。每轮生成 `index.html`，展示运行结论、用例状态、断言和逐步截图。`laya report` 打开当前项目最新一轮报告，也识别用 `--out` 指定的输出位置。`laya report RUN_DIR` 打开指定报告。详见[测试报告怎么看](reports.md)。
- **按用例保存执行轨迹**：每条用例单独录制，只保留未通过用例的轨迹；保存失败时删除残缺文件并记录原因（此前中断时生成的整轮轨迹可能是残缺的）。
- **更省事的 setup**：自动选用本机最新的 Python 3.10+，没有时下载校验过的独立 Python；优先使用本机已有的 Chromium、Chrome 或 Edge；`npm link` / `npm install -g` 后自动执行一次（sudo、CI 或 `LAYA_SKIP_SETUP=1` 时跳过）。`--python` 指定的版本不可用时，报错会写明检测到的版本。
- **结构化用例逐步截图**：生成和回放的每一步都保存截图，步骤用“点击「保存」”这类说明代替内部名称。

### 兼容性

产物目录结构有变化，读取旧路径的脚本需要更新：

| 旧                                                                      | 新                                                                |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `runs/laya-pilot/2026-11-20T04-47-26-547Z-31256/`                       | `runs/laya-pilot/2026-11-20_12-47-26/`（本地时间）                |
| `报告.md`                                                               | `summary.md`                                                      |
| `结果.csv`                                                              | `results.xlsx`（普通 Excel，含用例表和步骤表）                    |
| `执行结果.xlsx`                                                         | `results.xlsx`                                                    |
| `evidence/case-<哈希>-N-M.png`、`evidence/<id>.png`                     | `cases/<序号>-<编号>-<名称>/NN-步骤或预期N-结果.png`、`final.png` |
| `evidence/case-…-controls.json`                                         | `cases/<序号>-…/controls.json`                                    |
| 整轮的 `trace.zip`                                                      | 每条未通过用例的 `cases/<序号>-…/trace.zip`；通过的用例不保留     |
| `excel-inspection.json`、`selection.json`、`checkpoint.json` 等过程文件 | `logs/` 下同名文件                                                |
| `启动浏览器事件.json`、`轨迹保存失败.json`                              | `logs/startup-browser-events.json`、`logs/trace-error.json`       |
| `启动失败.json` / `启动失败.png`                                        | `results.json` 的 `error` 字段 / `run/startup-failure.png`        |
| 录制回放的 `report/`、`artifacts/`                                      | `playwright-report/`、`cases/`                                    |
| skill 目录下的 `latest-run.json`                                        | `runs/laya-pilot/latest.json`                                     |

`results.json` 的已有字段保持不变，普通 Excel 用例新增 `evidence_dir`、`input`、`url`；用例可能新增 `trace` / `trace_error`；结构化用例的 `attempts` 每一步都有 `evidence`，并新增 `text` 说明。

## 0.1.1 — 2026-11-17

本版包含用户反馈修复 #29–#32，重点改善普通 Excel 的执行证据、先审后执行流程、可执行性诊断及图标定位。版本号来自 `package.json`；分发包的 `manifest.json` 同时记录版本和内容摘要。

### 修复与新增

- **步骤与断言证据**（[PR #29](https://github.com/anthonyli/laya-pilot/pull/29)，#26）：每个逻辑步骤和每条预期结束时保存独立截图，关联原文、范围、时间与执行状态；保留用例最终截图，避免同名和重复执行覆盖。截图失败不输出虚假链接，也不改变业务判断。
- **先审用例再执行**（[PR #30](https://github.com/anthonyli/laya-pilot/pull/30)，#27）：新增离线 `--mode plan` 草稿入口与 `--mode reviewed` 执行入口。执行绑定已审核文件的 SHA-256 和操作范围，拒绝额外 URL、数据、控件绑定等覆盖；待补充项未解决时不执行。转换前检查 Excel 文本限制，避免审核内容被静默截断。详见[审核流程](review-plan.md)。
- **用例可执行性诊断**（[PR #31](https://github.com/anthonyli/laya-pilot/pull/31)，#25）：预检和报告逐项区分缺少数据、待页面定位、未支持语法及缺少业务判定依据。支持范围明确的复合预期；任一子项失败或未验证，整条不能通过。保留原工作簿和业务意图，未知前置条件继续标记待补证，已证明失败的前提继续阻断。详见[用例填写说明](case-template.md)。
- **无标签图标诊断与显式绑定**（[PR #32](https://github.com/anthonyli/laya-pilot/pull/32)，#28）：保留无法确定语义的控件及其 frame、行和上下文；支持可靠的 SVG title 与关联 tooltip，排除隐藏图标、装饰节点和空白名称。普通 Excel 可通过 `--control-bindings` 提供已核实的名称；定位须唯一，重渲染和决策期间目标变化会重新校验或停止。详见[绑定说明](control-bindings.md)。

### 兼容性与升级

- `--excel`、原验证式 `--mode generate` 及结构化回放保持兼容；`generate` 仍会实际操作页面，先审核任务应使用新的草稿流程。
- JSON 增加诊断与证据字段；CSV 保留已有列顺序并在末尾追加诊断列；Markdown 同时提供步骤证据、用例诊断和未识别控件诊断。
- 原输入 Excel 不被改写。通过仓库的 `scripts/package_skill.py --install-to <安装目录>` 升级可保留 `.env.local`、`.auth`、依赖和模型；解压 ZIP 手动更新时也应保留这些本机文件。更新后在安装目录运行 `node scripts/setup.mjs`，用 `node scripts/run.mjs --version` 确认版本为 `0.1.1`。
- ZIP 附带更新说明、运行源码和 manifest；不含本机密钥、登录态、运行报告、已安装依赖或模型。

### 验证与范围

本批修复的最终合并版本通过 89 项 Node 测试、35 项 Chromium/CLI 浏览器测试、42 项 Python 测试；合并后 9 项关键流程冒烟测试通过，格式、skill 与打包一致性检查通过。

验证使用本地合成页面与测试服务，未重跑反馈原业务系统，也未调用真实推理模型。逐步截图和显式绑定针对普通 Excel；显式绑定仅支持主页面，结构化生成/回放拒绝该参数。截图与控件诊断是对应采集时点的快照，不保证捕获已经消失的瞬时提示或节点。未知业务规则、复杂组件和多账号权限仍需专项适配与验收。
