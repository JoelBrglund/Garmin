"use strict";
/* Garmin Dashboard - unlocks site/data.enc in the browser and draws the dashboard.
   No libraries: charts are plain SVG drawn by the chart() function below. */

const $ = (sel, root = document) => root.querySelector(sel);
const PASS_KEY = "garmin-dashboard-pass";
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};

let DATA = null;
let PASS = null; // passphrase of the unlocked session, kept in memory for refreshing
const state = { tab: "today", day: null, night: null, range: 30, actType: "all", lift: null };

/* ---------- Unlocking ---------- */

const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function decrypt(blob, passphrase) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: fromB64(blob.salt), iterations: blob.iter, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const gz = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(blob.iv) }, key, fromB64(blob.ct));
  const text = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  return JSON.parse(text);
}

async function loadBlob() {
  const res = await fetch(`data.enc?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not load data (HTTP ${res.status}).`);
  return res.json();
}

async function unlock(passphrase, remember) {
  const blob = await loadBlob();
  try {
    DATA = await decrypt(blob, passphrase);
  } catch (e) {
    if (e.name === "OperationError") throw new Error("Wrong passphrase.");
    throw e;
  }
  PASS = passphrase;
  lastCheck = Date.now();
  if (remember) store.set(PASS_KEY, passphrase);
  await loadDemoScript();
  prepare();
  $("#lock").hidden = true;
  $("#app").hidden = false;
  render();
}

function showLock(message = "") {
  DATA = null; PASS = null;
  setStatus("");
  $("#app").hidden = true;
  $("#lock").hidden = false;
  $("#lock-error").textContent = message;
  $("#pass").value = "";
  $("#pass").focus();
}

$("#lock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#unlock-btn");
  btn.disabled = true; btn.textContent = "Unlocking…"; $("#lock-error").textContent = "";
  try { await unlock($("#pass").value, $("#remember").checked); }
  catch (err) { $("#lock-error").textContent = err.message; }
  finally { btn.disabled = false; btn.textContent = "Unlock"; }
});

$("#lock-btn").addEventListener("click", () => { store.del(PASS_KEY); showLock(); });

/* ---------- Refreshing ----------
   The refresh button first reloads the copy on the website. If that has nothing new, it asks
   GitHub to run the update workflow now (using the key stored inside the encrypted data) and
   waits for the new data to be published, which takes about 2-3 minutes. */

let refreshing = false, lastCheck = 0, statusTimer = null;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const minutesSince = (iso) => (Date.now() - new Date(iso)) / 60000;

function setStatus(text, kind = "", clearAfter = 0) {
  clearTimeout(statusTimer);
  const el = $("#refresh-status");
  el.textContent = text;
  el.className = `small ${kind === "error" ? "error" : "muted"}`;
  el.hidden = !text;
  if (clearAfter) statusTimer = setTimeout(() => setStatus(""), clearAfter);
}

// Reloads data.enc. Redraws only if it is newer, so scroll position and open details are kept otherwise.
async function reloadData() {
  const fresh = await decrypt(await loadBlob(), PASS);
  lastCheck = Date.now();
  if (fresh.generatedAt === DATA.generatedAt) { showUpdated(); return false; } // nothing new: keep the data (and its Hevy links) as is
  DATA = fresh; prepare(); render();
  return true;
}

async function github(r, path, options = {}) {
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${r.repo}/actions/${path}`, { ...options, cache: "no-store",
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${r.token}`, "X-GitHub-Api-Version": "2022-11-28" } });
  } catch { throw new Error("Couldn't reach GitHub - check your internet connection."); }
  if (res.status === 401) throw new Error("The refresh key has expired or is wrong - make a new one (see CLAUDE.md).");
  if (res.status === 403 || res.status === 404) throw new Error("The refresh key isn't allowed to start updates - it needs Actions: Read and write.");
  if (!res.ok) throw new Error(`GitHub didn't accept the request (HTTP ${res.status}).`);
  return res.status === 204 ? null : res.json().catch(() => null);
}
const latestRun = async (r) => (await github(r, `workflows/${r.workflow}/runs?per_page=1`))?.workflow_runs?.[0] || null;

async function refresh() {
  if (refreshing || !DATA) return;
  refreshing = true;
  const btn = $("#refresh-btn");
  btn.classList.add("busy"); btn.setAttribute("aria-busy", "true");
  try {
    if (!navigator.onLine) return setStatus("You're offline - showing the last saved data.", "", 6000);
    setStatus("Checking for new data…");
    if (await reloadData()) return setStatus("Updated with the latest data.", "", 5000);
    const r = DATA.refresh;
    if (!r?.token) return setStatus("Already up to date. New data arrives every 3 hours.", "", 6000);
    if (minutesSince(DATA.generatedAt) < 10) return setStatus("Already up to date - fetched from Garmin a few minutes ago.", "", 6000);

    // Start the update, unless one is already running.
    const started = Date.now();
    const running = await latestRun(r);
    if (!running || running.status === "completed") await github(r, `workflows/${r.workflow}/dispatches`, { method: "POST", body: JSON.stringify({ ref: r.ref }) });

    let polls = 0;
    while (Date.now() - started < 8 * 60000) {
      const s = Math.round((Date.now() - started) / 1000);
      setStatus(`Getting new data from Garmin… ${Math.floor(s / 60)}:${pad2(s % 60)} (usually 2-3 min)`);
      await sleepMs(5000);
      if (await reloadData()) return setStatus("Updated with the latest data.", "", 5000);
      if (++polls % 3 === 0) { // check the run itself every 15 s so a failure is reported right away
        const run = await latestRun(r);
        if (run && run.status === "completed" && run.conclusion !== "success" && new Date(run.created_at) > started - 60000)
          throw new Error("The update failed - open GitHub Actions to see why.");
      }
    }
    throw new Error("The update is taking longer than usual - try again in a few minutes.");
  } catch (err) {
    if (err.name === "OperationError") { store.del(PASS_KEY); return showLock("Passphrase changed - enter the new one."); }
    setStatus(err.message, "error", 15000);
  } finally {
    refreshing = false;
    btn.classList.remove("busy"); btn.removeAttribute("aria-busy");
  }
}
$("#refresh-btn").addEventListener("click", refresh);

// The installed iPhone app resumes where it was left, so quietly check for new data when it comes back.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && DATA && !refreshing && Date.now() - lastCheck > 5 * 60000)
    reloadData().catch(() => {});
});

(async function start() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  const pass = store.get(PASS_KEY);
  if (!pass) return showLock();
  try { await unlock(pass, true); }
  catch (err) {
    if (err.message === "Wrong passphrase.") { store.del(PASS_KEY); showLock("Passphrase changed - enter the new one."); }
    else showLock(err.message);
  }
})();

/* ---------- Data helpers ---------- */

const byDate = new Map();
// Preview of the Strength features with made-up lifts, for when Hevy isn't connected (open the site with #demo-hevy).
function loadDemoScript() {
  return new Promise((done) => {
    if (location.hash !== "#demo-hevy" || window.makeDemoHevy) return done();
    const el = document.createElement("script");
    el.src = "demo-hevy.js"; el.onload = el.onerror = () => done();
    document.head.appendChild(el);
  });
}
function applyDemo() {
  if (location.hash === "#demo-hevy" && !DATA.hevy && window.makeDemoHevy) { DATA.hevy = window.makeDemoHevy(DATA); DATA.demo = true; }
}

// A day counts once Garmin has returned something for it. Today often has only a weigh-in until the watch syncs.
const hasDayData = (d) => nz(d.rhr) || !!d.hrv || !!d.sleep || nz(d.steps);
const latestDate = () => ([...DATA.days].reverse().find(hasDayData) || DATA.days[DATA.days.length - 1]).date;

function prepare() {
  applyDemo();
  linkHevy();
  $("[data-tab=strength]").hidden = !DATA.hevy;
  byDate.clear();
  DATA.days.forEach((d) => byDate.set(d.date, d));
  const todayStr = localToday();
  const dates = DATA.days.filter(hasDayData).map((d) => d.date);
  if (!state.day || !dates.includes(state.day)) state.day = dates.includes(todayStr) ? todayStr : dates[dates.length - 1];
  const nights = DATA.days.filter((d) => d.sleep).map((d) => d.date);
  if (!state.night || !nights.includes(state.night)) state.night = nights[nights.length - 1] || null;
}

function localToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: DATA.timezone }).format(new Date());
}

const metric = () => DATA.units !== "statute";
const nz = (v) => v !== null && v !== undefined && !Number.isNaN(v);
const num = (v, digits = 0) => nz(v) ? Number(v).toLocaleString("en-GB", { maximumFractionDigits: digits, minimumFractionDigits: digits }) : "–";
const pad2 = (n) => String(n).padStart(2, "0");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function humanize(key) {
  if (!key) return "";
  const s = String(key).replace(/_\d+$/, "").replace(/_/g, " ").toLowerCase().replace(/\bbb\b/g, "Body Battery").replace(/\bhrv\b/g, "HRV");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function dur(sec, style = "hm") { // "7h 14m" or "45:49"
  if (!nz(sec)) return "–";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (style === "clock") return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
  return h ? `${h}h ${pad2(m)}m` : `${m}m`;
}

function dist(m, digits) {
  if (!nz(m)) return "–";
  if (metric()) return m < 1000 ? `${num(m)} m` : `${num(m / 1000, digits ?? 2)} km`;
  const mi = m / 1609.344;
  return mi < 0.1 ? `${num(m * 3.28084)} ft` : `${num(mi, digits ?? 2)} mi`;
}
const elev = (m) => !nz(m) ? "–" : metric() ? `${num(m)} m` : `${num(m * 3.28084)} ft`;
const weight = (kg) => !nz(kg) ? "–" : metric() ? `${num(kg, 1)} kg` : `${num(kg * 2.20462, 1)} lb`;
const temp = (c) => !nz(c) ? "–" : metric() ? `${num(c)} °C` : `${num(c * 9 / 5 + 32)} °F`;

function pace(mps, per = metric() ? 1000 : 1609.344) {
  if (!nz(mps) || mps <= 0) return "–";
  return dur(per / mps, "clock");
}
const paceUnit = () => metric() ? "/km" : "/mi";
const speed = (mps) => !nz(mps) ? "–" : metric() ? `${num(mps * 3.6, 1)} km/h` : `${num(mps * 2.23694, 1)} mph`;

const dayDate = (s) => new Date(`${s}T00:00:00Z`);
function fmtDay(s, opts = { weekday: "short", day: "numeric", month: "short" }) {
  return dayDate(s).toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" });
}
function relDay(s) {
  const t = localToday();
  const diff = Math.round((dayDate(t) - dayDate(s)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return fmtDay(s, { weekday: "long", day: "numeric", month: "long" });
}
// Garmin "local" timestamps are already in local time, so format them as UTC.
function clockLocal(ms) {
  if (!nz(ms)) return "–";
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: DATA.timeFormat === "12", timeZone: "UTC" });
}
// Real (GMT) timestamps are shown in the Garmin profile's time zone.
function clockReal(ms) {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: DATA.timeFormat === "12", timeZone: DATA.timezone });
}
function clockStr(s) { // "2026-10-23 12:23:12" or ISO, already local
  if (!s) return "–";
  const d = new Date(String(s).replace(" ", "T") + (String(s).endsWith("Z") ? "" : "Z"));
  return clockLocal(d.getTime());
}

