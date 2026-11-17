// A profile is the whole campaign as data: what you sell, who counts as a
// prospect, where to look, and what each possible answer means. The engine
// holds no opinion about any particular product — swap the profile, and the
// same code prospects for something else.

/** A page on the company's own site. `match` finds it elsewhere if the path 404s. */
export const page = (path, match = null) => ({ type: 'page', path, match });

/** Web searches, tried in order until one returns something. */
export const search = (...queries) => ({ type: 'search', queries });

/** This answer ends the assessment: not a prospect. */
export const reject = (code, reason) => ({ kind: 'reject', code, reason });

/** This answer ends the assessment: a prospect, and this is why. */
export const qualify = (code, reason) => ({ kind: 'qualify', code, reason });

/** Worth saying out loud on the review page, but not a decision. */
export const note = (text) => ({ kind: 'note', text });

/** Keep going to the next qualifier. */
export const carryOn = () => ({ kind: 'continue' });

const isSource = (source) =>
  (source?.type === 'page' && typeof source.path === 'string') ||
  (source?.type === 'search' && Array.isArray(source.queries) && source.queries.length > 0);

/**
 * One question asked of the web, plus what each answer means.
 *
 *  key            where the answer is stored
 *  ask            the question, in the words the model sees
 *  answers        the only answers allowed, besides 'unknown'
 *  sufficientWhen when a source counts as having settled it — the most
 *                 important line in a profile, and the one worth tuning first
 *  sources        where to look, in order; cheap and specific first
 *  outcomes       answer -> reject / qualify / note / continue
 *  absenceAnswer  what to conclude when every listed page loaded and none
 *                 mentioned it (only safe where silence really is an answer)
 *  onlyIf         ask this one only when a previous answer calls for it
 *  numeric        the answer is a number; `range` then decides
 */
export function qualifier(spec) {
  const { key, label, ask, answers = [], sources = [], outcomes = {}, numeric = false, range = null } = spec;

  if (!key || !label || !ask) throw new Error(`A qualifier needs key, label and ask (got ${JSON.stringify(key ?? label)}).`);
  if (!sources.length || !sources.every(isSource)) throw new Error(`Qualifier "${key}" needs at least one valid page() or search() source.`);
  if (!numeric && !answers.length) throw new Error(`Qualifier "${key}" needs its allowed answers.`);
  if (numeric && !range) throw new Error(`Qualifier "${key}" is numeric, so it needs a range.`);

  const known = new Set([...answers, 'unknown', 'not_stated']);
  for (const answer of Object.keys(outcomes)) {
    if (!numeric && !known.has(answer)) {
      throw new Error(`Qualifier "${key}" has an outcome for "${answer}", which is not one of its answers (${[...known].join(', ')}).`);
    }
  }
  if (spec.absenceAnswer && !known.has(spec.absenceAnswer)) {
    throw new Error(`Qualifier "${key}" has absenceAnswer "${spec.absenceAnswer}", which is not one of its answers.`);
  }

  return {
    requiresValue: false,
    absenceAnswer: null,
    onlyIf: null,
    numeric: false,
    range: null,
    ...spec,
    answers,
    sources,
    outcomes,
  };
}

/**
 * What one answer means. Numeric qualifiers consult their range; everything
 * else looks the answer up in `outcomes`. An answer with no entry carries on.
 */
export function outcomeOf(q, answer) {
  if (answer === undefined) return null;
  if (answer === 'unknown' && !q.outcomes.unknown) {
    return reject('insufficient_evidence', `Could not establish: ${q.label.toLowerCase()}.`);
  }
  if (q.numeric) {
    if (typeof answer !== 'number') return reject('insufficient_evidence', `No number found for ${q.label.toLowerCase()}.`);
    const { rejectBelow, rejectAbove, comfortable = [] } = q.range;
    if (rejectBelow !== undefined && answer < rejectBelow) return reject('too_small', `${q.label} is ${answer}, under ${rejectBelow}.`);
    if (rejectAbove !== undefined && answer > rejectAbove) return reject('too_large', `${q.label} is ${answer}, over ${rejectAbove}.`);
    const [low, high] = comfortable;
    if (comfortable.length && (answer < low || answer > high)) return note(`${q.label} is borderline (${answer}).`);
    return carryOn();
  }
  return q.outcomes[answer] ?? carryOn();
}

export function defineProfile(spec) {
  const { seller, qualifiers = [], discovery = [], contacts, excludeDomains = [], defaultVerdict } = spec;

  if (!seller?.product || !seller?.oneLiner) throw new Error('A profile needs seller.product and seller.oneLiner.');
  if (!qualifiers.length) throw new Error('A profile needs at least one qualifier.');
  if (!defaultVerdict) throw new Error('A profile needs a defaultVerdict: what a company that passes every qualifier is.');

  const seen = new Set();
  for (const q of qualifiers) {
    if (seen.has(q.key)) throw new Error(`Two qualifiers share the key "${q.key}".`);
    seen.add(q.key);
  }
  if (!discovery.length) throw new Error('A profile needs at least one discovery search.');

  return {
    ...spec,
    excludeDomains: excludeDomains.map((d) => d.toLowerCase()),
    qualifiers,
    byKey: Object.fromEntries(qualifiers.map((q) => [q.key, q])),
  };
}
