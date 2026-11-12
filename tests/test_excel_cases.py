"""Case boundaries for ordinary Excel rows, including optional id and title columns."""

import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from openpyxl import Workbook

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('case_boundary_worker', ROOT / 'scripts/worker.py')
worker = importlib.util.module_from_spec(spec)
with patch.object(sys, 'stdin', io.StringIO('')):
    spec.loader.exec_module(worker)


def workbook(rows, merges=(), sheet_name='用例', extra_sheets=()):
    book = Workbook()
    sheet = book.active
    sheet.title = sheet_name
    for row in rows:
        sheet.append(list(row))
    for ref in merges:
        sheet.merge_cells(ref)
    for name, sheet_rows, sheet_merges in extra_sheets:
        extra = book.create_sheet(name)
        for row in sheet_rows:
            extra.append(list(row))
        for ref in sheet_merges:
            extra.merge_cells(ref)
    return book


class ExcelCaseBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='laya-case-boundary-')
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)

    def read(self, book, name='cases.xlsx'):
        path = self.directory / name
        book.save(path)
        book.close()
        return worker.read_excel(path)

    def test_required_columns_only_stay_separate_cases(self):
        imported = self.read(
            workbook(
                [
                    ['用例编号', '用例名称', '前置条件', '测试数据', '测试步骤', '预期结果'],
                    [None, None, None, None, '在“姓名”输入“甲”', '“姓名”的值为“甲”'],
                    [None, None, None, None, '在“姓名”输入“乙”', '“姓名”的值为“乙”'],
                ]
            )
        )
        self.assertEqual(imported['warnings'], [])
        self.assertEqual([case['id'] for case in imported['cases']], ['用例-2', '用例-3'])
        self.assertEqual(
            [case['steps'] for case in imported['cases']],
            ['在“姓名”输入“甲”', '在“姓名”输入“乙”'],
        )
        self.assertEqual(
            [case['expected'] for case in imported['cases']],
            ['“姓名”的值为“甲”', '“姓名”的值为“乙”'],
        )

    def test_missing_identity_columns_are_one_case_per_row(self):
        imported = self.read(
            workbook(
                [
                    ['测试步骤', '预期结果'],
                    ['在“姓名”输入“甲”', '“姓名”的值为“甲”'],
                    ['在“姓名”输入“乙”', '“姓名”的值为“乙”'],
                ]
            )
        )
        self.assertEqual(imported['warnings'], [])
        self.assertEqual([case['id'] for case in imported['cases']], ['用例-2', '用例-3'])
        self.assertEqual(len(imported['cases'][0]['steps'].splitlines()), 1)

    def test_blank_identity_after_a_named_case_is_not_silently_merged(self):
        imported = self.read(
            workbook(
                [
                    ['用例编号', '用例名称', '测试步骤', '预期结果'],
                    ['001', '第一例', '在“姓名”输入“甲”', '“姓名”的值为“甲”'],
                    [None, None, '在“姓名”输入“乙”', '“姓名”的值为“乙”'],
                ]
            )
        )
        self.assertEqual([case['id'] for case in imported['cases']], ['001', '用例-3'])
        self.assertEqual(imported['cases'][1]['steps'], '在“姓名”输入“乙”')
        self.assertTrue(any('第3行' in warning for warning in imported['warnings']))
        self.assertTrue(all('已按独立用例保留' in warning for warning in imported['warnings']))

    def test_names_or_distinct_ids_keep_rows_separate_without_warning(self):
        named = self.read(
            workbook(
                [
                    ['用例编号', '用例名称', '测试步骤', '预期结果'],
                    [None, '第一例', '步骤甲', '预期甲'],
                    [None, '第二例', '步骤乙', '预期乙'],
                ]
            ),
            'named.xlsx',
        )
        numbered = self.read(
            workbook(
                [
                    ['用例编号', '用例名称', '测试步骤', '预期结果'],
                    ['001', None, '步骤甲', '预期甲'],
                    ['002', None, '步骤乙', '预期乙'],
                ]
            ),
            'numbered.xlsx',
        )
        self.assertEqual(named['warnings'], [])
        self.assertEqual(numbered['warnings'], [])
        self.assertEqual([case['title'] for case in named['cases']], ['第一例', '第二例'])
        self.assertEqual([case['id'] for case in numbered['cases']], ['001', '002'])

    def test_merged_identity_cells_still_continue_one_case(self):
        imported = self.read(
            workbook(
                [
                    ['用例编号', '用例名称', '前置条件', '测试数据', '测试步骤', '预期结果'],
                    ['001', '登录', '已打开', '甲', '输入甲', '值为甲'],
                    [None, None, '仍打开', '乙', '输入乙', '值为乙'],
                    [None, None, None, None, '输入丙', '值为丙'],
                ],
                merges=('A2:A4', 'B2:B4'),
            )
        )
        self.assertEqual(imported['warnings'], [])
        self.assertEqual(len(imported['cases']), 1)
        case = imported['cases'][0]
        self.assertEqual(case['id'], '001')
        self.assertEqual(case['steps'], '输入甲\n输入乙\n输入丙')
        self.assertEqual(case['expected'], '值为甲\n值为乙\n值为丙')
        self.assertEqual(case['preconditions'], '已打开\n仍打开')
        self.assertEqual(case['data'], '甲\n乙')

    def test_merged_id_alone_continues_when_title_is_blank(self):
        imported = self.read(
            workbook(
                [
                    ['用例编号', '用例名称', '测试步骤', '预期结果'],
                    ['9', None, '步骤甲', '预期甲'],
                    [None, None, '步骤乙', '预期乙'],
                ],
                merges=('A2:A3',),
            )
        )
        self.assertEqual(imported['warnings'], [])
        self.assertEqual(len(imported['cases']), 1)
        self.assertEqual(imported['cases'][0]['id'], '009')
        self.assertEqual(imported['cases'][0]['steps'], '步骤甲\n步骤乙')

    def test_merged_id_with_a_new_title_is_not_silently_merged(self):
        imported = self.read(
            workbook(
                [
                    ['用例编号', '用例名称', '测试步骤', '预期结果'],
                    ['001', '第一例', '步骤甲', '预期甲'],
                    [None, '第二例', '步骤乙', '预期乙'],
                ],
                merges=('A2:A3',),
            )
        )
        self.assertEqual([case['title'] for case in imported['cases']], ['第一例', '第二例'])
        self.assertEqual(imported['cases'][1]['steps'], '步骤乙')
        self.assertTrue(
            any('第3行' in warning and '合并' in warning for warning in imported['warnings'])
        )

    def test_merging_steps_does_not_join_independent_rows(self):
        imported = self.read(
            workbook(
                [
                    ['用例编号', '用例名称', '测试步骤', '预期结果'],
                    [None, None, '步骤甲', '预期甲'],
                    [None, None, None, '预期乙'],
                ],
                merges=('C2:C3',),
            )
        )
        self.assertEqual(imported['warnings'], [])
        self.assertEqual(len(imported['cases']), 2)
        self.assertEqual(imported['cases'][0]['expected'], '预期甲')
        self.assertEqual(imported['cases'][1]['expected'], '预期乙')
        self.assertEqual(imported['cases'][1]['steps'], '')

    def test_blank_rows_on_another_sheet_do_not_continue_the_previous_case(self):
        imported = self.read(
            workbook(
                [
                    ['用例编号', '用例名称', '测试步骤', '预期结果'],
                    ['001', '第一例', '步骤甲', '预期甲'],
                ],
                extra_sheets=(
                    (
                        '第二表',
                        [
                            ['用例编号', '用例名称', '测试步骤', '预期结果'],
                            [None, None, '步骤乙', '预期乙'],
                            [None, None, '步骤丙', '预期丙'],
                        ],
                        (),
                    ),
                ),
            )
        )
        self.assertEqual(imported['warnings'], [])
        self.assertEqual(
            [(case['sheet'], case['steps']) for case in imported['cases']],
            [('用例', '步骤甲'), ('第二表', '步骤乙'), ('第二表', '步骤丙')],
        )

    def test_formula_on_a_merged_continuation_stays_on_that_case(self):
        book = Workbook()
        sheet = book.active
        sheet.title = '用例'
        sheet.append(['用例编号', '测试步骤', '预期结果'])
        sheet.append(['001', '步骤甲', '预期甲'])
        sheet.append([None, '=A1', '预期乙'])
        sheet.merge_cells('A2:A3')
        imported = self.read(book)
        self.assertEqual(len(imported['cases']), 1)
        self.assertIn('B3', imported['cases'][0]['import_error'])
        self.assertEqual(imported['cases'][0]['expected'], '预期甲\n预期乙')


