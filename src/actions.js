// Everything the review page (or the CLI) can ask for. One place, so the two
// front ends can never drift apart on what an action actually does.
import { discover, addDomains } from './discover.js';
import { Researcher } from './research.js';
import { findContact, manualContact } from './contacts.js';
import { draftEmail } from './draft.js';
import { sendEmail, approve } from './send.js';
import { nextQuestion } from './assess.js';

export function createActions({ profile, llm, store, settings, researcher = new Researcher({ profile, llm, store }) }) {
  const load = async (domain) => {
    const company = await store.get(domain);
    if (!company) throw new Error(`No such company: ${domain}`);
    return company;
  };

  // Once a company is approved, finding the contact and drafting belong
  // together: neither is any use alone, and both can be interrupted.
  const contactAndDraft = async (domain) => {
    const company = await findContact(await load(domain), { profile, store, apiKey: settings.HUNTER_API_KEY });
    if (!company.contact) return company;
    return draftEmail(company, { profile, llm, store });
  };

  return {
    /** Fill the shortlist from the profile's discovery searches. */
    discover: async ({ limit = 10 } = {}) => {
      const added = await discover({ profile, llm, store, limit: Math.min(Number(limit) || 10, 50) });
      return { added: added.length };
    },

    /** Shortlist domains you already know you want. */
    add: async ({ domains = [] }) => ({ added: (await addDomains({ profile, store, domains })).length }),

    /**
     * Answer exactly one question. The page calls this in a loop, so no single
     * request runs long, and closing the tab halfway costs you one question.
     */
    researchStep: async ({ domain }) => {
      const company = await load(domain);
      if (!['shortlisted', 'researching'].includes(company.status)) return { done: true };

      const saved = await researcher.step(company);
      if (saved.status !== 'researching') return { done: true, verdict: saved.verdict };
      return { done: false, next: nextQuestion(profile, saved.progress.answers)?.label ?? null };
    },

    /** Look again at a company you have already researched. */
    researchAgain: async ({ domain }) => {
      const { progress, answers, details, verdict, handoff, timing, ...rest } = await load(domain);
      return store.put({ ...rest, status: 'researching' });
    },

    /** Your first checkpoint: is this company worth writing to at all? */
    decide: async ({ domain, decision }) => {
      const company = await load(domain);
      if (decision === 'reject') return store.put({ ...company, decision: 'rejected', status: 'rejected' });
      if (decision !== 'approve') throw new Error('A decision is "approve" or "reject".');

      await store.put({ ...company, decision: 'approved', status: 'approved' });
      return contactAndDraft(domain);
    },

    /** Pick up an approved company whose lookup or draft was interrupted. */
    resume: async ({ domain }) => {
      const company = await load(domain);
      if (!['approved', 'contact_found'].includes(company.status)) return company;
      return contactAndDraft(domain);
    },

    /** When Hunter has nothing, or has the wrong person. */
    setContact: async ({ domain, firstName, lastName, title }) => {
      const company = await store.put({ ...(await load(domain)), contact: manualContact({ firstName, lastName, title }), status: 'contact_found' });
      return draftEmail(company, { profile, llm, store });
    },

    /** Write it again, with your notes on what was wrong. */
    redraft: async ({ domain, feedback = null }) => {
      const company = await load(domain);
      return draftEmail({ ...company, rewrites: (company.rewrites ?? 0) + 1 }, { profile, llm, store, feedback });
    },

    rejectEmail: async ({ domain }) => {
      const company = await load(domain);
      return store.put({ ...company, status: 'email_rejected', email: { ...company.email, status: 'rejected' } });
    },

    /** Your second checkpoint. Edits you made on the page win. */
    send: async ({ domain, subject, body }) => {
      const company = await load(domain);
      return sendEmail(approve(company, { subject, body }), { store, settings });
    },
  };
}
