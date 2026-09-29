"""Deterministic model double for browser contract tests, never a runtime provider."""


def load(*args, **kwargs):
    return FixtureModel()


class FixtureModel:
    def predict(self, state, questions):
        criteria = questions['scenario']['criteria']
        if '名称' in criteria and '账号' in criteria:
            choice = '账号' if '登录账号' in state else '日期' if '过期' in state else '名称'
        elif '执行' in criteria:
            choice = '执行'
        elif '测试用途选项' in criteria:
            choice = '测试用途选项'
        elif '普通或只读选项' in criteria:
            choice = '普通或只读选项'
        elif '其他可用选项' in criteria:
            choice = '其他可用选项'
        else:
            choice = next(k for k in criteria if k not in ('停止', 'Stop', '无法判断'))
        probabilities = {k: 0.98 if k == choice else 0.02 / (len(criteria) - 1) for k in criteria}
        return {
            'answers': {
                'scenario': {'choice': choice, 'probabilities': probabilities, 'confidence': 0.98}
            }
        }
