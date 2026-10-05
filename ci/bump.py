#!/usr/bin/env python3
"""Set the release version: python3 ci/bump.py 1.2.1

Writes "version-name" and bumps the integer "version" in extension/metadata.json, and updates the
example .deb file name in README.md. Refuses a version that is not x.y.z or not newer than the
current one. Run from the repo root; the release workflow calls it for "Run workflow" with a version.
"""
import json
import re
import sys

META = 'extension/metadata.json'
README = 'README.md'


def parse(v):
    if not re.fullmatch(r'\d+\.\d+\.\d+', v):
        sys.exit(f'Version must look like 1.2.3, got {v!r}')
    return tuple(int(x) for x in v.split('.'))


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    new = sys.argv[1].strip().removeprefix('v')
    text = open(META).read()
    meta = json.loads(text)
    if parse(new) <= parse(meta['version-name']):
        sys.exit(f'{new} is not newer than the current version {meta["version-name"]}')

    # edit in place so the file keeps its formatting
    text = re.sub(r'("version-name":\s*)"[^"]*"', rf'\g<1>"{new}"', text, count=1)
    text = re.sub(r'("version":\s*)\d+', rf'\g<1>{meta["version"] + 1}', text, count=1)
    check = json.loads(text)
    assert check['version-name'] == new and check['version'] == meta['version'] + 1
    open(META, 'w').write(text)

    readme = open(README).read()
    open(README, 'w').write(re.sub(r'dock_\d+\.\d+\.\d+_all\.deb', f'dock_{new}_all.deb', readme))
    print(f'Version {meta["version-name"]} -> {new} (version {meta["version"]} -> {meta["version"] + 1})')


if __name__ == '__main__':
    main()
