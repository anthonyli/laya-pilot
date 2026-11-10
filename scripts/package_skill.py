"""Package the repository-root skill into an allowlisted, reproducible ZIP."""

import argparse
import hashlib
import json
from pathlib import Path
import zipfile


ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = {
    'SKILL.md',
    'LICENSE',
    'requirements.txt',
    'requirements-local.txt',
    'package.json',
    'package-lock.json',
}
RESOURCE_FILES = {
    'assets/.env.example',
    'assets/test-cases-template.xlsx',
    'scripts/common.mjs',
    'scripts/run.mjs',
    'scripts/setup.mjs',
    'scripts/runner.mjs',
    'scripts/worker.py',
}


def runtime_package_files(files):
    """Keep locked runtime dependencies without repository-only commands or dev tools."""
    package = json.loads(files['package.json'])
    package.pop('devDependencies', None)
    package['scripts'] = {'start': 'node scripts/run.mjs'}
    lock = json.loads(files['package-lock.json'])
    lock['packages'][''].pop('devDependencies', None)
    lock['packages'] = {
        name: entry for name, entry in lock['packages'].items() if not entry.get('dev', False)
    }
    for name, value in [('package.json', package), ('package-lock.json', lock)]:
        files[name] = (json.dumps(value, indent=4) + '\n').encode()


def distribution_files():
    names = ROOT_FILES | RESOURCE_FILES
    if (ROOT / 'agents/openai.yaml').is_file():
        names.add('agents/openai.yaml')
    for folder, suffixes in (
        ('scripts/lib', {'.mjs', '.py'}),
        ('references', {'.md'}),
    ):
        names.update(
            source.relative_to(ROOT).as_posix()
            for source in (ROOT / folder).iterdir()
            if source.is_file() and not source.name.startswith('.') and source.suffix in suffixes
        )
    files = {name: (ROOT / name).read_bytes() for name in sorted(names)}
    runtime_package_files(files)
    hashes = {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}
    manifest = {
        'schemaVersion': 1,
        'version': json.loads(files['package.json'])['version'],
        'contentHash': hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest(),
        'files': hashes,
    }
    files['manifest.json'] = (json.dumps(manifest, indent=4) + '\n').encode()
    return files


def owned_file(name):
    """Recognize current distribution files and legacy runtime files, never local state."""
    parts = Path(name).parts
    if (
        not parts
        or Path(name).is_absolute()
        or any(part.startswith('.') or part in {'node_modules', 'models'} for part in parts)
    ):
        return name == 'assets/.env.example'
    return name in ROOT_FILES | RESOURCE_FILES | {
        'assets/config.example.json',
        'agents/openai.yaml',
        'runner.mjs',
        'worker.py',
    } or (
        name.startswith(('runtime/', 'lib/', 'examples/', 'scripts/', 'references/'))
        and Path(name).suffix in {'.mjs', '.py', '.json', '.txt', '.md', '.html', '.xlsx'}
        and not name.endswith(('.local.json', '.local.mjs', '.local.py'))
    )


def install_files(destination, files):
    """Upgrade distribution files only; keep config, auth, dependencies and models."""
    destination = destination.resolve()
    if destination == ROOT or destination in ROOT.parents:
        raise ValueError('Install into a separate skill directory, not the source repository.')
    # Validate all writes before removing any obsolete files.
    for name in files:
        target = destination / name
        if target.is_symlink() or not target.resolve().is_relative_to(destination):
            raise ValueError(f'Unsafe installation path: {name}')
    previous = destination / 'manifest.json'
    if previous.is_file():
        for name in json.loads(previous.read_text()).get('files', {}):
            target = destination / name
            if (
                owned_file(name)
                and name not in files
                and not target.is_symlink()
                and target.resolve().is_relative_to(destination)
                and target.is_file()
            ):
                target.unlink()
    for name, data in files.items():
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def write_archive(output, files):
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(files.items()):
            entry = zipfile.ZipInfo('laya-pilot/' + name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, data)


def check_archive(output, files):
    if not output.is_file():
        raise ValueError(f'Package missing: {output}. Run npm run skill:package first.')
    with zipfile.ZipFile(output) as archive:
        expected = {'laya-pilot/' + name: data for name, data in files.items()}
        actual = archive.namelist()
        if len(actual) != len(expected) or set(actual) != set(expected):
            raise ValueError('Package file list differs from the current distribution.')
        stale = [name for name, data in expected.items() if archive.read(name) != data]
        if stale:
            raise ValueError('Package is out of date: ' + ', '.join(sorted(stale)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--check',
        action='store_true',
        help='Compare the ZIP or installed skill with current sources',
    )
    parser.add_argument('--output', type=Path, default=ROOT / 'dist' / 'laya-pilot-skill.zip')
    parser.add_argument(
        '--install-to',
        type=Path,
        help='Explicit upgrade destination; preserves local config/auth/dependencies',
    )
    args = parser.parse_args()
    files = distribution_files()
    if args.check:
        if args.install_to:
            stale = [
                name
                for name, data in files.items()
                if not (args.install_to / name).is_file()
                or (args.install_to / name).read_bytes() != data
            ]
            if stale:
                raise SystemExit('Installed skill is out of date: ' + ', '.join(sorted(stale)))
            print('Installed skill matches current distribution.')
        else:
            check_archive(args.output, files)
            print('Packaged skill matches current sources.')
        return
    write_archive(args.output, files)
    print(f'Packaged {len(files)} files: {args.output} ({args.output.stat().st_size:,} bytes)')
    if args.install_to:
        install_files(args.install_to, files)
        print(f'Installed distribution files into {args.install_to}; local state preserved.')
        print('Run node scripts/setup.mjs in the installed skill to refresh dependencies.')
        if (args.install_to / 'runtime').is_dir():
            print(
                'Legacy runtime dependencies are preserved; setup installs dependencies at the root.'
            )


if __name__ == '__main__':
    main()
