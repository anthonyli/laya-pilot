# -*- coding: utf-8 -*-
"""手写 super-admin/plans 页写场景用例（创建/编辑/删除 + 表单校验）。

09-26 决策模型在该页长表单（10+ 字段含数字校验）上填写不完整，改为基于
DOM 探针实测控件名手工构造用例步骤，经 workflow_excel.write 落盘保证
可见文本与隐藏步骤 sha 一致（同 gen_models_cases.py 套路）。

探针实测（2026-09-27）：
- 页面按钮：添加套餐 / 每卡 编辑、删除
- 创建弹窗：套餐代码 *、套餐名称 *、英文名称（textbox）；状态启用（checkbox）；
  月付价格 (USDT)、年付价格 (USDT)、最大客服数 (0=无限)…（spinbutton）；保存/取消
- 空表单保存提示：套餐代码和名称不能为空
"""
import json
import sys

sys.path.insert(0, r'C:\Users\honor1\WorkBuddy\laya-pilot\lib')
import workflow_excel as we  # noqa: E402

URL = 'http://127.0.0.1:5301/super-admin/plans'

cases = [
    {
        'id': '002',
        'operation': 'create',
        'steps': [
            {'kind': 'click', 'purpose': 'create',
             'target': {'name': '添加套餐', 'role': 'button', 'scope': 'page'}},
            {'kind': 'fill', 'value': '${recordName}',
             'target': {'name': '套餐代码 *', 'role': 'textbox', 'scope': 'form'}},
            {'kind': 'fill', 'value': '${recordName}',
             'target': {'name': '套餐名称 *', 'role': 'textbox', 'scope': 'form'}},
            {'kind': 'fill', 'value': '29',
             'target': {'name': '月付价格 (USDT)', 'role': 'spinbutton', 'scope': 'form'}},
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
             'target': {'name': '套餐名称 *', 'role': 'textbox', 'scope': 'form'}},
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
             'target': {'name': '添加套餐', 'role': 'button', 'scope': 'page'}},
            {'kind': 'click', 'purpose': 'save',
             'target': {'name': '保存', 'role': 'button', 'scope': 'form'}},
            {'kind': 'assert-text', 'scope': 'page',
             'value': '套餐代码和名称不能为空'},
        ],
    },
]

payload = {
    'file': {
        'schemaVersion': 1,
        'generatedAt': '2026-09-27T06:30:00Z',
        'moduleUrl': URL,
        'coverage': ['form-validation', 'create', 'edit', 'delete'],
        'cases': cases,
    },
    'path': r'C:\Users\honor1\WorkBuddy\laya-pilot\generated-cases\127-0-0-1-5301-super-admin-plans.xlsx',
}
result = we.write(payload)
print(json.dumps(result, ensure_ascii=False))
