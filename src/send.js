// Sending. Every email goes to EMAIL_TO — the address you own — and never to
// the contact. This is deliberate, and it is the one rule in this project that
// should outlive every other design decision in it: a tool that finds strangers
// and writes to them unsupervised is a different, much worse tool.
import { env } from './env.js';
import { deliver, mailerFor } from './mailer.js';

export async function sendEmail(company, { store, settings = env, ...transport } = {}) {
  const to = settings.EMAIL_TO?.trim().toLowerCase();
  if (!to) throw new Error('EMAIL_TO is not set. Nothing was sent.');

  const mailer = mailerFor(settings);
  if (!mailer.ready) throw new Error(`Cannot send over ${mailer.name}: ${mailer.missing.join(', ')} not set.`);

  const email = company.email;
  if (!email?.subject || !email?.body) throw new Error('The draft needs a subject and a body.');
  if (email.status === 'sent') return company;
  if (email.status !== 'approved') throw new Error('This draft has not been approved yet.');

  const { id, response } = await deliver({ settings, to, subject: email.subject, body: email.body, ...transport });

  return store.put({
    ...company,
    status: 'sent',
    email: {
      ...email,
      status: 'sent',
      providerId: id,
      sentVia: mailer.name,
      sentTo: to,
      sentAt: new Date().toISOString(),
      providerResponse: response ?? null,
    },
  });
}

/** Approve a draft, optionally with your own edits, ready to send. */
export function approve(company, { subject = company.email?.subject, body = company.email?.body } = {}) {
  if (!subject?.trim() || !body?.trim()) throw new Error('An approved email needs a subject and a body.');

  // Whether you rewrote it is the measurement that matters: a system whose
  // drafts always get rewritten is not saving anybody any time.
  const original = company.email?.originalBody ?? company.email?.body ?? '';
  const edited = body.trim() !== original.trim();

  return { ...company, email: { ...company.email, subject: subject.trim(), body: body.trim(), edited, status: 'approved' } };
}
