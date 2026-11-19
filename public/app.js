// Putting view.js's answers on screen. Everything that decides anything lives
// there; this file only builds elements and talks to the API.
import {
  STAGES, stageById, companiesIn, countsByStage, firstBusyStage, awaitingResearch,
  PIPELINE, pipelineCounts, furthestStage, bannerFor, researchQueueLine, runSummary,
  orbState, progressRatio, railEdges, stepCounter, evidenceGraph, pipelineProgress,
  metrics, formatDuration, asPercent, statusChips,
  actionState, verdictWording, answerWording, evidenceWording, wordCount, sendLabel, summaryLine, researchProgress,
} from './view.js';
import { ResearchOrb, paintDotField, revealOnEntry, tiltOnHover, magnetic, swap, reducedMotion, countUp, spotlight, drawPath, parallax, marquee } from './motion.js';

const $ = (selector) => document.querySelector(selector);

/**
 * replaceChildren, but tolerant of the nulls that conditional children
 * produce. Passed a null it would otherwise append the text "null" to the
 * page, which is how an empty metrics strip ended up saying so out loud.
 */
const fill = (node, ...children) => node.replaceChildren(...children.flat().filter((child) => child != null && child !== false));

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child != null && child !== false) node.append(child);
  return node;
}

let state = { companies: {}, signedIn: false, needsPassword: false, ready: false };
let live = null;
let stage = null;
let busy = false;
// Set by the Stop button. Research is a loop of separate requests, so stopping
// is simply declining to start the next one — no request is ever abandoned
// half-done, and the work already saved stays saved.
let stopRequested = false;
let canStop = false;
let orb = null;
// How many questions the profile asks, so a progress bar is a real fraction.
let questionCount = 0;
// Which tab the list is currently showing, so only a real change of tab
// gets the cross-fade.
let painted = null;

// ---------------------------------------------------------------- talking to the API

async function call(action, args = {}) {
  const res = await fetch('/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...args }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    state.signedIn = false;
    render();
    throw new Error(body.error ?? 'Sign in to do that.');
  }
  if (!res.ok) throw new Error(body.error ?? `That failed (${res.status}).`);
  return body;
}

async function load() {
  const res = await fetch('/api/state');
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    return showClosed(error ?? `The server said ${res.status}.`);
  }
  state = await res.json();
  questionCount = state.questions ?? questionCount;
  buildTicker(state.checks);
  stage ??= firstBusyStage(state.companies);
  render();
  askTheServices();
}

// Asked once a page load, in the background: whether the keys actually work.
async function askTheServices() {
  try {
    const res = await fetch('/api/selfcheck');
    if (!res.ok) return;
    live = await res.json();
    renderHeader();
  } catch {
    // Not knowing is not worth an error on screen; the chips stay as they were.
  }
}

// Every button goes through here: one thing at a time, and the page always
// re-reads the real state afterwards rather than guessing at it.
async function run(message, work, { stoppable = false } = {}) {
  if (busy) return;
  busy = true;
  stopRequested = false;
  canStop = stoppable;
  render();
  say(message + '…', 'working');
  try {
    // Work that covers many companies reports on all of them; everything else
    // either worked or threw.
    const summary = await work();
    if (summary?.text) say(summary.text, summary.tone);
    else say(stopRequested ? 'Stopped.' : 'Done.', stopRequested ? '' : 'ok');
  } catch (error) {
    say(error.message, 'bad');
  } finally {
    busy = false;
    canStop = false;
    stopRequested = false;
    await load();
  }
}

function say(message, tone = '') {
  const status = $('#status');
  status.textContent = message;
  status.className = `status ${tone}`;
}

/**
 * A discovery sweep, one model call at a time.
 *
 * The whole sweep is six calls, several of them grounded web searches. Asking
 * for it in one request meant minutes of work behind a sixty-second limit,
 * which is where the 504 came from. Each call is its own request now, so the
 * sweep cannot time out however slow the model is, and stopping halfway keeps
 * whatever was already shortlisted.
 */
