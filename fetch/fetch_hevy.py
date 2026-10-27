"""Download strength workouts from the Hevy API (needs Hevy PRO) in a compact, privacy-trimmed form.

Used by fetch_garmin.py, which stores the result under "hevy" in data/data.json.
The API key is read from the HEVY_API_KEY environment variable, or, on your own computer, from
"Hevy API.env" in the folder above the repository. With no key this step is skipped silently,
so the dashboard keeps working without Hevy.

Only sets, exercise names and muscle groups are kept. Notes and descriptions are dropped.
Never print the key or any workout details: GitHub Actions logs are public.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
LOCAL_KEY_FILE = REPO.parent / "Hevy API.env"
API = os.environ.get("HEVY_API_BASE", "https://api.hevyapp.com/v1").rstrip("/")
MAX_PAGES = 100          # safety stop (10 workouts per page)
PAUSE_SECONDS = 0.25     # be gentle: the rate limit is not documented


class HevyError(RuntimeError):
    """A problem talking to Hevy (message never contains the key)."""


def load_key() -> str:
    key = os.environ.get("HEVY_API_KEY", "").strip()
    if not key and LOCAL_KEY_FILE.exists():
        text = LOCAL_KEY_FILE.read_text(encoding="utf-8").strip()
        key = text.split("=", 1)[1].strip().strip("'\"") if "=" in text else text
    return key


def _get(path: str, params: dict, key: str) -> dict:
    url = f"{API}{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"api-key": key, "accept": "application/json"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < 3:
                time.sleep(2 ** (attempt + 1))
                continue
            if e.code in (401, 403):
                raise HevyError(f"Hevy rejected the key (HTTP {e.code}). Is Hevy PRO active and the key current?") from None
            raise HevyError(f"Hevy request failed (HTTP {e.code}).") from None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            if attempt < 3:
                time.sleep(2 ** (attempt + 1))
                continue
            raise HevyError(f"Could not reach Hevy ({type(e).__name__}).") from None
    raise HevyError("Hevy did not respond.")


def _pages(path: str, field: str, key: str, page_size: int):
    page = 1
    while page <= MAX_PAGES:
        data = _get(path, {"page": page, "pageSize": page_size}, key)
        yield from data.get(field) or []
        if page >= int(data.get("page_count") or 1):
            return
        page += 1
        time.sleep(PAUSE_SECONDS)


def compact_workout(w: dict) -> dict:
    return {
        "id": w.get("id"),
        "title": w.get("title"),
        "start": w.get("start_time"),
        "end": w.get("end_time"),
        "exercises": [
            {
                "templateId": e.get("exercise_template_id"),
                "title": e.get("title"),
                "sets": [
                    {"type": s.get("type"), "kg": s.get("weight_kg"), "reps": s.get("reps"), "rpe": s.get("rpe")}
                    for s in e.get("sets") or []
                ],
            }
            for e in w.get("exercises") or []
        ],
    }


def _start_date(w: dict) -> date | None:
    try:
        return datetime.fromisoformat(str(w.get("start_time")).replace("Z", "+00:00")).astimezone(timezone.utc).date()
    except ValueError:
        return None


def fetch(since: date) -> dict | None:
    """Return {"workouts": [...], "templates": {...}} for workouts on/after `since`, or None without a key."""
    key = load_key()
    if not key:
        return None
    workouts = []
    for w in _pages("/workouts", "workouts", key, 10):
        d = _start_date(w)
        if d is not None and d >= since:
            workouts.append(compact_workout(w))
    workouts.sort(key=lambda w: w.get("start") or "", reverse=True)

    wanted = {e["templateId"] for w in workouts for e in w["exercises"] if e.get("templateId")}
    templates: dict[str, dict] = {}
    if wanted:
        for t in _pages("/exercise_templates", "exercise_templates", key, 100):
            if t.get("id") in wanted:
                templates[t["id"]] = {
                    "title": t.get("title"),
                    "primary": t.get("primary_muscle_group"),
                    "secondary": t.get("secondary_muscle_groups") or [],
                }
    return {"workouts": workouts, "templates": templates}


if __name__ == "__main__":  # quick manual check: prints counts only
    result = fetch(date(2000, 1, 1))
    print("No Hevy key set." if result is None else f"{len(result['workouts'])} workouts, {len(result['templates'])} exercise types.")
