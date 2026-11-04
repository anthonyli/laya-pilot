"""Build the self-contained skill runtime and an allowlisted distributable ZIP."""

import argparse
import hashlib
import json
from pathlib import Path
import zipfile


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / 'skills' / 'laya-pilot'


def distribution_files(expected):
    names = {'SKILL.md', 'agents/openai.yaml', 'assets/.env.example', 'assets/config.example.json'}
    for folder, suffix in (('scripts', '.mjs'), ('references', '.md')):
        names.update(str(p.relative_to(SKILL)) for p in (SKILL / folder).glob('*' + suffix))
    files = {**expected, **{name: (SKILL / name).read_bytes() for name in names}}
    hashes = {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())}
    manifest = {
        'schemaVersion': 1,
        'version': json.loads((ROOT / 'package.json').read_text())['version'],
        'contentHash': hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest(),
        'files': hashes,
    }
    files['manifest.json'] = (json.dumps(manifest, indent=4) + '\n').encode()
    return files


def install_files(destination, files):
    """Upgrade distribution files only; credentials, auth and runtime caches are never copied."""
    destination = destination.resolve()
    previous = destination / 'manifest.json'
    if previous.is_file():
        for name in json.loads(previous.read_text()).get('files', {}):
            owned = name in {
                'SKILL.md',
                'agents/openai.yaml',
                'assets/.env.example',
                'assets/config.example.json',
                'LICENSE',
            } or (
                name.startswith(('runtime/', 'scripts/', 'references/'))
                and Path(name).suffix in {'.mjs', '.py', '.json', '.txt', '.md', '.html', '.xlsx'}
                and not any(
                    part.startswith('.') or part == 'node_modules' for part in Path(name).parts
                )
            )
            target = destination / name
            if (
                owned
                and name not in files
                and target.resolve().is_relative_to(destination)
                and target.is_file()
            ):
                target.unlink()
    for name, data in files.items():
        target = destination / name
        if target.is_symlink() or not target.resolve().is_relative_to(destination):
            raise ValueError(f'Unsafe installation path: {name}')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def runtime_files():
    files = {}
    for name in ('runner.mjs', 'worker.py', 'requirements.txt', 'requirements-local.txt'):
        files[f'runtime/{name}'] = (ROOT / name).read_bytes()
    for folder in ('lib', 'examples'):
        for source in sorted((ROOT / folder).iterdir()):
            if source.is_file() and source.suffix in {'.mjs', '.py', '.html', '.xlsx'}:
                files[f'runtime/{folder}/{source.name}'] = source.read_bytes()
    original = json.loads((ROOT / 'package.json').read_text())
    manifest = {
        key: original[key]
        for key in ('name', 'version', 'description', 'license', 'engines', 'type', 'dependencies')
    }
    manifest['name'] = 'laya-pilot-skill-runtime'
    manifest['private'] = True
    manifest['scripts'] = {'start': 'node runner.mjs', 'demo': 'node examples/demo-server.mjs'}
    lock = json.loads((ROOT / 'package-lock.json').read_text())
    lock['name'] = manifest['name']
    lock['packages'] = {
        name: value for name, value in lock['packages'].items() if not value.get('dev')
    }
    lock['packages'][''] = {
        key: manifest[key] for key in ('name', 'version', 'license', 'dependencies', 'engines')
    }
    for name, value in (('package.json', manifest), ('package-lock.json', lock)):
        files[f'runtime/{name}'] = (json.dumps(value, ensure_ascii=False, indent=4) + '\n').encode()
    files['LICENSE'] = (ROOT / 'LICENSE').read_bytes()
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--check', action='store_true', help='Verify bundled runtime matches current sources'
    )
    parser.add_argument('--output', type=Path, default=ROOT / 'dist' / 'laya-pilot-skill.zip')
    parser.add_argument(
        '--install-to',
        type=Path,
        help='Explicit upgrade destination; preserves local config/auth/dependencies',
    )
    args = parser.parse_args()
    expected = runtime_files()
    files = distribution_files(expected)
    if args.install_to and args.check:
        stale = [
            name
            for name, data in files.items()
            if not (args.install_to / name).is_file()
            or (args.install_to / name).read_bytes() != data
        ]
        if stale:
            raise SystemExit('Installed skill is out of date: ' + ', '.join(sorted(stale)))
        print('Installed skill matches current distribution.')
        return
    stale = [
        name
        for name, data in expected.items()
        if not (SKILL / name).is_file() or (SKILL / name).read_bytes() != data
    ]
    actual_runtime = {
        str(p.relative_to(SKILL))
        for p in (SKILL / 'runtime').rglob('*')
        if p.is_file()
        and 'node_modules' not in p.parts
        and '__pycache__' not in p.parts
        and p.suffix in {'.mjs', '.py', '.html', '.xlsx'}
    }
    obsolete = actual_runtime - expected.keys()
    if args.check:
        if (
            not (SKILL / 'manifest.json').is_file()
            or (SKILL / 'manifest.json').read_bytes() != files['manifest.json']
        ):
            stale.append('manifest.json')
        if stale or obsolete:
            raise SystemExit(
                'Skill runtime is out of date: ' + ', '.join(sorted(set(stale) | obsolete))
            )
        print('Bundled skill runtime matches current sources.')
        return
    for name in obsolete:
        (SKILL / name).unlink()
    for name, data in files.items():
        target = SKILL / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(files):
            archive.write(SKILL / name, 'laya-pilot/' + name)
    print(f'Packaged {len(files)} files: {args.output} ({args.output.stat().st_size:,} bytes)')
    if args.install_to:
        install_files(args.install_to, files)
        print(f'Installed distribution files into {args.install_to}; local state preserved.')


if __name__ == '__main__':
    main()
