import { phaseStep } from './phases.js';
import { currentPhase } from './claims.js';

// ---------------------------------------------------------------------------
// Benchmarks. Update these when VA publishes new figures.
// ---------------------------------------------------------------------------
export const BENCHMARKS = {
  claimAverage: {
    days: 69.2,
    asOf: 'claims completed Oct 2026',
    source: 'VA.gov',
    url: 'https://www.va.gov/disability/after-you-file-claim/',
  },
  // VA does not publish per-step times. These are typical ranges from
  // claims-attorney guidance; steps 1–2 are often same-day now.
  steps: {
    1: [7, 14],
    2: [14, 30],
    3: [30, 60],
    4: [7, 14],
    5: [7, 14],
    6: [7, 14],
    7: [7, 14],
  },
  stepsSource: {
    source: 'CCK Law',
    url: 'https://cck-law.com/blog/va-disability-claims-and-appeals-process-timeline/',
  },
  reviews: {
    higherLevelReview: { days: 125, label: 'VA goal' },
    supplementalClaim: { days: 125, label: 'VA goal' },
    directReview: { days: 365, label: 'VA goal' },
    evidenceSubmission: { days: 550, label: 'typical upper estimate' },
    hearingRequest: { days: 730, label: 'VA goal (often longer)' },
  },
  reviewsSource: {
    source: 'VA.gov',
    url: 'https://www.va.gov/resources/choosing-a-decision-review-option/',
  },
};

const DAY = 86400000;
const toDate = (s) => {
  if (!s) return null;
  if (s instanceof Date) return s;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(s);
};
const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d, n) => {
  const x = toDate(d);
  return new Date(x.getFullYear(), x.getMonth(), x.getDate() + Math.round(n)); // calendar math, DST-safe
};
const between = (a, b) => Math.round((midnight(toDate(b)) - midnight(toDate(a))) / DAY); // rounding absorbs DST hour

// ---------------------------------------------------------------------------
// Open claim: estimated decision window from typical remaining step times.
// ---------------------------------------------------------------------------
export function estimateClaim(attrs, now = new Date()) {
  const pd = attrs.claimPhaseDates || {};
  const step = phaseStep(currentPhase(attrs));
  const daysOpen = attrs.claimDate ? between(attrs.claimDate, now) : null;

  const national = {
    days: BENCHMARKS.claimAverage.days,
    target: attrs.claimDate ? addDays(attrs.claimDate, BENCHMARKS.claimAverage.days) : null,
    delta: daysOpen === null ? null : Math.round(daysOpen - BENCHMARKS.claimAverage.days),
  };

  if (!step || step >= 8) return { step, daysOpen, national, window: null };

  const elapsed = pd.phaseChangeDate ? Math.max(0, between(pd.phaseChangeDate, now)) : 0;
  const [lo, hi] = BENCHMARKS.steps[step];
  const overTypical = elapsed > hi;

  // Remaining time in the current step.
  let remLo = Math.max(0, lo - elapsed);
  let remHi = Math.max(remLo, hi - elapsed);
  if (overTypical) {
    remLo = 0;
    remHi = Math.ceil(hi / 2); // running long: could move any day, allow some slack
  }

  // Plus the typical time for every later step through final review (step 7).
  let restLo = 0;
  let restHi = 0;
  for (let s = step + 1; s <= 7; s++) {
    restLo += BENCHMARKS.steps[s][0];
    restHi += BENCHMARKS.steps[s][1];
  }

  const fromNow = [remLo + restLo, remHi + restHi];
  return {
    step,
    daysOpen,
    elapsed,
    typical: [lo, hi],
    overTypical,
    fromNow,
    window: [addDays(now, fromNow[0]), addDays(now, fromNow[1])],
    national,
  };
}

// ---------------------------------------------------------------------------
// Your own history: how long your past compensation claims took.
// ---------------------------------------------------------------------------
export function personalHistory(claims) {
  const durations = claims
    .map((c) => c.attributes || {})
    .filter((a) => a.closeDate && a.claimDate && /compensation/i.test(a.claimType || a.displayTitle || ''))
    .map((a) => between(a.claimDate, a.closeDate))
    .filter((d) => d >= 0);
  if (!durations.length) return null;
  const avg = Math.round(durations.reduce((s, d) => s + d, 0) / durations.length);
  return { count: durations.length, min: Math.min(...durations), max: Math.max(...durations), avg };
}

export function claimDuration(attrs) {
  return attrs.claimDate && attrs.closeDate ? between(attrs.claimDate, attrs.closeDate) : null;
}

// ---------------------------------------------------------------------------
// Reviews and appeals: target date from VA's goal for the lane/docket.
// ---------------------------------------------------------------------------
const REQUEST_EVENTS = ['hlr_request', 'sc_request', 'ama_nod', 'nod'];

export function estimateReview(appeal, now = new Date()) {
  const a = appeal.attributes || {};
  let bench = null;
  if (appeal.type === 'higherLevelReview') bench = BENCHMARKS.reviews.higherLevelReview;
  else if (appeal.type === 'supplementalClaim') bench = BENCHMARKS.reviews.supplementalClaim;
  else if (appeal.type === 'appeal') bench = BENCHMARKS.reviews[a.docket?.type] || BENCHMARKS.reviews.directReview;
  if (!bench) return null; // legacy appeals: no meaningful benchmark

  const events = a.events || [];
  const req = events.find((e) => REQUEST_EVENTS.includes(e.type)) || events[0];
  if (!req?.date) return null;

  const elapsed = between(req.date, now);
  return {
    start: toDate(req.date),
    goalDays: bench.days,
    label: bench.label,
    target: addDays(req.date, bench.days),
    elapsed,
    remaining: bench.days - elapsed,
  };
}
