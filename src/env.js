// Settings. On your machine they come from .env; in a hosted environment they
// come from the platform's own variables, which always win over the file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  GEMINI_MODEL: 'gemini-3.8-flash',
  GEMINI_MIN_GAP_MS: '1000',
  EMAIL_FROM: 'onboarding@resend.dev',
  REVIEW_MODE: 'true',
  PORT: '3000',
};

// KEY=value, one per line. A value may be quoted; everything after # on its own
// line is a comment. Deliberately small: no multi-line values, no interpolation.
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = value.match(/^(['"])([\s\S]*)\1$/);
    value = quoted ? quoted[2] : value.replace(/\s+#.*$/, '').trim();
    out[m[1]] = value;
  }
  return out;
}

/**
 * The same setting under the names people actually type.
 *
 * Environment variable names are case-sensitive, so GEMINI_API_KEY pasted in
 * as Gemini_api_key is simply invisible — and the app reports the key as
 * missing while the dashboard plainly shows it there. That is a miserable ten
 * minutes to debug, and costs nothing to prevent.
 */
const ALIASES = {
  HUNTERIO_API_KEY: 'HUNTER_API_KEY',
  HUNTER_IO_API_KEY: 'HUNTER_API_KEY',
  HUNTER_KEY: 'HUNTER_API_KEY',
  GEMINI_KEY: 'GEMINI_API_KEY',
  GOOGLE_API_KEY: 'GEMINI_API_KEY',
  GOOGLE_GEMINI_API_KEY: 'GEMINI_API_KEY',
  GMAIL_PASSWORD: 'GMAIL_APP_PASSWORD',
  GMAIL_APP_PASSWORD_: 'GMAIL_APP_PASSWORD',
  MAIL_TO: 'EMAIL_TO',
  TO_EMAIL: 'EMAIL_TO',
  RESEND_KEY: 'RESEND_API_KEY',
  POSTGRES_URL: 'DATABASE_URL',
};

export const canonicalName = (name) => {
  const upper = String(name).toUpperCase();
  return ALIASES[upper] ?? upper;
};

/** Which settings were found under a name other than their own. */
export const aliasesUsed = [];

export function loadEnv({ root = ROOT, processEnv = process.env } = {}) {
  const file = path.join(root, '.env');
  const fromFile = fs.existsSync(file) ? parseEnvFile(fs.readFileSync(file, 'utf8')) : {};
  const env = { ...DEFAULTS };
  const noted = [];

  const take = (source) => {
    // Normalised names first, exact names second, so an exactly-named value
    // always wins over one that had to be guessed at.
    for (const [key, value] of Object.entries(source)) {
      if (value === '' || value === undefined) continue;
      const name = canonicalName(key);
      if (name !== key) noted.push({ found: key, read_as: name });
      env[name] = value;
    }
    for (const [key, value] of Object.entries(source)) {
      if (value === '' || value === undefined) continue;
      env[key] = value;
    }
  };

  take(fromFile);
  take(processEnv);

  aliasesUsed.length = 0;
  aliasesUsed.push(...noted.filter((n) => Object.hasOwn(env, n.read_as)));
  return env;
}

export const env = loadEnv();

export const flag = (name) => String(env[name] ?? '').toLowerCase() === 'true';

export function required(name, why) {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set${why ? ` (${why})` : ''}. Add it to .env.`);
  return value;
}
