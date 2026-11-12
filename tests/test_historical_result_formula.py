"""Historical Excel results are not inputs, so their formulas must not block a run."""

import importlib.util
import io
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from openpyxl import Workbook


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('worker', ROOT / 'scripts/worker.py')
worker = importlib.util.module_from_spec(spec)
with patch.object(sys, 'stdin', io.StringIO('')):
    spec.loader.exec_module(worker)

FORMULA = '=IF(1=1,"fail","pass")'
HEADERS = ['用例编号', '用例名称', '测试步骤', '预期结果', '实际执行结果']
STEP = '查看当前页面'
EXPECTED = '页面显示“查询”按钮'


def read_cases(headers, rows):
    book = Workbook()
    sheet = book.active
    sheet.append(headers)
    for row in rows:
        sheet.append(row)
    with tempfile.TemporaryDirectory(prefix='laya-history-formula-') as directory:
        filename = Path(directory) / 'cases.xlsx'
        book.save(filename)
        book.close()
        return worker.read_excel(filename)['cases']


def case_row(source_result, **overrides):
    values = {
        '用例编号': '001',
        '用例名称': '检查按钮',
        '测试步骤': STEP,
        '预期结果': EXPECTED,
        '实际执行结果': source_result,
    }
    values.update(overrides)
    return [values[header] for header in HEADERS]


class HistoricalResultImportTests(unittest.TestCase):
    def test_literal_blank_and_formula_history_import_without_blocking(self):
        cases = read_cases(
            HEADERS,
            [
                case_row('fail', 用例编号='1'),
                case_row('', 用例编号='2'),
                case_row(FORMULA, 用例编号='3'),
            ],
        )
        self.assertEqual([case['id'] for case in cases], ['001', '002', '003'])
        self.assertEqual([case['source_result'] for case in cases], ['fail', '', FORMULA])
        self.assertEqual([case['import_error'] for case in cases], ['', '', ''])
        for case in cases:
            self.assertEqual(case['steps'], STEP)
            self.assertEqual(case['expected'], EXPECTED)
            self.assertEqual(case['title'], '检查按钮')

    def test_history_aliases_keep_formula_text_out_of_import_error(self):
        for header in ('实际执行结果', '实际结果', '测试结果', 'result'):
            with self.subTest(header=header):
                headers = ['用例编号', '用例名称', '测试步骤', '预期结果', header]
                cases = read_cases(headers, [['001', '检查按钮', STEP, EXPECTED, FORMULA]])
                self.assertEqual(cases[0]['import_error'], '')
                self.assertEqual(cases[0]['source_result'], FORMULA)

    def test_worker_protocol_matches_literal_and_formula_history(self):
        with tempfile.TemporaryDirectory(prefix='laya-history-protocol-') as directory:
            root = Path(directory)
            for name, historical_result in (('literal', 'fail'), ('formula', FORMULA)):
                book = Workbook()
                sheet = book.active
                sheet.append(HEADERS)
                sheet.append(case_row(historical_result))
                filename = root / f'{name}.xlsx'
                book.save(filename)
                book.close()
                completed = subprocess.run(
                    [sys.executable, str(ROOT / 'scripts/worker.py')],
                    input=json.dumps({'id': 1, 'action': 'read_excel', 'path': str(filename)})
                    + '\n',
                    text=True,
                    capture_output=True,
                    check=True,
                    timeout=30,
                )
                case = json.loads(completed.stdout)['cases'][0]
                self.assertEqual(case['import_error'], '', name)
                self.assertEqual(case['source_result'], historical_result, name)
                self.assertEqual(case['steps'], STEP, name)
                self.assertEqual(case['expected'], EXPECTED, name)

    def test_execution_input_formulas_are_still_rejected(self):
        history = FORMULA
        samples = [
            ('用例编号', '=ROW()', 'A2'),
            ('用例名称', '="检查按钮"', 'B2'),
            ('测试步骤', '=IF(1=1,"查看当前页面","点击删除")', 'C2'),
            ('预期结果', '=IF(1=1,"页面显示“查询”按钮","失败")', 'D2'),
        ]
        for header, formula, coordinate in samples:
            with self.subTest(header=header):
                cases = read_cases(HEADERS, [case_row(history, **{header: formula})])
                self.assertEqual(
                    cases[0]['import_error'], f'执行列含公式，需提供明确文本：{coordinate}'
                )
                self.assertNotIn('E2', cases[0]['import_error'])
                self.assertEqual(cases[0]['source_result'], history)

        extended = HEADERS[:4] + ['前提条件', '测试数据', '页面地址', '实际执行结果']
        extras = {
            '前提条件': ('=IF(1=1,"已登录","")', 'E2'),
            '测试数据': ('=IF(1=1,"名称=示例","")', 'F2'),
            '页面地址': ('=IF(1=1,"http://127.0.0.1/","http://example.test/")', 'G2'),
        }
        for header, (formula, coordinate) in extras.items():
            with self.subTest(header=header):
                values = ['001', '检查按钮', STEP, EXPECTED, '', '', '', history]
                values[extended.index(header)] = formula
                cases = read_cases(extended, [values])
                self.assertEqual(
                    cases[0]['import_error'], f'执行列含公式，需提供明确文本：{coordinate}'
                )
                self.assertNotIn('H2', cases[0]['import_error'])
                self.assertEqual(cases[0]['source_result'], history)

    def test_history_formula_is_omitted_when_execution_columns_also_have_formulas(self):
        cases = read_cases(
            HEADERS,
            [
                [
                    '001',
                    '检查按钮',
                    '=IF(1=1,"查看当前页面","点击删除")',
                    '=IF(1=1,"页面显示“查询”按钮","失败")',
                    FORMULA,
                ]
            ],
        )
        self.assertEqual(cases[0]['import_error'], '执行列含公式，需提供明确文本：C2,D2')
        self.assertEqual(cases[0]['source_result'], FORMULA)

    def test_continued_row_history_formula_does_not_join_import_error(self):
        cases = read_cases(
            HEADERS,
            [
                case_row('fail'),
                ['', '', '查看下一屏', EXPECTED, FORMULA],
            ],
        )
        self.assertEqual(len(cases), 1)
        self.assertEqual(cases[0]['import_error'], '')
        self.assertEqual(cases[0]['steps'], STEP + '\n查看下一屏')
        self.assertEqual(cases[0]['source_result'], 'fail')

        blocked = read_cases(
            HEADERS,
            [
                case_row('fail'),
                ['', '', '=IF(1=1,"查看下一屏","点击删除")', EXPECTED, FORMULA],
            ],
        )
        self.assertEqual(blocked[0]['import_error'], '执行列含公式，需提供明确文本：C3')
        self.assertNotIn('E3', blocked[0]['import_error'])


