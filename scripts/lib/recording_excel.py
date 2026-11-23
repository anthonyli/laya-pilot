"""Fill the shipped Excel case template with a converted recording."""

import json
import sys
from copy import copy
from openpyxl import load_workbook


cases = json.load(sys.stdin)
book = load_workbook(sys.argv[1])
sheet = book['测试用例']
fields = ['id', 'title', 'preconditions', 'data', 'steps', 'expected']
headers = ['用例编号', '用例名称', '前置条件', '测试数据', '测试步骤', '预期结果']
if [cell.value for cell in sheet[1]] != headers:
    raise ValueError('用例模板表头已经变化')
for row in sheet.iter_rows(min_row=2):
    for cell in row:
        cell.value = None
row = 2
for case in cases:
    # Merged identity cells let the existing importer reassemble one long case.
    first = row
    step_lines = case['steps'].split('\n')
    for offset in range(0, len(step_lines), 12):
        values = {field: case[field] if offset == 0 or field == 'id' else '' for field in fields}
        values['steps'] = '\n'.join(step_lines[offset : offset + 12])
        for column, field in enumerate(fields, 1):
            cell = sheet.cell(row, column)
            value = values[field]
            if len(value) > 32767:
                raise ValueError(f'{case["id"]} 的{headers[column - 1]}超过单元格上限')
            cell.value = value
            cell.data_type = 's'
            if row > 2:
                cell.alignment = copy(sheet.cell(2, column).alignment)
        lines = max(value.count('\n') + 1 for value in values.values())
        sheet.row_dimensions[row].height = max(
            sheet.row_dimensions[row].height or 0, min(409, 22 * lines)
        )
        row += 1
    if row - first > 1:
        sheet.merge_cells(start_row=first, end_row=row - 1, start_column=2, end_column=2)
with open(sys.argv[2], 'xb') as output:
    book.save(output)
