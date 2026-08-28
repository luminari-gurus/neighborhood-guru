import { resolve } from 'node:path';
import { loadAuthConfig } from './auth/config.js';
import { createAuthBackend } from './auth/backend.js';
import { createAppHandler } from './app.js';
const config = loadAuthConfig();
const backend = createAuthBackend({ config });
const fetch = createAppHandler({ authBackend: backend, config, distDirectory: resolve(process.cwd(), 'dist') });
const port = Number(process.env.PORT || 3000);
const server = Bun.serve({ port, fetch });
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  server.stop();
  backend.close();
  console.log(`Neighborhood Guru server stopped (${signal})`);
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
console.log(`Neighborhood Guru server listening on http://localhost:${port} (${config.mode} auth)`);
