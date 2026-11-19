// Postgres over HTTP. Neon answers SQL on a plain fetch endpoint, which keeps
// this project free of dependencies and works on a serverless host, where the
// file store cannot: there is no disk that survives a request.
const stamp = (company) => ({ ...company, updatedAt: new Date().toISOString() });

export class NeonStore {
  /** @param {{ url?: string, fetchImpl?: Function, timeoutMs?: number }} options */
  constructor({ url, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
    if (!url) throw new Error('NeonStore needs a DATABASE_URL.');
    this.url = url;
    this.endpoint = `https://${new URL(url).hostname}/sql`;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async sql(query, params = []) {
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Neon-Connection-String': this.url,
        // Ask for text, and parse the JSON column ourselves: the endpoint's
        // own typing is not something to rely on for a jsonb round trip.
        'Neon-Raw-Text-Output': 'true',
      },
      body: JSON.stringify({ query, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`Database ${res.status}: ${text.slice(0, 200)}`);

    try {
      return JSON.parse(text).rows ?? [];
    } catch {
      throw new Error(`The database returned something unreadable: ${text.slice(0, 120)}`);
    }
  }

  async all() {
    const rows = await this.sql('select domain, data from companies order by domain');
    return Object.fromEntries(rows.map((row) => [row.domain, JSON.parse(row.data)]));
  }

  async get(domain) {
    const rows = await this.sql('select data from companies where domain = $1', [domain]);
    return rows.length ? JSON.parse(rows[0].data) : undefined;
  }

  async has(domain) {
    return (await this.sql('select 1 from companies where domain = $1', [domain])).length > 0;
  }

  async put(company) {
    if (!company?.domain) throw new Error('A company needs a domain.');
    const saved = stamp(company);
    await this.sql(
      `insert into companies (domain, data, updated_at) values ($1, $2, now())
       on conflict (domain) do update set data = excluded.data, updated_at = now()`,
      [saved.domain, JSON.stringify(saved)],
    );
    return saved;
  }

  async remove(domain) {
    const rows = await this.sql('delete from companies where domain = $1 returning domain', [domain]);
    return rows.length > 0;
  }

  /** Used by the health check: proves the database is reachable and has the table. */
  async count() {
    const rows = await this.sql('select count(*)::int as n from companies');
    return Number(rows[0].n);
  }
}
