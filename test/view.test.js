import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STAGES, stageById, companiesIn, countsByStage, firstBusyStage, awaitingResearch,
  metrics, formatDuration, asPercent, statusChips,
  PIPELINE, pipelineStageOf, pipelineCounts, furthestStage, bannerFor, researchQueueLine,
  actionState, verdictWording, answerWording, evidenceWording, sourceLabel, formatDate, wordCount, sendLabel, summaryLine, researchProgress,
} from '../public/view.js';

const companies = {
  'a.com': { domain: 'a.com', status: 'researched', decision: null, verdict: { kind: 'qualify', reason: 'Hiring for it.' } },
  'b.com': { domain: 'b.com', status: 'drafted', email: { body: 'Hi there' } },
  'c.com': { domain: 'c.com', status: 'shortlisted' },
  'd.com': { domain: 'd.com', status: 'researching', progress: { answers: { saas: 'b2b_saas' } } },
  'e.com': { domain: 'e.com', status: 'rejected', decision: 'rejected', verdict: { kind: 'reject', reason: 'Not SaaS.' } },
  'f.com': { domain: 'f.com', status: 'sent', email: { sentTo: 'me@mine.com', sentAt: '2026-11-17T10:00:00Z' } },
  // Approved but the contact lookup has not finished: it belongs with the emails.
  'g.com': { domain: 'g.com', status: 'approved', decision: 'approved' },
};

test('every company lands in exactly one tab', () => {
  for (const company of Object.values(companies)) {
    const stages = STAGES.filter((stage) => stage.has(company));
    assert.equal(stages.length, 1, `${company.domain} (${company.status}) matched ${stages.length} tabs`);
  }
});

test('a decided company leaves the review tab', () => {
  assert.deepEqual(companiesIn(companies, 'review').map((c) => c.domain), ['a.com']);
  assert.ok(!companiesIn(companies, 'review').some((c) => c.domain === 'g.com'), 'approved, so no longer waiting on you');
});

test('the counts add up and the shortlist includes work in progress', () => {
  assert.deepEqual(countsByStage(companies), { review: 1, handoff: 0, emails: 2, waiting: 2, sent: 1, out: 1 });
  assert.equal(awaitingResearch(companies), 2, 'shortlisted and mid-research both still need work');
});

test('the page opens on the first tab with anything in it', () => {
  assert.equal(firstBusyStage(companies), 'review');
  assert.equal(firstBusyStage({ 'x.com': { status: 'sent' } }), 'sent');
  assert.equal(firstBusyStage({}), 'review', 'an empty store still opens somewhere sensible');
});

test('an unknown tab id falls back rather than breaking the page', () => {
  assert.equal(stageById('nonsense').id, 'review');
});

test('a disabled button always says why', () => {
  assert.deepEqual(actionState({ signedIn: true, ready: true, busy: false }), { enabled: true, reason: '' });

  const signedOut = actionState({ signedIn: false, ready: true, busy: false });
  assert.equal(signedOut.enabled, false);
  assert.match(signedOut.reason, /Sign in/);

  const noKey = actionState({ signedIn: true, ready: false, busy: false });
  assert.equal(noKey.enabled, false);
  assert.match(noKey.reason, /Gemini key/);

  assert.match(actionState({ signedIn: true, ready: true, busy: true }).reason, /already running|else is running/);
});

test('rejecting needs no API key, only a signature', () => {
  assert.equal(actionState({ signedIn: true, ready: false, busy: false, needs: 'none' }).enabled, true);
  assert.equal(actionState({ signedIn: false, ready: true, busy: false, needs: 'none' }).enabled, false);
});

test('verdicts read as plain English', () => {
  assert.deepEqual(verdictWording({ kind: 'qualify' }), { label: 'Worth writing to', tone: 'qualify' });
  assert.deepEqual(verdictWording({ kind: 'reject' }), { label: 'Not a fit', tone: 'reject' });
  assert.equal(verdictWording(undefined).tone, 'reject', 'no verdict is not a recommendation');
});

