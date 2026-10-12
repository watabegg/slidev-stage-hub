import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectDeckSource } from '@slidock/slidev-adapter/inspect-deck';

test('UTF-8 note slots preserve source byte offsets across CRLF and multibyte text', () => {
  const text =
    '# 日本語\r\nbody 🟦\r\n<!-- 話者メモ 💬 -->\r\n---\r\n# Next\r\n<!-- second note -->\r\n';
  const firstPageEnd = text.indexOf('---');
  const secondPageStart = text.indexOf('# Next');
  let parserArguments;
  const parseSync = (sourceText, source, options) => {
    parserArguments = { sourceText, source, options };
    return {
      slides: [
        {
          content: 'body 🟦 <div v-click>step</div>',
          index: 0,
          start: 0,
          raw: text.slice(0, firstPageEnd),
          note: '話者メモ 💬',
        },
        {
          content: '# Next',
          index: 1,
          start: 4,
          raw: text.slice(secondPageStart),
          note: 'second note',
        },
      ],
    };
  };

  const inspection = inspectDeckSource({ id: 'a/deck', source: 'deck.md', text, parseSync });
  assert.equal(parserArguments.sourceText, text);
  assert.equal(parserArguments.source, 'deck.md');
  assert.deepEqual(parserArguments.options, { preserveCR: true });
  assert.deepEqual(inspection.clickTotals, [1, 0]);

  const originalBytes = Buffer.from(text);
  const replacements = [' 更新済み 💬 ', ' replacement '];
  const rewrittenBytes = Buffer.from(
    inspection.slots.reduceRight((sourceBytes, slot, index) => {
      const replacement = Buffer.from(replacements[index]);
      return Buffer.concat([
        sourceBytes.subarray(0, slot.start),
        replacement,
        sourceBytes.subarray(slot.end),
      ]);
    }, originalBytes),
  );
  assert.equal(
    rewrittenBytes.toString('utf8'),
    text
      .replace('<!-- 話者メモ 💬 -->', `<!--${replacements[0]}-->`)
      .replace('<!-- second note -->', `<!--${replacements[1]}-->`),
  );
  assert.deepEqual(
    inspection.slots.map((slot) => originalBytes.subarray(slot.start, slot.end).toString()),
    [' 話者メモ 💬 ', ' second note '],
  );
});

test('parser shape, page-count, and unsupported click mismatches fail closed', () => {
  const text = '# page';
  const slide = { content: '# page', index: 0, start: 0, raw: text };
  const parseSync = () => ({ slides: [slide] });
  assert.throws(
    () => inspectDeckSource({ id: 'a/deck', source: 'deck.md', text, parseSync, expectedPages: 2 }),
    /public artifact\/source page count differs/,
  );
  assert.throws(
    () => inspectDeckSource({ id: 'a/deck', source: 'deck.md', text, parseSync: () => ({}) }),
    /parser returned no slides/,
  );
  assert.throws(
    () =>
      inspectDeckSource({
        id: 'a/deck',
        source: 'deck.md',
        text: '<div v-click="2">step</div>',
        parseSync: () => ({
          slides: [{ ...slide, content: '<div v-click="2">step</div>' }],
        }),
      }),
    /unsupported click syntax/,
  );
});
