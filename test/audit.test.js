// Regressions found in a full read of the codebase. Each test here names a
// bug that was real: the behaviour it asserts is the behaviour that was wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { sendSmtp, deliver } from '../src/mailer.js';
import { createPoliteFetcher, isPrivateAddress, resolvesPublicly, fetchPage, resolveRedirect } from '../src/web.js';
import { citationFor } from '../src/llm.js';
import { draftEmail } from '../src/draft.js';
import { MemoryStore } from '../src/store.js';
import { isAllowed } from '../src/robots.js';
import { SourceSet } from '../src/sources.js';
import { runSummary } from '../public/view.js';
import profile from '../profiles/compliance-saas.js';

// ---------------------------------------------------------------- the mailer

/** A socket that gets as far as the greeting and then has something happen to it. */
function flakyServer(afterGreeting) {
  const socket = new EventEmitter();
  socket.setEncoding = () => {};
  socket.end = () => { socket.ended = true; };
  socket.write = () => true;
  setImmediate(() => {
    socket.emit('data', '220 ready\r\n');
    setImmediate(() => afterGreeting(socket));
  });
  return socket;
}

test('a socket error mid-conversation fails the send instead of taking the process down', async () => {
  // Without a listener for it, Node treats "error" on a socket as unhandled
  // and ends the process. On a serverless host that is an unexplained 500.
  const connectImpl = async () => flakyServer((socket) => socket.emit('error', new Error('ECONNRESET')));

  await assert.rejects(
    () => sendSmtp({ host: 'smtp.example', user: 'u', pass: 'p', from: 'a@b.c', to: 'a@b.c', subject: 's', body: 'b', connectImpl }),
    /connection to the mail server failed.*ECONNRESET/i,
  );
});

test('a mail server that hangs up is reported at once, not after the timeout', async () => {
  const connectImpl = async () => flakyServer((socket) => socket.emit('close'));

  const started = Date.now();
  await assert.rejects(
    () => sendSmtp({ host: 'smtp.example', user: 'u', pass: 'p', from: 'a@b.c', to: 'a@b.c', subject: 's', body: 'b', connectImpl, timeoutMs: 20000 }),
    /closed the connection/i,
  );
  assert.ok(Date.now() - started < 2000, 'it did not sit and wait for the full timeout');
});

test('two sends carry different idempotency keys, even with the same subject', async () => {
  // Every email in this project goes to the same address, so keying on
  // recipient and subject made two companies look like one retry — and the
  // second was silently never sent.
  const keys = [];
  const fetchImpl = async (url, options) => {
    keys.push(options.headers['Idempotency-Key']);
    return { ok: true, json: async () => ({ id: 'resend-id' }) };
  };
  const settings = { RESEND_API_KEY: 'k', EMAIL_FROM: 'me@example.com' };
  const once = () => deliver({ settings, to: 'me@example.com', subject: 'Quick question', body: 'Hi', fetchImpl });

  await once();
  await once();
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1], 'the second send is a send, not a replay of the first');
});

// ---------------------------------------------------------------- polite fetching

test("one host's crawl delay does not slow down every other host", async () => {
  // A single site asking for "Crawl-delay: 30" used to raise the gap for the
  // whole run, which quietly blows the two-minute-per-company target for
  // companies that never asked for anything.
  const slept = [];
  const robots = {
    check: async (url) => ({ allowed: true, crawlDelay: new URL(url).host === 'slow.example' ? 30 : null }),
  };
  const polite = createPoliteFetcher({
    robots,
    minGapMs: 10,
    fetchPage: async (url) => ({ status: 'ok', url }),
    sleepImpl: async (ms) => slept.push(ms),
  });

  await polite('https://slow.example/a');
  await polite('https://slow.example/b');
  const afterSlowHost = slept.length;

  await polite('https://fast.example/a');
  await polite('https://fast.example/b');

  assert.ok(slept.slice(0, afterSlowHost).some((ms) => ms > 1000), 'the slow host got its long gap');
  assert.ok(slept.slice(afterSlowHost).every((ms) => ms <= 10), 'the fast host kept the ordinary one');
});

