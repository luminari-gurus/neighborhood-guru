import { resolve, sep } from 'node:path';
import { AUTH_MODES } from './auth/constants.js';

const RUNTIME_MARKER = 'globalThis.__NG_RUNTIME_CONFIG__={authMode:"disabled"};';
const TYPES = Object.freeze({ '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' });
function extension(path) { const dot = path.lastIndexOf('.'); return dot < 0 ? '' : path.slice(dot).toLowerCase(); }
function safePath(root, pathname) {
  let decoded; try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const target = resolve(root, `.${decoded}`);
  return target === root || target.startsWith(`${root}${sep}`) ? target : null;
}
async function serveIndex(root, mode) {
  const file = Bun.file(resolve(root, 'index.html')); if (!await file.exists()) return new Response('Build output is missing', { status: 503 });
  const source = await file.text();
  const runtime = `globalThis.__NG_RUNTIME_CONFIG__=${JSON.stringify({ authMode: mode })};`;
  return new Response(source.replace(RUNTIME_MARKER, runtime), { headers: { 'content-type': TYPES['.html'], 'cache-control': 'no-cache' } });
}
export function createAppHandler({ authBackend, config, distDirectory = resolve(process.cwd(), 'dist') }) {
  const root = resolve(distDirectory);
  return async function fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/auth/')) return authBackend.fetch(request);
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Not found', { status: 404 });
    if (config.mode === AUTH_MODES.REQUIRED) {
      const sessionRequest = new Request(new URL('/api/auth/session', url), { headers: { cookie: request.headers.get('cookie') || '' } });
      const session = await authBackend.fetch(sessionRequest);
      if (!session.ok) return Response.json({ error: { code: 'authentication_required' } }, { status: 401, headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/') return serveIndex(root, config.mode);
    const target = safePath(root, url.pathname); if (!target) return new Response('Bad request', { status: 400 });
    const file = Bun.file(target);
    if (await file.exists() && file.size > 0) return new Response(request.method === 'HEAD' ? null : file, { headers: { 'content-type': TYPES[extension(target)] || 'application/octet-stream' } });
    if (!extension(url.pathname) && (request.headers.get('accept') || '').includes('text/html')) return serveIndex(root, config.mode);
    return new Response('Not found', { status: 404 });
  };
}
