import test from 'node:test';
import assert from 'node:assert/strict';
import { Researcher } from '../src/research.js';
import { SourceSet } from '../src/sources.js';
import { MemoryStore } from '../src/store.js';
import { FakeLlm, fakeWeb, testProfile, unusable } from './helpers.js';

const acme = { domain: 'acme.com', name: 'Acme', status: 'shortlisted' };

const build = ({ reply, pages = {}, failing = [], budget = 40, profile = testProfile() }) => {
  const llm = new FakeLlm(reply);
  const store = new MemoryStore({ 'acme.com': acme });
  const fetchPage = fakeWeb(pages, { failing });
  return { llm, store, researcher: new Researcher({ profile, llm, store, fetchPage, budget, resolveRedirect: async (u) => u }) };
};

const sourcesFor = (researcher, llm, fetchPage) =>
  new SourceSet({ company: acme, llm, fetchPage, budget: researcher.budget });

test('an answer is kept with the quote and the page it came from', async () => {
  const { researcher, llm } = build({
    pages: { 'https://acme.com/': 'Acme is a B2B SaaS platform for finance teams.' },
    reply: () => ({ json: { answer: 'b2b_saas', sufficient: true, evidence_quote: 'a B2B SaaS platform for finance teams' } }),
  });
  const q = researcher.profile.qualifiers[0];
  const detail = await researcher.answerQuestion(acme, q, sourcesFor(researcher, llm, researcher.fetchPage));

  assert.equal(detail.answer, 'b2b_saas');
  assert.equal(detail.evidence.url, 'https://acme.com/');
  assert.equal(detail.evidence.kind, 'page');
  assert.match(detail.evidence.quote, /B2B SaaS platform/);
  assert.deepEqual(detail.log.at(-1).outcome, 'answered');
});

test('an answer whose quote is not in the page is thrown away', async () => {
  const { researcher, llm } = build({
    pages: { 'https://acme.com/': 'Acme is a B2B SaaS platform for finance teams.' },
    // Confident, well-formed, and quoting something the page never said.
    reply: () => ({ json: { answer: 'b2b_saas', sufficient: true, evidence_quote: 'Acme holds SOC 2 Type II' } }),
  });
  const q = researcher.profile.qualifiers[0];
  const detail = await researcher.answerQuestion(acme, q, sourcesFor(researcher, llm, researcher.fetchPage));

  assert.equal(detail.answer, 'unknown');
  assert.ok(detail.log.some((line) => line.outcome.includes('the quote is not in the source')));
});

test('silence counts as an answer when the page really loaded', async () => {
  const { researcher, llm } = build({
    pages: { 'https://acme.com/careers': 'We are hiring a designer and a sales lead.' },
    reply: () => ({ json: { answer: 'not_stated', sufficient: false } }),
  });
  const q = researcher.profile.byKey.preparing;
  const detail = await researcher.answerQuestion(acme, q, sourcesFor(researcher, llm, researcher.fetchPage));

  assert.equal(detail.answer, 'no');
  assert.equal(detail.evidence.kind, 'absence');
});

test('silence counts for nothing when the page was blocked', async () => {
  const { researcher, llm } = build({
    pages: { 'https://acme.com/careers': 'hiring' },
    failing: ['https://acme.com/careers'],
    reply: () => ({ json: { answer: 'not_stated', sufficient: false } }),
  });
  const q = researcher.profile.byKey.preparing;
  const detail = await researcher.answerQuestion(acme, q, sourcesFor(researcher, llm, researcher.fetchPage));

  assert.equal(detail.answer, 'unknown', 'a blocked page is not evidence of absence');
  assert.equal(detail.evidence, null);
});

test('a numeric question keeps the number, not the word', async () => {
  const { researcher, llm } = build({
    pages: { 'https://acme.com/about': 'We are a team of 84 people across three offices.' },
    reply: () => ({ json: { answer: 'not_stated', sufficient: true, number: 84, evidence_quote: 'a team of 84 people' } }),
  });
  const detail = await researcher.answerQuestion(acme, researcher.profile.byKey.employees, sourcesFor(researcher, llm, researcher.fetchPage));

  assert.equal(detail.answer, 84);
});

test('a searched claim takes its link from the citation, not from the prose', async () => {
  const profile = testProfile();
  const { researcher, llm } = build({
    profile,
    pages: {}, // the homepage 404s, so the search source is used
    reply: (request) =>
      request.search
        ? {
            text: 'Acme is a B2B SaaS platform, according to its profile.',
            sources: [{ uri: 'https://directory.example/acme' }],
            citations: [{ text: 'Acme is a B2B SaaS platform, according to its profile.', uris: ['https://directory.example/acme'] }],
          }
        : { json: { answer: 'b2b_saas', sufficient: true, evidence_quote: 'Acme is a B2B SaaS platform' } },
  });
  const detail = await researcher.answerQuestion(acme, profile.qualifiers[0], sourcesFor(researcher, llm, researcher.fetchPage));

  assert.equal(detail.answer, 'b2b_saas');
  assert.equal(detail.evidence.kind, 'search');
  assert.equal(detail.evidence.url, 'https://directory.example/acme');
});

