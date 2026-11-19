import { phaseStep, phaseName, pretty, statusLabel } from './phases.js';

// ---------- normalizing API payloads ----------

const SNAKE = /^[a-z0-9]+(_[a-z0-9]+)+$/;

// Converts snake_case keys to camelCase so the code works whether or not the
// API honored the camel inflection header. Leaves UPPER_CASE keys alone.
export function normalizeKeys(value) {
  if (Array.isArray(value)) return value.map(normalizeKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const key = SNAKE.test(k) ? k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase()) : k;
      out[key] = normalizeKeys(v);
    }
    return out;
  }
  return value;
}

// ---------- claim helpers ----------

export function currentPhase(attrs) {
  const d = (attrs && attrs.claimPhaseDates) || {};
  return d.phaseType || d.latestPhaseType || null;
}

export function isOpen(attrs) {
  if (!attrs) return false;
  if (attrs.closeDate) return false;
  return String(attrs.status || '').toUpperCase() !== 'COMPLETE';
}

// Only VBMS/Lighthouse claims have the per-claim detail endpoint and 8-step phases.
export function hasPhaseModel(attrs) {
  return !!attrs && attrs.provider === 'lighthouse';
}

export function makeSnapshot(attrs, hasDetail) {
  const d = attrs.claimPhaseDates || {};
  return {
    hasDetail: !!hasDetail,
    status: attrs.status ?? null,
    phase: currentPhase(attrs),
    phaseBack: !!d.currentPhaseBack,
    phaseChangeDate: d.phaseChangeDate ?? null,
    closeDate: attrs.closeDate ?? null,
    decisionLetterSent: !!attrs.decisionLetterSent,
    documentsNeeded: !!attrs.documentsNeeded,
    docs: (attrs.supportingDocuments || []).map((x) => ({
      id: String(x.documentId),
      label: x.documentTypeLabel || 'Document',
    })),
    tracked: (attrs.trackedItems || []).map((t) => ({
      id: String(t.id),
      name: t.friendlyName || t.displayName || 'Request',
      status: t.status || null,
    })),
    contentions: (attrs.contentions || []).map((c) => c.name).filter(Boolean),
  };
}

// ---------- step log ----------
// VA wipes earlier step dates when a claim is sent back, so we keep our own log.
// Entries: { phase, from, to, back } or { gap: true } when VA skipped history.

export function updatePhaseLog(log, attrs) {
  const pd = attrs.claimPhaseDates || {};
  const phase = currentPhase(attrs);
  if (!phase) return log || [];
  const from = pd.phaseChangeDate || null;
  const back = !!pd.currentPhaseBack;
  const L = log && log.length ? log.map((e) => ({ ...e })) : seedPhaseLog(attrs);
  const last = [...L].reverse().find((e) => !e.gap);

  if (last && last.phase === phase && last.from === from) {
    if (back) last.back = true;
  } else {
    if (last && !last.to) last.to = from;
    L.push({ phase, from, to: null, back });
  }
  if (String(phase).toUpperCase() === 'COMPLETE') L[L.length - 1].to = L[L.length - 1].from;
  return L.slice(-60);
}

function seedPhaseLog(attrs) {
  const pd = attrs.claimPhaseDates || {};
  const done = Object.entries(pd.previousPhases || {})
    .map(([k, v]) => ({ n: Number((/phase(\d+)CompleteDate/i.exec(k) || [])[1]), date: v }))
    .filter((x) => x.n && x.date)
    .sort((a, b) => a.n - b.n);
  const L = [];
  let prevDate = attrs.claimDate || null;
  for (const d of done) {
    L.push({ phase: PHASE_KEYS[d.n - 1], from: prevDate, to: d.date, back: false });
    prevDate = d.date;
  }
  const cur = phaseStep(currentPhase(attrs));
  const lastDone = done.length ? done[done.length - 1].n : 0;
  if (cur && (pd.currentPhaseBack || cur > lastDone + 1)) L.push({ gap: true });
  return L;
}

const PHASE_KEYS = ['CLAIM_RECEIVED', 'UNDER_REVIEW', 'GATHERING_OF_EVIDENCE', 'REVIEW_OF_EVIDENCE', 'PREPARATION_FOR_DECISION', 'PENDING_DECISION_APPROVAL', 'PREPARATION_FOR_NOTIFICATION', 'COMPLETE'];

