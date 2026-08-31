import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppHandler } from '../../server/app.js';
import { createAuthBackend } from '../../server/auth/backend.js';
import { createAnonymousAuthClient, createHttpAuthClient } from '../../src/js/auth/index.js';

const roots = [];
function fixture(mode = 'optional') {
  const root = mkdtempSync(join(tmpdir(), 'ng-static-')); roots.push(root); mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<script>globalThis.__NG_RUNTIME_CONFIG__={authMode:"disabled"};</script><main>app</main>'); writeFileSync(join(root, 'assets', 'app.js'), 'export default 1');
  const config = { mode, secret: 's'.repeat(32), databasePath: ':memory:', production: false };
  const backend = createAuthBackend({ config, providers: [] });
  return { backend, fetch: createAppHandler({ authBackend: backend, config, distDirectory: root }) };
}
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

describe('same-origin app and HTTP AuthClient', () => {
  test('optional mode serves injected SPA, static assets, fallback, and auth API', async () => {
    const app = fixture();
    expect(await (await app.fetch(new Request('https://app.example/'))).text()).toContain('{"authMode":"optional"}');
    expect((await app.fetch(new Request('https://app.example/assets/app.js'))).status).toBe(200);
    expect((await app.fetch(new Request('https://app.example/map', { headers: { accept: 'text/html' } }))).status).toBe(200);
    expect(await (await app.fetch(new Request('https://app.example/api/auth/providers'))).json()).toEqual([]);
    expect((await app.fetch(new Request('https://app.example/%2e%2e/secret.js'))).status).not.toBe(200);
    app.backend.close();
  });
  test('required mode serves the generic bootstrap and does not invent providers', async () => {
    const app = fixture('required');
    const response = await app.fetch(new Request('https://app.example/'));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('/api/auth/providers');
    expect(await (await app.fetch(new Request('https://app.example/api/auth/providers'))).json()).toEqual([]);
    app.backend.close();
  });
  test('HTTP client uses same-origin endpoints and disabled client makes zero requests', async () => {
    const calls = []; const location = { pathname: '/map', assign(value) { calls.push(['location', value]); } };
    const request = async (url, init) => { calls.push([url, init]); if (url.endsWith('providers')) return Response.json([{ id: 'generic', displayName: 'Generic' }]); if (url.endsWith('session')) return Response.json(null); return Response.json({ ok: true }); };
    const client = createHttpAuthClient({ fetch: request, location });
    expect(await client.discoverProviders()).toEqual([{ id: 'generic', displayName: 'Generic' }]); expect(await client.loadSession()).toBeNull(); await client.signIn({ providerId: 'generic' });
    expect(calls[0][0]).toBe('/api/auth/providers'); expect(calls[1][0]).toBe('/api/auth/session'); expect(calls[2][1]).toContain('/api/auth/login/generic');
  });
  test('anonymous disabled build client performs zero auth requests', async () => {
    let calls = 0; const original = globalThis.fetch; globalThis.fetch = async () => { calls += 1; throw new Error('network'); };
    try { const client = createAnonymousAuthClient(); await client.discoverProviders(); await client.loadSession(); expect(calls).toBe(0); } finally { globalThis.fetch = original; }
  });
});