test('answers lose their underscores but numbers stay numbers', () => {
  assert.equal(answerWording({ answer: 'not_b2b_saas' }), 'not b2b saas');
  assert.equal(answerWording({ answer: 84 }), '84');
  assert.equal(answerWording({ answer: 'yes', value: 'ISO 27001' }), 'yes (ISO 27001)');
});

test('evidence is shown as a quote, an absence, or nothing found', () => {
  assert.equal(evidenceWording({ evidence: null }).kind, 'none');
  assert.equal(evidenceWording({ evidence: { kind: 'absence' } }).kind, 'absence');

  const quoted = evidenceWording({ evidence: { kind: 'page', url: 'https://www.acme.com/security', quote: 'in progress', sourceDate: '2026-09-02' } });
  assert.equal(quoted.quote, 'in progress');
  assert.equal(quoted.source, 'acme.com · 2 Sep 2026');
});

test('a source label survives a URL that is not one', () => {
  assert.equal(sourceLabel({ url: 'not a url' }), 'not a url');
  assert.equal(sourceLabel({ url: null }), null);
  assert.equal(sourceLabel({ url: 'https://x.example/a', sourceDate: null }), 'x.example');
});

test('dates degrade gracefully as they get vaguer', () => {
  assert.equal(formatDate('2026-09-02'), '2 Sep 2026');
  assert.equal(formatDate('2026-09'), 'Sep 2026');
  assert.equal(formatDate('2026'), '2026');
  assert.equal(formatDate(null), '');
});

test('word count ignores the whitespace people actually type', () => {
  assert.equal(wordCount('  Hi  Ada,\n\nthree words here '), 5);
  assert.equal(wordCount(''), 0);
  assert.equal(wordCount(undefined), 0);
});

test('a summary line prefers the most useful fact it has', () => {
  assert.match(summaryLine(companies['f.com']), /^Sent to me@mine\.com on 17 Nov 2026$/);
  assert.equal(summaryLine(companies['e.com']), 'Not SaaS.');
  assert.equal(summaryLine({ status: 'no_contact' }), 'no contact');
});

test('research progress counts the questions already answered', () => {
  assert.equal(researchProgress(companies['c.com']).text, 'not started');
  assert.equal(researchProgress(companies['d.com']).text, '1 question answered');
  assert.equal(researchProgress({ status: 'researching', progress: { answers: { a: 1, b: 2 } } }).text, '2 questions answered');
});

test('the send button never trails off into nothing', () => {
  assert.equal(sendLabel('me@mine.com'), 'Send to me@mine.com');
  // An unset EMAIL_TO arrives as an empty string as often as null.
  assert.equal(sendLabel(''), 'Send to your own address');
  assert.equal(sendLabel('   '), 'Send to your own address');
  assert.equal(sendLabel(null), 'Send to your own address');
  assert.equal(sendLabel(undefined), 'Send to your own address');
});

// ---------------------------------------------------------------- the pipeline rail

test('a company sits at exactly one point on the rail', () => {
  assert.equal(pipelineStageOf({ status: 'shortlisted' }), 'shortlist');
  assert.equal(pipelineStageOf({ status: 'researching' }), 'research');
  assert.equal(pipelineStageOf({ status: 'researched' }), 'qualify');
  assert.equal(pipelineStageOf({ status: 'no_contact' }), 'contact');
  assert.equal(pipelineStageOf({ status: 'drafted' }), 'draft');
  assert.equal(pipelineStageOf({ status: 'sent' }), 'send');
});

test('a rejected company leaves the rail rather than lingering on it', () => {
  assert.equal(pipelineStageOf({ status: 'rejected' }), null);
  assert.equal(pipelineStageOf({ status: 'nonsense' }), null);
  assert.equal(pipelineStageOf(undefined), null);
});

test('the rail counts what is actually at each stop', () => {
  assert.deepEqual(pipelineCounts(companies), { shortlist: 1, research: 1, qualify: 1, contact: 1, draft: 1, send: 1 });
  assert.deepEqual(pipelineCounts({}), { shortlist: 0, research: 0, qualify: 0, contact: 0, draft: 0, send: 0 });
});

