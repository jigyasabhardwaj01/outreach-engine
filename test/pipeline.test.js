import test from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline, describeRun } from '../src/pipeline.js';
import { Researcher } from '../src/research.js';
import { MemoryStore } from '../src/store.js';
import { FakeLlm, fakeWeb, testProfile } from './helpers.js';

const profile = testProfile();

const PAGES = {
  'https://acme.com/': 'Acme is a B2B SaaS platform for finance teams.',
  'https://acme.com/about': 'Acme is a team of 84 people.',
  'https://acme.com/careers': 'We are hiring our first compliance lead to take us through SOC 2.',
};

const GOOD_DRAFT = {
  pain_points: [{ pain: 'a', why: 'b' }, { pain: 'c', why: 'd' }],
  hook: 'compliance lead',
  hook_source_url: 'https://acme.com/careers',
  why_this_email: 'Mid audit-prep.',
  subject: 'Your first compliance lead',
  body: 'Hi Ada,\n\nI saw you are hiring our first compliance lead to take us through SOC 2. It looks like that sits with you for now.\n\nWorth a short call?',
};

const answering = (overrides = {}) =>
  new FakeLlm((request) => {
    const { prompt } = request;
    if (prompt.includes('Write one cold email')) return { json: overrides.draft ?? GOOD_DRAFT };
    if (prompt.includes('How many people')) return { json: { answer: 'not_stated', sufficient: true, number: 84, evidence_quote: 'a team of 84 people' } };
    if (prompt.includes('preparing for an audit')) {
      return overrides.notPreparing
        ? { json: { answer: 'no', sufficient: true, evidence_quote: 'We are hiring our first compliance lead' } }
        : { json: { answer: 'yes', sufficient: true, evidence_quote: 'hiring our first compliance lead to take us through SOC 2' } };
    }
    if (prompt.includes('B2B SaaS'))
      return overrides.notSaas
        ? { json: { answer: 'not_b2b_saas', sufficient: true, evidence_quote: 'Acme is a B2B SaaS platform for finance teams' } }
        : { json: { answer: 'b2b_saas', sufficient: true, evidence_quote: 'a B2B SaaS platform for finance teams' } };
    return { json: { answer: 'not_stated', sufficient: false } };
  });

const hunterFinding = (people) => async () => ({ ok: true, json: async () => ({ data: { emails: people } }) });
const ADA = [{ first_name: 'Ada', last_name: 'Lovelace', position: 'CTO', value: 'ada@acme.com', confidence: 90 }];

function harness({ overrides = {}, pages = PAGES, people = ADA, settings = {}, budget = 40 } = {}) {
  const store = new MemoryStore();
  const llm = answering(overrides);
  const sent = [];
  const researcher = new Researcher({ profile, llm, store, fetchPage: fakeWeb(pages), resolveRedirect: async (u) => u, budget });

  return {
    store,
    llm,
    sent,
    run: (domains, extra = {}) =>
      runPipeline({
        domains,
        profile,
        llm,
        store,
        researcher,
        settings: { EMAIL_TO: 'me@mine.com', RESEND_API_KEY: 'k', MAILER: 'resend', EMAIL_FROM: 'bot@mine.com', HUNTER_API_KEY: 'k', REVIEW_MODE: 'false', ...settings },
        contactFetch: hunterFinding(people),
        transport: {
          fetchImpl: async (url, options) => {
            sent.push(JSON.parse(options.body));
            return { ok: true, json: async () => ({ id: 'msg_1' }) };
          },
        },
        ...extra,
      }),
  };
}

test('all seven steps, on one domain, with nothing asked of you', async () => {
  const { run, store, sent } = harness();
  const summary = await run(['acme.com']);

  assert.deepEqual(
    { processed: summary.processed, qualified: summary.qualified, drafted: summary.drafted, sent: summary.sent },
    { processed: 1, qualified: 1, drafted: 1, sent: 1 },
  );

  const company = await store.get('acme.com');
  assert.equal(company.status, 'sent');
  assert.equal(company.contact.firstName, 'Ada', 'step 4 found a person');
  assert.equal(company.email.pain_points.length, 2, 'step 5 named two pain points');
  assert.ok(company.email.body.includes('Ada'), 'step 6 addressed them by name');
  assert.deepEqual(sent[0].to, ['me@mine.com'], 'step 7 sent to your own address');
  assert.ok(company.timing.researchMs >= 0, 'and the time it took was recorded');
});

test('with review on, it drafts and stops', async () => {
  const { run, store, sent } = harness({ settings: { REVIEW_MODE: 'true' } });
  const summary = await run(['acme.com']);

  assert.equal(summary.drafted, 1);
  assert.equal(summary.sent, 0);
  assert.equal(sent.length, 0, 'nothing left the building');
  assert.equal((await store.get('acme.com')).status, 'drafted');
});

test('a company that does not fit costs nothing after the verdict', async () => {
  let hunterCalls = 0;
  const { store } = harness();
  const summary = await runPipeline({
    domains: ['acme.com'],
    profile,
    llm: answering({ notSaas: true }),
    store,
    researcher: new Researcher({ profile, llm: answering({ notSaas: true }), store, fetchPage: fakeWeb(PAGES), resolveRedirect: async (u) => u }),
    settings: { REVIEW_MODE: 'false', EMAIL_TO: 'me@mine.com' },
    contactFetch: async () => { hunterCalls++; return { ok: true, json: async () => ({ data: { emails: [] } }) }; },
  });

  assert.equal(summary.rejected, 1);
  assert.equal(summary.qualified, 0);
  assert.equal(hunterCalls, 0, 'no contact lookup is spent on a rejected company');
  assert.equal((await store.get('acme.com')).status, 'rejected');
});