class QueryPage(BaseHTTPRequestHandler):
    def do_GET(self):
        body = '<!doctype html><meta charset="utf-8"><button>查询</button>'.encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        return


@unittest.skipUnless(shutil.which('node'), 'Node.js is required for CLI execution tests')
class HistoricalResultCliTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='laya-history-cli-')
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.workbook = self.directory / 'cases.xlsx'
        book = Workbook()
        sheet = book.active
        sheet.append(HEADERS)
        for index, historical_result in enumerate(('fail', '', FORMULA), 1):
            sheet.append(
                case_row(historical_result, 用例编号=str(index), 用例名称=f'检查按钮{index}')
            )
        book.save(self.workbook)
        book.close()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), QueryPage)
        self.addCleanup(self.server.shutdown)
        self.addCleanup(self.server.server_close)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}/'

    def run_cli(self, *arguments):
        output = self.directory / f'output-{len(arguments)}'
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
                'BROWSER_HEADLESS': 'true',
            }
        )
        completed = subprocess.run(
            [
                'node',
                str(ROOT / 'scripts/runner.mjs'),
                '--excel',
                str(self.workbook),
                '--url',
                self.url,
                '--headless',
                '--lazy-model',
                '--language',
                'none',
                '--provider',
                'local',
                '--python',
                sys.executable,
                '--delay',
                '0',
                '--out',
                str(output),
                *arguments,
            ],
            cwd=self.directory,
            env=env,
            text=True,
            capture_output=True,
            timeout=90,
        )
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        summary = json.loads((output / 'results.json').read_text())
        selection = json.loads((output / 'selection.json').read_text())
        return summary, selection

    def assert_executed(self, result, source_result):
        self.assertEqual(result['import_error'], '')
        self.assertEqual(result['source_result'], source_result)
        self.assertEqual(result['status'], '通过')
        self.assertNotEqual(result['category'], 'Excel内容不明确')
        self.assertEqual(result['actions'][0]['action'], 'observe')
        self.assertEqual(result['assertions'][0]['status'], '通过')
        self.assertEqual(result['assertions'][0]['kind'], 'controlVisible')

    def test_selected_history_variants_execute_instead_of_skipping(self):
        summary, selection = self.run_cli()
        self.assertEqual(selection['selected'], 3)
        self.assertEqual(selection['eligible'], 3)
        self.assertEqual(selection['total'], 3)
        self.assertEqual(summary['workbookFormat'], 'natural-language')
        self.assertEqual([result['id'] for result in summary['results']], ['001', '002', '003'])
        for result, source_result in zip(summary['results'], ('fail', '', FORMULA)):
            self.assert_executed(result, source_result)
        self.assertNotIn('执行列含公式', json.dumps(summary, ensure_ascii=False))

    def test_explicit_case_selection_executes_formula_history(self):
        summary, selection = self.run_cli('--cases', '003')
        self.assertEqual(selection['eligible'], 3)
        self.assertEqual(selection['selected'], 1)
        self.assertEqual(len(summary['results']), 1)
        self.assert_executed(summary['results'][0], FORMULA)


if __name__ == '__main__':
    unittest.main()
