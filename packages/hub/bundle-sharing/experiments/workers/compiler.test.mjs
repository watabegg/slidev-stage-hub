import assert from 'node:assert/strict';
import test from 'node:test';
import { compileDeck } from './compiler.mjs';

const markdown = [
  '---',
  'title: Workers Deck',
  'subtitle: Compiler fixture',
  'description: "Public <!-- PRIVATE_NOTE_frontmatter_comment --> description"',
  'notes: PRIVATE_NOTE_headmatter',
  'themeConfig:',
  '  watabegg:',
  '    color: blue',
  'images:',
  '  - src: ./assets/frontmatter.svg',
  '    alt: Frontmatter image',
  '---',
  '# Cover content',
  '',
  '<FigureGrid :images="$frontmatter.images" v-click="1" />',
  '<div>{{ $frontmatter.title }} / {{ $page }} / {{ $slidev.title }} / {{ $clicksContext.current }}</div>',
  '',
  '<div class="bg-indigo-600 text-white p-4">Reveal</div>',
  '',
  '![Relative markdown image](./assets/diagram.png)',
  '<img src="./assets/raw.svg" alt="Raw image">',
  '',
  '<!-- PRIVATE_NOTE_inline_comment -->',
  '',
  '<style scoped>',
  '.cover-note { color: red; }',
  '</style>',
  '',
  '<style>',
  '.cover-plain { color: blue; }',
  '</style>',
  '',
  '---',
  'layout: default',
  'title: Default page',
  'notes: PRIVATE_NOTE_page',
  '---',
  '## Default heading',
  '',
  '- first item',
  '- second item',
  '',
  '```ts',
  'const runtime = "Slidev"',
  '```',
  '',
  '~~~html',
  '<!-- code comment stays visible as example source -->',
  '<style>not a page style</style>',
  '~~~',
  '',
  '---',
  'layout: section',
  'title: Section page',
  '---',
  '# Section body',
  '',
  '<!-- PRIVATE_NOTE_terminal_comment -->',
].join('\n');

test('compiles cover, default, and section slides with their frontmatter and Vue content', async () => {
  const result = await compileDeck({ markdown, deckId: 'fixtures/workers-demo' });

  assert.equal(result.title, 'Workers Deck');
  assert.deepEqual(result.frontmatter, {
    title: 'Workers Deck',
    subtitle: 'Compiler fixture',
    description: 'Public  description',
    themeConfig: { watabegg: { color: 'blue' } },
    images: [
      { src: '/sources/fixtures/workers-demo/assets/frontmatter.svg', alt: 'Frontmatter image' },
    ],
  });
  assert.equal(result.slides.length, 3);
  assert.deepEqual(
    result.slides.map((slide) => slide.no),
    [1, 2, 3],
  );
  assert.equal(result.slides[0].title, 'Workers Deck');
  assert.equal(result.slides[1].title, 'Default page');
  assert.equal(result.slides[2].title, 'Section page');
  assert.equal(result.slides[0].frontmatter.title, 'Workers Deck');
  assert.equal(result.slides[1].frontmatter.layout, 'default');
  assert.equal(result.slides[1].frontmatter.title, 'Default page');
  assert.equal(result.slides[2].frontmatter.layout, 'section');
  assert.equal(result.slides[2].frontmatter.title, 'Section page');

  const first = result.slides[0];
  assert.match(first.code, /resolveComponent\("FigureGrid"\)/);
  assert.match(first.code, /resolveDirective\("click"\)/);
  assert.match(first.code, /images: \$setup\.\$frontmatter\.images/);
  assert.match(first.code, /_toDisplayString\(\$setup\.\$frontmatter\.title\)/);
  assert.match(first.code, /_toDisplayString\(\$setup\.\$page\)/);
  assert.match(first.code, /_toDisplayString\(\$setup\.\$slidev\.title\)/);
  assert.match(first.code, /_toDisplayString\(\$setup\.\$clicksContext\.current\)/);
  assert.match(first.code, /LabSlideLayout/);
  assert.match(first.code, /\/_runtime\/vue\.js/);
  assert.match(first.code, /\/_runtime\/bridge\.js/);
  assert.match(first.code, /\/sources\/fixtures\/workers-demo\/assets\/diagram\.png/);
  assert.match(first.code, /\/sources\/fixtures\/workers-demo\/assets\/raw\.svg/);
  assert.match(first.css, /\.bg-indigo-600/);
  assert.match(first.css, /\.text-white/);
  assert.match(first.css, /\.cover-note\[data-v-[0-9a-f]+\]/);
  assert.match(first.css, /\.cover-plain/);
  assert.match(first.code, /__scopeId = "data-v-[0-9a-f]+"/);
  assert.match(result.slides[1].code, /<|_createElementVNode/); // Markdown headings/list/code compile into render nodes.
  assert.match(result.slides[1].code, /Default heading/);
  assert.match(result.slides[1].code, /first item/);
  assert.match(result.slides[1].code, /const runtime = /);
});

