// Where companies are kept. The pipeline only ever sees the four methods on a
// store, so a different backing (Postgres, Supabase, a test double) is a new
// class here and no change anywhere else.
import fs from 'node:fs';
import path from 'node:path';
import { env, ROOT } from './env.js';
import { NeonStore } from './store-neon.js';

const stamp = (company) => ({ ...company, updatedAt: new Date().toISOString() });

export class MemoryStore {
  constructor(seed = {}) {
    this.rows = new Map(Object.entries(seed));
  }

  async all() {
    return Object.fromEntries(this.rows);
  }

  async get(domain) {
    return this.rows.get(domain);
  }

  async put(company) {
    // The same rule as the other two stores. A test double that accepts what
    // production refuses is a test double that hides the bug it was meant
    // to catch.
    if (!company?.domain) throw new Error('A company needs a domain.');
    const saved = stamp(company);
    this.rows.set(saved.domain, saved);
    return saved;
  }

  async has(domain) {
    return this.rows.has(domain);
  }

  async count() {
    return this.rows.size;
  }
}

export class JsonStore {
  constructor(file = path.join(ROOT, 'data', 'companies.json')) {
    this.file = file;
  }

  #read() {
    if (!fs.existsSync(this.file)) return {};
    const text = fs.readFileSync(this.file, 'utf8').trim();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`${this.file} is not valid JSON (${error.message}). Fix or delete it.`);
    }
  }

  // Write to a neighbouring file and rename it over the real one, so a crash
  // halfway through can never leave a half-written store behind.
  #write(all) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(all, null, 2)}\n`);
    try {
      fs.renameSync(temporary, this.file);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  }

  async all() {
    return this.#read();
  }

  async get(domain) {
    return this.#read()[domain];
  }

  async put(company) {
    if (!company?.domain) throw new Error('A company needs a domain.');
    const saved = stamp(company);
    const all = this.#read();
    all[saved.domain] = saved;
    this.#write(all);
    return saved;
  }

  async has(domain) {
    return Object.hasOwn(this.#read(), domain);
  }

  async count() {
    return Object.keys(this.#read()).length;
  }
}

/**
 * Postgres when a DATABASE_URL is set, a file otherwise.
 *
 * A hosted deployment has no disk that survives a request, so there the file
 * store is not a fallback but a bug: say so rather than silently losing work.
 */
export function createStore(settings = env) {
  if (settings.DATABASE_URL) return new NeonStore({ url: settings.DATABASE_URL });
  if (settings.VERCEL) throw new Error('DATABASE_URL is not set. A hosted deployment cannot use the file store.');
  return new JsonStore(path.join(settings.DATA_DIR || path.join(ROOT, 'data'), 'companies.json'));
}
