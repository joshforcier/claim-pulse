# Claim Pulse

A Chrome extension that shows what VA's claims API actually says about your claim: the real 8-step phase, whether the claim was sent back, the document timeline, and VA requests. It also tells you when any of that changes.

Not affiliated with VA. All data stays in your browser.

## Install (unpacked)

1. Unzip this folder somewhere permanent.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `claim-pulse` folder (the one with `manifest.json`).
4. Pin the extension, sign in to VA.gov, then click the icon.

Want to look around first? Click the icon and choose **See an example with sample data first**.

## What it shows

**Home** answers three questions in plain words: what's happening, when it will be done, and whether you need to do anything. Deadlines and VA requests show at the top.

- **The real phase (Step X of 8).** VA.gov only shows 5 steps; the API still reports the 8-step phase.
- **Sent-back warning.** `currentPhaseBack` tells you when a claim moved past a step and was returned to it.
- **Days open, days in this step, days since last document.**
- **Step history** from `previousPhases`.
- **Documents.** Every C&P exam, exam request, and form VA attached, with dates.
- **VA requests** (tracked items), with due dates.
- **Estimated decision window** for each open claim, built from typical step times and adjusted for how long your claim has already been in its step. It's shown next to VA's national average and your own past claims.
- **Step history that survives send-backs.** VA erases earlier step dates when it sends a claim back. Claim Pulse keeps its own log, so you can still see how far the claim got.
- **Reviews and appeals**: Supplemental Claims, Higher-Level Reviews and Board Appeals, from `/v0/appeals`. Each shows its status in plain language, day X of VA's goal, an expected date, and how long your past reviews of that type took.
- **Deadlines.** After each decision you have one year to ask for another review. Every open deadline shows with a countdown, and anything within 60 days is flagged on the home screen.
- **Change feed.** Each check saves a snapshot and compares it to the last one: phase moves, send-backs, new documents, new or updated requests, conditions added or removed, closure.

## What it can't show

Temporary jurisdiction (which office has your claim). VA removed that field from the API, so no extension can show it anymore.

## Where the estimates come from

- VA's national average time to decide claims (69.2 days for claims completed Oct 2026, from VA.gov). Update `BENCHMARKS` in `lib/estimates.js` when VA publishes a new figure.
- Typical time for each step, from claims-attorney guidance (CCK Law). VA doesn't publish per-step times.
- VA's published goals for reviews: 125 days for Supplemental Claims and Higher-Level Reviews, and per-docket goals for Board Appeals.
- Your own closed claims and reviews.

These are estimates, not VA predictions. The app says so wherever it shows one.

## How syncing works

- Opening the popup syncs if the last check was more than 5 minutes ago.
- Visiting your VA.gov claim status or My VA pages syncs in the background, at most once every 10 minutes.
- Background checks (every 3 hours by default) run only while your VA.gov session is still active. Sessions time out, so most real syncs happen when you visit VA.gov.
- When something changes during a background sync, you get a desktop notification and a badge count on the icon.

## Privacy

- Requests go only to `api.va.gov`, using your existing VA.gov sign-in. The extension never sees your password.
- Claim data is kept in `chrome.storage.local` on this computer. **Settings → Clear saved data** wipes it.
- No analytics, and nothing is sent anywhere else.

## Fonts

The extension bundles Atkinson Hyperlegible (SIL Open Font License, see `fonts/OFL-LICENSE.txt`), a typeface designed for readability.
