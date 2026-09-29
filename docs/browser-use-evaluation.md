# Browser Use 评估：准确、快速、稳定优先

核对日期：2026-09-29。[最新稳定发布为 0.13.10](https://github.com/browser-use/browser-use/releases/tag/0.13.10)，发布说明包含 Browser Harness 0.1.13、依赖固定及 MCP 错误处理更新。本文是本项目的采用判断，不是两套引擎的性能测试结果。

## 当前值得保留的价值

[Browser Use CLI](https://docs.browser-use.com/open-source/browser-use-cli) 已提供基于 Browser Harness 的 Python 浏览器控制入口，可以连接本机 Chrome/Chromium 或现有 CDP 浏览器，也有独立的云浏览器入口。本地 CLI 本身不等于必须付费调用外部模型；已有 coding agent 可以编写操作代码。

自主 Agent 则需要通用 LLM 执行规划、观察和工具调用。[模型文档](https://docs.browser-use.com/open-source/supported-models)列出了包括 Ollama 在内的适配方式。[Agent 参数](https://docs.browser-use.com/open-source/customize/agent/all-parameters)允许配置模型、视觉、失败次数与超时。由此判断，使用本地或内网模型是可行方向，但模型的工具调用能力、上下文、硬件与延迟仍决定实际效果。当前 Laya 的候选分类协议不能直接替代完整 Agent 所需的模型协议。

[官方 Playwright 集成示例](https://docs.browser-use.com/open-source/examples/templates/playwright-integration)支持两者通过 CDP 共用 Chrome，并允许 Agent 调用确定性 Playwright 操作。因此后续可以只在未知页面探索阶段试用 Browser Use，继续用现有执行器做回放、断言与失败归因。

## 本轮判断

保留 Playwright 主路径，先完成状态复用、操作范围、断言准确性、进度保存与真实无头回归。Browser Use 保留为待验证的探索入口，不作为 P0 全量替换。

理由是当前需要稳定回放已有流程；重写浏览器层并不能直接修正重复记录定位、状态丢失或错误判成功。自主 Agent 还引入模型推理与新动作协议，收益需要实测。本轮没有安装 Browser Use、没有调用其云模型或云浏览器，也没有把它配置成可选驱动。

不能把云端 [rerunnable scripts](https://docs.browser-use.com/cloud/agent/scripts) 当作本地零推理成本回放的证明。也不能直接将 Agent 自述成功作为测试通过；最终仍由本项目的页面断言和接口/浏览器证据决定。

## 启动对比实验的条件

准备可访问的本地/内网通用模型及固定模型版本，再对同一组任务比较：

| 维度 | 采集内容                                                     | 采用条件                                             |
| ---- | ------------------------------------------------------------ | ---------------------------------------------------- |
| 准确 | 独立断言通过率、误通过数、重复写入数                         | 对比集无误通过和重复写入；不能只看 Agent 返回成功    |
| 速度 | 冷/热启动、总耗时 p50/p95、模型调用数、推理耗时              | 明确比现有方案改善目标任务，不因减少断言获得表面提速 |
| 稳定 | 固定任务至少重复 20 次，注入超时、HTTP 500、登录失效与重渲染 | 失败可定位，进度与证据可保留，写入不盲目重试         |
| 成本 | 模型服务位置、资源占用和外部推理调用数                       | 只使用批准的本地/内网推理路径，外部推理调用为 0      |

现阶段缺少已验证的本地/内网通用模型、真实业务对比集与对应成绩，不能声称 Browser Use 比当前实现更准确或更快。CLI/CDP 对接和自主 Agent 的价值要分开测；前者未必需要额外模型，后者必须评估模型成本与质量。
