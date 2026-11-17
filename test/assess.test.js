import test from 'node:test';
import assert from 'node:assert/strict';
import { assess, nextQuestion, verdictOf } from '../src/assess.js';
import { defineProfile, qualifier, page, search, reject, qualify, outcomeOf } from '../src/profile.js';

const tiny = (overrides = {}) =>
  defineProfile({
    seller: { product: 'widgets', oneLiner: 'We sell widgets.' },
    discovery: [{ source: 'test', query: 'widget buyers' }],
    defaultVerdict: reject('no_trigger', 'Nothing to act on.'),
    qualifiers: [
      qualifier({
        key: 'saas',
        label: 'B2B SaaS',
        ask: 'Is it B2B SaaS?',
        answers: ['yes', 'no'],
        sufficientWhen: 'The site says so.',
        sources: [page('/')],
        outcomes: { no: reject('not_saas', 'Not SaaS.') },
      }),
      qualifier({
        key: 'employees',
        label: 'Employee count',
        ask: 'How many people?',
        numeric: true,
        range: { rejectBelow: 15, rejectAbove: 350, comfortable: [20, 300] },
        sufficientWhen: 'A source states a number.',
        sources: [search('{name} employees')],
      }),
      qualifier({
        key: 'trigger',
        label: 'Buying trigger',
        ask: 'Any sign they are buying?',
        answers: ['yes', 'no'],
        sufficientWhen: 'A job post or announcement says so.',
        sources: [page('/careers', /careers/i)],
        outcomes: { yes: qualify('trigger_found', 'They are in market.') },
      }),
    ],
    ...overrides,
  });

test('asks the first unanswered question, in profile order', () => {
  const profile = tiny();
  assert.equal(assess(profile, {}).next.key, 'saas');
  assert.equal(assess(profile, { saas: 'yes' }).next.key, 'employees');
  assert.equal(assess(profile, { saas: 'yes', employees: 100 }).next.key, 'trigger');
});

test('a disqualifying answer stops the assessment there', () => {
  const verdict = verdictOf(tiny(), { saas: 'no' });
  assert.equal(verdict.kind, 'reject');
  assert.equal(verdict.code, 'not_saas');
  assert.equal(verdict.by, 'saas');
});

test('later questions are never asked once a verdict is reached', () => {
  // 'employees' is never answered, and that is fine: 'saas' already decided.
  assert.equal(nextQuestion(tiny(), { saas: 'no' }), null);
});

test('numeric ranges reject outside and note the borderline', () => {
  const profile = tiny();
  assert.equal(verdictOf(profile, { saas: 'yes', employees: 4 }).code, 'too_small');
  assert.equal(verdictOf(profile, { saas: 'yes', employees: 900 }).code, 'too_large');

  const borderline = verdictOf(profile, { saas: 'yes', employees: 320, trigger: 'yes' });
  assert.equal(borderline.kind, 'qualify');
  assert.deepEqual(borderline.notes, ['Employee count is borderline (320).']);
});

test('unknown rejects as insufficient evidence unless the profile says otherwise', () => {
  const verdict = verdictOf(tiny(), { saas: 'unknown' });
  assert.equal(verdict.code, 'insufficient_evidence');

  const lenient = tiny({
    qualifiers: tiny().qualifiers.map((q) =>
      q.key === 'saas' ? qualifier({ ...q, outcomes: { ...q.outcomes, unknown: { kind: 'continue' } } }) : q,
    ),
  });
  assert.equal(assess(lenient, { saas: 'unknown' }).next.key, 'employees');
});

test('passing every qualifier falls through to the default verdict', () => {
  const verdict = verdictOf(tiny(), { saas: 'yes', employees: 100, trigger: 'no' });
  assert.equal(verdict.code, 'no_trigger');
  assert.equal(verdict.by, 'default');
});

test('a qualifier gated by onlyIf is skipped when its condition is false', () => {
  const profile = tiny({
    qualifiers: [
      ...tiny().qualifiers,
      qualifier({
        key: 'gap',
        label: 'Gap',
        ask: 'Is there a gap?',
        answers: ['yes'],
        onlyIf: (answers) => answers.saas === 'maybe',
        sufficientWhen: 'Stated outright.',
        sources: [page('/')],
      }),
    ],
  });
  assert.equal(nextQuestion(profile, { saas: 'yes', employees: 100, trigger: 'no' }), null);
});

test('supporting questions run only after a company qualifies', () => {
  const supporting = [
    qualifier({ key: 'cloud', label: 'Cloud', ask: 'Which cloud?', answers: ['aws'], sufficientWhen: 'Named.', sources: [page('/')] }),
  ];
  const profile = tiny({ supporting });

  assert.equal(nextQuestion(profile, { saas: 'yes', employees: 100, trigger: 'yes' }).key, 'cloud');
  assert.equal(nextQuestion(profile, { saas: 'yes', employees: 100, trigger: 'no' }), null);
});

test('outcomeOf leaves an unanswered qualifier undecided', () => {
  assert.equal(outcomeOf(tiny().qualifiers[0], undefined), null);
});
