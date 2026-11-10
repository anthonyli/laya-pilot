"""Verify workbook dispatch and integrity checks through the public Excel CLI."""

import importlib.util
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from openpyxl import load_workbook


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    'workflow_excel_dispatch', ROOT / 'lib/workflow_excel.py'
)
workbooks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workbooks)


@unittest.skipUnless(shutil.which('node'), 'Node.js is required for CLI dispatch tests')
class ExcelDispatchTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='laya-excel-dispatch-')
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.workbook = self.directory / 'generated.xlsx'
        self.output = self.directory / 'output'
        self.file = {
            'schemaVersion': 1,
            'generatedAt': '2026-11-04T00:00:00Z',
            'moduleUrl': 'https://test.example/customers',
            'coverage': [],
            'cases': [
                {
                    'id': 'table',
                    'title': '检查页面',
                    'operation': 'table',
                    'steps': [{'kind': 'assert-text', 'value': '客户管理'}],
                }
            ],
        }
        self.write_workbook()

    def write_workbook(self):
        workbooks.write({'path': str(self.workbook), 'file': self.file})

    def run_cli(self, *extra, inspect=True, expected=0, provider='local'):
        env = {**os.environ}
        for key in list(env):
            if key.startswith(('LAYA_', 'TEST_', 'BROWSER_')):
                env.pop(key)
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
        if provider == 'api' and not inspect:
            env.update({'LAYA_API_BASE': 'http://127.0.0.1:9', 'LAYA_API_MODEL': 'fixture'})
        result = subprocess.run(
            [
                'node',
                str(ROOT / 'runner.mjs'),
                '--excel',
                str(self.workbook),
                '--provider',
                provider,
                '--python',
                sys.executable,
                '--out',
                str(self.output),
                *(['--inspect'] if inspect else []),
                *extra,
            ],
            cwd=self.directory,
            env=env,
            text=True,
            capture_output=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def test_generated_workbook_is_detected_and_inspected_without_a_model_or_browser(self):
        self.run_cli()
        inspection = json.loads((self.output / 'excel-inspection.json').read_text())
        selection = json.loads((self.output / 'selection.json').read_text())
        self.assertEqual(inspection['workbookFormat'], 'structured')
        self.assertEqual(inspection['cases'][0]['id'], 'table')
        self.assertEqual(selection['selected'], 1)
        self.assertFalse((self.output / 'trace.zip').exists())

    def test_old_generated_workbook_without_a_marker_is_still_detected(self):
        book = load_workbook(self.workbook)
        book.properties.identifier = None
        book.save(self.workbook)
        book.close()
        self.run_cli()
        inspection = json.loads((self.output / 'excel-inspection.json').read_text())
        self.assertEqual(inspection['workbookFormat'], 'structured')

    def test_api_inspection_requires_no_endpoint_model_or_key(self):
        self.run_cli(provider='api')
        inspection = json.loads((self.output / 'excel-inspection.json').read_text())
        self.assertEqual(inspection['workbookFormat'], 'structured')

    def test_changed_visible_steps_fail_without_falling_back_to_natural_language(self):
        book = load_workbook(self.workbook)
        book['生成用例']['I2'] = '点击删除'
        book.save(self.workbook)
        book.close()
        result = self.run_cli(expected=1)
        self.assertIn('与隐藏回放步骤不一致', result.stderr)
        self.assertFalse((self.output / 'excel-inspection.json').exists())
        execution = self.run_cli(inspect=False, expected=1)
        self.assertIn('与隐藏回放步骤不一致', execution.stderr)
        self.assertFalse((self.output / 'trace.zip').exists())

    def test_appended_case_is_rejected_before_inspection_or_execution(self):
        book = load_workbook(self.workbook)
        sheet = book['生成用例']
        for col in range(1, 18):
            sheet.cell(3, col).value = sheet.cell(2, col).value
        sheet.cell(3, 1).value = '002'
        book.save(self.workbook)
        book.close()
        before = hashlib.sha256(self.workbook.read_bytes()).hexdigest()
        for inspect in (True, False):
            result = self.run_cli(inspect=inspect, expected=1, provider='api')
            self.assertIn('工作表「生成用例」第3行', result.stderr)
            self.assertFalse((self.output / 'trace.zip').exists())
        self.assertEqual(hashlib.sha256(self.workbook.read_bytes()).hexdigest(), before)

    def test_formatted_empty_rows_are_ignored_but_extra_sheet_is_not(self):
        book = load_workbook(self.workbook)
        book['生成用例'].cell(20, 1).number_format = '@'
        book[workbooks.META].cell(20, 1).number_format = '@'
        book.save(self.workbook)
        book.close()
        self.run_cli()
        book = load_workbook(self.workbook)
        book.create_sheet('额外用例')['A1'] = '测试编号'
        book.save(self.workbook)
        book.close()
        result = self.run_cli(expected=1)
        self.assertIn('工作表「额外用例」第1行', result.stderr)

    def test_removed_plan_is_rejected_when_the_generated_marker_remains(self):
        book = load_workbook(self.workbook)
        del book[workbooks.META]
        book.save(self.workbook)
        book.close()
        result = self.run_cli(expected=1)
        self.assertIn('没有隐藏的 Laya 回放步骤', result.stderr)
        self.assertFalse((self.output / 'excel-inspection.json').exists())

    def test_structured_case_filter_is_rejected_instead_of_silently_running_everything(self):
        result = self.run_cli('--cases', '001', expected=1)
        self.assertIn('暂不支持 --cases', result.stderr)

    def test_unified_execution_does_not_enable_writes_implicitly(self):
        self.file['cases'] = [
            {
                'id': 'create',
                'title': '新增记录',
                'operation': 'create',
                'steps': [
                    {
                        'kind': 'click',
                        'purpose': 'create',
                        'target': {'role': 'button', 'name': '新增'},
                    },
                    {'kind': 'assert-text', 'value': '客户管理'},
                ],
            }
        ]
        self.write_workbook()
        result = self.run_cli(inspect=False, expected=1)
        self.assertIn('--allow-write', result.stderr)
        self.assertFalse((self.output / 'trace.zip').exists())


if __name__ == '__main__':
    unittest.main()