async function discoverAll() {
  let cursor = {};
  let added = 0;
  let retries = 0;
  const giveUpAfter = 4;

  // Two calls per source, plus room for a few retries: a bound, not an
  // expectation.
  for (let step = 0; step < 30; step++) {
    if (stopRequested) break;
    const result = await call('discoverStep', { cursor, limit: 10 });
    added += result.added ?? 0;
    if (result.label) say(`${result.label}…`, 'working');

    // A web search can take longer than one request is allowed. The server
    // hands back the same place in the sweep rather than dying, so this
    // asks again — a few times, and then moves on rather than looping.
    if (result.retry) {
      if (++retries > giveUpAfter) {
        return { text: `Searching is unusually slow right now. Shortlisted ${added} before giving up.`, tone: 'warn' };
      }
    } else {
      retries = 0;
    }

    if (result.done) break;
    cursor = result.cursor ?? {};
  }

  return {
    text: added ? `Shortlisted ${added} ${added === 1 ? 'company' : 'companies'}.` : 'Nothing new was found. Everything it turned up is already on the list.',
    tone: added ? 'ok' : '',
  };
}

// Research is asked for one question at a time: nothing runs long, and
// stopping costs at most the question in flight.
//
// One company failing — a quota refusal, a site that will not load — must not
// take the rest of the queue with it, the same way it does not in the CLI.
// What failed is collected and reported at the end rather than thrown away.
/** One company, to the end of its questions. */
async function researchOne(domain, position = '') {
  for (let step = 0; step < 60; step++) {
    if (stopRequested) break;
    const result = await call('researchStep', { domain });
    if (result.done) return;
    say(`${domain} — ${result.next ?? 'thinking'}${position}`, 'working');
  }
}

async function researchAll() {
  const waiting = companiesIn(state.companies, 'waiting');
  const failed = [];

  for (const [index, company] of waiting.entries()) {
    if (stopRequested) break;
    try {
      await researchOne(company.domain, ` (${index + 1} of ${waiting.length})`);
    } catch (error) {
      failed.push({ domain: company.domain, reason: error.message });
    }
  }

  return runSummary({ total: waiting.length, failed, stopped: stopRequested });
}

// ---------------------------------------------------------------- pieces

function actionButton(label, { needs = 'keys', primary = false, danger = false, onclick }) {
  const { enabled, reason } = actionState({ signedIn: state.signedIn, ready: state.ready, busy, needs });
  return h('button', {
    class: [primary && 'primary', danger && 'danger'].filter(Boolean).join(' '),
    disabled: !enabled,
    title: reason,
    onclick,
  }, label);
}

const link = (href, text, cls = 'small') =>
  h('a', { class: cls, href, target: '_blank', rel: 'noreferrer noopener' }, text);

function evidenceCell(detail) {
  const shown = evidenceWording(detail);
  if (shown.kind !== 'quote') return h('span', { class: 'soft' }, shown.text);
  return h('div', {},
    h('blockquote', {}, `“${shown.quote}”`),
    shown.url ? link(shown.url, shown.source) : h('span', { class: 'small soft' }, 'no link'),
  );
}

const evidenceTable = (company) =>
  h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Question'), h('th', {}, 'Answer'), h('th', {}, 'Because'))),
    h('tbody', {}, Object.values(company.details ?? {}).map((detail) =>
      h('tr', {}, h('td', {}, detail.label), h('td', {}, answerWording(detail)), h('td', {}, evidenceCell(detail))))),
  );

const auditTrail = (company) => {
  const lines = Object.values(company.details ?? {}).flatMap((detail) =>
    (detail.log ?? []).map((entry) => h('tr', {},
      h('td', { class: 'small soft' }, detail.label),
      h('td', { class: 'small' }, entry.source ?? ''),
      h('td', { class: 'small soft' }, entry.outcome))));

  return lines.length
    ? h('details', {}, h('summary', {}, `Where we looked (${lines.length})`), h('table', {}, h('tbody', {}, lines)))
    : null;
};

const svgEl = (name, attributes = {}) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
};

/**
 * The research as a picture: every question that got an answer, converging on
 * the verdict they produced.
 *
 * The chips are laid out by the browser, so the connecting lines can only be
 * drawn once their real positions are known — hence the measure-then-draw
 * after layout rather than coordinates worked out in advance.
 */