test('the furthest stage reached is what lights the rail up', () => {
  assert.equal(furthestStage(companies), 'send');
  assert.equal(furthestStage({ a: { status: 'shortlisted' }, b: { status: 'researched' } }), 'qualify');
  assert.equal(furthestStage({ a: { status: 'rejected' } }), null, 'rejections light nothing');
  assert.equal(furthestStage({}), null);
});

test('the banner leads with whatever most needs you', () => {
  assert.match(bannerFor(companies).title, /^1 company waiting for you$/);
  assert.equal(bannerFor({ a: { status: 'drafted' }, b: { status: 'drafted' } }).title, '2 drafts to approve');
  assert.equal(bannerFor({ a: { status: 'shortlisted' } }).title, '1 shortlisted, not yet researched');
  assert.equal(bannerFor({ a: { status: 'sent' } }).title, 'Nothing waiting for you');
  assert.equal(bannerFor({}).title, 'Nothing here yet');
});

test('the banner totals read as English, and skip what is zero', () => {
  assert.equal(bannerFor({ a: { status: 'sent' }, b: { status: 'rejected' } }).detail, '1 sent, 1 ruled out');
  assert.equal(bannerFor({ a: { status: 'sent' } }).detail, '1 sent');
  assert.equal(bannerFor({ a: { status: 'drafted' } }).detail, '', 'nothing sent or rejected yet, so say nothing');
});

test('the research queue names what is waiting, then stops naming', () => {
  const many = Object.fromEntries(['b.com', 'a.com', 'c.com'].map((d) => [d, { domain: d, status: 'shortlisted' }]));
  assert.equal(researchQueueLine(many, 8), '3 waiting for research: a.com, b.com, c.com');
  assert.equal(researchQueueLine(many, 2), '3 waiting for research: a.com, b.com and 1 more');
  assert.match(researchQueueLine({}), /^Nothing is waiting/);
});

// ---------------------------------------------------------------- the measurement plan

const measured = {
  a: { status: 'sent', timing: { researchMs: 60000 }, lookups: 10, contact: { firstName: 'A' }, email: { originalBody: 'x', body: 'x' } },
  b: { status: 'drafted', timing: { researchMs: 180000 }, lookups: 20, contact: { firstName: 'B' }, rewrites: 2, email: { body: 'y' } },
  c: { status: 'no_contact', timing: { researchMs: 30000 }, lookups: 6 },
  d: { status: 'rejected', timing: { researchMs: 30000 }, lookups: 4 },
  e: { status: 'manual_review' },
};

test('the metrics answer the questions the brief asks', () => {
  const m = metrics(measured);
  assert.equal(m.researched, 4, 'the handed-back company was never timed');
  assert.equal(m.averageMs, 75000);
  assert.equal(m.withinTarget, true, 'under the two minutes the brief asks for');
  assert.equal(m.lookupsPerCompany, 10);
  assert.equal(m.drafted, 2);
  assert.equal(m.rewritten, 1, 'only the one that was rewritten counts');
  assert.equal(m.rewriteRate, 0.5);
  assert.equal(m.contactsFound, 2);
  assert.equal(m.contactRate, 2 / 3, 'out of the three we actually looked for');
  assert.equal(m.sent, 1);
  assert.equal(m.handedBack, 1);
});

test('an edited draft counts as a rewrite even without pressing Rewrite', () => {
  const edited = metrics({ a: { status: 'sent', email: { body: 'changed', originalBody: 'original', edited: true } } });
  assert.equal(edited.rewritten, 1);
  assert.equal(edited.rewriteRate, 1);
});

test('metrics on nothing are blank rather than zero or NaN', () => {
  const m = metrics({});
  assert.equal(m.averageMs, null);
  assert.equal(m.withinTarget, null);
  assert.equal(m.rewriteRate, null);
  assert.equal(m.contactRate, null);
  assert.equal(m.researched, 0);
});

