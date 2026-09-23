import importlib.util
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from openpyxl import Workbook

spec = importlib.util.spec_from_file_location('worker', Path(__file__).parents[1] / 'worker.py')
worker = importlib.util.module_from_spec(spec)
with patch.object(sys, 'stdin', io.StringIO('')):
    spec.loader.exec_module(worker)

class ImportResultTest(unittest.TestCase):
    def test_source_result_is_not_execution_status_or_expected_result(self):
        wb = Workbook()
        ws = wb.active
        ws.append(['测试编号', '测试步骤', '预期结果', '实际执行结果', '执行状态'])
        ws.append(['1', '点击查询', '页面显示结果', 'pass', '未执行'])
        ws.append(['2', '点击查询', 'pass', 'fail', '已执行'])
        ws.append(['3', '点击查询', '页面显示结果', '废弃', '已执行'])
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / 'input.xlsx'
            wb.save(filename)
            cases = worker.read_excel(filename)['cases']
        self.assertEqual([c['source_result'] for c in cases], ['pass', 'fail', '废弃'])
        self.assertEqual([c['id'] for c in cases if c['source_result'] == 'pass'], ['001'])

if __name__ == '__main__':
    unittest.main()
