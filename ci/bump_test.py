#!/usr/bin/env python3
"""Test ci/bump.py on a temporary copy of metadata.json and README.md: python3 ci/bump_test.py"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUMP = os.path.join(ROOT, 'ci', 'bump.py')


def bump(cwd, version):
    return subprocess.run([sys.executable, BUMP, version], cwd=cwd, capture_output=True, text=True)


with tempfile.TemporaryDirectory() as tmp:
    os.mkdir(os.path.join(tmp, 'extension'))
    meta_path = os.path.join(tmp, 'extension', 'metadata.json')
    readme_path = os.path.join(tmp, 'README.md')
    shutil.copy(os.path.join(ROOT, 'extension', 'metadata.json'), meta_path)
    shutil.copy(os.path.join(ROOT, 'README.md'), readme_path)
    before = json.load(open(meta_path))
    major, minor, patch = (int(x) for x in before['version-name'].split('.'))
    new = f'{major}.{minor}.{patch + 1}'

    # refused: not newer, not x.y.z; nothing is written
    for bad in (before['version-name'], f'{major}.{minor}', 'v1.x.0', f'{major - 1}.9.9'):
        r = bump(tmp, bad)
        assert r.returncode != 0, f'{bad} was accepted'
        assert json.load(open(meta_path)) == before, f'{bad} changed metadata.json'

    r = bump(tmp, f'v{new}')
    assert r.returncode == 0, r.stderr
    after = json.load(open(meta_path))
    assert after['version-name'] == new, after
    assert after['version'] == before['version'] + 1, after
    assert {k: v for k, v in after.items() if k not in ('version', 'version-name')} == \
        {k: v for k, v in before.items() if k not in ('version', 'version-name')}, 'other keys changed'
    readme = open(readme_path).read()
    assert f'dock_{new}_all.deb' in readme, 'README example .deb name not updated'
    assert f'dock_{before["version-name"]}_all.deb' not in readme, 'old .deb name left in README'

print('bump_test: ok')
