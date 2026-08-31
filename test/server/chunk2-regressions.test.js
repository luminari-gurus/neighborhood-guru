import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppHandler } from '../../server/app.js';
import { createAuthBackend } from '../../server/auth/backend.js';
import { createProviderRegistry } from '../../server/auth/provider-registry.js';
import { LOGIN_STATE_COOKIE_NAME, SESSION_COOKIE_NAME } from '../../server/auth/constants.js';
import { createServer } from '../../server/server.js';
import { createHttpAuthClient } from '../../src/js/auth/http-auth-client.js';
const roots=[]; afterEach(()=>{ while(roots.length) rmSync(roots.pop(),{recursive:true,force:true}); });
function staticFixture(mode='optional') { const root=mkdtempSync(join(tmpdir(),'ng-static-')); roots.push(root); mkdirSync(join(root,'assets')); writeFileSync(join(root,'index.html'),'<script>globalThis.__NG_RUNTIME_CONFIG__={authMode:"disabled"};</script><main>PROTECTED APP</main>'); writeFileSync(join(root,'assets','app.js'),'PRIVATE ASSET'); const config={mode,secret:'s'.repeat(32),databasePath:':memory:',production:false}; const backend=createAuthBackend({config,providers:[]}); return {root,backend,fetch:createAppHandler({authBackend:backend,config,distDirectory:root})}; }
describe('chunk 2 static and composition regressions',()=>{
 test('contains direct, encoded, and directory symlinks for GET/HEAD and fallback while serving empty files',async()=>{ const app=staticFixture(); const outside=mkdtempSync(join(tmpdir(),'ng-outside-')); roots.push(outside); writeFileSync(join(outside,'secret.txt'),'OUTSIDE SECRET'); symlinkSync(join(outside,'secret.txt'),join(app.root,'assets','escape.txt')); symlinkSync(outside,join(app.root,'escape-dir')); writeFileSync(join(app.root,'assets','empty.txt'),''); for(const method of ['GET','HEAD']) for(const path of ['/assets/escape.txt','/assets/%65scape.txt','/escape-dir/secret.txt']) { const response=await app.fetch(new Request(`https://app.example${path}`,{method,headers:{accept:'text/html'}})); expect(response.status).not.toBe(200); expect(await response.text()).not.toContain('OUTSIDE SECRET'); } expect((await app.fetch(new Request('https://app.example/escape-dir/missing',{headers:{accept:'text/html'}}))).status).not.toBe(200); const empty=await app.fetch(new Request('https://app.example/assets/empty.txt')); expect(empty.status).toBe(200); expect(empty.headers.get('content-length')).toBe('0'); expect(empty.headers.get('cache-control')).toBeTruthy(); const asset=await app.fetch(new Request('https://app.example/assets/app.js')); expect(asset.headers.get('content-length')).toBe(String('PRIVATE ASSET'.length)); expect(asset.headers.get('cache-control')).toBeTruthy(); app.backend.close(); });
 test('required mode rejects no-provider composition and bootstraps fake provider without leaking SPA',async()=>{ const config={mode:'required',secret:'s'.repeat(32),databasePath:':memory:',production:true}; expect(()=>createServer({config,providerRegistry:createProviderRegistry([]),serve:false})).toThrow('at least one authentication provider'); const provider={id:'generic',displayName:'Generic Login',async createAuthorizationUrl(){return 'https://identity.example/login';},async exchangeCallback(){}}; const app=staticFixture('required'); app.backend.close(); const instance=createServer({config,providers:[provider],distDirectory:app.root,serve:false}); const login=await instance.fetch(new Request('https://app.example/')); const html=await login.text(); expect(login.status).toBe(200); expect(html).toContain('/api/auth/providers'); expect(html).toContain('/api/auth/login/'); expect(html).not.toContain('PROTECTED APP'); expect((await instance.fetch(new Request('https://app.example/assets/app.js'))).status).toBe(401); expect(await (await instance.fetch(new Request('https://app.example/api/auth/providers'))).json()).toEqual([{id:'generic',displayName:'Generic Login'}]); instance.backend.database.run('INSERT INTO users (id, display_name, email, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', ['u','User',null,null,1,1]); const session=instance.backend.issueSession('u'); const cookie={cookie:`${SESSION_COOKIE_NAME}=${session.raw}`}; expect(await (await instance.fetch(new Request('https://app.example/',{headers:cookie}))).text()).toContain('PROTECTED APP'); expect(await (await instance.fetch(new Request('https://app.example/route',{headers:{...cookie,accept:'text/html'}}))).text()).toContain('PROTECTED APP'); expect(await (await instance.fetch(new Request('https://app.example/assets/app.js',{headers:cookie}))).text()).toBe('PRIVATE ASSET'); instance.close(); });
  test('required mode recovers stale cookies after secret rotation and preserves callback fail-closed on stale-present logins', async () => {
    const now = 1;
    const dataDir = mkdtempSync(join(tmpdir(), 'ng-required-'));
    roots.push(dataDir);
    const db = join(dataDir, 'auth.sqlite');
    const dbConfig = (secret) => ({ mode: 'required', secret, databasePath: db, production: true });
    const root = mkdtempSync(join(tmpdir(), 'ng-static-required-'));
    roots.push(root);

    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'index.html'), '<script>globalThis.__NG_RUNTIME_CONFIG__={authMode:"disabled"};</script><main>PROTECTED APP</main>');
    writeFileSync(join(root, 'assets', 'app.js'), 'PRIVATE ASSET');

    const staleBackend = createAuthBackend({ config: dbConfig('a'.repeat(32)), providers: [] });
    staleBackend.database.run('INSERT INTO users (id, display_name, email, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', ['u', 'User', null, null, now, now]);
    const stale = staleBackend.issueSession('u');
    staleBackend.close();

    const provider = {
      id: 'generic',
      displayName: 'Generic Login',
      createAuthorizationUrl: async ({ state }) => `https://identity.example/auth?state=${state}`,
      exchangeCallback: async () => ({ identity: { issuer: 'https://id.example', subject: 'subject' }, user: { displayName: 'Ada', email: null, avatarUrl: null }, returnPath: '/map' }),
    };
    const instance = createServer({ config: dbConfig('b'.repeat(32)), providers: [provider], distDirectory: root, serve: false });
    const staleCookie = `${SESSION_COOKIE_NAME}=${stale.raw}`;

    const staleLogin = await instance.fetch(new Request(`https://app.example/api/auth/login/generic?returnPath=%2Fmap`, {
      headers: { cookie: staleCookie },
    }));
    const loginCookies = staleLogin.headers.getSetCookie();
    expect(staleLogin.status).toBe(302);
    expect(loginCookies).toHaveLength(2);

    const staleLoginState = loginCookies.find((value) => value.startsWith(`${LOGIN_STATE_COOKIE_NAME}=`));
    const staleClear = loginCookies.find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`));
    expect(staleLoginState).toBeDefined();
    expect(staleClear).toContain('Max-Age=0');

    const state = staleLoginState.match(new RegExp(`${LOGIN_STATE_COOKIE_NAME}=([^;]+)`))?.[1];
    expect(state).toBeString();
    expect((await instance.fetch(new Request(`https://app.example/api/auth/callback/generic?state=${state}`, {
      headers: { cookie: `${staleCookie}; ${LOGIN_STATE_COOKIE_NAME}=${state}` },
    }))).status).toBe(400);

    const freshLogin = await instance.fetch(new Request(`https://app.example/api/auth/login/generic?returnPath=%2Fmap`, {
      headers: { cookie: staleCookie },
    }));
    const freshCookies = freshLogin.headers.getSetCookie();
    const freshState = freshCookies.find((value) => value.startsWith(`${LOGIN_STATE_COOKIE_NAME}=`));
    const freshStateValue = freshState.match(new RegExp(`${LOGIN_STATE_COOKIE_NAME}=([^;]+)`))?.[1];
    const callback = await instance.fetch(new Request(`https://app.example/api/auth/callback/generic?state=${freshStateValue}`, {
      headers: { cookie: `${LOGIN_STATE_COOKIE_NAME}=${freshStateValue}` },
    }));
    expect(callback.status).toBe(302);

    const callbackCookies = callback.headers.getSetCookie();
    const sessionCookie = callbackCookies.find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`))?.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`))?.[1];
    expect(sessionCookie).toBeString();
    const protectedAppResponse = await instance.fetch(new Request('https://app.example/', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` },
    }));
    expect(await protectedAppResponse.text()).toContain('PROTECTED APP');
    const sessionCheck = await instance.fetch(new Request('https://app.example/api/auth/session', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` },
    }));
    expect(sessionCheck.status).toBe(200);

    instance.close();
  });
});
describe('chunk 2 HTTP client contract',()=>{
 test('preserves safe location, publishes normalized sessions, isolates listeners, and unsubscribes idempotently',async()=>{ const calls=[],events=[]; const location={pathname:'/map',search:'?q=coffee',hash:'#card',assign(value){calls.push(value);}}; const session={user:{id:'u',displayName:'User',email:null,avatarUrl:null},expiresAt:'2030-01-01T00:00:00.000Z',csrfToken:'csrf',ignored:true}; const request=async(url)=>url.endsWith('session')?Response.json(session):Response.json({ok:true}); const client=createHttpAuthClient({fetch:request,location}); client.subscribe(()=>{throw new Error('listener failed');}); const unsubscribe=client.subscribe(value=>events.push(value)); expect(await client.loadSession()).toEqual({user:session.user,expiresAt:session.expiresAt}); expect(await client.refreshSession()).toEqual({user:session.user,expiresAt:session.expiresAt}); await client.signIn({providerId:'generic'}); expect(calls[0]).toContain('returnPath=%2Fmap%3Fq%3Dcoffee%23card'); await client.signIn({providerId:'generic',returnPath:'https://evil.example/'}); expect(calls[1]).toContain('returnPath=%2F'); unsubscribe(); unsubscribe(); await client.signOut(); expect(events).toHaveLength(2); });
 test('returns normalized redacted errors',async()=>{ const client=createHttpAuthClient({fetch:async()=>Response.json({error:{code:'safe_code',detail:'secret'}},{status:500})}); try { await client.loadSession(); throw new Error('expected rejection'); } catch(error) { expect(error.message).toBe('safe_code'); expect(error.message).not.toContain('secret'); } });
});
