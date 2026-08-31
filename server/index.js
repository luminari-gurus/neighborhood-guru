import { loadAuthConfig } from './auth/config.js';
import { createServer } from './server.js';
const config=loadAuthConfig();
const instance=createServer({config});
let stopping=false;function shutdown(signal){if(stopping)return;stopping=true;instance.close();console.log(`Neighborhood Guru server stopped (${signal})`);}process.once('SIGINT',()=>shutdown('SIGINT'));process.once('SIGTERM',()=>shutdown('SIGTERM'));console.log(`Neighborhood Guru server listening on http://localhost:${instance.server.port} (${config.mode} auth)`);
