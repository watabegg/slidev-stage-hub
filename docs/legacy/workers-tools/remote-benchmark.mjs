import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
const origin = process.argv[2];
if (!origin || !origin.startsWith('https://') || !process.env.SLIDEV_POC_TOKEN_FILE)
  throw new Error('HTTPS origin and SLIDEV_POC_TOKEN_FILE required');
const token = (await readFile(process.env.SLIDEV_POC_TOKEN_FILE, 'utf8')).trim();
const measurements = [];
for (const pages of [5, 50, 100]) {
  const markdown = Array.from(
    { length: pages },
    (_, i) =>
      `# Page ${i + 1}\n\n<div v-click class="bg-indigo-600 text-white p-4">Click ${i + 1}</div>\n\n- One\n- Two`,
  ).join('\n\n---\n\n');
  for (const phase of ['compile', 'cached']) {
    const start = performance.now();
    const response = await fetch(origin + `/api/decks/cloud%2Fbench-${pages}`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ markdown }),
    });
    const body = await response.text();
    let data;
    try {
      data = JSON.parse(body);
    } catch {}
    const result = {
      pages,
      phase,
      status: response.status,
      httpWallMs: Math.round(performance.now() - start),
      cached: data?.cached,
      revision: data?.revision,
      error: data?.error || (!response.ok ? body.slice(0, 100) : undefined),
    };
    measurements.push(result);
    console.log(JSON.stringify(result));
    if (!response.ok) break;
  }
  if (measurements.at(-1).status !== 200) break;
}
await writeFile(
  'results/remote-benchmark.json',
  JSON.stringify(
    {
      origin,
      measurement: 'Client HTTP wall time; actual cpuTime recorded separately by cloud-tail',
      measurements,
    },
    null,
    2,
  ) + '\n',
);
