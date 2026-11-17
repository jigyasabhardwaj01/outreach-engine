import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnvFile } from '../src/env.js';
import { JsonStore, MemoryStore } from '../src/store.js';
import { citationFor, quoteIsInSource } from '../src/llm.js';
import { defineProfile, qualifier, page, reject } from '../src/profile.js';
import profile from '../profiles/compliance-saas.js';

test('parseEnvFile handles quotes, comments and export', () => {
  const env = parseEnvFile(['# a comment', 'KEY=value', 'export OTHER = spaced ', 'QUOTED="a # b"', 'TRAILING=x # note', 'bad line'].join('\n'));
  assert.deepEqual(env, { KEY: 'value', OTHER: 'spaced', QUOTED: 'a # b', TRAILING: 'x' });
});

test('JsonStore round-trips a company and survives a reopen', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outreach-'));
  const file = path.join(dir, 'companies.json');
  try {
    const store = new JsonStore(file);
    await store.put({ domain: 'example.com', name: 'Example', status: 'shortlisted' });
    assert.equal((await new JsonStore(file).get('example.com')).name, 'Example');
    assert.ok(await store.has('example.com'));
    assert.equal(await store.get('nope.com'), undefined);

    await store.put({ domain: 'example.com', name: 'Example', status: 'researched' });
    assert.equal(Object.keys(await store.all()).length, 1, 'the same domain updates rather than duplicating');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a store refuses a company with no domain', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outreach-'));
  try {
    await assert.rejects(() => new JsonStore(path.join(dir, 'c.json')).put({ name: 'No domain' }), /needs a domain/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MemoryStore behaves like JsonStore', async () => {
  const store = new MemoryStore();
  await store.put({ domain: 'a.com' });
  assert.ok((await store.get('a.com')).updatedAt);
});

test('quoteIsInSource ignores punctuation and casing but not invention', () => {
  const source = 'We are currently working toward our SOC 2 Type II report.';
  assert.ok(quoteIsInSource('working toward our SOC 2 Type II', source));
  assert.ok(quoteIsInSource('WORKING  TOWARD, our soc 2 type ii!', source));
  assert.ok(!quoteIsInSource('we hold ISO 27001', source));
  assert.ok(!quoteIsInSource('', source));
});

test('citationFor matches a quote to the source the model cited for it', () => {
  const citations = [
    { text: 'Acme raised a Series A in March.', uris: ['https://news.example/acme'] },
    { text: 'Acme has 40 employees.', uris: ['https://dir.example/acme'] },
  ];
  assert.equal(citationFor(citations, 'has 40 employees'), 'https://dir.example/acme');
  assert.equal(citationFor(citations, 'something never said'), null);
  assert.equal(citationFor([], 'anything'), null);
});

test('a profile rejects an outcome for an answer it never allows', () => {
  assert.throws(
    () =>
      qualifier({
        key: 'x',
        label: 'X',
        ask: 'X?',
        answers: ['yes'],
        sufficientWhen: 'Stated.',
        sources: [page('/')],
        outcomes: { maybe: reject('bad', 'nope') },
      }),
    /not one of its answers/,
  );
});

test('a profile rejects a qualifier with no sources, and duplicate keys', () => {
  assert.throws(() => qualifier({ key: 'x', label: 'X', ask: 'X?', answers: ['yes'], sources: [] }), /at least one valid/);

  const one = qualifier({ key: 'dup', label: 'D', ask: 'D?', answers: ['yes'], sufficientWhen: 's', sources: [page('/')] });
  assert.throws(
    () =>
      defineProfile({
        seller: { product: 'p', oneLiner: 'o' },
        discovery: [{ source: 's', query: 'q' }],
        defaultVerdict: reject('none', 'none'),
        qualifiers: [one, one],
      }),
    /share the key/,
  );
});

test('the example profile is valid and ordered cheapest-first', () => {
  assert.equal(profile.qualifiers[0].key, 'saas');
  assert.ok(profile.byKey.employees.numeric);
  assert.ok(profile.excludeDomains.includes('sprinto.com'));
  assert.equal(typeof profile.contacts.order(30)[0], 'string');
});
