import { pretty } from './phases.js';

// Plain-language labels for decision reviews and appeals (from /v0/appeals).

export const TYPE_LABEL = {
  higherLevelReview: 'Higher-Level Review',
  supplementalClaim: 'Supplemental Claim',
  appeal: 'Board Appeal',
  legacyAppeal: 'Appeal (older system)',
};

const OPTION_LABEL = {
  supplemental_claim: 'Supplemental Claim',
  higher_level_review: 'Higher-Level Review',
  appeal: 'Board Appeal',
};

// VA's API spells some of these wrong ("sc_recieved"); normalize first.
export function statusType(appeal) {
  const raw = appeal?.attributes?.status?.type || appeal?.attributes?.status || '';
  return String(raw).replace('recieved', 'received');
}

const STATUS = {
  sc_received: ['In progress', "VA received your Supplemental Claim and is reviewing the new evidence."],
  hlr_received: ['In progress', 'A senior reviewer is looking at your case again.'],
  sc_decision: ['Decided', 'VA made a decision on your Supplemental Claim.'],
  hlr_decision: ['Decided', 'VA made a decision on your Higher-Level Review.'],
  hlr_dta_error: ['Being corrected', 'The reviewer found an error. VA opened a new claim to fix it.'],
  sc_closed: ['Closed', 'This Supplemental Claim was closed.'],
  hlr_closed: ['Closed', 'This Higher-Level Review was closed.'],
  pre_docketed: ['Being checked', 'The Board is checking your appeal before adding it to the docket.'],
  on_docket: ['Waiting in line', "Your appeal is on the Board's docket, waiting for a judge."],
  evidentiary_period: ['Evidence window open', 'You can send the Board new evidence during this window.'],
  pending_hearing_scheduling: ['Waiting for a hearing date', 'Your appeal is waiting for a hearing to be scheduled.'],
  scheduled_hearing: ['Hearing scheduled', 'Your Board hearing is scheduled.'],
  decision_in_progress: ['Judge reviewing', 'A Veterans Law Judge is reviewing your appeal.'],
  bva_decision: ['Board decided', 'The Board made a decision on your appeal.'],
  bva_decision_effectuation: ['Putting decision in place', 'VA is carrying out the Board decision.'],
  ama_remand: ['Sent back to VA', 'The Board sent issues back to VA for more work.'],
  remand: ['Sent back to VA', 'The Board sent issues back to VA for more work.'],
  post_bva_dta_decision: ['Decided after remand', 'VA decided the issues the Board sent back.'],
  field_grant: ['Granted', 'VA granted your appeal.'],
  withdrawn: ['Withdrawn', 'This appeal was withdrawn.'],
  other_close: ['Closed', 'This appeal was closed.'],
  merged: ['Merged', 'This appeal was combined with another one.'],
  statutory_opt_in: ['Moved to new system', 'This appeal moved to the newer review system.'],
  pending_soc: ['Waiting on VA', 'VA is preparing a Statement of the Case.'],
  pending_form9: ['Action may be needed', 'VA sent a Statement of the Case. You may need to file a Form 9.'],
  pending_certification: ['Waiting on VA', 'VA is preparing to send your appeal to the Board.'],
  pending_certification_ssoc: ['Waiting on VA', 'VA is preparing to send your appeal to the Board.'],
  remand_ssoc: ['Waiting on VA', 'VA is working on issues sent back by the Board.'],
  at_vso: ['With your representative', 'Your appeal is with your representative for review.'],
};

export function statusInfo(appeal) {
  const t = statusType(appeal);
  const [title, plain] = STATUS[t] || [pretty(t) || 'Unknown', ''];
  return { type: t, title, plain };
}

const EVENTS = {
  claim_decision: 'Original decision',
  nod: 'Notice of Disagreement filed',
  soc: 'Statement of the Case sent',
  form9: 'Form 9 filed',
  ssoc: 'Supplemental Statement of the Case sent',
  certified: 'Sent to the Board',
  hearing_held: 'Hearing held',
  hearing_no_show: 'Missed hearing',
  bva_decision: 'Board decision',
  field_grant: 'Granted by VA',
  withdrawn: 'Withdrawn',
  ftr: 'Closed for no response',
  cavc_decision: 'Court decision',
  remand_return: 'Returned to the Board',
  ama_nod: 'Board Appeal filed',
  docket_change: 'Docket changed',
  distributed_to_vlj: 'Assigned to a judge',
  bva_decision_effectuation: 'Board decision put in place',
  dta_decision: 'Correction decided',
  sc_request: 'Supplemental Claim filed',
  sc_decision: 'Decision made',
  sc_other_close: 'Closed',
  hlr_request: 'Higher-Level Review requested',
  hlr_decision: 'Decision made',
  hlr_dta_error: 'Error found, new claim opened',
  hlr_other_close: 'Closed',
  statutory_opt_in: 'Moved to new system',
  other_close: 'Closed',
};
export const eventLabel = (t) => EVENTS[t] || pretty(t);

