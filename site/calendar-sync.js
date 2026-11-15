// Google Calendar sync. Keeps the next 7 days of training in your Google Calendar as all-day "Training" events.
//
// How it works: whenever the plan changes (add, remove, move, skip, goal change) or a new day starts, the app works out
// which of the next 7 days have training and sends that list to a small script in your own Google account
// (calendar-bridge/Code.gs). The script makes the calendar match: it adds missing events, removes outdated ones, never
// creates duplicates and never touches events it did not create. See calendar-bridge/SETUP.md.
//
// The link and secret come from the encrypted data (DATA.calendar), so they are never public. Without them
// everything here stays silent. Loaded after app.js; uses its globals (DATA, buildSchedule, schedState, store, ...).

const CAL = {
  key: "garmin-calendar-sync-v1",
  title: "Training",
  debounceMs: 900,
  timeoutMs: 40000,
  retryMs: [5000, 15000, 45000, 120000, 300000], // then every 5 minutes
};
const calRun = { timer: null, retryTimer: null, busy: false, dirty: false, retries: 0, status: "idle", message: "", pending: null, offline: false };

function calConfig() {
  const c = typeof DATA !== "undefined" && DATA && DATA.calendar;
  return c && /^https:\/\/script\.google\.com\//.test(c.url || "") && c.secret ? c : null;
}
function calLoad() {
  try { return JSON.parse(store.get(CAL.key) || "null") || {}; } catch { return {}; }
}
function calSave(o) { store.set(CAL.key, JSON.stringify(o)); }

// The days that should have a "Training" event: a day with at least one session that is neither skipped nor optional.
// A session that is already done still counts, so the event stays after you have trained.
function calendarWanted(st = schedState(), today = localToday()) {
  const plan = buildSchedule({ state: st, today });
  const days = plan.days.filter((d) => d.items.some((it) => !it.skipped && !it.optional)).map((d) => d.date);
  return { from: today, to: addDays(today, 6), days };
}
const calSig = (w) => `${w.from}|${w.days.join(",")}`;

function calSetStatus(status, message = "") {
  calRun.status = status; calRun.message = message;
  const el = document.getElementById("cal-status");
  if (el) el.textContent = calStatusText();
  const sync = document.getElementById("cal-sync"), test = document.getElementById("cal-test");
  [sync, test].forEach((b) => b && (b.disabled = status === "syncing"));
}
function calStatusText() {
  if (!calConfig()) return "Not set up";
  const last = calLoad();
  const when = last.at ? new Date(last.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  if (calRun.status === "syncing") return "Syncing…";
  if (calRun.status === "retry") return `${(calRun.message || "Could not reach Google").replace(/\.$/, "")}. Trying again automatically.`;
  if (calRun.status === "error") return calRun.message;
  if (calRun.status === "ok" && calRun.message) return calRun.message;
  return last.sig ? `Up to date${when ? ` (last sync ${when})` : ""}` : "Ready. Press Sync now to start.";
}

async function calCall(payload) {
  const cfg = calConfig();
  if (!cfg) throw Object.assign(new Error("Calendar sync is not set up."), { fatal: true });
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), CAL.timeoutMs);
  let res, text;
  try {
    // text/plain keeps this a "simple" request, so the browser sends no preflight (Apps Script cannot answer one)
    res = await fetch(cfg.url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ ...payload, secret: cfg.secret }), signal: ctl.signal, redirect: "follow", credentials: "omit" });
    text = await res.text();
  } finally { clearTimeout(t); }
  let out = null;
  try { out = JSON.parse(text); } catch { /* not JSON */ }
  if (!out) throw Object.assign(new Error(res.ok ? "Google did not answer as expected. Check that the script is deployed with access set to Anyone." : `Google returned an error (${res.status}).`), { fatal: res.ok });
  if (!out.ok) throw Object.assign(new Error(out.error === "unauthorized" ? "Google rejected the secret. The secret in the script and the GOOGLE_CALENDAR_SECRET key must be identical." : `Calendar script error: ${out.error}`), { fatal: out.error === "unauthorized" || out.error === "bad request" });
  return out;
}

