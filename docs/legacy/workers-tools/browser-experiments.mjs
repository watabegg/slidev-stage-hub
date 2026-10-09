import { chromium } from 'playwright-chromium';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startHarness, artifactRoot, experiment } from './harness.mjs';
const { mf, origin } = await startHarness();
const browser = await chromium.launch({
  channel: 'chromium',
  executablePath: process.env.CHROMIUM_EXECUTABLE,
  headless: true,
});
const checks = [];
const check = (name, passed) => {
  checks.push({ name, passed: Boolean(passed) });
  console.log(passed ? 'PASS' : 'FAIL', name);
};
const publish = async (id, markdown) => {
  const r = await fetch(origin + '/api/decks/' + encodeURIComponent(id), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ markdown }),
  });
  assert.equal(r.status, 200);
  return r.json();
};
const source = (name, color) =>
  `---\nlayout: default\n---\n# ${name}\n\n<div class="isolation-probe">${name} color</div>\n\n<style scoped>\n.isolation-probe { background-color: ${color}; }\n</style>\n\n---\nlayout: default\n---\n# ${name} page two\n\n<div v-click data-testid="reveal">${name} reveal</div>`;
try {
  const alpha = await publish('browser/alpha', source('Alpha', 'rgb(210, 20, 30)'));
  const beta = await publish('browser/beta', source('Beta', 'rgb(20, 30, 210)'));
  const context = await browser.newContext({ viewport: { width: 1200, height: 675 } });
  const a = await context.newPage(),
    b = await context.newPage();
  await Promise.all([a.goto(origin + alpha.entry), b.goto(origin + beta.entry)]);
  await Promise.all([
    a.locator('.isolation-probe').waitFor(),
    b.locator('.isolation-probe').waitFor(),
  ]);
  check(
    'two same-origin decks retain their own scoped CSS',
    (await a
      .locator('.isolation-probe')
      .evaluate((e) => getComputedStyle(e).backgroundColor === 'rgb(210, 20, 30)')) &&
      (await b
        .locator('.isolation-probe')
        .evaluate((e) => getComputedStyle(e).backgroundColor === 'rgb(20, 30, 210)')),
  );
  await a.keyboard.press('Enter');
  await a.locator('.slidev-page[data-slidev-no="2"] h1').waitFor();
  await a.keyboard.press('Enter');
  await a.waitForTimeout(250);
  check(
    'navigation and clicks do not move another deck tab',
    new URL(a.url()).pathname.endsWith('/2') &&
      new URL(b.url()).pathname.endsWith('/1') &&
      (await b.locator('.slidev-page[data-slidev-no="1"] h1').textContent()) === 'Beta',
  );
  const currentA = await publish('browser/alpha', source('Alpha updated', 'rgb(0, 150, 20)'));
  await a.reload();
  await a.locator('.slidev-page[data-slidev-no="2"] h1').waitFor();
  check(
    'existing tab stays on old revision after update and reload',
    new URL(a.url()).searchParams.get('revision') === alpha.revision &&
      (await a.locator('.slidev-page[data-slidev-no="2"] h1').textContent()) === 'Alpha page two',
  );
  const fresh = await context.newPage();
  await fresh.goto(origin + '/browser/alpha/1');
  await fresh.locator('.isolation-probe').waitFor();
  check(
    'unversioned URL opens newly published revision',
    new URL(fresh.url()).searchParams.get('revision') === currentA.revision &&
      (await fresh.locator('.isolation-probe').textContent()) === 'Alpha updated color',
  );
  const delayed = await context.newPage();
  let release;
  const gate = new Promise((r) => (release = r));
  await delayed.route('**/releases/**/1.css', async (route) => {
    await gate;
    await route.continue();
  });
  await delayed.goto(origin + beta.entry);
  await delayed.waitForTimeout(400);
  check(
    'slide content does not flash before stylesheet is available',
    (await delayed.locator('.isolation-probe').count()) === 0,
  );
  release();
  await delayed.locator('.isolation-probe').waitFor();
  check(
    'delayed stylesheet eventually renders styled content',
    await delayed
      .locator('.isolation-probe')
      .evaluate((e) => getComputedStyle(e).backgroundColor === 'rgb(20, 30, 210)'),
  );
  const broken = await context.newPage();
  const expectedErrors = [];
  broken.on('pageerror', (error) => expectedErrors.push(error.message));
  await broken.route('**/releases/**/1.css', (route) => route.abort('failed'));
  await broken.goto(origin + beta.entry);
  await broken.waitForTimeout(1000);
  const visibleError =
    (await broken
      .getByRole('alert')
      .filter({ hasText: 'スライドを読み込めませんでした' })
      .count()) > 0;
  check('failed stylesheet shows actionable error instead of blank slide', visibleError);
  await broken.screenshot({ path: resolve(artifactRoot, 'stylesheet-failure.png') });
  await broken.unroute('**/releases/**/1.css');
  if (visibleError) await broken.getByRole('button', { name: '再読み込み', exact: true }).click();
  else await broken.reload();
  await broken.locator('.isolation-probe').waitFor();
  check(
    'reload recovers after stylesheet connection is restored',
    (await broken.locator('.isolation-probe').textContent()) === 'Beta color',
  );
  const result = {
    scope: 'Local Chrome, two same-origin tabs, old/new revisions and network fault injection',
    checks,
    expectedNetworkErrors: expectedErrors,
  };
  await writeFile(
    resolve(experiment, 'results/browser-experiments.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  assert.equal(checks.filter((c) => !c.passed).length, 0);
} finally {
  await browser.close();
  await mf.dispose();
}
