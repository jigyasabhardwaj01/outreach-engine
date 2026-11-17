// Putting view.js's answers on screen. Everything that decides anything lives
// there; this file only builds elements and talks to the API.
import {
  STAGES, stageById, companiesIn, countsByStage, firstBusyStage, awaitingResearch,
  PIPELINE, pipelineCounts, furthestStage, bannerFor, researchQueueLine,
  actionState, verdictWording, answerWording, evidenceWording, sourceLabel, wordCount, sendLabel, summaryLine, researchProgress,
} from './view.js';

const $ = (selector) => document.querySelector(selector);

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
let stage = null;
let busy = false;

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
}

// Every button goes through here: one thing at a time, and the page always
// re-reads the real state afterwards rather than guessing at it.
async function run(message, work) {
  if (busy) return;
  busy = true;
  render();
  say(message + '…', 'working');
  try {
    await work();
    say('Done.', 'ok');
  } catch (error) {
    say(error.message, 'bad');
  } finally {
    busy = false;
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
async function researchAll() {
  const waiting = companiesIn(state.companies, 'waiting');
  for (const [index, company] of waiting.entries()) {
    for (let step = 0; step < 60; step++) {
      const result = await call('researchStep', { domain: company.domain });
      if (result.done) break;
      say(`${company.domain} — ${result.next ?? 'thinking'} (${index + 1} of ${waiting.length})`, 'working');
    }
  }
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
  const subject = h('input', { type: 'text', value: company.email.subject ?? '', 'aria-label': 'Subject' });
  const body = h('textarea', { 'aria-label': 'Body' }, company.email.body ?? '');
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

    h('label', { for: 'subject' }, 'Subject'), subject,
    h('div', { class: 'between' }, h('label', { for: 'body' }, 'Body'), counter), body,

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
  const chips = [];
  if (!state.ready) chips.push(h('span', { class: 'pill warn' }, 'no Gemini key'));
  chips.push(h('span', { class: 'pill' }, state.emailTo ? `sends to ${state.emailTo}` : 'EMAIL_TO not set'));

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

function doCard({ iconName, plum, title, body, label, onclick }) {
  const { enabled, reason } = actionState({ signedIn: state.signedIn, ready: state.ready, busy });
  return h('div', { class: 'do' },
    icon(iconName, plum),
    h('h3', {}, title),
    h('p', {}, body),
    h('div', { class: 'go' },
      h('button', { class: 'go-link', disabled: !enabled, title: reason, onclick }, `${label} →`)),
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
      onclick: () => run('Researching', researchAll),
    }),
  );
}

function renderBanner() {
  const { title, detail } = bannerFor(state.companies);
  $('#banner').replaceChildren(h('strong', {}, title), detail ? h('span', {}, detail) : null);
}

function renderTabs() {
  const counts = countsByStage(state.companies);
  $('.tabs').replaceChildren(...STAGES.map((item) =>
    h('button', {
      class: 'tab', role: 'tab', id: `tab-${item.id}`, title: item.blurb,
      'aria-selected': String(item.id === stage),
      onclick: () => { stage = item.id; render(); },
    }, item.name, h('span', { class: 'count' }, String(counts[item.id])))));
  $('#blurb').textContent = stageById(stage).blurb;
}

function render() {
  renderHeader();
  renderRail();
  renderToolbar();
  renderBanner();
  renderTabs();

  const current = stageById(stage);
  const mine = companiesIn(state.companies, current.id);
  const draw = { review: companyCard, emails: emailCard, waiting: shortlistRow }[current.id] ?? plainRow;

  $('#list').replaceChildren(
    ...(mine.length ? mine.map(draw) : [h('p', { class: 'empty' }, current.empty)]),
  );
}

$('#signin').addEventListener('click', (event) => {
  if (event.target.id === 'signin') $('#signin').close();
});

load();
