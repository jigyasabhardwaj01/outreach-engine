// Who to write to. The profile says which roles matter and in what order;
// this only knows how to ask Hunter and how to apply that order.
import { env } from './env.js';

/**
 * Pick the best contact from a list of people.
 *
 * `order` comes from the profile and depends on the company: at thirty people
 * the CTO owns this, at three hundred there is someone whose job it is.
 */
export function pickContact(people, profile, { employees = null } = {}) {
  const named = people.filter((person) => person.first_name && person.position);

  for (const role of profile.contacts.order(employees)) {
    const spec = profile.contacts.roles[role];
    if (!spec) continue;

    const best = named
      .filter((person) => spec.match.test(person.position))
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];

    if (best) {
      return {
        firstName: best.first_name,
        lastName: best.last_name ?? '',
        title: best.position,
        email: best.value ?? null,
        confidence: best.confidence ?? null,
        role,
        source: 'Hunter',
        reason: `${best.position} ${spec.because}.`,
      };
    }
  }
  return null;
}

/**
 * Look the contact up, once per company. Hunter's free tier is small, so this
 * only runs for a company you have already approved.
 */
export async function findContact(company, { profile, store, apiKey = env.HUNTER_API_KEY, fetchImpl = fetch }) {
  if (company.contact) return company;
  if (!apiKey) throw new Error('HUNTER_API_KEY is not set. Add it to .env.');

  const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(company.domain)}&limit=10&api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Hunter ${res.status}: ${data.errors?.[0]?.details ?? 'no details'}`);

  const employees = typeof company.answers?.employees === 'number' ? company.answers.employees : null;
  const contact = pickContact(data.data?.emails ?? [], profile, { employees });

  return store.put({ ...company, contact, status: contact ? 'contact_found' : 'no_contact' });
}

/** A contact you found yourself, when Hunter has nothing. */
export function manualContact({ firstName, lastName = '', title }) {
  if (!firstName?.trim() || !title?.trim()) throw new Error('A contact needs a first name and a title.');
  return {
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    title: title.trim(),
    email: null,
    confidence: null,
    role: 'manual',
    source: 'Entered by you',
    reason: 'Chosen by you.',
  };
}
