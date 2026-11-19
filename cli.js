#!/usr/bin/env node
// node cli.js review              Open the review page (the normal way to use this)
// node cli.js discover 10         Fill the shortlist from the profile's searches
// node cli.js add acme.com b.io   Shortlist companies you already know
// node cli.js research            Research everything shortlisted
// node cli.js run acme.com b.io  Run all seven steps over a list of domains
// node cli.js verify             Prove the pipeline works, without spending anything
// node cli.js verify --live      Check the real keys answer: model, Hunter, mailer
// node cli.js doctor              Check the settings and the API keys
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { env, ROOT } from './src/env.js';
import { createStore } from './src/store.js';
import { Gemini } from './src/llm.js';
import { createActions } from './src/actions.js';
import { Researcher } from './src/research.js';
import { startServer } from './src/server.js';
import { runPipeline, describeRun } from './src/pipeline.js';
import { selfCheck, liveCheck } from './src/selfcheck.js';
import { mailerFor } from './src/mailer.js';

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
      try {
        const done = await researcher.run(company, say);
        // A company can finish without a verdict: running out of lookups is a
        // handoff, not a decision, and it has no verdict to print.
        if (done.status === 'manual_review') say(`${done.domain}: handed back — ${done.handoff?.reason ?? 'stopped early'}`);
        else if (done.verdict) say(`${done.domain}: ${done.verdict.kind} (${done.verdict.code}) after ${done.lookups} lookups`);
        else say(`${done.domain}: finished as "${done.status}" with no verdict`);
      } catch (error) {
        // One company's failure is not a reason to abandon the rest of the queue.
        say(`${company.domain}: failed — ${error.message}`);
      }
    }
  },

  async run(domains) {
    const ctx = await context();
    const autoSend = String(env.REVIEW_MODE ?? 'true').toLowerCase() === 'false';
    say(autoSend ? `Sending is ON. Approved drafts go to ${env.EMAIL_TO}.` : 'REVIEW_MODE is on: drafts stop for your approval. Set REVIEW_MODE=false to send.');

    const summary = await runPipeline({ ...ctx, domains, onProgress: say });
    say(`\n${describeRun(summary)}`);
    for (const failure of summary.failures) say(`  ${failure.domain} (${failure.step}): ${failure.reason}`);
  },

  async verify(args) {
    if (args.includes('--live')) {
      say('Checking the real services with the credentials configured here:');
      const { steps, ok } = await liveCheck({ settings: env });
      for (const step of steps) say(`${step.ok ? '\u2713' : '\u2717'} ${step.name.padEnd(22)} ${step.detail}`);
      say(ok ? '\nEverything answers. It can run for real.' : '\nFix the crosses above before running it for real.');
      if (!ok) process.exitCode = 1;
      return;
    }

    const profile = await loadProfile();
    const { steps, ok, configured } = await selfCheck({ profile, settings: env });
    const line = (step) => say(`${step.ok ? '\u2713' : '\u2717'} ${String(step.step).padEnd(2)} ${step.name.padEnd(46)} ${step.detail}`);

    say('The pipeline, run end to end against a stand-in web and model:');
    steps.filter((s) => s.kind === 'pipeline').forEach(line);
    say('\nConfiguration on this machine:');
    steps.filter((s) => s.kind === 'config').forEach(line);

    say(ok ? '\nThe pipeline works end to end.' : '\nThe pipeline is broken above.');
    if (ok && !configured) say('It cannot do it for real until the missing settings are filled in.');
    if (!ok) process.exitCode = 1;
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

    const mailer = mailerFor(env);
    say(`Mailer           ${mailer.name}${mailer.ready ? ' — ready' : ` — MISSING ${mailer.missing.join(', ')}`}`);

    const store = createStore(env);
    say(`Companies stored: ${Object.keys(await store.all()).length}`);

    if (env.GEMINI_API_KEY) {
      try {
        const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', {
          headers: { 'x-goog-api-key': env.GEMINI_API_KEY },
        });
        const body = res.ok ? await res.json() : {};
        const usable = (body.models ?? []).filter((model) => (model.supportedGenerationMethods ?? []).includes('generateContent'));
        say(`Gemini: HTTP ${res.status}${usable.length ? `, ${env.GEMINI_MODEL} ${usable.some((m) => m.name.endsWith(env.GEMINI_MODEL)) ? 'is available' : 'was NOT in the list'}` : ''}`);
      } catch (error) {
        // "HTTP TypeError" told you nothing; this says the call never landed.
        say(`Gemini: could not be reached (${error.name}: ${error.message})`);
      }
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