function evidenceGraphView(company) {
  const graph = evidenceGraph(company);
  if (!graph) return null;

  const chips = graph.nodes.map((node) =>
    h('span', {
      class: ['node', node.decided && 'decided', !node.sourced && 'unsourced'].filter(Boolean).join(' '),
      title: node.sourced ? '' : 'No source behind this answer.',
    }, node.label, ' ', h('b', {}, node.answer)));

  const wires = svgEl('svg', { class: 'wires', 'aria-hidden': 'true' });
  const hub = h('div', { class: `hub ${graph.verdict.kind}` },
    h('div', { class: 'kind' }, graph.verdict.label),
    h('div', { class: 'why' }, graph.verdict.reason));

  const view = h('div', { class: 'graph' }, wires, h('div', { class: 'chips' }, chips), hub);

  // Drawn after the browser has placed the chips, because the lines join
  // real positions and nothing knows those until layout has happened.
  requestAnimationFrame(() => {
    const box = view.getBoundingClientRect();
    if (!box.width) return;
    const hubBox = hub.getBoundingClientRect();
    const toX = hubBox.left - box.left + hubBox.width / 2;
    const toY = hubBox.top - box.top;

    for (const [index, chip] of chips.entries()) {
      const chipBox = chip.getBoundingClientRect();
      const fromX = chipBox.left - box.left + chipBox.width / 2;
      const fromY = chipBox.bottom - box.top;
      const midY = (fromY + toY) / 2;
      const path = svgEl('path', {
        d: `M ${fromX} ${fromY} C ${fromX} ${midY}, ${toX} ${midY}, ${toX} ${toY}`,
        class: graph.nodes[index].decided ? 'decided' : '',
      });
      wires.append(path);
      drawPath(path, { delay: index * 60 });
    }
  });

  return view;
}

function companyCard(company) {
  const { label, tone } = verdictWording(company.verdict);
  return h('article', { class: 'card' },
    h('div', { class: 'between' },
      h('h2', {}, company.name ?? company.domain),
      link(`https://${company.domain}`, company.domain),
    ),
    h('p', { class: 'small' },
      h('span', { class: `verdict ${tone}` }, label), ' — ', company.verdict?.reason ?? '',
      company.verdict?.code ? h('span', { class: 'pill' }, company.verdict.code.replace(/_/g, ' ')) : null,
    ),
    ...(company.verdict?.notes ?? []).map((note) => h('p', { class: 'note small' }, note)),
    company.why ? h('p', { class: 'small soft' }, `Found by ${company.foundBy}: ${company.why}`) : null,
    evidenceGraphView(company),
    h('details', {}, h('summary', {}, 'Every answer, with its source'), evidenceTable(company)),
    auditTrail(company),
    h('div', { class: 'row actions' },
      actionButton('Approve and write', { primary: true, onclick: () => run(`Approving ${company.domain}`, () => call('decide', { domain: company.domain, decision: 'approve' })) }),
      actionButton('Reject', { danger: true, needs: 'none', onclick: () => run(`Rejecting ${company.domain}`, () => call('decide', { domain: company.domain, decision: 'reject' })) }),
      actionButton('Research again', { onclick: () => run(`Reopening ${company.domain}`, () => call('researchAgain', { domain: company.domain })) }),
    ),
  );
}

function contactForm(company) {
  const first = h('input', { type: 'text', placeholder: 'First name', 'aria-label': 'First name' });
  const last = h('input', { type: 'text', placeholder: 'Last name', 'aria-label': 'Last name' });
  const title = h('input', { type: 'text', placeholder: 'Job title', 'aria-label': 'Job title' });

  return h('article', { class: 'card' },
    h('h2', {}, company.name ?? company.domain),
    h('p', { class: 'small soft' }, 'Nobody suitable was found. Name someone yourself and the draft follows.'),
    h('div', { class: 'row fields' }, first, last, title),
    h('div', { class: 'row actions' },
      actionButton('Use this contact', {
        primary: true,
        onclick: () => run(`Drafting for ${company.domain}`, () =>
          call('setContact', { domain: company.domain, firstName: first.value, lastName: last.value, title: title.value })),
      }),
    ),
  );
}

