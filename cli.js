#!/usr/bin/env node
// node cli.js review              Open the review page (the normal way to use this)
// node cli.js discover 10         Fill the shortlist from the profile's searches
// node cli.js add acme.com b.io   Shortlist companies you already know
// node cli.js research            Research everything shortlisted
// node cli.js doctor              Check the settings and the API keys
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { env, ROOT } from './src/env.js';
import { createStore } from './src/store.js';
import { Gemini } from './src/llm.js';
import { createActions } from './src/actions.js';
import { Researcher } from './src/research.js';
import { startServer } from './src/server.js';

const say = (message) => console.log(message);

async function loadProfile() {
  const file = env.PROFILE || 'profiles/compliance-saas.js';
  try {
    return (await import(pathToFileURL(path.resolve(ROOT, file)).href)).default;
  } catch (error) {
    throw new Error(`Could not load the profile at ${file}: ${error.message}`);
  }
}

async function context() {
  const profile = await loadProfile();
  const store = createStore(env);
  const llm = new Gemini();
  return { profile, store, llm, settings: env, actions: createActions({ profile, llm, store, settings: env }) };
}

const WAITING = ['shortlisted', 'researching'];

const commands = {
  async review() {
    const ctx = await context();
    say(`Profile: ${ctx.profile.seller.company ?? ctx.profile.seller.product}`);
    say(env.EMAIL_TO ? `Approved emails go to ${env.EMAIL_TO}, and nowhere else.` : 'EMAIL_TO is not set, so nothing can be sent yet.');
    await startServer(ctx);
  },

  async discover([count]) {
    const { actions } = await context();
    const { added } = await actions.discover({ limit: Number(count) || 10 });
    say(`Shortlisted ${added}.`);
  },

  async add(domains) {
    if (!domains.length) throw new Error('Give me at least one domain.');
    const { actions } = await context();
    say(`Shortlisted ${(await actions.add({ domains })).added}.`);
  },

  async research() {
    const { profile, llm, store } = await context();
    const researcher = new Researcher({ profile, llm, store });
    const waiting = Object.values(await store.all()).filter((company) => WAITING.includes(company.status));
    if (!waiting.length) return say('Nothing is waiting to be researched.');

    for (const company of waiting) {
      const done = await researcher.run(company, say);
      say(`${done.domain}: ${done.verdict.kind} (${done.verdict.code}) after ${done.lookups} lookups`);
    }
  },

  async doctor() {
    const profile = await loadProfile();
    say(`Profile loaded: ${profile.qualifiers.length} qualifiers, ${profile.discovery.length} discovery searches.`);

    for (const [name, hint] of [
      ['GEMINI_API_KEY', 'research and drafting'],
      ['HUNTER_API_KEY', 'finding the contact'],
      ['RESEND_API_KEY', 'sending'],
      ['EMAIL_TO', 'where approved mail goes'],
    ]) {
      const value = env[name];
      const shown = name.endsWith('_KEY') ? `set, ${value?.length ?? 0} characters` : value;
      say(`${name.padEnd(16)} ${value ? shown : `MISSING — ${hint} will not work`}`);
    }

    const store = createStore(env);
    say(`Companies stored: ${Object.keys(await store.all()).length}`);

    if (env.GEMINI_API_KEY) {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', {
        headers: { 'x-goog-api-key': env.GEMINI_API_KEY },
      }).catch((error) => ({ ok: false, status: error.name }));
      const body = res.ok ? await res.json() : {};
      const usable = (body.models ?? []).filter((model) => (model.supportedGenerationMethods ?? []).includes('generateContent'));
      say(`Gemini: HTTP ${res.status}${usable.length ? `, ${env.GEMINI_MODEL} ${usable.some((m) => m.name.endsWith(env.GEMINI_MODEL)) ? 'is available' : 'was NOT in the list'}` : ''}`);
    }
  },
};

const [command, ...args] = process.argv.slice(2);
if (!Object.hasOwn(commands, command ?? '')) {
  console.log(`Usage: node cli.js <${Object.keys(commands).join(' | ')}>`);
  process.exit(1);
}

commands[command](args).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
