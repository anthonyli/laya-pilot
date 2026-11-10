"""Exercise actual CLI import/selection without starting a browser or a model."""

import json
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from openpyxl import Workbook, load_workbook


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which('node'), 'Node.js is required for CLI selection tests')
class ExcelSelectionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='laya-excel-selection-')
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.workbook = self.directory / 'mixed-results.xlsx'
        book = Workbook()
        sheet = book.active
        sheet.append(['测试编号', '用例名称', '测试步骤', '预期结果', '实际执行结果', '用例类型'])
        for index, result in enumerate(('pass', 'fail', '未执行', ''), 1):
            sheet.append(
                [
                    str(index),
                    f'用例{index}',
                    '点击查询',
                    '页面显示结果',
                    result,
                    'pass' if index % 2 else 'fail',
                ]
            )
        book.save(self.workbook)
        book.close()

    def inspect(self, *arguments):
        output = self.directory / 'output'
        env = {**os.environ}
        for key in list(env):
            if key.startswith(('LAYA_', 'TEST_', 'BROWSER_')):
                env.pop(key)
        # Empty shell values prevent a developer's .env.local from injecting login state.
        env.update(
            {
                'TEST_URL': '',
                'TEST_USER': '',
                'TEST_AUTH_STATE': '',
                'TEST_AUTH_CHECK': '',
                'BROWSER_PROVIDER': 'playwright',
                'BROWSER_CHANNEL': '',
                'BROWSER_HEADLESS': 'false',
            }
        )
        completed = subprocess.run(
            [
                'node',
                str(ROOT / 'scripts/runner.mjs'),
                '--excel',
                str(self.workbook),
                '--inspect',
                '--provider',
                'local',
                '--python',
                sys.executable,
                '--out',
                str(output),
                *arguments,
            ],
            cwd=self.directory,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        return (
            json.loads((output / 'selection.json').read_text()),
            json.loads((output / 'excel-inspection.json').read_text()),
        )

    def test_all_rows_are_selected_regardless_of_result_and_case_type(self):
        selection, inspection = self.inspect()
        self.assertEqual(selection['total'], 4)
        self.assertEqual(selection['eligible'], 4)
        self.assertEqual(selection['selected'], 4)
        self.assertFalse(selection['only_source_pass'])
        self.assertEqual(selection['excluded'], [])
        self.assertEqual([case['id'] for case in inspection['cases']], ['001', '002', '003', '004'])

    def test_explicit_case_selection_can_include_failed_and_blank_history(self):
        selection, inspection = self.inspect('--cases', '002,004')
        self.assertEqual(selection['eligible'], 4)
        self.assertEqual(selection['selected'], 2)
        self.assertEqual([case['id'] for case in inspection['cases']], ['002', '004'])

    def test_existing_all_cases_flag_remains_compatible(self):
        selection, inspection = self.inspect('--all-cases')
        self.assertEqual(selection['selected'], 4)
        self.assertEqual(len(inspection['cases']), 4)

    def test_bundled_template_examples_and_user_copy_are_read_without_changing_source(self):
        template = ROOT / 'assets/test-cases-template.xlsx'
        original = hashlib.sha256(template.read_bytes()).digest()
        imported = subprocess.run(
            [sys.executable, str(ROOT / 'scripts/worker.py')],
            input=json.dumps({'id': 1, 'action': 'read_excel', 'path': str(template)}) + '\n',
            text=True,
            capture_output=True,
            check=True,
            timeout=30,
        )
        imported_cases = json.loads(imported.stdout)
        self.assertEqual(
            [case['id'] for case in imported_cases['cases']],
            ['DEMO-001', 'DEMO-002', 'DEMO-003'],
        )
        self.assertEqual(imported_cases['warnings'], [])
        shutil.copyfile(template, self.workbook)
        selection, inspection = self.inspect()
        self.assertEqual(selection['selected'], 3)
        self.assertEqual([len(case['steps']) for case in inspection['cases']], [1, 3, 4])
        for case in inspection['cases']:
            self.assertTrue(case['title'].startswith('【示例】'))
            self.assertTrue(all(step['verb'] != 'unsupported' for step in case['steps']))
            self.assertTrue(all(item['kind'] != 'unsupported' for item in case['expected']))
        book = load_workbook(template)
        self.assertEqual(book.sheetnames, ['测试用例'])
        sheet = book.active
        self.assertEqual(sheet.freeze_panes, 'A2')
        for row in sheet.iter_rows(min_row=2):
            for cell in row:
                cell.value = None
        for column, value in enumerate(
            ['001', '查询按钮可见', '已登录', '', '查看当前页面', '“查询”按钮可见'], 1
        ):
            sheet.cell(2, column, value)
        book.save(self.workbook)
        book.close()
        selection, inspection = self.inspect()
        self.assertEqual(selection['total'], 1)
        self.assertEqual(selection['selected'], 1)
        case = inspection['cases'][0]
        self.assertEqual(case['id'], '001')
        self.assertEqual(case['title'], '查询按钮可见')
        self.assertEqual([step['text'] for step in case['steps']], ['查看当前页面'])
        self.assertEqual(case['steps'][0]['verb'], 'observe')
        self.assertEqual([item['text'] for item in case['expected']], ['“查询”按钮可见'])
        self.assertEqual(hashlib.sha256(template.read_bytes()).digest(), original)


if __name__ == '__main__':
    unittest.main()