function ago(iso) {
  const min = Math.round((Date.now() - new Date(iso)) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

const QUALITY = { EXCELLENT: "good", GOOD: "good", FAIR: "warning", POOR: "critical",
  BALANCED: "good", UNBALANCED: "warning", LOW: "serious", ONLY_LOW: "serious", POOR_HRV: "critical" };
function status(key, text) {
  if (!key) return "";
  return `<span class="status ${QUALITY[String(key).toUpperCase()] || ""}">${esc(text ?? humanize(key))}</span>`;
}

function rows(list) {
  const items = list.filter(([, v]) => v !== undefined && v !== null && v !== "–" && v !== "");
  if (!items.length) return `<p class="empty">No data.</p>`;
  return `<div class="rows">${items.map(([k, v]) => `<div class="row"><span>${esc(k)}</span><span>${v}</span></div>`).join("")}</div>`;
}

function tile(label, value, sub = "", extra = "") {
  return `<div class="tile"><div class="label">${esc(label)}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}${extra}</div>`;
}
const meter = (frac) => `<div class="meter"><span style="width:${Math.max(0, Math.min(1, frac || 0)) * 100}%"></span></div>`;

function stackBar(parts) { // parts: [{label, value, color}]
  const total = parts.reduce((a, p) => a + (p.value || 0), 0);
  if (!total) return "";
  const bar = parts.filter((p) => p.value > 0)
    .map((p) => `<span style="flex:${p.value} 1 0;background:${p.color}" title="${esc(p.label)}"></span>`).join("");
  const legend = parts.map((p) => `<span><i style="background:${p.color}"></i>${esc(p.label)}<b>${p.text ?? num(p.value)}</b></span>`).join("");
  return `<div class="stack">${bar}</div><div class="legend">${legend}</div>`;
}

const avg = (vals) => { const v = vals.filter(nz); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
// Average of the last n values at each point (smooths out day-to-day noise).
const rolling = (vals, n = 7) => vals.map((_, i) => {
  const w = vals.slice(Math.max(0, i - n + 1), i + 1).filter(nz);
  return w.length >= 3 ? w.reduce((a, b) => a + b, 0) / w.length : null;
});
// Your personal baseline: average of the n days before dateStr.
const baseline = (pick, dateStr, n = 30) => avg(DATA.days.filter((d) => d.date < dateStr).slice(-n).map(pick));
function vsBaseline(v, base, unit) {
  if (!nz(v) || !nz(base)) return "";
  const diff = Math.round(v - base);
  if (!diff) return `Same as your 30-day average`;
  return `${Math.abs(diff)} ${unit} ${diff < 0 ? "below" : "above"} your 30-day avg (${num(base)})`;
}
const actDate = (a) => a.startTimeLocal.slice(0, 10);
const mondayOf = (dateStr) => { const d = dayDate(dateStr); return new Date(d - ((d.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10); };
const addDays = (dateStr, n) => new Date(+dayDate(dateStr) + n * 86400000).toISOString().slice(0, 10);
// Totals per Monday-to-Sunday week: [{ s: "YYYY-MM-DD", v: number }], oldest first.
function weekly(acts, value, weeks = 12) {
  const last = mondayOf(localToday()), out = [];
  for (let k = weeks - 1; k >= 0; k--) {
    const s = addDays(last, -7 * k), e = addDays(s, 7);
    out.push({ s, v: acts.filter((a) => actDate(a) >= s && actDate(a) < e).reduce((x, a) => x + (value(a) || 0), 0) });
  }
  return out;
}
const isRealRun = (a) => /run/.test(a.type) && a.distance > 0;

/* ---------- Estimated training status ----------
   Garmin's API doesn't provide Training Status (it needs VO2 max), so this estimates it from
   training load (Garmin's own per-workout number) and a fitness trend led by swimming.
   All thresholds are in TS so they are easy to tune. See CLAUDE.md for the full explanation. */

const TS = {
  minDays: 28, minWorkouts: 6,             // below this: "No status"
  over: 1.5, overStressed: 1.3,            // load ratio (this week / 4-week weekly average)
  recovery: 0.8, detrain: 0.5, peakMax: 1.05, productiveMin: 1.0,
  swimMinDist: 1500, swimMinN: 4, swimTol: 0.03,   // swim windows: last 28 days vs the 28 before
  rhrTol: 1.5, rhrRise: 3, hrvTol: 0.05,
  trendCut: 0.25,                          // weighted vote needed to call a trend
  anaerobicMinTE: 2.0,                     // anaerobic training effect that counts as high-intensity work
  anaerobicWeight: 0.5,                    // anaerobic scores read high, so they count half in the load split
};

const median = (vals) => { const v = vals.filter(nz).sort((a, b) => a - b); return v.length ? (v[(v.length - 1) >> 1] + v[v.length >> 1]) / 2 : null; };

// Compares a recent value with an earlier one. Returns "up" (better), "down" (worse) or "flat".
function judge(cur, prev, tol, { relative = true, lowerIsBetter = false } = {}) {
  const change = relative ? (cur - prev) / prev : cur - prev;
  const better = lowerIsBetter ? -change : change;
  return better > tol ? "up" : better < -tol ? "down" : "flat";
}

const isStrength = (a) => a.type === "strength_training";

/* ---------- VO2 max ----------
   Garmin's API has no VO2 max, so it is worked out the way Garmin does it from running: speed (grade
   adjusted) against heart rate. Swimming can't give a true VO2 max (swim oxygen cost depends on technique),
   so "Swim VO2 max" is a trend index: swim speed per fraction of heart-rate reserve, scaled to the running
   number. Read it as up / down / flat. Swims are only ever compared within the same pool length. */

const VO = {
  runMinSec: 600, runMinDist: 1000, runMinSpeed: 1.5, hrrLo: 0.55, hrrHi: 0.95,
  longRunMin: 40,             // longer runs drift in heart rate; they only count when there are too few others
  runOffset: -2.0,            // fitted to the watch's value (56-57)
  swimMinDist: 1500, swimHrMax: 181, swimHrrLo: 0.45, swimHrrHi: 0.95,
  swimTechSwolf: 1.08,        // swims with SWOLF this far above your usual in that pool look like drill/technique sessions and are left out
  smoothRun: 3, smoothSwim: 5, // sessions in the chart's rolling median
  swimScale: 34.3,            // makes a typical recent swim read about the same as the running value
  currentDays: 42, minN: 2, tol: 0.02,
};

// One value per eligible run / swim, oldest first.
function vo2Points(kind) {
  const rhr = new Map(DATA.days.map((d) => [d.date, d.rhr]));
  const zone = (DATA.hrZones || []).find((z) => z.sport === "RUNNING") || (DATA.hrZones || [])[0] || {};
  const runMax = zone.maxHeartRateUsed || 194, zoneRest = zone.restingHeartRateUsed || 48;
  const out = [];
  const poolOf = (a) => (a.poolLength > 0 ? Math.round(a.poolLength / 100) : 0);
  const usualSwolf = new Map(); // your usual SWOLF per pool length
  if (kind === "swim") {
    const by = new Map();
    DATA.activities.filter((a) => isSwim(a) && a.averageSwolf > 0).forEach((a) => { const k = poolOf(a); if (!by.has(k)) by.set(k, []); by.get(k).push(a.averageSwolf); });
    by.forEach((v, k) => usualSwolf.set(k, median(v)));
  }
  DATA.activities.forEach((a) => {
    if (!a.averageHR) return;
    const rest = rhr.get(actDate(a)) ?? zoneRest;
    if (kind === "run" && isRealRun(a)) {
      const v = a.avgGradeAdjustedSpeed || a.averageSpeed, hrr = (a.averageHR - rest) / (runMax - rest);
      if (!(a.duration >= VO.runMinSec) || a.distance < VO.runMinDist || !(v >= VO.runMinSpeed) || hrr < VO.hrrLo || hrr > VO.hrrHi) return;
      out.push({ date: actDate(a), value: (12 * v) / hrr + 3.5 + VO.runOffset, long: a.duration > VO.longRunMin * 60, pool: 0,
        tip: `${fmtDay(actDate(a))} · ${dist(a.distance, 1)} · ${pace(a.averageSpeed)} ${paceUnit()} · ${num(a.averageHR)} bpm` });
    } else if (kind === "swim" && isSwim(a)) {
      const secs = a.movingDuration || a.duration, hrr = (a.averageHR - rest) / (VO.swimHrMax - rest);
      if (!(secs > 0) || a.distance < VO.swimMinDist || hrr < VO.swimHrrLo || hrr > VO.swimHrrHi) return;
      const pool = poolOf(a);
      if (a.averageSwolf > 0 && usualSwolf.get(pool) && a.averageSwolf > usualSwolf.get(pool) * VO.swimTechSwolf) return; // drill / technique session
      out.push({ date: actDate(a), value: (VO.swimScale * (a.distance / secs)) / hrr, long: false, pool,
        tip: `${fmtDay(actDate(a))} · ${dist(a.distance)} · ${pool ? pool + " m pool" : "open water"}` });
    }
  });
  return out.sort((x, y) => x.date.localeCompare(y.date));
}

// Current value (median of the last 6 weeks) and trend (last 4 weeks vs the 4 before).
function vo2Summary(kind, day = latestDate()) {
  const age = (p) => (dayDate(day) - dayDate(p.date)) / 86400000;
  const all = vo2Points(kind).filter((p) => age(p) >= 0);
  let pts = all, pool = null;
  if (kind === "swim" && all.length) { pool = all[all.length - 1].pool; pts = all.filter((p) => p.pool === pool); } // like with like
  const pick = (lo, hi) => { const w = pts.filter((p) => age(p) >= lo && age(p) < hi), steady = w.filter((p) => !p.long); return steady.length >= VO.minN ? steady : w; };
  const res = { kind, all, pts, pool, value: null, date: null, stale: false, trend: null };
  const cur = pick(0, VO.currentDays);
  if (cur.length >= VO.minN) { res.value = median(cur.map((p) => p.value)); res.date = cur[cur.length - 1].date; }
  else if (pts.length) { res.value = pts[pts.length - 1].value; res.date = pts[pts.length - 1].date; res.stale = true; }
  const c = pick(0, 28), pr = pick(28, 56);
  if (c.length >= VO.minN && pr.length >= VO.minN) {
    const now = median(c.map((p) => p.value)), before = median(pr.map((p) => p.value));
    res.trend = { now, before, diff: now - before, verdict: judge(now, before, VO.tol) };
  }
  return res;
}

function vo2Tiles(view) {
  const run = vo2Summary("run"), swim = vo2Summary("swim");
  if (!run.value && !swim.value) return;
  const sub = (s, extra = "") => {
    const t = s.trend, arrow = !t ? "" : t.verdict === "up" ? "↑" : t.verdict === "down" ? "↓" : "→";
    return (t ? `${arrow} ${t.diff > 0 ? "+" : ""}${num(t.diff, 1)} vs previous 4 weeks` : "No trend yet") + (s.stale ? `<br>as of ${esc(fmtDay(s.date))}` : "") + extra;
  };
  const tl = (label, s, extra) => tile(label, s.value ? `${num(s.value)}<small> ml/kg/min</small>` : "–", s.value ? sub(s, extra) : "Not enough data yet");
  section(view, [tl("VO2 max · running", run), tl("VO2 max · swimming", swim, swim.pool ? ` · ${swim.pool} m pool` : "")].join(""), "tiles");
}

function vo2Charts(grid, from, short) {
  const c = [css("--s1"), css("--s2")];
  // Single sessions swing a lot, so the line is the median of the last 3 sessions (same pool for swims); hover shows the single value.
  const smooth = (pts, n) => pts.map((p, i) => ({ ...p, line: median(pts.slice(Math.max(0, i - n + 1), i + 1).map((x) => x.value)) }));
  const tip = (p) => `${p.tip} · ${num(p.value, 1)}${p.long ? " (long run)" : ""}`;
  const run = vo2Summary("run"), rp = smooth(run.all, VO.smoothRun).filter((p) => p.date >= from);
  if (rp.length) chartCard(grid, "Running VO2 max", {
    type: "line", labels: rp.map((p) => short(p.date)), xName: "Run", tipLabels: rp.map(tip),
    series: [{ name: "VO2 max", color: c[0], values: rp.map((p) => p.line) }],
    yFmt: (v) => `${num(v, 1)} ml/kg/min`, axisFmt: (v) => num(v), dots: rp.length < 40,
  }, "Worked out from your running pace and heart rate, the way Garmin does. Each point is the median of your last 3 runs. Going up = fitter.");
  const swim = vo2Summary("swim");
  const byPool = new Map();
  swim.all.forEach((p) => { if (!byPool.has(p.pool)) byPool.set(p.pool, []); byPool.get(p.pool).push(p); });
  let sp = [...byPool.values()].flatMap((list) => smooth(list, VO.smoothSwim)).filter((p) => p.date >= from).sort((x, y) => x.date.localeCompare(y.date));
  const counts = new Map(); sp.forEach((p) => counts.set(p.pool, (counts.get(p.pool) || 0) + 1));
  const kept = new Set([...counts].filter(([, n]) => n >= 3).map(([pool]) => pool));
  if (kept.size) sp = sp.filter((p) => kept.has(p.pool)); // a pool with 1-2 swims in view would only add stray dots
  if (sp.length) {
    const pools = [...new Set(sp.map((p) => p.pool))].sort((x, y) => y - x);
    chartCard(grid, "Swim VO2 max", {
      type: "line", labels: sp.map((p) => short(p.date)), xName: "Swim", tipLabels: sp.map(tip), connect: true,
      series: pools.map((pl, i) => ({ name: pl ? `${pl} m pool` : "Open water", color: c[i % 2], values: sp.map((p) => (p.pool === pl ? p.line : null)) })),
      yFmt: (v) => `${num(v, 1)}`, axisFmt: (v) => num(v), dots: sp.length < 40,
    }, "Swim speed at a given effort, scaled to the running number. Each point is the median of your last 5 swims in that pool; drill and technique swims are left out. Read it as up, down or flat.");
  }
}

// Splits 28 days of training load into low aerobic, high aerobic and anaerobic.
function loadFocus(day) {
  const out = { low: 0, high: 0, an: 0 };
  DATA.activities.forEach((a) => {
    const age = (dayDate(day) - dayDate(actDate(a))) / 86400000;
    const L = a.activityTrainingLoad;
    if (isStrength(a) || age < 0 || age >= 28 || !nz(L)) return;
    const ae = a.aerobicTrainingEffect || 0, an = a.anaerobicTrainingEffect || 0;
    const anShare = an >= TS.anaerobicMinTE && ae + an > 0 ? (TS.anaerobicWeight * an) / (ae + an) : 0;
    const z = [1, 2, 3, 4, 5].map((i) => a[`hrTimeInZone_${i}`] || 0), zt = z.reduce((x, y) => x + y, 0);
    const lowShare = zt ? (z[0] + z[1]) / zt : 0.5;
    out.an += L * anShare;
    out.low += L * (1 - anShare) * lowShare;
    out.high += L * (1 - anShare) * (1 - lowShare);
  });
  return { ...out, total: out.low + out.high + out.an };
}

function trainingStatus(day = latestDate()) {
  const age = (d) => (dayDate(day) - dayDate(d)) / 86400000;
  // Aerobic status looks at cardio only (swim, run, walk, bike); lifting has its own gauges.
  const acts = DATA.activities.filter((a) => age(actDate(a)) >= 0 && !isStrength(a));
  const inWin = (list, get, lo, hi) => list.filter((x) => { const g = age(get(x)); return g >= lo && g < hi; });
  const loadSum = (lo, hi) => inWin(acts, actDate, lo, hi).reduce((s, a) => s + (a.activityTrainingLoad || 0), 0);
  const days = DATA.days.filter((d) => age(d.date) >= 0);

  const load7 = loadSum(0, 7), chronic = loadSum(0, 28) / 4;
  const ratio = chronic > 0 ? load7 / chronic : null;
  const prevRatio = chronic > 0 ? loadSum(7, 14) / chronic : null;
  const workouts = inWin(acts, actDate, 0, 28).length;
  // Garmin's own acute/chronic numbers add up every activity, lifting included; shown next to the cardio-only ones.
  const allLoad = (lo, hi) => DATA.activities.filter((a) => { const g = age(actDate(a)); return g >= lo && g < hi; }).reduce((s, a) => s + (a.activityTrainingLoad || 0), 0);
  const res = { day, load7, chronic, ratio, workouts, signals: [], trend: null, focus: loadFocus(day), totalLoad7: allLoad(0, 7), totalChronic: allLoad(0, 28) / 4 };

  // --- Fitness signals (swimming leads) ---
  const swims = acts.filter((a) => isSwim(a) && a.distance >= TS.swimMinDist && a.averageHR && (a.movingDuration || a.duration));
  const swimWin = (val) => {
    const cur = inWin(swims, actDate, 0, 28).map(val), prev = inWin(swims, actDate, 28, 56).map(val);
    return cur.filter(nz).length >= TS.swimMinN && prev.filter(nz).length >= TS.swimMinN ? [median(cur), median(prev)] : null;
  };
  const add = (key, label, weight, verdict, detail) => res.signals.push({ key, label, weight, verdict, detail });

  const sv = vo2Summary("swim", day);
  if (sv.trend) add("swimVo2", "Swim VO2 max", 2, sv.trend.verdict,
    `${num(sv.trend.now, 1)} now vs ${num(sv.trend.before, 1)} before${sv.pool ? ` (${sv.pool} m pool)` : ""}`);
  // SWOLF depends on pool length (50 m pools read about double 25 m pools), so scale it to a 25 m pool.
  const sw = swimWin((a) => a.averageSwolf > 0 && a.poolLength > 0 ? a.averageSwolf / (a.poolLength / 100 / 25) : null);
  if (sw) add("swolf", "SWOLF (per 25 m)", 1, judge(sw[0], sw[1], TS.swimTol, { lowerIsBetter: true }),
    `${num(sw[0], 1)} now vs ${num(sw[1], 1)} before (lower is better)`);

  const rhrAvg = (lo, hi) => avg(inWin(days, (d) => d.date, lo, hi).map((d) => d.rhr));
  const rhrNow = rhrAvg(0, 14), rhrPrev = rhrAvg(14, 56);
  const rhrCount = inWin(days, (d) => d.date, 0, 14).filter((d) => nz(d.rhr)).length;
  if (nz(rhrNow) && nz(rhrPrev) && rhrCount >= 7) add("rhr", "Resting heart rate", 1,
    judge(rhrNow, rhrPrev, TS.rhrTol, { relative: false, lowerIsBetter: true }), `${num(rhrNow, 1)} bpm now vs ${num(rhrPrev, 1)} before`);

  const hrvAvg = (lo, hi) => avg(inWin(days, (d) => d.date, lo, hi).map((d) => d.hrv?.avg));
  const hrvNow = hrvAvg(0, 7), hrvPrev = hrvAvg(7, 49);
  const latestHrv = [...days].reverse().find((d) => d.hrv)?.hrv;
  const hrvLow = !!latestHrv && (/^(LOW|POOR)/.test(latestHrv.status || "")
    || (nz(latestHrv.weekly) && nz(latestHrv.low) && latestHrv.weekly < latestHrv.low));
  if (nz(hrvNow) && nz(hrvPrev)) {
    const v = hrvLow ? "down" : judge(hrvNow, hrvPrev, TS.hrvTol);
    add("hrv", "HRV", 1, v, `${num(hrvNow)} ms (7-day) vs ${num(hrvPrev)} before${hrvLow ? " · below your normal range" : ""}`);
  }

  const rv = vo2Summary("run", day);
  if (rv.trend) add("runVo2", "Running VO2 max", 1, rv.trend.verdict, `${num(rv.trend.now, 1)} now vs ${num(rv.trend.before, 1)} before`);

  // Weighted vote: improving +weight, declining -weight.
  if (res.signals.length >= 2) {
    const W = res.signals.reduce((s, x) => s + x.weight, 0);
    const score = res.signals.reduce((s, x) => s + x.weight * (x.verdict === "up" ? 1 : x.verdict === "down" ? -1 : 0), 0) / W;
    res.trend = score > TS.trendCut ? "up" : score < -TS.trendCut ? "down" : "flat";
  }

  // --- Status (first match wins) ---
  const set = (key, label, tone, reason) => Object.assign(res, { key, label, tone, reason });
  const trendText = { up: "your fitness signals are improving", down: "your fitness signals are slipping", flat: "your fitness signals are steady" }[res.trend] || "";
  const rhrRose = nz(rhrNow) && nz(rhrPrev) && rhrNow - rhrPrev >= TS.rhrRise;
  const enough = days.length >= TS.minDays && workouts >= TS.minWorkouts && ratio !== null;

  if (!enough) set("none", "No status", "", `Needs at least ${TS.minDays} days of data and ${TS.minWorkouts} workouts in the last 4 weeks.`);
  else if (ratio > TS.over || (ratio > TS.overStressed && (hrvLow || rhrRose)))
    set("overreaching", "Overreaching", "critical", `This week's load is ${num(ratio, 2)}× your 4-week average${hrvLow || rhrRose ? " and recovery markers are strained" : ""}. Ease off for a few days.`);
  else if (ratio < TS.detrain || (ratio < TS.recovery && prevRatio !== null && prevRatio < TS.recovery))
    set("detraining", "Detraining", "warning", `Load has been well below your usual for a while (${num(ratio, 2)}× your 4-week average). Fitness starts to fade.`);
  else if (ratio < TS.recovery)
    set("recovery", "Recovery", "", `A lighter week (${num(ratio, 2)}× your 4-week average), good for absorbing recent training.`);
  else if (res.trend === null)
    set("none", "No status", "", "Not enough fitness data (swims, resting HR, HRV) to judge your trend yet.");
  else if (res.trend === "down")
    set("unproductive", "Unproductive", "warning", `Load is normal (${num(ratio, 2)}×) but ${trendText}. Check sleep, stress and recovery.`);
  else if (res.trend === "up" && ratio <= TS.peakMax && !hrvLow)
    set("peaking", "Peaking", "good", `Load is easy to moderate (${num(ratio, 2)}×) and ${trendText}. A good time to perform.`);
  else if (res.trend === "up" && ratio >= TS.productiveMin)
    set("productive", "Productive", "good", `Load is solid (${num(ratio, 2)}×) and ${trendText}. Keep going.`);
  else set("maintaining", "Maintaining", "", `Load is in your normal range (${num(ratio, 2)}×) and ${trendText}.`);
  return res;
}


/* ---------- Readiness (0-100) ----------
   How ready you are to train hard today: recovery markers (HRV, sleep, resting HR) plus how much
   recent training (cardio and lifting) is still weighing on you. Garmin's own Training Readiness
   isn't in the API, so this is an estimate. Weights and cut-offs are in RD. */

const RD = {
  weights: { hrv: 0.30, sleep: 0.25, rhr: 0.15, load: 0.30 },
  minParts: 3,
  baselineDays: 42, nights: 3,
  halfLifeDays: 1.4,         // how fast a workout's fatigue fades
  steadyLoad: 2.54,          // decayed load of steady daily training, in days of average load
  labels: [[85, "Prime", "good"], [70, "Good", "good"], [55, "Moderate", ""], [40, "Low", "warning"], [0, "Poor", "critical"]],
};
const clamp100 = (x) => Math.max(0, Math.min(100, x));
const sdOf = (vals) => { const v = vals.filter(nz); if (v.length < 4) return null; const m = avg(v); return Math.sqrt(avg(v.map((x) => (x - m) ** 2))); };

// Training load counted toward fatigue. Lifting uses the Hevy-based gym load when available (Garmin under-counts it).
const effLoad = (a) => (a.hevy ? Math.max(a.activityTrainingLoad || 0, hevyLoad(a.hevy)) : a.activityTrainingLoad || 0);

function readiness(day = latestDate()) {
  const days = DATA.days.filter((d) => d.date <= day).reverse(); // newest first
  const cur = days[0];
  const parts = [];
  const add = (key, label, score, detail) => parts.push({ key, label, score: Math.round(clamp100(score)), detail });
  const prior = (pick) => days.slice(1, 1 + RD.baselineDays).map(pick);

  const hrvs = days.slice(0, RD.nights).map((d) => d.hrv?.avg).filter(nz);
  const hrvBase = prior((d) => d.hrv?.avg).filter(nz);
  if (hrvs.length >= 2 && hrvBase.length >= 14) {
    const b = avg(hrvBase), sd = Math.max(sdOf(hrvBase) || 0, b * 0.05), now = avg(hrvs);
    add("hrv", "HRV", 70 + ((now - b) / sd) * 20, `${num(now)} ms (3-night avg) vs ${num(b)} usual`);
  }
  const sl = days.slice(0, RD.nights).map((d) => d.sleep?.score).filter(nz);
  if (sl.length >= 2) add("sleep", "Sleep", avg(sl), `Sleep score ${num(avg(sl))} over the last ${sl.length} nights`);
  const rhrBase = prior((d) => d.rhr).filter(nz);
  if (nz(cur?.rhr) && rhrBase.length >= 14) {
    const b = avg(rhrBase), sd = Math.max(sdOf(rhrBase) || 0, 1);
    add("rhr", "Resting heart rate", 75 - ((cur.rhr - b) / sd) * 20, `${num(cur.rhr)} bpm vs ${num(b, 1)} usual`);
  }
  // Fatigue: workout loads fade with a half-life, compared with what your normal days look like.
  const ageOf = (e) => (dayDate(day) - dayDate(e.date)) / 86400000;
  const acts = loadEvents().filter((e) => ageOf(e) >= 0);
  const k = Math.LN2 / RD.halfLifeDays;
  const decayed = acts.filter((e) => ageOf(e) < 10).reduce((s, e) => s + e.load * Math.exp(-k * ageOf(e)), 0);
  const daily = acts.filter((e) => ageOf(e) < 28).reduce((s, e) => s + e.load, 0) / 28;
  if (daily > 0 && days.length >= 14) {
    const fr = decayed / (daily * RD.steadyLoad);
    add("load", "Recent training", 100 - (fr - 0.4) * 60, fr > 1.2 ? "Heavier than usual in the last few days" : fr < 0.7 ? "Lighter than usual in the last few days" : "About your usual recent load");
  }

  const res = { day, parts, score: null, label: "No readiness", tone: "", reason: "Not enough recovery data yet." };
  if (parts.length < RD.minParts) return res;
  const wsum = parts.reduce((s, p) => s + RD.weights[p.key], 0);
  res.score = Math.round(parts.reduce((s, p) => s + p.score * RD.weights[p.key], 0) / wsum);
  const [, label, tone] = RD.labels.find(([min]) => res.score >= min);
  Object.assign(res, { label, tone });
  const worst = [...parts].sort((a, b) => a.score - b.score)[0];
  const why = { hrv: "HRV is below your usual", sleep: "sleep has been short or poor", rhr: "resting heart rate is up", load: "recent training is still weighing on you" };
  res.reason = worst.score >= 70 ? "Recovery markers and recent load all look good." : `Held back mostly because ${why[worst.key]}.`;
  return res;
}

function readinessCard(view, day) {
  const r = readiness(day);
  const bars = r.parts.map((p) => `<div class="focus"><div class="focus-top"><span>${esc(p.label)}</span><span><b>${p.score}</b> <small class="muted">${esc(p.detail)}</small></span></div>${meter(p.score / 100)}</div>`).join("");
  section(view, `<div class="card-head"><h2>Readiness</h2></div>
    <div class="ready"><span class="ready-score">${r.score ?? "–"}</span><div>${statusBadge(r, true)}<p class="note" style="margin-top:2px">${esc(r.reason)}</p></div></div>
    <details><summary>Show details</summary>
      ${bars}
      ${DATA.hevy ? `<h3 style="margin-top:12px">Muscle freshness</h3>${rows(freshness(day).map((f) => [f.label, `<span class="status ${f.fresh ? "good" : "warning"}">${f.fresh ? "Fresh" : "Recovering"}</span> <span class="muted small">${f.text}</span>`]))}` : ""}
      <h3 style="margin-top:12px">How this is calculated</h3>
      <p class="note">A 0–100 score for how ready you are to train hard today, from four things: HRV (30%), sleep (25%), resting heart rate (15%) and how much recent training is still weighing on you (30%). Training load fades with a half-life of about a day and a half and is compared with your normal daily load.</p>
      ${DATA.hevy ? `<p class="note">Lifting counts as gym load from Hevy (hard sets × ${HV.loadPerSet}). Muscle freshness shows which muscle groups had a hard session in the last ${HV.freshDays} days.</p>` : ""}
    </details>`);
}


/* ---------- Strength (Hevy) ----------
   Garmin records lifting as "1 set, 0 reps", so exercises, sets and weights come from Hevy
   (data.hevy, added by fetch/fetch_hevy.py). Everything here is hidden when there is no Hevy data.
   Gym load is an estimate: hard sets x HV.loadPerSet (Garmin under-counts lifting). */

const HV = {
  loadPerSet: 4,                 // gym load per hard set (a 20-set session ~ 80, a hard swim ~ 150)
  hardTypes: ["normal", "failure", "dropset"],
  e1rmMaxReps: 12,               // 1-rep-max estimates are only trusted up to this many reps
  matchSlackMin: 45,             // Hevy and Garmin sessions match if they overlap within this many minutes
  trendTol: 0.02,                // a lift counts as up/down when its best estimated 1RM moves by 2%
  minLifts: 3, minSessions: 2,   // lifts needed for a trend; sessions per 4-week window per lift
  volumeTol: 0.10,
  freshHeavySets: 4,             // sets in a muscle group that make it "worked hard"
  freshDays: 2,                  // days until a worked muscle group counts as fresh again
  pairMinN: 8,                   // sessions per group before the strength-vs-swim comparison is shown
};
// Gym status thresholds (same shape as TS). `over` is higher than for cardio: weekly lifting load is lumpier (3 sessions one week, 2 the next).
const GS = {
  minDays: 28, minSessions: 6, over: 2.0, overStressed: 1.3, recovery: 0.8, detrain: 0.5, peakMax: 1.05, productiveMin: 1.0, trendCut: 0.25,
};
const MUSCLE_GROUP = { chest: "push", shoulders: "push", triceps: "push", lats: "pull", upper_back: "pull", traps: "pull", biceps: "pull", forearms: "pull",
  quadriceps: "legs", hamstrings: "legs", glutes: "legs", calves: "legs", abductors: "legs", adductors: "legs", abdominals: "core", lower_back: "core" };
const GROUPS = [["push", "Push", "--s1"], ["pull", "Pull", "--s3"], ["legs", "Legs", "--s2"], ["core", "Core", "--s4"]];

const hevyMs = (iso) => Date.parse(iso);
const hevyDate = (w) => new Intl.DateTimeFormat("en-CA", { timeZone: DATA.timezone }).format(new Date(hevyMs(w.start)));
const isHard = (s) => HV.hardTypes.includes(s.type || "normal") && (s.reps > 0 || s.kg > 0);
const hardSets = (ex) => (ex.sets || []).filter(isHard);
const setE1rm = (s) => (s.kg > 0 && s.reps > 0 && s.reps <= HV.e1rmMaxReps ? s.kg * (1 + s.reps / 30) : null);
const hevyStats = (w) => {
  let sets = 0, volume = 0, exercises = 0;
  w.exercises.forEach((ex) => { const h = hardSets(ex); if (h.length) exercises++; sets += h.length; volume += h.reduce((v, s) => v + (s.kg || 0) * (s.reps || 0), 0); });
  return { sets, volume, exercises };
};
const hevyLoad = (w) => hevyStats(w).sets * HV.loadPerSet;
const lift = (kg) => !nz(kg) ? "–" : metric() ? `${num(kg, kg % 1 ? 1 : 0)} kg` : `${num(kg * 2.20462, 0)} lb`;
const volText = (kg) => metric() ? `${num(kg / 1000, 1)} t` : `${num(kg * 2.20462)} lb`;
const exName = (ex) => DATA.hevy?.templates?.[ex.templateId]?.title || ex.title || "Exercise";

// Weighted hard sets per muscle (primary 1, secondary 0.5).
function muscleSets(w) {
  const out = {};
  w.exercises.forEach((ex) => {
    const n = hardSets(ex).length, t = DATA.hevy.templates?.[ex.templateId];
    if (!n || !t) return;
    if (t.primary) out[t.primary] = (out[t.primary] || 0) + n;
    (t.secondary || []).forEach((m) => { out[m] = (out[m] || 0) + n * 0.5; });
  });
  return out;
}
const groupSets = (w) => {
  const g = { push: 0, pull: 0, legs: 0, core: 0 };
  Object.entries(muscleSets(w)).forEach(([m, v]) => { if (MUSCLE_GROUP[m]) g[MUSCLE_GROUP[m]] += v; });
  return g;
};

// Pairs each Hevy workout with the Garmin strength session it overlaps (by time).
function linkHevy() {
  DATA.activities.forEach((a) => { delete a.hevy; });
  if (!DATA.hevy) return;
  const used = new Set();
  DATA.hevy.workouts.forEach((w) => { w.matched = false; });
  DATA.activities.filter(isStrength).forEach((a) => {
    const s = a.beginTimestamp || Date.parse(`${String(a.startTimeGMT).replace(" ", "T")}Z`), e = s + (a.duration || 0) * 1000, slack = HV.matchSlackMin * 60000;
    let best = null, bestOv = 0;
    DATA.hevy.workouts.forEach((w) => {
      if (used.has(w.id)) return;
      const ov = Math.min(e + slack, hevyMs(w.end)) - Math.max(s - slack, hevyMs(w.start));
      if (ov > bestOv) { best = w; bestOv = ov; }
    });
    if (best) { used.add(best.id); a.hevy = best; best.matched = true; }
  });
}

// Everything that counts as lifting: Garmin strength sessions plus Hevy workouts the watch missed.
function strengthEvents() {
  const ev = DATA.activities.filter(isStrength).map((a) => ({ date: actDate(a), load: effLoad(a), a, w: a.hevy || null }));
  (DATA.hevy?.workouts || []).filter((w) => !w.matched).forEach((w) => ev.push({ date: hevyDate(w), load: hevyLoad(w), a: null, w }));
  return ev.sort((x, y) => x.date.localeCompare(y.date));
}
// Everything that adds fatigue: cardio at Garmin's load, lifting at the fairer gym load.
const loadEvents = () => DATA.activities.filter((a) => !isStrength(a)).map((a) => ({ date: actDate(a), load: effLoad(a) })).concat(strengthEvents().map((e) => ({ date: e.date, load: e.load })));

// Best estimated 1RM (and heaviest set) per lift per session, oldest first.
function liftHistory() {
  const map = new Map();
  [...DATA.hevy.workouts].sort((a, b) => a.start.localeCompare(b.start)).forEach((w) => {
    w.exercises.forEach((ex) => {
      const key = ex.templateId || ex.title;
      let best = null, top = null;
      hardSets(ex).forEach((s) => {
        const e = setE1rm(s);
        if (e && (!best || e > best.e1rm)) best = { e1rm: e, kg: s.kg, reps: s.reps };
        if (s.kg > 0 && (!top || s.kg > top.kg)) top = { kg: s.kg, reps: s.reps };
      });
      if (!best) return;
      if (!map.has(key)) map.set(key, { key, name: exName(ex), points: [] });
      map.get(key).points.push({ date: hevyDate(w), e1rm: best.e1rm, kg: best.kg, reps: best.reps, top });
    });
  });
  return [...map.values()];
}

// Personal records: a session whose estimated 1RM beat everything before it.
function recentPRs(n = 8) {
  const out = [];
  liftHistory().forEach((l) => {
    let max = 0;
    l.points.forEach((p, i) => { if (i > 0 && p.e1rm > max * 1.0001) out.push({ name: l.name, ...p }); max = Math.max(max, p.e1rm); });
  });
  return out.sort((a, b) => b.date.localeCompare(a.date)).slice(0, n);
}

// Muscle groups worked hard recently: "fresh" again after HV.freshDays.
function freshness(day) {
  const last = {};
  (DATA.hevy?.workouts || []).forEach((w) => {
    const d = hevyDate(w);
    if (d > day) return;
    const g = groupSets(w);
    GROUPS.forEach(([k]) => { if (g[k] >= HV.freshHeavySets && (!last[k] || d > last[k])) last[k] = d; });
  });
  return GROUPS.map(([k, label]) => {
    const days = last[k] ? (dayDate(day) - dayDate(last[k])) / 86400000 : null;
    const fresh = days === null || days >= HV.freshDays;
    return { key: k, label, days, fresh, text: days === null ? "not trained recently" : days === 0 ? "worked hard today" : `worked hard ${num(days)} day${days === 1 ? "" : "s"} ago` };
  });
}

function gymStatus(day = latestDate()) {
  const age = (d) => (dayDate(day) - dayDate(d)) / 86400000;
  const res = { day, signals: [], trend: null, ratio: null, load7: 0, chronic: 0, sessions: 0 };
  const set = (key, label, tone, reason) => Object.assign(res, { key, label, tone, reason });
  if (!DATA.hevy) { set("none", "Needs Hevy", "", "Garmin doesn't record exercises, sets or weights. Connect Hevy to track your lifting."); return res; }

  const ev = strengthEvents().filter((e) => age(e.date) >= 0);
  const inWin = (list, get, lo, hi) => list.filter((x) => { const g = age(get(x)); return g >= lo && g < hi; });
  const loadSum = (lo, hi) => inWin(ev, (e) => e.date, lo, hi).reduce((s, e) => s + e.load, 0);
  res.load7 = loadSum(0, 7); res.chronic = loadSum(0, 28) / 4;
  res.ratio = res.chronic > 0 ? res.load7 / res.chronic : null;
  const prevRatio = res.chronic > 0 ? loadSum(7, 14) / res.chronic : null;
  res.sessions = inWin(ev, (e) => e.date, 0, 28).length;
  const firstDate = DATA.hevy.workouts.map(hevyDate).sort()[0];
  const spanDays = firstDate ? age(firstDate) : 0;

  // Lifts: best estimated 1RM, last 28 days vs the 28 before.
  const hist = liftHistory().map((l) => ({ ...l, points: l.points.filter((p) => age(p.date) >= 0) }));
  const changes = [];
  hist.forEach((l) => {
    const cur = inWin(l.points, (p) => p.date, 0, 28), prev = inWin(l.points, (p) => p.date, 28, 56);
    if (cur.length >= HV.minSessions && prev.length >= HV.minSessions)
      changes.push({ name: l.name, cur: Math.max(...cur.map((p) => p.e1rm)), prev: Math.max(...prev.map((p) => p.e1rm)) });
  });
  res.lifts = changes;
  const add = (key, label, weight, verdict, detail) => res.signals.push({ key, label, weight, verdict, detail });
  if (changes.length >= HV.minLifts) {
    const up = changes.filter((c) => judge(c.cur, c.prev, HV.trendTol) === "up").length, down = changes.filter((c) => judge(c.cur, c.prev, HV.trendTol) === "down").length;
    const sc = (up - down) / changes.length;
    add("lifts", "Lift progress", 2, sc > GS.trendCut ? "up" : sc < -GS.trendCut ? "down" : "flat",
      `${up} of ${changes.length} main lifts up, ${down} down (best 1RM, last 4 weeks vs the 4 before)`);
  }
  const setsIn = (lo, hi) => inWin(ev, (e) => e.date, lo, hi).reduce((s, e) => s + (e.w ? hevyStats(e.w).sets : 0), 0);
  const s1 = setsIn(0, 28), s0 = setsIn(28, 56);
  if (s0 > 0) add("volume", "Weekly hard sets", 1, judge(s1, s0, HV.volumeTol), `${num(s1 / 4, 1)} per week now vs ${num(s0 / 4, 1)} before`);
  if (res.signals.length >= 2 || (res.signals.length === 1 && res.signals[0].key === "lifts")) {
    const W = res.signals.reduce((s, x) => s + x.weight, 0);
    const score = res.signals.reduce((s, x) => s + x.weight * (x.verdict === "up" ? 1 : x.verdict === "down" ? -1 : 0), 0) / W;
    res.trend = score > GS.trendCut ? "up" : score < -GS.trendCut ? "down" : "flat";
  }

  const r = res.ratio, liftsDown = res.signals.some((s) => s.key === "lifts" && s.verdict === "down");
  const trendText = { up: "your lifts are going up", down: "your lifts are slipping", flat: "your lifts are steady" }[res.trend] || "";
  if (spanDays < GS.minDays || res.sessions < GS.minSessions || r === null)
    set("none", "No status", "", `Needs at least ${GS.minDays} days of logged lifting and ${GS.minSessions} sessions in the last 4 weeks.`);
  else if (r > GS.over || (r > GS.overStressed && liftsDown))
    set("overreaching", "Overreaching", "critical", `This week's lifting load is ${num(r, 2)}× your 4-week average${liftsDown ? " and lifts are dropping" : ""}. Consider a lighter week.`);
  else if (r < GS.detrain || (r < GS.recovery && prevRatio !== null && prevRatio < GS.recovery))
    set("detraining", "Detraining", "warning", `Lifting has been well below your usual for a while (${num(r, 2)}× your 4-week average). Strength fades first.`);
  else if (r < GS.recovery)
    set("recovery", "Recovery", "", `A lighter lifting week (${num(r, 2)}× your 4-week average), good for absorbing the work.`);
  else if (res.trend === null)
    set("none", "No status", "", "Not enough repeated lifts yet to judge progress. Keep logging the same exercises.");
  else if (res.trend === "down")
    set("unproductive", "Unproductive", "warning", `Lifting load is normal (${num(r, 2)}×) but ${trendText}. Check sleep, food and recovery.`);
  else if (res.trend === "up" && r <= GS.peakMax)
    set("peaking", "Peaking", "good", `Lifting load is easy to moderate (${num(r, 2)}×) and ${trendText}. A good time to test strength.`);
  else if (res.trend === "up" && r >= GS.productiveMin)
    set("productive", "Productive", "good", `Lifting load is solid (${num(r, 2)}×) and ${trendText}. Keep going.`);
  else set("maintaining", "Maintaining", "", `Lifting load is in your normal range (${num(r, 2)}×) and ${trendText}.`);
  return res;
}

// Day-after comparisons: lifting vs not, and heavy legs vs not.
function strengthSwimLink() {
  const ev = strengthEvents();
  const lifted = new Set(ev.map((e) => e.date));
  const heavyLegs = new Set(ev.filter((e) => e.w && groupSets(e.w).legs >= HV.freshHeavySets + 2).map((e) => e.date));
  const prevDay = (d) => addDays(d, -1);
  const sets = [];
  const split = (items, pick, inSet, label, fmt, lowerBetter) => {
    const a = items.filter((x) => inSet.has(prevDay(x.date))).map(pick).filter(nz), b = items.filter((x) => !inSet.has(prevDay(x.date))).map(pick).filter(nz);
    sets.push({ label, a, b, fmt, lowerBetter });
  };
  const hrvDays = DATA.days.filter((d) => d.hrv && nz(d.hrv.avg)), rhrDays = DATA.days.filter((d) => nz(d.rhr));
  const swims = DATA.activities.filter((a) => isSwim(a) && a.distance >= TS.swimMinDist && a.averageHR && (a.movingDuration || a.duration))
    .map((a) => ({ date: actDate(a), e: a.distance / ((a.movingDuration || a.duration) / 60) / a.averageHR }));
  const [hl, ll] = [["after lifting", "after other days", lifted], ["after heavy leg days", "after other days", heavyLegs]];
  [hl, ll].forEach(([an, bn, inSet]) => {
    split(hrvDays, (d) => d.hrv.avg, inSet, `HRV, ${an}`, (v) => `${num(v)} ms`, false);
    split(rhrDays, (d) => d.rhr, inSet, `Resting HR, ${an}`, (v) => `${num(v, 1)} bpm`, true);
    split(swims, (s) => s.e, inSet, `Swim efficiency, ${an}`, (v) => num(v, 3), false);
  });
  return sets.map((s) => ({ ...s, ok: s.a.length >= HV.pairMinN && s.b.length >= HV.pairMinN, ma: avg(s.a), mb: avg(s.b) }));
}

// ----- UI -----

function hevyTitle(label) { return `<div class="card-head"><h2>${label}</h2>${DATA.demo ? `<span class="muted small">Demo data</span>` : ""}</div>`; }

function gymCard(view, day) {
  const g = gymStatus(day);
  section(view, `${hevyTitle("Gym status")}${statusBadge(g, true)}<p class="note">${esc(g.reason)}</p>`);
}

function gymDetail(view) {
  const g = gymStatus();
  const arrow = { up: "Improving ↑", down: "Slipping ↓", flat: "Steady →" };
  const lifts = (g.lifts || []).map((c) => [c.name, `${lift(c.cur)} <span class="muted small">1RM now vs ${lift(c.prev)}</span>`]);
  section(view, `${hevyTitle("Gym status")}${statusBadge(g, true)}<p class="note">${esc(g.reason)}</p>
    <div class="tiles" style="margin-top:12px">
      ${tile("This week's load", num(g.load7), "last 7 days")}
      ${tile("4-week average", num(g.chronic), "per week")}
      <div style="grid-column:1/-1">${tile("Load ratio", g.ratio === null ? "–" : `${num(g.ratio, 2)}×`, "0.8–1.5× is the normal range", meter((g.ratio || 0) / 2))}</div>
    </div>
    <details><summary>Show strength signals</summary>
      ${g.signals.length ? rows(g.signals.map((s) => [s.label, `${arrow[s.verdict]}<br><span class="muted small">${esc(s.detail)}</span>`])) : `<p class="empty">Not enough data yet.</p>`}
      ${lifts.length ? `<h3 style="margin-top:12px">Main lifts</h3>${rows(lifts)}` : ""}
    </details>
    <details><summary>How this is calculated</summary>
      <p class="note">Gym load is hard sets (warm-ups excluded) × ${HV.loadPerSet}. The ratio compares the last 7 days with your 4-week weekly average. Progress compares the best 1-rep max (weight × (1 + reps ÷ 30), sets of ${HV.e1rmMaxReps} reps or fewer) on each lift over the last 4 weeks with the 4 before; lifts count double and weekly hard sets count once.</p>
      <p class="note">It is judged separately from aerobic status: your swimming can improve while your lifts don't, and the reverse.</p>
    </details>`);
}

function renderStrength(view) {
  gymDetail(view);
  const ev = strengthEvents();
  const mon = mondayOf(localToday());
  const week = ev.filter((e) => e.date >= mon && e.w), sums = week.reduce((s, e) => { const t = hevyStats(e.w); return { n: s.n + 1, sets: s.sets + t.sets, vol: s.vol + t.volume }; }, { n: 0, sets: 0, vol: 0 });
  section(view, [
    tile("This week", `${num(sums.n)}<small> sessions</small>`, `${num(sums.sets)} hard sets`),
    tile("Volume this week", volText(sums.vol), "weight × reps, warm-ups excluded"),
  ].join(""), "tiles");

  // Muscle balance, last 28 days
  const cut = addDays(localToday(), -27), totals = {}, grp = { push: 0, pull: 0, legs: 0, core: 0 };
  DATA.hevy.workouts.filter((w) => hevyDate(w) >= cut).forEach((w) => {
    Object.entries(muscleSets(w)).forEach(([m, v]) => { totals[m] = (totals[m] || 0) + v; });
    Object.entries(groupSets(w)).forEach(([k, v]) => { grp[k] += v; });
  });
  const top = Object.entries(totals).sort((a, b) => b[1] - a[1]), mx = top.length ? top[0][1] : 1;
  const bal = section(view, `<div class="card-head"><h2>Muscle balance</h2><span class="muted small">last 4 weeks · sets per week</span></div>
    ${stackBar(GROUPS.map(([k, label, c]) => ({ label, value: grp[k], color: css(c), text: `${num(grp[k] / 4, 1)}/wk` })))}
    ${top.length ? top.map(([m, v]) => `<div class="focus"><div class="focus-top"><span>${esc(humanize(m))}</span><b>${num(v / 4, 1)}</b></div>${meter(v / mx)}</div>`).join("") : `<p class="empty">No lifting in the last 4 weeks.</p>`}
    <p class="note">Main muscle counts as a full set, helper muscles as half. A big gap between push and pull, or legs far behind, is worth a look.</p>`);

  // Progress per lift
  const hist = liftHistory().filter((l) => l.points.length >= 2).sort((a, b) => b.points.length - a.points.length).slice(0, 8);
  if (hist.length) {
    if (!hist.some((l) => l.key === state.lift)) state.lift = hist[0].key;
    const cur = hist.find((l) => l.key === state.lift);
    const chips = section(view, hist.map((l) => `<button class="chip ${l.key === state.lift ? "active" : ""}" data-lift="${esc(l.key)}">${esc(l.name)}</button>`).join(""), "chips");
    chips.querySelectorAll(".chip").forEach((b) => b.onclick = () => { state.lift = b.dataset.lift; render(); });
    const best = Math.max(...cur.points.map((p) => p.e1rm));
    chartCard(view, `${cur.name} · 1RM`, {
      type: "line", labels: cur.points.map((p) => fmtDay(p.date, { day: "numeric", month: "short" })), xName: "Session",
      tipLabels: cur.points.map((p) => `${fmtDay(p.date)} · best set ${lift(p.kg)} × ${p.reps}`),
      series: [{ name: "1RM", color: css("--s1"), values: cur.points.map((p) => (metric() ? p.e1rm : p.e1rm * 2.20462)) }],
      yFmt: (v) => `${num(v)} ${metric() ? "kg" : "lb"}`, headRight: `<span class="muted small">best ${lift(best)}</span>`, dots: cur.points.length < 40,
    }, "One-rep max (1RM) from your best set each session. Going up = getting stronger.");
  }

  const prs = recentPRs();
  section(view, `<h2>Recent personal records</h2>${prs.length ? rows(prs.map((p) => [p.name, `${lift(p.kg)} × ${p.reps} <span class="muted small">1RM ${lift(p.e1rm)} · ${esc(fmtDay(p.date))}</span>`])) : `<p class="empty">No new records yet.</p>`}`);

  // Lifting vs swimming and recovery
  const link = strengthSwimLink();
  const items = link.map((s) => s.ok
    ? [s.label, `${s.fmt(s.ma)} vs ${s.fmt(s.mb)} <span class="muted small">${s.ma === s.mb ? "same" : `${Math.abs(((s.ma - s.mb) / s.mb) * 100).toFixed(1)}% ${(s.ma > s.mb) === !s.lowerBetter ? "better" : "worse"}`} · ${s.a.length} vs ${s.b.length}</span>`]
    : [s.label, `<span class="muted small">needs more data: ${s.a.length} vs ${s.b.length}, need ${HV.pairMinN}+ in each</span>`]);
  section(view, `<h2>Lifting, recovery and swimming</h2>${rows(items)}
    <p class="note">Compares the day after lifting with the day after other days.</p>`);
}

// Rough healthy shares of 28-day load. A guide only, not Garmin's targets.
const FOCUS_TARGETS = [
  { key: "low", label: "Low aerobic", lo: 0.4, hi: 0.7, colorVar: "--s3" },
  { key: "high", label: "High aerobic", lo: 0.25, hi: 0.5, colorVar: "--s1" },
  { key: "an", label: "Anaerobic", lo: 0.05, hi: 0.2, colorVar: "--s2" },
];

function statusBadge(ts, big = false) {
  return `<span class="status ${ts.tone}${big ? " ts-big" : ""}">${esc(ts.label)}</span>`;
}

// Small card for the Today tab.
function statusCard(view, day) {
  const ts = trainingStatus(day);
  section(view, `<div class="card-head"><h2>Aerobic status</h2><span class="muted small">All cardio</span></div>
    ${statusBadge(ts, true)}<p class="note">${esc(ts.reason)}</p>`);
}

// Detailed card for the Fitness tab.
function statusDetail(view) {
  const ts = trainingStatus();
  const arrow = { up: "Improving ↑", down: "Slipping ↓", flat: "Steady →" };
  const f = ts.focus;
  const focusRows = f.total > 0 ? FOCUS_TARGETS.map((t) => {
    const share = f[t.key] / f.total;
    const where = share < t.lo ? "below the usual range" : share > t.hi ? "above the usual range" : "in the usual range";
    return `<div class="focus"><div class="focus-top"><span>${t.label}</span><span><b>${num(f[t.key])}</b> · ${num(share * 100)}% <small class="muted">${where} (${num(t.lo * 100)}–${num(t.hi * 100)}%)</small></span></div>
      <div class="meter"><span style="width:${Math.min(100, share * 100)}%;background:${css(t.colorVar)}"></span></div></div>`;
  }).join("") : `<p class="empty">No workouts in the last 28 days.</p>`;
  const sigRows = ts.signals.length
    ? rows(ts.signals.map((s) => [s.label, `${arrow[s.verdict]}<br><span class="muted small">${esc(s.detail)}</span>`]))
    : `<p class="empty">Not enough data yet.</p>`;
  const swimSig = ts.signals.some((s) => s.key === "swimVo2");
  const byType = {};
  DATA.activities.filter((a) => !isStrength(a) && (dayDate(ts.day) - dayDate(actDate(a))) / 86400000 >= 0 && (dayDate(ts.day) - dayDate(actDate(a))) / 86400000 < 28)
    .forEach((a) => { byType[a.type] = (byType[a.type] || 0) + (a.activityTrainingLoad || 0); });
  const palette = [css("--s1"), css("--s2"), css("--s3"), css("--s4"), css("--o3"), css("--o1")];
  const typeParts = Object.entries(byType).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1])
    .map(([t, v], i) => ({ label: humanize(t), value: v, color: palette[i % palette.length], text: num(v) }));
  section(view, `<div class="card-head"><h2>Aerobic status</h2><span class="muted small">All cardio</span></div>
    ${statusBadge(ts, true)}<p class="note">${esc(ts.reason)}</p>
    <div class="tiles" style="margin-top:12px">
      ${tile("This week's load", num(ts.load7), `last 7 days · <b>${num(ts.totalLoad7)}</b> with lifting`)}
      ${tile("4-week average", num(ts.chronic), `per week · <b>${num(ts.totalChronic)}</b> with lifting`)}
      <div style="grid-column:1/-1">${tile("Load ratio", ts.ratio === null ? "–" : `${num(ts.ratio, 2)}×`, "0.8–1.5× is the normal range", meter((ts.ratio || 0) / 2))}</div>
    </div>
    <details><summary>Show fitness signals</summary>
      ${sigRows}
      ${swimSig ? "" : `<p class="note">Swim VO2 max needs at least ${VO.minN} swims of ${dist(VO.swimMinDist)}+ in the same pool in each of the last two 4-week periods.</p>`}
    </details>
    <h3 style="margin-top:14px">Load by activity · last 28 days</h3>${typeParts.length ? stackBar(typeParts) : `<p class="empty">No cardio in the last 28 days.</p>`}
    <h3 style="margin-top:14px">Load focus · last 28 days</h3>${focusRows}
    <details><summary>How this is calculated</summary>
      <p class="note">Covers all cardio: swimming, running, cycling, walking and any other activity that isn't lifting. Lifting is judged separately so one can't hide the other. The "with lifting" figures add every activity, as Garmin's acute and chronic load do.</p>
      <p class="note"><b>Load</b> is Garmin's training load for every workout. The ratio compares the last 7 days with your 4-week weekly average. Very high is Overreaching, very low is Recovery or Detraining.</p>
      <p class="note"><b>Fitness trend</b> compares the last 4 weeks with the 4 weeks before. Swimming leads: swim VO2 max (swim speed per fraction of heart-rate reserve, swims over ${dist(VO.swimMinDist)}, same pool only) counts double, then SWOLF scaled to a 25 m pool, resting heart rate, HRV and running VO2 max. Improving signals give Productive or Peaking; slipping ones give Unproductive.</p>
      <p class="note"><b>Load focus</b> splits load by heart-rate zone (zones 1–2 low aerobic, 3–4 high aerobic) and by anaerobic training effect (counted at half weight).</p>
    </details>`);
}

/* ---------- Charts (SVG) ---------- */

const NS = "http://www.w3.org/2000/svg";
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function niceTicks(min, max, count = 4) {
  if (min === max) { max = min + 1; min = Math.max(0, min - 1); }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(6));
  return ticks;
}
const compact = (v) => Math.abs(v) >= 1000 ? `${+(v / 1000).toFixed(1)}K` : `${+v.toFixed(1)}`;

/**
 * chart(el, cfg) draws a line, bar or stacked-bar chart with a hover tooltip.
 * cfg: { type, labels[], tipLabels[], x[] (optional numeric x), series:[{name, color, values[]}],
 *        yFmt(v), band:{lo[],hi[]}, yMin, height, connect, endLabel }
 */
function chart(el, cfg) {
  el.classList.add("chart");
  const draw = () => {
    const W = el.clientWidth || 300, H = cfg.height || 170;
    const endLabel = cfg.endLabel ?? cfg.series.length === 1; // two-line charts rely on legend + tooltip
    const padL = 34, padR = cfg.type === "line" && endLabel ? 30 : 6, padT = 10, padB = 22;
    const pw = W - padL - padR, ph = H - padT - padB;
    const n = cfg.labels.length;
    const stacked = cfg.type === "stack";
    const all = [];
    for (let i = 0; i < n; i++) {
      if (stacked) all.push(cfg.series.reduce((a, s) => a + (s.values[i] || 0), 0));
      else cfg.series.forEach((s) => nz(s.values[i]) && all.push(s.values[i]));
      if (cfg.band) [cfg.band.lo[i], cfg.band.hi[i]].forEach((v) => nz(v) && all.push(v));
    }
    if (!all.length) { el.innerHTML = `<p class="empty">No data for this period.</p>`; return; }
    let lo = cfg.type === "line" ? Math.min(...all) : 0, hi = Math.max(...all);
    if (cfg.yMin !== undefined) lo = Math.min(cfg.yMin, lo);
    if (cfg.type === "line") { const padV = (hi - lo) * 0.1 || 1; lo = Math.max(cfg.yMin ?? -Infinity, lo - padV); hi += padV; }
    if (cfg.yMax !== undefined) hi = Math.min(hi, cfg.yMax);
    const ticks = niceTicks(lo, hi);
    const y0 = ticks[0], y1 = ticks[ticks.length - 1];
    const Y = (v) => padT + ph - ((v - y0) / (y1 - y0)) * ph;
    const band = pw / Math.max(n, 1);
    let X;
    if (cfg.x) {
      const xmin = cfg.x[0], xmax = cfg.x[n - 1];
      X = (i) => padL + (xmax === xmin ? pw / 2 : ((cfg.x[i] - xmin) / (xmax - xmin)) * pw);
    } else if (cfg.type === "line") X = (i) => padL + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
    else X = (i) => padL + band * (i + 0.5);

    let s = `<svg xmlns="${NS}" viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${esc(cfg.title || "chart")}">`;
    s += `<g class="grid">${ticks.map((t) => `<line x1="${padL}" x2="${W - padR}" y1="${Y(t)}" y2="${Y(t)}"/>`).join("")}</g>`;
    s += ticks.map((t) => `<text class="axis-text" x="${padL - 6}" y="${Y(t) + 4}" text-anchor="end">${esc((cfg.axisFmt || compact)(t))}</text>`).join("");
    // x labels: about 5, evenly spaced
    const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 64))));
    for (let i = 0; i < n; i += step) {
      s += `<text class="axis-text" x="${X(i)}" y="${H - 5}" text-anchor="middle">${esc(cfg.labels[i])}</text>`;
    }
    if (cfg.band) {
      let top = "", bot = "";
      for (let i = 0; i < n; i++) if (nz(cfg.band.hi[i]) && nz(cfg.band.lo[i])) { top += `${top ? "L" : "M"}${X(i)},${Y(cfg.band.hi[i])}`; bot = `L${X(i)},${Y(cfg.band.lo[i])}` + bot; }
      if (top) s += `<path class="band" d="${top}${bot}Z"/>`;
    }
    const bw = Math.max(1.5, Math.min(24, band * 0.72));
    const rTop = (x, y, w, h, r) => { r = Math.min(r, h, w / 2); return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`; };
    if (cfg.type === "bar") {
      const sr = cfg.series[0];
      for (let i = 0; i < n; i++) {
        const v = sr.values[i]; if (!nz(v) || v <= 0) continue;
        const y = Y(v), h = Y(y0) - y;
        s += `<path d="${rTop(X(i) - bw / 2, y, bw, h, 4)}" fill="${sr.color}"/>`;
      }
      if (cfg.goal) s += `<line x1="${padL}" x2="${W - padR}" y1="${Y(cfg.goal)}" y2="${Y(cfg.goal)}" stroke="${css("--axis")}" stroke-width="1"/>`;
    } else if (stacked) {
      for (let i = 0; i < n; i++) {
        let acc = 0;
        const segs = cfg.series.map((sr) => sr.values[i] || 0);
        const last = segs.map((v) => v > 0).lastIndexOf(true);
        segs.forEach((v, k) => {
          if (v <= 0) return;
          const yTop = Y(acc + v), yBot = Y(acc); acc += v;
          const h = Math.max(0, yBot - yTop - (k === last ? 0 : 2)); // 2px surface gap between segments
          const y = yTop + (k === last ? 0 : 2);
          s += k === last ? `<path d="${rTop(X(i) - bw / 2, yTop, bw, yBot - yTop, 4)}" fill="${cfg.series[k].color}"/>`
            : `<rect x="${X(i) - bw / 2}" y="${y}" width="${bw}" height="${h}" fill="${cfg.series[k].color}"/>`;
        });
      }
    } else {
      cfg.series.forEach((sr) => {
        let d = "", pen = false, lastI = -1;
        for (let i = 0; i < n; i++) {
          const v = sr.values[i];
          if (!nz(v)) { if (!cfg.connect) pen = false; continue; }
          d += `${pen ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; pen = true; lastI = i;
        }
        s += `<path class="line" d="${d}" stroke="${sr.color}"/>`;
        const pts = sr.values.filter(nz).length;
        if (pts && pts <= 2 || cfg.dots) sr.values.forEach((v, i) => { if (nz(v)) s += `<circle class="dot" cx="${X(i)}" cy="${Y(v)}" r="4" fill="${sr.color}"/>`; });
        if (lastI >= 0) {
          s += `<circle class="dot" cx="${X(lastI)}" cy="${Y(sr.values[lastI])}" r="4" fill="${sr.color}"/>`;
          if (endLabel) s += `<text class="end-label" x="${X(lastI) + 7}" y="${Y(sr.values[lastI]) + 4}">${esc((cfg.axisFmt || compact)(sr.values[lastI]))}</text>`;
        }
      });
    }
    s += `<line class="cross" x1="0" x2="0" y1="${padT}" y2="${padT + ph}" visibility="hidden"/>`;
    s += `<g class="hover-dots"></g><rect x="${padL}" y="0" width="${pw}" height="${H}" fill="transparent" class="hit"/>`;
    s += `</svg>`;
    el.innerHTML = s;

    // Hover / touch tooltip
    const svg = el.querySelector("svg"), cross = svg.querySelector(".cross"), hd = svg.querySelector(".hover-dots");
    const tip = $("#tooltip");
    const show = (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = (ev.clientX - rect.left) * (W / rect.width);
      let best = 0, bd = Infinity;
      for (let i = 0; i < n; i++) { const d = Math.abs(X(i) - px); if (d < bd) { bd = d; best = i; } }
      const vals = cfg.series.map((sr) => ({ sr, v: sr.values[best] }));
      if (!vals.some((o) => nz(o.v))) return hide();
      cross.setAttribute("x1", X(best)); cross.setAttribute("x2", X(best)); cross.setAttribute("visibility", "visible");
      hd.innerHTML = cfg.type === "line" ? vals.filter((o) => nz(o.v)).map((o) => `<circle class="dot" cx="${X(best)}" cy="${Y(o.v)}" r="5" fill="${o.sr.color}"/>`).join("") : "";
      const fmt = cfg.yFmt || ((v) => num(v));
      let html = `<div class="t-head">${esc((cfg.tipLabels || cfg.labels)[best])}</div>`;
      html += vals.map((o) => `<div class="t-row"><i style="background:${o.sr.color}"></i>${cfg.series.length > 1 ? esc(o.sr.name) + ": " : ""}<b>${nz(o.v) ? fmt(o.v) : "–"}</b></div>`).join("");
      if (stacked) html += `<div class="t-row">Total: <b>${fmt(vals.reduce((a, o) => a + (o.v || 0), 0))}</b></div>`;
      if (cfg.band && nz(cfg.band.lo[best])) html += `<div class="t-row muted">Normal range: ${fmt(cfg.band.lo[best])}–${fmt(cfg.band.hi[best])}</div>`;
      tip.innerHTML = html; tip.hidden = false;
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let left = ev.clientX + 12; if (left + tw > innerWidth - 8) left = ev.clientX - tw - 12;
      tip.style.left = `${Math.max(8, left)}px`;
      tip.style.top = `${Math.max(8, rect.top + 4 - th)}px`;
    };
    const hide = () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); hd.innerHTML = ""; };
    const hit = svg.querySelector(".hit");
    hit.addEventListener("pointermove", show);
    hit.addEventListener("pointerdown", show);
    hit.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hide(); });
    el._hide = hide;
  };
  draw();
  el._lastW = el.clientWidth;
  if (!el._ro) {
    el._ro = new ResizeObserver(() => { if (el.clientWidth !== el._lastW) { el._lastW = el.clientWidth; draw(); } });
    el._ro.observe(el);
  }
}
document.addEventListener("pointerdown", (e) => { if (!e.target.closest(".chart")) $("#tooltip").hidden = true; });
addEventListener("scroll", () => { $("#tooltip").hidden = true; }, { passive: true });

