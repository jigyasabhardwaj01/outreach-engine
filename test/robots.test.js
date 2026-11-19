import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed, parseRobots, RobotsCache } from '../src/robots.js';
import { createPoliteFetcher } from '../src/web.js';

const SIMPLE = `
# a comment
User-agent: *
Disallow: /admin
Disallow: /private/
Allow: /admin/public
Crawl-delay: 2
`;

test('the obvious cases', () => {
  assert.equal(isAllowed(SIMPLE, '/').allowed, true);
  assert.equal(isAllowed(SIMPLE, '/careers').allowed, true);
  assert.equal(isAllowed(SIMPLE, '/admin').allowed, false);
  assert.equal(isAllowed(SIMPLE, '/private/notes').allowed, false);
});

test('a more specific Allow beats a broader Disallow', () => {
  const verdict = isAllowed(SIMPLE, '/admin/public/page');
  assert.equal(verdict.allowed, true);
  assert.match(verdict.rule, /^Allow:/);
});

test('crawl-delay is reported so it can be obeyed', () => {
  assert.equal(isAllowed(SIMPLE, '/').crawlDelay, 2);
});

test('an empty Disallow means everything is allowed', () => {
  assert.equal(isAllowed('User-agent: *\nDisallow:', '/anything').allowed, true);
});

test('Disallow: / closes the whole site', () => {
  assert.equal(isAllowed('User-agent: *\nDisallow: /', '/').allowed, false);
  assert.equal(isAllowed('User-agent: *\nDisallow: /', '/careers').allowed, false);
});

test('a group naming us wins over the catch-all', () => {
  const text = 'User-agent: *\nDisallow: /\n\nUser-agent: outreach-engine\nDisallow: /secret';
  assert.equal(isAllowed(text, '/careers', 'outreach-engine').allowed, true, 'our group permits it');
  assert.equal(isAllowed(text, '/secret', 'outreach-engine').allowed, false);
  assert.equal(isAllowed(text, '/careers', 'someone-else').allowed, false, 'everyone else gets the catch-all');
});

test('agent names are matched regardless of case', () => {
  const text = 'User-agent: Outreach-Engine\nDisallow: /x';
  assert.equal(isAllowed(text, '/x', 'outreach-engine').allowed, false);
});

test('two agents sharing one block both get its rules', () => {
  const text = 'User-agent: alpha\nUser-agent: beta\nDisallow: /no';
  assert.equal(isAllowed(text, '/no', 'alpha').allowed, false);
  assert.equal(isAllowed(text, '/no', 'beta').allowed, false);
});

test('wildcards and end-anchors are honoured', () => {
  const text = 'User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp*/logs';
  assert.equal(isAllowed(text, '/report.pdf').allowed, false);
  assert.equal(isAllowed(text, '/report.pdf.html').allowed, true, '$ means the path ends there');
  assert.equal(isAllowed(text, '/tmp-2024/logs').allowed, false);
});

test('nonsense in the file does not block the whole site', () => {
  assert.equal(isAllowed('<!doctype html><html>404 not found</html>', '/careers').allowed, true);
  assert.equal(isAllowed('', '/careers').allowed, true);
  assert.equal(isAllowed(null, '/careers').allowed, true);
});

test('rules before any User-agent line are ignored', () => {
  assert.equal(isAllowed('Disallow: /careers\nUser-agent: *\nDisallow: /x', '/careers').allowed, true);
});

test('parseRobots keeps the groups apart', () => {
  const groups = parseRobots(SIMPLE);
  assert.deepEqual(groups.get('*').disallow, ['/admin', '/private/']);
  assert.deepEqual(groups.get('*').allow, ['/admin/public']);
});

// ---------------------------------------------------------------- the cache and the fetcher

const robotsServing = (byOrigin) => ({
  fetchImpl: async (url) => {
    const origin = new URL(url).origin;
    const body = byOrigin[origin];
    if (body === undefined) return { status: 404, text: async () => '' };
    if (body instanceof Error) throw body;
    return { status: 200, text: async () => body };
  },
});

test('robots.txt is fetched once per host, not once per page', async () => {
  let fetches = 0;
  const cache = new RobotsCache({
    fetchImpl: async () => { fetches++; return { status: 200, text: async () => 'User-agent: *\nDisallow: /no' }; },
  });

  assert.equal((await cache.check('https://x.example/a')).allowed, true);
  assert.equal((await cache.check('https://x.example/no')).allowed, false);
  assert.equal(fetches, 1);
});

test('no robots.txt means nothing has been refused', async () => {
  const cache = new RobotsCache(robotsServing({}));
  assert.equal((await cache.check('https://x.example/anything')).allowed, true);
});

test('an unreachable robots.txt does not halt the run', async () => {
  const cache = new RobotsCache(robotsServing({ 'https://x.example': new Error('ECONNRESET') }));
  assert.equal((await cache.check('https://x.example/page')).allowed, true);
});

test('a disallowed page is a failure to read, never an absence of content', async () => {
  const robots = new RobotsCache(robotsServing({ 'https://x.example': 'User-agent: *\nDisallow: /careers' }));
  const fetchPage = async () => { throw new Error('should never be fetched'); };
  const polite = createPoliteFetcher({ robots, fetchPage, minGapMs: 0 });

  const result = await polite('https://x.example/careers');
  assert.equal(result.status, 'failed', 'failed, not missing: absence cannot be concluded from it');
  assert.match(result.reason, /robots\.txt disallows it/);
});

test('an allowed page is fetched normally', async () => {
  const robots = new RobotsCache(robotsServing({ 'https://x.example': 'User-agent: *\nDisallow: /admin' }));
  const polite = createPoliteFetcher({ robots, fetchPage: async (url) => ({ status: 'ok', url, text: 'hello' }), minGapMs: 0 });
  assert.equal((await polite('https://x.example/careers')).status, 'ok');
});

test('requests to one host are spaced out, and different hosts are not', async () => {
  const waits = [];
  const polite = createPoliteFetcher({
    robots: null,
    minGapMs: 1000,
    fetchPage: async (url) => ({ status: 'ok', url }),
    sleepImpl: async (ms) => waits.push(ms),
  });

  await polite('https://a.example/one');
  await polite('https://a.example/two');
  await polite('https://b.example/one');

  assert.equal(waits.length, 1, 'only the second request to the same host waits');
  assert.ok(waits[0] > 0 && waits[0] <= 1000);
});

test('the polite fetcher still refuses addresses that are not public', async () => {
  const polite = createPoliteFetcher({ robots: null, fetchPage: async () => ({ status: 'ok' }) });
  assert.equal((await polite('http://localhost:3000/admin')).status, 'failed');
  assert.equal((await polite('file:///etc/passwd')).status, 'failed');
});
