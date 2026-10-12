import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprintOfflineSite as fingerprintOfflineSiteService } from '../dist/node/internal/fingerprint-offline.mjs';

export async function fingerprintOfflineSite(siteRoot) {
  return fingerprintOfflineSiteService(resolve(siteRoot));
}

async function main() {
  const [siteRoot] = process.argv.slice(2);
  if (!siteRoot) throw new Error('usage: node scripts/fingerprint-offline.mjs <site-root>');
  console.log(JSON.stringify(await fingerprintOfflineSite(siteRoot), null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
