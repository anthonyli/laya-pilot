"""Fill the shipped Excel case template with a converted recording."""

import json
import sys
from openpyxl import load_workbook


case = json.load(sys.stdin)
book = load_workbook(sys.argv[1])
sheet = book['测试用例']
fields = ['id', 'title', 'preconditions', 'data', 'steps', 'expected']
headers = ['用例编号', '用例名称', '前置条件', '测试数据', '测试步骤', '预期结果']
if [cell.value for cell in sheet[1]] != headers:
    raise ValueError('用例模板表头已经变化')
for row in sheet.iter_rows(min_row=2):
    for cell in row:
        cell.value = None
for column, field in enumerate(fields, 1):
    cell = sheet.cell(2, column)
    value = case[field]
    if len(value) > 32767:
        raise ValueError('录制内容超过单元格上限，请拆成多条用例')
    cell.value = value
    cell.data_type = 's'
lines = max(case[field].count('\n') + 1 for field in fields)
sheet.row_dimensions[2].height = max(sheet.row_dimensions[2].height or 0, min(409, 22 * lines))
with open(sys.argv[2], 'xb') as output:
    book.save(output)
