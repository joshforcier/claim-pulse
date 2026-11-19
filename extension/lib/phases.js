// The 8-step phase model VA tracks internally (VA.gov collapses it to 5 steps).
export const PHASES = [
  { key: 'CLAIM_RECEIVED', name: 'Claim received' },
  { key: 'UNDER_REVIEW', name: 'Initial review' },
  { key: 'GATHERING_OF_EVIDENCE', name: 'Gathering evidence' },
  { key: 'REVIEW_OF_EVIDENCE', name: 'Reviewing evidence' },
  { key: 'PREPARATION_FOR_DECISION', name: 'Rating' },
  { key: 'PENDING_DECISION_APPROVAL', name: 'Preparing your letter' },
  { key: 'PREPARATION_FOR_NOTIFICATION', name: 'Final review' },
  { key: 'COMPLETE', name: 'Decided' },
];

// The 5-step status VA.gov shows on the claim page.
export const STATUSES = {
  CLAIM_RECEIVED: 'Step 1 of 5: Claim received',
  INITIAL_REVIEW: 'Step 2 of 5: Initial review',
  EVIDENCE_GATHERING_REVIEW_DECISION: 'Step 3 of 5: Evidence gathering, review, and decision',
  PREPARATION_FOR_NOTIFICATION: 'Step 4 of 5: Preparation for notification',
  COMPLETE: 'Step 5 of 5: Closed',
};

export function phaseStep(key) {
  if (!key) return null;
  const i = PHASES.findIndex((p) => p.key === String(key).toUpperCase());
  return i < 0 ? null : i + 1;
}

export function phaseName(key) {
  const s = phaseStep(key);
  return s ? PHASES[s - 1].name : pretty(key);
}

export function phaseLabel(key) {
  const s = phaseStep(key);
  return s ? `Step ${s} of 8: ${PHASES[s - 1].name}` : pretty(key) || 'Unknown';
}

export function statusLabel(status) {
  if (!status) return 'Unknown';
  return STATUSES[String(status).toUpperCase()] || pretty(status);
}

export function pretty(s) {
  if (s === null || s === undefined || s === '') return '';
  const t = String(s)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
