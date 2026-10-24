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
const state = { tab: "today", day: null, night: null, range: 30, actType: "all" };

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
  if (remember) store.set(PASS_KEY, passphrase);
  prepare();
  $("#lock").hidden = true;
  $("#app").hidden = false;
  render();
}

function showLock(message = "") {
  DATA = null;
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
$("#refresh-btn").addEventListener("click", async () => {
  const pass = store.get(PASS_KEY);
  if (!pass) return showLock("Enter your passphrase to reload.");
  try { await unlock(pass, true); } catch (err) { showLock(err.message); }
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
function prepare() {
  byDate.clear();
  DATA.days.forEach((d) => byDate.set(d.date, d));
  const todayStr = localToday();
  const dates = DATA.days.map((d) => d.date);
  if (!state.day || !byDate.has(state.day)) state.day = dates.includes(todayStr) ? todayStr : dates[dates.length - 1];
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

function weekIntensity(dateStr) { // Garmin counts vigorous minutes double; week starts Monday
  const d = dayDate(dateStr);
  const monday = new Date(d - ((d.getUTCDay() + 6) % 7) * 86400000);
  let total = 0;
  for (let t = monday; t <= d; t = new Date(+t + 86400000)) {
    const row = byDate.get(t.toISOString().slice(0, 10));
    if (row) total += (row.imModerate || 0) + 2 * (row.imVigorous || 0);
  }
  return total;
}

function latestWeight(dateStr) {
  for (let i = DATA.days.length - 1; i >= 0; i--) {
    const d = DATA.days[i];
    if (d.date <= dateStr && d.weightKg) return d;
  }
  return null;
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
    const padL = 34, padR = cfg.type === "line" && cfg.endLabel !== false ? 30 : 6, padT = 10, padB = 22;
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
          if (cfg.endLabel !== false) s += `<text class="end-label" x="${X(lastI) + 7}" y="${Y(sr.values[lastI]) + 4}">${esc((cfg.axisFmt || compact)(sr.values[lastI]))}</text>`;
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
  if (a.totalSets) st.push(["Sets", num(a.activeSets ?? a.totalSets)]);
  if (a.totalReps) st.push(["Reps", num(a.totalReps)]);
  if (a.averageHR) st.push(["♥", `${num(a.averageHR)} bpm`]);
  if (a.calories) st.push(["", `${num(a.calories)} kcal`]);
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

  u("duration", "movingDuration", "elapsedDuration", "distance", "averageSpeed", "maxSpeed", "avgGradeAdjustedSpeed", "calories", "bmrCalories",
    "steps", "lapCount", "locationName", "waterEstimated", "differenceBodyBattery", "moderateIntensityMinutes", "vigorousIntensityMinutes");
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
    ["Calories", a.calories ? `${num(a.calories)} kcal` + (a.bmrCalories ? ` <span class="muted">(${num(a.bmrCalories)} resting)</span>` : "") : null],
    ["Intensity minutes", (a.moderateIntensityMinutes || a.vigorousIntensityMinutes) ? `${num(a.moderateIntensityMinutes || 0)} moderate · ${num(a.vigorousIntensityMinutes || 0)} vigorous` : null],
    ["Body Battery impact", nz(a.differenceBodyBattery) ? num(a.differenceBodyBattery) : null],
    ["Steps", a.steps ? num(a.steps) : null],
    ["Laps", a.lapCount ? num(a.lapCount) : null],
    ["Sweat loss (est.)", a.waterEstimated ? `${num(a.waterEstimated)} ml` : null],
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
  if (a.totalSets || a.exerciseSets) {
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

const TITLES = { today: "Today", sleep: "Sleep", activities: "Activities", trends: "Trends" };

function render() {
  $("#tooltip").hidden = true;
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
  $("#view-title").textContent = TITLES[state.tab];
  const age = (Date.now() - new Date(DATA.generatedAt)) / 3600000;
  $("#updated").innerHTML = `Updated ${ago(DATA.generatedAt)}` + (age > 8 ? ` <span class="stale">· not updating - check GitHub Actions</span>` : "");
  $("#warnings").innerHTML = (DATA.errors || []).length
    ? `<div class="banner">Some data couldn't be loaded on the last update: ${DATA.errors.map((e) => esc(e.split(":")[0])).join(", ")}.</div>` : "";
  const view = $("#view");
  view.innerHTML = "";
  ({ today: renderToday, sleep: renderSleep, activities: renderActivities, trends: renderTrends })[state.tab](view);
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
  const dates = DATA.days.map((d) => d.date);
  dayPicker(view, dates, state.day, (d) => { state.day = d; render(); });
  const d = byDate.get(state.day) || {};
  const sl = d.sleep, hrv = d.hrv;
  const wk = weekIntensity(state.day);
  const w = latestWeight(state.day);
  const isLive = DATA.intraday && DATA.intraday.date === state.day;

  const tiles = [
    tile("Body Battery", nz(d.bbLatest) && isLive ? num(d.bbLatest) : nz(d.bbMax) ? num(d.bbMax) + "<small> high</small>" : "–",
      nz(d.bbMax) ? `High ${num(d.bbMax)} · Low ${num(d.bbMin)}<br>+${num(d.bbCharged)} charged · −${num(d.bbDrained)} drained` : ""),
    tile("Steps", num(d.steps), nz(d.stepGoal) ? `Goal ${num(d.stepGoal)} · ${dist(d.distance, 1)}` : "", nz(d.stepGoal) ? meter(d.steps / d.stepGoal) : ""),
    tile("Resting heart rate", nz(d.rhr) ? `${num(d.rhr)}<small> bpm</small>` : "–",
      [nz(d.hrMin) ? `Range ${num(d.hrMin)}–${num(d.hrMax)}` : "", isLive && DATA.intraday.rhr7dayAvg ? `7-day avg ${num(DATA.intraday.rhr7dayAvg)}` : ""].filter(Boolean).join("<br>")),
    tile("Stress", nz(d.stressAvg) ? `${num(d.stressAvg)}<small> avg</small>` : "–",
      nz(d.stressMax) ? `Max ${num(d.stressMax)}${d.stressQualifier && d.stressQualifier !== "unknown" ? " · " + esc(humanize(d.stressQualifier)) : ""}` : ""),
    tile("Sleep", sl ? dur(sl.total) : "–", sl ? `${nz(sl.score) ? "Score " + num(sl.score) + " · " : ""}${status(sl.quality)}` : "No sleep recorded"),
    tile("HRV (overnight)", hrv && nz(hrv.avg) ? `${num(hrv.avg)}<small> ms</small>` : "–",
      hrv ? `${status(hrv.status)}${nz(hrv.weekly) ? `<br>7-day avg ${num(hrv.weekly)} ms` : ""}` : ""),
    tile("Intensity minutes", num((d.imModerate || 0) + 2 * (d.imVigorous || 0)),
      `${num(d.imModerate || 0)} moderate · ${num(d.imVigorous || 0)} vigorous<br>This week ${num(wk)} / ${num(d.imGoal || 150)}`, meter(wk / (d.imGoal || 150))),
    tile("Calories", nz(d.kcalTotal) ? `${num(d.kcalTotal)}<small> kcal</small>` : "–", nz(d.kcalActive) ? `${num(d.kcalActive)} active · ${num(d.kcalResting)} resting` : ""),
    tile("Floors climbed", num(d.floors), nz(d.floorsGoal) ? `Goal ${num(d.floorsGoal)}` : "", nz(d.floorsGoal) ? meter(d.floors / d.floorsGoal) : ""),
    tile("Respiration", nz(d.respAvg) ? `${num(d.respAvg)}<small> brpm</small>` : "–", nz(d.respMin) ? `Range ${num(d.respMin)}–${num(d.respMax)}` : ""),
    tile("Weight", w ? weight(w.weightKg) : "–", w ? (w.date === state.day ? "Weighed today" : `Last weighed ${fmtDay(w.date)}`) + (w.bodyFat ? ` · ${num(w.bodyFat, 1)}% fat` : "") : "No weigh-ins"),
  ];
  if (d.hydrationMl) tiles.push(tile("Hydration", `${num(d.hydrationMl)}<small> ml</small>`, d.hydrationGoalMl ? `Goal ${num(d.hydrationGoalMl)} ml` : ""));
  section(view, tiles.join(""), "tiles");

  if (isLive && DATA.intraday.hr.length) {
    const hr = DATA.intraday.hr;
    chartCard(view, "Heart rate today", {
      type: "line", x: hr.map((p) => p[0]), labels: hr.map((p) => clockReal(p[0])), series: [{ name: "Heart rate", color: css("--s1"), values: hr.map((p) => p[1]) }],
      yFmt: (v) => `${num(v)} bpm`, noTable: true, height: 160,
    }, nz(d.rhr) ? `Resting ${num(d.rhr)} bpm · range ${num(d.hrMin)}–${num(d.hrMax)} bpm` : "");
  }
  if (isLive && DATA.intraday.bodyBattery.length > 1) {
    const bb = DATA.intraday.bodyBattery;
    chartCard(view, "Body Battery today", {
      type: "line", x: bb.map((p) => p[0]), labels: bb.map((p) => clockReal(p[0])), series: [{ name: "Body Battery", color: css("--s1"), values: bb.map((p) => p[1]) }],
      yMin: 0, yMax: 100, dots: true, noTable: true, height: 150,
    });
  }

  if (d.stressSeconds) {
    const s = d.stressSeconds, c = HR_COLORS();
    const parts = [
      { label: "Rest", value: s.rest, color: c[0] }, { label: "Low", value: s.low, color: c[1] },
      { label: "Medium", value: s.medium, color: c[2] }, { label: "High", value: s.high, color: c[4] },
    ].map((p) => ({ ...p, text: dur(p.value) }));
    section(view, `<h2>Stress breakdown</h2>${stackBar(parts)}<p class="note">Also ${dur(s.activity)} during activity and ${dur(s.unmeasured)} not measured. Scale 0–100: rest 0–25, low 26–50, medium 51–75, high 76–100.</p>`);
  }

  if (d.bbFeedback || (d.bbEvents || []).length) {
    section(view, `<h2>Body Battery events</h2>${!(d.bbEvents || []).length ? "" : rows(d.bbEvents.map((e) => [
      `${humanize(e.type)} · ${clockStr(e.start)}`, `${e.impact > 0 ? "+" : ""}${num(e.impact)} <span class="muted">(${dur(e.minutes * 60)})</span>`]))}
      ${d.bbFeedback ? `<p class="note">${esc(humanize(d.bbFeedback))}</p>` : ""}`);
  }

  const acts = DATA.activities.filter((a) => a.startTimeLocal.startsWith(state.day));
  section(view, `<h2>Activities</h2>${actList(acts, "No activities this day.")}`);
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
    ["Avg stress", nz(s.avgStress) ? num(s.avgStress) : null],
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
  const today = dayDate(localToday());
  const monday = new Date(today - ((today.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
  const four = new Date(today - 27 * 86400000).toISOString().slice(0, 10);
  const sum = (arr) => ({ n: arr.length, t: arr.reduce((x, a) => x + actTime(a), 0), d: arr.reduce((x, a) => x + (a.distance || 0), 0) });
  const wk = sum(list.filter((a) => a.startTimeLocal.slice(0, 10) >= monday));
  const m4 = sum(list.filter((a) => a.startTimeLocal.slice(0, 10) >= four));
  section(view, [
    tile("This week", `${num(wk.n)}<small> activities</small>`, `${dur(wk.t)}${wk.d ? " · " + dist(wk.d, 1) : ""}`),
    tile("Last 4 weeks", `${num(m4.n)}<small> activities</small>`, `${dur(m4.t)}${m4.d ? " · " + dist(m4.d, 1) : ""}`),
  ].join(""), "tiles");

  // Weekly training time chart (last 12 weeks)
  const weeks = [];
  for (let k = 11; k >= 0; k--) {
    const start = new Date(dayDate(monday) - k * 7 * 86400000), end = new Date(+start + 7 * 86400000);
    const s = start.toISOString().slice(0, 10), e = end.toISOString().slice(0, 10);
    weeks.push({ s, v: list.filter((a) => a.startTimeLocal.slice(0, 10) >= s && a.startTimeLocal.slice(0, 10) < e).reduce((x, a) => x + actTime(a), 0) / 3600 });
  }
  chartCard(view, "Training time per week", {
    type: "bar", labels: weeks.map((w) => fmtDay(w.s, { day: "numeric", month: "short" })), tipLabels: weeks.map((w) => `Week of ${fmtDay(w.s)}`),
    series: [{ name: "Hours", color: css("--s1"), values: weeks.map((w) => w.v) }], yFmt: (v) => dur(v * 3600), axisFmt: (v) => `${v}h`, xName: "Week",
  });

  section(view, `<h2>${list.length} ${state.actType === "all" ? "activities" : esc(humanize(state.actType))}</h2>${actList(list)}`);
}

function renderTrends(view) {
  const chips = section(view, [[7, "7 days"], [30, "30 days"], [90, "90 days"], [365, "1 year"]].map(([v, t]) =>
    `<button class="chip ${state.range === v ? "active" : ""}" data-range="${v}">${t}</button>`).join(""), "chips");
  chips.querySelectorAll(".chip").forEach((b) => b.onclick = () => { state.range = +b.dataset.range; render(); });

  const days = DATA.days.slice(-state.range);
  const labels = days.map((d) => fmtDay(d.date, { day: "numeric", month: "short" }));
  const tipLabels = days.map((d) => fmtDay(d.date));
  const blue = css("--s1");
  const avg = (vals) => { const v = vals.filter(nz); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const one = (name, values, extra = {}) => ({ type: "line", labels, tipLabels, series: [{ name, color: blue, values }], ...extra,
    headRight: `<span class="muted small">avg ${extra.yFmt ? extra.yFmt(avg(values)) : num(avg(values))}</span>` });

  const grid = section(view, "", "grid2");
  chartCard(grid, "Resting heart rate", one("Resting HR", days.map((d) => d.rhr), { yFmt: (v) => `${num(v)} bpm` }));
  chartCard(grid, "Overnight HRV", one("HRV", days.map((d) => d.hrv?.avg), {
    yFmt: (v) => `${num(v)} ms`, band: { lo: days.map((d) => d.hrv?.low), hi: days.map((d) => d.hrv?.high) } }),
    "Shaded area = your normal (balanced) range.");
  chartCard(grid, "Sleep duration", { ...one("Sleep", days.map((d) => d.sleep ? d.sleep.total / 3600 : null), { yFmt: (v) => dur(v * 3600), axisFmt: (v) => `${v}h` }), type: "bar" });
  chartCard(grid, "Sleep score", one("Score", days.map((d) => d.sleep?.score), { yMax: 100 }));
  const stepGoal = avg(days.map((d) => d.stepGoal));
  chartCard(grid, "Steps", { ...one("Steps", days.map((d) => d.steps)), type: "bar", goal: stepGoal }, stepGoal ? `Line = average step goal (${num(stepGoal)}).` : "");
  chartCard(grid, "Average stress", one("Stress", days.map((d) => d.stressAvg)));
  chartCard(grid, "Body Battery", {
    type: "line", labels, tipLabels, yMin: 0, yMax: 100, headRight: "",
    series: [{ name: "Highest", color: css("--s1"), values: days.map((d) => d.bbMax) }, { name: "Lowest", color: css("--s2"), values: days.map((d) => d.bbMin) }],
  });
  chartCard(grid, "Active calories", { ...one("Active kcal", days.map((d) => d.kcalActive), { yFmt: (v) => `${num(v)} kcal` }), type: "bar" });
  chartCard(grid, "Respiration", one("Breaths/min", days.map((d) => d.respAvg), { yFmt: (v) => `${num(v)} brpm` }));

  // Weekly intensity minutes
  const wkMap = new Map();
  days.forEach((d) => {
    const dt = dayDate(d.date), mon = new Date(dt - ((dt.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
    wkMap.set(mon, (wkMap.get(mon) || 0) + (d.imModerate || 0) + 2 * (d.imVigorous || 0));
  });
  const wks = [...wkMap.entries()];
  const goal = days[days.length - 1]?.imGoal || 150;
  chartCard(grid, "Intensity minutes per week", {
    type: "bar", labels: wks.map(([k]) => fmtDay(k, { day: "numeric", month: "short" })), tipLabels: wks.map(([k]) => `Week of ${fmtDay(k)}`),
    series: [{ name: "Minutes", color: blue, values: wks.map(([, v]) => v) }], goal, xName: "Week",
  }, `Line = weekly goal (${num(goal)}). Vigorous minutes count double. First week may be partial.`);

  const wDays = DATA.days.filter((d) => d.weightKg && d.date >= days[0].date);
  if (wDays.length) chartCard(grid, "Weight", {
    type: "line", labels: wDays.map((d) => fmtDay(d.date, { day: "numeric", month: "short" })), tipLabels: wDays.map((d) => fmtDay(d.date)),
    series: [{ name: "Weight", color: blue, values: wDays.map((d) => metric() ? d.weightKg : d.weightKg * 2.20462) }],
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
