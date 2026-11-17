import test from 'node:test';
import assert from 'node:assert/strict';
import { pickContact, findContact, manualContact } from '../src/contacts.js';
import { isFreshHook, collectEvidence, checkDraft, findUnsupportedClaims, draftEmail } from '../src/draft.js';
import { sendEmail, approve } from '../src/send.js';
import { MemoryStore } from '../src/store.js';
import { FakeLlm, testProfile } from './helpers.js';

const profile = testProfile();

const PEOPLE = [
  { first_name: 'Ada', last_name: 'Lovelace', position: 'CTO', value: 'ada@acme.com', confidence: 80 },
  { first_name: 'Grace', last_name: 'Hopper', position: 'Head of Security', value: 'grace@acme.com', confidence: 90 },
  { first_name: 'Alan', last_name: 'Turing', position: 'CEO', value: 'alan@acme.com', confidence: 95 },
  { first_name: 'NoRole', last_name: '', position: '', value: 'x@acme.com', confidence: 99 },
];

test('who to write to depends on how big the company is', () => {
  assert.equal(pickContact(PEOPLE, profile, { employees: 30 }).firstName, 'Ada', 'small company: the CTO');
  assert.equal(pickContact(PEOPLE, profile, { employees: 300 }).firstName, 'Grace', 'large company: the security lead');
});

test('within a role, the most confident match wins, and the untitled are ignored', () => {
  const two = [
    { first_name: 'Low', position: 'CTO', confidence: 20 },
    { first_name: 'High', position: 'CTO & co-founder', confidence: 85 },
    { first_name: 'Blank', position: '', confidence: 99 },
  ];
  assert.equal(pickContact(two, profile, { employees: 30 }).firstName, 'High');
});

test('nobody suitable means no contact, not a bad one', async () => {
  const store = new MemoryStore();
  const company = { domain: 'acme.com', name: 'Acme', answers: { employees: 30 }, status: 'approved' };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ data: { emails: [{ first_name: 'Sam', position: 'Office Manager' }] } }) });

  const result = await findContact(company, { profile, store, apiKey: 'test', fetchImpl });
  assert.equal(result.contact, null);
  assert.equal(result.status, 'no_contact');
});

test('a contact you enter yourself is recorded as yours', () => {
  assert.equal(manualContact({ firstName: ' Ada ', title: 'CTO' }).source, 'Entered by you');
  assert.throws(() => manualContact({ firstName: '', title: 'CTO' }), /first name and a title/);
});

const march = new Date('2026-03-01T00:00:00Z');

test('a hook has to be something that is true now', () => {
  const page = (url, sourceDate = null) => ({ kind: 'page', url, sourceDate, quote: 'q' });

  assert.ok(isFreshHook(page('https://acme.com/careers'), { now: march }), 'an undated page on their site is current');
  assert.ok(!isFreshHook(page('https://acme.com/blog/2019/we-did-a-thing'), { now: march }), 'an undated article could be ancient');
  assert.ok(isFreshHook(page('https://acme.com/blog/x', '2025-12-01'), { now: march }), 'recent enough');
  assert.ok(!isFreshHook(page('https://acme.com/blog/x', '2019-01-01'), { now: march }), 'too old');
  assert.ok(!isFreshHook(page('https://acme.com/blog/x', '2027-01-01'), { now: march }), 'dated in the future');
  assert.ok(!isFreshHook({ kind: 'absence', url: null }, { now: march }), 'absence is not a hook');
});

const company = {
  domain: 'acme.com',
  name: 'Acme',
  verdict: { kind: 'qualify', code: 'preparing_for_audit', reason: 'Hiring a compliance lead.' },
  contact: { firstName: 'Ada', lastName: 'Lovelace', title: 'CTO' },
  answers: {},
  details: {
    preparing: {
      label: 'Preparing for an audit',
      answer: 'yes',
      value: null,
      evidence: { kind: 'page', url: 'https://acme.com/careers', sourceDate: null, quote: 'hiring our first compliance lead to take us through SOC 2' },
    },
    old: {
      label: 'Funding',
      answer: 'series_a_c',
      value: null,
      evidence: { kind: 'search', url: 'https://news.example/acme-2018', sourceDate: '2018-05-01', quote: 'Acme raised a Series A' },
    },
  },
};

const evidence = collectEvidence(company, { now: march });

const goodDraft = {
  subject: 'Your first compliance lead',
  body: 'Hi Ada,\n\nI saw you are hiring your first compliance lead to take us through SOC 2. It looks like that lands on your desk until they start.\n\nWorth a short call next week?',
  hook: 'hiring a compliance lead',
  hook_source_url: 'https://acme.com/careers',
  why_this_email: 'They are mid-audit-prep.',
  pain_points: [{ pain: 'a', why: 'b' }, { pain: 'c', why: 'd' }],
};

const check = (overrides) => checkDraft({ ...goodDraft, ...overrides }, { company, evidence, profile });

test('a sound draft passes', () => {
  assert.deepEqual(check({}), []);
});

test('the checks catch the ways a draft goes wrong', () => {
  assert.match(check({ body: `Hi Ada, ${'word '.repeat(200)}` })[0], /Too long/);
  assert.match(check({ body: 'Hello there, saw the compliance hire.' })[0], /addressed to the contact by name/);
  assert.match(check({ body: 'Hi Ada, saw [COMPANY] is hiring.' }).join(' '), /placeholder/);
  assert.match(check({ subject: '' }).join(' '), /No subject line/);
  assert.match(check({ pain_points: [{ pain: 'a', why: 'b' }] }).join(' '), /exactly 2 pain points/);
  assert.match(check({ hook_source_url: 'https://invented.example/x' }).join(' '), /not in the research/);
  assert.match(check({ hook_source_url: 'https://news.example/acme-2018' }).join(' '), /too old, or undated/);
});

