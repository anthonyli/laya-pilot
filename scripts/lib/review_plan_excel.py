"""Materialize a validated review-plan snapshot; never explore or execute a page."""

import json
import sys
from openpyxl import Workbook


plan = json.load(sys.stdin)
book = Workbook()
sheet = book.active
sheet.title = '审核用例'
sheet.append(['用例编号', '用例名称', '前置条件', '测试数据', '测试步骤', '预期结果'])
for case in plan['cases']:
    row = sheet.max_row + 1
    for column, key in enumerate(['id', 'title', 'preconditions', 'data', 'steps', 'expected'], 1):
        cell = sheet.cell(row, column)
        cell.value = case[key]
        cell.data_type = 's'
with open(sys.argv[1], 'xb') as output:
    book.save(output)
