# -*- coding: utf-8 -*-
"""手写 tenant-admin/channels 页配置保存用例（WebChat 欢迎消息设置）。

09-26 定性：channels 是配置型页面，无 create 类控件，create/edit/delete 场景
天然不适用。本用例覆盖该页唯一可自动化的写路径：欢迎消息启用态下的
填写→保存→toast 确认（2026-09-27 手动实测全链通过，toast 文本
「欢迎消息设置已保存」）。

探针实测（2026-09-27）：
- checkbox：启用欢迎消息（唯一 checkbox）
- textarea：无 label，dom.mjs 取名回退到 placeholder
  「例如：欢迎访问XX平台在线客服...」
- 保存按钮：保存欢迎消息设置

前提：服务端 webchat_settings.welcome_enabled=true（由首次手写验证保存并
持久化；用例只填写保存，不切换开关，保证确定性）。
"""
import json
import sys

sys.path.insert(0, r'C:\Users\honor1\WorkBuddy\laya-pilot\lib')
import workflow_excel as we  # noqa: E402

URL = 'http://127.0.0.1:5301/tenant-admin/channels'

cases = [
    {
        'id': '002',
        'operation': 'form-validation',
        'steps': [
            {'kind': 'fill', 'value': '${recordName}',
             'target': {'name': '欢迎消息内容',
                        'role': 'textbox', 'scope': 'page'}},
            {'kind': 'click', 'purpose': 'save',
             'target': {'name': '保存欢迎消息设置', 'role': 'button', 'scope': 'page'}},
            {'kind': 'assert-text', 'scope': 'page', 'value': '欢迎消息设置已保存'},
        ],
    },
]

payload = {
    'file': {
        'schemaVersion': 1,
        'generatedAt': '2026-09-27T06:40:00Z',
        'moduleUrl': URL,
        'coverage': ['form-validation'],
        'cases': cases,
    },
    'path': r'C:\Users\honor1\WorkBuddy\laya-pilot\generated-cases\127-0-0-1-5301-tenant-admin-channels.xlsx',
}
result = we.write(payload)
print(json.dumps(result, ensure_ascii=False))
