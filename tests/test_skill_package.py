import importlib.util
import hashlib
import json
import subprocess
import sys
import zipfile
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
                'node_modules/keep',
                'models/keep',
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
                    'assets/config.example.json': b'{}',
                    'runtime/runner.mjs': b'old runner',
                    'runner.mjs': b'old root runner',
                    'worker.py': b'old root worker',
                    'lib/old.mjs': b'old root library',
                    'examples/demo-server.mjs': b'old demo server',
                    'runtime/lib/obsolete.mjs': b'old module',
                    'manifest.json': json.dumps(
                        {
                            'files': dict.fromkeys(
                                [
                                    'scripts/old.mjs',
                                    'assets/config.example.json',
                                    'runtime/runner.mjs',
                                    'runner.mjs',
                                    'worker.py',
                                    'lib/old.mjs',
                                    'examples/demo-server.mjs',
                                    'runtime/lib/obsolete.mjs',
                                    *state,
                                ],
                                'old',
                            )
                        }
                    ).encode(),
                },
            )
            package_skill.install_files(
                root,
                {
                    'SKILL.md': b'new',
                    'scripts/run.mjs': b'new',
                    'scripts/runner.mjs': b'new runner',
                    'manifest.json': b'{"files":{"scripts/run.mjs":"new"}}',
                },
            )
            self.assertEqual((root / 'SKILL.md').read_bytes(), b'new')
            self.assertFalse((root / 'scripts/old.mjs').exists())
            self.assertFalse((root / 'assets/config.example.json').exists())
            self.assertFalse((root / 'runtime/runner.mjs').exists())
            for name in ['runner.mjs', 'worker.py', 'lib/old.mjs', 'examples/demo-server.mjs']:
                self.assertFalse((root / name).exists())
            self.assertFalse((root / 'runtime/lib/obsolete.mjs').exists())
            self.assertEqual((root / 'scripts/runner.mjs').read_bytes(), b'new runner')
            for name in state:
                self.assertEqual((root / name).read_bytes(), b'private-local-state')

    def test_manifest_is_reproducible_and_excludes_private_state(self):
        first = package_skill.distribution_files()
        second = package_skill.distribution_files()
        self.assertEqual(first['manifest.json'], second['manifest.json'])
        self.assertNotIn('assets/config.example.json', first)
        self.assertFalse(
            any(
                '.auth' in p or p.endswith('.local.json') or p.endswith('.env.local') for p in first
            )
        )

    def test_zip_uses_source_layout_and_detects_stale_or_extra_files(self):
        files = package_skill.distribution_files()
        for name in (
            'scripts/runner.mjs',
            'scripts/lib/engine.mjs',
            'package.json',
            'package-lock.json',
        ):
            self.assertEqual(files[name], (ROOT / name).read_bytes())
        self.assertFalse(
            any(name.startswith(('runtime/', 'tests/', 'node_modules/')) for name in files)
        )
        self.assertTrue(
            all(name.startswith('scripts/') for name in files if name.endswith(('.mjs', '.py')))
        )
        manifest = json.loads(files['manifest.json'])
        for name, digest in manifest['files'].items():
            self.assertEqual(hashlib.sha256(files[name]).hexdigest(), digest)
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'skill.zip'
            package_skill.write_archive(output, files)
            first = output.read_bytes()
            package_skill.check_archive(output, files)
            package_skill.write_archive(output, files)
            self.assertEqual(output.read_bytes(), first)
            with self.assertRaisesRegex(ValueError, 'out of date'):
                package_skill.check_archive(output, {**files, 'scripts/runner.mjs': b'changed'})
            with zipfile.ZipFile(output, 'a') as archive:
                archive.writestr('laya-pilot/.env.local', 'must not be shipped')
            with self.assertRaisesRegex(ValueError, 'file list differs'):
                package_skill.check_archive(output, files)

    def test_package_cli_writes_only_output_and_checks_extracted_installation(self):
        files = package_skill.distribution_files()
        before = {name: (ROOT / name).read_bytes() for name in files if name != 'manifest.json'}
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'skill.zip'
            command = [
                sys.executable,
                str(ROOT / 'scripts/package_skill.py'),
                '--output',
                str(output),
            ]
            missing = subprocess.run([*command, '--check'], capture_output=True, text=True)
            self.assertNotEqual(missing.returncode, 0)
            self.assertFalse(output.exists())
            subprocess.run(command, check=True, capture_output=True)
            subprocess.run([*command, '--check'], check=True, capture_output=True)
            with zipfile.ZipFile(output) as archive:
                archive.extractall(tmp)
            installed = Path(tmp) / 'laya-pilot'
            check = [*command, '--check', '--install-to', str(installed)]
            subprocess.run(check, check=True, capture_output=True)
            # Help must work in the extracted ZIP before dependency installation.
            for entry in ('run', 'setup'):
                subprocess.run(
                    ['node', str(installed / 'scripts' / f'{entry}.mjs'), '--help'],
                    cwd=tmp,
                    check=True,
                    capture_output=True,
                )
            (installed / 'scripts/lib/engine.mjs').write_text('stale')
            stale = subprocess.run(check, capture_output=True, text=True)
            self.assertNotEqual(stale.returncode, 0)
            self.assertIn('scripts/lib/engine.mjs', stale.stderr)
        for name, original in before.items():
            self.assertEqual((ROOT / name).read_bytes(), original)

    def test_upgrade_preflights_paths_before_deleting_old_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'installed'
            root.mkdir()
            (root / 'scripts').mkdir()
            old = root / 'scripts/old.mjs'
            old.write_bytes(b'keep if upgrade fails')
            (root / 'manifest.json').write_text('{"files":{"scripts/old.mjs":"old"}}')
            (root / 'scripts/runner.mjs').symlink_to(Path(tmp) / 'outside.mjs')
            with self.assertRaisesRegex(ValueError, 'Unsafe installation path'):
                package_skill.install_files(root, {'scripts/runner.mjs': b'new'})
            self.assertEqual(old.read_bytes(), b'keep if upgrade fails')
        with self.assertRaisesRegex(ValueError, 'source repository'):
            package_skill.install_files(ROOT, {'scripts/runner.mjs': b'new'})


if __name__ == '__main__':
    unittest.main()
