// Offline save queue. Needs config.js and auth.js loaded first.
// If a save can't reach the server, it's stored on the phone and sent automatically later.

const QUEUE_DB = "coil-scanner-queue";
const QUEUE_STORE = "saves";
const QUEUE_RETRY_MS = 20000;
let queueBusy = false;

// ---------- Phone storage (IndexedDB) ----------
function queueDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(QUEUE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(QUEUE_STORE, { keyPath: "id", autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function queueRun(mode, work) {
  const db = await queueDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, mode);
    const req = work(tx.objectStore(QUEUE_STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
  });
}

const queueAdd = (item) => queueRun("readwrite", (s) => s.add(item));
const queueAll = () => queueRun("readonly", (s) => s.getAll());
const queuePut = (item) => queueRun("readwrite", (s) => s.put(item));
const queueRemove = (id) => queueRun("readwrite", (s) => s.delete(id));

// ---------- Sending ----------
function queueApiUrl(action) {
  const q = new URLSearchParams({ action });
  if (TEST_MODE) q.set("test", "1");
  return API_URL + "?" + q.toString();
}

function isNetworkError(err) {
  return err instanceof TypeError || !navigator.onLine;
}

async function postToLambda(action, payload) {
  const res = await authFetch(queueApiUrl(action), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  const row = Array.isArray(data) ? data[0] : data;
  const message = data.error || (row && row.status >= 400 &&
    ((row.errors && row.errors[0] && row.errors[0].message) || "TeamDesk rejected the record"));
  if (message) {
    const err = new Error(message);
    err.fromServer = true;
    throw err;
  }
  return data;
}

// Use this for every save. Returns { queued: false } if sent now, { queued: true } if stored for later.
// Throws only if the server says the data itself is wrong (so the worker can fix it).
async function saveOrQueue(action, payload, label) {
  if (navigator.onLine) {
    try {
      await postToLambda(action, payload);
      return { queued: false };
    } catch (err) {
      if (!isNetworkError(err)) throw err;
    }
  }
  await queueAdd({ action, payload, label, createdAt: Date.now(), error: null });
  updateQueueBanner();
  return { queued: true };
}

async function processQueue() {
  if (queueBusy || !navigator.onLine) return;
  queueBusy = true;
  try {
    const items = await queueAll();
    for (const item of items) {
      if (item.error) continue; // failed before; waits for a manual retry
      try {
        await postToLambda(item.action, item.payload);
        await queueRemove(item.id);
      } catch (err) {
        if (isNetworkError(err)) break; // still no signal, try again later
        item.error = err.message;
        await queuePut(item);
      }
    }
  } catch (e) {
    console.error("Queue error:", e);
  } finally {
    queueBusy = false;
    updateQueueBanner();
  }
}

async function retryFailed() {
  const items = await queueAll();
  for (const item of items) {
    if (item.error) { item.error = null; await queuePut(item); }
  }
  processQueue();
}

// ---------- Banner at the top of the page ----------
function queueBanner() {
  let el = document.getElementById("queueBanner");
  if (el) return el;
  const style = document.createElement("style");
  style.textContent =
    "#queueBanner{position:sticky;top:env(safe-area-inset-top,0px);z-index:10;display:none;" +
    "margin:0 0 12px;padding:10px 12px;border-radius:8px;font-weight:700;font-size:15px;" +
    "background:var(--go);color:var(--go-ink,#1C2430);cursor:default}" +
    "#queueBanner.failed{background:var(--hold);color:#fff;cursor:pointer}" +
    "#queueBanner.show{display:block}";
  document.head.appendChild(style);
  el = document.createElement("div");
  el.id = "queueBanner";
  el.setAttribute("role", "status");
  el.addEventListener("click", async () => {
    if (!el.classList.contains("failed")) return;
    const failed = (await queueAll()).filter((i) => i.error);
    const list = failed.map((i) => "• " + i.label + ": " + i.error).join("\n");
    if (confirm("These saves were rejected:\n\n" + list + "\n\nTry sending them again?")) retryFailed();
  });
  const main = document.querySelector("main") || document.body;
  main.prepend(el);
  return el;
}

async function updateQueueBanner() {
  let items = [];
  try { items = await queueAll(); } catch (e) { return; }
  const el = queueBanner();
  const failed = items.filter((i) => i.error).length;
  const waiting = items.length - failed;
  el.className = "";
  if (failed) {
    el.textContent = "⚠ " + failed + " save" + (failed > 1 ? "s" : "") + " failed. Tap to review.";
    el.className = "show failed";
  } else if (waiting) {
    el.textContent = (navigator.onLine ? "Uploading " : "No signal. ") + waiting +
      " save" + (waiting > 1 ? "s" : "") + " waiting on this phone.";
    el.className = "show";
  }
}

// ---------- Start ----------
window.addEventListener("online", processQueue);
window.addEventListener("offline", updateQueueBanner);
setInterval(processQueue, QUEUE_RETRY_MS);
document.addEventListener("DOMContentLoaded", () => { updateQueueBanner(); processQueue(); });