# outreach-engine

Cold outreach that has to show its work. Find companies, qualify them against a
profile, and draft an email where every claim traces back to a quote from a page
we actually read.

Node 20+, no dependencies. Nothing is sent without your approval, and every
email goes to `EMAIL_TO` — never to the contact.

## The idea

A **profile** is the whole campaign as data: what you sell, what makes a company
worth writing to, where to look, and what each possible answer means. Nothing in
`src/` knows anything about any particular product, so a second campaign is a
second file in `profiles/`, not a fork.

The decision itself is plain code walking the profile in order. The model reads
pages and answers questions; it never decides. So the same answers always give
the same verdict, and every verdict reads back as the rule that produced it.

Three rules the engine enforces, because they're where this kind of tool usually
goes wrong:

- **A quote must really be in the page.** A claim whose quote isn't found in the
  source text is discarded, however confident the model was.
- **Silence only counts when we actually looked.** A page that 404s is evidence
  of absence; a page that was blocked or timed out is not.
- **Questions stop at the first answer that decides.** A company rejected on
  headcount never costs you the rest of the API calls.

## Getting started

```bash
cp .env.example .env
npm test
```

## Where things are

| Path | What it does |
|---|---|
| `src/profile.js` | How a campaign is described: `qualifier`, `page`, `search`, `reject`, `qualify` |
| `src/assess.js` | The verdict: walks the qualifiers, decides or asks the next question |
| `src/llm.js` | Gemini, with pacing, retries, and the grounding citations that tie a quote to its source |
| `src/web.js` | Fetching and reading public pages; `ok` / `missing` / `failed` |
| `src/store.js` | Where companies live — `JsonStore` now, another class later |
| `src/env.js` | Settings, from `.env` or the platform |
| `profiles/compliance-saas.js` | A worked example to copy |

## Still to build

Discovery, the research loop, contact lookup, drafting, the review page, the CLI.