test('one unusable source does not sink the question', async () => {
  const { researcher, llm } = build({
    pages: { 'https://acme.com/': 'Acme sells software to other businesses.' },
    reply: (request, nth) =>
      nth === 1
        ? unusable('refused this one')
        : request.search
          ? { text: 'Acme sells software to other businesses.', sources: [{ uri: 'https://d.example/a' }], citations: [{ text: 'Acme sells software to other businesses.', uris: ['https://d.example/a'] }] }
          : { json: { answer: 'b2b_saas', sufficient: true, evidence_quote: 'Acme sells software to other businesses' } },
  });
  const detail = await researcher.answerQuestion(acme, researcher.profile.qualifiers[0], sourcesFor(researcher, llm, researcher.fetchPage));

  assert.equal(detail.answer, 'b2b_saas');
  assert.ok(detail.log.some((line) => line.outcome.startsWith('unusable:')));
});

test('a page shared by two questions is fetched once', async () => {
  let fetches = 0;
  const pages = fakeWeb({ 'https://acme.com/': 'Acme is a B2B SaaS platform.', 'https://acme.com/about': 'Acme is a B2B SaaS platform of 84 people.' });
  const counting = async (url) => {
    fetches++;
    return pages(url);
  };
  const llm = new FakeLlm((request) =>
    request.prompt.includes('How many people')
      ? { json: { answer: 'not_stated', sufficient: true, number: 84, evidence_quote: '84 people' } }
      : { json: { answer: 'b2b_saas', sufficient: true, evidence_quote: 'Acme is a B2B SaaS platform' } },
  );
  const researcher = new Researcher({ profile: testProfile(), llm, store: new MemoryStore(), fetchPage: counting });
  const sources = new SourceSet({ company: acme, llm, fetchPage: counting, budget: 40 });

  await researcher.answerQuestion(acme, researcher.profile.qualifiers[0], sources);
  await researcher.answerQuestion(acme, researcher.profile.qualifiers[0], sources);
  assert.equal(fetches, 1, 'the second ask comes from the cache');
});

test('the lookup budget stops a company before it stops the run', async () => {
  const { researcher, llm } = build({
    budget: 0,
    pages: { 'https://acme.com/careers': 'We are hiring.' },
    reply: () => ({ json: { answer: 'not_stated', sufficient: false } }),
  });
  const detail = await researcher.answerQuestion(acme, researcher.profile.byKey.preparing, new SourceSet({ company: acme, llm, fetchPage: researcher.fetchPage, budget: 0 }));

  assert.equal(detail.answer, 'unknown', 'out of budget is not the same as nothing to find');
  assert.equal(detail.evidence, null);
});

test('step saves progress, and run carries on to a verdict', async () => {
  const { researcher, store } = build({
    pages: {
      'https://acme.com/': 'Acme is a B2B SaaS platform for finance teams.',
      'https://acme.com/about': 'Acme is a team of 84 people.',
      'https://acme.com/careers': 'We are hiring our first compliance lead to take us through SOC 2.',
    },
    reply: (request) => {
      if (request.prompt.includes('How many people')) return { json: { answer: 'not_stated', sufficient: true, number: 84, evidence_quote: 'a team of 84 people' } };
      if (request.prompt.includes('preparing for an audit')) return { json: { answer: 'yes', sufficient: true, evidence_quote: 'our first compliance lead to take us through SOC 2' } };
      return { json: { answer: 'b2b_saas', sufficient: true, evidence_quote: 'a B2B SaaS platform for finance teams' } };
    },
  });

  const afterOne = await researcher.step(acme);
  assert.equal(afterOne.status, 'researching');
  assert.deepEqual(Object.keys(afterOne.progress.answers), ['saas']);

  // Resuming from the saved row, exactly as an interrupted run would.
  const finished = await researcher.run(await store.get('acme.com'));
  assert.equal(finished.status, 'researched');
  assert.equal(finished.verdict.kind, 'qualify');
  assert.equal(finished.verdict.code, 'preparing_for_audit');
  assert.equal(finished.answers.employees, 84);
  assert.ok(finished.details.preparing.evidence.quote);
});

test('a company is rejected as soon as one answer disqualifies it', async () => {
  const { researcher } = build({
    pages: { 'https://acme.com/': 'Acme is a consumer photo-sharing app.' },
    reply: () => ({ json: { answer: 'not_b2b_saas', sufficient: true, evidence_quote: 'a consumer photo-sharing app' } }),
  });
  const finished = await researcher.run(acme);

  assert.equal(finished.verdict.code, 'not_saas');
  assert.equal(finished.answers.employees, undefined, 'the later questions were never asked');
});

// ---------------------------------------------------------------- not running past the clock

