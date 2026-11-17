// The decision. Plain code walking the profile in order — no model involved —
// so the same answers always give the same verdict, and every verdict can be
// read back as the rule that produced it.
import { outcomeOf } from './profile.js';

/**
 * Walk the qualifiers until one of them decides, or until one has no answer yet.
 *
 * Returns either
 *   { status: 'needs', next, notes }    ask `next`, then call again
 *   { status: 'decided', verdict, notes }
 *
 * The order of `profile.qualifiers` is the order questions get asked, so put
 * the cheap, disqualifying ones first: most companies never reach the rest.
 */
export function assess(profile, answers = {}) {
  const notes = [];

  for (const q of profile.qualifiers) {
    if (q.onlyIf && !q.onlyIf(answers)) continue;

    const answer = answers[q.key];
    if (answer === undefined) return { status: 'needs', next: q, notes };

    const outcome = outcomeOf(q, answer);
    if (!outcome || outcome.kind === 'continue') continue;
    if (outcome.kind === 'note') {
      notes.push(outcome.text);
      continue;
    }
    return { status: 'decided', verdict: { ...outcome, by: q.key, notes }, notes };
  }

  return { status: 'decided', verdict: { ...profile.defaultVerdict, by: 'default', notes }, notes };
}

/** The next question to ask, or null when the assessment is finished. */
export function nextQuestion(profile, answers) {
  const result = assess(profile, answers);
  if (result.status === 'needs') return result.next;

  // Supporting questions are only worth their API calls once a company has
  // qualified: a rejected company never pays for them.
  if (result.verdict.kind !== 'qualify') return null;
  return (profile.supporting ?? []).find((q) => answers[q.key] === undefined) ?? null;
}

/** The finished verdict, or null if more questions remain. */
export function verdictOf(profile, answers) {
  const result = assess(profile, answers);
  return result.status === 'decided' ? result.verdict : null;
}
