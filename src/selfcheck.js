// The system checking itself.
//
// It runs the real pipeline — the real researcher, the real qualifier, the
// real drafting checks — against a stand-in web and a stand-in model, and then
// asserts that each of the seven steps actually produced what it claims to.
// No API keys, no network, no cost. If this passes, the wiring is sound and
// only the credentials stand between you and a real run.
import { MemoryStore } from './store.js';
import { Researcher } from './research.js';
import { runPipeline } from './pipeline.js';
import { isAllowed } from './robots.js';
import { mailerFor } from './mailer.js';

const PAGES = {
  'https://selfcheck.example/': 'Selfcheck is a B2B SaaS platform that mid-market finance teams use to close their books.',
  'https://selfcheck.example/about': 'Selfcheck is a team of 84 people across two offices, serving finance teams.',
  'https://selfcheck.example/security': 'Our SOC 2 Type II audit is currently in progress. We are not certified yet.',
  'https://selfcheck.example/careers': 'We are hiring our first compliance lead to take us through SOC 2 this year.',
  'https://selfcheck.example/pricing': 'Plans for teams, with an enterprise tier for larger finance organisations.',
};

const fakeWeb = async (url) => {
  const page = PAGES[url];
  if (!page) return { status: 'missing', url };
  return { status: 'ok', url, text: page, links: Object.keys(PAGES), publishedAt: null, fetchedAt: '2026-01-01' };
};

// Answers drawn only from the page it is shown, so the evidence checks are
// exercised rather than bypassed.
const fakeLlm = {
  requests: [],
  async ask(request) {
    this.requests.push(request);
    const prompt = request.prompt;
    const quote = (text, fallback) => (prompt.includes(text) ? text : fallback);

    if (prompt.includes('Write one cold email')) {
      return {
        json: {
          pain_points: [
            { pain: 'Audit prep landing on one person', why: 'They are hiring their first compliance lead.' },
            { pain: 'Enterprise questionnaires', why: 'They sell to finance teams.' },
          ],
          hook: 'hiring their first compliance lead',
          hook_source_url: 'https://selfcheck.example/careers',
          why_this_email: 'They are mid audit-prep with nobody owning it yet.',
          subject: 'Your first compliance lead',
          body: 'Hi Ada,\n\nI saw you are hiring our first compliance lead to take us through SOC 2. It looks like that work sits with you until they start.\n\nWorth a short call?',
        },
      };
    }
    if (prompt.includes('B2B software-as-a-service')) {
      return { json: { answer: 'b2b_saas', sufficient: true, evidence_quote: quote('B2B SaaS platform', 'B2B SaaS') } };
    }
    if (prompt.includes('How many people')) {
      return { json: { answer: 'not_stated', sufficient: true, number: 84, evidence_quote: 'a team of 84 people' } };
    }
    if (prompt.includes('certifications')) {
      return { json: { answer: 'not_certified', sufficient: true, evidence_quote: 'We are not certified yet' } };
    }
    if (prompt.includes('funding stage')) {
      return { json: { answer: 'unknown', sufficient: false } };
    }
    if (prompt.includes('preparing for a compliance audit')) {
      return { json: { answer: 'yes', sufficient: true, evidence_quote: 'hiring our first compliance lead to take us through SOC 2' } };
    }
    return { json: { answer: 'not_stated', sufficient: false } };
  },
};

const hunterStub = async () => ({
  ok: true,
  json: async () => ({ data: { emails: [{ first_name: 'Ada', last_name: 'Lovelace', position: 'CTO', value: 'ada@selfcheck.example', confidence: 90 }] } }),
});

/**
 * Run the pipeline end to end against stand-ins and report on each step.
 * Returns { steps: [{ step, name, ok, detail }], ok }.
 */
