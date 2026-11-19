// Reading public web pages. Everything here returns data for a model to read,
// never instructions to follow: callers wrap it in <untrusted_content> tags.
import dns from 'node:dns/promises';

const DOMAIN = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const PRIVATE_HOST = /\.(localhost|test|local|internal|invalid)$/;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function normalizeDomain(input) {
  const domain = String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, '');
  return DOMAIN.test(domain) ? domain : null;
}

// Blocks anything that isn't a public web address, so a link found on a page
// can never make us fetch something on the machine we're running on.
export function isPublicUrl(input) {
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (!DOMAIN.test(url.hostname) || PRIVATE_HOST.test(url.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Is this address inside the machine, the network, or the cloud provider?
 *
 * The ranges that matter: loopback, the RFC 1918 private blocks, link-local
 * (which is where 169.254.169.254, every cloud's credential endpoint, lives),
 * carrier-grade NAT, and the IPv6 equivalents.
 */
export function isPrivateAddress(ip) {
  const address = String(ip ?? '').toLowerCase().replace(/^::ffff:/, '');

  if (address.includes(':')) {
    return address === '::' || address === '::1' || /^f[cd]/.test(address) || address.startsWith('fe80');
  }

  const [a, b] = address.split('.').map(Number);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return true;
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * The check isPublicUrl cannot make.
 *
 * A name can look perfectly public and still resolve to something inside the
 * network — by accident, or because a page we read linked to a host its owner
 * pointed at 169.254.169.254 on purpose. The name is the only thing we can
 * check before connecting, so we check where it actually points.
 *
 * A name that will not resolve is left alone: the fetch below will fail on its
 * own, and refusing here would turn "DNS was slow" into "this site blocked us".
 */
/** @param {string} hostname @param {Function} [lookup] */
export async function resolvesPublicly(hostname, lookup = dns.lookup) {
  let addresses;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    return true;
  }
  if (!addresses?.length) return true;
  return !addresses.some((entry) => isPrivateAddress(entry.address));
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'",
  rsquo: '’', lsquo: '‘', ldquo: '"', rdquo: '"', ndash: '-', mdash: '-', hellip: '...',
};

export function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<img\b[^>]*\balt=["']([^"']*)["'][^>]*>/gi, ' $1 ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&([a-z0-9#]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

export function extractLinks(html, baseUrl) {
  const links = new Set();
  for (const match of html.matchAll(/<a\b[^>]*\bhref=["']([^"'#]+)/gi)) {
    try {
      const href = new URL(match[1], baseUrl).href;
      if (isPublicUrl(href)) links.add(href);
    } catch {
      // A malformed href is simply not a link.
    }
  }
  return [...links];
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// When the page says it was published. Metadata first, because a date in the
// body could belong to anything; a visible byline date is the fallback.
export function findPublishedDate(html, text = htmlToText(html)) {
  const meta =
    html.match(/article:published_time["'][^>]*content=["'](\d{4}-\d{2}-\d{2})/i) ||
    html.match(/content=["'](\d{4}-\d{2}-\d{2})[^"']*["'][^>]*article:published_time/i) ||
    html.match(/"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})/) ||
    html.match(/<time\b[^>]*\bdatetime=["'](\d{4}-\d{2}-\d{2})/i);
  if (meta) return meta[1];

  const visible = text.match(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i,
  );
  if (!visible) return null;
  const [, month, day, year] = visible;
  const date = new Date(Date.UTC(Number(year), MONTHS.indexOf(month.toLowerCase()), Number(day)));
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

/**
 * Fetch one page.
 *
 * status 'ok'      the text is usable
 * status 'missing' there is no such page, so "this company has no X page" is a fact
 * status 'failed'  blocked, timed out, or JavaScript-only: we learned nothing
 *
 * The difference matters: only 'missing' lets a caller conclude anything from absence.
 */
/**
 * @param {string} url
 * @param {{ attempts?: number, timeoutMs?: number, maxChars?: number, lookup?: Function }} options
 */
export async function fetchPage(url, { attempts = 3, timeoutMs = 20000, maxChars = 30000, lookup } = {}) {
  if (!isPublicUrl(url)) return { status: 'failed', url, reason: 'not a public web address' };
  if (!(await resolvesPublicly(new URL(url).hostname, lookup))) {
    return { status: 'failed', url, reason: 'resolves to a private address' };
  }

  let reason = 'unknown';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await sleep(attempt * 1500);
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      });

      if (res.status === 404 || res.status === 410) return { status: 'missing', url };
      if (res.status === 401 || res.status === 403) return { status: 'failed', url, reason: `blocked (${res.status})` };
      if (!res.ok) {
        reason = `HTTP ${res.status}`;
        continue;
      }

      const html = await res.text();
      const text = htmlToText(html);
      // Too little text almost always means the page builds itself in the
      // browser. Treat it as a failure, not as an empty page.
      if (text.length < 200) return { status: 'failed', url: res.url, reason: 'too little text (JavaScript-only page?)' };

      return {
        status: 'ok',
        url: res.url,
        text: text.slice(0, maxChars),
        links: extractLinks(html, res.url),
        publishedAt: findPublishedDate(html, text),
        fetchedAt: new Date().toISOString().slice(0, 10),
      };
    } catch (error) {
      reason = error.name === 'TimeoutError' ? 'timed out' : error.name;
    }
  }
  return { status: 'failed', url, reason };
}

/**
 * fetchPage, wrapped in the two courtesies a scraper owes a site it does not
 * own: ask robots.txt first, and do not hammer one host.
 *
 * A disallowed page comes back as 'failed', not 'missing', because we did not
 * look — and absence of evidence must never be read from a page we never read.
 */
/** @param {{ robots?: any, minGapMs?: number, maxGapMs?: number, fetchPage?: Function, sleepImpl?: Function }} options */
export function createPoliteFetcher({ robots, minGapMs = 1000, maxGapMs = 10000, fetchPage: inner = fetchPage, sleepImpl = sleep } = {}) {
  const lastByHost = new Map();
  const gapByHost = new Map();

  return async function politeFetch(url, options) {
    if (!isPublicUrl(url)) return { status: 'failed', url, reason: 'not a public web address' };

    const { host } = new URL(url);

    if (robots) {
      const verdict = await robots.check(url);
      if (!verdict.allowed) return { status: 'failed', url, reason: `robots.txt disallows it (${verdict.rule})` };
      // A Crawl-delay belongs to the host that asked for it. Raising the gap
      // globally would let one site with "Crawl-delay: 30" slow every other
      // site down for the rest of the run — and quietly blow the two-minute
      // target for companies that never asked for anything.
      if (verdict.crawlDelay) {
        gapByHost.set(host, Math.min(Math.max(minGapMs, verdict.crawlDelay * 1000), maxGapMs));
      }
    }

    const gap = gapByHost.get(host) ?? minGapMs;
    const wait = (lastByHost.get(host) ?? 0) + gap - Date.now();
    if (wait > 0) await sleepImpl(wait);
    lastByHost.set(host, Date.now());

    return inner(url, options);
  };
}

// Search results link through a redirect; follow one hop to the real address.
//
// The URL here comes from the model's grounding data, so it is checked like
// anything else off the web before we are willing to open a connection to it.
export async function resolveRedirect(url) {
  if (!isPublicUrl(url)) return url;
  try {
    const res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    const location = res.headers.get('location');
    return location && isPublicUrl(location) ? location : url;
  } catch {
    return url;
  }
}