function tableView(cfg) {
  const fmt = cfg.yFmt || ((v) => num(v));
  const head = `<tr><th>${esc(cfg.xName || "Date")}</th>${cfg.series.map((s) => `<th>${esc(s.name)}</th>`).join("")}</tr>`;
  const body = cfg.labels.map((_, i) => i).reverse()
    .filter((i) => cfg.series.some((s) => nz(s.values[i])))
    .map((i) => `<tr><td>${esc((cfg.tipLabels || cfg.labels)[i])}</td>${cfg.series.map((s) => `<td>${nz(s.values[i]) ? fmt(s.values[i]) : "–"}</td>`).join("")}</tr>`).join("");
  return `<details><summary>Show numbers</summary><div class="table-wrap"><table>${head}${body}</table></div></details>`;
}

// Card with a chart (and a table of the numbers underneath).
function chartCard(container, title, cfg, note = "") {
  const card = document.createElement("section");
  card.className = "card";
  const legend = cfg.series.length > 1
    ? `<div class="legend" style="margin-bottom:6px">${cfg.series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>` : "";
  card.innerHTML = `<div class="card-head"><h2>${esc(title)}</h2>${cfg.headRight || ""}</div>${legend}<div class="chart-box"></div>${note ? `<p class="note">${note}</p>` : ""}${cfg.noTable ? "" : tableView(cfg)}`;
  container.appendChild(card);
  chart(card.querySelector(".chart-box"), { ...cfg, title });
  return card;
}

