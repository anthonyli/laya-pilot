# 先审用例再执行

用户明确要求先审核时，草稿生成与页面执行分开。现有 `--mode generate` 会实际操作页面，不能用来实现“先审再测”。`--inspect` 只检查已有输入，不生成或验证业务用例。

## 离线草稿

根据用户提供的需求、页面说明或已获授权取得的观察资料，将候选用例写为 JSON。保留原测试目标和预期；不了解的业务规则、合法值及选项写入对应 `pending`。记录未覆盖范围，不承诺全菜单覆盖。不要为获得通过而把“查询结果一致”改成“查询框可见”。

```json
{
    "url": "https://test.example/customers",
    "allowWrite": false,
    "uncovered": ["未验证其他菜单"],
    "cases": [
        {
            "id": "001",
            "title": "查看搜索入口",
            "preconditions": "",
            "data": "",
            "steps": "观察页面",
            "expected": "页面显示“搜索”按钮",
            "pending": []
        }
    ]
}
```

`allowWrite` 必须显式填写，只代表草稿拟议范围；它不是用户批准。每条用例的 `pending` 和全局 `uncovered` 均为文本数组。当前审核计划只支持单个目标 URL、普通 Excel 能力及同站点内显式步骤，不支持审批流程和结构化回放迁移。

```bash
node scripts/run.mjs --mode plan --plan-source cases.json --out review-plans/batch-1
```

输出新的 `draft-plan.json` 和 `draft-cases.md`，状态为 `draft-unverified`，同时打印 SHA-256。此入口无需 Python、API 或浏览器，不读取登录配置、不访问页面，也不执行任何用例。输出目录必须不存在，避免覆盖已经审核过的文件。

## 审核与执行

向用户展示草稿内容、目标地址、写操作范围、待补充项、未覆盖项及 SHA-256，等待其明确批准。当用户已在当前对话批准确切版本和范围且文件未变时，沿用该授权。工具不会自动推断批准，`--approved-hash` 只是执行器校验该指令所绑定版本的参数，不是数字签名或身份认证。

修改 `draft-plan.json` 后，可离线检查并获得新摘要；inspect 不需要批准，也不能算作测试通过：

```bash
node scripts/run.mjs --mode reviewed --review-plan review-plans/batch-1/draft-plan.json --inspect
```

`pending` 非空时不执行，需先补充内容并重新审核。执行时将用户明确批准的摘要作为参数：

```bash
node scripts/run.mjs --mode reviewed --review-plan review-plans/batch-1/draft-plan.json \
  --approved-hash APPROVED_SHA256 --headless
```

执行器核对原文件字节的摘要，拒绝用 URL、用例筛选、数据覆盖、名称映射、读写标记或其他模式替换已审核范围。通过校验后只使用内存中的已审核内容生成独立普通 Excel，再按现有引擎执行；不会修改输入草稿。环境中的 URL、Excel、测试数据和操作范围不会覆盖审核计划。账号和模型配置继续使用原机制。

报告和 `review-plan-approval.json` 记录本轮计划摘要与范围。审核代表允许执行，不代表用例或业务结果已经验证；不支持的原预期仍应报告未验证。输入草稿缺少页面证据时不得称为已验证回放用例，也不得绕过生成工作簿的隐藏计划一致性保护。
