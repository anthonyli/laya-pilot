"""Exercise actual CLI import/selection without starting a browser or a model."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from openpyxl import Workbook


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


if __name__ == '__main__':
    unittest.main()
