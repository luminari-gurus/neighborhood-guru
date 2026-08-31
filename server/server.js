import { resolve } from 'node:path';
import { createAuthBackend } from './auth/backend.js';
import { AUTH_MODES } from './auth/constants.js';
import { createProviderRegistry } from './auth/provider-registry.js';
import { createAppHandler } from './app.js';
export function createServer({config,providers=[],providerRegistry,distDirectory=resolve(process.cwd(),'dist'),port=Number(process.env.PORT||3000),serve=true}={}) { if(!config)throw new TypeError('Server configuration is required'); const registry=providerRegistry||createProviderRegistry(providers); if(config.mode===AUTH_MODES.REQUIRED&&registry.list().length===0)throw new Error('Required authentication needs at least one authentication provider'); const backend=createAuthBackend({config,providerRegistry:registry}); const fetch=createAppHandler({authBackend:backend,config,distDirectory}); const server=serve?Bun.serve({port,fetch}):null; return {fetch,backend,server,close(){server?.stop();backend.close();}}; }
