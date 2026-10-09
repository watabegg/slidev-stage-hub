import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateThumbnails as generateThumbnailsService } from '../dist/node/internal/thumbnails.mjs';

export async function generateThumbnails({ siteRoot, ...options } = {}) {
  const chromiumExecutable = options.chromiumExecutable || process.env.CHROMIUM_EXECUTABLE;
  const serviceOptions = { ...options };
  if (siteRoot) serviceOptions.siteRoot = resolve(siteRoot);
  else serviceOptions.siteRoot = siteRoot;
  if (chromiumExecutable) serviceOptions.chromiumExecutable = resolve(chromiumExecutable);
  else delete serviceOptions.chromiumExecutable;
  return generateThumbnailsService(serviceOptions);
}

async function main() {
  const [siteRootArgument, ...extraArguments] = process.argv.slice(2);
  if (!siteRootArgument || extraArguments.length)
    throw new Error('usage: node scripts/thumbnails.mjs <site-root>');
  const thumbnails = await generateThumbnails({ siteRoot: siteRootArgument });
  console.log(JSON.stringify(thumbnails, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