function calScheduleRetry() {
  clearTimeout(calRun.retryTimer);
  const wait = CAL.retryMs[Math.min(calRun.retries, CAL.retryMs.length - 1)];
  calRun.retries++;
  calRun.retryTimer = setTimeout(() => calendarSync("retry"), wait);
}

// Make the calendar match the plan. reason: "edit" | "open" | "retry" | "manual"
async function calendarSync(reason = "edit") {
  if (!calConfig() || typeof DATA === "undefined" || !DATA) return;
  if (calRun.busy) { calRun.dirty = true; return; }
  const w = calendarWanted(), sig = calSig(w), last = calLoad();
  if (reason !== "manual" && last.sig === sig) { if (calRun.status !== "ok") calSetStatus("idle"); return; } // nothing changed
  calRun.busy = true; calRun.dirty = false;
  clearTimeout(calRun.retryTimer);
  calSetStatus("syncing");
  try {
    const r = await calCall({ action: "sync", from: w.from, to: w.to, days: w.days, title: CAL.title });
    calSave({ ...calLoad(), sig, at: Date.now(), base: sig });
    calRun.retries = 0;
    calSetStatus("ok", `Synced just now · ${w.days.length} training day${w.days.length === 1 ? "" : "s"}${r.created || r.deleted || r.updated ? ` (${[r.created && `${r.created} added`, r.updated && `${r.updated} updated`, r.deleted && `${r.deleted} removed`].filter(Boolean).join(", ")})` : ""}`);
  } catch (e) {
    const msg = e.name === "AbortError" ? "Google took too long to answer" : e.message || "Sync failed";
    if (e.fatal) { calRun.retries = 0; calSetStatus("error", msg); } // retrying a wrong secret or setup mistake is pointless
    else { calSetStatus("retry", msg); calScheduleRetry(); }
  } finally {
    calRun.busy = false;
    if (calRun.dirty && calConfig()) calendarSyncSoon("edit");
  }
}

// Called from app.js after anything that may change the plan. Waits a moment so quick changes become one request.
// A device that has never synced does not start on its own (it could overwrite the calendar kept by your other device):
// it remembers the plan it saw first, and starts syncing once you change something here, or press Sync now.
function calendarSyncSoon(reason = "edit") {
  if (!calConfig() || typeof DATA === "undefined" || !DATA) return;
  const last = calLoad();
  if (!last.sig) {
    let sig; try { sig = calSig(calendarWanted()); } catch { return; }
    if (!last.base) { calSave({ ...last, base: sig }); return; }
    if (last.base === sig) return;
  }
  clearTimeout(calRun.timer);
  calRun.timer = setTimeout(() => calendarSync(reason), CAL.debounceMs);
}

window.addEventListener("online", () => { if (calRun.status === "retry") { calRun.retries = 0; calendarSync("retry"); } });

function calendarCard(view) {
  const on = !!calConfig();
  const el = section(view, `<details id="cal-card"><summary>Google Calendar · <span id="cal-status" role="status">${esc(calStatusText())}</span></summary>
    ${on ? `<p class="note">Your next 7 days of training are kept in Google Calendar as all-day “${esc(CAL.title)}” events. It updates by itself whenever the plan changes, and only ever touches events it created.</p>
      <p class="note"><button class="link-btn" id="cal-sync" data-cal="sync">Sync now</button> <button class="link-btn" id="cal-test" data-cal="test">Test connection</button></p>`
    : `<p class="note">Not connected. Follow calendar-bridge/SETUP.md in the project to turn this on (about 10 minutes, once).</p>`}</details>`);
  el.querySelectorAll("[data-cal]").forEach((b) => b.addEventListener("click", async () => {
    if (b.dataset.cal === "sync") { calRun.retries = 0; calendarSync("manual"); return; }
    calSetStatus("syncing");
    try { const r = await calCall({ action: "ping" }); calSetStatus("ok", `Connected to calendar “${r.calendar}”`); }
    catch (e) { calSetStatus("error", e.name === "AbortError" ? "Google took too long to answer" : e.message); }
  }));
}
