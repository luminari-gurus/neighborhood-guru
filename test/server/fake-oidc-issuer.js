const encoder = new TextEncoder();

export async function generateRs256KeyPair(kid = 'test-key') {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    privateKey: pair.privateKey,
    publicJwk: { ...publicJwk, kid, use: 'sig', alg: 'RS256' },
  };
}

export async function signJwt(privateKey, header, payload) {
  const signingInput = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  const signature = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, privateKey, encoder.encode(signingInput));
  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
}

async function s256(value) {
  return Buffer.from(await crypto.subtle.digest('SHA-256', encoder.encode(value))).toString('base64url');
}

function randomToken(randomBytes, length = 32) {
  return Buffer.from(randomBytes(length)).toString('base64url');
}

export async function createFakeOidcIssuer(options = {}) {
  const origin = options.origin || 'https://issuer.example';
  const clientId = options.clientId || 'test-client';
  const clock = options.clock || (() => Date.now());
  const randomBytes = options.randomBytes || ((length) => crypto.getRandomValues(new Uint8Array(length)));
  let signing = options.keys || await generateRs256KeyPair('test-key');
  const retiredKeys = [];
  const codes = new Map();
  let nextAuthorizeError = null;
  let nextTokenMutator = null;
  let publishSigningKey = true;
  let metadataOverride = null;

  const metadata = Object.freeze({
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    jwks_uri: `${origin}/jwks`,
    response_types_supported: Object.freeze(['code']),
    subject_types_supported: Object.freeze(['public']),
    id_token_signing_alg_values_supported: Object.freeze(['RS256']),
    code_challenge_methods_supported: Object.freeze(['S256']),
    scopes_supported: Object.freeze(['openid', 'profile', 'email']),
  });

  async function handle(input, init = {}) {
    const url = new URL(input);
    if (url.origin !== origin) throw new Error(`Fake OIDC issuer received unexpected origin ${url.origin}`);
    const method = String(init.method || 'GET').toUpperCase();

    if (url.pathname === '/.well-known/openid-configuration' && method === 'GET') {
      return Response.json(metadataOverride || metadata);
    }

    if (url.pathname === '/jwks' && method === 'GET') {
      const keys = [];
      if (publishSigningKey) keys.push(signing.publicJwk);
      keys.push(...retiredKeys.map((key) => key.publicJwk));
      return Response.json({ keys });
    }

    if (url.pathname === '/authorize' && method === 'GET') {
      const redirectUri = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state') || '';
      if (!redirectUri) return new Response('missing redirect_uri', { status: 400 });
      const redirect = new URL(redirectUri);
      if (nextAuthorizeError) {
        const error = nextAuthorizeError;
        nextAuthorizeError = null;
        redirect.searchParams.set('error', error);
        if (state) redirect.searchParams.set('state', state);
        return new Response(null, { status: 302, headers: { location: redirect.href } });
      }
      const code = randomToken(randomBytes);
      codes.set(code, {
        nonce: url.searchParams.get('nonce'),
        codeChallenge: url.searchParams.get('code_challenge'),
        codeChallengeMethod: url.searchParams.get('code_challenge_method'),
        redirectUri,
        clientId: url.searchParams.get('client_id'),
        consumed: false,
      });
      redirect.searchParams.set('code', code);
      if (state) redirect.searchParams.set('state', state);
      return new Response(null, { status: 302, headers: { location: redirect.href } });
    }

    if (url.pathname === '/token' && method === 'POST') {
      const raw = typeof init.body === 'string' ? init.body : init.body == null ? '' : String(init.body);
      const form = new URLSearchParams(raw);
      const record = codes.get(form.get('code'));
      if (!record || record.consumed) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      if (form.get('grant_type') !== 'authorization_code') return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
      if (form.get('redirect_uri') !== record.redirectUri || form.get('client_id') !== record.clientId) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      if (record.codeChallengeMethod !== 'S256' || await s256(form.get('code_verifier') || '') !== record.codeChallenge) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      record.consumed = true;

      const now = Math.floor(clock() / 1000);
      let header = { alg: 'RS256', typ: 'JWT', kid: signing.publicJwk.kid };
      let payload = {
        iss: origin,
        sub: options.subject || 'subject-1',
        aud: clientId,
        exp: now + 300,
        iat: now,
        nonce: record.nonce,
        name: 'Ada Lovelace',
        email: 'ada@example.test',
      };
      const mutated = nextTokenMutator ? nextTokenMutator({ header, payload, record }) : null;
      nextTokenMutator = null;
      if (mutated?.header) header = mutated.header;
      if (mutated?.payload) payload = mutated.payload;
      let idToken = mutated?.idToken || await signJwt(signing.privateKey, header, payload);
      if (mutated?.corruptSignature) idToken = `${idToken.slice(0, -8)}aaaaaaaa`;

      return Response.json({
        token_type: 'Bearer',
        expires_in: 300,
        id_token: idToken,
        access_token: 'provider-access-token-must-not-leak',
        refresh_token: 'provider-refresh-token-must-not-leak',
      });
    }

    return new Response('Not found', { status: 404 });
  }

  return {
    origin,
    issuer: origin,
    clientId,
    metadata,
    codes,
    fetch: (input, init) => handle(input, init),
    cancelNextAuthorize(error = 'access_denied') {
      nextAuthorizeError = error;
    },
    mutateNextIdToken(mutator) {
      nextTokenMutator = mutator;
    },
    async rotateKeys(next) {
      retiredKeys.push(signing);
      signing = next || await generateRs256KeyPair(`rotated-${retiredKeys.length}`);
    },
    hideSigningKey(hide = true) {
      publishSigningKey = !hide;
    },
    setMetadata(document) {
      metadataOverride = document;
    },
    get publicJwk() {
      return signing.publicJwk;
    },
  };
}
