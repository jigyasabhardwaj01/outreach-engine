// Shared by every function in this folder. Vercel ignores files whose name
// starts with an underscore, so this is not a route of its own.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { env, ROOT } from '../src/env.js';
import { createStore } from '../src/store.js';
import { Gemini } from '../src/llm.js';
import { createActions } from '../src/actions.js';
import { createApi } from '../src/api.js';

let cached = null;

// Built once per warm instance: the profile import and the store are the same
// for every request this instance will ever serve.
async function api() {
  if (cached) return cached;

  const file = env.PROFILE || 'profiles/compliance-saas.js';
  const profile = (await import(pathToFileURL(path.resolve(ROOT, file)).href)).default;
  const store = createStore(env);
  const llm = new Gemini();

  cached = createApi({ actions: createActions({ profile, llm, store, settings: env }), store, settings: env });
  return cached;
}

export async function route(name, req, res) {
  try {
    const { status, body, headers = {} } = await (await api())[name]({
      method: req.method,
      headers: req.headers,
      body: typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {}),
    });

    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  } catch (error) {
    // A failure building the API at all — a missing DATABASE_URL, a broken
    // profile — would otherwise surface as an unexplained 500.
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: error.message }));
  }
}