// ---------- change detection ----------

export function diffSnapshots(prev, next) {
  if (!prev || !next) return [];
  const ev = [];
  const push = (kind, text) => ev.push({ kind, text });

  const s1 = phaseStep(prev.phase);
  const s2 = phaseStep(next.phase);

  if (prev.phase !== next.phase && next.phase) {
    if (s1 && s2 && s2 < s1) {
      push('phase_back', `Sent back to Step ${s2} (${phaseName(next.phase)}) from Step ${s1} (${phaseName(prev.phase)})`);
    } else {
      const from = s1 ? ` from Step ${s1}` : '';
      push('phase', `Moved ahead to Step ${s2 || '?'} of 8: ${phaseName(next.phase)}`);
    }
  } else if (next.phaseChangeDate && prev.phaseChangeDate !== next.phaseChangeDate) {
    // Same phase, new entry date: it left and came back between checks.
    push(
      next.phaseBack ? 'phase_back' : 'phase',
      `Re-entered Step ${s2 || '?'} (${phaseName(next.phase)}) on ${fmtDate(next.phaseChangeDate)}${next.phaseBack ? ' after being sent back' : ''}`
    );
  } else if (!prev.phaseBack && next.phaseBack) {
    push('phase_back', `Flagged as sent back to Step ${s2 || '?'} (${phaseName(next.phase)})`);
  }

  if (prev.status !== next.status && prev.phase === next.phase && next.status) {
    push('status', `VA.gov status changed to "${statusLabel(next.status)}"`);
  }

  if (!prev.closeDate && next.closeDate) push('closed', `Claim closed on ${fmtDate(next.closeDate)}`);
  if (!prev.decisionLetterSent && next.decisionLetterSent) push('letter', 'Decision letter marked as sent');
  if (!prev.documentsNeeded && next.documentsNeeded) push('action', 'VA says it needs something from you');

  if (prev.hasDetail && next.hasDetail) {
    const seen = new Set(prev.docs.map((d) => d.id));
    const added = next.docs.filter((d) => !seen.has(d.id));
    if (added.length) {
      push('docs', `VA added ${added.length} document${added.length > 1 ? 's' : ''}: ${groupLabels(added.map((d) => docLabel(d.label)))}`);
    }

    const prevTracked = new Map(prev.tracked.map((t) => [t.id, t]));
    for (const t of next.tracked) {
      const old = prevTracked.get(t.id);
      if (!old) push('request', `New VA request: ${t.name}${t.status ? ` (${pretty(t.status)})` : ''}`);
      else if (old.status !== t.status) push('request', `${t.name}: ${pretty(old.status) || 'unknown'} → ${pretty(t.status) || 'unknown'}`);
    }

    const pc = new Set(prev.contentions);
    const nc = new Set(next.contentions);
    for (const c of nc) if (!pc.has(c)) push('contention', `Condition added: ${c}`);
    for (const c of pc) if (!nc.has(c)) push('contention', `Condition removed: ${c}`);
  }

  return ev;
}

// Plain names for VA document types.
export function docLabel(label) {
  const l = label || 'Document';
  if (/C&P Exam/i.test(l)) return 'Exam results';
  if (/Exam Request/i.test(l)) return 'Exam request';
  if (/526/i.test(l)) return 'Your application';
  if (/10210|Lay Witness|Statement/i.test(l)) return 'Written statement';
  if (/DD ?214|Release or Discharge/i.test(l)) return 'Discharge papers (DD214)';
  if (/Medical Treatment Record|STR|Service Treatment/i.test(l)) return 'Medical records';
  if (/IES|ILER/i.test(l)) return 'Exposure record';
  return l;
}

function groupLabels(labels) {
  const counts = new Map();
  for (const l of labels) counts.set(l, (counts.get(l) || 0) + 1);
  return [...counts].map(([l, n]) => (n > 1 ? `${l} ×${n}` : l)).join(', ');
}

// ---------- dates ----------

// "2026-10-13" -> local Date at midnight; ISO timestamps parsed normally.
export function parseDate(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

export function fmtDate(s) {
  const d = s instanceof Date ? s : parseDate(s);
  if (!d) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function daysSince(s, now = new Date()) {
  const d = s instanceof Date ? s : parseDate(s);
  if (!d) return null;
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((b - a) / 86400000);
}
