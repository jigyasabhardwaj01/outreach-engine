// The whole thing, end to end, over a list of domains.
//
// The seven steps of the brief: scrape, extract, qualify (with the loop),
// find the contact, name the pain points, draft, send. One company failing
// must never stop the run — the reason is recorded and the next one starts.
import { addDomains } from './discover.js';
import { Researcher } from './research.js';
import { findContact } from './contacts.js';
import { draftEmail } from './draft.js';
import { sendEmail, approve } from './send.js';

const blank = () => ({ processed: 0, qualified: 0, rejected: 0, handedBack: 0, contacted: 0, drafted: 0, sent: 0, failures: [] });

/**
 * @param autoSend  send without a human saying yes. Off unless REVIEW_MODE is
 *                  explicitly false: the brief wants the run to be hands-off,
 *                  the deck wants a person between a draft and an inbox, and
 *                  the setting is where those two meet.
 */
export async function runPipeline({
  domains = [],
  profile,
  llm,
  store,
  settings,
  researcher = new Researcher({ profile, llm, store }),
  autoSend = String(settings?.REVIEW_MODE ?? 'true').toLowerCase() === 'false',
  onProgress = () => {},
  transport = {},
  contactFetch = fetch,
}) {
  const summary = blank();

  const added = domains.length ? await addDomains({ profile, store, domains }) : [];
  const waiting = Object.values(await store.all()).filter((c) => ['shortlisted', 'researching'].includes(c.status));
  const targets = [...new Set([...added, ...waiting].map((c) => c.domain))];

  for (const [index, domain] of targets.entries()) {
    const label = `${domain} (${index + 1}/${targets.length})`;
    try {
      onProgress(`${label}: researching`);
      let company = await researcher.run(await store.get(domain), onProgress);
      summary.processed++;

      if (company.status === 'manual_review') {
        summary.handedBack++;
        onProgress(`${label}: handed back — ${company.handoff.reason}`);
        continue;
      }

      if (company.verdict?.kind !== 'qualify') {
        summary.rejected++;
        await store.put({ ...company, decision: 'rejected', status: 'rejected' });
        onProgress(`${label}: ${company.verdict?.reason ?? 'not a fit'}`);
        continue;
      }

      summary.qualified++;
      onProgress(`${label}: qualified — ${company.verdict.reason}`);

      company = await findContact(await store.put({ ...company, decision: 'approved', status: 'approved' }), {
        profile,
        store,
        apiKey: settings?.HUNTER_API_KEY,
        fetchImpl: contactFetch,
      });
      if (!company.contact) {
        summary.failures.push({ domain, step: 'contact', reason: 'no suitable contact found' });
        onProgress(`${label}: no contact found`);
        continue;
      }
      summary.contacted++;

      company = await draftEmail(company, { profile, llm, store });
      summary.drafted++;

      if (company.email.issues.length) {
        summary.failures.push({ domain, step: 'draft', reason: company.email.issues.join(' ') });
        onProgress(`${label}: draft kept for review — ${company.email.issues[0]}`);
        continue;
      }
      if (!autoSend) {
        onProgress(`${label}: drafted, waiting for you to approve`);
        continue;
      }

      await sendEmail(approve(company), { store, settings, ...transport });
      summary.sent++;
      onProgress(`${label}: sent to ${settings.EMAIL_TO}`);
    } catch (error) {
      // Degrade gracefully: record which step broke and carry on.
      summary.failures.push({ domain, step: 'run', reason: error.message });
      onProgress(`${label}: failed — ${error.message}`);
    }
  }

  return summary;
}

export const describeRun = (summary) =>
  [
    `${summary.processed} processed`,
    `${summary.qualified} qualified`,
    `${summary.rejected} ruled out`,
    summary.handedBack ? `${summary.handedBack} handed back` : null,
    `${summary.drafted} drafted`,
    `${summary.sent} sent`,
    summary.failures.length ? `${summary.failures.length} failed` : null,
  ]
    .filter(Boolean)
    .join(', ');
