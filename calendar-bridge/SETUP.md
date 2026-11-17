# Google Calendar sync: one-time setup (about 10 minutes)

The dashboard keeps your next 7 days of training in Google Calendar as separate all-day events, one per session (e.g. **Lower lift 60 min** and **Swim 60 min**), in their own calendar called **Training** so they stay apart from your own calendar.
It happens by itself whenever you change the plan. The only thing you do is this setup, once.

Why this way: the dashboard is a static website, which cannot safely hold a long-lived Google login.
So a tiny script runs inside **your own Google account**, and the dashboard just tells it which days have training.
The script can only do two things: add/remove its own "Training" events, and check the connection.
It cannot read your other events (it never looks at events it did not create).

## 1. Create the script

1. Go to <https://script.google.com> (signed in to the Google account whose calendar you want) and press **New project**.
2. Delete the sample code and paste in everything from `calendar-bridge/Code.gs`.
3. Near the top, replace `PASTE-A-LONG-RANDOM-SECRET-HERE` with a long random password (30+ characters, letters and numbers; make one with a password manager). **Keep a copy**, you need it in step 3.
4. Optional: to use a separate calendar instead of your main one, set `CALENDAR_NAME` to e.g. `"Training"`. Leave `""` for your main calendar.
5. Press **Save** (the disk icon).

## 2. Publish it

1. Press **Deploy → New deployment**, click the gear and choose **Web app**.
2. *Execute as:* **Me**. *Who has access:* **Anyone**. (The secret from step 1 is what keeps strangers out.)
3. Press **Deploy**. Google asks you to authorise: choose your account, **Advanced → Go to (project) → Allow**. This is you allowing your own script to edit your own calendar.
4. Copy the **Web app URL** (it starts with `https://script.google.com/macros/s/`).

If you edit the code later, use **Deploy → Manage deployments → edit → New version**, otherwise the old code keeps running.

## 3. Give the dashboard the URL and secret

In GitHub, repository **Settings → Secrets and variables → Actions → New repository secret**. Add two:

| Name | Value |
|---|---|
| `GOOGLE_CALENDAR_URL` | the Web app URL from step 2 |
| `GOOGLE_CALENDAR_SECRET` | the secret from step 1 |

Then **Actions → Update dashboard → Run workflow**. They are stored inside the encrypted dashboard data, never in the public site.

## 4. Connect

Open the dashboard (reload it once the workflow finished), go to **Schedule**, open **Google Calendar** at the bottom,
press **Test connection** (it should say "Connected to calendar …") and then **Sync now**.
From then on it updates by itself.

## Good to know

- **It only touches its own events.** Every event it makes carries a hidden mark. Your own events, even ones titled "Training", are never changed or deleted. If you delete one of its events by hand, the next sync puts it back.
- **Rolling 7 days:** today plus the next six. Events for days that fall out of the plan are removed; past days are left alone.
- **What counts as a training day:** a day with at least one session that is not skipped and not optional (a day you already trained still counts). Each session is its own event, titled with its planned minutes as on the Schedule page, and it updates when you change the plan.
- **Own calendar:** the first sync creates a calendar called Training. You can hide it, recolour it or change its notifications from "My calendars" in Google Calendar. On an iPhone, make sure it is ticked under Calendars in the Calendar app. To use your main calendar instead, set `CALENDAR_NAME` to `""` in the script.
- **After updating the script code:** Deploy → Manage deployments → pencil → Version: New version → Deploy (the web address stays the same).
- **The plan lives on each device.** If you use the dashboard on both phone and computer, the calendar follows whichever device changed the plan last. A device that has never synced does not start on its own, so opening the dashboard on a new device will not overwrite anything.
- **Failed sync (no internet, Google busy):** it retries automatically (after 5 s, 15 s, 45 s, 2 min, then every 5 min) and straight away when you are back online. A wrong secret or a wrong deployment setting is shown on the card instead of retrying forever.
- **Change the secret:** edit it in the script (new version) and in the GitHub secret, then re-run the workflow.
- **Turn it off:** delete the two GitHub secrets and re-run the workflow. Existing events stay; delete the script project to stop it completely.