const LOCATION = { aoj: 'With VA', bva: "At the Board of Veterans' Appeals" };
export const locationLabel = (l) => LOCATION[l] || pretty(l);

const DOCKET = {
  directReview: 'Direct review',
  evidenceSubmission: 'Evidence submission',
  hearingRequest: 'Hearing',
};
export const docketLabel = (d) => DOCKET[d] || pretty(d);

export const optionLabel = (o) => OPTION_LABEL[o] || pretty(o);

export function isActive(appeal) {
  return !!appeal?.attributes?.active;
}

const REQUEST_EVENTS = new Set(['hlr_request', 'sc_request', 'ama_nod', 'nod']);
const DECISION_EVENTS = new Set(['hlr_decision', 'sc_decision', 'bva_decision', 'field_grant', 'dta_decision']);

export function requestDate(appeal) {
  const evs = (appeal.attributes?.events || []).filter((e) => REQUEST_EVENTS.has(e.type) && e.date).map((e) => e.date).sort();
  return evs[0] || null;
}

export function decisionDate(appeal) {
  const evs = (appeal.attributes?.events || []).filter((e) => DECISION_EVENTS.has(e.type) && e.date).map((e) => e.date).sort();
  return evs[evs.length - 1] || null;
}

// "Next step" deadlines VA reports after a decision (one year to choose another lane).
export function deadlines(appeals, now = new Date()) {
  const out = [];
  for (const ap of appeals) {
    for (const al of ap.attributes?.alerts || []) {
      if (al.type !== 'ama_post_decision' || !al.details?.dueDate) continue;
      const due = new Date(al.details.dueDate + 'T00:00:00');
      if (due < new Date(now.getFullYear(), now.getMonth(), now.getDate())) continue;
      out.push({
        appealId: ap.id,
        type: ap.type,
        description: ap.attributes.description || '',
        decisionDate: al.details.decisionDate || decisionDate(ap),
        dueDate: al.details.dueDate,
        options: (al.details.availableOptions || []).map(optionLabel),
        daysLeft: Math.round((due - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000),
      });
    }
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

// How long your own past reviews of a given type took (request -> decision).
export function reviewHistory(appeals, type) {
  const d = appeals
    .filter((a) => a.type === type && !isActive(a))
    .map((a) => {
      const r = requestDate(a);
      const x = decisionDate(a);
      if (!r || !x) return null;
      const days = Math.round((new Date(x + 'T00:00:00') - new Date(r + 'T00:00:00')) / 86400000);
      return days >= 0 ? days : null; // VA data sometimes has the request after the decision
    })
    .filter((n) => n !== null);
  if (!d.length) return null;
  return { count: d.length, min: Math.min(...d), max: Math.max(...d), avg: Math.round(d.reduce((s, n) => s + n, 0) / d.length) };
}

// ---------- snapshots + change detection ----------

export function makeAppealSnapshot(appeal) {
  const a = appeal.attributes || {};
  return {
    active: !!a.active,
    status: statusType(appeal),
    location: a.location || null,
    docket: a.docket?.type || null,
    events: (a.events || []).map((e) => `${e.type}|${e.date}`),
    alerts: (a.alerts || []).map((x) => x.type),
    issues: (a.issues || []).map((i) => ({ key: `${i.diagnosticCode || ''}|${i.description || ''}`, desc: i.description || 'Issue', lastAction: i.lastAction || null })),
  };
}

export function diffAppealSnapshots(prev, next) {
  if (!prev || !next) return [];
  const ev = [];
  const push = (kind, text) => ev.push({ kind, text });
  const label = (t) => (STATUS[t] ? STATUS[t][0] : pretty(t));

  if (prev.status !== next.status) push('status', `Status changed: ${label(prev.status)} → ${label(next.status)}`);
  if (prev.location !== next.location && next.location) push('phase', `Moved: ${locationLabel(next.location)}`);
  if (prev.active && !next.active) push('closed', 'Closed');

  const seen = new Set(prev.events);
  for (const e of next.events) {
    if (seen.has(e)) continue;
    const [type, date] = e.split('|');
    push('event', `${eventLabel(type)}${date ? ` (${new Date(date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })})` : ''}`);
  }

  const seenAlerts = new Set(prev.alerts);
  for (const a of next.alerts) if (!seenAlerts.has(a)) push('action', a === 'ama_post_decision' ? 'Decision made: your next-step options are open' : `New alert: ${pretty(a)}`);

  const pi = new Map(prev.issues.map((i) => [i.key, i]));
  for (const i of next.issues) {
    const old = pi.get(i.key);
    if (old && old.lastAction !== i.lastAction && i.lastAction) push('issue', `${shorten(i.desc)}: ${i.lastAction}`);
  }
  return ev;
}

const shorten = (s, n = 70) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
