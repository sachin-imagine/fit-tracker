# Sachin Fit Tracker

Personal AI fitness tracker & coach. Read `DESIGN.md` first for the architecture and reasoning — this file is just the "how to stand it up / upgrade it" steps.

Everything here is free: Google Apps Script, Sheets, and Drive have no cost on a personal account, GitHub Pages hosting is free for a public repo, and sign-in is a plain emailed 6-digit code — no Google Cloud project, no OAuth Client ID, no billing anywhere.

> **Note on this copy of the repo:** the cloud workspace building this app was reset between sessions and lost its local copy of everything past the very first Phase 1 drop. Every file here has been rebuilt from the detailed design/status notes rather than diffed byte-for-byte against what's already pasted into your Apps Script project — the *behavior* matches what you've been testing, but if you're hand-comparing files, expect some reformatting. Replace files wholesale rather than trying to hand-merge.

### What's new in this drop
- Sign-in, code verification, and the approval reminder now go over GET instead of POST — see the `/u/N/` troubleshooting entry below for why. This is the durable fix for "verification only works after removing /u/1/".
- The Profile screen is a readable summary instead of a raw JSON dump, and has an editable **display name** (useful since the auto-generated name from an email address can look odd).
- The dashboard has a **"This week"** card — a weight-trend summary built from your Weight Log entries. It'll get more to say once Phase 2/3 add food and workout logging.

## What's in this folder

```
DESIGN.md          - architecture, schema, and limitations write-up (read this first)
apps-script/       - the entire backend; paste into your Apps Script project
pwa/               - the frontend; push to GitHub Pages
```

## First-time setup (skip this if Phase 1 is already live for you)

### Step 1 — Create the Apps Script project

1. Go to script.google.com → **New project**.
2. Name it something like "Fit Tracker Backend".
3. Create each file from `apps-script/` in the project with the exact same name, and paste in its contents: `Config.gs`, `SheetService.gs`, `Auth.gs`, `Profile.gs`, `Code.gs`, `Setup.gs`.
4. Open **Project Settings** (gear icon) → check "Show appsscript.json" → paste the contents of `apps-script/appsscript.json` into that manifest file.

### Step 2 — Run the one-time setup

1. Select `runSetup` from the function dropdown and click **Run**. Approve the permission prompts (Sheets, Drive, and Mail access).
2. Open **View → Logs** and copy the `Spreadsheet ID` and `Root folder ID` it prints.
3. Open **Project Settings → Script Properties** and add:
   | Property | Value |
   |---|---|
   | `SPREADSHEET_ID` | the spreadsheet ID from the log |
   | `ROOT_FOLDER_ID` | the root folder ID from the log |
   | `API_SHARED_TOKEN` | any random string you make up — this now only protects the owner's Approve/Reject email links |

   (Leave `LLM_API_KEY` unset — not needed until Phase 2.)
4. `runSetup` also seeds the `Settings` sheet's `owner_email` row and an auto-approved `Users` row for you, using whichever Google account ran the script.

### Step 3 — Deploy the backend as a web app

1. **Deploy → New deployment** → Type: **Web app** → Execute as: **Me** → Who has access: **Anyone**.
2. Click **Deploy**, authorize if asked, and copy the **Web app URL** text shown *in that dialog* (ends in `/exec`). Don't substitute whatever's in your browser's address bar — see the troubleshooting note about `/u/N/` below.
3. Test it: paste `https://script.google.com/macros/s/XXXX/exec?action=health` into a browser tab. You should see `{"ok":true,"data":{"status":"ok",...}}`.

Whenever you edit any `.gs` file later: **Deploy → Manage deployments → Edit (pencil) → New version → Deploy** — saving alone does not push changes live.

### Step 4 — Configure and host the frontend

1. Open `pwa/js/config.js` and set `APPS_SCRIPT_URL` to the web app URL from Step 3.
2. Push the contents of `pwa/` to a public GitHub repo (root or `/docs`, matching your Pages setting).
3. **Settings → Pages**, set Source to that branch/folder, save. Open the resulting `https://yourusername.github.io/...` URL.

## Upgrading to the current version — emailed login code, family accounts, multi-select goals

This replaces the old shared-token model with real per-person login, adds a family-approval workflow, and lets a profile hold more than one fitness goal. See DESIGN.md section 11 for the full reasoning. If you already have a live Phase 1 spreadsheet with real data in it, do these steps in order.

