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

// ---------------------------------------------------------------- discovery that cannot time out

test('a discovery sweep is one model call per request', async () => {
  // Six calls back to back, several of them grounded web searches, is minutes
  // of work. Behind a sixty-second serverless limit that is a 504 with
  // nothing to show for it, which is exactly what the hosted copy returned.
  const { discoverStep } = await import('../src/discover.js');
  const { MemoryStore } = await import('../src/store.js');

  const profile = {
    discovery: [{ source: 'Job posts', query: 'a' }, { source: 'Funding', query: 'b' }],
    excludeDomains: [],
  };

  let calls = 0;
  const llm = {
    async ask({ search }) {
      calls++;
      if (search) return { text: 'Acme (acme.com) came up. Northwind (northwind.io) came up.' };
      return { json: { companies: [{ name: 'Acme', domain: 'acme.com' }, { name: 'Northwind', domain: 'northwind.io' }] } };
    },
  };

  const store = new MemoryStore();
  let cursor = {};
  let steps = 0;
  let added = 0;
  for (;;) {
    const before = calls;
    const result = await discoverStep({ profile, llm, store, cursor, limit: 10 });
    assert.equal(calls - before, 1, `step ${steps + 1} made ${calls - before} model calls, not one`);
    added += result.added;
    steps++;
    if (result.done) break;
    cursor = result.cursor;
    assert.ok(steps < 10, 'the sweep did not finish');
  }

  assert.equal(steps, 4, 'two sources, two calls each');
  assert.equal(added, 2, 'the second source found nothing new, because it is the same two companies');
  assert.equal(Object.keys(await store.all()).length, 2);
});

test('a sweep that is interrupted keeps what it already shortlisted', async () => {
  const { discoverStep } = await import('../src/discover.js');
  const { MemoryStore } = await import('../src/store.js');

  const profile = { discovery: [{ source: 'A', query: 'a' }, { source: 'B', query: 'b' }], excludeDomains: [] };
  const llm = {
    async ask({ search }) {
      if (search) return { text: 'Acme (acme.com)' };
      return { json: { companies: [{ name: 'Acme', domain: 'acme.com' }] } };
    },
  };
  const store = new MemoryStore();

  const first = await discoverStep({ profile, llm, store, cursor: {}, limit: 10 });
  const second = await discoverStep({ profile, llm, store, cursor: first.cursor, limit: 10 });

  // Stopping here is what closing the tab does. The company is already saved.
  assert.equal(second.added, 1);
  assert.equal(second.done, false, 'there is a second source still to go');
  assert.ok(await store.has('acme.com'));
});

test('a cursor past the end of the sources is finished, not an error', async () => {
  const { discoverStep } = await import('../src/discover.js');
  const { MemoryStore } = await import('../src/store.js');
  const profile = { discovery: [{ source: 'A', query: 'a' }], excludeDomains: [] };

  const result = await discoverStep({ profile, llm: null, store: new MemoryStore(), cursor: { source: 9 }, limit: 10 });
  assert.deepEqual({ done: result.done, added: result.added }, { done: true, added: 0 });
});

// ---------------------------------------------------------------- adding a company you know

test('a domain you type goes straight on the list, with no model call', async () => {
  const { lookupCompany } = await import('../src/discover.js');
  const { MemoryStore } = await import('../src/store.js');
  const profile = { discovery: [], excludeDomains: ['sprinto.com'] };
  const llm = { ask: async () => assert.fail('a domain needs no looking up') };
  const store = new MemoryStore();

  const result = await lookupCompany({ profile, llm, store, query: 'https://www.acme.com/pricing' });
  assert.equal(result.added, true);
  assert.equal(result.company.domain, 'acme.com', 'the scheme, the www and the path are all stripped');
});

test('a name is looked up, and a company that cannot be found is said so', async () => {
  const { lookupCompany } = await import('../src/discover.js');
  const { MemoryStore } = await import('../src/store.js');
  const profile = { discovery: [], excludeDomains: [] };

  const found = { ask: async () => ({ json: { found: true, name: 'Acme Analytics', domain: 'acme.io', why: 'B2B SaaS' } }) };
  const result = await lookupCompany({ profile, llm: found, store: new MemoryStore(), query: 'Acme Analytics' });
  assert.equal(result.added, true);
  assert.equal(result.company.domain, 'acme.io');
  assert.match(result.company.foundBy, /Acme Analytics/);

  // A model that cannot find it must say so rather than guess: a wrong domain
  // sends a stranger's website to be researched as if it were theirs.
  const missing = { ask: async () => ({ json: { found: false } }) };
  const nothing = await lookupCompany({ profile, llm: missing, store: new MemoryStore(), query: 'A Company That Does Not Exist' });
  assert.equal(nothing.added, false);
  assert.match(nothing.reason, /Could not find/);
});

test('looking up refuses the empty, the excluded and the already-listed', async () => {
  const { lookupCompany } = await import('../src/discover.js');
  const { MemoryStore } = await import('../src/store.js');
  const profile = { discovery: [], excludeDomains: ['sprinto.com'] };
  const llm = { ask: async () => assert.fail('no model call expected') };

  await assert.rejects(() => lookupCompany({ profile, llm, store: new MemoryStore(), query: '   ' }), /name or a domain/);

  const excluded = await lookupCompany({ profile, llm, store: new MemoryStore(), query: 'sprinto.com' });
  assert.equal(excluded.added, false);
  assert.match(excluded.reason, /exclude list/);

  const store = new MemoryStore();
  await lookupCompany({ profile, llm, store, query: 'acme.com' });
  const again = await lookupCompany({ profile, llm, store, query: 'acme.com' });
  assert.equal(again.added, false);
  assert.match(again.reason, /already on the list/);
});

test('a domain the model returns is cleaned up, and nonsense is refused', async () => {
  const { lookupCompany } = await import('../src/discover.js');
  const { MemoryStore } = await import('../src/store.js');
  const profile = { discovery: [], excludeDomains: [] };

  const messy = { ask: async () => ({ json: { found: true, domain: 'https://www.Acme.COM/about' } }) };
  const cleaned = await lookupCompany({ profile, llm: messy, store: new MemoryStore(), query: 'Acme' });
  assert.equal(cleaned.company.domain, 'acme.com');

  const rubbish = { ask: async () => ({ json: { found: true, domain: 'not a domain at all' } }) };
  const refused = await lookupCompany({ profile, llm: rubbish, store: new MemoryStore(), query: 'Acme' });
  assert.equal(refused.added, false);
  assert.match(refused.reason, /not a website address/);
});

// ---------------------------------------------------------------- forgetting

test('every store can forget a company, and says whether it had one', async () => {
  const { MemoryStore, JsonStore } = await import('../src/store.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const memory = new MemoryStore();
  await memory.put({ domain: 'a.com' });
  assert.equal(await memory.remove('a.com'), true);
  assert.equal(await memory.remove('a.com'), false, 'removing it twice is not an error');
  assert.equal(await memory.count(), 0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outreach-'));
  try {
    const file = new JsonStore(path.join(dir, 'c.json'));
    await file.put({ domain: 'a.com' });
    await file.put({ domain: 'b.com' });
    assert.equal(await file.remove('a.com'), true);
    assert.equal(await file.remove('nope.com'), false);
    // It has to survive a reopen, or it was never really removed.
    assert.deepEqual(Object.keys(await new JsonStore(path.join(dir, 'c.json')).all()), ['b.com']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
