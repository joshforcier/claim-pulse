import { normalizeKeys, isOpen, hasPhaseModel, makeSnapshot, diffSnapshots, updatePhaseLog } from './lib/claims.js';
import { makeAppealSnapshot, diffAppealSnapshots, TYPE_LABEL } from './lib/appeals.js';

const API = 'https://api.va.gov';
const MAX_EVENTS = 300;
const VISIT_THROTTLE_MS = 10 * 60 * 1000;
const DEFAULT_SETTINGS = { intervalMin: 180, notify: true };

class AuthError extends Error {}

// ---------- API ----------

async function apiGet(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let res;
  try {
    res = await fetch(API + path, {
      credentials: 'include',
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'X-Key-Inflection': 'camel' },
    });
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) throw new AuthError('Not signed in to VA.gov');
  if (!res.ok) throw new Error(`VA API returned ${res.status}`);
  return normalizeKeys(await res.json());
}

// ---------- storage ----------

async function load() {
  const s = await chrome.storage.local.get(['claims', 'appeals', 'phaseLogs', 'snapshots', 'events', 'meta', 'settings']);
  return {
    claims: s.claims || {},
    appeals: s.appeals || [],
    phaseLogs: s.phaseLogs || {},
    snapshots: s.snapshots || {},
    events: s.events || [],
    meta: s.meta || {},
    settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) },
  };
}

async function publicState() {
  const st = await load();
  const claims = Object.values(st.claims).map((c) => ({ ...c, phaseLog: st.phaseLogs[c.id] || [] }));
  return { claims, appeals: st.appeals, events: st.events, meta: st.meta, settings: st.settings };
}

// ---------- refresh ----------

let inflight = null;

function refresh(reason) {
  if (!inflight) inflight = doRefresh(reason).finally(() => (inflight = null));
  return inflight;
}

async function doRefresh(reason) {
  const st = await load();
  const now = new Date().toISOString();
  const firstRun = Object.keys(st.snapshots).length === 0;

  try {
    const list = await apiGet('/v0/benefits_claims');
    const items = Array.isArray(list.data) ? list.data : [];
    const newEvents = [];
    const claims = {};

    for (const item of items) {
      const id = String(item.id);
      let attrs = item.attributes || {};
      let detail = null;

      if (hasPhaseModel(attrs) && isOpen(attrs)) {
        try {
          const d = await apiGet(`/v0/benefits_claims/${encodeURIComponent(id)}`);
          detail = d.data || null;
          if (detail && detail.attributes) attrs = detail.attributes;
        } catch (e) {
          if (e instanceof AuthError) throw e;
          // Keep going with list data if one detail call fails.
        }
      }

      const prevClaim = st.claims[id];

      // Detail call failed for an open claim we've seen before: keep the last
      // good record untouched rather than diffing against thinner list data.
      if (!detail && hasPhaseModel(attrs) && isOpen(attrs) && prevClaim?.hasDetail) {
        claims[id] = { ...prevClaim, stale: true };
        continue;
      }

      claims[id] = {
        id,
        attributes: attrs,
        hasDetail: !!detail,
        stale: false,
        fetchedAt: now,
        firstSeenAt: prevClaim?.firstSeenAt || now,
      };

      const snap = makeSnapshot(attrs, !!detail);
      const prev = st.snapshots[id];

      if (!prev) {
        if (!firstRun) newEvents.push(evt(id, attrs, 'new', 'New claim appeared on your account', now));
      } else {
        for (const e of diffSnapshots(prev, snap)) newEvents.push(evt(id, attrs, e.kind, e.text, now));
      }
      st.snapshots[id] = snap;
      if (hasPhaseModel(attrs)) st.phaseLogs[id] = updatePhaseLog(st.phaseLogs[id], attrs);
    }

    // Decision reviews and appeals (HLR, Supplemental Claims, Board). Non-fatal.
    let appeals = st.appeals;
    let appealsError = null;
    try {
      const ap = await apiGet('/v0/appeals');
      appeals = Array.isArray(ap.data) ? ap.data : [];
      for (const appeal of appeals) {
        const key = `appeal:${appeal.id}`;
        const snap = makeAppealSnapshot(appeal);
        const prev = st.snapshots[key];
        const title = TYPE_LABEL[appeal.type] || 'Appeal';
        if (!prev) {
          if (!firstRun) newEvents.push(evt(key, { displayTitle: title }, 'new', `New ${title} appeared on your account`, now));
        } else {
          for (const e of diffAppealSnapshots(prev, snap)) newEvents.push(evt(key, { displayTitle: title }, e.kind, e.text, now));
        }
        st.snapshots[key] = snap;
      }
    } catch (e) {
      if (e instanceof AuthError) throw e;
      appealsError = String(e.message || e);
    }

    const events = [...newEvents, ...st.events].slice(0, MAX_EVENTS);
    const meta = { ...st.meta, lastCheckAt: now, lastOkAt: now, auth: 'ok', error: null, appealsError, lastReason: reason };

    await chrome.storage.local.set({ claims, appeals, phaseLogs: st.phaseLogs, snapshots: st.snapshots, events, meta });
    await updateBadge(events);

    if (newEvents.length && st.settings.notify && reason !== 'popup') notify(newEvents);
  } catch (e) {
    const meta = {
      ...st.meta,
      lastCheckAt: now,
      auth: e instanceof AuthError ? 'signed_out' : 'error',
      error: e instanceof AuthError ? null : String(e.message || e),
    };
    await chrome.storage.local.set({ meta });
  }
  return publicState();
}