/* ---------- Activities ---------- */

const ACT_ICON = { running: "🏃", trail_running: "🏃", treadmill_running: "🏃", walking: "🚶", hiking: "🥾",
  cycling: "🚴", road_biking: "🚴", mountain_biking: "🚵", indoor_cycling: "🚴", lap_swimming: "🏊", open_water_swimming: "🏊",
  strength_training: "🏋️", yoga: "🧘", cardio: "❤️", hiit: "🔥", rowing: "🚣", indoor_rowing: "🚣",
  cross_country_skiing: "⛷️", resort_skiing: "⛷️", elliptical: "⚙️", stair_climbing: "🪜" };
const isSwim = (a) => /swim/.test(a.type);
const isRun = (a) => /run|walk|hik/.test(a.type);
const isRide = (a) => /cycl|bik|ride/.test(a.type);
// Swims count the whole session, rests included (elapsed time), not just time spent swimming.
const actTime = (a) => (isSwim(a) ? a.elapsedDuration || a.duration : a.duration) || 0;

function swimPace(mps) { // per 100 m (or 100 yd)
  const per = metric() ? 100 : 91.44;
  return nz(mps) && mps > 0 ? `${dur(per / mps, "clock")} ${metric() ? "/100 m" : "/100 yd"}` : "–";
}