function emailCard(company) {
  if (company.status === 'no_contact') return contactForm(company);

  if (!company.email) {
    return h('article', { class: 'card' },
      h('h2', {}, company.name ?? company.domain),
      h('p', { class: 'small soft' }, 'Approved, but the contact lookup or the draft did not finish.'),
      h('div', { class: 'row actions' },
        actionButton('Carry on', { primary: true, onclick: () => run(`Finishing ${company.domain}`, () => call('resume', { domain: company.domain })) })),
    );
  }

  const contact = company.contact ?? {};
  // The ids tie the labels below to these fields, so clicking a label focuses
  // the field it names. Scoped by domain because several cards can be on the
  // page at once and an id has to be unique for the association to hold.
  const idFor = (what) => `${what}-${company.domain.replace(/[^a-z0-9]/gi, '-')}`;
  const subject = h('input', { type: 'text', id: idFor('subject'), value: company.email.subject ?? '', 'aria-label': 'Subject' });
  const body = h('textarea', { id: idFor('body'), 'aria-label': 'Body' }, company.email.body ?? '');
  const counter = h('span', { class: 'small soft' }, `${wordCount(company.email.body)} words`);
  body.addEventListener('input', () => { counter.textContent = `${wordCount(body.value)} words`; });
  const feedback = h('input', { type: 'text', placeholder: 'What should change?', 'aria-label': 'Rewrite instructions' });

  return h('article', { class: 'card' },
    h('div', { class: 'between' },
      h('h2', {}, company.name ?? company.domain),
      h('span', { class: 'small soft' }, [contact.firstName, contact.lastName].filter(Boolean).join(' ') + (contact.title ? ` — ${contact.title}` : '')),
    ),
    contact.reason ? h('p', { class: 'small soft' }, contact.reason) : null,
    ...(company.email.issues ?? []).map((issue) => h('p', { class: 'note small' }, issue)),

    h('details', {},
      h('summary', {}, 'Why this email'),
      h('p', { class: 'small' }, company.email.why_this_email ?? ''),
      h('ul', { class: 'small' }, (company.email.pain_points ?? []).map((point) => h('li', {}, `${point.pain} — ${point.why}`))),
      company.email.hook_source_url ? h('p', { class: 'small' }, 'Hook from ', link(company.email.hook_source_url, company.email.hook_source_url)) : null,
    ),

    h('label', { htmlFor: idFor('subject') }, 'Subject'), subject,
    h('div', { class: 'between' }, h('label', { htmlFor: idFor('body') }, 'Body'), counter), body,

    h('div', { class: 'row actions' },
      actionButton(sendLabel(state.emailTo), {
        primary: true,
        onclick: () => run(`Sending ${company.domain}`, () => call('send', { domain: company.domain, subject: subject.value, body: body.value })),
      }),
      actionButton('Reject draft', { danger: true, needs: 'none', onclick: () => run('Rejecting the draft', () => call('rejectEmail', { domain: company.domain })) }),
    ),
    h('div', { class: 'row actions' },
      feedback,
      actionButton('Rewrite', { onclick: () => run('Rewriting', () => call('redraft', { domain: company.domain, feedback: feedback.value })) }),
    ),
  );
}

function handoffCard(company) {
  const handoff = company.handoff ?? {};
  const answered = Object.values(company.progress?.details ?? {}).filter((d) => d.evidence);

  return h('article', { class: 'card' },
    h('div', { class: 'between' },
      h('h2', {}, company.name ?? company.domain),
      link(`https://${company.domain}`, company.domain),
    ),
    h('p', { class: 'note small' }, handoff.reason ?? 'The system stopped before it could decide.'),
    answered.length
      ? h('p', { class: 'small soft' }, `Answered before stopping: ${answered.map((d) => d.label).join(', ')}.`)
      : h('p', { class: 'small soft' }, 'Nothing was answered before it stopped.'),
    (handoff.unanswered ?? []).length ? h('p', { class: 'small soft' }, `Still open: ${handoff.unanswered.join(', ')}.`) : null,
    h('div', { class: 'row actions' },
      actionButton('Try again', { onclick: () => run(`Reopening ${company.domain}`, () => call('researchAgain', { domain: company.domain })) }),
      actionButton('Reject', { danger: true, needs: 'none', onclick: () => run(`Rejecting ${company.domain}`, () => call('decide', { domain: company.domain, decision: 'reject' })) }),
    ),
  );
}