test('a company nobody suitable works at is recorded and skipped', async () => {
  const { run, store } = harness({ people: [{ first_name: 'Sam', position: 'Office Manager' }] });
  const summary = await run(['acme.com']);

  assert.equal(summary.contacted, 0);
  assert.equal(summary.drafted, 0);
  assert.deepEqual(summary.failures, [{ domain: 'acme.com', step: 'contact', reason: 'no suitable contact found' }]);
  assert.equal((await store.get('acme.com')).status, 'no_contact');
});

test('a draft that fails its own checks is kept, not sent', async () => {
  const { run, store, sent } = harness({ overrides: { draft: { ...GOOD_DRAFT, body: 'Hi Ada, we guarantee you pass the audit in days.' } } });
  const summary = await run(['acme.com']);

  assert.equal(summary.drafted, 1);
  assert.equal(summary.sent, 0);
  assert.equal(sent.length, 0);
  assert.equal(summary.failures[0].step, 'draft');
  assert.ok((await store.get('acme.com')).email.issues.length);
});

test('running out of lookups hands the company back instead of guessing', async () => {
  const { run, store } = harness({ budget: 1 });
  const summary = await run(['acme.com']);

  assert.equal(summary.handedBack, 1);
  assert.equal(summary.qualified, 0);

  const company = await store.get('acme.com');
  assert.equal(company.status, 'manual_review');
  assert.match(company.handoff.reason, /Ran out of lookups/);
  assert.ok(company.handoff.unanswered.length, 'it says what is still open');
  assert.equal(company.verdict, undefined, 'and reaches no verdict it cannot support');
});

test('one company failing does not stop the rest', async () => {
  const store = new MemoryStore();
  const llm = answering();
  let calls = 0;

  const researcher = {
    run: async (company) => {
      calls++;
      if (company.domain === 'broken.com') throw new Error('the model fell over');
      return store.put({ ...company, status: 'researched', verdict: { kind: 'reject', code: 'no_trigger', reason: 'no' }, details: {}, answers: {} });
    },
  };

  const summary = await runPipeline({
    domains: ['broken.com', 'fine.com'],
    profile, llm, store, researcher,
    settings: { REVIEW_MODE: 'true', EMAIL_TO: 'me@mine.com' },
  });

  assert.equal(calls, 2, 'the second company still ran');
  assert.equal(summary.rejected, 1);
  assert.deepEqual(summary.failures, [{ domain: 'broken.com', step: 'run', reason: 'the model fell over' }]);
});

test('with no domains given it works through what is already shortlisted', async () => {
  const { run, store } = harness({ settings: { REVIEW_MODE: 'true' } });
  await store.put({ domain: 'acme.com', name: 'Acme', status: 'shortlisted' });

  const summary = await run([]);
  assert.equal(summary.processed, 1);
});

test('rubbish in the domain list is dropped, not processed', async () => {
  const { run } = harness();
  const summary = await run(['not a domain', 'ourselves.com']);
  assert.equal(summary.processed, 0, 'an unparseable domain and our own are both skipped');
});

test('the same domain twice is one company, not two', async () => {
  const { run, store } = harness({ settings: { REVIEW_MODE: 'true' } });
  await run(['acme.com', 'acme.com']);
  assert.equal(Object.keys(await store.all()).length, 1);
});

test('an empty run says so rather than failing', async () => {
  const { run } = harness();
  const summary = await run([]);
  assert.equal(summary.processed, 0);
  assert.match(describeRun(summary), /0 processed/);
});

test('the summary reads as a sentence', () => {
  assert.equal(
    describeRun({ processed: 5, qualified: 2, rejected: 2, handedBack: 1, drafted: 2, sent: 1, failures: [{}] }),
    '5 processed, 2 qualified, 2 ruled out, 1 handed back, 2 drafted, 1 sent, 1 failed',
  );
  assert.equal(describeRun({ processed: 1, qualified: 0, rejected: 1, handedBack: 0, drafted: 0, sent: 0, failures: [] }), '1 processed, 0 qualified, 1 ruled out, 0 drafted, 0 sent');
});

test('the self-check passes against the real profile, and would notice if it stopped', async () => {
  const { selfCheck } = await import('../src/selfcheck.js');
  const real = (await import('../profiles/compliance-saas.js')).default;

  const { steps, ok } = await selfCheck({ profile: real, settings: { GEMINI_API_KEY: 'k', EMAIL_TO: 'me@mine.com', MAILER: 'resend', RESEND_API_KEY: 'k' } });
  assert.equal(ok, true, steps.filter((s) => !s.ok).map((s) => `${s.name}: ${s.detail}`).join('; '));
  assert.equal(steps.filter((s) => s.kind === 'pipeline').length, 9, 'seven steps plus the two promises');
  assert.ok(steps.every((s) => s.kind !== 'config' || s.ok), 'and the configuration it was handed is complete');
});

test('the self-check reports configuration separately from wiring', async () => {
  const { selfCheck } = await import('../src/selfcheck.js');
  const real = (await import('../profiles/compliance-saas.js')).default;

  const { ok, configured } = await selfCheck({ profile: real, settings: {} });
  assert.equal(ok, true, 'the pipeline still works with no keys at all');
  assert.equal(configured, false, 'but it is not ready to do it for real');
});