function actSpeed(a) {
  if (isSwim(a)) return swimPace(a.averageSpeed);
  if (isRide(a)) return speed(a.averageSpeed);
  if (a.distance > 0) return `${pace(a.averageSpeed)} ${paceUnit()}`;
  return null;
}

function actSummary(a) {
  const st = [];
  if (a.distance > 0) st.push(["", dist(a.distance)]);
  st.push(["", dur(actTime(a), "clock")]);
  const sp = actSpeed(a); if (sp) st.push(["", sp]);
  if (a.hevy) {
    const h = hevyStats(a.hevy);
    st.push(["", `${num(h.exercises)} exercises`], ["Sets", num(h.sets)], ["", volText(h.volume)]);
  } else {
    if (a.totalSets) st.push(["Sets", num(a.activeSets ?? a.totalSets)]);
    if (a.totalReps) st.push(["Reps", num(a.totalReps)]);
  }
  if (a.averageHR) st.push(["♥", `${num(a.averageHR)} bpm`]);
  if (a.trainingEffectLabel) st.push(["", humanize(a.trainingEffectLabel)]);
  return st.map(([k, v]) => `<span>${k ? esc(k) + " " : ""}<b>${esc(v)}</b></span>`).join("");
}

function actItem(a) {
  const when = `${fmtDay(a.startTimeLocal.slice(0, 10))} · ${clockStr(a.startTimeLocal)}`;
  return `<button class="act" data-act="${a.activityId}">
    <span class="act-icon" aria-hidden="true">${ACT_ICON[a.type] || "⏱️"}</span>
    <span><span class="act-name">${esc(a.activityName || humanize(a.type))}</span>
    <span class="act-meta"> · ${esc(humanize(a.type))}</span>
    <div class="act-meta">${esc(when)}${a.locationName ? " · " + esc(a.locationName) : ""}</div>
    <div class="act-stats">${actSummary(a)}</div></span></button>`;
}

