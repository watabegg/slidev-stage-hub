import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packPackages } from './pack-cli.mjs';
export const serverPackageNames = [
  'protocol',
  'slidev-adapter',
  'server',
  'adapter-cloudflare',
  'adapter-node',
  'storage-s3',
  'storage-gcs',
  'state-postgres',
];
export function packServer(destination) {
  return packPackages(destination, serverPackageNames);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(JSON.stringify(await packServer(resolve('artifacts/server-package'))));
