// When you browse VA.gov (and are likely signed in), ask the tracker to sync.
// The background worker throttles this to once every 10 minutes.
try {
  chrome.runtime.sendMessage({ type: 'pageVisit' }).catch(() => {});
} catch (_) {
  /* extension reloaded; ignore */
}