test('the crawl delay a site asks for is capped, so one site cannot stall the run', async () => {
  const slept = [];
  const robots = { check: async () => ({ allowed: true, crawlDelay: 3600 }) };
  const polite = createPoliteFetcher({
    robots,
    minGapMs: 10,
    maxGapMs: 5000,
    fetchPage: async (url) => ({ status: 'ok', url }),
    sleepImpl: async (ms) => slept.push(ms),
  });

  await polite('https://slow.example/a');
  await polite('https://slow.example/b');
  assert.ok(slept.every((ms) => ms <= 5000), `waited ${slept} ms, which is over the cap`);
});

// ---------------------------------------------------------------- where a name points

test('isPrivateAddress knows the ranges that are inside the network', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.0.1', '172.31.255.255', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.ok(isPrivateAddress(address), `${address} should be private`);
  }
  for (const address of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '192.167.0.1', '2606:4700::1111']) {
    assert.ok(!isPrivateAddress(address), `${address} should be public`);
  }
});

test('a public-looking name that resolves inside the network is refused', async () => {
  // isPublicUrl can only judge the name. A page we read can link to a host
  // its owner pointed at the cloud metadata address on purpose.
  const lookup = async () => [{ address: '169.254.169.254', family: 4 }];
  assert.equal(await resolvesPublicly('metadata.evil.example', lookup), false);

  const page = await fetchPage('https://metadata.evil.example/', { lookup });
  assert.equal(page.status, 'failed');
  assert.match(page.reason, /private address/);
});

test('a name that will not resolve is left for the fetch to fail on', async () => {
  const lookup = async () => { throw new Error('ENOTFOUND'); };
  assert.equal(await resolvesPublicly('nope.example', lookup), true, 'slow DNS is not the same as a blocked site');
});

test('resolveRedirect refuses a URL that is not a public web address', async () => {
  // The URL comes from the model's grounding data, so it gets the same
  // treatment as anything else off the web.
  assert.equal(await resolveRedirect('file:///etc/passwd'), 'file:///etc/passwd', 'returned unchanged, never fetched');
  assert.equal(await resolveRedirect('http://localhost:3000/'), 'http://localhost:3000/');
});

// ---------------------------------------------------------------- citations

test('a cited fragment too short to mean anything is not treated as the source', () => {
  // A fragment this short sits inside almost any quote. Matching on it
  // staples a real URL to a claim that page never made, which is worse than
  // having no URL at all.
  const citations = [{ text: 'in March', uris: ['https://wrong.example'] }];
  assert.equal(citationFor(citations, 'Acme raised a Series A in March 2026'), null);

  const real = [{ text: 'Acme raised a Series A in March 2026.', uris: ['https://right.example'] }];
  assert.equal(citationFor(real, 'raised a Series A in March 2026'), 'https://right.example');
});

// ---------------------------------------------------------------- drafting

const CONTACT = { firstName: 'Ada', lastName: 'Lovelace', title: 'CTO' };

const company = (over = {}) => ({
  domain: 'acme.com',
  name: 'Acme',
  contact: CONTACT,
  verdict: { kind: 'qualify', code: 'fit', reason: 'Mid-market SaaS with no SOC 2.' },
  answers: {},
  details: {
    saas: {
      label: 'Is it B2B SaaS?',
      answer: 'b2b_saas',
      value: null,
      evidence: { kind: 'page', url: 'https://acme.com/', sourceDate: null, quote: 'Acme is a B2B SaaS platform', checkedAt: '2026-01-01' },
    },
  },
  ...over,
});

const good = {
  pain_points: [{ pain: 'a', why: 'b' }, { pain: 'c', why: 'd' }],
  hook: 'B2B SaaS platform',
  hook_source_url: 'https://acme.com/',
  why_this_email: 'because',
  subject: 'Quick question',
  body: 'Hi Ada,\n\nI saw that Acme is a B2B SaaS platform. Worth a short call?',
};

test('a model reply with no body is a failed attempt, not a crash', async () => {
  // The schema asks for a body. A schema is a request, not a guarantee: a
  // truncated or refused answer arrives shaped like a draft with nothing in it.
  const replies = [{ json: { ...good, body: null } }, { json: good }];
  const llm = { ask: async () => replies.shift() };
  const store = new MemoryStore();

  const saved = await draftEmail(company(), { profile, llm, store });
  assert.equal(saved.status, 'drafted');
  assert.match(saved.email.body, /Worth a short call/);
});

