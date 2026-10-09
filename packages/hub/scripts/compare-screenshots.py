"""Compare matching experiment PNGs without modifying the images."""
import json
import sys
from pathlib import Path
from PIL import Image, ImageChops, ImageStat

baseline = Path(sys.argv[1] if len(sys.argv) > 1 else 'artifacts/browser-baseline')
candidate = Path(sys.argv[2] if len(sys.argv) > 2 else 'artifacts/browser-module-graph-minified')
output = Path(sys.argv[3] if len(sys.argv) > 3 else 'artifacts/visual-comparison.json')
rows = []
for source in sorted(baseline.glob('*.png')):
    target = candidate / source.name
    if not target.exists():
        raise SystemExit(f'Missing candidate screenshot: {target}')
    a, b = Image.open(source).convert('RGB'), Image.open(target).convert('RGB')
    if a.size != b.size:
        raise SystemExit(f'Different screenshot dimensions: {source.name}')
    diff = ImageChops.difference(a, b)
    rows.append({'image': source.name, 'size': a.size, 'identical': diff.getbbox() is None,
                 'mean_absolute_channel_error': sum(ImageStat.Stat(diff).mean) / 3,
                 'difference_box': diff.getbbox()})
if not rows:
    raise SystemExit('No screenshots to compare')
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(rows, indent=2) + '\n')
print(f'{sum(row["identical"] for row in rows)}/{len(rows)} pixel-identical; {output}')
