// Sending the mail.
//
// Two ways out: Gmail over SMTP, and Resend's API. Gmail is the one the brief
// asks for; Resend stays because it needs no account password and is easier to
// test against. Whichever is used, the recipient is EMAIL_TO and nobody else.
import tls from 'node:tls';

const CRLF = '\r\n';

/** Fold a header value so a long subject cannot break the message. */
const header = (name, value) => `${name}: ${String(value).replace(/[\r\n]+/g, ' ')}`;

/** RFC 2047, so a subject with an em dash or a name with an accent survives. */
const encodeHeader = (value) =>
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}=?`.replace(/=\?$/, '?=');

/**
 * A line starting with a lone dot ends the DATA block early, so it is doubled.
 * Without this, an email whose body has ".\n" on its own line is silently
 * truncated at that point — and the sender sees a success.
 */
export const dotStuff = (text) => text.split(/\r?\n/).map((line) => (line.startsWith('.') ? `.${line}` : line)).join(CRLF);

export function buildMessage({ from, fromName, to, subject, body, date = new Date() }) {
  const sender = fromName ? `${encodeHeader(fromName)} <${from}>` : from;
  return [
    header('From', sender),
    header('To', to),
    header('Subject', encodeHeader(subject)),
    header('Date', date.toUTCString()),
    header('MIME-Version', '1.0'),
    header('Content-Type', 'text/plain; charset=utf-8'),
    '',
    dotStuff(body),
    '.',
  ].join(CRLF);
}

/** An SMTP reply is one or more lines; only the last has a space after the code. */
export function parseReply(text) {
  const lines = String(text ?? '').split(/\r?\n/).filter(Boolean);
  const last = lines.at(-1) ?? '';
  // No line at all means no code. Zero would compare as a real one.
  const code = /^\d{3}/.test(last) ? Number(last.slice(0, 3)) : Number.NaN;
  return { code, text: lines.join(' ').trim() };
}

const connect = (host, port) =>
  new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host }, () => resolve(socket));
    socket.setEncoding('utf8');
    socket.once('error', reject);
  });

/** Log in and hang up. Proves the credentials work without sending anything. */
export async function openSession({ host, port = 465, user, pass, connectImpl = connect, timeoutMs = 20000 }) {
  return sendSmtp({ host, port, user, pass, connectImpl, timeoutMs, loginOnly: true });
}

/**
 * Enough SMTP to post one message: greeting, EHLO, login, envelope, data.
 *
 * `connectImpl` is injected so the conversation can be tested against a fake
 * socket. Everything is driven off the reply codes rather than timing.
 */
export async function sendSmtp({ host, port = 465, user, pass, from, fromName, to, subject, body, connectImpl = connect, timeoutMs = 20000, loginOnly = false }) {
  const socket = await connectImpl(host, port);
  let buffer = '';
  let waiting = null;

  /**
   * A reply is complete when the last line starts with its code and a space;
   * a hyphen (250-STARTTLS) means more lines are coming.
   */
  const complete = (text) => {
    if (!/\r?\n$/.test(text)) return null;
    const last = text.trimEnd().split(/\r?\n/).at(-1) ?? '';
    return /^\d{3} /.test(last) ? parseReply(text) : null;
  };

  // Checked both on arrival and the moment someone starts waiting: the
  // greeting usually lands before the first read is registered, and waiting
  // only on arrival would hang there forever.
  const flush = () => {
    if (!waiting) return;
    const reply = complete(buffer);
    if (!reply) return;
    buffer = '';
    const { resolve } = waiting;
    waiting = null;
    resolve(reply);
  };

  socket.on('data', (chunk) => {
    buffer += chunk;
    flush();
  });

  const read = () =>
    new Promise((resolve, reject) => {
      waiting = { resolve, reject };
      flush();
      setTimeout(() => waiting && reject(new Error('The mail server stopped replying.')), timeoutMs).unref?.();
    });

  const say = async (line, expected) => {
    if (line !== null) socket.write(line + CRLF);
    const reply = await read();
    if (expected && !expected.includes(reply.code)) throw new Error(`SMTP ${reply.code}: ${reply.text}`);
    return reply;
  };

  try {
    await say(null, [220]);
    await say('EHLO outreach-engine', [250]);
    await say('AUTH LOGIN', [334]);
    await say(Buffer.from(user).toString('base64'), [334]);
    // A wrong app password lands here, so name that rather than "SMTP 535".
    const authed = await say(Buffer.from(pass).toString('base64'), null);
    if (authed.code !== 235) {
      throw new Error(
        authed.code === 535
          ? 'Gmail rejected the username or app password. A normal account password will not work: create an App Password.'
          : `SMTP ${authed.code}: ${authed.text}`,
      );
    }

    if (loginOnly) {
      await say('QUIT', [221]).catch(() => {});
      return { id: null, response: 'signed in' };
    }

    await say(`MAIL FROM:<${from}>`, [250]);
    await say(`RCPT TO:<${to}>`, [250, 251]);
    await say('DATA', [354]);
    const accepted = await say(buildMessage({ from, fromName, to, subject, body }), [250]);
    await say('QUIT', [221]).catch(() => {});

    return { id: queueId(accepted.text), response: accepted.text };
  } finally {
    socket.end?.();
  }
}

/**
 * Gmail's acceptance reads "250 2.0.0 OK  1763000000 abc123 - gsmtp": the
 * queue id is the token with letters in it, not the timestamp beside it.
 */
export function queueId(text) {
  const tokens = String(text ?? '').match(/\b[0-9A-Za-z-]{10,}\b/g) ?? [];
  return tokens.filter((token) => /[a-zA-Z]/.test(token)).at(-1) ?? null;
}

async function sendViaResend({ settings, from, fromName, to, subject, body, fetchImpl }) {
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `outreach-${to}-${subject}`.slice(0, 256),
    },
    body: JSON.stringify({ from: fromName ? `${fromName} <${from}>` : from, to: [to], subject, text: body }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${data.message ?? 'no details'}`);
  return { id: data.id ?? null, response: 'accepted by Resend' };
}