test('a model that never returns a body says so, rather than throwing on undefined', async () => {
  const llm = { ask: async () => ({ json: { ...good, body: null } }) };
  await assert.rejects(
    () => draftEmail(company(), { profile, llm, store: new MemoryStore() }),
    /no usable draft for acme\.com/,
  );
});

test('the rewrite note and the automatic corrections do not contradict each other', async () => {
  const prompts = [];
  const llm = { ask: async ({ prompt }) => (prompts.push(prompt), { json: good }) };

  await draftEmail(company(), { profile, llm, store: new MemoryStore(), feedback: 'Make it shorter.' });
  const rejections = prompts[0].match(/The last attempt was rejected/g) ?? [];
  assert.equal(rejections.length, 0, 'your own instruction is not dressed up as a rejection');
  assert.match(prompts[0], /asked for: Make it shorter\./);
});

// ---------------------------------------------------------------- the store contract

test('every store refuses a company with no domain, test doubles included', async () => {
  // A double that accepts what production refuses hides the bug it exists to catch.
  await assert.rejects(() => new MemoryStore().put({ name: 'No domain' }), /needs a domain/);
});

test('every store can be counted, which is what the health check asks for', async () => {
  const store = new MemoryStore();
  assert.equal(await store.count(), 0);
  await store.put({ domain: 'a.com' });
  await store.put({ domain: 'b.com' });
  assert.equal(await store.count(), 2);
});

// ---------------------------------------------------------------- robots.txt

test('a question mark in a rule is matched as a character, not as a quantifier', () => {
  // Unescaped, "/search?q=" made the "h" optional and matched "/searc=".
  const robots = 'User-agent: *\nDisallow: /search?q=';
  assert.equal(isAllowed(robots, '/search?q=acme').allowed, false);
  assert.equal(isAllowed(robots, '/searc').allowed, true);
  assert.equal(isAllowed(robots, '/searchq=acme').allowed, true);
});

// ---------------------------------------------------------------- source caching

test('two searches that open the same way but fall back differently are different sources', async () => {
  const asked = [];
  const llm = {
    ask: async ({ prompt }) => (asked.push(prompt), { text: `found something`, sources: [{ uri: 'https://x.example' }], citations: [] }),
  };
  const set = new SourceSet({ company: { domain: 'acme.com', name: 'Acme' }, llm, fetchPage: async () => ({ status: 'missing' }) });

  await set.get({ type: 'search', queries: ['acme funding', 'acme raised'] });
  await set.get({ type: 'search', queries: ['acme funding', 'acme headcount'] });
  assert.equal(asked.length, 2, 'the second search ran rather than reading the first one\'s answer');
});

test('the lookup budget still holds when a page has to be hunted for', async () => {
  // Following a link off the homepage is a second lookup; it used to be
  // spent without asking whether there was any budget left.
  const fetched = [];
  const fetchPage = async (url) => {
    fetched.push(url);
    if (url.endsWith('/')) return { status: 'ok', url, text: 'home', links: ['https://acme.com/trust'] };
    return { status: 'missing', url };
  };
  const set = new SourceSet({ company: { domain: 'acme.com' }, llm: null, fetchPage, budget: 2 });

  await set.get({ type: 'page', path: '/security', match: /trust/ });
  assert.ok(set.used <= 2, `used ${set.used} lookups against a budget of 2`);
});

// ---------------------------------------------------------------- reporting a run

test('a research run reports every company, not just the last thing that happened', () => {
  assert.deepEqual(runSummary({ total: 3, failed: [] }), { text: 'Finished: 3 of 3 researched.', tone: 'ok' });

  const partial = runSummary({ total: 3, failed: [{ domain: 'a.com', reason: 'Gemini 429: out of quota' }] });
  assert.match(partial.text, /2 of 3 researched/);
  assert.match(partial.text, /a\.com/);
  assert.match(partial.text, /out of quota/);
  assert.equal(partial.tone, 'warn');

  assert.equal(runSummary({ total: 1, failed: [{ domain: 'a.com', reason: 'nope' }] }).tone, 'bad');
  assert.match(runSummary({ total: 5, failed: [], stopped: true }).text, /^Stopped: 5 of 5/);
  assert.equal(runSummary({ total: 0 }).text, 'Nothing to research.');
});