test('removes notes and HTML comments from public content/frontmatter but keeps code examples', async () => {
  const result = await compileDeck({ markdown, deckId: 'notes-check' });
  const serialized = JSON.stringify(result);

  for (const sentinel of [
    'PRIVATE_NOTE_frontmatter',
    'PRIVATE_NOTE_headmatter',
    'PRIVATE_NOTE_page',
    'PRIVATE_NOTE_inline_comment',
    'PRIVATE_NOTE_terminal_comment',
  ]) {
    assert(!serialized.includes(sentinel), `${sentinel} leaked into compiler output`);
  }
  assert.match(result.slides[1].code, /code comment stays visible as example source/);
  assert.match(result.slides[1].code, /not a page style/);
});

test('compilation is deterministic and warns about plain fenced code', async () => {
  const first = await compileDeck({ markdown, deckId: 'deterministic' });
  const second = await compileDeck({ markdown, deckId: 'deterministic' });
  assert.deepEqual(second, first);
  assert.deepEqual(first.warnings, [
    'Fenced code is rendered as plain Markdown; Slidev syntax highlighting and code-block transforms are not included.',
  ]);
  assert.deepEqual(
    (await compileDeck({ markdown: '# No code fences', deckId: 'no-code' })).warnings,
    [],
  );
});

test('keeps Vue moustaches and tags literal inside inline and fenced Markdown code', async () => {
  const result = await compileDeck({
    markdown: [
      'Inline `{{ inlineValue }}` and `<span v-if="ready">`.',
      '',
      '```html',
      '{{ value }}',
      '<div v-if="ready" v-click="1">Vue source</div>',
      '```',
    ].join('\n'),
    deckId: 'literal-code',
  });
  const code = result.slides[0].code;

  assert.match(code, /\{\{ inlineValue \}\}/);
  assert.match(code, /\{\{ value \}\}/);
  assert.match(code, /<span v-if=/);
  assert.match(code, /<div v-if=.*v-click=/);
  assert.doesNotMatch(code, /_ctx\.(?:inlineValue|value|ready)/);
  assert.doesNotMatch(code, /resolveDirective\("(?:if|click)"\)/);
});

test('warns when dollar-delimited math is emitted as plain text', async () => {
  const result = await compileDeck({
    markdown: '# Math\n\nInline $x^2$ and display:\n\n$$\ny^2\n$$',
    deckId: 'plain-math',
  });

  assert.deepEqual(result.warnings, [
    'Dollar-delimited math ($...$ or $$...$$) remains plain text in Workers output; no math renderer is applied.',
  ]);
  assert.match(result.slides[0].code, /\$x\^2\$/);
  assert.match(result.slides[0].code, /\$\$ y\^2 \$\$/);
});

test('does not detect dollar math inside inline or fenced code', async () => {
  const result = await compileDeck({
    markdown: 'Inline code `$x$`.\n\n```tex\n$$ y^2 $$\n```',
    deckId: 'math-in-code',
  });

  assert.deepEqual(result.warnings, [
    'Fenced code is rendered as plain Markdown; Slidev syntax highlighting and code-block transforms are not included.',
  ]);
});

test('includes parser-derived titles when a slide title is only a heading', async () => {
  const result = await compileDeck({
    markdown:
      '---\ntitle: Deck title\n---\n# First heading\n\n---\nlayout: section\n---\n## Heading-derived title',
    deckId: 'heading-titles',
  });
  assert.equal(result.slides[0].title, 'Deck title');
  assert.equal(result.slides[1].title, 'Heading-derived title');
  assert.equal(result.slides[1].frontmatter.layout, 'section');
});

