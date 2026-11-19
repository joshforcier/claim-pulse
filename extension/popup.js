import { PHASES, phaseStep, statusLabel, pretty } from './lib/phases.js';
import { currentPhase, isOpen, hasPhaseModel, fmtDate, daysSince, parseDate, docLabel } from './lib/claims.js';
import { BENCHMARKS, estimateClaim, personalHistory, estimateReview, claimDuration } from './lib/estimates.js';
import { TYPE_LABEL, statusInfo, isActive, requestDate, decisionDate, deadlines, reviewHistory, docketLabel } from './lib/appeals.js';

const VA = 'https://www.va.gov';
const AUTO_REFRESH_MS = 5 * 60 * 1000;
const SOON_DAYS = 60;

const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });
if (new URLSearchParams(location.search).has('tab')) document.body.classList.add('tab');

let STATE = null;
let REAL = null; // the user's own state while the example is showing
let DEMO = false;
let busy = false;
const ui = { view: 'home', claimId: null, allDocs: false, allDeadlines: false, allPast: false, allChanges: false };

// ---------- DOM helpers (API text always becomes text nodes) ----------

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.setAttribute('style', v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Static icon markup (our own constants only).
const ICONS = {
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/>',
  sentBack: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  bars: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
};
function icon(name, { size = 20, color = 'currentColor', width = 2 } = {}) {
  const t = document.createElement('template');
  t.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return t.content.firstChild;
}
function logo(size = 24) {
  const t = document.createElement('template');
  t.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="#0B6B61"/><path d="M4 13h4l2-5 3 9 2-5h5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return t.content.firstChild;
}

const ext = (href, ...kids) => h('a', { href, target: '_blank', rel: 'noopener' }, ...kids);
const plural = (n, w, ws = `${w}s`) => `${n} ${n === 1 ? w : ws}`;
const short = (d) => (d ? (d instanceof Date ? d : parseDate(d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—');
const ago = (iso) => {
  if (!iso) return 'Not updated yet';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return 'Updated just now';
  if (m < 60) return `Updated ${m} min ago`;
  const hr = Math.round(m / 60);
  return hr < 48 ? `Updated ${plural(hr, 'hour')} ago` : `Updated ${fmtDate(new Date(iso))}`;
};
const go = (patch) => {
  Object.assign(ui, patch);
  render();
  window.scrollTo(0, 0);
};
const toggle = (key) => {
  ui[key] = !ui[key];
  render();
};

// ---------- plain-language helpers ----------

const PLAIN_PHASE = [
  null,
  'VA received your claim.',
  'VA is doing a first review of your claim.',
  'VA is gathering evidence for your claim.',
  'VA is reviewing the evidence for your claim.',
  'VA is deciding your claim and your rating.',
  'VA is preparing your decision letter.',
  'A senior reviewer is doing a final check of your decision.',
  'VA has decided your claim.',
];
const STEP_NAME = [null, ...PHASES.map((p) => p.name)];
const STEP_DESC = [
  null,
  'VA logged your claim.',
  'VA checks that your claim has the basic information.',
  'VA collects records and exam results. Usually the longest step.',
  'VA looks over everything it gathered.',
  'VA decides your claim and your rating.',
  'VA writes your decision letter.',
  'A senior reviewer checks the decision.',
  'Your letter is ready on VA.gov and in the mail.',
];

function claimTitle(a) {
  if (/disability compensation/i.test(a.claimTypeBase || a.displayTitle || '')) return 'Disability claim';
  return a.displayTitle || a.claimType || 'Claim';
}

// VA often sends condition names in ALL CAPS. Lower-case long shouted words and
// small joining words, keep short acronyms (PTSD, TBI stay as-is).
const SMALL = new Set(['TO', 'OF', 'AND', 'THE', 'IN', 'ON', 'WITH', 'FOR', 'OR', 'DUE', 'AS']);
function sentenceCase(s) {
  if (!s) return s;
  const out = s.replace(/\b[A-Z][A-Z]+\b/g, (w) => (w.length >= 5 || SMALL.has(w) ? w.toLowerCase() : w));
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function outcomeSummary(appeal) {
  const issues = appeal.attributes?.status?.details?.issues || appeal.attributes?.issues || [];
  const n = (re) => issues.filter((i) => re.test(i.disposition || i.lastAction || '')).length;
  const g = n(/grant|allow/i);
  const d = n(/den/i);
  const r = n(/remand/i);
  if (!issues.length) return { text: 'Decided', cls: 'bad' };
  if (g && !d && !r) return { text: `${plural(g, 'issue')} granted`, short: `${g} granted`, cls: 'ok' };
  if (d && !g && !r) return { text: `${plural(d, 'issue')} denied`, short: `${d} denied`, cls: 'bad' };
  const parts = [g && `${g} granted`, d && `${d} denied`, r && `${r} sent back`].filter(Boolean);
  return { text: parts.join(', '), short: parts.join(', '), cls: 'bad' };
}

// ---------- data shaping ----------

function model() {
  const s = STATE || {};
  const claims = s.claims || [];
  const appeals = s.appeals || [];
  const byDate = (a, b) => String(b.attributes.claimDate).localeCompare(String(a.attributes.claimDate));
  return {
    s,
    tracked: claims.filter((c) => hasPhaseModel(c.attributes) && isOpen(c.attributes)).sort(byDate),
    otherOpen: claims.filter((c) => !hasPhaseModel(c.attributes) && isOpen(c.attributes)).sort(byDate),
    closedClaims: claims.filter((c) => !isOpen(c.attributes)).sort(byDate),
    activeAppeals: appeals.filter(isActive),
    pastAppeals: appeals.filter((a) => !isActive(a)).sort((a, b) => String(decisionDate(b)).localeCompare(String(decisionDate(a)))),
    appeals,
    claims,
    deadlines: deadlines(appeals),
    events: s.events || [],
  };
}

// ---------- shell ----------

function header({ back } = {}) {
  const meta = STATE?.meta || {};
  const refresh = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Check for updates now', 'aria-busy': busy ? 'true' : 'false', onclick: doRefresh }, icon('refresh'));
  if (back) {
    return h('header', { class: 'bar' },
      h('button', { class: 'back', type: 'button', onclick: () => go({ view: 'home' }) }, icon('back', { width: 2.2 }), back),
      h('div', { class: 'bar-right' }, refresh));
  }
  return h('header', { class: 'bar' },
    h('div', { class: 'brand' }, logo(), 'Claim Pulse'),
    h('div', { class: 'bar-right' }, h('span', { class: 'updated' }, busy ? 'Checking…' : ago(meta.lastOkAt)), refresh));
}

function footer() {
  return h('footer', { class: 'foot' },
    h('span', null, 'Your info stays on this computer. Not affiliated with VA.'),
    h('button', { class: 'btn-link', type: 'button', onclick: () => go({ view: 'settings' }) }, 'Settings'));
}

function signedOutBanner(meta) {
  if (meta.auth === 'signed_out') {
    return h('div', { class: 'note warn' }, icon('info', { color: '#9a4a00' }),
      h('div', { class: 'stack-2' },
        h('strong', null, "You're signed out of VA.gov"),
        h('span', null, `Showing what was saved ${meta.lastOkAt ? `on ${fmtDate(new Date(meta.lastOkAt))}` : 'earlier'}. `, ext(`${VA}/my-va/`, 'Sign in to update'), '.')));
  }
  if (meta.auth === 'error') {
    return h('div', { class: 'note warn' }, icon('alert', { color: '#9a4a00' }),
      h('span', null, "Couldn't reach VA.gov just now. Showing saved info. Try the refresh button in a minute."));
  }
  return null;
}

// ---------- views ----------

function viewSignedOut() {
  return h('div', { class: 'welcome' },
    h('div', { class: 'brand' }, logo(28), 'Claim Pulse'),
    h('section', { class: 'stack-2', style: 'gap:8px' },
      h('h1', null, 'Sign in to VA.gov to see your claims'),
      h('p', { class: 'p', style: 'color:var(--ink-2)' }, 'Claim Pulse reads your claim status from VA.gov using your own sign-in. It never sees your password.')),
    ext(`${VA}/my-va/`, 'Sign in to VA.gov'),
    h('p', { class: 'p small', style: 'margin-top:-8px;text-align:center;font-size:14px' }, 'Then click the Claim Pulse button again.'),
    h('button', { class: 'btn-link', type: 'button', onclick: startDemo, style: 'align-self:center' }, 'See an example with sample data first'),
    h('section', { class: 'card', style: 'gap:12px' },
      h('strong', null, "Once you're signed in, you'll see:"),
      h('ul', { class: 'clean icon-lines' },
        ['Exactly which step your claim is on, out of 8', 'An estimate of when it will be decided', 'A heads-up when anything changes', 'Deadlines to ask for another review'].map((t) =>
          h('li', null, icon('check', { color: '#0B6B61', width: 2.4 }), h('span', null, t))))),
    h('p', { class: 'p small', style: 'margin-top:auto' }, "Your info stays on this computer. Claim Pulse isn't affiliated with VA."));
}

function viewHome() {
  const m = model();
  const meta = m.s.meta || {};
  const inProgress = m.tracked.length + m.otherOpen.length + m.activeAppeals.length;
  const soon = m.deadlines.filter((d) => d.daysLeft <= SOON_DAYS);
  const needsYou = m.tracked.filter((c) => c.attributes.documentsNeeded || (c.attributes.trackedItems || []).some((t) => String(t.status).toUpperCase() === 'NEEDED_FROM_YOU'));

  const attentionCount = soon.length + needsYou.length;
  const lede = attentionCount
    ? `${plural(attentionCount, 'thing needs', 'things need')} your attention.`
    : 'Nothing needs your attention right now.';

  const main = h('main', null,
    signedOutBanner(meta),
    h('section', { class: 'stack-2', style: 'gap:4px' },
      h('h1', null, inProgress ? `You have ${plural(inProgress, 'thing')} in progress` : 'Nothing in progress right now'),
      h('p', { class: 'lede' }, lede)),

    needsYou.map((c) => h('section', { class: 'attention' },
      h('div', { style: 'display:flex;gap:10px' }, icon('alert', { size: 24, color: '#9a4a00' }),
        h('div', { class: 'stack-2', style: 'gap:4px' },
          h('span', { class: 't' }, 'VA needs something from you'),
          h('span', { class: 'b' }, `For your ${claimTitle(c.attributes).toLowerCase()} filed ${fmtDate(c.attributes.claimDate)}.`))),
      ext(`${VA}/track-claims/your-claims/${encodeURIComponent(c.id)}/files`, 'See what VA needs'))),

    soon.slice(0, 1).map((d) => h('section', { class: 'attention' },
      h('div', { style: 'display:flex;gap:10px' }, icon('calendar', { size: 24, color: '#9a4a00' }),
        h('div', { class: 'stack-2', style: 'gap:4px' },
          h('span', { class: 't' }, `${plural(d.daysLeft, 'day')} left to ask for another review`),
          h('span', { class: 'b' }, `If you disagree with VA's decision from ${fmtDate(d.decisionDate)}, you have until `, h('strong', null, fmtDate(d.dueDate)), ' to ask VA to look again.'))),
      h('button', { class: 'btn-soft', type: 'button', onclick: () => go({ view: 'reviews' }) }, soon.length > 1 ? `See all ${soon.length} deadlines` : 'See your options'))),

    inProgress ? h('h2', { class: 'kicker' }, 'In progress') : null,
    m.tracked.map(claimCard),
    m.activeAppeals.map(appealCard),
    m.otherOpen.map((c) => h('div', { class: 'card', style: 'gap:4px' },
      h('span', { class: 'title' }, c.attributes.displayTitle || 'Application'),
      h('span', { class: 'small' }, `Received ${fmtDate(c.attributes.claimDate)}`),
      h('span', { style: 'margin-top:6px' }, otherStatus(c.attributes)))),

    m.events.length ? [h('h2', { class: 'kicker' }, 'What changed recently'), changeList(m.events, 5, 'allChanges')] : null,

    m.appeals.length || m.closedClaims.length
      ? h('ul', { class: 'clean list-card' },
          m.appeals.length ? navRow('Reviews, appeals and deadlines', `${plural(m.deadlines.length, 'open deadline')}`, () => go({ view: 'reviews' })) : null,
          m.closedClaims.length ? navRow('Past claims', `${m.closedClaims.length} closed`, () => go({ view: 'past' })) : null)
      : null);

  return [header(), main, footer()];
}

function navRow(title, sub, onclick) {
  return h('li', { style: 'padding:0' },
    h('button', { type: 'button', onclick, class: 'link-card', style: 'border:0;border-radius:0;flex-direction:row;justify-content:space-between;align-items:center;padding:14px 16px' },
      h('span', { class: 'stack-2' }, h('strong', null, title), h('span', { class: 'small' }, sub)),
      icon('chevron', { color: '#555E68' })));
}

function otherStatus(a) {
  const s = String(a.status || '').toLowerCase();
  if (/received|pending/.test(s)) return 'Received. Waiting for VA to review.';
  return statusLabel(a.status);
}

function claimCard(c) {
  const a = c.attributes;
  const pd = a.claimPhaseDates || {};
  const step = phaseStep(currentPhase(a));
  const back = !!pd.currentPhaseBack;
  const est = estimateClaim(a);
  return h('button', { type: 'button', class: 'link-card', onclick: () => go({ view: 'claim', claimId: c.id, allDocs: false }) },
    h('div', { class: 'row-top' },
      h('div', { class: 'stack-2' }, h('span', { class: 'title' }, claimTitle(a)), h('span', { class: 'small' }, `Filed ${fmtDate(a.claimDate)}`)),
      icon('chevron', { color: '#555E68' })),
    h('div', { class: 'stack-2', style: 'gap:6px' },
      h('strong', null, step ? `Step ${step} of 8: ${STEP_NAME[step]}` : statusLabel(a.status)),
      step ? segBar(step, back) : null),
    back ? h('div', { class: 'inline-warn' }, icon('sentBack', { size: 16, color: '#9a4a00', width: 2.2 }), `Sent back to this step on ${short(pd.phaseChangeDate)}`) : null,
    a.documentsNeeded ? h('div', { class: 'inline-warn' }, icon('alert', { size: 16, color: '#9a4a00', width: 2.2 }), 'VA needs something from you') : null,
    est?.window ? h('div', { class: 'foot-row' }, h('span', null, 'Estimated decision'), h('strong', null, `${short(est.window[0])} – ${short(est.window[1])}`)) : null);
}

function segBar(step, back) {
  return h('div', { class: 'seg', 'aria-hidden': 'true' },
    PHASES.map((_, i) => h('i', { class: i + 1 < step ? 'done' : i + 1 === step ? `cur${back ? ' sent' : ''}` : '' })));
}

function appealCard(ap) {
  const est = estimateReview(ap);
  const info = statusInfo(ap);
  const issues = (ap.attributes.issues || []).length;
  const pct = est ? Math.min(100, Math.round((est.elapsed / est.goalDays) * 100)) : 0;
  return h('button', { type: 'button', class: 'link-card', onclick: () => go({ view: 'reviews' }) },
    h('div', { class: 'row-top' },
      h('div', { class: 'stack-2' },
        h('span', { class: 'title' }, TYPE_LABEL[ap.type] || 'Appeal'),
        h('span', { class: 'small' }, `Filed ${fmtDate(requestDate(ap))}${issues ? ` · ${plural(issues, 'issue')}` : ''}`)),
      icon('chevron', { color: '#555E68' })),
    h('strong', null, info.plain || info.title),
    est ? h('div', { class: 'stack-2', style: 'gap:6px' },
      h('div', { class: `meter${est.elapsed > est.goalDays ? ' over' : ''}`, 'aria-hidden': 'true' }, h('i', { style: `width:${pct}%` })),
      h('span', { class: 'small' }, `Day ${est.elapsed} of VA's ${est.goalDays}-day ${est.label === 'VA goal' ? 'goal' : 'estimate'}`)) : null,
    est ? h('div', { class: 'foot-row' }, h('span', null, est.remaining >= 0 ? 'Expected by about' : 'VA goal date was'), h('strong', null, short(est.target))) : null);
}

function changeList(events, n, key) {
  const shown = ui[key] ? events.slice(0, 40) : events.slice(0, n);
  const titleFor = (e) => (e.claimTitle === 'Claim for disability compensation' ? 'Disability claim' : e.claimTitle);
  return h('ul', { class: 'clean list-card' },
    shown.map((e) => h('li', { class: e.seen ? '' : 'new' },
      h('span', null, h('strong', null, titleFor(e)), ': ', e.text),
      h('span', { class: 'small' }, `Noticed ${fmtDate(new Date(e.at))}`))),
    events.length > n ? h('li', { class: 'more' }, h('button', { class: 'btn-link', type: 'button', onclick: () => toggle(key) }, ui[key] ? 'Show fewer' : `Show ${Math.min(events.length, 40) - n} more`)) : null);
}

// ---------- claim detail ----------

function viewClaim() {
  const m = model();
  const c = m.claims.find((x) => x.id === ui.claimId);
  if (!c) return viewHome();
  const a = c.attributes;
  const pd = a.claimPhaseDates || {};
  const step = phaseStep(currentPhase(a));
  const back = !!pd.currentPhaseBack;
  const est = estimateClaim(a);
  const hist = personalHistory(m.claims);
  const events = m.events.filter((e) => e.claimId === c.id);
  const items = a.trackedItems || [];
  const fromYou = items.filter((t) => String(t.status).toUpperCase() === 'NEEDED_FROM_YOU');
  const fromOthers = items.filter((t) => String(t.status).toUpperCase() === 'NEEDED_FROM_OTHERS');

  const main = h('main', null,
    h('section', { class: 'stack-2' },
      h('h1', null, claimTitle(a)),
      h('span', { class: 'small', style: 'font-size:14px' }, `Filed ${fmtDate(a.claimDate)} · open ${plural(est.daysOpen ?? 0, 'day')}`)),

    // What's happening
    h('section', { class: 'card' },
      h('h2', null, "What's happening"),
      h('p', { class: 'big' }, PLAIN_PHASE[step] || statusLabel(a.status)),
      back ? h('div', { class: 'note warn' }, icon('sentBack', { color: '#9a4a00', width: 2.2 }),
        h('span', null, 'Your claim moved ahead, then was ', h('strong', null, `sent back to this step on ${short(pd.phaseChangeDate)}`),
          ". This often means VA needs another exam or more information. You don't need to do anything unless VA asks.")) : null,
      a.decisionLetterSent && isOpen(a) ? h('div', { class: 'note info' }, icon('info', { color: '#1f3f8f' }),
        h('span', null, 'VA says a decision letter was sent, but this claim is still open. It may be a decision on part of your claim. ', ext(`${VA}/track-claims/your-claim-letters`, 'Check your letters'), '.')) : null,
      c.stale ? h('p', { class: 'p small' }, `Couldn't load the newest details. Showing info from ${fmtDate(new Date(c.fetchedAt))}.`) : null),

    // When will it be done?
    est?.window ? estimateCard(est, hist) : null,

    // Where your claim is
    step ? stepsCard(step, back, c.phaseLog || [], a) : null,

    // Do you need to do anything?
    fromYou.length || a.documentsNeeded
      ? h('section', { class: 'attention' },
          h('div', { style: 'display:flex;gap:10px' }, icon('alert', { size: 24, color: '#9a4a00' }),
            h('div', { class: 'stack-2', style: 'gap:4px' },
              h('span', { class: 't' }, 'VA needs something from you'),
              fromYou.length ? h('ul', { class: 'bullets b' }, fromYou.map((t) => h('li', null, t.friendlyName || t.displayName || 'Request', t.suspenseDate ? ` (by ${fmtDate(t.suspenseDate)})` : ''))) : null)),
          ext(`${VA}/track-claims/your-claims/${encodeURIComponent(c.id)}/files`, 'Respond on VA.gov'))
      : h('section', { class: 'note ok', style: 'padding:16px;border-radius:14px' }, icon('checkCircle', { size: 22, color: '#1E6B3A', width: 2.4 }),
          h('div', { class: 'stack-2' }, h('strong', null, 'Nothing needed from you right now'),
            h('span', null, "VA isn't asking you for anything. Claim Pulse will tell you if that changes."))),

    fromOthers.length ? h('section', { class: 'card' }, h('h2', null, 'VA is waiting on'),
      h('ul', { class: 'bullets' }, fromOthers.map((t) => h('li', null, t.friendlyName || t.displayName || 'Records', t.suspenseDate ? h('span', { class: 'small' }, ` · due ${fmtDate(t.suspenseDate)}`) : null)))) : null,

    docsCard(a),

    (a.contentions || []).length ? h('section', { class: 'card', style: 'gap:8px' }, h('h2', null, 'What you claimed'),
      h('ul', { class: 'bullets' }, a.contentions.map((x) => h('li', null, sentenceCase(x.name))))) : null,

    events.length ? [h('h2', { class: 'kicker' }, 'What changed'), changeList(events, 4, 'allChanges')] : null,

    ext(`${VA}/track-claims/your-claims/${encodeURIComponent(c.id)}/status`, 'Open this claim on VA.gov ', icon('external', { size: 18, color: '#fff', width: 2.2 })),

    h('details', { class: 'tech' }, h('summary', null, 'Technical details'),
      h('pre', null, JSON.stringify(a, (k, v) => (k === 'claimStatusMeta' ? undefined : v), 2))));

  // style the VA.gov links that act as buttons
  main.querySelectorAll('a[href*="/status"]').forEach((el) => (el.className = 'btn-primary'));
  main.querySelectorAll('.attention > a').forEach((el) => (el.className = 'btn-soft'));
  return [header({ back: 'All claims' }), main];
}

function estimateCard(est, hist) {
  const weeks = (d) => Math.max(1, Math.round(d / 7));
  const [lo, hi] = est.fromNow;
  const likely = hi <= 13 ? `Most likely within ${plural(Math.max(hi, 1), 'day')}` : `Most likely in ${weeks(lo)} to ${weeks(hi)} weeks`;
  const stepLine = est.overTypical
    ? h('span', null, `This step usually takes `, h('strong', null, `${est.typical[0]}–${est.typical[1]} days`), `. Your claim is on `, h('strong', null, `day ${est.elapsed}`), ', so it is running long. It could move any day.')
    : h('span', null, `This step usually takes `, h('strong', null, `${est.typical[0]}–${est.typical[1]} days`), `. Your claim is on `, h('strong', null, `day ${est.elapsed}`), ', which is normal.');
  const avg = Math.round(est.national.days);
  const natLine = est.national.delta > 0
    ? h('span', null, "VA's average for all claims is ", h('strong', null, `${avg} days`), `. Yours is at ${est.daysOpen} days, ${est.national.delta > 30 ? 'well' : 'a little'} over.`)
    : h('span', null, "VA's average for all claims is ", h('strong', null, `${avg} days`), `. Yours is at ${est.daysOpen} days.`);
  return h('section', { class: 'card', style: 'gap:12px' },
    h('h2', null, 'When will it be done?'),
    h('div', { class: 'stack-2' },
      h('span', { class: 'est-big' }, `${short(est.window[0])} – ${short(est.window[1])}`),
      h('span', { class: 'small', style: 'font-size:15px' }, likely)),
    h('ul', { class: 'clean icon-lines' },
      h('li', null, icon('clock', { color: '#0B6B61' }), stepLine),
      h('li', null, icon('bars', { color: '#0B6B61' }), natLine),
      hist ? h('li', null, icon('person', { color: '#0B6B61' }),
        h('span', null, hist.count === 1 ? 'Your last claim took ' : 'Your past claims took ', h('strong', null, hist.count === 1 ? `${hist.avg} days` : `${hist.min}–${hist.max} days`), '.')) : null),
    h('p', { class: 'p small' }, 'This is an estimate, not a promise from VA. ',
      ext(BENCHMARKS.claimAverage.url, 'VA average'), ' · ', ext(BENCHMARKS.stepsSource.url, 'typical step times')));
}

function stepsCard(step, back, log, a) {
  const pd = a.claimPhaseDates || {};
  const entryFor = (n) => [...log].reverse().find((e) => !e.gap && phaseStep(e.phase) === n && e.to);
  const range = (e) => {
    const d = daysBetween(e.from, e.to);
    const span = e.from === e.to || d === 0 ? `${short(e.to)} · same day` : `${short(e.from)} – ${short(e.to)} · ${plural(d, 'day')}`;
    return span;
  };
  const inStep = daysSince(pd.phaseChangeDate);
  return h('section', { class: 'card', style: 'gap:12px' },
    h('h2', null, 'Where your claim is'),
    h('ol', { class: 'clean steps' },
      PHASES.map((_, i) => {
        const n = i + 1;
        if (n < step) {
          const e = entryFor(n);
          return h('li', { class: 'done' }, h('span', { class: 'dot', 'aria-label': 'Done' }, icon('check', { size: 16, color: '#fff', width: 3 })),
            h('div', { class: 'stack-2' }, h('strong', null, `${n}. ${STEP_NAME[n]}`), e ? h('span', { class: 'small' }, range(e)) : null));
        }
        if (n === step) {
          return h('li', { class: `cur${back ? '' : ' ok'}` }, h('span', { class: 'dot' }, n),
            h('div', { class: 'stack-2' },
              h('strong', null, STEP_NAME[n], ' ', h('span', { class: 'here' }, '· you are here')),
              h('span', { class: 'desc' }, STEP_DESC[n]),
              pd.phaseChangeDate ? h('span', { class: 'when' }, `Since ${short(pd.phaseChangeDate)}${back ? ' (sent back)' : ''} · ${plural(inStep, 'day')}`) : null,
              back ? earlierProgress(log, step) : null));
        }
        return h('li', { class: 'todo' }, h('span', { class: 'dot' }, n),
          h('div', { class: 'stack-2' }, h('strong', null, STEP_NAME[n]), h('span', { class: 'small' }, STEP_DESC[n])));
      })),
    h('p', { class: 'p small' }, `VA.gov shows this as "${statusLabel(a.status).split(':')[0]}". VA tracks 8 steps behind the scenes.`));
}

// Where the claim got to before it was sent back (from our own log; VA drops these dates).
function earlierProgress(log, step) {
  const ahead = log.filter((e) => !e.gap && e.to && phaseStep(e.phase) > step);
  if (!ahead.length) return h('span', { class: 'when' }, "VA doesn't show how far it got before it was sent back.");
  const top = ahead.reduce((x, y) => (phaseStep(y.phase) > phaseStep(x.phase) ? y : x));
  const n = phaseStep(top.phase);
  return h('span', { class: 'when' }, `Before that it reached Step ${n} (${STEP_NAME[n]}), ${short(top.from)} – ${short(top.to)}.`);
}

const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 86400000);

function docsCard(a) {
  const docs = [...(a.supportingDocuments || [])].map((d) => ({ date: (d.uploadDateTime || d.uploadDate || '').slice(0, 10), label: docLabel(d.documentTypeLabel) }));
  if (!docs.length) return null;
  const groups = new Map();
  for (const d of docs) {
    const k = `${d.date}|${d.label}`;
    groups.set(k, { ...d, n: (groups.get(k)?.n || 0) + 1 });
  }
  const rows = [...groups.values()].sort((x, y) => y.date.localeCompare(x.date));
  const shown = ui.allDocs ? rows : rows.slice(0, 4);
  return h('section', { class: 'card' },
    h('h2', null, 'What VA has received'),
    h('ul', { class: 'clean docs' }, shown.map((r) =>
      h('li', null, h('span', { class: 'd' }, short(r.date)), h('span', null, r.label, r.n > 1 ? h('span', { class: 'small', style: 'font-size:15px' }, ` (${r.n})`) : null)))),
    rows.length > 4 ? h('button', { class: 'btn-link', type: 'button', onclick: () => toggle('allDocs') }, ui.allDocs ? 'Show fewer' : `Show all ${plural(docs.length, 'document')}`) : null);
}

// ---------- reviews, appeals, deadlines ----------

function viewReviews() {
  const m = model();
  const dls = m.deadlines;
  const shownDl = ui.allDeadlines ? dls : dls.slice(0, 3);
  const shownPast = ui.allPast ? m.pastAppeals : m.pastAppeals.slice(0, 3);

  const main = h('main', null,
    h('section', { class: 'stack-2', style: 'gap:4px' },
      h('h1', null, 'Reviews and appeals'),
      h('p', { class: 'lede' }, 'When you ask VA to look at a decision again.')),

    STATE?.meta?.appealsError ? h('div', { class: 'note warn' }, icon('alert', { color: '#9a4a00' }), h('span', null, "Couldn't load the newest review info. Showing saved info.")) : null,

    m.activeAppeals.map((ap) => activeReviewCard(ap, m.appeals)),

    dls.length ? h('section', { class: 'stack-2', style: 'gap:8px' },
      h('h2', { class: 'kicker' }, 'Time left to ask for another review'),
      h('p', { class: 'p', style: 'font-size:14px;color:var(--ink-2)' }, 'After each decision you have 1 year to ask VA to look again, if you disagree.'),
      h('ul', { class: 'clean list-card' },
        shownDl.map((d, i) => {
          const ap = m.appeals.find((x) => x.id === d.appealId);
          const out = ap ? outcomeSummary(ap) : null;
          const soon = d.daysLeft <= SOON_DAYS;
          return h('li', { class: `dl${soon ? ' soon' : ''}` },
            h('div', { class: 'days' }, h('strong', null, d.daysLeft), h('span', null, d.daysLeft === 1 ? 'day' : 'days')),
            h('div', { class: 'stack-2' },
              h('strong', null, `Until ${fmtDate(d.dueDate)}`),
              h('span', { class: 'sub', style: 'font-size:14px' }, `Decision from ${fmtDate(d.decisionDate)}${out ? ` · ${out.text}` : ''}`),
              soon || i === 0 ? h('span', { class: 'sub small' }, `Options: ${d.options.join(', ')}`) : null));
        }),
        dls.length > 3 ? h('li', { class: 'more' }, h('button', { class: 'btn-link', type: 'button', onclick: () => toggle('allDeadlines') }, ui.allDeadlines ? 'Show fewer' : `Show ${dls.length - 3} more deadlines`)) : null),
      ext(`${VA}/resources/choosing-a-decision-review-option/`, 'Which review option is right for me?')) : null,

    m.pastAppeals.length ? h('section', { class: 'stack-2', style: 'gap:8px' },
      h('h2', { class: 'kicker' }, 'Past reviews'),
      h('ul', { class: 'clean list-card' },
        shownPast.map((ap) => {
          const out = outcomeSummary(ap);
          const r = requestDate(ap);
          const d = decisionDate(ap);
          const took = r && d ? daysBetween(r, d) : null;
          return h('li', { style: 'flex-direction:row;justify-content:space-between;gap:8px' },
            h('div', { class: 'stack-2' }, h('strong', null, TYPE_LABEL[ap.type] || 'Appeal'),
              h('span', { class: 'small' }, `Decided ${fmtDate(d)}${took !== null && took >= 0 ? ` · took ${plural(took, 'day')}` : ''}`)),
            h('span', { class: `pill ${out.cls}`, style: 'align-self:center' }, out.short || out.text));
        }),
        m.pastAppeals.length > 3 ? h('li', { class: 'more' }, h('button', { class: 'btn-link', type: 'button', onclick: () => toggle('allPast') }, ui.allPast ? 'Show fewer' : `Show ${m.pastAppeals.length - 3} more`)) : null)) : null,

    !m.appeals.length ? h('div', { class: 'card' }, h('p', { class: 'p' }, 'No reviews or appeals on your account.')) : null);

  main.querySelectorAll('a[href*="choosing-a-decision"]').forEach((el) => (el.style.cssText = 'font-size:14px;font-weight:700;min-height:44px;display:inline-flex;align-items:center'));
  return [header({ back: 'All claims' }), main];
}

function activeReviewCard(ap, all) {
  const est = estimateReview(ap);
  const info = statusInfo(ap);
  const hist = reviewHistory(all, ap.type);
  const pct = est ? Math.min(100, Math.round((est.elapsed / est.goalDays) * 100)) : 0;
  const issues = ap.attributes.issues || [];
  const trim = (s) => (s.length > 90 ? s.slice(0, 88) + '…' : s);
  const slower = hist && est && est.elapsed > hist.max;
  return h('section', { class: 'card', style: 'gap:12px' },
    h('div', { class: 'row-top' },
      h('div', { class: 'stack-2' }, h('span', { class: 'title' }, TYPE_LABEL[ap.type] || 'Appeal'), h('span', { class: 'small' }, `Filed ${fmtDate(requestDate(ap))}`)),
      h('span', { class: 'pill prog' }, info.title)),
    info.plain ? h('p', { class: 'p' }, info.plain) : null,
    ap.attributes.docket?.type ? h('p', { class: 'p small' }, `Board docket: ${docketLabel(ap.attributes.docket.type)}`) : null,
    est ? h('div', { class: 'stack-2', style: 'gap:6px' },
      h('div', { class: `meter${est.elapsed > est.goalDays ? ' over' : ''}`, 'aria-hidden': 'true' }, h('i', { style: `width:${pct}%` })),
      h('div', { style: 'display:flex;justify-content:space-between', class: 'small' }, h('span', null, `Day ${est.elapsed}`), h('span', null, `VA's ${est.label === 'VA goal' ? 'goal' : 'estimate'}: ${est.goalDays} days`))) : null,
    est ? h('div', { class: 'foot-row', style: 'padding:10px 0;border-bottom:1px solid var(--divider)' },
      h('span', null, est.remaining >= 0 ? 'Expected by about' : 'VA goal date was'), h('strong', { style: 'font-size:17px' }, fmtDate(est.target))) : null,
    hist ? h('p', { class: 'p', style: 'font-size:14px' },
      `Your past ${TYPE_LABEL[ap.type]}s took `, h('strong', null, hist.count === 1 ? `${hist.avg} days` : `${hist.min}–${hist.max} days`),
      hist.count > 1 ? ` (about ${hist.avg} on average)` : '', slower ? ', so this one is taking longer than usual.' : '.') : null,
    issues.length ? h('div', { class: 'stack-2', style: 'gap:6px' },
      h('strong', { style: 'font-size:14px' }, `Issues being reviewed (${issues.length})`),
      h('ul', { class: 'bullets', style: 'font-size:14px' }, issues.map((i) => h('li', null, trim(i.description || 'Issue'))))) : null,
    ext(`${VA}/track-claims/appeals/${encodeURIComponent(ap.id)}/status`, 'Open on VA.gov'));
}

// ---------- past claims ----------

function viewPast() {
  const m = model();
  return [header({ back: 'All claims' }), h('main', null,
    h('h1', null, 'Past claims'),
    h('ul', { class: 'clean list-card' }, m.closedClaims.map((c) => {
      const a = c.attributes;
      const d = claimDuration(a);
      return h('li', null, h('strong', null, a.displayTitle || 'Claim'),
        h('span', { class: 'small' }, `Filed ${fmtDate(a.claimDate)} · closed ${fmtDate(a.closeDate)}${d !== null ? ` · took ${plural(d, 'day')}` : ''}`));
    })))];
}

// ---------- settings ----------

function viewSettings() {
  const st = STATE?.settings || {};
  const interval = h('select', { id: 'interval', onchange: async (e) => { STATE = await send('saveSettings', { settings: { intervalMin: Number(e.target.value) } }); } },
    [['0', 'Never'], ['60', 'Every hour'], ['180', 'Every 3 hours'], ['360', 'Every 6 hours']].map(([v, t]) => h('option', { value: v, selected: String(st.intervalMin ?? 180) === v }, t)));
  const notify = h('input', { id: 'notify', type: 'checkbox', checked: st.notify !== false, onchange: async (e) => { const r = await send('saveSettings', { settings: { notify: e.target.checked } }); if (DEMO) REAL = r; else STATE = r; } });
  return [header({ back: 'Back' }), h('main', null,
    h('h1', null, 'Settings'),
    h('section', { class: 'card' },
      h('label', { class: 'field', for: 'interval' }, h('span', null, 'Check for updates in the background'), interval),
      h('label', { class: 'field', for: 'notify' }, h('span', null, 'Show a pop-up when something changes'), notify),
      h('p', { class: 'p small' }, 'Background checks only work while you are signed in to VA.gov. Visiting VA.gov while signed in also updates Claim Pulse.')),
    h('section', { class: 'card' },
      h('button', { class: 'btn-link', type: 'button', onclick: () => chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?tab=1') }) }, 'Open in a bigger window'),
      DEMO ? null : h('button', { class: 'btn-link', type: 'button', onclick: startDemo }, 'Show an example with sample data'),
      h('button', { class: 'btn-link', type: 'button', onclick: async () => { DEMO = false; STATE = await send('clearData'); go({ view: 'home' }); } }, 'Erase saved claim info from this computer')),
    h('section', { class: 'card' },
      h('h2', null, 'Where the estimates come from'),
      h('ul', { class: 'bullets', style: 'font-size:14px' },
        h('li', null, `VA's average time to decide claims: ${BENCHMARKS.claimAverage.days} days (${BENCHMARKS.claimAverage.asOf}). `, ext(BENCHMARKS.claimAverage.url, 'Source')),
        h('li', null, 'Typical time for each step: claims-attorney guidance; VA does not publish this. ', ext(BENCHMARKS.stepsSource.url, 'Source')),
        h('li', null, "Reviews and appeals: VA's published goals (125 days for Supplemental Claims and Higher-Level Reviews). ", ext(BENCHMARKS.reviewsSource.url, 'Source')),
        h('li', null, 'Your own past claims and reviews, from your VA.gov account.'))))];
}

// ---------- example mode (sample data, for first-time users and store reviewers) ----------

async function startDemo() {
  const res = await fetch(chrome.runtime.getURL('demo/sample.json'));
  const sample = await res.json();
  // Shift every date so the example always looks current.
  const ref = new Date(sample.referenceDate + 'T00:00:00');
  const today = new Date();
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - ref) / 86400000);
  const shift = (v) => {
    if (Array.isArray(v)) return v.map(shift);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shift(x)]));
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const d = new Date(v + 'T00:00:00');
      d.setDate(d.getDate() + days);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v))) return new Date(Date.parse(v) + days * 86400000).toISOString();
    return v;
  };
  const demo = shift(sample);
  demo.meta = { auth: 'ok', lastOkAt: new Date().toISOString(), lastCheckAt: new Date().toISOString() };
  REAL = STATE;
  STATE = demo;
  DEMO = true;
  go({ view: 'home' });
}

