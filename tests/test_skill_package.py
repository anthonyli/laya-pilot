import importlib.util
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('package_skill', ROOT / 'scripts/package_skill.py')
package_skill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package_skill)


class SkillUpgradeTests(unittest.TestCase):
    def test_upgrade_replaces_code_and_preserves_local_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = [
                '.env.local',
                'config.local.json',
                '.auth/session.json',
                '.venv/keep',
                'runtime/node_modules/keep',
            ]
            for name in state:
                p = root / name
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(b'private-local-state')
            package_skill.install_files(
                root,
                {
                    'SKILL.md': b'old',
                    'scripts/old.mjs': b'old',
                    'manifest.json': b'{"files":{"scripts/old.mjs":"old"}}',
                },
            )
            package_skill.install_files(
                root,
                {
                    'SKILL.md': b'new',
                    'scripts/run.mjs': b'new',
                    'manifest.json': b'{"files":{"scripts/run.mjs":"new"}}',
                },
            )
            self.assertEqual((root / 'SKILL.md').read_bytes(), b'new')
            self.assertFalse((root / 'scripts/old.mjs').exists())
            for name in state:
                self.assertEqual((root / name).read_bytes(), b'private-local-state')

    def test_manifest_is_reproducible_and_excludes_private_state(self):
        first = package_skill.distribution_files(package_skill.runtime_files())
        second = package_skill.distribution_files(package_skill.runtime_files())
        self.assertEqual(first['manifest.json'], second['manifest.json'])
        self.assertFalse(
            any(
                '.auth' in p or p.endswith('.local.json') or p.endswith('.env.local') for p in first
            )
        )


if __name__ == '__main__':
    unittest.main()