function evt(claimId, attrs, kind, text, at) {
  return {
    id: `${at}-${claimId}-${Math.random().toString(36).slice(2, 8)}`,
    claimId,
    claimTitle: attrs.displayTitle || attrs.claimType || 'Claim',
    kind,
    text,
    at,
    seen: false,
  };
}

// ---------- badge + notifications ----------

async function updateBadge(events) {
  const unseen = (events || (await load()).events).filter((e) => !e.seen).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#c2410c' });
  await chrome.action.setBadgeText({ text: unseen ? String(Math.min(unseen, 99)) : '' });
}

function notify(newEvents) {
  const top = newEvents.find((e) => e.kind === 'phase_back') || newEvents.find((e) => e.kind === 'phase') || newEvents[0];
  const extra = newEvents.length > 1 ? ` (+${newEvents.length - 1} more)` : '';
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'VA claim update',
    message: top.text + extra,
    priority: 1,
  });
}

// ---------- scheduling ----------

async function schedule() {
  const { settings } = await load();
  await chrome.alarms.clear('poll');
  if (settings.intervalMin > 0) {
    chrome.alarms.create('poll', { periodInMinutes: settings.intervalMin, delayInMinutes: 1 });
  }
}

chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'poll') refresh('alarm');
});
chrome.notifications.onClicked.addListener(() => chrome.action.openPopup?.().catch(() => {}));

// ---------- messages ----------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'getState':
        return publicState();
      case 'refresh':
        return refresh('popup');
      case 'pageVisit': {
        const { meta } = await load();
        const last = meta.lastOkAt ? Date.parse(meta.lastOkAt) : 0;
        if (Date.now() - last > VISIT_THROTTLE_MS) await refresh('visit');
        return { ok: true };
      }
      case 'markSeen': {
        const st = await load();
        const events = st.events.map((e) => ({ ...e, seen: true }));
        await chrome.storage.local.set({ events });
        await updateBadge(events);
        return { ok: true };
      }
      case 'saveSettings': {
        const st = await load();
        await chrome.storage.local.set({ settings: { ...st.settings, ...msg.settings } });
        await schedule();
        return publicState();
      }
      case 'clearData': {
        await chrome.storage.local.remove(['claims', 'appeals', 'phaseLogs', 'snapshots', 'events', 'meta']);
        await updateBadge([]);
        return publicState();
      }
      default:
        return { error: 'unknown message' };
    }
  })().then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true;
});