/** Which way out is configured, and whether it can actually be used. */
export function mailerFor(settings) {
  const chosen = (settings.MAILER ?? (settings.GMAIL_APP_PASSWORD ? 'gmail' : 'resend')).toLowerCase();
  if (chosen === 'gmail') {
    const missing = ['GMAIL_USER', 'GMAIL_APP_PASSWORD'].filter((name) => !settings[name]);
    return { name: 'gmail', ready: missing.length === 0, missing };
  }
  if (chosen === 'resend') {
    const missing = ['RESEND_API_KEY'].filter((name) => !settings[name]);
    return { name: 'resend', ready: missing.length === 0, missing };
  }
  return { name: chosen, ready: false, missing: [`MAILER must be "gmail" or "resend", not "${chosen}"`] };
}

/** Send one message by whichever route is configured. */
export async function deliver({ settings, to, subject, body, fetchImpl = fetch, connectImpl = connect }) {
  const mailer = mailerFor(settings);
  if (!mailer.ready) throw new Error(`Cannot send: ${mailer.missing.join(', ')} not set.`);

  const fromName = settings.SENDER_NAME || null;

  if (mailer.name === 'gmail') {
    return sendSmtp({
      host: settings.SMTP_HOST || 'smtp.gmail.com',
      port: Number(settings.SMTP_PORT) || 465,
      user: settings.GMAIL_USER,
      pass: settings.GMAIL_APP_PASSWORD,
      // Gmail rewrites From to the authenticated account anyway, so do not pretend.
      from: settings.GMAIL_USER,
      fromName,
      to,
      subject,
      body,
      connectImpl,
    });
  }
  return sendViaResend({ settings, from: settings.EMAIL_FROM, fromName, to, subject, body, fetchImpl });
}