test('a permanent fetch failure is not retried, and says what went wrong', async () => {
  const { describeFailure } = await import('../src/web.js');

  // Three retries of a name that does not resolve is eight seconds spent
  // learning what the first attempt already knew.
  const dead = describeFailure(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
  assert.deepEqual(dead, { reason: 'no such host', permanent: true });

  assert.equal(describeFailure({ name: 'TimeoutError' }).permanent, false, 'a timeout might not happen again');
  assert.equal(describeFailure({ cause: { code: 'ECONNRESET' } }).permanent, false, 'a reset might not happen again');
  assert.equal(describeFailure(Object.assign(new TypeError('x'), { cause: { code: 'ECONNREFUSED' } })).permanent, true);
  assert.equal(describeFailure(Object.assign(new TypeError('x'), { cause: { code: 'CERT_HAS_EXPIRED' } })).permanent, true);
  // Unknown causes stay retryable: guessing "permanent" would lose real pages.
  assert.equal(describeFailure(new Error('something new')).permanent, false);
});

test('a question that runs out of time does not become a verdict about the company', async () => {
  const { Researcher } = await import('../src/research.js');
  const { MemoryStore } = await import('../src/store.js');
  const profile = (await import('../profiles/compliance-saas.js')).default;

  // A clock that has already run past the budget by the time the first
  // source is reached.
  let clock = 0;
  const now = () => (clock += 60000);
  const store = new MemoryStore();
  const researcher = new Researcher({
    profile,
    llm: { ask: async () => assert.fail('no source should have been read') },
    store,
    fetchPage: async () => assert.fail('no page should have been fetched'),
    stepBudgetMs: 1000,
  });

  const saved = await researcher.step({ domain: 'slow.example', name: 'Slow', status: 'shortlisted' }, { now });

  assert.equal(saved.status, 'researching', 'it is still being researched, not decided');
  assert.equal(saved.verdict, undefined, 'no verdict was reached');
  // The crucial part: nothing was recorded as an answer. Recording "unknown"
  // would have the profile reject the company for insufficient evidence —
  // turning a slow website into a judgement about the business.
  assert.deepEqual(saved.progress.answers, {});
  assert.equal(saved.progress.stalled.saas, 1);
});

test('a question that keeps running out of time is handed back, not guessed at', async () => {
  const { Researcher } = await import('../src/research.js');
  const { MemoryStore } = await import('../src/store.js');
  const profile = (await import('../profiles/compliance-saas.js')).default;

  let clock = 0;
  const now = () => (clock += 60000);
  const store = new MemoryStore();
  const researcher = new Researcher({
    profile, llm: { ask: async () => ({ json: {} }) }, store,
    fetchPage: async () => ({ status: 'failed', reason: 'slow' }),
    stepBudgetMs: 1000,
  });

  let company = { domain: 'slow.example', name: 'Slow', status: 'shortlisted' };
  for (let attempt = 0; attempt < 3; attempt++) company = await researcher.step(company, { now });

  assert.equal(company.status, 'manual_review');
  assert.match(company.handoff.reason, /could not be answered in time/);
  assert.match(company.handoff.reason, /too slow/);
  assert.ok(company.handoff.unanswered.length > 0);
  assert.equal(company.verdict, undefined, 'still no verdict — a person decides this one');
});

test('running out of time never lets silence count as an answer', async () => {
  const { Researcher } = await import('../src/research.js');
  const { MemoryStore } = await import('../src/store.js');
  const { qualifier, page, defineProfile, reject, qualify } = await import('../src/profile.js');

  // A qualifier where absence means something, which is exactly where
  // stopping early must not be mistaken for having looked.
  const q = qualifier({
    key: 'certified', label: 'Certified', ask: 'Certified?',
    answers: ['yes', 'no'], sufficientWhen: 'Stated.',
    sources: [page('/security'), page('/trust')],
    absenceAnswer: 'no',
    outcomes: { yes: reject('already', 'already certified'), no: qualify('gap', 'no certification') },
  });
  const profile = defineProfile({
    seller: { product: 'p', oneLiner: 'o' },
    discovery: [{ source: 's', query: 'q' }],
    defaultVerdict: reject('none', 'none'),
    qualifiers: [q],
  });

  // The call order is: the step starts the clock, then the question checks
  // it before each source. So the first source is reached in good time and
  // the clock has run out by the second.
  let calls = 0;
  const times = [0, 10, 99999, 99999];
  let at = 0;
  const now = () => times[Math.min(at++, times.length - 1)];

  const researcher = new Researcher({
    profile,
    llm: { ask: async () => ({ json: { answer: 'not_stated', sufficient: false } }) },
    store: new MemoryStore(),
    fetchPage: async () => (calls++, { status: 'ok', url: 'https://a.example/security', text: 'nothing relevant here at all, repeated to pass the length check'.repeat(5), links: [] }),
    stepBudgetMs: 50,
  });

  const saved = await researcher.step({ domain: 'a.example', status: 'shortlisted' }, { now });

  // "no" would have been a qualifying verdict. It must not be reached by
  // running out of time partway down the list of places to look — so look
  // wherever an answer could have been recorded, not just one of them.
  const recorded = { ...(saved.answers ?? {}), ...(saved.progress?.answers ?? {}) };
  assert.equal(recorded.certified, undefined, 'nothing was concluded about certification');
  assert.equal(saved.status, 'researching');
  assert.equal(calls, 1, 'only the first page was read before the clock ran out');
});
