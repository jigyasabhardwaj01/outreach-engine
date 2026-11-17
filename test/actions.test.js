import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createActions } from '../src/actions.js';
import { createServer, isSameOrigin } from '../src/server.js';
import { Researcher } from '../src/research.js';
import { MemoryStore } from '../src/store.js';
import { FakeLlm, fakeWeb, testProfile } from './helpers.js';

const profile = testProfile();

const researched = {
  domain: 'acme.com',
  name: 'Acme',
  status: 'researched',
  decision: null,
  answers: { saas: 'b2b_saas', employees: 84, preparing: 'yes' },
  details: {
    preparing: {
      label: 'Preparing for an audit',
      answer: 'yes',
      evidence: { kind: 'page', url: 'https://acme.com/careers', sourceDate: null, quote: 'hiring our first compliance lead' },
    },
  },
  verdict: { kind: 'qualify', code: 'preparing_for_audit', reason: 'Hiring a compliance lead.', notes: [] },
};

const settings = { EMAIL_TO: 'me@mine.com', EMAIL_FROM: 'bot@mine.com', RESEND_API_KEY: 'k', HUNTER_API_KEY: 'h', PORT: 0 };

test('rejecting a company stops there, and never looks anyone up', async () => {
  const store = new MemoryStore({ 'acme.com': researched });
  const llm = new FakeLlm(() => {
    throw new Error('the model should not be asked anything');
  });
  const actions = createActions({ profile, llm, store, settings });

  const saved = await actions.decide({ domain: 'acme.com', decision: 'reject' });
  assert.equal(saved.status, 'rejected');
  assert.equal(saved.decision, 'rejected');
  assert.equal(llm.requests.length, 0);
});

test('an unknown company is an error, not a silent no-op', async () => {
  const actions = createActions({ profile, llm: new FakeLlm(() => ({})), store: new MemoryStore(), settings });
  await assert.rejects(() => actions.decide({ domain: 'nope.com', decision: 'approve' }), /No such company/);
});

test('a decision has to be approve or reject', async () => {
  const actions = createActions({ profile, llm: new FakeLlm(() => ({})), store: new MemoryStore({ 'acme.com': researched }), settings });
  await assert.rejects(() => actions.decide({ domain: 'acme.com', decision: 'maybe' }), /"approve" or "reject"/);
});

test('researchStep reports the next question, then that it is done', async () => {
  const store = new MemoryStore({ 'acme.com': { domain: 'acme.com', name: 'Acme', status: 'shortlisted' } });
  const llm = new FakeLlm(() => ({ json: { answer: 'not_b2b_saas', sufficient: true, evidence_quote: 'a consumer photo app' } }));
  const researcher = new Researcher({ profile, llm, store, fetchPage: fakeWeb({ 'https://acme.com/': 'Acme is a consumer photo app.' }) });
  const actions = createActions({ profile, llm, store, settings, researcher });

  const first = await actions.researchStep({ domain: 'acme.com' });
  assert.equal(first.done, true, 'one disqualifying answer finishes the assessment');
  assert.equal(first.verdict.code, 'not_saas');

  assert.deepEqual(await actions.researchStep({ domain: 'acme.com' }), { done: true }, 'a finished company stays finished');
});

test('researching again clears the old verdict so it cannot be mistaken for fresh', async () => {
  const store = new MemoryStore({ 'acme.com': researched });
  const actions = createActions({ profile, llm: new FakeLlm(() => ({})), store, settings });

  const saved = await actions.researchAgain({ domain: 'acme.com' });
  assert.equal(saved.status, 'researching');
  assert.equal(saved.verdict, undefined);
  assert.equal(saved.answers, undefined);
});

test('only our own page may post actions', () => {
  const req = (origin, host = 'localhost:3000') => ({ headers: { ...(origin ? { origin } : {}), ...(host ? { host } : {}) } });
  assert.ok(isSameOrigin(req('http://localhost:3000')));
  assert.ok(isSameOrigin(req('http://127.0.0.1:3000', '127.0.0.1:3000')));
  assert.ok(!isSameOrigin(req('https://evil.example')));
  assert.ok(!isSameOrigin(req('http://localhost:9999')), 'a different port is a different origin');
  assert.ok(!isSameOrigin(req(null)), 'no origin header at all');
  assert.ok(!isSameOrigin(req('http://localhost:3000', null)), 'no host header either');
});

async function withServer(options, run) {
  const server = createServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base, server.address().port);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('the API serves state and refuses a cross-site action', async () => {
  const store = new MemoryStore({ 'acme.com': researched });
  const actions = createActions({ profile, llm: new FakeLlm(() => ({})), store, settings });

  await withServer({ actions, store, settings }, async (base, port) => {
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.emailTo, 'me@mine.com');
    assert.equal(state.reviewMode, true);
    assert.ok(state.companies['acme.com']);

    const foreign = await fetch(`${base}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ action: 'decide', domain: 'acme.com', decision: 'reject' }),
    });
    assert.equal(foreign.status, 403);
    assert.equal((await store.get('acme.com')).status, 'researched', 'nothing happened');

    const ours = await fetch(`${base}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ action: 'decide', domain: 'acme.com', decision: 'reject' }),
    });
    assert.equal(ours.status, 200);
    assert.equal((await store.get('acme.com')).status, 'rejected');
  });
});

test('the API rejects an unknown action and reports a failure as an error', async () => {
  const store = new MemoryStore();
  const actions = createActions({ profile, llm: new FakeLlm(() => ({})), store, settings });

  await withServer({ actions, store, settings }, async (base, port) => {
    const post = (body) =>
      fetch(`${base}/api/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` },
        body: JSON.stringify(body),
      });

    assert.equal((await post({ action: 'drop_everything' })).status, 400);

    const failed = await post({ action: 'decide', domain: 'ghost.com', decision: 'approve' });
    assert.equal(failed.status, 500);
    assert.match((await failed.json()).error, /No such company/);

    assert.equal((await fetch(`${base}/api/action`)).status, 405, 'GET is not how actions happen');
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});
