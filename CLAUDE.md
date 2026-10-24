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

## Layout

- `fetch/` – Python scripts (fetch + encrypt)
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

## Secrets and data

- The Git repository is the inner `Garmin/` folder; its parent folder is not under version control.
- The Garmin API key lives in `../Garmin API.env` (one line, the bare key), outside the repo. Never copy it into the repo, commit it, or print it. The fetcher reads it from `GARMIN_PERSONAL_API_KEY` or that file.
- On GitHub the key and the dashboard passphrase are repository secrets: `GARMIN_PERSONAL_API_KEY` and `DASHBOARD_PASSPHRASE`.
- Garmin Personal API keys expire (30 days to 1 year, chosen when created in Garmin Connect settings). When it expires the workflow fails and the dashboard shows "not updating"; create a new key and update the secret and the local file.
- Never commit `data/` or any unencrypted Garmin data. The repo is public (needed for free GitHub Pages); only encrypted data is published.
- If an `.env` file is ever added inside the repo, make sure `.gitignore` covers it first.

## Security hardening (keep these when making changes)

- **Content Security Policy** (`<meta http-equiv="Content-Security-Policy">` in `site/index.html`): the page may only load scripts, styles, images and data from its own site. When adding any outside resource (CDN library, web font, external API), add its origin to the matching directive (`script-src`, `style-src`/`font-src`, `connect-src`, `img-src`); otherwise the browser silently blocks it. Keep JavaScript in `.js` files: inline `<script>` blocks and `onclick="..."` attributes are blocked.
- **Workflow actions are pinned to commit SHAs** with the version as a comment. To upgrade one, look up the new tag's commit (`git ls-remote https://github.com/actions/<name> refs/tags/<tag>`) and replace both the SHA and the comment. Pin any newly added action the same way.
- **Python packages are pinned** with `==` in `requirements.txt`. Pin new ones too.
- **Encryption strength**: `ITERATIONS` in `fetch/encrypt.py` (2,000,000 PBKDF2 rounds). The value is stored in `data.enc`, so the browser needs no change if it is adjusted.
- Text from Garmin (activity names etc.) must go through `esc()` before being inserted as HTML.

## Garmin Personal API notes

- Pull only, read only. Bearer token lasts 24 h and is created from the key on each run.
- Range limits per request: daily summaries/HRV 180 days, sleep and Body Battery 28 days. The fetcher splits ranges.
- VO2 max and training status are not provided by this API.
