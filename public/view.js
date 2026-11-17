// The page's thinking, with no DOM in it: which companies belong in which
// tab, what a button should say, whether it may be pressed. Kept separate so
// it can be tested without a browser — the rendering in app.js is then only
// about putting these answers on screen.

/** The review stages, in the order the work flows through them. */
export const STAGES = [
  {
    id: 'review',
    name: 'To review',
    blurb: 'Researched, waiting for you to say yes or no.',
    empty: 'Nothing waiting. Research some shortlisted companies and they arrive here.',
    has: (c) => c.status === 'researched' && !c.decision,
  },
  {
    id: 'emails',
    name: 'Emails',
    blurb: 'Drafts to approve, edit or reject.',
    empty: 'No drafts yet. Approving a company writes one.',
    has: (c) => ['drafted', 'no_contact', 'approved', 'contact_found'].includes(c.status),
  },
  {
    id: 'waiting',
    name: 'Shortlist',
    blurb: 'Found, not yet researched.',
    empty: 'The shortlist is empty. Find companies to fill it.',
    has: (c) => ['shortlisted', 'researching'].includes(c.status),
  },
  { id: 'sent', name: 'Sent', blurb: 'Gone to your own address.', empty: 'Nothing sent yet.', has: (c) => c.status === 'sent' },
  {
    id: 'out',
    name: 'Rejected',
    blurb: 'Ruled out, with the reason kept.',
    empty: 'Nothing rejected yet.',
    has: (c) => ['rejected', 'email_rejected'].includes(c.status),
  },
];

export const stageById = (id) => STAGES.find((stage) => stage.id === id) ?? STAGES[0];

export const companiesIn = (companies, stageId) => Object.values(companies ?? {}).filter(stageById(stageId).has);

export const countsByStage = (companies) =>
  Object.fromEntries(STAGES.map((stage) => [stage.id, Object.values(companies ?? {}).filter(stage.has).length]));

/** The first tab with something in it, so the page opens where the work is. */
export function firstBusyStage(companies) {
  const counts = countsByStage(companies);
  return (STAGES.find((stage) => counts[stage.id] > 0) ?? STAGES[0]).id;
}

export const awaitingResearch = (companies) => companiesIn(companies, 'waiting').length;

/**
 * May this button be pressed, and if not, why not?
 *
 * The reason is shown to the person rather than kept as a disabled button
 * with no explanation, which is the usual way this goes wrong.
 */
export function actionState({ signedIn, ready, busy, needs = 'keys' }) {
  if (busy) return { enabled: false, reason: 'Something else is running.' };
  if (!signedIn) return { enabled: false, reason: 'Sign in to run this — it spends API credits or sends mail.' };
  if (needs === 'keys' && !ready) return { enabled: false, reason: 'No Gemini key is configured on this deployment.' };
  return { enabled: true, reason: '' };
}

export const verdictWording = (verdict = {}) =>
  verdict.kind === 'qualify' ? { label: 'Worth writing to', tone: 'qualify' } : { label: 'Not a fit', tone: 'reject' };

/** "northwind.io · 2 Sep 2026", or just the host when the source is undated. */
export function sourceLabel(evidence) {
  if (!evidence?.url) return null;
  let host = evidence.url;
  try {
    host = new URL(evidence.url).hostname.replace(/^www\./, '');
  } catch {
    // Not a URL we can parse; show it as it came.
  }
  return evidence.sourceDate ? `${host} · ${formatDate(evidence.sourceDate)}` : host;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDate(value) {
  if (!value) return '';
  const [year, month, day] = String(value).slice(0, 10).split('-');
  if (!year) return String(value);
  if (!month) return year;
  return [day && String(Number(day)), MONTHS[Number(month) - 1], year].filter(Boolean).join(' ');
}

/** What an answer should read as in the table: a number stays a number. */
export function answerWording(detail) {
  const answer = typeof detail.answer === 'number' ? String(detail.answer) : String(detail.answer ?? '').replace(/_/g, ' ');
  return detail.value ? `${answer} (${detail.value})` : answer;
}

export function evidenceWording(detail) {
  if (!detail.evidence) return { kind: 'none', text: 'nothing found' };
  if (detail.evidence.kind === 'absence') return { kind: 'absence', text: 'not mentioned anywhere we looked' };
  return { kind: 'quote', quote: detail.evidence.quote, source: sourceLabel(detail.evidence), url: detail.evidence.url };
}

export const wordCount = (text) => String(text ?? '').trim().split(/\s+/).filter(Boolean).length;

/**
 * An unset EMAIL_TO arrives as an empty string as readily as null, and
 * "Send to" with nothing after it is worse than saying where it goes.
 */
export const sendLabel = (emailTo) => `Send to ${emailTo?.trim() ? emailTo.trim() : 'your own address'}`;

/** A one-line summary of a company for the collapsed rows. */
export function summaryLine(company) {
  if (company.email?.sentAt) return `Sent to ${company.email.sentTo} on ${formatDate(company.email.sentAt)}`;
  if (company.verdict?.reason) return company.verdict.reason;
  return String(company.status ?? '').replace(/_/g, ' ');
}

/** Progress through one company's questions, for the shortlist rows. */
export function researchProgress(company) {
  const answered = Object.keys(company.progress?.answers ?? company.answers ?? {}).length;
  if (company.status === 'shortlisted') return { answered: 0, text: 'not started' };
  return { answered, text: answered === 1 ? '1 question answered' : `${answered} questions answered` };
}
