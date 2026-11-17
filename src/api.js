// The API, as plain functions from a request to a response. The local server
// and the hosted functions are both thin wrappers around this, so there is one
// implementation of what every route does and what it lets through.
import { authorize, loginResponse, logoutResponse } from './auth.js';

const ok = (body) => ({ status: 200, body });
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
      const missing = ['DATABASE_URL', 'APP_PASSWORD', 'GEMINI_API_KEY', 'EMAIL_TO'].filter((name) => !settings[name]);
      let database = 'not configured';
      if (settings.DATABASE_URL) {
        try {
          database = `ok, ${await store.count()} companies`;
        } catch (error) {
          database = `unreachable: ${error.message}`;
        }
      }
      return ok({ ready: missing.length === 0, missing, database });
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
        emailTo: settings.EMAIL_TO ?? null,
        reviewMode: String(settings.REVIEW_MODE ?? 'true').toLowerCase() !== 'false',
      });
    },

    async action(req) {
      if (req.method !== 'POST') return fail(405, 'Use POST.');
      if (!isSameOrigin(req)) return fail(403, 'Not allowed from there.');

      const allowed = authorize(req, settings);
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
