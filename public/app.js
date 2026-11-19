// Putting view.js's answers on screen. Everything that decides anything lives
// there; this file only builds elements and talks to the API.
import {
  STAGES, stageById, companiesIn, countsByStage, firstBusyStage, awaitingResearch,
  PIPELINE, pipelineCounts, furthestStage, bannerFor, researchQueueLine, runSummary,
  metrics, formatDuration, asPercent, statusChips,
  actionState, verdictWording, answerWording, evidenceWording, wordCount, sendLabel, summaryLine, researchProgress,
} from './view.js';

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

// Research is asked for one question at a time: nothing runs long, and
// stopping costs at most the question in flight.
//
// One company failing — a quota refusal, a site that will not load — must not
// take the rest of the queue with it, the same way it does not in the CLI.
// What failed is collected and reported at the end rather than thrown away.
async function researchAll() {
  const waiting = companiesIn(state.companies, 'waiting');
  const failed = [];

  for (const [index, company] of waiting.entries()) {
    if (stopRequested) break;
    try {
      for (let step = 0; step < 60; step++) {
        if (stopRequested) break;
        const result = await call('researchStep', { domain: company.domain });
        if (result.done) break;
        say(`${company.domain} — ${result.next ?? 'thinking'} (${index + 1} of ${waiting.length})`, 'working');
      }
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
    evidenceTable(company),
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
  return h('article', { class: 'card tight' },
    h('div', { class: 'between' },
      h('div', {}, h('strong', {}, company.name ?? company.domain), ' ', h('span', { class: 'small soft' }, company.domain)),
      h('span', { class: 'small soft' }, progress.text),
    ),
    company.why ? h('p', { class: 'small soft' }, company.why) : null,
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
    h('span', { class: `pill ${chip.tone ?? ''}`.trim(), title: chip.title ?? '' }, chip.text));

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
  const furthestAt = PIPELINE.findIndex((s) => s.id === furthest);

  $('#rail').replaceChildren(...PIPELINE.map((stop, index) =>
    h('div', {
      class: ['stop', furthestAt >= 0 && index <= furthestAt && 'done', stop.id === furthest && 'here'].filter(Boolean).join(' '),
    },
      h('div', { class: 'dot' }),
      h('div', { class: 'name' }, stop.name),
      h('div', { class: 'n' }, counts[stop.id] ? String(counts[stop.id]) : ''),
    )));
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

function renderToolbar() {
  const waiting = awaitingResearch(state.companies);
  $('#toolbar').replaceChildren(
    doCard({
      iconName: 'search',
      title: 'Find companies',
      body: 'Search free sources for companies that may need what you sell soon.',
      label: 'Find 10 companies',
      onclick: () => run('Searching for companies', async () => {
        const { added } = await call('discover', { limit: 10 });
        say(`Shortlisted ${added}.`, 'ok');
      }),
    }),
    doCard({
      iconName: 'doc',
      plum: true,
      title: 'Research companies',
      body: researchQueueLine(state.companies),
      label: waiting ? 'Research shortlisted' : 'Nothing to research',
      onclick: () => run('Researching', researchAll, { stoppable: true }),
    }),
  );
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
  renderRail();
  renderStop();
  renderToolbar();
  renderBanner();
  renderMetrics();
  renderTabs();

  const current = stageById(stage);
  const mine = companiesIn(state.companies, current.id);
  const draw = { review: companyCard, emails: emailCard, waiting: shortlistRow, handoff: handoffCard }[current.id] ?? plainRow;

  fill($('#list'), mine.length ? mine.map(draw) : [h('p', { class: 'empty' }, current.empty)]);
}

$('#signin').addEventListener('click', (event) => {
  if (event.target.id === 'signin') $('#signin').close();
});

load();
