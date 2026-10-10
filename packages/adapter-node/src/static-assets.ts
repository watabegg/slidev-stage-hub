import { realpath, readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

const mimeTypes: Record<string, string> = {
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const privateDirectories = new Set(['.git', '_private', 'private', 'source', 'sources', 'src']);
const sourceExtensions = new Set([
  '.md',
  '.mdx',
  '.map',
  '.rs',
  '.sass',
  '.scss',
  '.sh',
  '.toml',
  '.ts',
  '.tsx',
  '.vue',
  '.yaml',
  '.yml',
]);

function isPrivateRuntimePath(path: string): boolean {
  const segments = path.split(sep).filter(Boolean);
  return (
    segments.some((part) => privateDirectories.has(part.toLowerCase())) ||
    sourceExtensions.has(extname(path).toLowerCase())
  );
}

function notFound(): Response {
  return new Response('Not Found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

export function createStaticAssets({ root }: { root: string }): {
  fetch(request: Request): Promise<Response>;
} {
  const rootPromise = realpath(resolve(root));

  async function fileResponse(path: string, method: string): Promise<Response | null> {
    try {
      const rootPath = await rootPromise;
      const actualPath = await realpath(path);
      const rel = relative(rootPath, actualPath);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
      if (isPrivateRuntimePath(rel)) return null;
      const info = await stat(actualPath);
      if (!info.isFile()) return null;
      const bytes = method === 'HEAD' ? null : await readFile(actualPath);
      return new Response(bytes, {
        headers: {
          'content-type':
            mimeTypes[extname(actualPath).toLowerCase()] ?? 'application/octet-stream',
          'content-length': String(info.size),
        },
      });
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' ||
        (error as NodeJS.ErrnoException).code === 'ENOTDIR'
      )
        return null;
      throw error;
    }
  }

  return {
    async fetch(request) {
      if (request.method !== 'GET' && request.method !== 'HEAD')
        return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
      let pathname: string;
      try {
        pathname = decodeURIComponent(new URL(request.url).pathname);
      } catch {
        return notFound();
      }
      if (pathname.includes('\0') || pathname.includes('\\')) return notFound();
      const segments = pathname.split('/').filter(Boolean);
      if (segments.some((part) => part === '.' || part === '..')) return notFound();
      if (isPrivateRuntimePath(pathname)) return notFound();
      const reserved =
        pathname === '/api' ||
        pathname.startsWith('/api/') ||
        pathname === '/releases' ||
        pathname.startsWith('/releases/');
      if (reserved) return notFound();
      const rootPath = await rootPromise;
      let requestedPath = resolve(rootPath, `.${pathname}`);
      if (requestedPath !== rootPath && !requestedPath.startsWith(`${rootPath}${sep}`))
        return notFound();
      if (pathname.endsWith('/')) requestedPath = resolve(requestedPath, 'index.html');
      const direct = await fileResponse(requestedPath, request.method);
      if (direct) return direct;

      const hasExtension = extname(pathname) !== '';
      const acceptsDocument = request.headers.get('accept')?.includes('text/html') ?? false;
      if (hasExtension || !acceptsDocument) return notFound();
      return (await fileResponse(resolve(rootPath, 'index.html'), request.method)) ?? notFound();
    },
  };
}
