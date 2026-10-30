# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

A personal Garmin dashboard that works on phone and computer, in Chrome or Safari, and can be added to the iPhone home screen as a web app. It should be easy to read without leaving out anything important.

Focus: workouts, sleep, recovery (HRV, resting heart rate) and markers of fitness improvement (running efficiency, swim pace/SWOLF, training load, fitness age). The owner does not want Body Battery, stress, intensity minutes, calories or floors on the dashboard (the fetcher still downloads them).

The owner is a beginner: explain unfamiliar technical concepts in plain English when they matter.

## How it works

1. `fetch/fetch_garmin.py` downloads up to 365 days of data with Garmin's official **Personal API** (`garmin-connect-personal-api-python`) and writes `data/data.json`.
2. `fetch/encrypt.py` encrypts that file with a passphrase (gzip, then AES-256-GCM with a PBKDF2 key) into `site/data.enc`.
3. `site/` is a static web app with no build step and no libraries (plain HTML/CSS/JS, charts are hand-drawn SVG in `app.js`). The browser decrypts `data.enc` after the passphrase is entered.
4. `.github/workflows/update.yml` runs steps 1–2 every 3 hours (and on push/manual run) and publishes `site/` to GitHub Pages.

Live site: https://joelbrglund.github.io/Garmin/ (repo: github.com/JoelBrglund/Garmin, public). Pushing to `main` rebuilds and publishes it automatically (~2 min). Secrets and Pages (source: GitHub Actions) are already set up.

## Dashboard design decisions

