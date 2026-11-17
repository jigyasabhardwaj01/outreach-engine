// Getting hold of something to read, and remembering what we already read.
//
// One SourceSet lives for one company's assessment. Several qualifiers ask for
// the same pages — /security, /careers, the homepage — so fetching each one
// once is most of the cost saved, and the budget stops a pathological company
// from eating a whole day's API quota.
import { fetchPage as realFetchPage, isPublicUrl } from './web.js';
import { LlmUnusable } from './llm.js';

const NOTHING = 'NOTHING_FOUND';

export class SourceSet {
  constructor({ company, llm, fetchPage = realFetchPage, budget = 40, used = 0 }) {
    Object.assign(this, { company, llm, fetchPage, budget });
    this.used = used;
    this.cache = new Map();
  }

  get exhausted() {
    return this.used >= this.budget;
  }

  #key(spec) {
    return spec.type === 'page' ? `page:${spec.path}` : `search:${spec.queries[0]}`;
  }

  /** The content for one source spec, fetched once per company. */
  async get(spec) {
    const key = this.#key(spec);
    if (this.cache.has(key)) return this.cache.get(key);

    this.used++;
    const result = spec.type === 'page' ? await this.#page(spec) : await this.#search(spec);
    this.cache.set(key, result);
    return result;
  }

  async #page(spec) {
    const { domain } = this.company;
    let page = await this.fetchPage(`https://${domain}${spec.path}`);

    // Plenty of sites only answer on www.
    if (page.status !== 'ok' && spec.path === '/') page = await this.fetchPage(`https://www.${domain}/`);
    if (page.status === 'ok' || !spec.match) return { kind: 'page', ...page };

    // The page may simply live somewhere else — /trust-center, /legal/privacy.
    // The homepage is already cached by now in the common case.
    const home = await this.get({ type: 'page', path: '/', match: null });
    const link = (home.links ?? []).find((href) => spec.match.test(href) && isPublicUrl(href));
    if (!link) return { kind: 'page', ...page };

    this.used++;
    return { kind: 'page', ...(await this.fetchPage(link)) };
  }

  async #search(spec) {
    const fill = (query) => query.replaceAll('{name}', this.company.name ?? this.company.domain).replaceAll('{domain}', this.company.domain);

    for (const [index, raw] of spec.queries.entries()) {
      if (index > 0) this.used++;
      const query = fill(raw);
      const prompt = [
        `Search the web for: ${query}`,
        `Report only facts the sources state about this exact company (website ${this.company.domain}).`,
        `Say which source each fact comes from, and its date if the source gives one.`,
        `If you find nothing relevant, reply ${NOTHING} and nothing else.`,
      ].join('\n');

      let answer;
      try {
        answer = await this.llm.ask({ prompt, search: true });
      } catch (error) {
        // One unusable search is not a reason to stop; a quota failure is, and
        // that arrives as a plain LlmError, which we deliberately let through.
        if (!(error instanceof LlmUnusable)) throw error;
        continue;
      }

      if (answer.sources?.length && !answer.text.includes(NOTHING)) {
        return { kind: 'search', status: 'ok', query, text: answer.text, citations: answer.citations };
      }
    }
    return { kind: 'search', status: 'empty', query: fill(spec.queries[0]) };
  }
}

/** How a source is named in the audit log on the review page. */
export const describeSource = (source) => (source.kind === 'search' ? `search: ${source.query}` : source.url);
