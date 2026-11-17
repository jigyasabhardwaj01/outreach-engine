import test from 'node:test';
import assert from 'node:assert/strict';
import { discover, addDomains } from '../src/discover.js';
import { MemoryStore } from '../src/store.js';
import { FakeLlm, testProfile } from './helpers.js';

const profile = testProfile({
  discovery: [
    { source: 'Job posts', query: 'hiring for SOC 2' },
    { source: 'Funding', query: 'recent Series A' },
  ],
});

// Each source returns its own list; the extraction pass just echoes it back.
const llmReturning = (bySource) =>
  new FakeLlm((request) => {
    if (request.search) {
      const entry = Object.entries(bySource).find(([query]) => request.prompt.includes(query));
      return { text: JSON.stringify(entry[1]) };
    }
    return { json: { companies: JSON.parse(request.prompt.match(/<untrusted_content>\n([\s\S]*?)\n<\/untrusted_content>/)[1]) } };
  });

test('takes from each source in turn rather than draining the first', async () => {
  const llm = llmReturning({
    'hiring for SOC 2': [{ name: 'A', domain: 'a.com' }, { name: 'B', domain: 'b.com' }],
    'recent Series A': [{ name: 'C', domain: 'c.com' }, { name: 'D', domain: 'd.com' }],
  });
  const added = await discover({ profile, llm, store: new MemoryStore(), limit: 3 });

  assert.deepEqual(added.map((c) => c.domain), ['a.com', 'c.com', 'b.com']);
  assert.equal(added[0].foundBy, 'Job posts');
  assert.equal(added[1].foundBy, 'Funding');
});

test('skips companies we already have, and our own side of the market', async () => {
  const llm = llmReturning({
    'hiring for SOC 2': [{ name: 'Known', domain: 'https://www.known.com/careers' }, { name: 'Us', domain: 'ourselves.com' }],
    'recent Series A': [{ name: 'New', domain: 'NEW.com' }],
  });
  const store = new MemoryStore({ 'known.com': { domain: 'known.com', status: 'rejected' } });
  const added = await discover({ profile, llm, store, limit: 10 });

  assert.deepEqual(added.map((c) => c.domain), ['new.com'], 'the known one and the competitor are left out');
  assert.equal(Object.keys(await store.all()).length, 2);
});

test('a company with an unusable domain is dropped, not guessed at', async () => {
  const llm = llmReturning({
    'hiring for SOC 2': [{ name: 'Nameless', domain: 'see their website' }],
    'recent Series A': [],
  });
  assert.deepEqual(await discover({ profile, llm, store: new MemoryStore(), limit: 5 }), []);
});

test('addDomains shortlists what you hand it', async () => {
  const store = new MemoryStore();
  const added = await addDomains({ profile, store, domains: ['https://Acme.com/pricing', 'ourselves.com', 'rubbish'] });

  assert.deepEqual(added.map((c) => c.domain), ['acme.com']);
  assert.equal(added[0].status, 'shortlisted');
  assert.equal(added[0].foundBy, 'Added by hand');
});
