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
| `src/discover.js` | Finding candidates, in two passes so domains can't be invented |
| `src/research.js` | Answering the questions, one per step, with evidence |
| `src/sources.js` | Fetching and caching what a company's assessment reads |
| `src/contacts.js` | Who to write to, via Hunter, in the profile's order |
| `src/draft.js` | Writing the email, and the checks it has to survive |
| `src/send.js` | Sending, always to `EMAIL_TO` |
| `profiles/compliance-saas.js` | A worked example to copy |

## What the drafting checks reject

The model writes the email; code decides whether it's fit to send. A draft is
rejected for being too long, for a placeholder nobody filled in, for a hook
that isn't in the research or is too old to call recent, for promising an
outcome ("effortless", "in days", "pass your audit"), and for stating as fact
anything the research doesn't support — telling them they need a framework, or
naming one that appears nowhere in the evidence. Hedged wording is always
allowed, because "it looks like" is an honest sentence.

Failing drafts go back to the model with the specific complaint, up to three
times. A draft that still fails is kept, with its problems attached, so you can
see what's wrong rather than having it quietly sent.

## Still to build

The review page and the CLI.
