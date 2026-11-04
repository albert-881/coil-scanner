// Keeps a copy of the coil list (and other lookups) on the phone so scanning works without signal.
// Needs config.js and auth.js loaded first.

const COIL_CACHE_KEY = "coil-scanner-coils";
const EXTRA_CACHE_KEY = "coil-scanner-extras";
const COIL_REFRESH_MS = 5 * 60 * 1000; // refresh the list every 5 minutes when there's signal

function cacheRead(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch (e) { return null; }
}
function cacheWrite(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { console.warn("Couldn't save offline data:", e); }
}

function coilKey(coil) {
  return String(coil || "").trim().toUpperCase();
}

function savedTime(ms) {
  return ms ? new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "never";
}

async function getJson(action, extra) {
  const q = new URLSearchParams(Object.assign({ action }, extra || {}));
  const res = await authFetch(API_URL + "?" + q.toString());
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

// ---------- Coil list ----------
async function refreshCoilList() {
  if (!navigator.onLine) return;
  try {
    const data = await getJson("coil_list");
    const coils = {};
    data.coils.forEach((row) => { coils[coilKey(row["Coil No"])] = row; });
    cacheWrite(COIL_CACHE_KEY, { savedAt: Date.now(), coils });
  } catch (e) {
    console.warn("Coil list not refreshed:", e.message);
  }
  updateOfflineBanner();
}

// Same answer shape as the Lambda's lookup, plus { offline: true } when it came from the phone.
async function lookupCoilSmart(coil) {
  const key = coilKey(coil);
  if (navigator.onLine) {
    try {
      const data = await getJson("lookup", { coil: key });
      if (data.found) { // keep the phone's copy up to date
        const cache = cacheRead(COIL_CACHE_KEY);
        if (cache) { cache.coils[key] = data.coil; cacheWrite(COIL_CACHE_KEY, cache); }
      }
      return data;
    } catch (err) {
      if (!(err instanceof TypeError) && navigator.onLine) throw err; // a real error, not lost signal
    }
  }
  const cache = cacheRead(COIL_CACHE_KEY);
  if (!cache) throw new Error("No signal, and this phone has no saved coil list yet. Open the app once with signal.");
  const row = cache.coils[key];
  return row
    ? { found: true, coil: row, offline: true, savedAt: cache.savedAt }
    : { found: false, coil_number: key, offline: true, savedAt: cache.savedAt };
}

// ---------- Other lookups (damage options, truck slots) ----------
async function cachedGet(action) {
  const extras = cacheRead(EXTRA_CACHE_KEY) || {};
  try {
    if (!navigator.onLine) throw new TypeError("offline");
    const data = await getJson(action);
    extras[action] = data;
    cacheWrite(EXTRA_CACHE_KEY, extras);
    return data;
  } catch (err) {
    if (extras[action]) return extras[action];
    throw err instanceof TypeError ? new Error("No signal, and this phone hasn't saved this info yet.") : err;
  }
}

// ---------- Small grey bar when offline ----------
function updateOfflineBanner() {
  let el = document.getElementById("offlineBanner");
  if (!el) {
    const style = document.createElement("style");
    style.textContent =
      "#offlineBanner{display:none;margin:0 0 12px;padding:8px 12px;border-radius:8px;" +
      "font-size:14px;font-weight:600;background:var(--line);color:var(--ink)}" +
      "#offlineBanner.show{display:block}";
    document.head.appendChild(style);
    el = document.createElement("div");
    el.id = "offlineBanner";
    el.setAttribute("role", "status");
    (document.querySelector("main") || document.body).prepend(el);
  }
  if (navigator.onLine) { el.className = ""; return; }
  const cache = cacheRead(COIL_CACHE_KEY);
  el.textContent = "Offline. Using coil list saved at " + savedTime(cache && cache.savedAt) + ".";
  el.className = "show";
}

// ---------- Start ----------
window.addEventListener("online", () => { updateOfflineBanner(); refreshCoilList(); });
window.addEventListener("offline", updateOfflineBanner);
setInterval(refreshCoilList, COIL_REFRESH_MS);
document.addEventListener("DOMContentLoaded", () => {
  updateOfflineBanner();
  refreshCoilList();
  cachedGet("options").catch(() => {}); // save damage options for later
  cachedGet("slots").catch(() => {});   // save truck slots for later
});
// ---------- Keep a copy of the app on the phone (sw.js) ----------
if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("Offline copy not set up:", e));
  }