const shortlistRow = (company) => {
  const progress = researchProgress(company);
  // A fraction of the profile's own questions, so the bar cannot overstate
  // how far along a company is.
  const ratio = progressRatio(company, questionCount);

  return h('article', { class: 'card tight' },
    h('div', { class: 'between' },
      h('div', {}, h('strong', {}, company.name ?? company.domain), ' ', h('span', { class: 'small soft' }, company.domain)),
      h('span', { class: 'small soft' }, progress.text),
    ),
    company.why ? h('p', { class: 'small soft' }, company.why) : null,
    ratio === null ? null : h('div', { class: 'bar' }, h('i', { style: `width: ${Math.round(ratio * 100)}%` })),
    h('div', { class: 'row actions' },
      actionButton('Research this one', {
        primary: true,
        onclick: () => run(`Researching ${company.domain}`, async () => {
          await researchOne(company.domain);
          return { text: `Finished ${company.domain}.`, tone: 'ok' };
        }, { stoppable: true }),
      }),
      actionButton('Remove', {
        danger: true, needs: 'none',
        onclick: () => run(`Removing ${company.domain}`, () => call('forget', { domain: company.domain })),
      }),
    ),
  );
};

const plainRow = (company) =>
  h('article', { class: 'card tight' },
    h('div', { class: 'between' },
      h('div', {}, h('strong', {}, company.name ?? company.domain), ' ', h('span', { class: 'small soft' }, company.domain)),
      h('span', { class: 'small soft' }, summaryLine(company)),
    ),
  );

// ---------------------------------------------------------------- sign in

function signInCard(message) {
  const password = h('input', { type: 'password', placeholder: 'Password', 'aria-label': 'Password' });
  const problem = h('p', { class: 'small bad' }, message ?? '');

  const submit = async () => {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password.value }),
    });
    if (res.ok) {
      $('#signin').close();
      return load();
    }
    problem.textContent = (await res.json().catch(() => ({}))).error ?? 'That did not work.';
  };

  password.addEventListener('keydown', (event) => event.key === 'Enter' && submit());
  return h('div', {},
    h('h2', {}, 'Sign in'),
    h('p', { class: 'small soft' }, 'Reading is open to anyone. Running research or sending mail needs the password, because both cost something.'),
    h('div', { class: 'row fields' }, password, h('button', { class: 'primary', onclick: submit }, 'Sign in')),
    problem,
  );
}

function openSignIn() {
  const dialog = $('#signin');
  dialog.replaceChildren(signInCard());
  dialog.showModal();
  dialog.querySelector('input')?.focus();
}

function showClosed(message) {
  $('#toolbar').hidden = true;
  $('.tabs').hidden = true;
  $('#list').replaceChildren(h('article', { class: 'card' }, h('h2', {}, 'Not available'), h('p', { class: 'small soft' }, message)));
}

// ---------------------------------------------------------------- render

function renderHeader() {
  const chips = statusChips(state, live).map((chip) =>
    h('span', {
      // A quietly blinking dot on anything confirmed working, so "ready"
      // reads as a live check rather than a label someone typed.
      class: ['pill', chip.tone ?? '', chip.tone === 'ok' && 'live'].filter(Boolean).join(' '),
      title: chip.title ?? '',
    }, chip.text));

  if (state.needsPassword) {
    chips.push(state.signedIn
      ? h('button', { class: 'linky', onclick: () => run('Signing out', () => fetch('/api/logout', { method: 'POST' })) }, 'Sign out')
      : h('button', { class: 'linky', onclick: openSignIn }, 'Sign in'));
  }
  $('#chips').replaceChildren(...chips);
}