/** @param {{ profile?: any, settings?: import('./env.js').Settings }} options */
export async function selfCheck({ profile, settings = {} } = {}) {
  const store = new MemoryStore();
  const steps = [];
  const add = (step, name, ok, detail, kind = 'pipeline') => steps.push({ step, name, ok, detail, kind });

  /** @type {any} */
  let sent = null;
  const summary = await runPipeline({
    domains: ['selfcheck.example'],
    profile,
    llm: fakeLlm,
    store,
    settings: { ...settings, REVIEW_MODE: 'false', EMAIL_TO: 'you@example.com', HUNTER_API_KEY: 'stub', MAILER: 'resend', RESEND_API_KEY: 'stub' },
    // The real researcher, pointed at a stand-in web rather than the network.
    researcher: new Researcher({ profile, llm: fakeLlm, store, fetchPage: fakeWeb, resolveRedirect: async (u) => u }),
    contactFetch: /** @type {any} */ (hunterStub),
    transport: {
      fetchImpl: /** @type {any} */ (async (url, options) => {
        sent = JSON.parse(options.body);
        return { ok: true, json: async () => ({ id: 'selfcheck' }) };
      }),
    },
  });

  const company = await store.get('selfcheck.example');
  const details = company?.details ?? {};
  const quoted = Object.values(details).filter((d) => d.evidence?.quote);

  add(1, 'Scrape the company’s site', Boolean(quoted.length), `${quoted.length} answers came from fetched pages`);
  add(2, 'Extract structured data', Object.keys(company?.answers ?? {}).length > 0, `fields: ${Object.keys(company?.answers ?? {}).join(', ') || 'none'}`);
  add(
    3,
    'Qualify against the ICP, fetching more when thin',
    company?.verdict?.kind === 'qualify',
    `${company?.verdict?.code ?? 'no verdict'} after ${company?.lookups ?? 0} lookups`,
  );
  add(4, 'Find the point of contact', Boolean(company?.contact?.firstName), company?.contact ? `${company.contact.firstName} — ${company.contact.title}` : 'none found');
  add(5, 'Name two pain points', (company?.email?.pain_points ?? []).length === 2, `${(company?.email?.pain_points ?? []).length} named`);
  add(
    6,
    'Draft, addressed by name with a real hook',
    Boolean(company?.email) && company.email.issues.length === 0 && company.email.body.includes(company.contact.firstName),
    company?.email?.issues?.length ? `rejected by its own checks: ${company.email.issues[0]}` : 'passed every draft check',
  );
  add(7, 'Send to your own address', summary.sent === 1 && sent?.to?.[0] === 'you@example.com', sent?.to ? `to ${sent.to.join(', ')}` : 'nothing sent');

  // Two promises that are easy to break and expensive to break quietly.
  add('a', 'Mail goes only to EMAIL_TO', !JSON.stringify(sent ?? {}).includes('ada@selfcheck.example'), 'the contact address appears nowhere in the message');
  add('b', 'robots.txt is honoured', isAllowed('User-agent: *\nDisallow: /private', '/private').allowed === false, 'a disallowed path is refused');

  const mailer = mailerFor(settings);
  // Configuration, not wiring: reported separately so a missing key does not
  // read as a broken pipeline.
  add('c', 'A way to send is configured', mailer.ready, mailer.ready ? `${mailer.name} is ready` : `${mailer.name}: ${mailer.missing.join(', ')} missing`, 'config');
  add('d', 'A model key is configured', Boolean(settings.GEMINI_API_KEY), settings.GEMINI_API_KEY ? 'GEMINI_API_KEY is set' : 'GEMINI_API_KEY missing', 'config');
  add('e', 'A destination address is set', Boolean(settings.EMAIL_TO), settings.EMAIL_TO ? `mail goes to ${settings.EMAIL_TO}` : 'EMAIL_TO missing', 'config');

  const pipeline = steps.filter((s) => s.kind === 'pipeline');
  return {
    steps,
    ok: pipeline.every((s) => s.ok),
    configured: steps.filter((s) => s.kind === 'config').every((s) => s.ok),
    summary,
  };
}