test('an outcome nobody can promise is rejected', () => {
  assert.match(check({ body: 'Hi Ada, we can get you certified in a few weeks.' }).join(' '), /Promises an outcome/);
  assert.match(check({ body: 'Hi Ada, we make audits effortless.' }).join(' '), /Promises an outcome/);
});

test('telling them they need something is only allowed when the research says so', () => {
  const asserted = { body: 'Hi Ada, you need ISO 27001 before your next enterprise deal.' };
  assert.match(check(asserted).join(' '), /States a guess as fact/);

  const hedged = { body: 'Hi Ada, I saw you are hiring your first compliance lead. It looks like ISO 27001 might come up next. Worth a call?' };
  assert.deepEqual(checkDraft({ ...goodDraft, ...hedged }, { company, evidence, profile }), [], 'hedged wording is fine');

  // Both halves have to hold: the research says they need something, and it
  // says which. Naming a framework the evidence never mentions stays a guess.
  const evidenced = {
    ...company,
    answers: { frameworkGap: 'yes' },
    details: {
      ...company.details,
      frameworkGap: {
        label: 'Needs another framework',
        answer: 'yes',
        value: 'ISO 27001',
        evidence: { kind: 'page', url: 'https://acme.com/security', sourceDate: null, quote: 'EU buyers ask us for ISO 27001' },
      },
    },
  };
  const widerEvidence = collectEvidence(evidenced, { now: march });

  assert.deepEqual(checkDraft({ ...goodDraft, ...asserted }, { company: evidenced, evidence: widerEvidence, profile }), []);
  assert.match(
    checkDraft({ ...goodDraft, body: 'Hi Ada, you need FedRAMP before your next deal.' }, { company: evidenced, evidence: widerEvidence, profile }).join(' '),
    /States a guess as fact/,
    'a framework nobody researched is still a guess, gap or no gap',
  );
});

test('findUnsupportedClaims leaves sentences about the sender alone', () => {
  assert.deepEqual(findUnsupportedClaims('We help teams reach SOC 2 and ISO 27001.', evidence), []);
  assert.deepEqual(findUnsupportedClaims('Your HIPAA position looks settled.', evidence), ['Your HIPAA position looks settled.']);
});

test('drafting retries on a failed check and keeps the clean attempt', async () => {
  const store = new MemoryStore();
  const llm = new FakeLlm((request, nth) => ({
    json: nth === 1 ? { ...goodDraft, body: 'Hi Ada, we guarantee you pass the audit in days.' } : goodDraft,
  }));

  const saved = await draftEmail(company, { profile, llm, store, now: march });
  assert.deepEqual(saved.email.issues, []);
  assert.equal(llm.requests.length, 2);
  assert.match(llm.requests[1].prompt, /Fix exactly this: Promises an outcome/);
  assert.match(saved.email.body, /\n\nSam\nUs$/, 'the signature is appended');
});

test('a draft that never comes clean is kept, with its problems attached', async () => {
  const store = new MemoryStore();
  const llm = new FakeLlm(() => ({ json: { ...goodDraft, body: 'Hi Ada, we guarantee you pass the audit.' } }));

  const saved = await draftEmail(company, { profile, llm, store, now: march, attempts: 2 });
  assert.equal(saved.email.status, 'draft');
  assert.ok(saved.email.issues.length, 'the review page gets to see what is wrong');
});

test('sending goes to your own address, never to the contact', async () => {
  const store = new MemoryStore();
  const settings = { EMAIL_TO: 'Me@Mine.com', EMAIL_FROM: 'bot@mine.com', SENDER_NAME: 'Sam', RESEND_API_KEY: 'k' };
  let sent;
  const fetchImpl = async (url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true, json: async () => ({ id: 'msg_1' }) };
  };

  const approved = approve({ ...company, contact: { ...company.contact, email: 'ada@acme.com' }, email: { ...goodDraft, status: 'draft' } });
  const saved = await sendEmail(approved, { store, settings, fetchImpl });

  assert.deepEqual(sent.to, ['me@mine.com']);
  assert.ok(!JSON.stringify(sent).includes('ada@acme.com'), 'the contact address is never a recipient');
  assert.equal(saved.status, 'sent');
  assert.equal(saved.email.providerId, 'msg_1');
});

test('an unapproved draft is not sent, and a sent one is not sent twice', async () => {
  const store = new MemoryStore();
  const settings = { EMAIL_TO: 'me@mine.com', EMAIL_FROM: 'bot@mine.com', RESEND_API_KEY: 'k' };
  const fetchImpl = async () => {
    throw new Error('should not have been called');
  };

  await assert.rejects(() => sendEmail({ ...company, email: { ...goodDraft, status: 'draft' } }, { store, settings, fetchImpl }), /not been approved/);
  const already = { ...company, email: { ...goodDraft, status: 'sent' } };
  assert.equal((await sendEmail(already, { store, settings, fetchImpl })).email.status, 'sent');
});

test('no EMAIL_TO means nothing leaves the building', async () => {
  await assert.rejects(
    () => sendEmail({ ...company, email: { ...goodDraft, status: 'approved' } }, { store: new MemoryStore(), settings: {}, fetchImpl: async () => {} }),
    /EMAIL_TO is not set/,
  );
});
