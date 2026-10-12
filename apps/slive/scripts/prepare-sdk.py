#!/usr/bin/env python3
"""Extract distro development files locally; never install OS packages."""
import pathlib
import subprocess
root = pathlib.Path(__file__).resolve().parents[1] / 'artifacts' / 'sdk'
(root / 'debs').mkdir(parents=True, exist_ok=True)
(root / 'root').mkdir(exist_ok=True)
plan = subprocess.check_output(['apt-get', '--simulate', '--no-install-recommends', 'install', 'libwebkit2gtk-4.1-dev', 'libgtk-3-dev'], text=True)
packages = {line.split()[1] for line in plan.splitlines() if line.startswith('Inst ')}
packages.update(['libwebkit2gtk-4.1-dev', 'libgtk-3-dev'])
if packages:
    subprocess.run(['apt-get', 'download', *sorted(packages)], cwd=root / 'debs', check=True)
(root / 'versions.txt').write_text('')
for deb in (root / 'debs').glob('*.deb'):
    subprocess.run(['dpkg-deb', '-x', str(deb), str(root / 'root')], check=True)
    with (root / 'versions.txt').open('a') as versions:
        subprocess.run(['dpkg-deb', '-f', str(deb), 'Package', 'Version'], stdout=versions, check=True)
# Development symlinks refer to host runtime libraries. Resolve only links whose
# extracted target is absent; runtime search paths remain untouched.
for link in (root / 'root/usr/lib/x86_64-linux-gnu').glob('*.so'):
    if link.is_symlink() and not link.exists():
        host = pathlib.Path('/usr/lib/x86_64-linux-gnu') / link.readlink().name
        if host.exists():
            link.unlink()
            link.symlink_to(host)
print(f'Local SDK: {root}')