test('rejects executable scripts and unsupported style preprocessors explicitly', async () => {
  await assert.rejects(
    compileDeck({
      markdown: '# Before\n\n<script setup>throw new Error("no")</script>',
      deckId: 'script',
    }),
    /<script> block|unsupported script block/i,
  );
  await assert.rejects(
    compileDeck({
      markdown: '# Before\n\n<style lang="scss">.a { color: red }</style>',
      deckId: 'scss',
    }),
    /unsupported <style lang>/i,
  );
});

test('rejects Slidev source includes and compiles named-slot shorthand', async () => {
  await assert.rejects(
    compileDeck({ markdown: '---\nsrc: ./included.md\n---\n# Page', deckId: 'include' }),
    /src include.*not supported/i,
  );
  const result = await compileDeck({
    markdown:
      '# Page\n\n::left::\n\nleft content\n\n::right::\n\nright content\n\n::default::\n\ndefault content',
    deckId: 'slots',
  });
  assert.match(result.slides[0].code, /left: _withCtx\(\(\) => \[/);
  assert.match(result.slides[0].code, /right: _withCtx\(\(\) => \[/);
  assert.match(result.slides[0].code, /default: _withCtx\(\(\) => \[/);
  assert.match(result.slides[0].code, /left content/);
  assert.match(result.slides[0].code, /right content/);
  assert.match(result.slides[0].code, /default content/);

  const codeExample = await compileDeck({ markdown: '~~~md\n::left::\n~~~', deckId: 'slot-code' });
  assert.match(codeExample.slides[0].code, /::left::/);
  assert.doesNotMatch(codeExample.slides[0].code, /left: _withCtx/);
});

test('rejects raw Vue template tags with an accurate error', async () => {
  await assert.rejects(
    compileDeck({
      markdown: '# Page\n\n<template #before><p>Before</p></template>',
      deckId: 'raw-template',
    }),
    /raw <template> tag; raw Vue template blocks are not supported in slide content/i,
  );
});

test('rejects diagram, Monaco, Twoslash, and Magic Move fences', async () => {
  const unsupported = [
    ['```mermaid\nflowchart LR\n```', /mermaid fence/i],
    ['```plantuml\n@startuml\n@enduml\n```', /plantuml fence/i],
    ['```js {monaco}\nconst value = 1\n```', /Monaco fence metadata/i],
    ['```ts twoslash\nconst value = 1\n```', /Twoslash fence metadata/i],
    ['```ts {magic-move}\nconst value = 1\n```', /Magic Move fence metadata/i],
  ];
  for (const [source, expected] of unsupported) {
    await assert.rejects(compileDeck({ markdown: source, deckId: 'special-code' }), expected);
  }
});

test('enforces the 100-slide limit before compiling any slide', async () => {
  const tooManySlides = [
    '# First slide\n\n<script setup>unsupported</script>',
    ...Array.from({ length: 100 }, (_, index) => `---\nlayout: default\n---\n# Slide ${index + 2}`),
  ].join('\n');
  await assert.rejects(
    compileDeck({ markdown: tooManySlides, deckId: 'too-many' }),
    /101 slides; the Workers compiler limit is 100/,
  );
});

test('rejects image traversal outside the deck source and unsafe compiler inputs', async () => {
  await assert.rejects(
    compileDeck({ markdown: '![escape](../outside.png)', deckId: 'safe/deck' }),
    /escapes deck "safe\/deck"/,
  );
  await assert.rejects(
    compileDeck({ markdown: '![absolute escape](/%2e%2e/outside.png)', deckId: 'safe/deck' }),
    /escapes deck "safe\/deck"/,
  );
  await assert.rejects(
    compileDeck({ markdown: '# Safe', deckId: '../outside' }),
    /traversal path segments/,
  );
  await assert.rejects(
    compileDeck({ markdown: '# Safe', deckId: 'safe', assetBase: '/sources/%2e%2e/outside/' }),
    /unsafe path segment/,
  );
  await assert.rejects(
    compileDeck({
      markdown: '---\nimages:\n  - src: ../outside.svg\n---\n# Image',
      deckId: 'safe',
    }),
    /escapes deck "safe"/,
  );
});
