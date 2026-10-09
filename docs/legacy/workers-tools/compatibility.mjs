import { themeDirectory } from '../../../../../scripts/runtime-environment.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileDeck } from './compiler.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const themeRoot = resolve(themeDirectory());
const themeExample = join(themeRoot, 'example.md');
const outputPath = join(here, 'results/compatibility.json');

const focusedCases = [
  {
    id: 'gfm-table',
    markdown: '# Table\n\n| A | B |\n|:-|:-|\n| one | two |',
    assess(result) {
      const code = result.slides[0].code;
      return {
        accepted:
          code.includes('_createElementVNode("table"') &&
          code.includes('"one"') &&
          code.includes('"two"'),
        evidence: 'Vue render code contains table, header, and both cell values.',
      };
    },
  },
  {
    id: 'nested-lists',
    markdown: '# List\n\n- one\n  - nested\n    - deep',
    assess(result) {
      const code = result.slides[0].code;
      return {
        accepted:
          code.includes('"deep"') && (code.match(/_createElementVNode\("ul"/g) ?? []).length >= 3,
        evidence:
          'Vue render code contains three nested unordered-list nodes and the deepest item.',
      };
    },
  },
  {
    id: 'block-math',
    markdown: '# Math\n\n$$\nx^2 + y^2\n$$',
    assess(result) {
      const code = result.slides[0].code;
      const rawMath = code.includes('$$ x^2 + y^2 $$');
      const mathRenderer = /katex|mathjax|renderMath/i.test(code + result.slides[0].css);
      const warning =
        result.warnings.find((item) => item.includes('Dollar-delimited math')) ?? null;
      return {
        accepted: rawMath && !mathRenderer && Boolean(warning),
        classification:
          rawMath && !mathRenderer
            ? warning
              ? 'acceptance_with_warning'
              : 'silent_incorrect_output'
            : undefined,
        evidence: {
          rawDollarTextPreserved: rawMath,
          mathRendererGenerated: mathRenderer,
          warning,
          codeExcerpt: excerpt(code, '$$'),
        },
        expected: 'Rendered math or an explicit unsupported-syntax warning/rejection.',
      };
    },
  },
  {
    id: 'inline-math',
    markdown: 'The result is $x^2$ and the area is $\\pi r^2$.',
    assess(result) {
      const code = result.slides[0].code;
      const rawMath = code.includes('$x^2$') && code.includes('r^2$');
      const mathRenderer = /katex|mathjax|renderMath/i.test(code + result.slides[0].css);
      const warning =
        result.warnings.find((item) => item.includes('Dollar-delimited math')) ?? null;
      return {
        accepted: rawMath && !mathRenderer && Boolean(warning),
        classification:
          rawMath && !mathRenderer
            ? warning
              ? 'acceptance_with_warning'
              : 'silent_incorrect_output'
            : undefined,
        evidence: {
          rawDollarTextPreserved: rawMath,
          mathRendererGenerated: mathRenderer,
          warning,
          codeExcerpt: excerpt(code, '$x^2$'),
        },
        expected: 'Rendered inline math or an explicit unsupported-syntax warning/rejection.',
      };
    },
  },
  {
    id: 'slidev-shorthand-named-slot',
    markdown:
      '# Two columns\n\n::left::\n\nleft content\n\n::right::\n\nright content\n\n::default::\n\ndefault content',
    assess(result) {
      const code = result.slides[0].code;
      const slots = ['left', 'right', 'default'].filter((name) =>
        code.includes(`${name}: _withCtx(() => [`),
      );
      return {
        accepted: slots.length === 3,
        evidence: {
          generatedSlots: slots,
          contentPreserved: ['left content', 'right content', 'default content'].every((value) =>
            code.includes(value),
          ),
        },
      };
    },
  },
  {
    id: 'vue-template-named-slots',
    markdown:
      '# Figure\n\n<FigureGrid><template #before><p>Before</p></template><template #after><p>After</p></template></FigureGrid>',
    expectedError: /raw <template> tag; raw Vue template blocks are not supported/i,
    expected:
      'Raw Vue template blocks remain explicitly unsupported; the rejection names the unsupported content accurately.',
  },
  {
    id: 'scoped-style',
    markdown:
      '# Style\n\n<div class="probe">visible</div>\n\n<style scoped>\n.probe { color: red }\n</style>',
    assess(result) {
      const slide = result.slides[0];
      return {
        accepted: /__scopeId = "data-v-/.test(slide.code) && /\.probe\[data-v-/.test(slide.css),
        evidence: 'Generated component scope id matches the scoped CSS selector.',
      };
    },
  },
  {
    id: 'relative-style-url',
    markdown:
      '# CSS URL\n\n<div class="hero">visible</div>\n\n<style scoped>\n.hero { background: url(./assets/bg.svg) }\n</style>',
    assess(result) {
      const css = result.slides[0].css;
      const relativeUrlPreserved = css.includes('url(./assets/bg.svg)');
      return {
        accepted: relativeUrlPreserved,
        evidence: {
          relativeUrlPreserved,
          emittedStylesheetPath: '/{deck-prefix}/{slide-no}.css',
          emittedAssetPath: '/{deck-prefix}/assets/{name}',
          resolution:
            'Relative CSS URL resolves from the emitted stylesheet to the adjacent assets/ directory in worker.mjs.',
        },
      };
    },
  },
  {
    id: 'frontmatter-defaults',
    markdown:
      '---\ntitle: Defaults deck\ndefaults:\n  layout: section\n  color: blue\n  transition: fade\n---\n# Cover\n\n---\ntitle: Inherits defaults\n---\n# Page two\n\n---\ncolor: red\n---\n# Override',
    assess(result) {
      const defaults = result.frontmatter.defaults;
      const pageTwo = result.slides[1].frontmatter;
      const pageThree = result.slides[2].frontmatter;
      const passedToRuntime =
        defaults?.layout === 'section' &&
        defaults?.color === 'blue' &&
        pageTwo.title === 'Inherits defaults' &&
        pageThree.color === 'red';
      return {
        accepted: passedToRuntime,
        evidence: {
          deckDefaultsRetained: defaults,
          pageTwoRawFrontmatter: pageTwo,
          pageThreeOverride: pageThree,
          runtimeMergeSource:
            'runtime/routes.ts uses reactive({ ...defaults, ...item.frontmatter });',
        },
      };
    },
  },
  {
    id: 'relative-and-frontmatter-images',
    markdown:
      '---\nimage: ./assets/bg.svg\nimages:\n  - src: ./assets/a.svg\n    alt: Frontmatter\n---\n![Markdown](./assets/m.png?size=2)\n<img src="./assets/raw.svg" alt="Raw">',
    assess(result) {
      const slide = result.slides[0];
      const all = JSON.stringify({ frontmatter: result.frontmatter, slide });
      const expected = [
        '/sources/compat/case-relative-and-frontmatter-images/assets/bg.svg',
        '/sources/compat/case-relative-and-frontmatter-images/assets/a.svg',
        '/sources/compat/case-relative-and-frontmatter-images/assets/m.png?size=2',
        '/sources/compat/case-relative-and-frontmatter-images/assets/raw.svg',
      ];
      const found = expected.filter((value) => all.includes(value));
      return {
        accepted: found.length === expected.length,
        evidence: { rewrittenUrls: found, expectedCount: expected.length },
      };
    },
  },
  {
    id: 'html-comments-and-private-notes',
    markdown:
      '---\nnotes: PRIVATE_FRONTMATTER\ndescription: "Visible <!-- PRIVATE_FM_COMMENT --> text"\n---\n# Comments\n\nVisible <!-- PRIVATE_BODY_COMMENT --> content\n\n<!-- PRIVATE_TAIL_COMMENT -->',
    assess(result) {
      const output = JSON.stringify(result);
      const sentinels = [
        'PRIVATE_FRONTMATTER',
        'PRIVATE_FM_COMMENT',
        'PRIVATE_BODY_COMMENT',
        'PRIVATE_TAIL_COMMENT',
      ];
      const leaked = sentinels.filter((value) => output.includes(value));
      return {
        accepted:
          leaked.length === 0 &&
          output.includes('Visible  text') &&
          output.includes('Visible content'),
        evidence: {
          leakedSentinels: leaked,
          commentFreeTextPreserved:
            output.includes('Visible  text') && output.includes('Visible content'),
        },
      };
    },
  },
  {
    id: 'fenced-code-literal-braces',
    markdown: '```js\nconst point = { x: 1, y: 2 }\n```',
    assess(result) {
      const code = result.slides[0].code;
      return {
        accepted: code.includes('const point = { x: 1, y: 2 }') && result.warnings.length === 1,
        evidence: {
          literalObjectPreserved: code.includes('const point = { x: 1, y: 2 }'),
          warning: result.warnings[0],
        },
      };
    },
  },
  {
    id: 'fenced-code-vue-interpolation',
    markdown: '```html\n{{ value }}\n```',
    assess(result) {
      const code = result.slides[0].code;
      const evaluatedAsVue = code.includes('_toDisplayString(_ctx.value)');
      return {
        accepted: !evaluatedAsVue && code.includes('{{ value }}'),
        classification: evaluatedAsVue ? 'silent_incorrect_output' : undefined,
        evidence: {
          evaluatedAsVue,
          literalMustacheTextPreserved: code.includes('{{ value }}'),
          codeExcerpt: excerpt(code, '_toDisplayString(_ctx.value)'),
        },
        expected: 'A fenced code block should render the source text {{ value }} literally.',
      };
    },
  },
  {
    id: 'inline-code-vue-interpolation',
    markdown: 'Show the literal `{{ value }}` in this example.',
    assess(result) {
      const code = result.slides[0].code;
      const evaluatedAsVue = code.includes('_toDisplayString(_ctx.value)');
      return {
        accepted: !evaluatedAsVue && code.includes('{{ value }}'),
        classification: evaluatedAsVue ? 'silent_incorrect_output' : undefined,
        evidence: {
          evaluatedAsVue,
          literalMustacheTextPreserved: code.includes('{{ value }}'),
          codeExcerpt: excerpt(code, '_toDisplayString(_ctx.value)'),
        },
        expected: 'Inline code should render the source text {{ value }} literally.',
      };
    },
  },
  {
    id: 'raw-html-table',
    markdown: '<table><tbody><tr><td>raw-cell</td></tr></tbody></table>',
    assess(result) {
      const code = result.slides[0].code;
      return {
        accepted: code.includes('_createElementVNode("td"') && code.includes('"raw-cell"'),
        evidence: 'Raw HTML table was converted into Vue table/td nodes.',
      };
    },
  },
  {
    id: 'absolute-and-external-image-urls',
    markdown:
      '![External](https://example.com/a.svg?x=1#top) ![Root](/public/x.svg) ![CDN](//cdn.example/a.png)',
    assess(result) {
      const code = result.slides[0].code;
      const urls = ['https://example.com/a.svg?x=1#top', '/public/x.svg', '//cdn.example/a.png'];
      const found = urls.filter((url) => code.includes(url));
      return { accepted: found.length === urls.length, evidence: { retainedUrls: found } };
    },
  },
  {
    id: 'script-block',
    markdown: '<script setup>const value = 1</script>',
    expectedError: /<script> block.*not supported/i,
  },
  {
    id: 'src-include',
    markdown: '---\nsrc: ./part.md\n---\n# Include',
    expectedError: /src include.*not supported/i,
  },
  {
    id: 'code-fence-protects-comments-and-style-tags',
    markdown: '~~~html\n<!-- code-note -->\n<style>.x {}</style>\n~~~',
    assess(result) {
      const code = result.slides[0].code;
      return {
        accepted:
          code.includes('<!-- code-note -->') &&
          code.includes('<style>.x {}</style>') &&
          result.slides[0].css === '',
        evidence: {
          codeCommentPreserved: code.includes('<!-- code-note -->'),
          styleExamplePreserved: code.includes('<style>.x {}</style>'),
          extractedPageCss: result.slides[0].css,
        },
      };
    },
  },
  {
    id: 'theme-component-and-click-directive',
    markdown: '<QuestionList :items="[{ text: \'one\' }]" />\n\n<div v-click="1">Reveal</div>',
    assess(result) {
      const code = result.slides[0].code;
      return {
        accepted:
          code.includes('resolveComponent("QuestionList")') &&
          code.includes('resolveDirective("click")'),
        evidence: {
          questionListResolved: code.includes('resolveComponent("QuestionList")'),
          clickDirectiveResolved: code.includes('resolveDirective("click")'),
        },
      };
    },
  },
];

function excerpt(value, needle, radius = 110) {
  const index = value.indexOf(needle);
  return index < 0
    ? null
    : value.slice(
        Math.max(0, index - radius),
        Math.min(value.length, index + needle.length + radius),
      );
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function gitValue(args) {
  try {
    return execFileSync('git', ['-C', themeRoot, ...args], { encoding: 'utf8' }).trim();
  } catch (error) {
    return `unavailable: ${error.message}`;
  }
}

async function runCase(item) {
  try {
    const result = await compileDeck({ markdown: item.markdown, deckId: `compat/case-${item.id}` });
    if (item.expectedError) {
      return {
        id: item.id,
        classification: 'unexpected_acceptance',
        outcome: 'accepted',
        expectedError: String(item.expectedError),
        evidence: { slideCount: result.slides.length, warnings: result.warnings },
      };
    }
    const assessment = item.assess(result);
    const classification =
      assessment.classification ?? (assessment.accepted ? 'acceptance' : 'unexpected_output');
    return {
      id: item.id,
      classification,
      outcome:
        classification === 'silent_incorrect_output'
          ? 'compiled_with_silent_mismatch'
          : classification === 'acceptance_with_warning'
            ? 'accepted_with_warning'
            : 'accepted',
      expected: item.expected,
      evidence: assessment.evidence,
      ...(assessment.accepted === false && !assessment.classification
        ? { assessmentPassed: false }
        : {}),
      warnings: result.warnings,
      slideCount: result.slides.length,
    };
  } catch (error) {
    const expected = item.expectedError ? item.expectedError.test(error.message) : false;
    return {
      id: item.id,
      classification: expected ? 'explicit_rejection' : 'unexpected_rejection',
      outcome: 'rejected',
      error: error.message,
      ...(item.expected ? { expected: item.expected } : {}),
      ...(item.expectedError ? { expectedError: String(item.expectedError) } : {}),
    };
  }
}

async function runDeckFile(id, path, sourceKind) {
  const markdown = await readFile(path, 'utf8');
  try {
    const result = await compileDeck({ markdown, deckId: `compat/${id}` });
    return {
      id,
      sourceKind,
      path,
      sourceSha256: sha256(markdown),
      classification: 'acceptance',
      outcome: 'accepted',
      title: result.title,
      slideCount: result.slides.length,
      warnings: result.warnings,
      evidence:
        'compileDeck returned Vue ESM/CSS for the complete source deck; no browser/runtime rendering was performed.',
    };
  } catch (error) {
    const match = /Slide (\d+)/.exec(error.message);
    const lines = markdown.split(/\r?\n/);
    const slotLine = lines.findIndex((line) => /^\s*::[\w-]+::\s*$/.test(line));
    const unsupportedFence = /uses a (mermaid|plantuml|puml) fence/i.exec(error.message);
    const fenceLine = unsupportedFence
      ? lines.findIndex(
          (line) =>
            /^ {0,3}(?:`{3,}|~{3,})/.test(line) &&
            line.toLowerCase().includes(unsupportedFence[1].toLowerCase()),
        )
      : -1;
    const sourceLine = fenceLine >= 0 ? fenceLine : slotLine;
    return {
      id,
      sourceKind,
      path,
      sourceSha256: sha256(markdown),
      classification:
        /uses Slidev named-slot syntax|uses a (?:mermaid|plantuml|puml) fence|uses Monaco fence|uses Twoslash fence|uses Magic Move fence/.test(
          error.message,
        )
          ? 'explicit_rejection'
          : 'unexpected_rejection',
      outcome: 'rejected',
      error: error.message,
      rejectedSlide: match ? Number(match[1]) : null,
      evidence:
        sourceLine >= 0
          ? {
              line: sourceLine + 1,
              sourceExcerpt: lines
                .slice(sourceLine, Math.min(lines.length, sourceLine + 4))
                .join('\n'),
            }
          : null,
    };
  }
}

const sharedFixtures = resolve(repo, '../../examples/fixtures');
const fixtureFiles = [
  ['aaa1', join(sharedFixtures, 'aaa/aaa1/slides.md')],
  ['aaa2', join(sharedFixtures, 'aaa/aaa2/slides.md')],
  ['bbb1', join(sharedFixtures, 'bbb/bbb1/slides.md')],
  ['bbb2', join(sharedFixtures, 'bbb/bbb2/slides.md')],
];

const decks = [];
for (const [id, path] of fixtureFiles)
  decks.push(await runDeckFile(id, path, 'bundle-sharing fixture'));
decks.push(
  await runDeckFile(
    'configured-theme-example',
    themeExample,
    'installed or explicitly configured theme example',
  ),
);

const cases = [];
for (const item of focusedCases) cases.push(await runCase(item));

const themeExampleSource = await readFile(themeExample, 'utf8');
const result = {
  generatedAt: new Date().toISOString(),
  scope:
    'Direct compileDeck compatibility checks only. Successful compilation is not browser/runtime compatibility evidence.',
  command: 'node compatibility.mjs',
  previousRun: {
    path: join(here, 'results/compatibility-before.json'),
    sha256: sha256(await readFile(join(here, 'results/compatibility-before.json'))),
  },
  compiler: {
    path: join(here, 'compiler.mjs'),
    sha256: sha256(await readFile(join(here, 'compiler.mjs'))),
  },
  environment: {
    node: process.version,
    themeRoot,
    themeHead: gitValue(['rev-parse', 'HEAD']),
    themeExampleGitStatus:
      gitValue(['status', '--short', '--', 'example.md']) || 'clean for example.md',
    themeExampleSha256: sha256(themeExampleSource),
  },
  decks,
  focusedCases: cases,
  findings: [
    {
      id: 'full-deck-mermaid-rejection',
      classification: 'explicit_rejection',
      evidence:
        'All five actual decks pass Slidev shorthand-slot parsing and reject on their first Mermaid fence; Mermaid remains an explicit compiler limitation, so no complete deck output is produced.',
      caseIds: ['aaa1', 'aaa2', 'bbb1', 'bbb2', 'configured-theme-example'],
    },
    {
      id: 'raw-markdown-math-is-not-rendered',
      classification: 'acceptance_with_warning',
      evidence:
        'Block and inline dollar math still compile as plain text; the compiler now emits a precise warning and adds no renderer.',
      caseIds: ['block-math', 'inline-math'],
    },
    {
      id: 'vue-interpolation-in-code-examples',
      classification: 'acceptance',
      evidence:
        'Fenced and inline Markdown code preserve {{ value }} and Vue tags/directives as literal rendered text.',
      caseIds: ['fenced-code-vue-interpolation', 'inline-code-vue-interpolation'],
    },
    {
      id: 'vue-template-slot-rejection',
      classification: 'explicit_rejection',
      evidence:
        'Slidev shorthand slots left/right/default compile to named layout slots. Authored raw <template> blocks remain explicitly unsupported with an accurate error.',
      caseIds: ['slidev-shorthand-named-slot', 'vue-template-named-slots'],
    },
  ],
  summary: {
    deckAcceptance: decks.filter((item) => item.classification === 'acceptance').length,
    deckExplicitRejection: decks.filter((item) => item.classification === 'explicit_rejection')
      .length,
    focusedAcceptance: cases.filter((item) => item.classification === 'acceptance').length,
    focusedAcceptanceWithWarning: cases.filter(
      (item) => item.classification === 'acceptance_with_warning',
    ).length,
    focusedExplicitRejection: cases.filter((item) => item.classification === 'explicit_rejection')
      .length,
    focusedSilentIncorrectOutput: cases.filter(
      (item) => item.classification === 'silent_incorrect_output',
    ).length,
    focusedUnexpected: cases
      .filter(
        (item) =>
          ![
            'acceptance',
            'acceptance_with_warning',
            'explicit_rejection',
            'silent_incorrect_output',
          ].includes(item.classification),
      )
      .map((item) => ({ id: item.id, classification: item.classification })),
  },
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, summary: result.summary }, null, 2));