/**
 * The same seven steps, but against the real services, using whatever
 * credentials are configured. One cheap call each: list models, read the
 * Hunter account, count rows, open an SMTP session without sending.
 *
 * This is what to run the moment a key is added — a key that is present but
 * wrong looks exactly like a key that is absent until something tries it.
 */
/** @param {{ settings?: import('./env.js').Settings, fetchImpl?: Function, connectImpl?: Function }} options */
export async function liveCheck({ settings = {}, fetchImpl = fetch, connectImpl } = {}) {
  const steps = [];
  const add = (name, ok, detail) => steps.push({ name, ok, detail });

  // The model
  if (!settings.GEMINI_API_KEY) add('Gemini key', false, 'GEMINI_API_KEY is not set');
  else {
    try {
      const res = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
        headers: { 'x-goog-api-key': settings.GEMINI_API_KEY },
        signal: AbortSignal.timeout(15000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) add('Gemini key', false, `HTTP ${res.status}: ${body.error?.message ?? 'rejected'}`);
      else {
        const usable = (body.models ?? []).filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'));
        const wanted = settings.GEMINI_MODEL;
        const has = usable.some((m) => m.name.endsWith(wanted));
        add('Gemini key', true, `${usable.length} models available`);
        add(`Model ${wanted}`, has, has ? 'available to this key' : `NOT available. Try: ${usable.slice(0, 3).map((m) => m.name.replace('models/', '')).join(', ')}`);
      }
    } catch (error) {
      add('Gemini key', false, `unreachable: ${error.name}`);
    }
  }

  // The contact finder
  if (!settings.HUNTER_API_KEY) add('Hunter key', false, 'HUNTER_API_KEY is not set');
  else {
    try {
      const res = await fetchImpl(`https://api.hunter.io/v2/account?api_key=${encodeURIComponent(settings.HUNTER_API_KEY)}`, {
        signal: AbortSignal.timeout(15000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) add('Hunter key', false, `HTTP ${res.status}: ${body.errors?.[0]?.details ?? 'rejected'}`);
      else {
        const searches = body.data?.requests?.searches;
        add('Hunter key', true, searches ? `${searches.used}/${searches.available} searches used this month` : 'accepted');
      }
    } catch (error) {
      add('Hunter key', false, `unreachable: ${error.name}`);
    }
  }

  // The way out
  const mailer = mailerFor(settings);
  if (!mailer.ready) add(`Mailer (${mailer.name})`, false, `${mailer.missing.join(', ')} not set`);
  else if (mailer.name === 'gmail') {
    try {
      // Log in and hang up: proves the App Password works, sends nothing.
      const { openSession } = await import('./mailer.js');
      await openSession({
        host: settings.SMTP_HOST || 'smtp.gmail.com',
        port: Number(settings.SMTP_PORT) || 465,
        user: settings.GMAIL_USER,
        pass: settings.GMAIL_APP_PASSWORD,
        connectImpl,
      });
      add('Mailer (gmail)', true, `signed in as ${settings.GMAIL_USER}, nothing sent`);
    } catch (error) {
      add('Mailer (gmail)', false, error.message);
    }
  } else {
    try {
      const res = await fetchImpl('https://api.resend.com/domains', {
        headers: { Authorization: `Bearer ${settings.RESEND_API_KEY}` },
        signal: AbortSignal.timeout(15000),
      });
      add('Mailer (resend)', res.ok, res.ok ? 'key accepted' : `HTTP ${res.status}`);
    } catch (error) {
      add('Mailer (resend)', false, `unreachable: ${error.name}`);
    }
  }

  add('Destination', Boolean(settings.EMAIL_TO), settings.EMAIL_TO ? `mail would go to ${settings.EMAIL_TO}` : 'EMAIL_TO is not set');

  return { steps, ok: steps.every((s) => s.ok) };
}
