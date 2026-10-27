"""Download Garmin data with the Garmin Personal API and save it as one tidy JSON file.

Usage (from the repository folder):
    python fetch/fetch_garmin.py            # writes data/data.json

The API key is read from the GARMIN_PERSONAL_API_KEY environment variable, or, when
running on your own computer, from "Garmin API.env" in the folder above the repository.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

try:  # Use the operating system's trusted certificates (fixes SSL errors behind antivirus/proxies).
    import truststore

    truststore.inject_into_ssl()
except ImportError:
    pass

from garmin_personal_api import GarminPersonalApiClient, PersonalApiAuthenticator

import fetch_hevy

REPO = Path(__file__).resolve().parents[1]
LOCAL_KEY_FILE = REPO.parent / "Garmin API.env"
OUT_FILE = REPO / "data" / "data.json"
HISTORY_DAYS = int(os.environ.get("HISTORY_DAYS", "365"))
MAX_ACTIVITIES = 1000

# Activity fields that are not needed on the dashboard (personal info and location).
ACTIVITY_SKIP = ("owner", "startLatitude", "startLongitude", "endLatitude", "endLongitude",
                 "activityUUID", "userProfileId", "privacy")


def load_api_key() -> str:
    key = os.environ.get("GARMIN_PERSONAL_API_KEY", "").strip()
    if not key and LOCAL_KEY_FILE.exists():
        text = LOCAL_KEY_FILE.read_text(encoding="utf-8").strip()
        # Accept either a bare key or a KEY=VALUE line.
        key = text.split("=", 1)[1].strip().strip("'\"") if "=" in text else text
    if not key:
        sys.exit("No API key: set GARMIN_PERSONAL_API_KEY or create '../Garmin API.env'.")
    return key


def chunks(start: date, end: date, size: int):
    """Split a date range into pieces of at most `size` days (Garmin limits range lengths)."""
    while start <= end:
        stop = min(start + timedelta(days=size - 1), end)
        yield start, stop
        start = stop + timedelta(days=1)


def g(obj, *path, default=None):
    """Safely read a nested value: g(d, "a", "b") == d["a"]["b"] or default."""
    for p in path:
        if not isinstance(obj, dict) or obj.get(p) is None:
            return default
        obj = obj[p]
    return obj


def to_ms(value):
    """Garmin timestamps arrive as epoch milliseconds or as ISO strings; return epoch ms."""
    if value is None or isinstance(value, (int, float)):
        return value
    try:
        return int(datetime.fromisoformat(str(value).replace(" ", "T")).replace(tzinfo=timezone.utc).timestamp() * 1000)
    except ValueError:
        return None


def series(values):
    """Turn [[timestamp, value], ...] into a clean list, dropping empty readings."""
    return [[to_ms(t), v] for t, v, *_ in (values or []) if v is not None and v >= 0]


def daily_row(d: dict) -> dict:
    st = d.get("stress") or {}
    bb = d.get("bodyBattery") or {}
    sec = lambda k: (st.get(k) or 0) // 1000
    return {
        "date": d["calendarDate"],
        "steps": g(d, "movement", "steps", "value"),
        "stepGoal": g(d, "movement", "steps", "goal"),
        "distance": g(d, "movement", "steps", "distanceInMeters"),
        "floors": g(d, "movement", "floorsAscended", "value"),
        "floorsGoal": g(d, "movement", "floorsAscended", "goal"),
        "kcalTotal": g(d, "calories", "burnedTotal"),
        "kcalActive": g(d, "calories", "burnedActive"),
        "kcalResting": g(d, "calories", "burnedResting"),
        "rhr": g(d, "heartRate", "restingValue"),
        "hrMin": g(d, "heartRate", "minValue"),
        "hrMax": g(d, "heartRate", "maxValue"),
        "imModerate": g(d, "intensityMinutes", "moderate"),
        "imVigorous": g(d, "intensityMinutes", "vigorous"),
        "imGoal": g(d, "intensityMinutes", "goal"),
        "stressAvg": st.get("avgLevel"),
        "stressMax": st.get("maxLevel"),
        "stressQualifier": st.get("qualifier"),
        "stressSeconds": {
            "rest": sec("restDurationInMillis"),
            "low": sec("lowStressDurationInMillis"),
            "medium": sec("mediumStressDurationInMillis"),
            "high": sec("highStressDurationInMillis"),
            "activity": sec("activityDurationInMillis"),
            "unmeasured": sec("uncategorizedDurationInMillis"),
        } if st else None,
        "bbMax": bb.get("maxValue"),
        "bbMin": bb.get("minValue"),
        "bbCharged": bb.get("chargedValue"),
        "bbDrained": bb.get("drainedValue"),
        "bbLatest": bb.get("latestValue"),
        "bbFeedback": g(bb, "endOfDayDynamicFeedbackEvent", "feedbackLongType")
                      or g(bb, "dynamicFeedbackEvent", "feedbackLongType"),
        "bbEvents": [
            {"type": e.get("eventType"), "start": e.get("eventStartTimeLocal"),
             "minutes": round((e.get("durationInMillis") or 0) / 60000),
             "impact": e.get("bodyBatteryImpact"), "feedback": e.get("shortFeedback")}
            for e in bb.get("activityEvents") or []
        ],
        "respAvg": g(d, "respiration", "avgValue"),
        "respMin": g(d, "respiration", "minValue"),
        "respMax": g(d, "respiration", "maxValue"),
        "hydrationMl": g(d, "hydration", "consumedInMl"),
        "hydrationGoalMl": g(d, "hydration", "goalInMl"),
    }


def sleep_row(s: dict) -> dict:
    scores = s.get("sleepScores") or {}
    return {
        "score": g(scores, "overall", "value"),
        "quality": g(scores, "overall", "qualifierKey"),
        "total": s.get("sleepTimeSeconds"),
        "deep": s.get("deepSleepSeconds"),
        "light": s.get("lightSleepSeconds"),
        "rem": s.get("remSleepSeconds"),
        "awake": s.get("awakeSleepSeconds"),
        "nap": s.get("napTimeSeconds"),
        "start": s.get("sleepStartTimestampLocal"),
        "end": s.get("sleepEndTimestampLocal"),
        "avgHR": s.get("avgHeartRate"),
        "avgStress": s.get("avgSleepStress"),
        "respAvg": s.get("averageRespirationValue"),
        "respMin": s.get("lowestRespirationValue"),
        "respMax": s.get("highestRespirationValue"),
        "awakeCount": s.get("awakeCount"),
        "needMinutes": g(s, "sleepNeed", "actual"),
        "feedback": s.get("sleepScoreFeedback"),
        "insight": s.get("sleepScorePersonalizedInsight") or s.get("sleepScoreInsight"),
        "factors": {k: {"value": v.get("value"), "quality": v.get("qualifierKey")}
                    for k, v in scores.items() if k != "overall" and isinstance(v, dict)},
    }


def hrv_row(h: dict) -> dict:
    b = h.get("baseline") or {}
    return {
        "avg": h.get("lastNightAvg"),
        "weekly": h.get("weeklyAvg"),
        "high5": h.get("lastNight5MinHigh"),
        "status": h.get("status"),
        "feedback": h.get("feedbackPhrase"),
        "low": b.get("balancedLow"),
        "high": b.get("balancedUpper"),
        "lowUpper": b.get("lowUpper"),
    }


def activity_row(a: dict) -> dict:
    row = {k: v for k, v in a.items()
           if not k.startswith(ACTIVITY_SKIP) and not isinstance(v, (dict, list)) and v is not None}
    row["type"] = g(a, "activityType", "typeKey", default="other")
    if a.get("summarizedExerciseSets"):
        row["exerciseSets"] = a["summarizedExerciseSets"]
    return row


def main() -> None:
    key = load_api_key()
    with PersonalApiAuthenticator() as auth:
        token = auth.obtain_token(key)

    errors: list[str] = []

    def safe(label, fn, default=None):
        try:
            return fn()
        except Exception as e:  # Keep going so one failing data type doesn't stop the update.
            errors.append(f"{label}: {type(e).__name__}: {str(e)[:200]}")
            print("WARNING", errors[-1], file=sys.stderr)
            return default

    with GarminPersonalApiClient(token.access_token) as c:
        profile = safe("profile", c.get_user_profile_settings, {}) or {}
        tz = ZoneInfo(profile.get("timeZone") or "UTC")
        today = datetime.now(tz).date()
        start = today - timedelta(days=HISTORY_DAYS - 1)

        days: dict[str, dict] = {}
        for a, b in chunks(start, today, 180):
            for d in g(safe("daily summaries", lambda: c.get_daily_summaries(a, b), {}), "data", default=[]):
                days[d["calendarDate"]] = daily_row(d)

        def day(date_str):
            return days.setdefault(date_str, {"date": date_str})

        for a, b in chunks(start, today, 28):
            for s in safe("sleep", lambda: c.get_daily_sleep_summaries(a, b), []) or []:
                if s.get("sleepTimeSeconds"):
                    day(s["calendarDate"])["sleep"] = sleep_row(s)

        for a, b in chunks(start, today, 180):
            for h in g(safe("hrv", lambda: c.get_daily_hrv_summaries(a, b), {}), "hrvSummaries", default=[]):
                day(h["calendarDate"])["hrv"] = hrv_row(h)

        weights = safe("weight", lambda: c.get_weight_measurements(start, today), {}) or {}
        for w in weights.get("dailyWeightSummaries") or []:
            lw = w.get("latestWeight") or {}
            if lw.get("weight"):
                row = day(w["summaryDate"])
                row["weightKg"] = round(lw["weight"] / 1000, 2)
                row["bmi"] = lw.get("bmi")
                row["bodyFat"] = lw.get("bodyFat")
                row["muscleMassKg"] = round(lw["muscleMass"] / 1000, 2) if lw.get("muscleMass") else None

        activities = []
        while len(activities) < MAX_ACTIVITIES:
            page = safe("activities", lambda: c.search_activities(
                start=len(activities), limit=50, start_date=start, end_date=today), []) or []
            activities += [activity_row(a) for a in page]
            if len(page) < 50:
                break

        hr_day = safe("heart rate (today)", lambda: c.get_daily_heart_rate(today), {}) or {}
        bb_day = safe("body battery (today)", lambda: c.get_daily_body_battery(today, today), []) or []
        intraday = {
            "date": today.isoformat(),
            "hr": series(hr_day.get("heartRateValues")),
            "bodyBattery": series(bb_day[-1].get("bodyBatteryValuesArray")) if bb_day else [],
            "rhr7dayAvg": hr_day.get("lastSevenDaysAvgRestingHeartRate"),
        }
        fitness_age = safe("fitness age", lambda: c.get_fitness_age(today), None)
        hr_zones = safe("heart rate zones", c.get_heart_rate_zones, None)

    # Optional: strength workouts from Hevy (skipped silently when no key is set).
    hevy = safe("hevy", lambda: fetch_hevy.fetch(start))
    if hevy:
        print(f"Hevy: {len(hevy['workouts'])} workouts, {len(hevy['templates'])} exercise types")

    data = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "timezone": str(tz),
        "units": profile.get("measurementSystem", "metric"),
        "timeFormat": "12" if "twelve" in str(g(profile, "timeFormat", "formatKey", default="")) else "24",
        "days": [days[k] for k in sorted(days)],
        "activities": sorted(activities, key=lambda a: a.get("startTimeLocal", ""), reverse=True),
        "intraday": intraday,
        "fitnessAge": fitness_age,
        "hrZones": hr_zones,
        "errors": errors,
    }
    if hevy:
        data["hevy"] = hevy
    OUT_FILE.parent.mkdir(exist_ok=True)
    OUT_FILE.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    print(f"Saved {len(data['days'])} days and {len(activities)} activities to {OUT_FILE.relative_to(REPO)}"
          + (f" ({len(errors)} warnings)" if errors else ""))


if __name__ == "__main__":
    main()
