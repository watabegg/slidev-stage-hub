import { chromium } from 'playwright-chromium';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startHarness, artifactRoot, experiment } from './harness.mjs';
const { mf, origin } = await startHarness();
const hubRoot = resolve(experiment, '../../..');
const sharedFixtures = resolve(hubRoot, '../../examples/fixtures');
const browser = await chromium.launch({
  channel: 'chromium',
  executablePath: process.env.CHROMIUM_EXECUTABLE,
  headless: true,
});
const checks = [],
  errors = [];
const check = (name, pass) => {
  assert.ok(pass, name);
  checks.push(name);
  console.log('PASS', name);
};
const publish = async (id, markdown, assets = {}) => {
  const response = await fetch(origin + '/api/decks/' + encodeURIComponent(id), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ markdown, assets }),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
};
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 675 } });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  for (const id of ['aaa/aaa1', 'aaa/aaa2', 'bbb/bbb1', 'bbb/bbb2']) {
    const directory = resolve(sharedFixtures, id);
    const original = await readFile(resolve(directory, 'slides.md'), 'utf8');
    // Explicitly test only original first two pages. The third contains unsupported Mermaid/math.
    const source = original.split('\n---\nlayout: default')[0];
    const manifest = await publish('fixture/' + id, source, {
      'assets/conflict.svg': await readFile(resolve(directory, 'assets/conflict.svg'), 'utf8'),
    });
    check(`${id}: original cover and two-column page compile`, manifest.slides.length === 2);
    await page.goto(origin + manifest.entry.replace('/1?', '/2?'));
    const left = page.locator('.slidev-page[data-slidev-no="2"] .col-left');
    const right = page.locator('.slidev-page[data-slidev-no="2"] .col-right');
    await left
      .locator('img')
      .waitFor({ timeout: 5000 })
      .catch(async (error) => {
        await page.screenshot({ path: resolve(artifactRoot, 'fixture-failed.png') });
        console.error('PAGE', await page.locator('body').innerText(), errors);
        throw error;
      });
    check(
      `${id}: left slot image decodes`,
      await left.locator('img').evaluate(async (img) => {
        await img.decode();
        return img.naturalWidth > 0;
      }),
    );
    check(
      `${id}: right slot contains deck content`,
      (await right.innerText()).includes('Deck ' + id.split('/')[1]),
    );
    const click = right.getByText('First click step', { exact: true });
    check(
      `${id}: click starts hidden`,
      await click.evaluate(
        (el) =>
          getComputedStyle(el).visibility === 'hidden' || getComputedStyle(el).opacity === '0',
      ),
    );
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(250);
    check(
      `${id}: ArrowRight reveals right-slot click`,
      await click.evaluate(
        (el) =>
          getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).opacity !== '0',
      ),
    );
    if (id === 'aaa/aaa1')
      await page.screenshot({ path: resolve(artifactRoot, 'original-two-cols.png') });
  }
  const literal = await publish(
    'fixture/code',
    '---\nlayout: default\n---\n# Literal code\n\n```vue\n{{ missing_value }}\n<div v-click>sample</div>\n::left::\n```\n\nInline: `{{ also_missing }}`',
  );
  await page.goto(origin + literal.entry);
  await page.locator('.slidev-page[data-slidev-no="1"] pre').waitFor();
  const text = await page.locator('.slidev-page[data-slidev-no="1"]').innerText();
  check(
    'fenced code preserves interpolation and Vue markup literally',
    text.includes('{{ missing_value }}') && text.includes('<div v-click>sample</div>'),
  );
  check('slot markers in code are literal text', text.includes('::left::'));
  check('inline code preserves interpolation literally', text.includes('{{ also_missing }}'));
  check('all expanded fixture pages have no browser exceptions', errors.length === 0);
  await writeFile(
    resolve(experiment, 'results/fixture-browser.json'),
    JSON.stringify(
      {
        scope:
          'Original first two pages from four fixtures; third page omitted explicitly (unsupported Mermaid/math)',
        checks,
        errors,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await browser.close();
  await mf.dispose();
}
