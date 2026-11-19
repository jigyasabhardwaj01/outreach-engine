// The model. One class, so a run shares its rate limiting, and so tests can
// hand the pipeline a fake with the same two methods.
import { env } from './env.js';
import { sleep } from './web.js';

// The whole run should stop: out of quota, unreachable, misconfigured. Stopping
// is important — carrying on would record "no evidence found" against a company
// when the truth is that we never managed to look.
export class LlmError extends Error {}

// This one piece of content could not be used: refused, or returned as garbage.
// Only that source is lost, so the caller moves on to the next one.
export class LlmUnusable extends LlmError {}

const RETRYABLE = (status) => status === 429 || status >= 500;

export class Gemini {
  /** @type {string} */ apiKey;
  /** @type {string} */ model;
  /** @type {number} */ minGapMs;
  /** @type {number} */ attempts;
  /** @type {number} */ timeoutMs;
  /** @type {typeof fetch} */ fetchImpl;

  constructor({
    apiKey = env.GEMINI_API_KEY,
    model = env.GEMINI_MODEL,
    minGapMs = Number(env.GEMINI_MIN_GAP_MS) || 1000,
    attempts = 6,
    timeoutMs = 120000,
    fetchImpl = fetch,
  } = {}) {
    Object.assign(this, { apiKey, model, minGapMs, attempts, timeoutMs, fetchImpl });
    this.lastCallAt = 0;
    this.calls = 0;
  }

  get endpoint() {
    return `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
  }

  async #pace() {
    const wait = this.minGapMs - (Date.now() - this.lastCallAt);
    if (wait > 0) await sleep(wait);
    this.lastCallAt = Date.now();
  }

  /**
   * One call. With `schema` the answer comes back as `json`, otherwise as `text`.
   * With `search` the model may search the web, and `citations` then says which
   * source it used for each sentence it wrote.
   */
  async ask({ prompt, schema = null, search = false, temperature = 0.2 }) {
    if (!this.apiKey) throw new LlmError('GEMINI_API_KEY is not set. Add it to .env.');

    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature },
    };
    if (search) body.tools = [{ google_search: {} }];
    if (schema) {
      body.generationConfig.responseMimeType = 'application/json';
      body.generationConfig.responseSchema = schema;
    }

    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      await this.#pace();
      this.calls++;

      let res;
      try {
        res = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (attempt === this.attempts) throw new LlmError(`Gemini unreachable: ${error.name}`);
        await sleep(attempt * 5000);
        continue;
      }

      if (RETRYABLE(res.status)) {
        const data = await res.json().catch(() => ({}));
        const wait = retryDelayMs(data) ?? attempt * 10000;
        if (attempt === this.attempts || wait > 120000) throw new LlmError(`Gemini ${res.status}: ${messageOf(data)}`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        throw new LlmError(`Gemini ${res.status}: ${messageOf(await res.json().catch(() => ({})))}`);
      }

      const data = await res.json();
      const candidate = (data.candidates ?? [])[0];
      if (!candidate) {
        const feedback = data.promptFeedback;
        throw new LlmUnusable(`Gemini returned nothing (${feedback?.blockReason ?? 'no reason given'})`);
      }

      const text = (candidate.content?.parts ?? []).map((part) => part.text ?? '').join('');
      const result = { text, ...groundingOf(candidate) };
      if (!schema) return result;

      try {
        return { ...result, json: JSON.parse(text) };
      } catch {
        if (attempt === this.attempts) {
          throw new LlmUnusable(
            `Gemini kept returning invalid JSON (finish reason ${candidate.finishReason}, ${text.length} chars, ends: ${text.slice(-120)})`,
          );
        }
      }
    }
    throw new LlmError('Gemini failed.');
  }
}

function messageOf(data) {
  return data?.error?.message ?? 'no details';
}

// Google tells us how long to wait; obey it rather than guessing.
function retryDelayMs(data) {
  const detail = (data?.error?.details ?? []).find((d) => d.retryDelay);
  if (!detail) return null;
  const seconds = parseFloat(detail.retryDelay);
  return Number.isFinite(seconds) ? seconds * 1000 + 1000 : null;
}

// Which web page the model used for each sentence. Keeping the mapping lets us
// link a claim to its real source instead of trusting a URL it typed out.
function groundingOf(candidate) {
  const grounding = candidate.groundingMetadata ?? {};
  const chunks = (grounding.groundingChunks ?? []).map((chunk) => chunk.web).filter(Boolean);
  const citations = (grounding.groundingSupports ?? []).map((support) => ({
    text: support.segment?.text ?? '',
    uris: (support.groundingChunkIndices ?? []).map((i) => chunks[i]?.uri).filter(Boolean),
  }));
  return { sources: chunks, citations };
}

/**
 * The source cited for the sentence a quote came from, or null if none was.
 *
 * Containment is checked both ways, because the model's own sentence and the
 * quote it pulled out of it rarely line up exactly. But a very short cited
 * fragment is contained in almost everything, and matching on one would staple
 * a real URL to a claim that page never made — which is worse than having no
 * URL at all. So the shorter side has to be long enough to mean something.
 */
const ENOUGH_TO_MATCH_ON = 12;

export function citationFor(citations, quote) {
  const needle = squash(quote);
  if (needle.length < ENOUGH_TO_MATCH_ON) return null;

  const hit = (citations ?? []).find((citation) => {
    const sentence = squash(citation.text);
    if (!citation.uris.length || sentence.length < ENOUGH_TO_MATCH_ON) return false;
    return sentence.includes(needle) || needle.includes(sentence);
  });
  return hit ? hit.uris[0] : null;
}

export const squash = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// A claim only counts if its quote is really in the page we read. This is the
// one check that stops a confident model inventing its own evidence.
export const quoteIsInSource = (quote, sourceText) => Boolean(squash(quote)) && squash(sourceText).includes(squash(quote));