function exitDemo() {
  STATE = REAL;
  DEMO = false;
  go({ view: 'home' });
}

function demoBanner() {
  return h('div', { class: 'note info', style: 'margin:12px 16px 0;align-items:center;justify-content:space-between' },
    h('span', null, h('strong', null, 'Example with sample data. '), "These aren't your claims."),
    h('button', { class: 'btn-link', type: 'button', onclick: exitDemo, style: 'align-self:center;white-space:nowrap' }, 'Exit example'));
}

// ---------- render + wiring ----------

function render() {
  const root = document.getElementById('root');
  const meta = STATE?.meta || {};
  const hasData = (STATE?.claims || []).length || (STATE?.appeals || []).length;
  let nodes;
  if (!hasData && !meta.lastCheckAt) nodes = [header(), h('main', null, h('p', { class: 'lede' }, 'Checking VA.gov for your claims…'))];
  else if (!hasData && meta.auth !== 'ok') nodes = [viewSignedOut()];
  else if (ui.view === 'claim') nodes = viewClaim();
  else if (ui.view === 'reviews') nodes = viewReviews();
  else if (ui.view === 'past') nodes = viewPast();
  else if (ui.view === 'settings') nodes = viewSettings();
  else nodes = viewHome();
  const list = [nodes].flat(Infinity).filter(Boolean);
  if (DEMO) list.splice(1, 0, demoBanner());
  root.replaceChildren(...list);
  // Sign-in link on the welcome screen is the primary button.
  root.querySelectorAll('.welcome > a').forEach((el) => {
    el.className = 'btn-primary';
    el.style.minHeight = '52px';
    el.style.fontSize = '17px';
  });
  root.querySelectorAll('.attention > a').forEach((el) => (el.className = 'btn-soft'));
}

async function doRefresh() {
  if (DEMO) exitDemo();
  if (busy) return;
  busy = true;
  render();
  try {
    const r = await send('refresh');
    if (DEMO) REAL = r;
    else STATE = r;
  } finally {
    busy = false;
    render();
  }
}

(async function init() {
  STATE = await send('getState');
  render();
  const last = STATE?.meta?.lastCheckAt ? Date.parse(STATE.meta.lastCheckAt) : 0;
  if (Date.now() - last > AUTO_REFRESH_MS) await doRefresh();
  send('markSeen');
})();
