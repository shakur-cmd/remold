import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sdkRequire = createRequire(require.resolve('@workos-inc/authkit-react'));
const { createClient } = sdkRequire('@workos-inc/authkit-js');

function browser(url) {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const location = new URL(url);
  globalThis.window = { location, origin: location.origin, localStorage: storage, sessionStorage: storage, history: { replaceState: (_state, _title, next) => { window.location = new URL(next, location.origin); } } };
  globalThis.document = { cookie: '' };
  globalThis.sessionStorage = storage;
  return values;
}

test('installed SDK builds the configured PKCE callback and preserves invite state', async t => {
  const originals = { window: globalThis.window, document: globalThis.document, sessionStorage: globalThis.sessionStorage, fetch: globalThis.fetch };
  t.after(() => Object.assign(globalThis, originals));
  const stored = browser('http://localhost:5173/invite/synthetic-invite');
  globalThis.fetch = () => { throw new Error('This SDK contract check must not call a provider'); };
  const client = await createClient('client_synthetic', { redirectUri: 'http://localhost:5173/callback', devMode: true });
  t.after(() => client.dispose());
  const url = new URL(await client.getSignInUrl({ state: { returnTo: '/invite/synthetic-invite' } }));
  assert.equal(url.origin, 'https://api.workos.com');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:5173/callback');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge'));
  assert.deepEqual(JSON.parse(url.searchParams.get('state')), { returnTo: '/invite/synthetic-invite' });
  assert.ok(stored.size > 0);
});

test('installed SDK refuses unsolicited callback without a PKCE verifier', async t => {
  const originals = { window: globalThis.window, document: globalThis.document, sessionStorage: globalThis.sessionStorage, fetch: globalThis.fetch };
  t.after(() => Object.assign(globalThis, originals));
  browser('http://localhost:5173/callback?code=synthetic-unsolicited&state=not-json');
  let callbacks = 0, requests = 0;
  globalThis.fetch = () => { requests++; throw new Error('No token exchange is allowed'); };
  const client = await createClient('client_synthetic', { redirectUri: 'http://localhost:5173/callback', devMode: true, onRedirectCallback: () => { callbacks++; } });
  t.after(() => client.dispose());
  assert.equal(client.getUser(), null);
  assert.equal(callbacks, 0);
  assert.equal(requests, 0);
  assert.equal(window.location.search, '');
});
