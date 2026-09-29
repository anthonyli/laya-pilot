import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    'workflow_excel', Path(__file__).resolve().parents[1] / 'lib/workflow_excel.py'
)
excel = importlib.util.module_from_spec(spec)
spec.loader.exec_module(excel)


class WorkbookTests(unittest.TestCase):
    def test_generation_report_keeps_failed_and_skipped_cases(self):
        with tempfile.TemporaryDirectory(prefix='laya-report-') as directory:
            output = str(Path(directory) / '执行结果.xlsx')
            rows = [
                {
                    'id': 'ok',
                    'title': '=unsafe',
                    'status': '已验证',
                    'steps': [{'kind': 'assert-control', 'target': {'name': '名称'}}],
                    'reason': '通过',
                },
                {
                    'id': 'failed',
                    'status': '未生成',
                    'steps': [],
                    'reason': '\x1b[2m错误',
                    'diagnosis': None,
                },
                {
                    'id': 'blocked',
                    'status': '未执行（依赖阻断）',
                    'steps': [],
                    'reason': '依赖未通过',
                },
            ]
            excel.report({'mode': 'generate', 'output': output, 'results': rows})
            book = excel.load_workbook(output)
            sheet = book['生成验证结果']
            self.assertEqual(sheet.max_row, 4)
            self.assertEqual([sheet.cell(i, 11).value for i in (2, 3, 4)], ['pass', 'fail', 'skip'])
            self.assertEqual(sheet.cell(2, 4).data_type, 's')
            self.assertEqual(sheet.cell(2, 14).value, '生成时验证')
            book.close()

    def test_discovery_roundtrip_includes_readable_assertions(self):
        with tempfile.TemporaryDirectory(prefix='laya-discovery-') as directory:
            source = str(Path(directory) / 'cases.xlsx')
            step = {
                'kind': 'assert-discovery',
                'spec': {
                    'check': 'field-invalid',
                    'label': '数量',
                    'constraint': 'min',
                    'bound': 1,
                },
            }
            case = {
                'id': 'discovered',
                'operation': 'discover',
                'title': '数量下界校验',
                'steps': [step],
            }
            excel.write(
                {
                    'path': source,
                    'file': {
                        'schemaVersion': 1,
                        'generatedAt': 'test',
                        'moduleUrl': 'https://app.test/users',
                        'coverage': [],
                        'cases': [case],
                    },
                }
            )
            self.assertEqual(excel.read({'path': source})['cases'][0], case)
            self.assertIn('min=1', excel.expected_text(case))

    def test_relative_date_step_roundtrip(self):
        with tempfile.TemporaryDirectory(prefix='laya-date-') as directory:
            source = str(Path(directory) / 'cases.xlsx')
            step = {'kind': 'form-date', 'target': {'label': '过期时间'}, 'value': '${expiryDate}'}
            case = {
                'id': 'create',
                'operation': 'create',
                'steps': [step, {'kind': 'assert-row', 'value': '${recordName}'}],
            }
            excel.write(
                {
                    'path': source,
                    'file': {
                        'schemaVersion': 1,
                        'generatedAt': 'test',
                        'moduleUrl': 'https://app.test/users',
                        'coverage': [],
                        'cases': [case],
                    },
                }
            )
            self.assertEqual(excel.read({'path': source})['cases'][0]['steps'][0], step)
            self.assertIn('选择日期', excel.step_text(step))

    def test_disabled_assertion_and_retry_report_roundtrip(self):
        with tempfile.TemporaryDirectory(prefix='laya-excel-') as directory:
            source = str(Path(directory) / '用例.xlsx')
            output = str(Path(directory) / '结果.xlsx')
            case = {
                'id': '001',
                'operation': 'form-validation',
                'steps': [
                    {'kind': 'assert-disabled', 'target': {'name': '保存\x1b[2m', 'role': 'button'}}
                ],
            }
            excel.write(
                {
                    'path': source,
                    'file': {
                        'schemaVersion': 1,
                        'generatedAt': 'test',
                        'moduleUrl': 'https://app.test/records',
                        'coverage': [],
                        'cases': [case],
                    },
                }
            )
            loaded = excel.read({'path': source})
            self.assertEqual(loaded['cases'][0], case)
            excel.results(
                {
                    'path': source,
                    'output': output,
                    'results': [
                        {
                            'id': '001',
                            'status': '失败',
                            'reason': '失败\x1b[31m',
                            'attempts': [
                                {
                                    'step': 'assert-disabled',
                                    'attempt': n,
                                    'status': '失败',
                                    'reason': '未禁用\x00',
                                }
                                for n in range(1, 4)
                            ],
                        }
                    ],
                }
            )
            book = excel.load_workbook(output)
            note = book['生成用例'].cell(2, 16).value
            self.assertIn('第3次', note)
            self.assertNotIn('\x1b', note)
            self.assertNotIn('\x00', note)
            self.assertEqual(book['生成用例'].cell(2, 11).value, 'fail')
            book.close()


if __name__ == '__main__':
    unittest.main()