@unittest.skipUnless(shutil.which('node'), 'Node.js is required for CLI inspect tests')
class ExcelInspectBoundaryTests(unittest.TestCase):
    def test_public_inspect_keeps_required_only_rows_separate(self):
        env = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith(('LAYA_', 'TEST_', 'BROWSER_'))
        }
        with tempfile.TemporaryDirectory(prefix='laya-inspect-boundary-') as temporary:
            root = Path(temporary)
            for name, named in (('empty', False), ('named', True)):
                book = Workbook()
                sheet = book.active
                sheet.append(
                    ['用例编号', '用例名称', '前置条件', '测试数据', '测试步骤', '预期结果']
                )
                sheet.append(
                    [
                        None,
                        '第一例' if named else None,
                        None,
                        None,
                        '在“姓名”输入“甲”',
                        '“姓名”的值为“甲”',
                    ]
                )
                sheet.append(
                    [
                        None,
                        '第二例' if named else None,
                        None,
                        None,
                        '在“姓名”输入“乙”',
                        '“姓名”的值为“乙”',
                    ]
                )
                workbook_path = root / f'{name}.xlsx'
                book.save(workbook_path)
                book.close()
                output = root / name
                completed = subprocess.run(
                    [
                        'node',
                        str(ROOT / 'scripts/run.mjs'),
                        '--excel',
                        str(workbook_path),
                        '--inspect',
                        '--python',
                        sys.executable,
                        '--out',
                        str(output),
                    ],
                    check=False,
                    capture_output=True,
                    text=True,
                    env=env,
                    cwd=ROOT,
                    timeout=30,
                )
                self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
                selection = json.loads((output / 'selection.json').read_text())
                inspection = json.loads((output / 'excel-inspection.json').read_text())
                self.assertEqual(selection['total'], 2)
                self.assertEqual(selection['selected'], 2)
                self.assertEqual(inspection['warnings'], [])
                self.assertEqual(
                    [case['id'] for case in inspection['cases']], ['Sheet-2', 'Sheet-3']
                )
                self.assertEqual(
                    [
                        [step['text'], step['verb']]
                        for case in inspection['cases']
                        for step in case['steps']
                    ],
                    [['在“姓名”输入“甲”', 'fill'], ['在“姓名”输入“乙”', 'fill']],
                )
                self.assertEqual(
                    [item['text'] for case in inspection['cases'] for item in case['expected']],
                    ['“姓名”的值为“甲”', '“姓名”的值为“乙”'],
                )
                self.assertTrue(all(len(case['steps']) == 1 for case in inspection['cases']))


if __name__ == '__main__':
    unittest.main()
