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

export function loadEnv({ root = ROOT, processEnv = process.env } = {}) {
  const file = path.join(root, '.env');
  const fromFile = fs.existsSync(file) ? parseEnvFile(fs.readFileSync(file, 'utf8')) : {};
  const env = { ...DEFAULTS, ...fromFile };
  // A platform variable overrides the file, but an empty one does not erase it.
  for (const [key, value] of Object.entries(processEnv)) if (value !== '' && value !== undefined) env[key] = value;
  return env;
}

export const env = loadEnv();

export const flag = (name) => String(env[name] ?? '').toLowerCase() === 'true';

export function required(name, why) {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set${why ? ` (${why})` : ''}. Add it to .env.`);
  return value;
}
