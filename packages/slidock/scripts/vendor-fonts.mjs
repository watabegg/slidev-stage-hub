import { relative, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vendorFonts as vendorFontsService } from '../dist/node/internal/vendor-fonts.mjs';

const REPO_ROOT = resolve(join(fileURLToPath(import.meta.url), '../..'));

export async function vendorFonts({ siteRoot, evidencePath } = {}) {
  if (!siteRoot) {
    throw new Error(
      'usage: node scripts/vendor-fonts.mjs <site-root> [evidence-json=artifacts/fonts/report.json]',
    );
  }
  const absoluteSiteRoot = resolve(siteRoot);
  const absoluteEvidencePath = resolve(REPO_ROOT, evidencePath || 'artifacts/fonts/report.json');
  return vendorFontsService({ siteRoot: absoluteSiteRoot, evidencePath: absoluteEvidencePath });
}

async function main() {
  const [siteRootArgument, evidenceArgument] = process.argv.slice(2);
  if (!siteRootArgument)
    throw new Error(
      'usage: node scripts/vendor-fonts.mjs <site-root> [evidence-json=artifacts/fonts/report.json]',
    );
  const siteRoot = resolve(siteRootArgument);
  const evidencePath = resolve(REPO_ROOT, evidenceArgument || 'artifacts/fonts/report.json');
  const report = await vendorFonts({ siteRoot, evidencePath });
  console.log(
    JSON.stringify(
      {
        siteRoot: report.siteRoot,
        evidence: relative(REPO_ROOT, evidencePath),
        counts: report.counts,
        bytes: report.bytes,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('font vendoring failed: ' + error.message);
    if (error instanceof AggregateError)
      for (const nested of error.errors) console.error('- ' + nested.message);
    process.exitCode = 1;
  });
}