test('a company over the two-minute target is reported as over', () => {
  assert.equal(metrics({ a: { status: 'sent', timing: { researchMs: 200000 } } }).withinTarget, false);
});

test('durations read as a person would say them', () => {
  assert.equal(formatDuration(45000), '45s');
  assert.equal(formatDuration(80000), '1m 20s');
  assert.equal(formatDuration(600000), '10m 00s');
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(-5), '—');
});

test('percentages, including the ones we cannot compute', () => {
  assert.equal(asPercent(0.5), '50%');
  assert.equal(asPercent(0), '0%');
  assert.equal(asPercent(1), '100%');
  assert.equal(asPercent(null), '—');
  assert.equal(asPercent(undefined), '—');
});

test('a handed-back company gets its own tab and sits on the rail where it stopped', () => {
  assert.deepEqual(companiesIn({ x: { domain: 'x', status: 'manual_review' } }, 'handoff').map((c) => c.domain), ['x']);
  assert.equal(pipelineStageOf({ status: 'manual_review' }), 'qualify');

  // And it must not quietly vanish from every tab.
  const stages = STAGES.filter((s) => s.has({ status: 'manual_review' }));
  assert.equal(stages.length, 1);
});

// ---------------------------------------------------------------- what the header says

const liveSteps = (over = {}) => ({
  steps: [
    { name: 'Gemini key', ok: true, detail: '41 models available', ...over.gemini },
    { name: 'Hunter key', ok: true, detail: '3/50 searches used this month', ...over.hunter },
    { name: 'Mailer (resend)', ok: true, detail: 'key accepted', ...over.mailer },
  ],
});

test('before the live check lands, the header says only what it knows', () => {
  const chips = statusChips({ ready: true, emailTo: 'me@mine.com' }, null);
  assert.deepEqual(chips.map((c) => c.text), ['sends to me@mine.com']);
});

test('a key that is set but rejected is called rejected, not ready', () => {
  // The failure this whole check exists for: present, so "ready", and refused.
  const chips = statusChips(
    { ready: true, emailTo: 'me@mine.com' },
    liveSteps({ gemini: { ok: false, detail: 'HTTP 401: API key not valid' } }),
  );
  const gemini = chips.find((c) => c.text.includes('Gemini'));
  assert.equal(gemini.text, 'Gemini key rejected');
  assert.equal(gemini.tone, 'bad');
  assert.match(gemini.title, /401/);
});

test('a working key says so', () => {
  const chips = statusChips({ ready: true, emailTo: 'me@mine.com' }, liveSteps());
  assert.equal(chips.find((c) => c.text.includes('Gemini')).text, 'Gemini ready');
});

test('no key at all still reads as no key', () => {
  const chips = statusChips({ ready: false }, null);
  assert.equal(chips[0].text, 'no Gemini key');
  assert.equal(chips[0].tone, 'warn');
});

test('a model the key cannot use gets its own warning', () => {
  const chips = statusChips({ ready: true }, { steps: [{ name: 'Model gemini-9', ok: false, detail: 'NOT available' }] });
  assert.ok(chips.some((c) => c.text === 'model unavailable'));
});

test('Hunter usage is shown, because 50 searches a month runs out quietly', () => {
  const chips = statusChips({ ready: true }, liveSteps());
  assert.equal(chips.find((c) => c.text.includes('searches')).text, '3/50 searches used');
});

test('an unconfigured mailer is a warning, not an error', () => {
  const chips = statusChips({ ready: true }, liveSteps({ mailer: { ok: false, detail: 'RESEND_API_KEY not set' } }));
  const mailer = chips.find((c) => c.text === 'sending not set up');
  assert.equal(mailer.tone, 'warn');
  assert.match(mailer.title, /RESEND_API_KEY/);
});

test('a missing destination is still called out', () => {
  assert.ok(statusChips({ ready: true, emailTo: null }, liveSteps()).some((c) => c.text === 'EMAIL_TO not set'));
});
