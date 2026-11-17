// The login. One shared password, because there is one of you.
//
// This exists because the thing behind it spends money and sends mail. A
// hosted copy with no gate is a stranger's API budget, so when the app is
// hosted and no password is configured, it refuses to serve anything rather
// than defaulting to open.
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

const COOKIE = 'oe_session';
const WEEK = 60 * 60 * 24 * 7;

/** The cookie value for a password: anyone who knows the password can mint it, nobody else can. */
export const tokenFor = (password) => createHmac('sha256', password).update('outreach-engine session v1').digest('hex');

export function sameSecret(a = '', b = '') {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  // Compare in constant time, and do it on equal-length buffers so the
  // comparison itself cannot leak the length.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export const parseCookies = (header = '') =>
  Object.fromEntries(
    String(header)
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        return index === -1 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );

/**
 * Who is allowed in.
 *
 * - hosted with APP_PASSWORD     -> whoever has the cookie
 * - hosted with PUBLIC_ACCESS    -> everyone, on purpose (see below)
 * - hosted with neither          -> nobody, with an explanation
 * - local with no APP_PASSWORD   -> you, because it is your own machine
 *
 * PUBLIC_ACCESS has to be set deliberately. An open deployment is a
 * defensible choice; becoming open because a password went missing is not,
 * so a lost APP_PASSWORD closes the site rather than unlocking it.
 */
export function authorize(req, settings) {
  const password = settings.APP_PASSWORD;
  const hosted = Boolean(settings.VERCEL);
  const open = String(settings.PUBLIC_ACCESS ?? '').toLowerCase() === 'true';

  if (!password) {
    if (hosted && !open) {
      return { ok: false, status: 503, error: 'This deployment has no APP_PASSWORD set, so it is closed. Set one, or set PUBLIC_ACCESS=true to open it deliberately.' };
    }
    return { ok: true };
  }

  const cookies = parseCookies(req.headers?.cookie);
  if (sameSecret(cookies[COOKIE], tokenFor(password))) return { ok: true };
  return { ok: false, status: 401, error: 'Sign in first.' };
}

export function loginResponse(given, settings) {
  const password = settings.APP_PASSWORD;
  if (!password) return { status: 503, body: { error: 'No APP_PASSWORD is set on this deployment.' } };
  if (!sameSecret(given ?? '', password)) return { status: 401, body: { error: 'That password is not right.' } };

  const flags = ['Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${WEEK}`, settings.VERCEL ? 'Secure' : ''].filter(Boolean);
  return {
    status: 200,
    headers: { 'Set-Cookie': `${COOKIE}=${tokenFor(password)}; ${flags.join('; ')}` },
    body: { ok: true },
  };
}

export const logoutResponse = () => ({
  status: 200,
  headers: { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` },
  body: { ok: true },
});

/** A password to start with, when nobody has chosen one. */
export const suggestPassword = () => randomUUID().replaceAll('-', '').slice(0, 20);
