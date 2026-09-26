# -*- coding: utf-8 -*-
"""手写 super-admin/models 页写场景用例（创建/编辑/删除 + 表单校验）。

决策模型探索在该页无法产出 create 场景（表单为手写 Label 结构 + 弹窗，
LLM 决策把握不足），改为基于 DOM 探针实测控件名手工构造用例步骤，
经 workflow_excel.write 落盘以保证可见文本与隐藏步骤 sha 一致。
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
]

payload = {
    'file': {
        'schemaVersion': 1,
        'generatedAt': '2026-09-27T01:30:00Z',
        'moduleUrl': URL,
        'coverage': ['form-validation', 'create', 'edit', 'delete'],
        'cases': cases,
    },
    'path': r'C:\Users\honor1\WorkBuddy\laya-pilot\generated-cases\127-0-0-1-5301-super-admin-models.xlsx',
}
result = we.write(payload)
print(json.dumps(result, ensure_ascii=False))