// The rail across the top: where the companies are, as opposed to the tabs
// below, which are where your attention is needed.
function renderRail() {
  const counts = pipelineCounts(state.companies);
  const furthest = furthestStage(state.companies);
  const furthestAt = PIPELINE.findIndex((stop) => stop.id === furthest);
  // An edge only carries a pulse when something is really on the far side
  // of it, so the movement traces companies rather than running on a loop.
  const edges = railEdges(state.companies);

  fill($('#rail'), PIPELINE.map((stop, index) => {
    const edge = index > 0 ? edges[index - 1] : null;
    return h('div', {
      class: [
        'stop',
        furthestAt >= 0 && index <= furthestAt && 'done',
        stop.id === furthest && 'here',
        edge?.live && busy && 'flowing',
      ].filter(Boolean).join(' '),
    },
      h('div', { class: 'step' }, stepCounter(index, PIPELINE.length)),
      h('div', { class: 'dot' }),
      h('div', { class: 'name' }, stop.name),
      h('div', { class: 'n' }, counts[stop.id] ? String(counts[stop.id]) : ''),
    );
  }));
}

const ICONS = {
  search: 'M10.5 3a7.5 7.5 0 1 0 4.55 13.46l3.74 3.74 1.42-1.42-3.74-3.74A7.5 7.5 0 0 0 10.5 3Zm0 2a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Z',
  doc: 'M6 2h8l4 4v16H6V2Zm7 1.5V7h3.5L13 3.5ZM8 11h8v1.6H8V11Zm0 4h8v1.6H8V15Z',
};

const icon = (name, plum = false) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  return h('div', { class: `icon ${plum ? 'plum' : ''}` }, svg);
};

/** @param {{ iconName: string, plum?: boolean, title: string, body: string, label: string, onclick: Function }} options */
function doCard({ iconName, plum = false, title, body, label, onclick }) {
  const { enabled, reason } = actionState({ signedIn: state.signedIn, ready: state.ready, busy });
  return h('div', { class: 'do' },
    icon(iconName, plum),
    h('h3', {}, title),
    h('p', {}, body),
    h('div', { class: 'go' },
      h('button', { class: 'go-link', disabled: !enabled, title: reason, onclick }, `${label} →`)),
  );
}

// Only ever shown while something long is running. A run over twenty
// companies is minutes of API calls, and the only alternative to a Stop
// button is closing the tab — which looks, from the page, exactly like a
// crash.
function renderStop() {
  fill($('#stop'),
    busy && canStop
      ? h('button', {
          class: 'linky',
          onclick: () => {
            stopRequested = true;
            say('Stopping after this question…', 'working');
            renderStop();
          },
          disabled: stopRequested,
        }, stopRequested ? 'Stopping…' : 'Stop')
      : null,
  );
}

/**
 * The orb, told what to show. It is the only piece of pure decoration here,
 * and it stays honest by reading the same state everything else does: busy
 * means requests are in flight, not that a timer is running.
 */
function renderOrb() {
  const { mode, intensity, label } = orbState({ busy, stopping: stopRequested, companies: state.companies, ready: state.ready });
  const live = ['working', 'stopping'].includes(mode);

  $('#orbwrap').classList.toggle('live', live);
  $('#orblabel').textContent = label;
  orb?.setIntensity(intensity);

  // The arc is how far the whole shortlist has got, which is a different
  // question from what the orb's brightness answers.
  $('#arc')?.style.setProperty('--through', String(pipelineProgress(state.companies)));
}

/**
 * Look a company up by name, or add it straight away if you typed a domain.
 *
 * This is the thing the page was missing: every other way in went through
 * the profile's own searches, so a company you already had in mind could
 * only be added from the command line.
 */
