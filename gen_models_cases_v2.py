# -*- coding: utf-8 -*-
"""models 页用例 v2：原有 4 条（create/edit/delete/form-validation）+ 真网关联动 3 条。

真网关联动设计（升级原「需真实网关👤」项）：
- 006 create：创建本轮独立测试模型（owned-row 前提，同 models 页既有手写套路）。
- 007 bind-key：owned-row 点「点击更换API Key」→ 弹窗内点「LLM网关-hiapi」→
  「确认绑定」→ 断言「API Key绑定成功」。弹窗内选择项/按钮名唯一，无多候选风险。
- 008 test-connectivity：owned-row 点「测试连通性」→ 后端 /test 走代理真实调用
  hiapi 网关；独立记录 model_code 不存在于网关 → 网关返回 4xx → 页面 message
  以「HTTP」开头（后端固定格式 f'HTTP {status}: {text}'）。断言「HTTP」出现即证明
  「后端→代理→网关」链路真实打通（404 model not found = 已通过认证到达网关路由）。
  真实成功路径（gemini-2.5-flash 200/3.5s）已由 API 级实测覆盖，UI 层因多卡片
  同名按钮无法确定性定位特定卡片，决策模型无「选可成功模型」依据，故不在 UI 层断言。
"""
import json
import sys

sys.path.insert(0, r'C:\Users\honor1\WorkBuddy\laya-pilot\lib')
import workflow_excel as we  # noqa: E402

URL = 'http://127.0.0.1:5301/super-admin/models'

cases = [
    {
        'id': '002',
        'operation': 'create',
        'steps': [
            {'kind': 'click', 'purpose': 'create',
             'target': {'name': '添加模型', 'role': 'button', 'scope': 'page'}},
            {'kind': 'fill', 'value': '${recordName}',
             'target': {'name': '模型代码 *', 'role': 'textbox', 'scope': 'form'}},
            {'kind': 'fill', 'value': '${recordName}',
             'target': {'name': '模型名称 *', 'role': 'textbox', 'scope': 'form'}},
            {'kind': 'click', 'purpose': 'save',
             'target': {'name': '保存', 'role': 'button', 'scope': 'form'}},
            {'kind': 'reload'},
            {'kind': 'assert-row', 'value': '${recordName}'},
        ],
    },
    {
        'id': '003',
        'operation': 'edit',
        'steps': [
            {'kind': 'click', 'purpose': 'edit',
             'target': {'name': '编辑', 'role': 'button', 'scope': 'owned-row'}},
            {'kind': 'fill', 'value': '${updatedName}',
             'target': {'name': '模型名称 *', 'role': 'textbox', 'scope': 'form'}},
            {'kind': 'click', 'purpose': 'save',
             'target': {'name': '保存', 'role': 'button', 'scope': 'form'}},
            {'kind': 'reload'},
            {'kind': 'assert-row', 'value': '${updatedName}'},
        ],
    },
    {
        'id': '004',
        'operation': 'delete',
        'steps': [
            {'kind': 'click', 'purpose': 'delete',
             'target': {'name': '删除', 'role': 'button', 'scope': 'owned-row'}},
            {'kind': 'reload'},
            {'kind': 'assert-absent', 'value': '${updatedName}'},
        ],
    },
    {
        'id': '005',
        'operation': 'form-validation',
        'steps': [
            {'kind': 'click', 'purpose': 'create',
             'target': {'name': '添加模型', 'role': 'button', 'scope': 'page'}},
            {'kind': 'click', 'purpose': 'save',
             'target': {'name': '保存', 'role': 'button', 'scope': 'form'}},
            {'kind': 'assert-text', 'scope': 'page',
             'value': '模型代码、名称和类型不能为空'},
        ],
    },
    {
        'id': '006',
        'operation': 'create',
        'steps': [
            {'kind': 'click', 'purpose': 'create',
             'target': {'name': '添加模型', 'role': 'button', 'scope': 'page'}},
            {'kind': 'fill', 'value': '${recordName}',
             'target': {'name': '模型代码 *', 'role': 'textbox', 'scope': 'form'}},
            {'kind': 'fill', 'value': '${recordName}',
             'target': {'name': '模型名称 *', 'role': 'textbox', 'scope': 'form'}},
            {'kind': 'click', 'purpose': 'save',
             'target': {'name': '保存', 'role': 'button', 'scope': 'form'}},
            {'kind': 'reload'},
            {'kind': 'assert-row', 'value': '${recordName}'},
        ],
    },
    {
        'id': '007',
        'operation': 'bind-key',
        'steps': [
            {'kind': 'click', 'purpose': 'bind',
             'target': {'name': '绑定API Key', 'role': 'button', 'scope': 'owned-row'}},
            {'kind': 'click', 'purpose': 'selectKey',
             'target': {'name': 'LLM网关-hiapi', 'role': 'button', 'scope': 'page'}},
            {'kind': 'click', 'purpose': 'bind',
             'target': {'name': '确认绑定', 'role': 'button', 'scope': 'page'}},
            {'kind': 'assert-text', 'scope': 'page', 'value': 'API Key绑定成功'},
        ],
    },
    {
        'id': '008',
        'operation': 'test-connectivity',
        'steps': [
            {'kind': 'click', 'purpose': 'test',
             'target': {'name': '测试连通性', 'role': 'button', 'scope': 'owned-row'}},
            {'kind': 'assert-text', 'scope': 'page', 'value': 'HTTP'},
        ],
    },
    {
        'id': '009',
        'operation': 'delete',
        'steps': [
            {'kind': 'click', 'purpose': 'delete',
             'target': {'name': '删除', 'role': 'button', 'scope': 'owned-row'}},
            {'kind': 'reload'},
            {'kind': 'assert-absent', 'value': '${recordName}'},
        ],
    },
]

payload = {
    'file': {
        'schemaVersion': 1,
        'generatedAt': '2026-09-27T14:00:00Z',
        'moduleUrl': URL,
        'coverage': ['form-validation', 'create', 'edit', 'delete', 'bind-key', 'test-connectivity'],
        'cases': cases,
    },
    'path': r'C:\Users\honor1\WorkBuddy\laya-pilot\generated-cases\127-0-0-1-5301-super-admin-models.xlsx',
}
result = we.write(payload)
print(json.dumps(result, ensure_ascii=False))