function actList(list, empty = "No activities.") {
  return list.length ? list.map(actItem).join("") : `<p class="empty">${empty}</p>`;
}

const HR_COLORS = () => ["--o1", "--o2", "--o3", "--o4", "--o5"].map(css);
function zones(a, prefix, label) {
  const vals = [1, 2, 3, 4, 5].map((z) => a[`${prefix}${z}`] || 0);
  if (!vals.some((v) => v > 0)) return "";
  const c = HR_COLORS();
  return `<h3 style="margin-top:10px">${label}</h3>` + stackBar(vals.map((v, i) => ({ label: `Zone ${i + 1}`, value: v, color: c[i], text: dur(v, "clock") })));
}

const KNOWN = new Set(["activityId", "activityName", "type", "startTimeLocal", "startTimeGMT", "endTimeGMT", "beginTimestamp",
  "sportTypeId", "eventType", "exerciseSets", "manufacturer", "isFavorite", "favorite", "hasImages", "hasVideo", "isParent", "parent",
  "isAutoCalcCalories", "autoCalcCalories", "isElevationCorrected", "elevationCorrected", "isDecoDive", "decoDive", "qualifyingDive",
  "isManualActivity", "manualActivity", "isPR", "pr", "deviceId", "unitOfPoolLength"]);

