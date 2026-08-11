# Personal AI Fitness Tracker & Coach — Design Document

Owner: Sachin Kumar · Version: Phase 1 · Date: 2026-08-08

This document is the output requested before writing any code: a review of the requirements, the technical limitations discovered, the final architecture, the data schemas, and the milestone breakdown. Only **Phase 1** is implemented in this drop; later phases build on this foundation once Phase 1 is tested.

---

## 1. Requirements Review

The brief (sections 1–21) is internally consistent and the requested stack — Apps Script + Sheets + Drive + an LLM API, fronted by a PWA — is realistic for a single-user, low-volume personal app at effectively zero infrastructure cost. Three things stood out during review that shape the architecture below:

- The app is explicitly meant to be a personal journal, not a commercial product — so Phase 1 deliberately skips auth/multi-user concerns, rate limiting for other users, and anything that only matters at scale.
- AI is explicitly a *recommender*, never the system of record — every AI output must land as a proposal a human (Sachin) approves, and the Sheets remain the source of truth.
- "Feels like a real app on iPhone" is a hard requirement, not a nice-to-have — this drove the one architectural change from the original stack description (see below).

## 2. Technical Limitations Identified

**Apps Script web apps cannot host a real PWA.** When Apps Script serves HTML via `HtmlService`, the page is rendered inside a sandboxed Google iframe on a `googleusercontent.com` domain (with the outer page on `script.google.com` redirecting into it). This breaks the three things "feels like a real app" depends on:
- `manifest.json` + "Add to Home Screen" needs a top-level page Safari can inspect; an iframed/redirected page doesn't reliably qualify, and iOS home-screen icons/standalone mode become unreliable.
- Service workers generally cannot register inside that sandbox, so there's no offline shell caching.
- Camera/file input (`<input capture>`) works better as a plain top-level page than inside Google's wrapper, which has had intermittent issues with permissions in embedded contexts.

**Resolution:** split hosting from backend. The PWA (HTML/CSS/JS, manifest, service worker, icons) is static and hosted for free on **GitHub Pages** — which you're already using for source control, so this adds no new service. Apps Script is used purely as a **JSON API + data layer** (Sheets as DB, Drive as file store), called from the PWA via `fetch()`. This keeps every piece of the original stack (Apps Script, Sheets, Drive, GitHub) and costs nothing extra; it just assigns "serve the UI" to the tool actually built for it.

**CORS between GitHub Pages and Apps Script.** Apps Script web apps don't let you set custom CORS headers, so cross-origin calls must be "simple requests" (avoid `Content-Type: application/json` triggering a preflight `OPTIONS`, which Apps Script doesn't handle). The client sends `POST` with `Content-Type: text/plain;charset=utf-8` and a JSON string body; `doPost` parses `e.postData.contents` as JSON server-side. This is a well-established workaround and is used throughout the backend.

