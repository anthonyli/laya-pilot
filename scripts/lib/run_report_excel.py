"""Write the per-run results.xlsx from JSON on stdin: {"sheets": [{title, header, rows, link}]}."""

import json
import sys
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

FILLS = {
    '通过': 'DAFBE1',
    '已验证': 'DAFBE1',
    '已完成': 'DAFBE1',
    '失败': 'FFEBE9',
    '未生成': 'FFEBE9',
    '未验证': 'FFF8C5',
    '阻断': 'FFF8C5',
}


def safe(value):
    """Keep cell text literal: never let workbook content become a formula."""
    if isinstance(value, str) and value[:1] in ('=', '+', '-', '@', '\t', '\r'):
        return "'" + value
    return value


def main():
    output = Path(sys.argv[1])
    payload = json.load(sys.stdin)
    book = Workbook()
    book.remove(book.active)
    for spec in payload['sheets']:
        sheet = book.create_sheet(spec['title'])
        sheet.append(spec['header'])
        for cell in sheet[1]:
            cell.font = Font(bold=True)
        status_column = spec['header'].index('结果' if '结果' in spec['header'] else '状态') + 1
        link = spec.get('link')
        for row in spec['rows']:
            sheet.append([safe(v) for v in row])
            index = sheet.max_row
            status = sheet.cell(index, status_column)
            if status.value in FILLS:
                status.fill = PatternFill('solid', fgColor=FILLS[status.value])
            if link is not None:
                target = sheet.cell(index, link + 1)
                text = str(target.value or '')
                if text.startswith(('cases/', 'run/')):
                    target.hyperlink = text
                    target.font = Font(color='0969DA', underline='single')
        sheet.freeze_panes = 'A2'
        sheet.auto_filter.ref = sheet.dimensions
        for column in range(1, len(spec['header']) + 1):
            width = max(len(str(c.value or '')) for c in sheet[get_column_letter(column)])
            sheet.column_dimensions[get_column_letter(column)].width = min(max(width + 2, 8), 60)
    output.parent.mkdir(parents=True, exist_ok=True)
    book.save(output)


if __name__ == '__main__':
    main()
