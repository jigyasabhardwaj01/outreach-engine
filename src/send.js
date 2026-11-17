// Sending. Every email goes to EMAIL_TO — the address you own — and never to
// the contact. This is deliberate, and it is the one rule in this project that
// should outlive every other design decision in it: a tool that finds strangers
// and writes to them unsupervised is a different, much worse tool.
import { env } from './env.js';

export async function sendEmail(company, { store, settings = env, fetchImpl = fetch } = {}) {
  const to = settings.EMAIL_TO?.trim().toLowerCase();
  if (!to) throw new Error('EMAIL_TO is not set. Nothing was sent.');
  if (!settings.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set. Nothing was sent.');

  const email = company.email;
  if (!email?.subject || !email?.body) throw new Error('The draft needs a subject and a body.');
  if (email.status === 'sent') return company;
  if (email.status !== 'approved') throw new Error('This draft has not been approved yet.');

  const from = settings.SENDER_NAME ? `${settings.SENDER_NAME} <${settings.EMAIL_FROM}>` : settings.EMAIL_FROM;

  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      // Pressing send twice should not send twice.
      'Idempotency-Key': `outreach-${company.domain}-${to}-${email.subject}`.slice(0, 256),
    },
    body: JSON.stringify({ from, to: [to], subject: email.subject, text: email.body }),
    signal: AbortSignal.timeout(30000),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${data.message ?? 'no details'}`);

  return store.put({
    ...company,
    status: 'sent',
    email: { ...email, status: 'sent', providerId: data.id ?? null, sentTo: to, sentAt: new Date().toISOString() },
  });
}

/** Approve a draft, optionally with your own edits, ready to send. */
export function approve(company, { subject = company.email?.subject, body = company.email?.body } = {}) {
  if (!subject?.trim() || !body?.trim()) throw new Error('An approved email needs a subject and a body.');
  return { ...company, email: { ...company.email, subject: subject.trim(), body: body.trim(), status: 'approved' } };
}
