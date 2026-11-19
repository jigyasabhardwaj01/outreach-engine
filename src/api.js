// The API, as plain functions from a request to a response. The local server
// and the hosted functions are both thin wrappers around this, so there is one
// implementation of what every route does and what it lets through.
import { authorize, loginResponse, logoutResponse, signedIn, isOpen } from './auth.js';
import { liveCheck } from './selfcheck.js';
import { aliasesUsed } from './env.js';

const ok_ = (body) => ({ status: 200, body });
const ok = ok_;
const fail = (status, error) => ({ status, body: { error } });

/** The host as the browser sees it, behind a proxy or not. */
const hostOf = (headers = {}) => headers['x-forwarded-host'] ?? headers.host;

/**
 * Only our own page may post actions — not some other site in the same
 * browser. Without this, any page you visit could spend your API credits.
 */
export function isSameOrigin(req) {
  const origin = req.headers?.origin;
  const host = hostOf(req.headers);
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function createApi({ actions, store, settings }) {
  return {
    /** Is this deployment actually wired up? Safe to call signed out. */
    async health() {
      const open = isOpen(settings);
      const access = settings.APP_PASSWORD ? (open ? 'public to read, password to act' : 'password') : open ? 'open to anyone' : 'closed';

      const missing = ['DATABASE_URL', 'GEMINI_API_KEY', 'EMAIL_TO'].filter((name) => !settings[name]);
      // Absent on purpose is not the same as missing, but with neither a
      // password nor an explicit opt-in the site cannot serve anybody.
      if (access === 'closed') missing.push('APP_PASSWORD');
      let database = 'not configured';
      if (settings.DATABASE_URL) {
        try {
          database = `ok, ${await store.count()} companies`;
        } catch (error) {
          database = `unreachable: ${error.message}`;
        }
      }
      return ok({ ready: missing.length === 0, missing, access, database, readUnderOtherNames: aliasesUsed });
    },

    /**
     * Ask every configured service one cheap question. This is the only way
     * to tell a key that is wrong from a key that is missing, and a hosted
     * deployment is exactly where you cannot just run the CLI.
     */
    async selfcheck() {
      const { steps, ok } = await liveCheck({ settings });
      return ok_({ ok, steps, readUnderOtherNames: aliasesUsed });
    },

    async login(req) {
      return loginResponse(req.body?.password, settings);
    },

    async logout() {
      return logoutResponse();
    },

    async state(req) {
      const allowed = authorize(req, settings);
      if (!allowed.ok) return fail(allowed.status, allowed.error);

      return ok({
        companies: await store.all(),
        emailTo: settings.EMAIL_TO || null,
        reviewMode: String(settings.REVIEW_MODE ?? 'true').toLowerCase() !== 'false',
        // The page needs to know whether to offer the buttons or a sign-in.
        signedIn: signedIn(req, settings) || !settings.APP_PASSWORD,
        needsPassword: Boolean(settings.APP_PASSWORD),
        ready: Boolean(settings.GEMINI_API_KEY),
      });
    },

    async action(req) {
      if (req.method !== 'POST') return fail(405, 'Use POST.');
      if (!isSameOrigin(req)) return fail(403, 'Not allowed from there.');

      // Acting is gated more tightly than reading: every action either spends
      // API credits, writes to the store, or sends mail.
      const allowed = authorize(req, settings, { write: true });
      if (!allowed.ok) return fail(allowed.status, allowed.error);

      const { action, ...args } = req.body ?? {};
      if (!Object.hasOwn(actions, action)) return fail(400, `No such action: ${action}`);

      try {
        const result = await actions[action](args);
        // Actions mostly return the saved company, which the page re-reads from
        // /api/state anyway; only small summaries are worth sending back.
        return ok({ ok: true, ...(result && typeof result === 'object' && !result.domain ? result : {}) });
      } catch (error) {
        return fail(500, error.message);
      }
    },
  };
}
