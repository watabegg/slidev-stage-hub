#!/usr/bin/env python3
"""Run the actual native app, collect its QA result, then stop only that process."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--timeout', type=float, default=90)
parser.add_argument('--log', type=Path, default=root / 'artifacts/runtime-qa.log')
args = parser.parse_args()
args.log = args.log.resolve()
args.log.parent.mkdir(parents=True, exist_ok=True)
config = json.loads((root / 'artifacts/local-config.json').read_text())
source_root = Path(config['approvedSourceRoot']).resolve()
sources = [Path(item['source']).resolve() for item in config['notes'].values()]
if any(not source.is_relative_to(source_root) for source in sources):
    raise SystemExit('notes source outside the approved root')
original = {source: source.read_bytes() for source in sources}
process = None
qa = None
error = None
try:
    with args.log.open('w') as output:
        process = subprocess.Popen([str(root / 'target/debug/slidev-native-poc')], cwd=root, env={**os.environ, 'NATIVE_POC_QA': '1'}, stdout=output, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + args.timeout
        while time.monotonic() < deadline:
            for line in args.log.read_text(errors='replace').splitlines():
                if not line.startswith('VIEWER_READY presenter '):
                    continue
                try:
                    report = json.loads(line.split(' ', 2)[2]).get('qa', {})
                except (ValueError, IndexError):
                    continue
                if 'complete' in report:
                    qa = report
                    break
            if qa is not None:
                break
            if process.poll() is not None:
                error = f'native process exited {process.returncode} before QA result'
                break
            time.sleep(0.2)
        if qa is None and error is None:
            error = f'QA did not finish within {args.timeout:g}s'
finally:
    if process is not None and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)

unchanged = all(source.read_bytes() == before for source, before in original.items())
result = {'qa': qa, 'error': error, 'sourceRestored': unchanged, 'sourceSHA256': {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in sources}, 'log': str(args.log)}
if (root / 'artifacts/notes-before.md').exists() and (root / 'artifacts/notes-after.md').exists():
    with (root / 'artifacts/notes-save.diff').open('w') as diff:
        subprocess.run(['git', 'diff', '--no-index', str(root / 'artifacts/notes-before.md'), str(root / 'artifacts/notes-after.md')], stdout=diff, check=False)
args.log.with_suffix('.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
passed = qa is not None and qa.get('complete') is True and all(item['pass'] for item in qa.get('assertions', [])) and unchanged
raise SystemExit(0 if passed else 1)