### Step A — Update the Apps Script backend

1. Update `Config.gs`, `SheetService.gs`, `Profile.gs`, `Code.gs`, `Setup.gs` with the versions in this drop, and add the new `Auth.gs` file.
2. Script Properties stay as they are — `API_SHARED_TOKEN` is unchanged, just repurposed as the admin secret for approval emails.
3. Run **`runMigrationAddUsers`** once (safe to re-run — it skips anything already migrated). This retrofits the `UserEmail` column onto your existing per-user sheets, backfills existing rows with your own email, and creates the `Users`/`LoginCodes`/`Sessions` sheets.
4. Run **`runMigrationAddReminderColumn`** once — adds the `LastReminderAt` column the "Remind approver" feature needs to the `Users` sheet. (New in this round; skip only if you're setting this up completely fresh, since `runSetup` already includes this column for new installs.)
5. Run **`testMailPermission`** once and confirm you got a "mail permission OK" email.
6. **Deploy → Manage deployments → Edit (pencil) → New version → Deploy.** The web app URL itself doesn't change.

No new sheet migration is needed this round — `getWeeklySummary` and `updateName` only add new backend actions, they don't touch the sheet schema.

### Step B — Update the frontend

1. `pwa/js/config.js` only needs `APPS_SCRIPT_URL` — there's no separate token field anymore.
2. Replace all of `pwa/index.html`, `pwa/js/app.js`, `pwa/js/api.js`, `pwa/css/style.css`, and `pwa/service-worker.js` with the versions in this drop.
3. Commit and push. Give Pages a minute to rebuild, and see the note below about the service worker cache if the page seems to ignore your update.

### Step C — Test it end to end

1. Open the GitHub Pages URL — briefly shows a loading spinner, then either the email-entry screen (first time) or straight to your dashboard (if you still have a valid session from before).
2. Sign in with your own (owner) email → code arrives → entering it auto-advances straight to setup/dashboard, no manual reload needed. This request is a GET now specifically so it survives the `/u/N/` redirect quirk — see troubleshooting below if it still gives you trouble.
3. In a private/incognito tab, sign in with a different email to test the family flow → it should land on "Almost there ⏳" automatically (no scrolling needed) and you should get an approval-request email.
4. Click **Approve** — confirmation page, and that address gets a follow-up email. Back in that private tab, the pending screen should pick up the approval **on its own within ~15 seconds** (it polls automatically) — or tap **Check now** for an immediate check.
5. If you (deliberately, for testing) don't approve right away, try the **Remind approver** button on the pending screen — you should get a second "Reminder:" email; tapping again immediately should show a "please wait" message instead of sending another.
6. On setup, confirm you can tick multiple goal checkboxes and both save and reload correctly.
7. On the dashboard, confirm the **"This week"** card shows something sensible (it reads Weight Log entries from the last 7 days — log a weight entry via Setup or wait for Phase 3's weight-log screen to test with real data).
8. On the Profile tab, try editing your **display name** and tapping Save — it should update immediately everywhere "Welcome, ___" appears, and survive a reload.
9. Try **Log out** (on the Profile tab, and also present on the pending/rejected screens) — should return you cleanly to the sign-in screen.

## Milestone checklist

- [x] M1 — `runSetup` ran successfully; sheet tabs + Drive folders exist
- [x] M2 — `?action=health` returns `ok:true` from a browser
- [x] M3 — Setup form saves a profile and reloading fetches it back
- [x] M4 — Home Screen install opens full-screen with the app icon, no browser chrome
- [ ] v2 — email-code sign-in, family approval (with reminders), multi-select goals, seamless reload — **retest this round's fixes end to end**

Once the v2 checklist item above is confirmed, we move on to Phase 2 (food photo tracking).

## Troubleshooting

- **First step for almost any weird/inconsistent frontend behavior: check the build markers.** Open the browser console (F12 → Console) and reload. `app.js` and `api.js` each log a line like `Fit Tracker app.js — build: email-code-auth-v4 ...` on load. If you don't see both, or one shows an older build tag than the other, one of the five `pwa/` files is stale — re-copy all five fresh rather than editing just one you think changed.
- **The page seems to ignore an update you just pushed** — the service worker caches the app shell by name (`CACHE_NAME` in `service-worker.js`); it only re-checks its cache when the service worker file's own bytes change. This drop bumps it to `fit-tracker-shell-v4`. If you edit frontend files again later without changing that constant, browsers may keep serving the old cached copy — bump the version string (e.g. `-v5`) any time you update `pwa/` files, and/or do a hard refresh.
- **"Incorrect code" even though you copied it right** — codes are single-use and expire in 10 minutes; if you requested a second code, only the newest is valid.
- **Login code or approval email never arrives** — run `testMailPermission` from the editor to confirm mail sending is authorized; check spam; confirm there's no typo in the address; confirm `owner_email` in the `Settings` sheet is correct.
- **You (the owner) got stuck on the pending screen** — `owner_email` in `Settings` doesn't match the email you signed in with; fix that row, or edit your row in `Users` to `Status = approved` directly.
- **Signed in but the app forgets you after closing the browser** — some browsers (Safari private mode, aggressive "clear on close" settings) clear `localStorage`; sign in again, or check the browser's site-data settings.
- **Screens don't switch — you have to scroll to see the next one** — this was a real CSS bug (fixed): `.screen-center` and `#bottom-nav` set `display: flex` unconditionally, which silently overrode the `hidden` attribute regardless of which screen it was on. Fixed with a global `[hidden] { display: none !important; }` rule in `style.css`. Make sure you're on the latest `style.css`.
- **Clicking Approve/Reject in the owner's email lands on a Google Drive "unable to open the file" error** — a Google multi-account quirk, not a broken link: if the opened tab's URL has `/macros/u/1/s/...` (or `/u/2/`, etc.) instead of `/macros/s/...`, Google is resolving it against the wrong signed-in account slot. Edit the address bar to remove the `/u/N/` segment and press Enter.
- **Verifying a code kept failing even after removing `/u/1/` from `config.js`, or it keeps coming back** — this turned out to be more fundamental than a one-time copy-paste mistake: `script.google.com`'s `/exec` URL can redirect the *actual request* through a `/u/N/`-tagged path depending on which Google account is active in the visiting browser, regardless of what URL you put in `config.js`. Per the HTTP/Fetch spec, a redirect on a **POST** silently turns it into a bodiless **GET** — dropping the emailed code entirely — while a redirect on a **GET** just re-fetches the same query string and works fine. That's exactly why status checks (GET) kept working while verifying a code (previously POST) didn't. The durable fix, already in this drop: sign-in, code verification, and the approval reminder are now sent as **GET** requests instead of POST, so they survive this redirect no matter which account slot Google routes through. If you still see trouble after updating to this version, that would be a genuinely new symptom worth flagging back — the GET-based approach should be immune to the `/u/N/` issue by construction.
- **The verify-code button used to give no feedback and stayed clickable while checking** — fixed: it now disables and shows "Verifying..." immediately, and only re-enables on an actual error.
- **Reloading used to flash the email-entry screen for a moment even when you were already signed in** — fixed: there's now a neutral loading screen shown by default whenever a saved session exists; it only switches to sign-in once it's actually confirmed you're signed out, so a valid session never gets interrupted by a stray flash of the wrong screen.
- **A network hiccup used to force you to re-enter your email from scratch** — fixed: the app used to treat *any* failed request the same as "not signed in" and wiped the session. Now it only does that when the backend explicitly says the session is invalid/expired; other failures (including the `/u/N/` issue above) show a Retry screen with your session left intact.
- **The pending-approval screen never updated on its own after the owner approved** — fixed: it now polls automatically every ~15 seconds while you're on that screen, plus there's a manual "Check now" button.
- **The owner missed or ignored the first approval-request email and there was no way to nudge them** — fixed: the pending screen now has a "Remind approver" button (rate-limited to about once every 5 minutes) that resends the same Approve/Reject email marked as a reminder.
- **CORS error in the browser console** — make sure `api.js` wasn't modified to send `Content-Type: application/json`; it must stay `text/plain` for POST requests.
- **"Add to Home Screen" doesn't go full-screen** — confirm you're opening the GitHub Pages URL directly (not through an in-app browser like Instagram/Twitter's), and that `manifest.json` is reachable at `<your-pages-url>/manifest.json`.
