"use strict";
/* Made-up lifting data so the Strength features can be previewed without Hevy.
   Only loaded when the dashboard is opened with #demo-hevy. Nothing here is real. It is built around
   the dates of the real Garmin strength sessions, so the preview lines up with the real calendar. */

window.makeDemoHevy = (DATA) => {
  let seed = 7;
  const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  // id: [title, primary muscle, helper muscles, start kg, kg gained per session, working reps]
  const T = {
    bench: ["Bench Press (Barbell)", "chest", ["triceps", "shoulders"], 70, 0.6, 6],
    ohp: ["Overhead Press (Barbell)", "shoulders", ["triceps"], 42, 0.05, 6],
    incline: ["Incline Press (Dumbbell)", "chest", ["shoulders", "triceps"], 24, 0.25, 9],
    raise: ["Lateral Raise (Dumbbell)", "shoulders", [], 10, 0.05, 12],
    pushdown: ["Triceps Pushdown (Cable)", "triceps", [], 30, 0.2, 11],
    row: ["Bent Over Row (Barbell)", "upper_back", ["lats", "biceps"], 60, 0.7, 8],
    pulldown: ["Lat Pulldown (Cable)", "lats", ["biceps"], 55, 0.4, 10],
    pullup: ["Pull Up", "lats", ["biceps", "upper_back"], 0, 0, 7],
    facepull: ["Face Pull (Cable)", "shoulders", ["upper_back"], 25, 0.15, 14],
    curl: ["Bicep Curl (Dumbbell)", "biceps", ["forearms"], 14, 0.1, 10],
    squat: ["Squat (Barbell)", "quadriceps", ["glutes", "hamstrings"], 80, 1.0, 5],
    rdl: ["Romanian Deadlift (Barbell)", "hamstrings", ["glutes", "lower_back"], 90, 0.7, 8],
    legpress: ["Leg Press", "quadriceps", ["glutes"], 160, 2.0, 10],
    lunge: ["Walking Lunge (Dumbbell)", "quadriceps", ["glutes", "hamstrings"], 20, 0.15, 12],
    calf: ["Standing Calf Raise", "calves", [], 60, 0.4, 14],
    crunch: ["Cable Crunch", "abdominals", [], 40, 0.3, 15],
  };
  const ROUTINES = [
    ["Push day", ["bench", "ohp", "incline", "raise", "pushdown"]],
    ["Pull day", ["row", "pulldown", "pullup", "facepull", "curl"]],
    ["Leg day", ["squat", "rdl", "legpress", "lunge", "calf", "crunch"]],
  ];
  const templates = {};
  Object.entries(T).forEach(([id, [title, primary, secondary]]) => { templates["demo-" + id] = { title, primary, secondary }; });

  const round = (kg) => Math.round(kg / 2.5) * 2.5;
  const sessions = DATA.activities.filter((a) => a.type === "strength_training").sort((a, b) => a.startTimeLocal.localeCompare(b.startTimeLocal));
  const workouts = [];
  const build = (i, startMs, endMs) => {
    const [title, ids] = ROUTINES[i % 3];
    return {
      id: `demo-w${i}`, title, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(),
      exercises: ids.map((id) => {
        const [name, , , base, gain, reps] = T[id];
        const work = id === "pullup" ? 0 : round(base + gain * Math.floor(i / 3) * 3 + (rnd() - 0.5) * 2);
        const sets = [];
        if (work >= 40) sets.push({ type: "warmup", kg: round(work * 0.6), reps: 8, rpe: null });
        const n = 3 + (rnd() > 0.6 ? 1 : 0);
        for (let k = 0; k < n; k++) sets.push({ type: "normal", kg: work, reps: Math.max(3, reps + Math.round((rnd() - 0.6) * 2) - (k === n - 1 ? 1 : 0)), rpe: k >= n - 2 ? 8 + (rnd() > 0.5 ? 1 : 0) : 7 });
        return { templateId: "demo-" + id, title: name, sets };
      }),
    };
  };
  sessions.forEach((a, i) => {
    const start = a.beginTimestamp || Date.parse(`${String(a.startTimeGMT).replace(" ", "T")}Z`);
    workouts.push(build(i, start + 120000, start + (a.duration || 3600) * 1000 - 60000));
  });

  // One session the watch missed, on a day (a week or more ago) without a Garmin strength session.
  const have = new Set(sessions.map((a) => a.startTimeLocal.slice(0, 10)));
  const lastDay = DATA.days[DATA.days.length - 1].date;
  for (let back = 9; back < 28; back++) {
    const d = new Date(Date.parse(lastDay + "T17:30:00Z") - back * 86400000);
    if (!have.has(d.toISOString().slice(0, 10))) { workouts.push(build(sessions.length, +d, +d + 55 * 60000)); break; }
  }
  workouts.sort((a, b) => b.start.localeCompare(a.start));
  return { workouts, templates };
};