function searchCard() {
  const field = h('input', {
    type: 'text',
    placeholder: 'acme.com, or Acme Analytics',
    'aria-label': 'Company name or website',
    id: 'lookup',
  });

  const submit = () => {
    const query = field.value.trim();
    if (!query) return say('Type a company name or a website address first.', 'bad');
    return run(`Looking up ${query}`, async () => {
      const result = await call('lookup', { query });
      if (result.added) {
        field.value = '';
        return { text: `Added ${result.company?.domain ?? query}. Research it when you are ready.`, tone: 'ok' };
      }
      return { text: result.reason ?? 'Nothing was added.', tone: 'warn' };
    });
  };

  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });

  const { enabled, reason } = actionState({ signedIn: state.signedIn, ready: state.ready, busy });
  return h('div', { class: 'do find' },
    icon('search'),
    h('h3', {}, 'Add a company you know'),
    h('p', {}, 'A website address goes straight on the list. A name is looked up first, and never guessed at.'),
    h('div', { class: 'row fields' },
      field,
      h('button', { class: 'primary', disabled: !enabled, title: reason, onclick: submit }, 'Add'),
    ),
  );
}

function renderToolbar() {
  const waiting = awaitingResearch(state.companies);
  $('#toolbar').replaceChildren(
    doCard({
      iconName: 'search',
      title: 'Find companies',
      body: 'Search free sources for companies that may need what you sell soon.',
      label: 'Find 10 companies',
      onclick: () => run('Searching for companies', discoverAll, { stoppable: true }),
    }),
    doCard({
      iconName: 'doc',
      plum: true,
      title: 'Research companies',
      body: researchQueueLine(state.companies),
      label: waiting ? 'Research shortlisted' : 'Nothing to research',
      onclick: () => run('Researching', researchAll, { stoppable: true }),
    }),
    searchCard(),
  );

  for (const card of $('#toolbar').querySelectorAll('.do')) tiltOnHover(card, { degrees: 2.4 });
  for (const button of $('#toolbar').querySelectorAll('button')) magnetic(button, { pull: 0.18 });
}

function renderBanner() {
  const { title, detail } = bannerFor(state.companies);
  fill($('#banner'), h('strong', {}, title), detail ? h('span', {}, detail) : null);
}

function renderMetrics() {
  const m = metrics(state.companies);
  if (!m.researched && !m.drafted) return $('#metrics').replaceChildren();

  const stat = (label, value, hint) =>
    h('div', { class: 'stat', title: hint ?? '' }, h('span', { class: 'figure' }, value), h('span', { class: 'label' }, label));

  fill($('#metrics'),
    stat('per company', formatDuration(m.averageMs), 'Average research time. The brief asks for under two minutes, against 15-20 by hand.'),
    stat('lookups each', m.lookupsPerCompany === null ? '—' : String(m.lookupsPerCompany), 'Pages fetched and searches run per company.'),
    stat('drafts rewritten', asPercent(m.rewriteRate), 'Rewrite more than half and the system is costing you time, not saving it.'),
    stat('contacts found', asPercent(m.contactRate), 'How often a usable contact turned up.'),
    stat('sent', String(m.sent), 'Emails sent to your own address.'),
    m.handedBack ? stat('handed back', String(m.handedBack), 'Stopped at the lookup cap and left for you.') : null,
  );

  // Kivo's analytics tiles count up the first time you see them. The real
  // figure is already in the element before this runs, so nothing depends
  // on the animation finishing.
  for (const figure of $('#metrics').querySelectorAll('.figure')) countUp(figure);
}

/**
 * The tab strip, as the ARIA tab pattern expects it: one stop in the tab
 * order, and the arrow keys move between tabs. Without this, reaching the
 * sixth tab from the keyboard means six presses of Tab through controls you
 * did not want, and screen readers announce six unrelated buttons rather
 * than one set of six.
 */
function renderTabs() {
  const counts = countsByStage(state.companies);
  // Rendering replaces these buttons, so the one that was just clicked or
  // arrowed to stops existing and focus falls back to the document. The next
  // arrow press would then go nowhere. Put it back — but only if it was in
  // the strip to begin with, so an ordinary re-render never steals focus
  // from whatever you were typing in.
  const hadFocus = $('.tabs').contains(document.activeElement);

  const move = (by) => {
    const at = STAGES.findIndex((item) => item.id === stage);
    stage = STAGES[(at + by + STAGES.length) % STAGES.length].id;
    render();
  };

  $('.tabs').replaceChildren(...STAGES.map((item) => {
    const selected = item.id === stage;
    return h('button', {
      class: 'tab', role: 'tab', id: `tab-${item.id}`, title: item.blurb,
      'aria-selected': String(selected),
      'aria-controls': 'list',
      tabIndex: selected ? 0 : -1,
      onclick: () => { stage = item.id; render(); },
      onkeydown: (event) => {
        const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
        if (!step) return;
        event.preventDefault();
        move(step);
      },
    }, item.name, h('span', { class: 'count' }, String(counts[item.id])));
  }));

  if (hadFocus) $(`#tab-${stage}`)?.focus();
  $('#blurb').textContent = stageById(stage).blurb;
  $('#list').setAttribute('aria-labelledby', `tab-${stage}`);
}

