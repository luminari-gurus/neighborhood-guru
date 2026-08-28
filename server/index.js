import { loadAuthConfig } from './auth/config.js';
import { createAuthBackend } from './auth/backend.js';
const config = loadAuthConfig();
const backend = createAuthBackend({ config });
const port = Number(process.env.PORT || 3000);
Bun.serve({ port, fetch: backend.fetch });
console.log(`Neighborhood Guru auth server listening on http://localhost:${port}`);
