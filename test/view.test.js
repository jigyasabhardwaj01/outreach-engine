import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STAGES, stageById, companiesIn, countsByStage, firstBusyStage, awaitingResearch,
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
  assert.deepEqual(countsByStage(companies), { review: 1, emails: 2, waiting: 2, sent: 1, out: 1 });
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
