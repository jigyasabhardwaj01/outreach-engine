import test from 'node:test';
import assert from 'node:assert/strict';
import { authorize, loginResponse, tokenFor, parseCookies, sameSecret } from '../src/auth.js';
import { createApi } from '../src/api.js';
import { NeonStore } from '../src/store-neon.js';
import { createStore, MemoryStore } from '../src/store.js';

const hosted = { VERCEL: '1', APP_PASSWORD: 'hunter2' };
const withCookie = (value) => ({ headers: { cookie: `oe_session=${value}` } });

test('a hosted deployment with no password is closed, not open', () => {
  const result = authorize({ headers: {} }, { VERCEL: '1' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.match(result.error, /no APP_PASSWORD/i);
});

test('locally, with no password, you are let in', () => {
  assert.equal(authorize({ headers: {} }, {}).ok, true);
});

test('hosted, only the right cookie gets in', () => {
  assert.equal(authorize(withCookie(tokenFor('hunter2')), hosted).ok, true);
  assert.equal(authorize(withCookie(tokenFor('guess')), hosted).ok, false);
  assert.equal(authorize({ headers: {} }, hosted).status, 401);
});

test('the cookie is derived from the password, and is not the password', () => {
  const token = tokenFor('hunter2');
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.ok(!token.includes('hunter2'));
  assert.notEqual(token, tokenFor('hunter3'));
});

test('signing in checks the password and sets a locked-down cookie', () => {
  assert.equal(loginResponse('wrong', hosted).status, 401);

  const good = loginResponse('hunter2', hosted);
  assert.equal(good.status, 200);
  const cookie = good.headers['Set-Cookie'];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/, 'hosted means https, so the cookie says so');
  assert.ok(!loginResponse('hunter2', { APP_PASSWORD: 'hunter2' }).headers['Set-Cookie'].includes('Secure'), 'but not on plain-http localhost');
});

test('sameSecret does not leak by length or value', () => {
  assert.ok(sameSecret('abc', 'abc'));
  assert.ok(!sameSecret('abc', 'abcd'));
  assert.ok(!sameSecret('', 'abc'));
});

test('parseCookies copes with spacing, encoding and junk', () => {
  assert.deepEqual(parseCookies('a=1; b=two%20words; flag'), { a: '1', b: 'two words', flag: '' });
  assert.deepEqual(parseCookies(undefined), {});
});

test('the API refuses state and actions to a signed-out visitor', async () => {
  const api = createApi({ actions: { discover: async () => ({ added: 1 }) }, store: new MemoryStore(), settings: hosted });

  assert.equal((await api.state({ headers: {} })).status, 401);
  const blocked = await api.action({ method: 'POST', headers: { origin: 'https://x.vercel.app', host: 'x.vercel.app' }, body: { action: 'discover' } });
  assert.equal(blocked.status, 401, 'a valid origin is not a substitute for being signed in');
});

test('the API serves a signed-in visitor, and still checks the origin', async () => {
  const headers = { cookie: `oe_session=${tokenFor('hunter2')}`, origin: 'https://x.vercel.app', host: 'x.vercel.app' };
  const api = createApi({ actions: { discover: async () => ({ added: 3 }) }, store: new MemoryStore(), settings: hosted });

  assert.equal((await api.state({ headers })).status, 200);
  assert.deepEqual((await api.action({ method: 'POST', headers, body: { action: 'discover' } })).body, { ok: true, added: 3 });

  const crossSite = await api.action({ method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: { action: 'discover' } });
  assert.equal(crossSite.status, 403, 'a stolen cookie still cannot be used from another site');
});

test('the origin is checked against the host the browser saw, behind a proxy', async () => {
  const api = createApi({ actions: {}, store: new MemoryStore(), settings: hosted });
  const headers = {
    cookie: `oe_session=${tokenFor('hunter2')}`,
    origin: 'https://app.vercel.app',
    host: 'internal-lambda.local',
    'x-forwarded-host': 'app.vercel.app',
  };
  assert.notEqual((await api.action({ method: 'POST', headers, body: { action: 'nope' } })).status, 403);
});

test('health says what is missing without being signed in', async () => {
  const api = createApi({ actions: {}, store: new MemoryStore(), settings: { VERCEL: '1' } });
  const { body } = await api.health();

  assert.equal(body.ready, false);
  assert.deepEqual(body.missing, ['DATABASE_URL', 'APP_PASSWORD', 'GEMINI_API_KEY', 'EMAIL_TO']);
  assert.equal(body.database, 'not configured');
});

const fakeNeon = (rows) => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...JSON.parse(options.body), headers: options.headers });
    return { ok: true, status: 200, text: async () => JSON.stringify({ rows }) };
  };
  return { calls, fetchImpl };
};

test('the Postgres store sends parameters, never pasted-in values', async () => {
  const { calls, fetchImpl } = fakeNeon([]);
  const store = new NeonStore({ url: 'postgresql://user:pw@ep-x.neon.tech/neondb', fetchImpl });

  await store.get("acme.com'; drop table companies; --");
  assert.match(calls[0].query, /where domain = \$1/);
  assert.deepEqual(calls[0].params, ["acme.com'; drop table companies; --"]);
  assert.ok(!calls[0].query.includes('drop table'), 'the value never reaches the SQL text');
  assert.equal(calls[0].url, 'https://ep-x.neon.tech/sql');
});

test('the Postgres store round-trips a company through jsonb', async () => {
  const { calls, fetchImpl } = fakeNeon([{ domain: 'acme.com', data: JSON.stringify({ domain: 'acme.com', name: 'Acme' }) }]);
  const store = new NeonStore({ url: 'postgresql://user:pw@ep-x.neon.tech/neondb', fetchImpl });

  assert.deepEqual(await store.all(), { 'acme.com': { domain: 'acme.com', name: 'Acme' } });

  const saved = await store.put({ domain: 'acme.com', name: 'Acme' });
  assert.ok(saved.updatedAt, 'saving stamps the time');
  assert.match(calls[1].query, /on conflict \(domain\) do update/);
  assert.equal(JSON.parse(calls[1].params[1]).name, 'Acme');
});

test('a database error is reported, not swallowed', async () => {
  const store = new NeonStore({
    url: 'postgresql://user:pw@ep-x.neon.tech/neondb',
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'password authentication failed' }),
  });
  await assert.rejects(() => store.all(), /Database 401: password authentication failed/);
});

test('a hosted deployment with no DATABASE_URL refuses to fall back to a file', () => {
  assert.throws(() => createStore({ VERCEL: '1' }), /cannot use the file store/);
  assert.ok(createStore({ DATABASE_URL: 'postgresql://user:pw@ep-x.neon.tech/neondb' }) instanceof NeonStore);
});
