// A worked example: selling compliance automation to B2B SaaS companies.
// Copy this file, change the seller and the rules, and point PROFILE at it.
// Nothing in src/ knows anything about this particular campaign.
import { defineProfile, qualifier, page, search, reject, qualify } from '../src/profile.js';

const HOME = page('/', null);
const PRICING = page('/pricing', /pricing|plans/i);
const SECURITY = page('/security', /security/i);
const TRUST = page('/trust', /trust/i);
const CAREERS = page('/careers', /careers|jobs|join-us|work-with-us/i);
const CUSTOMERS = page('/customers', /customers|case-stud|success-stor/i);
const ABOUT = page('/about', /about|company/i);

export default defineProfile({
  seller: {
    company: 'Sprinto',
    product: 'compliance automation',
    oneLiner: 'Sprinto automates compliance certifications (SOC 2, ISO 27001, GDPR) for SaaS companies.',
    senderName: 'Sprinto',
    senderTitle: '',
  },

  // Companies that sell the same thing are never prospects.
  excludeDomains: ['sprinto.com', 'vanta.com', 'drata.com', 'secureframe.com'],

  discovery: [
    {
      source: 'Job posts mentioning SOC 2',
      query:
        'B2B SaaS startups working toward their first SOC 2 or ISO 27001 certification: job posts saying "help us achieve SOC 2", "lead our first SOC 2 audit" or "SOC 2 in progress". Exclude companies that already hold SOC 2',
    },
    {
      source: 'Recent Series A funding',
      query:
        'B2B SaaS companies with 20 to 150 employees that announced Series A funding in the last 6 months and plan to start selling to enterprise customers',
    },
    {
      source: 'Accelerator directories',
      query: 'Y Combinator B2B SaaS companies selling to enterprise customers, Series A stage or later, 20 to 300 employees',
    },
  ],

  // Asked in this order. Cheapest and most disqualifying first.
  qualifiers: [
    qualifier({
      key: 'saas',
      label: 'B2B SaaS',
      ask: 'Is this company a B2B software-as-a-service business?',
      answers: ['b2b_saas', 'not_b2b_saas'],
      sufficientWhen:
        'The content shows what the product does and who it is sold to. Consumer products, agencies, services firms and marketplaces are not_b2b_saas.',
      sources: [HOME, PRICING, page('/product', /product|platform/i), ABOUT, search('{name} {domain} what does the company do')],
      outcomes: {
        not_b2b_saas: reject('not_saas', 'Not a B2B SaaS company.'),
        unknown: reject('insufficient_evidence', 'Could not confirm it is B2B SaaS.'),
      },
    }),

    qualifier({
      key: 'employees',
      label: 'Employee count',
      ask: 'How many people does this company employ? Use the midpoint of any range.',
      numeric: true,
      range: { rejectBelow: 15, rejectAbove: 350, comfortable: [20, 300] },
      sufficientWhen: 'One source states a number or a range, ideally from the last 12 months.',
      sources: [
        search('{name} {domain} number of employees company size', '{name} LinkedIn company size employees'),
        ABOUT,
        CAREERS,
        search('{name} Crunchbase employee count'),
      ],
    }),

    qualifier({
      key: 'certified',
      label: 'Certifications held',
      ask: 'Which compliance certifications does this company hold, and does it use a compliance automation vendor?',
      answers: ['holds_needed', 'missing_framework', 'uses_competitor', 'not_certified'],
      sufficientWhen: [
        'Only answer if the content explicitly says so.',
        'holds_needed: holds SOC 2 Type II or ISO 27001 with no obvious gap.',
        'missing_framework: holds one framework but clearly sells to EU, UK or regulated buyers who need another.',
        'uses_competitor: visibly uses Vanta, Drata or Secureframe, for example a powered-by trust page.',
        'not_certified: explicitly says it is not certified yet, or that certification is in progress.',
        'If the content does not mention certification at all, answer not_stated.',
      ].join(' '),
      absenceAnswer: 'not_certified',
      sources: [SECURITY, TRUST, HOME, page('/dpa', /dpa|data-processing/i), search('{name} {domain} SOC 2 ISO 27001 certified')],
      outcomes: {
        holds_needed: reject('already_certified', 'Already holds the frameworks its buyers ask for.'),
        uses_competitor: reject('uses_competitor', 'Visibly uses a competing compliance platform.'),
        unknown: reject('insufficient_evidence', 'Could not rule out that it is already certified.'),
      },
    }),

    // Holding one framework still leaves room, but only if buyers want another.
    qualifier({
      key: 'frameworkGap',
      label: 'Needs another framework',
      ask: 'Is there evidence this company needs a compliance framework it does not hold yet? Name the framework in value.',
      answers: ['yes'],
      onlyIf: (answers) => answers.certified === 'missing_framework',
      requiresValue: true,
      sufficientWhen:
        'yes only if the content names the framework and shows buyers ask for it, or that the company is working toward it. Selling to large companies is not enough on its own. Otherwise answer not_stated.',
      sources: [SECURITY, TRUST, CAREERS, search('{name} {domain} customers require compliance framework roadmap')],
      outcomes: {
        not_stated: reject('already_certified', 'Holds a certification, and nothing shows it needs another.'),
        unknown: reject('already_certified', 'Holds a certification, and nothing shows it needs another.'),
      },
    }),

    qualifier({
      key: 'funding',
      label: 'Funding stage',
      ask: 'What is this company’s latest funding stage?',
      answers: ['series_a_c', 'bootstrapped', 'too_early', 'too_late'],
      sufficientWhen:
        'A dated announcement or funding profile names the latest round, or a source says it is bootstrapped. too_early is pre-seed or seed; too_late is Series D or later, public, or acquired.',
      sources: [search('{name} {domain} funding round raised Series'), page('/press', /press|news|newsroom/i), search('{name} Crunchbase funding stage')],
      outcomes: {
        too_early: reject('too_early', 'Pre-seed or seed stage.'),
        too_late: reject('too_late', 'Series D or later, public, or acquired.'),
        unknown: { kind: 'note', text: 'Funding stage is unknown.' },
      },
    }),

    qualifier({
      key: 'preparing',
      label: 'Preparing for an audit',
      ask: 'Is this company preparing for a compliance audit right now?',
      answers: ['yes', 'no'],
      sufficientWhen:
        'yes only if a job post mentions achieving SOC 2 or ISO 27001, the site says an audit is in progress, or it is hiring its first security, GRC or compliance person. Otherwise answer not_stated.',
      absenceAnswer: 'no',
      sources: [CAREERS, SECURITY, search('{name} {domain} job posting SOC 2 ISO 27001 compliance'), page('/blog', /blog/i)],
      outcomes: {
        yes: qualify('preparing_for_audit', 'Evidence that it is preparing for a compliance audit.'),
      },
    }),

    qualifier({
      key: 'clients',
      label: 'Enterprise clients',
      ask: 'Does this company have enterprise clients, or an enterprise pricing tier?',
      answers: ['yes', 'no'],
      sufficientWhen:
        'yes if a named client has over 1,000 employees or is in a regulated sector, or pricing shows an enterprise tier. Quote the client name as evidence. no if the named clients are clearly all small. Otherwise answer not_stated.',
      absenceAnswer: 'no',
      sources: [CUSTOMERS, HOME, page('/case-studies', /case-stud|success-stor/i), PRICING],
      outcomes: {
        yes: qualify('enterprise_pressure', 'Has enterprise buyers without the certification they expect.'),
      },
    }),
  ],

  // Only asked once a company has qualified: colour for the email, not criteria.
  supporting: [
    qualifier({
      key: 'industry',
      label: 'Industries served',
      ask: 'Which industries does this company sell into? Is any of them regulated?',
      answers: ['regulated', 'not_regulated'],
      sufficientWhen: 'A named client, case study or solutions page shows the sector. Put the sector in value.',
      sources: [CUSTOMERS, page('/solutions', /solutions|industries/i)],
    }),
    qualifier({
      key: 'cloud',
      label: 'Cloud provider',
      ask: 'Which cloud provider does this company run on?',
      answers: ['aws', 'azure', 'gcp', 'other'],
      sufficientWhen: 'A subprocessors page, privacy policy or engineering job post names the provider.',
      sources: [page('/subprocessors', /sub-?processors/i), page('/privacy', /privacy/i), search('{name} engineering job AWS Azure GCP')],
    }),
  ],

  // Fits the profile, but nothing says now is the moment.
  defaultVerdict: reject('no_trigger', 'Fits the profile, but no sign of an audit or enterprise pressure.'),

  contacts: {
    roles: {
      security: {
        match: /\b(ciso|chief (information )?security|head of (information |product )?security|(vp|vice president|director)\b.*\bsecurity|security lead|grc|head of compliance|compliance (lead|manager))\b/i,
        because: 'owns security and compliance directly',
      },
      cto: { match: /\b(cto|chief technology|technical co-?founder)\b/i, because: 'usually owns compliance where there is no security lead' },
      vpEng: { match: /\b((vp|vice president)\b.*\bengineering|head of engineering)\b/i, because: 'runs the team that would do the audit work' },
      ceo: { match: /\b(ceo|chief executive|co-?founder|founder)\b/i, because: 'closest decision-maker at a company this size' },
    },
    // Who to write to, by headcount. Earlier entries are preferred.
    order: (employees) => {
      if (employees !== null && employees < 50) return ['cto', 'ceo'];
      if (employees !== null && employees > 150) return ['security', 'cto'];
      return ['security', 'cto', 'vpEng'];
    },
  },

  email: {
    maxWords: 110,
    hookMaxAgeMonths: 12,
  },
});