**6-minute execution ceiling per Apps Script run.** Any video processing must happen client-side before upload — the browser extracts a handful of JPEG frames from the recorded/selected video via `<video>` + `<canvas>`, and only those frames (not the raw video's processing) are sent for AI analysis. The raw video file itself is uploaded once to Drive for the 7-day retention window.

**Sheets has no real transactions.** For a single user this is low-risk, but writes still use Apps Script's `LockService` to avoid two near-simultaneous requests corrupting a row.

**Daily quotas are generous but finite.** Consumer Google accounts get 20,000 `UrlFetch` calls/day and 6-minute script runtime — orders of magnitude beyond what one person logging meals and workouts will use. Documented in case Phase 4/5 usage patterns change.

**AI estimates are estimates.** Every AI-derived number (calories, macros, form score) is stored with a `source` flag (`ai_estimate` vs `user_confirmed`/`user_edited`) and a `confidence` field, and the UI always shows an editable confirmation step before saving — never auto-saves an AI guess as fact.

## 3. Final Architecture

```
iPhone Safari (installed PWA, GitHub Pages, HTTPS, static)
        │  fetch() — text/plain JSON body, no custom headers
        ▼
Google Apps Script Web App  (doGet / doPost — the only backend)
        │
        ├── Google Sheets  — structured data (profile, logs, plans, history)
        ├── Google Drive   — food photos, training videos (7-day TTL), reports
        └── LLM API call   — Claude Haiku (default) for vision + text analysis
                │
                ▼
        Structured JSON back from the LLM
                │
                ▼
        Apps Script validates/normalizes → writes to Sheets → returns JSON to PWA
```

Design rule carried through every endpoint: **Data → Rules/Metrics → AI → Recommendation → User approval → Sheets.** The AI never writes directly to a sheet; every AI response comes back to the client as a proposal, the client shows a confirm/edit screen, and only the user's confirmed action triggers the write.

The OpenAI/Claude API key lives only in Apps Script's `PropertiesService` (server-side script properties), never in any file served to the browser.

## 4. Google Sheets Schema

One spreadsheet, created by the Phase 1 setup script, with these tabs:

**Profile** — single-row (or versioned) record: `Timestamp, Age, HeightCm, StartWeightKg, TargetWeightKg, Goal, TrainingExperience, WorkoutDaysPerWeek, PreferredWorkoutDurationMin, AvailableEquipment, DietaryPreferences, TypicalSchedule, Notes`

**Goals** — `Date, GoalType, TargetValue, TargetDate, Status, Notes` (calorie target, protein target, weight target, etc. — one row per active goal so history is kept when goals change)

**Daily Log** — one row per day, the rollup the dashboard reads: `Date, WeightKg, CaloriesConsumed, CalorieTarget, ProteinG, ProteinTargetG, CarbsG, FatG, WaterMl, WaterTargetMl, Steps, SleepHrs, EnergyLevel, WorkoutCompleted, DailyScore, Notes`

**Meals** — one row per logged meal: `MealId, Date, Time, PhotoDriveFileId, ItemsJSON, TotalCalories, TotalProteinG, TotalCarbsG, TotalFatG, ConfidenceLevel, Source(ai_estimate/user_edited), Notes`

**Foods** — the personal food database: `FoodId, Name, ServingDescription, Calories, ProteinG, CarbsG, FatG, TimesUsed, LastUsed` — seeded by you, and appended to automatically the first time a corrected meal introduces a new item, so the AI increasingly uses known foods instead of re-guessing.

**Workouts** — one row per set logged: `Date, SessionId, Exercise, MuscleGroup, SetNumber, Reps, WeightKg, DurationSec, RestSec, Notes`

**Exercises** — reference table: `ExerciseId, Name, MuscleGroup, Equipment, DefaultRestSec, Notes`

**Workout Plan** — the current accepted plan: `Day, Focus, Exercise, TargetSets, TargetReps, TargetWeightKg, Notes, LastModified`

**Weight Log** — `Date, WeightKg, Notes` (kept separate from Daily Log so weight trend logic is simple to query independently)

**Training Videos** — `VideoId, Date, Exercise, DriveFileId, DriveFolderPath, FormScore, GoodPoints, Corrections, NextSessionNote, UploadedAt, DeleteAfter, Deleted(bool)`

**AI Insights** — append-only log of every AI output shown to the user: `Date, Type(daily/weekly/plan_suggestion), ContentJSON, UserAction(accepted/rejected/edited/none), Notes` — this is what makes weekly reviews and "did the AI's advice help" analysis possible later.

**Settings** — `Key, Value` (calorie/macro targets, water target, model name in use, feature flags) — read by the backend on every request so behavior can be tuned without redeploying code.

## 5. Google Drive Structure

```
Sachin Fit Tracker/
├── Food Photos/YYYY/MM-DD/
├── Training Videos/YYYY/MM-DD/        (auto-deleted after 7 days by a time trigger)
├── Progress Photos/YYYY-MM-DD/
└── Reports/
    ├── Weekly/
    └── Monthly/
```

Created once by the Phase 1 setup script; subsequent date subfolders are created on demand by the upload endpoints.

## 6. Apps Script Project Structure

- `Config.gs` — spreadsheet ID, folder IDs, sheet name constants, model name — all read from `PropertiesService` so nothing is hardcoded.
- `Code.gs` — `doGet`/`doPost` router; dispatches to handlers by an `action` field in the request; wraps every response in a consistent `{ok, data, error}` JSON envelope; sets up CORS-safe plain-text responses.
- `SheetService.gs` — generic helpers (`getSheet`, `appendRow`, `readRows`, `updateRowById`) so handler code never touches `SpreadsheetApp` directly.
- `Profile.gs` — Phase 1 handlers: `getProfile`, `saveProfile`, `getSettings`.
- `Setup.gs` — one-time `runSetup()` you execute manually once from the Apps Script editor; idempotent (safe to re-run) — creates all 12 sheet tabs with headers, creates the Drive folder tree, and writes default `Settings` rows.
- `appsscript.json` — manifest (timezone, web app access config).

Later phases add `Meals.gs`, `Workouts.gs`, `Ai.gs`, `Videos.gs`, `Coach.gs`, `Cleanup.gs` (the 7-day video-deletion trigger) without touching Phase 1 files.

## 7. AI API Interaction

- Default model: **Claude Haiku 4.5** (vision-capable, cheapest per-call cost) for food-photo analysis and form-check frame analysis; the model name is a `Settings` value, not hardcoded, so it can be swapped to Sonnet or an OpenAI model later without a code change beyond the request-shape adapter.
- Every AI call requests a **strict JSON schema** back (items, quantities, macros, confidence, or form score/observations) — never freeform prose that the backend has to parse. The prompt states the required JSON shape explicitly and the backend validates the shape before using it.
- The personal `Foods` sheet is included in the prompt context (as a compact lookup list) so the model prefers known foods over re-estimating from scratch.
- AI responses never write to Sheets directly — they return to the client as a proposal object; the client's confirm screen is what triggers the actual save call.

## 8. PWA Structure

- Static, single-origin (GitHub Pages), so `manifest.json` and a service worker (app-shell caching only, not data — data must always be fresh) work normally.
- `index.html` is a lightweight shell; screens are shown/hidden panels rather than a heavy router, keeping the app fast on a phone.
- Bottom navigation: Today · Log · Coach (later phases) · Profile.
- Photo/video capture uses `<input type="file" accept="image/*" capture="environment">` (and `accept="video/*"` for form-check videos later) — the most reliable cross-iOS-version approach, avoiding `getUserMedia` complexity for Phase 1.
- All calls to the backend go through one `api.js` module with the Apps Script web app URL as its only config value.

## 9. Security & Privacy Considerations

- LLM API key stored only in Apps Script `PropertiesService`; never present in any file served to the browser or committed to GitHub.
- The Apps Script web app is deployed as "Execute as: Me / Access: Anyone with the link" (Apps Script has no finer-grained per-user auth for a script not tied to a Google Workspace org) — the URL itself is the shared secret. Phase 1 adds a simple shared-secret token (`Settings` value) that the PWA sends on every request and the backend checks, so a leaked/guessed URL alone isn't enough.
- All personal data (food photos, videos, logs) stays in Sachin's own Google Drive/Sheets — no third-party database.
- Training videos are deleted from Drive after 7 days by an automated trigger; only the derived analysis (score, notes) persists.
- GitHub repo holds only frontend code and Apps Script source (via `clasp`, optional) — no credentials, no personal data.

## 10. Milestones (Phase 1 only, per the requested incremental approach)

1. **M1 — Data foundation:** run `Setup.gs` once; verify all 12 sheet tabs and the Drive folder tree exist with correct headers.
2. **M2 — Backend reachable:** deploy the Apps Script web app; confirm `doGet` health-check and `doPost` echo both return the expected JSON envelope from a browser `fetch()`.
3. **M3 — Profile round-trip:** PWA setup screen collects the profile fields (age, height, weight, goal, etc.), posts to the backend, and the `Profile` sheet row appears correctly; reloading the app fetches it back and skips setup.
4. **M4 — Installable shell:** PWA is pushed to GitHub Pages, passes Chrome's installability checks, and "Add to Home Screen" on the iPhone produces a full-screen icon with no browser chrome.

Later phases (food tracking, workouts, video form-check, AI coach, polish) are intentionally out of scope until these four milestones are confirmed working end-to-end.

## 11. v2 Update — Login, Multi-User (Family), and Multi-Select Goals

Once Phase 1 was confirmed working, the app was extended with real per-person sign-in, family/multi-user support with owner approval, and multi-select fitness goals. This section documents the final design and why it landed where it did.

**Why not Google Sign-In.** The original plan was Google Identity Services (Sign in with Google), verifying the ID token server-side against `https://oauth2.googleapis.com/tokeninfo`. This was abandoned because creating an OAuth Client ID in Google Cloud Console required adding a credit card for identity verification — a hard blocker given the "genuinely free" constraint. The replacement needed to stay entirely inside what Apps Script already offers for free: Sheets, Drive, and `MailApp`.

**Final auth model — emailed one-time code + session token.**
1. `requestLoginCode_(email)` generates a random 6-digit code, stores it in a `LoginCodes` sheet with an expiry (`LOGIN_CODE_TTL_MINUTES`), and emails it via `MailApp`. Rate-limited per email (`LOGIN_CODE_RESEND_COOLDOWN_SECONDS`) so repeated taps can't spam an inbox.
2. `verifyLoginCodeAndCreateSession_(email, code)` checks the code (single-use, deleted on success or expiry), then calls `getOrCreateUserRecord_` and mints a session token (`Utilities.getUuid()`) stored in a `Sessions` sheet with a 30-day expiry (`SESSION_TTL_DAYS`).
3. The frontend keeps the session token in `localStorage` and sends it as `sessionToken` on every request. `requireApprovedSession_` (used by every protected action) resolves the token, checks the matching `Users` row's `Status`, and throws an error carrying `.status` = `'pending'` / `'rejected'` / `'signed_out'` so the frontend can route to the right screen without parsing message text.

**Owner-approval workflow.** The first time an email signs in, `getOrCreateUserRecord_` creates a `Users` row. If the email matches the `owner_email` Setting (seeded from `Session.getEffectiveUser().getEmail()` when `runMigrationAddUsers`/`runSetup` runs), it's auto-approved. Otherwise it's marked `pending` and `sendApprovalRequestEmail_` emails the owner Approve/Reject links (`doGet?action=approveUser`, protected by the same random string as `API_SHARED_TOKEN`, now repurposed as an admin secret for just this). Clicking either link updates `Status` and emails the requester a decision notice.

**Missed-approval reminder (added after the owner missed a first approval email in testing).** A still-pending user can tap "Remind approver" on the pending screen, which calls `handleRequestApprovalReminder_`. This re-sends the same approval email (marked as a reminder) but only if `APPROVAL_REMINDER_COOLDOWN_SECONDS` (5 minutes) has elapsed since the `Users` row's `LastReminderAt` (falling back to `RequestedAt` if never reminded) — so a forgotten first email is recoverable without letting the button spam the owner.

**Multi-tenancy.** One spreadsheet serves everyone. Every per-user sheet (`Profile`, `Goals`, `Daily Log`, `Meals`, `Workouts`, `Workout Plan`, `Weight Log`, `Training Videos`, `AI Insights`) got a leading `UserEmail` column; `Foods`, `Exercises`, and `Settings` stay shared/global. `runMigrationAddUsers()` retrofits this onto an already-live Phase 1 spreadsheet (idempotent — skips sheets already migrated) and creates the three new auth sheets; a fresh install gets all of this from `runSetup()` directly.

**Multi-select goals.** The setup form's single `<select>` became a `checkbox-grid` of `name="goals"` checkboxes; the frontend collects them with `formData.getAll('goals')` and the backend joins them into one comma-separated string in the `Profile` sheet's `Goals` column — no schema change beyond the header rename from `Goal` to `Goals`.

**UX hardening after real-world testing.** Several rounds of testing surfaced issues that needed fixing beyond the core auth logic:
- A CSS cascade bug where `.screen-center` and `#bottom-nav` set `display: flex` unconditionally, which silently overrode the `hidden` attribute on every screen using them (author CSS always beats the browser's default `[hidden]` handling regardless of selector specificity). Fixed with a global `[hidden] { display: none !important; }` rule.
- The resend-code countdown originally displayed on the "Send code" button the user had already navigated away from; moved to the "Resend code" button on the verify screen instead.
- The verify-code submit button gave no feedback while the request was in flight and stayed clickable; it now disables and shows "Verifying…" immediately.
- Reloading the app with a valid session briefly flashed the sign-in screen before the auth check resolved. Fixed by adding a neutral `screen-loading` (spinner) screen shown by default whenever a session token exists, only switching to sign-in/pending/setup/dashboard once the check actually resolves.
- A transient network failure (including the `/u/N/` redirect quirk below) used to wipe the session and force re-entering the email address, because the old error handling treated *any* failure the same as "not signed in." It now only clears the session when the backend explicitly says the token is invalid/expired (`status: 'signed_out'`); other failures show a retry screen with the session left intact, and background polls fail silently rather than disrupting the current screen.
- The pending-approval screen was static — if the owner approved while the tab was still open, nothing changed until a manual reload. It now polls `authCheck` every 15 seconds while shown, plus offers a manual "Check now" button.
- Google's `/u/N/` account-switcher URL segment (a browser/account quirk, not a code bug) turned out to have a second, more serious effect beyond the cosmetic Drive-error page on Approve/Reject links: if it ends up baked into `config.js`'s `APPS_SCRIPT_URL`, a redirect on a **POST** request (like `verifyLoginCode`) gets re-sent by the browser as a bodiless GET, silently dropping the payload — while GET-based calls (`health`, `authCheck`) keep working, making it look like "only some things" are broken. `api.js` now inspects the final response URL and body shape to detect this and surface an actionable error pointing at `config.js` instead of a generic failure.
- The service worker's cache name is bumped (`fit-tracker-shell-v3`) whenever the cached frontend files change, since the browser only re-checks a service worker's own cache when the service worker script's bytes change — leaving the cache name untouched risked serving stale HTML/CSS/JS after a GitHub Pages update.

**Security notes (updated).** The session token in `localStorage` is the only "credential" a browser holds; it's scoped to one account, expires after 30 days, and is meaningless without server-side verification against the `Sessions` sheet on every request. There is still no strong identity proof (anyone who can receive mail at an address can sign in as it) — acceptable here because the owner-approval gate is the real access control, not the email code itself.

## 12. v4 Update — GET-based sign-in, editable name, weekly summary

**The `/u/N/` issue was more than cosmetic.** Testing kept showing "verification only works after removing `/u/1/`" even after checking `config.js` for a stray URL segment. The real mechanism: `script.google.com`'s `/exec` endpoint can redirect the actual request through a `/u/N/`-tagged path depending on which Google account is active in the visiting browser — this is server-side behavior, not something a correctly-copied `config.js` URL can prevent. Per the Fetch/HTTP spec, a redirect on a POST request gets silently resent as a bodiless GET (dropping the JSON payload), while a redirect on a GET request just re-fetches the same query string and works transparently. That is precisely why status checks (`authCheck`, a GET) kept working while code verification (previously a POST) intermittently failed. The fix: `requestLoginCode`, `verifyLoginCode`, and `requestApprovalReminder` all moved from POST to GET, with their (small, non-sensitive) parameters sent as query string values instead of a JSON body. `saveProfile` stays POST — its payload is larger free-text and hadn't shown the same failure, and moving it would put profile free-text (dietary notes, schedule) into server request logs unnecessarily.

**Editable display name.** `prettifyNameFromEmail_` guesses a name by splitting the email's local-part on `._-` and capitalizing — reasonable for `sachin.kumar@...` but not for less-clean addresses. Added `handleUpdateName_(userEmail, name)` (Auth.gs) which patches the `Users` sheet's `Name` column directly via `updateRowValues_`, exposed as a GET action so it inherits the same redirect-safety as the sign-in actions. The Profile screen now has an inline name field + Save button feeding this, instead of only ever showing the guessed name.

**Profile screen redesign.** Replaced the raw `JSON.stringify(profile)` dump with a formatted `<dl>` of human-readable labels (Age, Height, Current/Target weight, Goals, etc.) — same data, presented as an actual profile rather than a debug view.

**Weekly summary.** Added `handleGetWeeklySummary_(userEmail)` (Profile.gs), which reads `Weight Log` rows from the last 7 days and returns a weigh-in count, start/latest weight, and the delta. Deliberately scoped to data that actually exists in Phase 1 — no calorie/protein/workout numbers are fabricated for phases that haven't shipped yet. Rendered as a "This week" card on the dashboard, with an explicit note that it'll have more to say once Meals/Workouts logging exist.

**Refactor: `enterAppShell_`.** Both the initial "profile just saved" path and the "reloaded with an existing profile" path now funnel through one function that sets today's date, renders the profile summary, un-hides the bottom nav, shows the dashboard, and fetches the weekly summary — replacing two near-duplicate copies of this sequence that had started to drift apart.