function openActivity(id) {
  const a = DATA.activities.find((x) => String(x.activityId) === String(id));
  if (!a) return;
  const used = new Set(KNOWN);
  const u = (...keys) => { keys.forEach((k) => used.add(k)); };
  const sec = (title, list) => { const r = rows(list); return r.includes("No data.") ? "" : `<section class="card"><h2>${esc(title)}</h2>${r}</section>`; };

  // Calories, intensity minutes, Body Battery etc. are left to "All other fields" at the bottom.
  u("duration", "movingDuration", "elapsedDuration", "distance", "averageSpeed", "maxSpeed", "avgGradeAdjustedSpeed", "steps", "lapCount", "locationName");
  let html = sec("Overview", [
    ["Date", `${fmtDay(a.startTimeLocal.slice(0, 10), { weekday: "long", day: "numeric", month: "long", year: "numeric" })}`],
    ["Start", clockStr(a.startTimeLocal)],
    ["Location", a.locationName ? esc(a.locationName) : null],
    ["Distance", a.distance > 0 ? dist(a.distance) : null],
    ...(isSwim(a) ? [
      ["Total time", dur(actTime(a), "clock")],
      ["Swim time", a.movingDuration ? dur(a.movingDuration, "clock") : null],
      ["Rest time", a.movingDuration ? dur(Math.max(0, actTime(a) - a.movingDuration), "clock") : null],
    ] : [
      ["Time", dur(a.duration, "clock")],
      ["Moving time", a.movingDuration && Math.abs(a.movingDuration - a.duration) > 5 ? dur(a.movingDuration, "clock") : null],
      ["Elapsed time", a.elapsedDuration && Math.abs(a.elapsedDuration - a.duration) > 5 ? dur(a.elapsedDuration, "clock") : null],
    ]),
    [isRide(a) ? "Avg speed" : isSwim(a) ? "Avg pace (while swimming)" : "Avg pace", actSpeed(a)],
    [isRide(a) ? "Max speed" : "Best pace", a.maxSpeed && a.distance > 0 && !isSwim(a) ? (isRide(a) ? speed(a.maxSpeed) : `${pace(a.maxSpeed)} ${paceUnit()}`) : null],
    ["Grade adjusted pace", a.avgGradeAdjustedSpeed && isRun(a) ? `${pace(a.avgGradeAdjustedSpeed)} ${paceUnit()}` : null],
    ["Steps", a.steps ? num(a.steps) : null],
    ["Laps", a.lapCount ? num(a.lapCount) : null],
  ]);

  u("averageHR", "maxHR", "minHR");
  for (let z = 1; z <= 5; z++) u(`hrTimeInZone_${z}`, `powerTimeInZone_${z}`);
  if (a.averageHR || a.maxHR) html += `<section class="card"><h2>Heart rate</h2>${rows([["Average", a.averageHR ? `${num(a.averageHR)} bpm` : null], ["Max", a.maxHR ? `${num(a.maxHR)} bpm` : null]])}${zones(a, "hrTimeInZone_", "Time in heart rate zones")}</section>`;

  u("aerobicTrainingEffect", "anaerobicTrainingEffect", "aerobicTrainingEffectMessage", "anaerobicTrainingEffectMessage", "trainingEffectLabel", "activityTrainingLoad");
  html += sec("Training effect", [
    ["Primary benefit", a.trainingEffectLabel ? esc(humanize(a.trainingEffectLabel)) : null],
    ["Aerobic", nz(a.aerobicTrainingEffect) ? `${num(a.aerobicTrainingEffect, 1)} <span class="muted">${esc(humanize(a.aerobicTrainingEffectMessage))}</span>` : null],
    ["Anaerobic", nz(a.anaerobicTrainingEffect) ? `${num(a.anaerobicTrainingEffect, 1)} <span class="muted">${esc(humanize(a.anaerobicTrainingEffectMessage))}</span>` : null],
    ["Training load", nz(a.activityTrainingLoad) ? num(a.activityTrainingLoad) : null],
  ]);

  u("averageRunningCadenceInStepsPerMinute", "maxRunningCadenceInStepsPerMinute", "maxDoubleCadence", "avgStrideLength", "avgGroundContactTime",
    "avgVerticalOscillation", "avgVerticalRatio", "avgPower", "maxPower", "normPower");
  html += sec("Running dynamics & power", [
    ["Avg cadence", a.averageRunningCadenceInStepsPerMinute ? `${num(a.averageRunningCadenceInStepsPerMinute)} spm` : null],
    ["Max cadence", a.maxRunningCadenceInStepsPerMinute ? `${num(a.maxRunningCadenceInStepsPerMinute)} spm` : null],
    ["Stride length", a.avgStrideLength ? (metric() ? `${num(a.avgStrideLength / 100, 2)} m` : `${num(a.avgStrideLength / 30.48, 2)} ft`) : null],
    ["Ground contact time", a.avgGroundContactTime ? `${num(a.avgGroundContactTime)} ms` : null],
    ["Vertical oscillation", a.avgVerticalOscillation ? `${num(a.avgVerticalOscillation, 1)} cm` : null],
    ["Vertical ratio", a.avgVerticalRatio ? `${num(a.avgVerticalRatio, 1)} %` : null],
    ["Avg power", a.avgPower ? `${num(a.avgPower)} W` : null],
    ["Max power", a.maxPower ? `${num(a.maxPower)} W` : null],
    ["Normalized power", a.normPower ? `${num(a.normPower)} W` : null],
  ]);
  const pz = zones(a, "powerTimeInZone_", "Time in power zones");
  if (pz) html += `<section class="card">${pz}</section>`;

  u("poolLength", "activeLengths", "strokes", "avgStrokes", "averageSwolf", "averageSwimCadenceInStrokesPerMinute", "avgStrokeDistance");
  if (isSwim(a)) html += sec("Swimming", [
    ["Pool length", a.poolLength ? `${num(a.poolLength / 100, 1)} m` : null],
    ["Lengths", a.activeLengths ? num(a.activeLengths) : null],
    ["Total strokes", a.strokes ? num(a.strokes) : null],
    ["Avg strokes per length", a.avgStrokes ? num(a.avgStrokes, 1) : null],
    ["Avg SWOLF", a.averageSwolf ? num(a.averageSwolf) : null],
    ["Avg stroke rate", a.averageSwimCadenceInStrokesPerMinute ? `${num(a.averageSwimCadenceInStrokesPerMinute)} strokes/min` : null],
    ["Avg distance per stroke", a.avgStrokeDistance ? `${num(a.avgStrokeDistance, 2)} m` : null],
  ]);

  u("totalSets", "activeSets", "totalReps");
  if (a.hevy) {
    const h = hevyStats(a.hevy);
    const setText = (x) => `${x.kg > 0 ? lift(x.kg) + " × " : ""}${num(x.reps)}`;
    const tbl = a.hevy.exercises.map((ex) => `<tr><td>${esc(exName(ex))}</td><td>${(ex.sets || []).map((x) => (x.type === "warmup" ? `<span class="muted">${esc(setText(x))}</span>` : esc(setText(x)))).join(", ")}</td></tr>`).join("");
    html += `<section class="card"><h2>Strength · from Hevy</h2>${rows([["Exercises", num(h.exercises)], ["Hard sets", num(h.sets)], ["Volume", volText(h.volume)], ["Gym load", num(hevyLoad(a.hevy))]])}
      <div class="table-wrap"><table><tr><th>Exercise</th><th>Sets (warm-ups grey)</th></tr>${tbl}</table></div></section>`;
  } else if (a.totalSets || a.exerciseSets) {
    const ex = (a.exerciseSets || []).filter((x) => x.sets);
    const table = ex.length ? `<div class="table-wrap"><table><tr><th>Exercise</th><th>Sets</th><th>Reps</th><th>Volume</th><th>Time</th></tr>${ex.map((x) =>
      `<tr><td>${esc(humanize(x.category))}</td><td>${num(x.sets)}</td><td>${num(x.reps)}</td><td>${x.volume ? weight(x.volume / 1000) : "–"}</td><td>${dur((x.duration || 0) / 1000, "clock")}</td></tr>`).join("")}</table></div>` : "";
    html += `<section class="card"><h2>Strength</h2>${rows([["Sets", num(a.activeSets ?? a.totalSets)], ["Reps", num(a.totalReps)]])}${table}</section>`;
  }

  u("elevationGain", "elevationLoss", "minElevation", "maxElevation", "avgElevation", "maxVerticalSpeed", "minTemperature", "maxTemperature");
  html += sec("Elevation & temperature", [
    ["Total ascent", a.elevationGain ? elev(a.elevationGain) : null],
    ["Total descent", a.elevationLoss ? elev(a.elevationLoss) : null],
    ["Min / max elevation", nz(a.minElevation) ? `${elev(a.minElevation)} / ${elev(a.maxElevation)}` : null],
    ["Temperature", nz(a.minTemperature) ? `${temp(a.minTemperature)} – ${temp(a.maxTemperature)}` : null],
  ]);

  const splits = Object.keys(a).filter((k) => k.startsWith("fastestSplit_"));
  splits.forEach((k) => used.add(k));
  if (splits.length) {
    const label = (m) => ({ 1000: "1 km", 1609: "1 mile", 5000: "5 km", 10000: "10 km", 21098: "Half marathon", 42195: "Marathon" }[m] || `${m} m`);
    html += sec("Fastest splits", splits.map((k) => +k.split("_")[1]).sort((x, y) => x - y)
      .map((m) => [label(m), dur(a[`fastestSplit_${m}`], "clock")]));
  }

  // Anything else Garmin sent, so nothing is hidden.
  const rest = Object.keys(a).filter((k) => !used.has(k) && (typeof a[k] === "number" || typeof a[k] === "string"));
  if (rest.length) html += `<section class="card"><details><summary>All other fields (${rest.length})</summary>${rows(rest.map((k) => [humanize(k.replace(/([a-z])([A-Z])/g, "$1_$2")), esc(typeof a[k] === "number" ? num(a[k], 2) : a[k])]))}</details></section>`;

  $("#sheet-title").textContent = `${ACT_ICON[a.type] || ""} ${a.activityName || humanize(a.type)}`;
  $("#sheet-body").innerHTML = `<div class="grid2" style="grid-template-columns:1fr">${html}</div>`;
  $("#sheet").hidden = false;
  $("#sheet-body").parentElement.scrollTop = 0;
}
$("#sheet-close").addEventListener("click", () => { $("#sheet").hidden = true; });
$("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") $("#sheet").hidden = true; });
addEventListener("keydown", (e) => { if (e.key === "Escape") $("#sheet").hidden = true; });
document.addEventListener("click", (e) => { const b = e.target.closest("[data-act]"); if (b) openActivity(b.dataset.act); });

/* ---------- Views ---------- */

const TITLES = { today: "Today", sleep: "Sleep", activities: "Activities", trends: "Fitness", strength: "Strength" };

function showUpdated() {
  const age = (Date.now() - new Date(DATA.generatedAt)) / 3600000;
  $("#updated").innerHTML = `Updated ${ago(DATA.generatedAt)}` + (age > 8 ? ` <span class="stale">· not updating - check GitHub Actions</span>` : "");
}

function render() {
  $("#tooltip").hidden = true;
  if (state.tab === "strength" && !DATA.hevy) state.tab = "today";
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
  $("#view-title").textContent = TITLES[state.tab];
  showUpdated();
  $("#warnings").innerHTML = ((DATA.errors || []).length
    ? `<div class="banner">Some data couldn't be loaded on the last update: ${DATA.errors.map((e) => esc(e.split(":")[0])).join(", ")}.</div>` : "")
    + (DATA.demo ? `<div class="banner">Preview: the lifting data is made up to show how Hevy would look. Your Garmin data is real and unchanged.</div>` : "");
  const view = $("#view");
  view.innerHTML = "";
  ({ today: renderToday, sleep: renderSleep, activities: renderActivities, trends: renderTrends, strength: renderStrength })[state.tab](view);
  window.scrollTo(0, 0);
}

document.querySelectorAll(".tabbar button").forEach((b) => b.addEventListener("click", () => { state.tab = b.dataset.tab; render(); }));

function dayPicker(view, dates, current, onChange, labelFn = relDay) {
  const i = dates.indexOf(current);
  const el = document.createElement("div");
  el.className = "daypicker";
  el.innerHTML = `<button aria-label="Previous day" ${i <= 0 ? "disabled" : ""}>‹</button>
    <div class="day">${esc(labelFn(current))}<div class="muted small">${esc(fmtDay(current, { day: "numeric", month: "short", year: "numeric" }))}</div></div>
    <button aria-label="Next day" ${i >= dates.length - 1 ? "disabled" : ""}>›</button>`;
  const [prev, next] = el.querySelectorAll("button");
  prev.onclick = () => onChange(dates[i - 1]);
  next.onclick = () => onChange(dates[i + 1]);
  view.appendChild(el);
}

function section(view, html, cls = "card") {
  const el = document.createElement("section");
  el.className = cls;
  el.innerHTML = html;
  view.appendChild(el);
  return el;
}

function renderToday(view) {
  const dates = DATA.days.filter(hasDayData).map((d) => d.date);
  dayPicker(view, dates, state.day, (d) => { state.day = d; render(); });
  const d = byDate.get(state.day) || {};
  const sl = d.sleep, hrv = d.hrv;

  // Recovery: how well the body bounced back overnight
  section(view, [
    tile("HRV (overnight)", hrv && nz(hrv.avg) ? `${num(hrv.avg)}<small> ms</small>` : "–",
      hrv ? `${status(hrv.status)}${nz(hrv.weekly) ? `<br>7-day avg ${num(hrv.weekly)} ms` : ""}${hrv.low ? ` · normal ${num(hrv.low)}–${num(hrv.high)}` : ""}` : "No reading"),
    tile("Resting heart rate", nz(d.rhr) ? `${num(d.rhr)}<small> bpm</small>` : "–", vsBaseline(d.rhr, baseline((x) => x.rhr, state.day), "bpm")),
    tile("Sleep", sl ? dur(sl.total) : "–",
      sl ? `${nz(sl.score) ? "Score " + num(sl.score) + " · " : ""}${status(sl.quality)}${sl.needMinutes ? `<br>Need ${dur(sl.needMinutes * 60)}` : ""}` : "No sleep recorded"),
    tile("Overnight breathing", sl && nz(sl.respAvg) ? `${num(sl.respAvg)}<small> brpm</small>` : "–",
      sl && nz(sl.respAvg) ? vsBaseline(sl.respAvg, baseline((x) => x.sleep?.respAvg, state.day), "brpm") : ""),
  ].join(""), "tiles");

  readinessCard(view, state.day);
  statusCard(view, state.day);
  if (DATA.hevy) gymCard(view, state.day);

  const last14 = DATA.days.filter((x) => x.date <= state.day).slice(-14);
  const labels = last14.map((x) => fmtDay(x.date, { day: "numeric", month: "short" }));
  const tipLabels = last14.map((x) => fmtDay(x.date));
  const grid = section(view, "", "grid2");
  chartCard(grid, "HRV · last 14 nights", {
    type: "line", labels, tipLabels, noTable: true, height: 150,
    series: [{ name: "HRV", color: css("--s1"), values: last14.map((x) => x.hrv?.avg) }],
    band: { lo: last14.map((x) => x.hrv?.low), hi: last14.map((x) => x.hrv?.high) }, yFmt: (v) => `${num(v)} ms`,
  }, "Shaded area = your normal range. Below it usually means you need more recovery.");
  chartCard(grid, "Resting heart rate · last 14 days", {
    type: "line", labels, tipLabels, noTable: true, height: 150,
    series: [{ name: "Resting HR", color: css("--s1"), values: last14.map((x) => x.rhr) }], yFmt: (v) => `${num(v)} bpm`,
  }, "A few beats above normal can mean fatigue, stress or illness.");

  // Workouts
  const acts = DATA.activities.filter((a) => actDate(a) === state.day);
  const latest = DATA.activities.find((a) => actDate(a) < state.day);
  section(view, acts.length ? `<h2>Workouts</h2>${actList(acts)}`
    : `<h2>Rest day</h2><p class="empty">No workouts this day.</p>${latest ? `<h3 style="margin-top:6px">Latest workout</h3>${actList([latest])}` : ""}`);

  // Training this week vs last week
  const wk = (from, to) => {
    const list = DATA.activities.filter((a) => actDate(a) >= from && actDate(a) < to);
    return { n: list.length, t: list.reduce((x, a) => x + actTime(a), 0), load: list.reduce((x, a) => x + (a.activityTrainingLoad || 0), 0) };
  };
  const mon = mondayOf(localToday());
  const thisWk = wk(mon, addDays(mon, 7)), lastWk = wk(addDays(mon, -7), mon);
  section(view, [
    tile("This week", `${num(thisWk.n)}<small> workouts</small>`, `${dur(thisWk.t)} · training load ${num(thisWk.load)}`),
    tile("Last week", `${num(lastWk.n)}<small> workouts</small>`, `${dur(lastWk.t)} · training load ${num(lastWk.load)}`),
  ].join(""), "tiles");
}

