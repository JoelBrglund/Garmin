/**
 * Training dashboard -> Google Calendar bridge.
 *
 * This runs inside YOUR Google account (script.google.com). The dashboard sends it the days you have
 * training planned in the next 7 days, and it makes your calendar match, as simple all-day events.
 *
 * Safety rules built in:
 *  - It only ever touches events it created itself (they carry a hidden tag). Your personal events are never read,
 *    changed or deleted by this script.
 *  - Running the same request twice changes nothing, so there are never duplicates.
 *  - Requests without the right SECRET are rejected.
 *
 * Setup: see SETUP.md next to this file. Change SECRET below, then deploy as a web app.
 */

// Must match GOOGLE_CALENDAR_SECRET in the dashboard's GitHub secrets. Use 30+ random characters.
const SECRET = "PASTE-A-LONG-RANDOM-SECRET-HERE";
// "" = your main calendar. Or a name like "Training": the script then creates/uses a separate calendar with that name.
const CALENDAR_NAME = "";

const TAG_KEY = "trainingDashboard";   // hidden marker on events made by this script
const TAG_VALUE = "1";
const MAX_WINDOW_DAYS = 31;            // refuse absurdly long windows
const CLEAN_AHEAD_DAYS = 120;          // also remove leftover events of ours up to this far after the window

function doGet() {
  return json_({ ok: true, info: "Training dashboard calendar bridge is running." });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (err) {
    return json_({ ok: false, error: "bad request" });
  }
  if (!SECRET || SECRET.indexOf("PASTE-A-LONG") === 0 || typeof req.secret !== "string" || !sameText_(req.secret, SECRET)) {
    return json_({ ok: false, error: "unauthorized" });
  }
  try {
    if (req.action === "ping") return json_({ ok: true, calendar: getCalendar_().getName() });
    if (req.action === "sync") return json_(syncDays_(req));
    return json_({ ok: false, error: "unknown action" });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

/** Make the calendar's events match req.events ([{day, title}]) inside the window [req.from, req.to].
 *  (Older dashboards send req.days + req.title instead; that still works.) */
function syncDays_(req) {
  var from = req.from, to = req.to;
  var events = req.events;
  if (events === undefined && Array.isArray(req.days)) {
    events = req.days.map(function (d) { return { day: d, title: req.title }; });
  }
  if (!isDay_(from) || !isDay_(to) || from > to || !Array.isArray(events) ||
      !events.every(function (e) { return e && isDay_(e.day); })) throw new Error("invalid window");
  if (daysBetween_(from, to) >= MAX_WINDOW_DAYS) throw new Error("window too long");
  var want = {};
  events.forEach(function (e) { if (e.day >= from && e.day <= to) want[e.day] = cleanTitle_(e.title); });

  var lock = LockService.getScriptLock();
  lock.waitLock(20000); // two requests at once would race, so they queue up
  try {
    var tz = Session.getScriptTimeZone();
    var cal = getCalendar_();
    var events = cal.getEvents(parseDay_(from, tz), parseDay_(addDays_(to, CLEAN_AHEAD_DAYS + 1), tz));
    var byDay = {};
    events.forEach(function (ev) {
      if (!ev.isAllDayEvent() || ev.getTag(TAG_KEY) !== TAG_VALUE) return; // not ours: never touch
      var d = Utilities.formatDate(ev.getAllDayStartDate(), tz, "yyyy-MM-dd");
      (byDay[d] = byDay[d] || []).push(ev);
    });

    var result = { ok: true, created: 0, updated: 0, deleted: 0, kept: 0 };
    Object.keys(byDay).forEach(function (d) {
      var list = byDay[d];
      if (!want[d]) { // training no longer planned that day (or it is past the window): remove our event
        list.forEach(function (ev) { ev.deleteEvent(); result.deleted++; });
        return;
      }
      for (var i = 1; i < list.length; i++) { list[i].deleteEvent(); result.deleted++; } // duplicates
      if (list[0].getTitle() !== want[d]) { list[0].setTitle(want[d]); result.updated++; } else result.kept++;
    });
    Object.keys(want).forEach(function (d) {
      if (byDay[d]) return;
      var ev = cal.createAllDayEvent(want[d], parseDay_(d, tz));
      ev.setTag(TAG_KEY, TAG_VALUE);
      result.created++;
    });
    return result;
  } finally {
    lock.releaseLock();
  }
}

function getCalendar_() {
  if (!CALENDAR_NAME) return CalendarApp.getDefaultCalendar();
  var found = CalendarApp.getCalendarsByName(CALENDAR_NAME);
  return found.length ? found[0] : CalendarApp.createCalendar(CALENDAR_NAME);
}

function cleanTitle_(t) {
  t = typeof t === "string" ? t.replace(/[\r\n]+/g, " ").trim().slice(0, 120) : "";
  return t || "Training";
}
function isDay_(s) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function parseDay_(s, tz) { return Utilities.parseDate(s, tz, "yyyy-MM-dd"); }
function addDays_(s, n) { var d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function daysBetween_(a, b) { return Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 86400000); }
function sameText_(a, b) { // compares without stopping at the first difference
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