- Four tabs: **Today** (recovery tiles: HRV, resting HR, sleep, overnight breathing compared with the 30-day baseline; 14-day HRV/RHR charts; that day's workouts or the latest one; this week vs last week), **Sleep**, **Activities**, **Fitness** (RHR and HRV with 7-day averages, running efficiency, swim pace, SWOLF, weekly training load, weight, fitness age, HR zones).
- **Swims use total time including rests** (`elapsedDuration`, via `actTime()` in `app.js`) everywhere: lists, details, weekly totals. Details also show swim time (`movingDuration`) and rest time. Swim pace is Garmin's pace while swimming.
- **Running efficiency** = metres per heartbeat (`averageSpeed × 60 / averageHR`); rising = fitter.
- Workout details end with "All other fields" so no Garmin value is ever hidden; calories, intensity minutes and Body Battery live there.
- Units and 12/24 h time follow the Garmin profile (`units`, `timeFormat` in the data). UI text is English.
- **Refresh button** (`refresh()` in `app.js`): reloads `data.enc`; if nothing is newer and the data is over 10 minutes old, it starts the workflow through the GitHub API (`workflow_dispatch`) and polls every 5 s until new data is published (about 2–3 min, gives up after 8), reporting failures from the run status. It shows a spinning icon and a status line under "Updated…". The GitHub key comes from `DATA.refresh`, which `encrypt.py` adds from the `DASHBOARD_REFRESH_TOKEN` secret. Without that secret the button only reloads the website copy. The installed app also re-checks `data.enc` when reopened after 5+ minutes.
- **UI preferences:** no "estimated"/caveat wording on cards; Readiness components and the fitness/strength signals sit behind `<details>` bubbles ("Show details", "Show fitness signals"); the Activities list shows the latest 7 with the rest behind "Show all".
- **VO2 max** (`vo2Points()`, `vo2Summary()`, `VO` constants; Fitness tab tiles + two charts; both are fitness signals in Aerobic status, swim weight 2, run weight 1). Garmin's API has no VO2 max. **Running** uses Garmin's method: VO2max = 0.2 x speed(m/min) / %HRR + 3.5 (grade-adjusted speed, HR reserve from that day's resting HR and the profile's max HR 194), eligible runs >= 10 min, >= 1 km, 55-95% HRR; `VO.runOffset` -2 matches the watch's 56-57 (the raw readings are not stored; the repo is public). Current = median of the last 6 weeks (long runs > 40 min excluded when enough others exist, because of heart-rate drift); trend = last 4 weeks vs the 4 before, +/-2% flat. **Swimming** cannot give a real VO2 max (swim oxygen cost depends on technique), so "Swim VO2 max" is a trend index: `VO.swimScale` x swim speed / %HRR (swim HR max 181, swims >= 1500 m), scaled so it reads like the running value. Only compared within the same pool length (25 m and 50 m swims read differently); a pool change starts a new comparison. Swims whose SWOLF is > 8% above your usual for that pool (slow, drill/technique-style sessions such as 17 Sep and 10 Oct) are excluded (`VO.swimTechSwolf`); the chart line is a rolling median of 5 swims (3 runs). Known limit: Garmin's API only gives whole-session averages (no laps), so rest-heavy interval sessions read higher than continuous ones; per-length data would need the FIT file download (a bigger change). It replaced the old swim-efficiency and running-efficiency signals/chart (same information, less accurate). To recalibrate: compare the displayed running value with the watch and adjust `VO.runOffset`.
- **Readiness (0-100)** (`readiness()`, `RD` constants): HRV 30% (3-night avg vs 42-day baseline, z-score), sleep score 25% (3-night avg), resting HR 15% (vs 42-day baseline), recent training 30% (loads decayed with a 1.4-day half-life vs normal daily load; `effLoad()` is the load used per workout). Needs >= 3 of the 4 parts, otherwise "No readiness". Garmin's own Training Readiness is not in the API, so tune `RD` by comparing with the watch. Today tab shows it above Aerobic status.
- **Aerobic status** counts the load of ALL cardio (every activity that isn't `strength_training`: swimming, running, cycling, walking, rowing, anything new); the Fitness tab shows a "Load by activity" breakdown of the last 28 days. The load tiles show the total including lifting as the large number (cardio-only in small; the ratio and status use cardio-only) (`totalLoad7`, `totalChronic`), which matches Garmin's own acute (7-day sum) and chronic (28-day sum / 4) load within a few points (checked 30 Oct: Garmin 640 / 494 vs 649 / 497). It is the training-status model restricted to non-strength activities (`isStrength()`); lifting is judged separately by Gym status. Estimated, not Garmin's.
- **Hevy / Strength** (optional, needs Hevy PRO; hidden entirely when `data.hevy` is absent). `fetch/fetch_hevy.py` (urllib, no new packages) downloads workouts + exercise templates and keeps only sets, exercise names and muscle groups (notes dropped); `fetch_garmin.py` stores them under `hevy` and a failure becomes a line in `errors`. No key = silently skipped. **The Hevy field names are written from the docs/wrappers and tested only against a fake server: when the first real key exists, run `python fetch/fetch_hevy.py` locally (prints counts only) and check the data before trusting it.** In `app.js`: `linkHevy()` pairs each Hevy workout with the overlapping Garmin strength session (±45 min) so `a.hevy` carries sets next to Garmin's heart rate; unmatched Hevy workouts still count (`strengthEvents()`). Gym load = hard sets × `HV.loadPerSet` (4, an estimate because Garmin under-counts lifting); `effLoad()` takes the larger of Garmin's and Hevy's. `gymStatus()` (`GS` constants; Overreaching needs 2.0× load, higher than cardio because lifting weeks are lumpier) judges load ratio plus a trend from best estimated 1RM (Epley, <= 12 reps) per lift, 28 days vs the 28 before (weight 2) and weekly hard sets. `freshness()` shows which muscle groups were worked hard in the last 2 days (in the Readiness card). Strength tab: gym status, week tiles, muscle balance, per-lift 1RM chart, PRs, and lifting vs HRV/RHR/swim comparison (needs >= 8 sessions per group, else "needs more data").
- **Hevy preview without Hevy:** open the live site with `#demo-hevy` appended (e.g. in Safari). `site/demo-hevy.js` then generates made-up lifts on the dates of the real Garmin strength sessions, labelled "Preview" and "Demo data". It is client-side only and never mixes into real data; it only applies when `data.hevy` is absent.
- **Training status is an estimate** (`trainingStatus()`, `TS` thresholds, `loadFocus()` in `app.js`), because Garmin's API gives no Training Status or VO2 max. No "Estimated" labels on the dashboard (the owner finds them noisy); they are still estimates internally. Load ratio = last 7 days of `activityTrainingLoad` ÷ (28-day load ÷ 4). Fitness trend is a weighted vote of 28-day vs previous-28-day medians, **led by swimming** (the owner is a swimmer): swim efficiency = metres per minute of moving time per heartbeat on swims ≥ 1500 m (weight 2, needs ≥ 4 swims per window), pool-length-normalised SWOLF, resting HR, HRV, and running efficiency (only with ≥ 6 runs in 8 weeks). Rules in order: No status, Overreaching, Detraining, Recovery, Unproductive, Peaking, Productive, Maintaining. Load focus splits load by HR zones 1–2 / 3–4 and anaerobic training effect (half weight); its target ranges are rough guides. Today tab shows a short card, Fitness tab the detail. Tune `TS` after comparing with the watch.
- Charts: colors come from CSS tokens in `style.css` (light + dark mode). Single-series charts get an end label; multi-series charts use a legend and the tap/hover tooltip instead. Every chart card has a "Show numbers" table.

## Layout

- `fetch/` – Python scripts (`fetch_garmin.py`, optional `fetch_hevy.py`, `encrypt.py`)
- `site/` – the dashboard (`index.html`, `app.js`, `style.css`, `sw.js` offline cache, `manifest.webmanifest`, `icons/`)
- `requirements.txt` – Python packages (Python 3.12+ required)
- `data/`, `site/data.enc` – generated, ignored by git

## Commands (Windows, from the repository folder)

```
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python fetch\fetch_garmin.py
.venv\Scripts\python fetch\encrypt.py
.venv\Scripts\python -m http.server 8000 -d site
```

Then open http://localhost:8000. (The browser only allows decryption on `localhost` or `https`.) If pip fails with an SSL certificate error on this PC, add `--use-feature=truststore`.

## Testing changes

- Test against real data without touching the real passphrase: run the fetcher, then `DASHBOARD_PASSPHRASE="test passphrase 1234" python fetch/encrypt.py`, copy `site/` to a scratch folder, move `data.enc` there, and serve that folder. Don't leave `site/data.enc` in the repo.
- Browser checks use Playwright with the installed Chrome (`p.chromium.launch(channel="chrome")`); it is installed in `.venv` for testing only and is not in `requirements.txt`. Check phone (390 px) and desktop widths, light and dark mode, and that the console shows no errors (including blocked-by-CSP messages).
- Headless `chrome --dump-dom/--screenshot` doesn't wait for the unlock, so use Playwright instead. Node.js and the `gh` CLI are not installed; check workflow runs via the public API (`https://api.github.com/repos/JoelBrglund/Garmin/actions/runs`).
- On this PC, Python output with emoji fails in the console; use `sys.stdout.reconfigure(encoding="utf-8")`.
- Stop a local test server by matching its command line (`http.server <port>`), never by killing all `python.exe` processes.

## Everyday tasks for the owner

- **Install on iPhone:** open the live site in Safari → Share → Add to Home Screen; enter the passphrase once inside the installed app (it has its own storage).
- **Change the passphrase:** update the `DASHBOARD_PASSPHRASE` secret, then Actions → Update dashboard → Run workflow. Use 5–6 random words.
- **Garmin key expired** (dashboard says "not updating", workflow fails): create a new key in Garmin Connect settings, update the `GARMIN_PERSONAL_API_KEY` secret and `../Garmin API.env`, re-run the workflow.
- **Set up or renew the refresh key** (the refresh button says the key has expired): GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token. Repository access: only `JoelBrglund/Garmin`. Permissions: **Actions: Read and write**, nothing else. Longest expiry allowed. Save it as the repository secret `DASHBOARD_REFRESH_TOKEN`, then Actions → Update dashboard → Run workflow.
- GitHub pauses scheduled workflows after 60 days without repo activity; pressing Run workflow re-enables it.

## Secrets and data

- The Git repository is the inner `Garmin/` folder; its parent folder is not under version control.
- The Garmin API key lives in `../Garmin API.env` (one line, the bare key), outside the repo. Never copy it into the repo, commit it, or print it. The fetcher reads it from `GARMIN_PERSONAL_API_KEY` or that file.
- Optional Hevy key: `../Hevy API.env` locally and the repository secret `HEVY_API_KEY` on GitHub (create it at hevy.com/settings?developer; needs Hevy PRO). Never print it or workout details in logs.
- On GitHub the key and the dashboard passphrase are repository secrets: `GARMIN_PERSONAL_API_KEY` and `DASHBOARD_PASSPHRASE`. The optional `DASHBOARD_REFRESH_TOKEN` (GitHub token, Actions read/write on this repo only) is placed inside the encrypted data so the refresh button can start the workflow; anyone with the passphrase can therefore start or cancel workflow runs, but cannot read secrets or change code. It is never written to `data/data.json`.
- Garmin Personal API keys expire (30 days to 1 year, chosen when created in Garmin Connect settings). When it expires the workflow fails and the dashboard shows "not updating"; create a new key and update the secret and the local file.
- Never commit `data/` or any unencrypted Garmin data. The repo is public (needed for free GitHub Pages); only encrypted data is published.
- If an `.env` file is ever added inside the repo, make sure `.gitignore` covers it first.

## Security hardening (keep these when making changes)

- **Content Security Policy** (`<meta http-equiv="Content-Security-Policy">` in `site/index.html`): the page may only load scripts, styles, images and data from its own site, plus `https://api.github.com` for the refresh button. When adding any outside resource (CDN library, web font, external API), add its origin to the matching directive (`script-src`, `style-src`/`font-src`, `connect-src`, `img-src`); otherwise the browser silently blocks it. Keep JavaScript in `.js` files: inline `<script>` blocks and `onclick="..."` attributes are blocked.
- **Workflow actions are pinned to commit SHAs** with the version as a comment. To upgrade one, look up the new tag's commit (`git ls-remote https://github.com/actions/<name> refs/tags/<tag>`) and replace both the SHA and the comment. Pin any newly added action the same way.
- **Python packages are pinned** with `==` in `requirements.txt`. Pin new ones too.
- **Encryption strength**: `ITERATIONS` in `fetch/encrypt.py` (2,000,000 PBKDF2 rounds). The value is stored in `data.enc`, so the browser needs no change if it is adjusted.
- Text from Garmin (activity names etc.) must go through `esc()` before being inserted as HTML.
- GitHub Actions logs are public: scripts may print counts and error types, never health data, the key or the passphrase.
- The remembered passphrase is stored in the browser's `localStorage` ("Remember on this device"); the lock button forgets it.

**Security checklist** (re-run after bigger changes):
1. Key not in code or history: search `git log --all -p` for the start of the key (without printing the key).
2. `https://joelbrglund.github.io/Garmin/data.enc` is ciphertext; `/data/data.json` returns 404.
3. Browser DevTools → Network: every request goes to `joelbrglund.github.io`, or to `api.github.com` after pressing refresh.
4. A private browser window shows only the lock screen; a wrong passphrase is rejected.
5. The latest Actions log contains nothing personal.

## Garmin Personal API notes

- Pull only, read only. Bearer token lasts 24 h and is created from the key on each run.
- Range limits per request: daily summaries/HRV 180 days, sleep and Body Battery 28 days. The fetcher splits ranges.
- VO2 max and training status are not provided by this API.
