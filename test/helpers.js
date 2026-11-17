// Stand-ins for the model and the web, so the tests exercise the rules rather
// than the network.
import { LlmUnusable } from '../src/llm.js';
import { defineProfile, qualifier, page, search, reject, qualify } from '../src/profile.js';

/** `reply` sees every request and returns { json } , { text, citations } , or throws. */
export class FakeLlm {
  constructor(reply) {
    this.reply = reply;
    this.requests = [];
  }

  async ask(request) {
    this.requests.push(request);
    const answer = await this.reply(request, this.requests.length);
    if (answer instanceof Error) throw answer;
    return { text: '', sources: [], citations: [], ...answer };
  }
}

export const unusable = (message = 'refused') => new LlmUnusable(message);

/** A web of pages keyed by URL; anything not listed 404s. */
export function fakeWeb(pages, { failing = [] } = {}) {
  return async (url) => {
    if (failing.includes(url)) return { status: 'failed', url, reason: 'blocked (403)' };
    const entry = pages[url];
    if (!entry) return { status: 'missing', url };
    const { text, links = [], publishedAt = null } = typeof entry === 'string' ? { text: entry } : entry;
    return { status: 'ok', url, text, links, publishedAt, fetchedAt: '2026-01-01' };
  };
}

export const testProfile = (overrides = {}) =>
  defineProfile({
    seller: { company: 'Us', product: 'compliance automation', oneLiner: 'We automate compliance.', senderName: 'Sam', senderTitle: 'Us' },
    email: { maxWords: 110, painPoints: 2, hookMaxAgeMonths: 12 },
    contacts: {
      roles: {
        security: { match: /\b(ciso|head of security|grc)\b/i, because: 'owns compliance' },
        cto: { match: /\b(cto|chief technology)\b/i, because: 'owns it where nobody else does' },
        ceo: { match: /\b(ceo|founder)\b/i, because: 'closest decision-maker' },
      },
      order: (employees) => (employees !== null && employees < 50 ? ['cto', 'ceo'] : ['security', 'cto']),
    },
    discovery: [{ source: 'Job posts', query: 'companies hiring for SOC 2' }],
    defaultVerdict: reject('no_trigger', 'Nothing to act on.'),
    excludeDomains: ['ourselves.com'],
    qualifiers: [
      qualifier({
        key: 'saas',
        label: 'B2B SaaS',
        ask: 'Is this company B2B SaaS?',
        answers: ['b2b_saas', 'not_b2b_saas'],
        sufficientWhen: 'The site says what it sells and to whom.',
        sources: [page('/', null), search('{name} {domain} what does it do')],
        outcomes: { not_b2b_saas: reject('not_saas', 'Not B2B SaaS.') },
      }),
      qualifier({
        key: 'employees',
        label: 'Employee count',
        ask: 'How many people work here?',
        numeric: true,
        range: { rejectBelow: 15, rejectAbove: 350, comfortable: [20, 300] },
        sufficientWhen: 'A source states a number.',
        sources: [page('/about', /about/i)],
      }),
      qualifier({
        key: 'preparing',
        label: 'Preparing for an audit',
        ask: 'Are they preparing for an audit?',
        answers: ['yes', 'no'],
        sufficientWhen: 'A job post or the site says so.',
        absenceAnswer: 'no',
        sources: [page('/careers', /careers/i)],
        outcomes: { yes: qualify('preparing_for_audit', 'Preparing for an audit.') },
      }),
    ],
    ...overrides,
  });