function render() {
  renderHeader();
  renderOrb();
  renderRail();
  renderStop();
  renderToolbar();
  renderBanner();
  renderMetrics();
  renderTabs();

  const current = stageById(stage);
  const mine = companiesIn(state.companies, current.id);
  const draw = { review: companyCard, emails: emailCard, waiting: shortlistRow, handoff: handoffCard }[current.id] ?? plainRow;

  // Changing tab is a change of subject, so it gets a short cross-fade the
  // way Kivo moves between pages. Within a tab — after an action — the list
  // is repainted in place, because fading the same content in and out on
  // every click would be noise.
  const paint = () => {
    fill($('#list'), mine.length ? mine.map(draw) : [h('p', { class: 'empty' }, current.empty)]);
    revealOnEntry($('#list').querySelectorAll('.card'));
    for (const card of $('#list').querySelectorAll('.card')) {
      tiltOnHover(card);
      spotlight(card);
    }
    for (const button of $('#list').querySelectorAll('button.primary')) magnetic(button);
  };

  if (current.id === painted) paint();
  else swap($('#list'), paint);
  painted = current.id;
}

$('#signin').addEventListener('click', (event) => {
  if (event.target.id === 'signin') $('#signin').close();
});

// The scene behind the hero. Built once; the dot field is painted once and
// left to drift under CSS, because repainting a full-width field every frame
// is real battery for something nobody looks at directly.
/**
 * The headline, set a word at a time behind a mask so it arrives rather than
 * appears. Done once on load: it is the front door, not something that should
 * replay every time the page re-renders.
 *
 * The words come from the markup, so the sentence stays in the HTML where a
 * reader or a search engine can find it, and the effect is only ever added on
 * top of text that is already there.
 */
function typeHeadline() {
  const heading = $('.hero h1');
  if (reducedMotion()) return heading.classList.add('typed');

  for (const part of [...heading.childNodes]) {
    const words = (part.textContent ?? '').split(/(\s+)/).filter(Boolean);
    const pieces = words.map((word) => {
      if (!word.trim()) return document.createTextNode(word);
      const mask = h('span', { class: 'mask' }, h('span', {}, word));
      return mask;
    });
    part.replaceWith(...(part.nodeType === 1 ? [h(part.nodeName.toLowerCase(), {}, pieces)] : pieces));
  }

  let delay = 0;
  for (const word of heading.querySelectorAll('.mask > span')) {
    word.style.transitionDelay = `${delay}ms`;
    delay += 42;
  }
  requestAnimationFrame(() => heading.classList.add('typed'));
}

/** The strip of what every company is checked against. */
function buildTicker(checks) {
  const track = $('#ticker .track');
  if (!checks?.length || track.childElementCount) return;
  fill(track, checks.map((label) => h('span', { class: 'check' }, label)));
  marquee(track);
}

function buildScene() {
  typeHeadline();
  orb = new ResearchOrb($('#orb'));
  const field = $('#field');
  const repaint = () => paintDotField(field);
  repaint();

  let timer = null;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(repaint, 160);
  });
  // Light and dark have different amber; the field is drawn with it.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => setTimeout(repaint, 60));
  if (reducedMotion()) field.hidden = true;

  // Depth on scroll: the wash furthest back moves least, the orb most. Small
  // rates on purpose — at the depth a marketing page uses, the background
  // slides behind text you are trying to read.
  parallax([
    { node: $('.glow'), rate: 0.16 },
    { node: field, rate: 0.09 },
    { node: $('#orbwrap'), rate: -0.05 },
  ]);
}

buildScene();
load();