function renderSleep(view) {
  const nights = DATA.days.filter((d) => d.sleep).map((d) => d.date);
  if (!state.night) { section(view, `<p class="empty">No sleep data yet.</p>`); return; }
  dayPicker(view, nights, state.night, (d) => { state.night = d; render(); }, (s) => {
    const r = relDay(s); return r === "Today" ? "Last night" : r === "Yesterday" ? "Night before last" : `Night to ${r}`;
  });
  const d = byDate.get(state.night), s = d.sleep, hrv = d.hrv;
  const c = ["--s1", "--s2", "--s3", "--s4"].map(css);
  const stages = [
    { label: "Deep", value: s.deep, color: c[0] }, { label: "Light", value: s.light, color: c[1] },
    { label: "REM", value: s.rem, color: c[2] }, { label: "Awake", value: s.awake, color: c[3] },
  ].map((p) => ({ ...p, text: `${dur(p.value)}${s.total ? ` · ${Math.round(((p.value || 0) / (s.total + (s.awake || 0))) * 100)}%` : ""}` }));

  section(view, `<div class="hero"><div class="label muted">Sleep score</div>
      <div class="value">${nz(s.score) ? num(s.score) : "–"}<small> / 100</small></div>
      <div>${status(s.quality)} · ${dur(s.total)} asleep${s.needMinutes ? ` <span class="muted">(need ${dur(s.needMinutes * 60)})</span>` : ""}</div></div>
      <h3 style="margin-top:14px">Sleep stages</h3>${stackBar(stages)}
      ${s.feedback ? `<p class="note">${esc(humanize(s.feedback))}${s.insight ? ". " + esc(humanize(s.insight)) : ""}.</p>` : ""}`);

  const grid = section(view, "", "grid2");
  section(grid, `<h2>Details</h2>${rows([
    ["Fell asleep", clockLocal(s.start)], ["Woke up", clockLocal(s.end)],
    ["Time asleep", dur(s.total)], ["Awake time", dur(s.awake)], ["Times awake", nz(s.awakeCount) ? num(s.awakeCount) : null],
    ["Avg heart rate", s.avgHR ? `${num(s.avgHR)} bpm` : null],
    ["Respiration", s.respAvg ? `${num(s.respAvg)} brpm <span class="muted">(${num(s.respMin)}–${num(s.respMax)})</span>` : null],
    ["Overnight HRV", hrv && hrv.avg ? `${num(hrv.avg)} ms ${status(hrv.status)}` : null],
    ["HRV 5-min high", hrv && hrv.high5 ? `${num(hrv.high5)} ms` : null],
    ["HRV normal range", hrv && hrv.low ? `${num(hrv.low)}–${num(hrv.high)} ms` : null],
    ["Nap", s.nap ? dur(s.nap) : null],
  ])}`);
  const FACT = { totalDuration: "Duration", deepPercentage: "Deep sleep", lightPercentage: "Light sleep", remPercentage: "REM sleep",
    awakeCount: "Awakenings", restlessness: "Restlessness", stress: "Stress" };
  const facts = Object.entries(s.factors || {});
  if (facts.length) section(grid, `<h2>Score factors</h2>${rows(facts.map(([k, f]) => [FACT[k] || humanize(k), `${nz(f.value) ? num(f.value) + "% " : ""}${status(f.quality)}`]))}`);

  const last = DATA.days.filter((x) => x.sleep && x.date <= state.night).slice(-30);
  const labels = last.map((x) => fmtDay(x.date, { day: "numeric", month: "short" }));
  const h = (v) => (v || 0) / 3600;
  chartCard(view, "Last 30 nights", {
    type: "stack", labels, tipLabels: last.map((x) => fmtDay(x.date)),
    series: [
      { name: "Deep", color: c[0], values: last.map((x) => h(x.sleep.deep)) }, { name: "Light", color: c[1], values: last.map((x) => h(x.sleep.light)) },
      { name: "REM", color: c[2], values: last.map((x) => h(x.sleep.rem)) }, { name: "Awake", color: c[3], values: last.map((x) => h(x.sleep.awake)) },
    ],
    yFmt: (v) => dur(v * 3600), axisFmt: (v) => `${v}h`,
  });
  chartCard(view, "Sleep score", {
    type: "line", labels, tipLabels: last.map((x) => fmtDay(x.date)),
    series: [{ name: "Score", color: css("--s1"), values: last.map((x) => x.sleep.score) }], yMax: 100,
  });
}

function renderActivities(view) {
  const types = [...new Set(DATA.activities.map((a) => a.type))];
  const chips = section(view, ["all", ...types].map((t) =>
    `<button class="chip ${state.actType === t ? "active" : ""}" data-type="${t}">${t === "all" ? "All" : `${ACT_ICON[t] || ""} ${esc(humanize(t))}`}</button>`).join(""), "chips");
  chips.querySelectorAll(".chip").forEach((b) => b.onclick = () => { state.actType = b.dataset.type; render(); });
  const list = DATA.activities.filter((a) => state.actType === "all" || a.type === state.actType);

  // Totals for this week and last 4 weeks
  const monday = mondayOf(localToday()), four = addDays(localToday(), -27);
  const sum = (arr) => ({ n: arr.length, t: arr.reduce((x, a) => x + actTime(a), 0), d: arr.reduce((x, a) => x + (a.distance || 0), 0) });
  const wk = sum(list.filter((a) => actDate(a) >= monday));
  const m4 = sum(list.filter((a) => actDate(a) >= four));
  section(view, [
    tile("This week", `${num(wk.n)}<small> workouts</small>`, `${dur(wk.t)}${wk.d ? " · " + dist(wk.d, 1) : ""}`),
    tile("Last 4 weeks", `${num(m4.n)}<small> workouts</small>`, `${dur(m4.t)}${m4.d ? " · " + dist(m4.d, 1) : ""}`),
  ].join(""), "tiles");

  const weeks = weekly(list, (a) => actTime(a) / 3600, 12);
  chartCard(view, "Training time per week", {
    type: "bar", labels: weeks.map((w) => fmtDay(w.s, { day: "numeric", month: "short" })), tipLabels: weeks.map((w) => `Week of ${fmtDay(w.s)}`),
    series: [{ name: "Hours", color: css("--s1"), values: weeks.map((w) => w.v) }], yFmt: (v) => dur(v * 3600), axisFmt: (v) => `${v}h`, xName: "Week",
  });

  const SHOWN = 7, rest = list.slice(SHOWN);
  section(view, `<h2>${list.length} ${state.actType === "all" ? "activities" : esc(humanize(state.actType))}</h2>${actList(list.slice(0, SHOWN))}
    ${rest.length ? `<details><summary>Show all ${list.length} (${rest.length} more)</summary>${rest.map(actItem).join("")}</details>` : ""}`);
}

function renderTrends(view) {
  const chips = section(view, [[30, "30 days"], [90, "90 days"], [180, "6 months"], [365, "1 year"]].map(([v, t]) =>
    `<button class="chip ${state.range === v ? "active" : ""}" data-range="${v}">${t}</button>`).join(""), "chips");
  chips.querySelectorAll(".chip").forEach((b) => b.onclick = () => { state.range = +b.dataset.range; render(); });

  statusDetail(view);

  const days = DATA.days.slice(-state.range);
  const from = days[0].date;
  const labels = days.map((d) => fmtDay(d.date, { day: "numeric", month: "short" }));
  const tipLabels = days.map((d) => fmtDay(d.date));
  const [c1, c2] = [css("--s1"), css("--s2")];
  const short = (s) => fmtDay(s, { day: "numeric", month: "short" });
  const avgNote = (v, f) => `<span class="muted small">avg ${nz(v) ? f(v) : "–"}</span>`;
  vo2Tiles(view);
  const grid = section(view, "", "grid2");

  // Recovery markers
  const rhr = days.map((d) => d.rhr);
  chartCard(grid, "Resting heart rate", {
    type: "line", labels, tipLabels, yFmt: (v) => `${num(v)} bpm`, headRight: avgNote(avg(rhr), (v) => `${num(v)} bpm`),
    series: [{ name: "Daily", color: c1, values: rhr }, { name: "7-day average", color: c2, values: rolling(rhr) }],
  }, "A falling trend over weeks means your heart is getting fitter.");
  const hrvVals = days.map((d) => d.hrv?.avg);
  chartCard(grid, "Overnight HRV", {
    type: "line", labels, tipLabels, yFmt: (v) => `${num(v)} ms`, headRight: avgNote(avg(hrvVals), (v) => `${num(v)} ms`),
    series: [{ name: "Nightly", color: c1, values: hrvVals }, { name: "7-day average", color: c2, values: days.map((d) => d.hrv?.weekly) }],
    band: { lo: days.map((d) => d.hrv?.low), hi: days.map((d) => d.hrv?.high) },
  }, "Shaded area = your normal range. A rising 7-day average means you're handling training well.");

  // VO2 max (running, and a swim trend index)
  vo2Charts(grid, from, short);

  // Swimming: pace and efficiency
  const swims = DATA.activities.filter((a) => isSwim(a) && a.averageSpeed && actDate(a) >= from).reverse();
  if (swims.length) {
    const per = metric() ? 100 : 91.44, unit = metric() ? "/100 m" : "/100 yd";
    const sl = swims.map((a) => short(actDate(a))), st = swims.map((a) => `${fmtDay(actDate(a))} · ${dist(a.distance)}`);
    chartCard(grid, "Swim pace", {
      type: "line", labels: sl, tipLabels: st, xName: "Swim", dots: swims.length < 40,
      series: [{ name: "Pace", color: c1, values: swims.map((a) => per / a.averageSpeed) }],
      yFmt: (v) => `${dur(v, "clock")} ${unit}`, axisFmt: (v) => dur(v, "clock"),
    }, `Average pace while swimming (${unit}). Lower = faster.`);
    const swolf = swims.map((a) => a.averageSwolf || null);
    if (swolf.some(nz)) chartCard(grid, "SWOLF", {
      type: "line", labels: sl, tipLabels: st, xName: "Swim", dots: swims.length < 40,
      series: [{ name: "SWOLF", color: c1, values: swolf }],
    }, "Strokes plus seconds per length. Lower = more efficient technique.");
  }

  // Training load per week
  // Start at the chosen range or the first recorded workout, whichever is later.
  const firstAct = DATA.activities.length ? actDate(DATA.activities[DATA.activities.length - 1]) : from;
  const startWk = mondayOf(firstAct > from ? firstAct : from);
  const nWeeks = Math.max(1, Math.round((dayDate(mondayOf(localToday())) - dayDate(startWk)) / 604800000) + 1);
  const load = weekly(DATA.activities, (a) => a.activityTrainingLoad, nWeeks);
  chartCard(grid, "Training load per week", {
    type: "bar", labels: load.map((w) => short(w.s)), tipLabels: load.map((w) => `Week of ${fmtDay(w.s)}`), xName: "Week",
    series: [{ name: "Load", color: c1, values: load.map((w) => w.v) }],
  }, "Garmin's training load for all workouts added up. Increase it gradually; this week may be incomplete.");

  const wDays = DATA.days.filter((d) => d.weightKg && d.date >= from);
  if (wDays.length) chartCard(grid, "Weight", {
    type: "line", labels: wDays.map((d) => short(d.date)), tipLabels: wDays.map((d) => fmtDay(d.date)),
    series: [{ name: "Weight", color: c1, values: wDays.map((d) => metric() ? d.weightKg : d.weightKg * 2.20462) }],
    yFmt: (v) => `${num(v, 1)} ${metric() ? "kg" : "lb"}`, dots: wDays.length < 40,
  });

  const fa = DATA.fitnessAge;
  if (fa) {
    const comp = fa.components || {};
    section(grid, `<h2>Fitness age</h2><div class="hero"><div class="value">${num(fa.fitnessAge, 1)}<small> years</small></div>
      <div class="muted">Actual age ${num(fa.chronologicalAge)}${fa.previousFitnessAge && fa.previousFitnessAge !== fa.fitnessAge ? ` · previously ${num(fa.previousFitnessAge, 1)}` : ""}</div></div>
      ${rows([
        ["Vigorous days per week", comp.vigorousDaysAvg ? num(comp.vigorousDaysAvg.value, 1) : null],
        ["Vigorous minutes per week", comp.vigorousMinutesAvg ? num(comp.vigorousMinutesAvg.value) : null],
        ["Resting heart rate", comp.rhr ? `${num(comp.rhr.value)} bpm` : null],
        ["BMI", comp.bmi ? `${num(comp.bmi.value, 1)}${comp.bmi.targetValue ? ` <span class="muted">(target ${num(comp.bmi.targetValue, 1)})</span>` : ""}` : null],
      ])}`);
  }
  const z = (DATA.hrZones || [])[0];
  if (z) {
    const floors = [z.zone1Floor, z.zone2Floor, z.zone3Floor, z.zone4Floor, z.zone5Floor, z.maxHeartRateUsed];
    section(grid, `<h2>Heart rate zones</h2>${rows([1, 2, 3, 4, 5].map((i) => [`Zone ${i}`, `${floors[i - 1]}–${floors[i] - (i < 5 ? 1 : 0)} bpm`]))}
      <p class="note">Based on max heart rate ${num(z.maxHeartRateUsed)} bpm (${esc(humanize(z.trainingMethod))}), resting ${num(z.restingHeartRateUsed)} bpm.</p>`);
  }
}
