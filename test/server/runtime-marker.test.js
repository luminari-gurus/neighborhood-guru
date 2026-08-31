import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { RUNTIME_MARKER } from '../../server/app.js';
import { injectDevRuntimeConfig } from '../../vite.config.js';

const root = resolve(import.meta.dir, '../..');

describe('SPA runtime config marker', () => {
  test('source index.html contains the exact server replacement marker', async () => {
    const html = await Bun.file(resolve(root, 'index.html')).text();
    expect(html).toContain(RUNTIME_MARKER);
  });

  test('Vite injects only authMode for enabled modes and keeps the static default otherwise', () => {
    const html = `<script>${RUNTIME_MARKER}</script>`;
    expect(injectDevRuntimeConfig(html, 'disabled')).toBe(html);
    expect(injectDevRuntimeConfig(html, undefined)).toBe(html);
    expect(injectDevRuntimeConfig(html, 'optional')).toBe(`<script>globalThis.__NG_RUNTIME_CONFIG__=${JSON.stringify({ authMode: 'optional' })};</script>`);
    expect(injectDevRuntimeConfig(html, 'required')).toContain('{"authMode":"required"}');
    expect(injectDevRuntimeConfig(html, 'optional')).not.toContain('AUTH_SECRET');
    expect(injectDevRuntimeConfig(html, 'optional')).not.toContain('sqlite');
  });

  test('bun run build leaves the exact server replacement marker in dist/index.html', async () => {
    const proc = Bun.spawn(['bun', 'run', 'build'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    expect(await proc.exited).toBe(0);
    const html = await Bun.file(resolve(root, 'dist/index.html')).text();
    expect(html).toContain(RUNTIME_MARKER);
  }, 60_000);
});
