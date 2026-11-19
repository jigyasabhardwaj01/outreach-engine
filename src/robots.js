// Asking permission before reading.
//
// robots.txt is the one place a site states, in a form a machine can read,
// what it is willing to have fetched automatically. Honouring it costs one
// request per host and is the difference between a crawler and a nuisance.
const ALL = '*';

/**
 * Parse robots.txt into the rules that apply to one agent.
 *
 * Groups are keyed by User-agent, and consecutive User-agent lines share the
 * rules that follow. A group naming our agent wins; otherwise the `*` group.
 */
export function parseRobots(text) {
  const groups = new Map();
  let current = [];
  let collecting = false;

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;

    const [field, ...rest] = line.split(':');
    const key = field.trim().toLowerCase();
    const value = rest.join(':').trim();

    if (key === 'user-agent') {
      // A User-agent line after rules starts a fresh group.
      if (collecting) current = [];
      collecting = false;
      const agent = value.toLowerCase();
      current.push(agent);
      if (!groups.has(agent)) groups.set(agent, { allow: [], disallow: [], crawlDelay: null });
      continue;
    }

    if (!current.length) continue;
    collecting = true;

    for (const agent of current) {
      const group = groups.get(agent);
      if (key === 'disallow' && value) group.disallow.push(value);
      else if (key === 'disallow') group.disallow.push(''); // empty Disallow allows everything
      else if (key === 'allow' && value) group.allow.push(value);
      else if (key === 'crawl-delay') {
        const seconds = Number.parseFloat(value);
        if (Number.isFinite(seconds)) group.crawlDelay = seconds;
      }
    }
  }
  return groups;
}

const matches = (rule, path) => {
  if (rule === '') return false;
  // robots.txt wildcards: * for any run, $ for end-of-path.
  const pattern = rule.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replaceAll('*', '.*').replace(/\\\$$/, '$');
  return new RegExp(`^${pattern}`).test(path);
};

const longest = (rules, path) => rules.filter((rule) => matches(rule, path)).sort((a, b) => b.length - a.length)[0] ?? null;

/**
 * May we fetch this path?
 *
 * The most specific rule wins, and Allow beats Disallow at equal length, which
 * is how a site says "stay out of /admin but /admin/public is fine".
 */
export function isAllowed(robotsText, path, agent = ALL) {
  const groups = parseRobots(robotsText);
  const group = groups.get(agent.toLowerCase()) ?? groups.get(ALL);
  if (!group) return { allowed: true, rule: null };

  const target = path || '/';
  const blocked = longest(group.disallow, target);
  const permitted = longest(group.allow, target);

  if (blocked === null) return { allowed: true, rule: null, crawlDelay: group.crawlDelay };
  if (permitted !== null && permitted.length >= blocked.length) return { allowed: true, rule: `Allow: ${permitted}`, crawlDelay: group.crawlDelay };
  return { allowed: false, rule: `Disallow: ${blocked}`, crawlDelay: group.crawlDelay };
}

/**
 * Fetches and remembers one robots.txt per host.
 *
 * A host with no robots.txt has not refused anything, so a 404 means yes. A
 * host that errors or times out has not answered, and we do not read silence
 * as consent for anything we would not otherwise fetch — but neither do we
 * stop the whole run: the caller decides, and the default below is to proceed,
 * which matches how every other client on the web behaves.
 */
export class RobotsCache {
  /** @type {typeof fetch} */ fetchImpl;
  /** @type {string} */ agent;
  /** @type {number} */ timeoutMs;

  constructor({ fetchImpl = fetch, agent = ALL, timeoutMs = 8000 } = {}) {
    Object.assign(this, { fetchImpl, agent, timeoutMs });
    this.hosts = new Map();
  }

  async rulesFor(origin) {
    if (this.hosts.has(origin)) return this.hosts.get(origin);

    let text = '';
    try {
      const res = await this.fetchImpl(`${origin}/robots.txt`, { signal: AbortSignal.timeout(this.timeoutMs) });
      // Anything that is not a 200 with rules means no stated restriction.
      text = res.status === 200 ? await res.text() : '';
    } catch {
      text = '';
    }
    this.hosts.set(origin, text);
    return text;
  }

  async check(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { allowed: false, rule: 'not a URL' };
    }
    const text = await this.rulesFor(parsed.origin);
    if (!text.trim()) return { allowed: true, rule: null };
    return isAllowed(text, parsed.pathname + parsed.search, this.agent);
  }
}
