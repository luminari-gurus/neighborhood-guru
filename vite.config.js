import { defineConfig, loadEnv } from 'vite';
import { RUNTIME_MARKER } from './server/app.js';

const ENABLED_AUTH_MODES = new Set(['optional', 'required']);

export function injectDevRuntimeConfig(html, authMode) {
  if (!ENABLED_AUTH_MODES.has(authMode)) return html;
  return html.replace(RUNTIME_MARKER, `globalThis.__NG_RUNTIME_CONFIG__=${JSON.stringify({ authMode })};`);
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const authMode = ENABLED_AUTH_MODES.has(env.AUTH_MODE) ? env.AUTH_MODE : 'disabled';
  return {
    plugins: command === 'serve' ? [{
      name: 'ng-runtime-config',
      transformIndexHtml(html) {
        return injectDevRuntimeConfig(html, authMode);
      },
    }] : [],
    server: {
      proxy: {
        '/api/auth': { target: env.AUTH_DEV_SERVER || 'http://localhost:3000', changeOrigin: true },
        '/api-jambase': {
          target: 'https://www.jambase.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api-jambase/, ''),
        },
      },
    },
  };
});
