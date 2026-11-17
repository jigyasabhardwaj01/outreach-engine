import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDomain, isPublicUrl, htmlToText, extractLinks, findPublishedDate } from '../src/web.js';

test('normalizeDomain strips scheme, www, path and port', () => {
  assert.equal(normalizeDomain('https://www.Example.com/pricing?x=1'), 'example.com');
  assert.equal(normalizeDomain('  sub.example.co.uk  '), 'sub.example.co.uk');
  assert.equal(normalizeDomain('localhost:3000'), null);
  assert.equal(normalizeDomain('not a domain'), null);
  assert.equal(normalizeDomain(''), null);
});

test('isPublicUrl refuses anything that is not a public web address', () => {
  assert.ok(isPublicUrl('https://example.com/security'));
  assert.ok(!isPublicUrl('http://localhost:3000/admin'));
  assert.ok(!isPublicUrl('https://api.internal/keys'));
  assert.ok(!isPublicUrl('file:///etc/passwd'));
  assert.ok(!isPublicUrl('javascript:alert(1)'));
  assert.ok(!isPublicUrl('nonsense'));
});

test('htmlToText drops scripts and keeps readable text', () => {
  const html = `
    <html><head><style>.a{color:red}</style></head>
    <body><script>sendSecrets()</script>
    <h1>We are SOC 2 compliant</h1><p>Since&nbsp;2024 &amp; counting.</p>
    <img alt="trust badge" src="x.png"></body></html>`;
  const text = htmlToText(html);
  assert.ok(text.includes('We are SOC 2 compliant'));
  assert.ok(text.includes('Since 2024 & counting.'));
  assert.ok(text.includes('trust badge'));
  assert.ok(!text.includes('sendSecrets'));
  assert.ok(!text.includes('color:red'));
});

test('extractLinks resolves relative links and drops private ones', () => {
  const html = `<a href="/security">s</a><a href="https://other.com/x">o</a><a href="http://localhost/admin">no</a>`;
  const links = extractLinks(html, 'https://example.com/');
  assert.deepEqual(links, ['https://example.com/security', 'https://other.com/x']);
});

test('findPublishedDate prefers metadata over a date in the body', () => {
  const html = `<meta property="article:published_time" content="2025-03-04T10:00:00Z"><p>Jan 1, 2001 we began</p>`;
  assert.equal(findPublishedDate(html), '2025-03-04');
});

test('findPublishedDate falls back to a visible byline date', () => {
  assert.equal(findPublishedDate('<p>Published March 4, 2025 by Sam</p>'), '2025-03-04');
  assert.equal(findPublishedDate('<p>no date here at all</p>'), null);
});
