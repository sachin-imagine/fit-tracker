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

**Meals** — one row per logged meal: `MealId, Date, Time, PhotoDriveFileId, ItemsJSON, TotalCalories, TotalProteinG, TotalCarbsG, TotalFatG, TotalFiberG, ConfidenceLevel, Source(ai_estimate/user_edited), Notes` — `TotalFiberG` added in Phase 2, Slice 2 (section 15); see that section for why fiber is a first-class column rather than folded into notes.

**Foods** — the personal food database: `FoodId, Name, ServingDescription, Calories, ProteinG, CarbsG, FatG, FiberG, TimesUsed, LastUsed` — seeded by you, and appended to automatically the first time a corrected meal introduces a new item, so the AI increasingly uses known foods instead of re-guessing.

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

Later phases add `Meals.gs`, `Workouts.gs`, `Ai.gs`, `Videos.gs`, `Coach.gs`, `Cleanup.gs` (the 7-day video-deletion trigger) without touching Phase 1 files. `Meals.gs` and `Ai.gs` are now live as of Phase 2 (sections 13-15).

## 7. AI API Interaction

- Default model: **Claude Haiku 4.5** (vision-capable, cheapest per-call cost) for food-photo analysis and form-check frame analysis; the model name is a `Settings` value, not hardcoded, so it can be swapped to Sonnet or an OpenAI model later without a code change beyond the request-shape adapter.
- Every AI call requests a **strict JSON schema** back (items, quantities, macros, confidence, or form score/observations) — never freeform prose that the backend has to parse. The prompt states the required JSON shape explicitly and the backend validates the shape before using it.
- The personal `Foods` sheet is included in the prompt context (as a compact lookup list) so the model prefers known foods over re-estimating from scratch.
- AI responses never write to Sheets directly — they return to the client as a proposal object; the client's confirm screen is what triggers the actual save call.

**Superseded in Phase 2 (sections 13-15): the actual provider is Gemini, not Claude/OpenAI**, chosen specifically for its free tier — see section 13's "Model choice" and section 14 for the concrete model id and why it changed mid-implementation. The design principles in this section (strict JSON schema, Foods-sheet context, never-auto-save) all carried through unchanged; only the provider and request shape did.

## 8. PWA Structure

- Static, single-origin (GitHub Pages), so `manifest.json` and a service worker (app-shell caching only, not data — data must always be fresh) work normally.
- `index.html` is a lightweight shell; screens are shown/hidden panels rather than a heavy router, keeping the app fast on a phone.
- Bottom navigation: Today · Log · Coach (later phases) · Profile.
- Photo/video capture uses `<input type="file" accept="image/*" capture="environment">` (and `accept="video/*"` for form-check videos later) — the most reliable cross-iOS-version approach, avoiding `getUserMedia` complexity for Phase 1.
- All calls to the backend go through one `api.js` module with the Apps Script web app URL as its only config value.

## 9. Security & Privacy Considerations

- LLM API key stored only in Apps Script `PropertiesService`; never present in any file served to the browser or committed to GitHub.
- The Apps Script web app is deployed as "Execute as: Me / Access: Anyone with the link" (Apps Script has no finer-grained per-user auth for a script not tied to a Google Workspace org) — the URL itself is the shared secret. Phase 1 adds a simple shared-secret token (`Settings` value) that the PWA sends on every request and the backend checks, so a leaked/guessed URL alone isn't enough. (Superseded by the per-person session-token login in section 11 — the admin token now only protects the owner's Approve/Reject email links.)
- All personal data (food photos, videos, logs) stays in Sachin's own Google Drive/Sheets — no third-party database.
- Training videos are deleted from Drive after 7 days by an automated trigger; only the derived analysis (score, notes) persists. (Superseded in section 13 — the raw video is now never uploaded at all, so there's nothing to auto-delete.)
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

## 13. Phase 2, Slice 1 — AI Form-Check Video Pipeline (Gemini)

### Why this isn't "upload video, ask LLM to watch it"

Two hard constraints ruled that out before anything else:

1. **We can't assume any LLM API reliably understands an arbitrary-length video frame-by-frame.** Even providers that accept video input are effectively sampling frames internally at a rate we don't control, and reasoning about *reps* (a temporal, counting task) is exactly the kind of thing general-purpose vision-language models are unreliable at compared to purpose-built pose estimation.
2. **Apps Script's web app POST body has a hard ~50MB ceiling**, and a 60-second phone video can easily exceed that (especially at 4K/high bitrate) — so "just upload the video to the backend" isn't even reliably possible with our current architecture, independent of LLM cost.

So the design keeps the LLM out of the temporal-reasoning business entirely. It only ever sees a handful of still frames plus numbers we've already computed. Rep counting, depth, and tempo come from on-device pose estimation — deterministic, free, and not dependent on any API's video-understanding quality. The LLM's job is narrower and something it's actually good at: look at a few chosen moments and the numeric context, and turn that into coaching language.

```
60-second squat video (stays on the phone/browser — never uploaded whole)
        │
        ▼
1. Client-side frame sampling (canvas, ~8 fps, low-res) ── local only, no network
        │
        ▼
2. Client-side pose estimation (MediaPipe Pose Landmarker, WASM, free, on-device)
        │
        ▼
3. Rep/movement analysis (plain JS over joint-angle time series) — rep count,
   depth, tempo, asymmetry, per-rep quality score. Deterministic, no LLM.
        │
        ▼
4. Select 4–6 representative full-res frames (worst rep, best rep, first, last,
   deepest point of two flagged reps) — the ONLY images that leave the browser
        │
        ▼
5. POST { exercise, repSummary, frames[] } → Apps Script `analyzeForm` action
        │
        ▼
6. Ai.gs calls Gemini generateContent: frames + repSummary + coaching rubric,
   requests strict JSON back (responseMimeType: application/json + schema)
        │
        ▼
7. Structured form report → shown to user for review (never auto-saved) →
   confirmed row written to `Training Videos` sheet
```

### Step 1-2: client-side frame sampling + pose estimation

Runs entirely in the browser, before any network call:

- The captured video (`<input type="file" accept="video/*" capture="environment">`, per section 8) loads into an off-screen `<video>` element. We step through it via a seek loop, grabbing a downscaled canvas frame roughly every 150ms (~6-7 fps) — plenty for a squat tempo, cheap enough to run on a phone.
- Each sampled frame goes through **MediaPipe Tasks Vision — Pose Landmarker** (`@mediapipe/tasks-vision`, loaded from Google's CDN, WASM runtime, runs on-device, no API key, no per-call cost, no server round-trip). It returns hip/knee/ankle/shoulder keypoints per frame.
- This is the concrete answer to "rep / movement analysis" in your diagram, and it's what lets us avoid the video-understanding-reliability problem: we're not asking any LLM to track motion at all.

### Step 3: rep/movement analysis (plain JavaScript, no AI)

From the per-frame knee angle (hip-knee-ankle) time series:

- **Rep segmentation**: find local minima (bottom of squat) and maxima (standing) in the smoothed knee-angle curve → rep count and rep boundaries.
- **Per-rep metrics**: depth (knee angle at the bottom — lower = deeper), tempo (seconds descent vs. ascent), and a simple left/right asymmetry score (hip or knee height difference at the bottom, if both sides are visible).
- **Flagging**: the shallowest rep, the slowest/fastest outlier, and the most asymmetric rep get tagged — these become the frames worth showing the LLM.

This step is exercise-specific only in *which joint angle* it tracks (knee angle for squats). The rep-segmentation logic itself (find peaks/valleys in a joint-angle curve) is generic, so adding deadlifts or push-ups later is a matter of picking the right joint/angle, not rebuilding this stage. **Implemented in `pwa/js/rep-analysis.js` — see section 14 for the concrete algorithm and its test coverage.**

### Step 4: representative-frame selection

From the small set of tagged moments (not every sampled frame), we grab the *original, full-resolution* canvas frame at that timestamp — these 4-6 images are the only visual data that leaves the device. Typical selection: standing start, bottom of the deepest rep, bottom of the shallowest rep, bottom of the most-asymmetric rep, standing finish. Each is compressed to a modest JPEG (e.g. max 768px on the long edge — this also happens to match Gemini's image-tiling token cost breakpoints, so we're not paying for resolution the model discards anyway).

### Step 5-6: backend call to Gemini

New action `analyzeForm` (POST — payload is a few hundred KB to ~1-2MB of base64 JPEGs plus JSON, comfortably under the 50MB ceiling that ruled out full-video upload). New file `Ai.gs` (already anticipated in section 6):

- `callGeminiVision_(promptText, imageParts, jsonSchema)` — generic helper: builds a `generateContent` request to `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`, one text part with the prompt, N `inline_data` image parts, and a `generationConfig` requesting strict JSON matching `jsonSchema`. API key comes from the `LLM_API_KEY` Script Property (same property Config.gs already reserved for "Phase 2+"; the name stays provider-agnostic since Section 7 already says the model/provider should be swappable). Model id is a `Settings` sheet value — **not hardcoded** — same pattern as the rest of the app. **This same helper is reused as-is by the food-photo feature in section 15 — different schema/prompt/images, same call.**
- `handleAnalyzeForm_(userEmail, payload)` — validates the payload, builds the prompt (exercise name + the rep summary numbers, explicitly telling the model to treat those numbers as ground truth and use the images only to describe *form*, not to re-count reps), calls the helper, validates the shape of what comes back, and returns the proposal to the client. **It does not write to `Training Videos` itself** — same "AI proposes, human confirms" rule Section 7 already established for food logging. The client shows the report; a separate confirm action (`saveFormReport`) writes the row.
- **History-awareness (added by explicit request):** `getRecentFormHistory_(userEmail, exercise, limit)` reads the last few same-exercise `Training Videos` rows and feeds them into the prompt, so the model can call out a fault that's still unresolved from last time (`recurringIssues` in the schema below) instead of reviewing every session as if it's the lifter's first. `handleSaveFormReport_` writes `recurringIssues` back into `NextSessionNote` (prefixed `RECURRING:`), closing the loop for the *next* session's read.
- **Strict-coach persona (added by explicit request):** `buildFormCheckPrompt_` instructs the model to actively look for flaws rather than default to praise, call out a repeated fault plainly ("you were already told about this — it is still not fixed"), stay honest even when unflattering, and never inflate the score to be encouraging. `getCoachingContext_` pulls the user's name/goals/training experience from `Users`/`Profile` so the voice is personalized, not generic.

**Structured report schema** (requested via Gemini's JSON-schema response format):

```json
{
  "exercise": "Squat",
  "repsAnalyzed": 8,
  "overallScore": 7,
  "summary": "One or two sentences, strict-coach voice.",
  "goodPoints": ["string", "..."],
  "corrections": [
    {"issue": "string", "severity": "minor | moderate | major", "cue": "string"}
  ],
  "recurringIssues": ["string", "..."],
  "safetyFlag": {"flagged": false, "reason": "string or null"},
  "perRepNotes": [{"repIndex": 1, "note": "string"}]
}
```

`repsAnalyzed`, and every numeric rep metric referenced in `perRepNotes`, come from our own pose-estimation pass — the model is told those numbers, not asked to guess them, which is the main reliability lever here.

### Model choice — what actually shipped

Section 13 originally left the exact model id open pending a live check in AI Studio. What actually happened once real API access was in hand:

- `listGeminiModels()` (Ai.gs) was added specifically to avoid guessing — it lists every model the account's key can see that supports `generateContent`, straight from `GET /v1beta/models`, rather than trusting any name written into this document ahead of time.
- First choice was a pinned `gemini-2.5-flash` (real reasoning quality over `-lite`, calmer free-tier quota than `-pro`). This came back `HTTP 404 — "no longer available to new users"` on the live account, even though it had appeared in `listGeminiModels()`'s own output — a genuine, account-specific eligibility change, not something predictable in advance.
- **Final choice: `gemini-flash-latest`** — Google's own alias that always points at whatever flash-tier model is currently eligible for the account, sidestepping exactly the pinned-version cutoff that broke the first choice. Still "flash", not "-lite" or "-pro": the strict-coach personalization work (section above) needs real reasoning quality, not just cheap classification, and flash's free-tier quota is calmer than `-pro`'s.
- This reverses an earlier instinct ("pinned/stable naming matters more than being on the newest release") — documented here rather than quietly changed, because the reversal was a direct result of hitting a real, live account-specific failure, not a style preference.
- The model id lives in the `Settings` sheet's `llm_model` row, exactly as designed — changing it later (if `-latest` behavior ever needs pinning back down) is a spreadsheet edit, not a code change. **Important operational note:** `Config.gs`'s `DEFAULT_SETTINGS` only seeds a brand-new spreadsheet's `Settings` tab; it never overwrites an existing row, so changing the *live* model requires editing the Settings sheet directly, not just editing `Config.gs`.

### Decision: the raw video is discarded, not uploaded

Sections 5/9 originally assumed training videos land in Drive with a 7-day auto-delete. That's superseded for this slice: **the raw video never leaves the browser.** Only the extracted JPEG frames and the structured report get persisted (Drive for the frames, `Training Videos` sheet for the report). This avoids the ~50MB POST-size ceiling entirely and avoids reopening the OAuth-token-for-direct-Drive-upload complexity we deliberately walked away from earlier when Google Sign-In needed a billing card. Trade-off accepted: there's no way to rewatch the original clip later, only the report and the handful of stills it was based on. `Training Videos.DriveFileId` now points at a small folder of extracted frames rather than the source video; if full-video review turns out to matter later, it's an additive change (a direct browser→Drive upload path), not a rework of this pipeline.

## 14. Phase 2, Slice 1 — Checkpoints 1 & 2: what shipped, what's genuinely tested

Section 13 designed the full pipeline; it shipped in two checkpoints (a decision made explicitly to de-risk the highest-uncertainty piece — real on-device pose tracking — from everything else).

**Checkpoint 1 (capture + round trip, no pose tracking).** Proved the capture screen, canvas frame extraction at three fixed points (10%/50%/90% of the clip), the `analyzeForm`/`saveFormReport` round trip, and the report-review UI all work, with the lifter typing in their own rep count as a stand-in for what pose tracking would compute. This shipped and was handed off for real-device testing before checkpoint 2 began.

**Checkpoint 2 (real pose tracking) — this round.** Replaces the typed-in rep count with actual on-device rep detection:

- **`pwa/js/rep-analysis.js`** — pure, dependency-free math (no DOM, no MediaPipe, no fetch): `computeKneeAngleSeries` turns a sequence of BlazePose landmark frames into a knee-angle time series (average of both legs where visible, using the standard 33-point topology: 23/24 hip, 25/26 knee, 27/28 ankle); `segmentReps` finds contiguous stretches below a depth threshold (baseline estimated as the 85th percentile of the smoothed angle series, so it self-calibrates to however deep *this* person actually squats) and turns each into a rep with depth/tempo/asymmetry; `selectRepresentativeTimestamps` picks a small, deduplicated set of moments (start, deepest rep, shallowest rep, most-asymmetric rep, finish) capped at Ai.gs's 8-frame limit. **This is the one part of checkpoint 2 that is fully, genuinely unit-tested** — `pwa/js/test/rep-analysis.test.js` runs 9 tests against synthetic multi-rep knee-angle curves (built from first principles, not fixtures) under plain Node, covering rep counting, depth-ranking, asymmetry detection, noise-rejection (a sub-threshold-duration dip must NOT register as a rep), and the frame-selection dedup logic.
- **`app.js`'s `runPoseAnalysis_`** — steps through the loaded video at ~150ms intervals, calling MediaPipe's `PoseLandmarker.detectForVideo()` at each step and collecting `{t, landmarks}` frames, which feed `rep-analysis.js`. The MediaPipe API calls themselves (`FilesetResolver.forVisionTasks`, `PoseLandmarker.createFromOptions`, `detectForVideo`'s synchronous-return overload, the `landmarks[0]`/`NormalizedLandmark{x,y,z,visibility}` result shape) were verified against the REAL installed npm package (`@mediapipe/tasks-vision`, resolved version **1.0.1** — installed and its actual `vision.d.ts` read, not guessed from training-data memory) — this was done specifically to avoid the kind of stale-API-knowledge risk that bit the earlier Gemini field-casing investigation. The BlazePose 33-point landmark *index layout* (23/24/25/26/27/28) is standard, pre-training-knowledge, and was **not** independently re-verified this session — flagging that distinction explicitly rather than blurring "verified" and "assumed" together.

**A real, disclosed limitation: MediaPipe's actual model files could not be loaded or run from within this session.** This sandbox's network egress allowlist blocks both hosts MediaPipe needs: `cdn.jsdelivr.net` (the wasm runtime + module bundle) returns a 403 that looks like a proxy block page, and `storage.googleapis.com` (where the pose model `.task` file actually lives) fails the connection outright. This was confirmed directly (`curl` from this sandbox) rather than assumed, and it means **the actual pose-detection call — the one piece of checkpoint 2 that talks to the outside world — has only been verified for API *shape* correctness, not for whether it actually detects a real squat correctly on a real phone.** Everything else has been tested for real, including this exact failure mode:
- `pwa/js/test/rep-analysis.test.js` (9/9 passing) — the rep-segmentation math, described above.
- `apps-script/test/meals.test.js` and `apps-script/test/code-routing.test.js` (11/11 passing) — see section 15.
- `pwa/test/browser.test.js` (7/7 passing) — a headless-Chromium Playwright test. Its Form Check portion is **not mocked**: it genuinely attempts to load MediaPipe from the real CDN URLs, genuinely fails in this sandbox exactly the way a phone with no signal would, and confirms the app degrades gracefully to the manual rep-count fallback (reveals the rep-count field, shows an explanatory message, and still completes the `analyzeForm` round trip once a manual count is entered) instead of hanging forever.
- **A robustness improvement that came directly out of hitting this limitation:** the first version of `getPoseLandmarker_` had no bound on how long it would wait for MediaPipe's files to load, which is fine for an outright-fast rejection (e.g. this sandbox's 403) but would leave a real user staring at "Analyzing movement…" indefinitely on a *slow-but-not-dead* connection instead of ever reaching the fallback. Added `withTimeout_` — a 15-second cap on the model-loading step specifically — so a hung connection degrades to the manual fallback within a bounded time, the same as an outright failure does. If pose detection fails for ANY reason (no network, a slow network, an unsupported browser, a corrupt video, a genuine bug), the whole feature degrades instead of hard-failing — this was a deliberate design choice, not just a side effect of the timeout.
- **What this means for you:** the pipeline design, the math, the fallback behavior, and the UI are all verified. What's NOT verified is "does real MediaPipe pose tracking actually produce a sane knee-angle curve from a real squat video on your phone/laptop." That needs one real test on a device with working internet — if it doesn't work well in practice (e.g. the model is too slow, or misses reps), the fallback path means the feature is still usable via manual entry while that gets tuned.

## 15. Phase 2, Slice 2 — AI Food-Photo Logging Pipeline

Same shape as the form-check pipeline (sections 13-14), reusing the same backend primitives (`callGeminiVision_`, the "AI proposes, human confirms" rule, the strict-coach persona pattern) rather than inventing a parallel design.

```
Meal photo (client-side downscale to ≤1024px long edge, JPEG)
        │
        ▼
POST { photo, mealType, notes } → Apps Script `analyzeFood` action
        │
        ▼
Meals.gs calls Gemini generateContent: photo + this person's stated goals +
their most-used Foods names (for naming consistency) + a strict-coach rubric,
requests strict JSON back (per-item name/portion/grams/macros incl. fiber/
confidence, plus a blunt coachNote)
        │
        ▼
Proposal shown to the user — EVERY item has an editable quantity multiplier
(default 1.0 = "as estimated"), live-recomputed macros, and a remove option
        │
        ▼
User confirms (with whatever edits) → POST { items, ... } → `saveMeal` action
        │
        ▼
Meals.gs recomputes totals SERVER-SIDE from the submitted items (never trusts
a client-sent total) → Meals row + Foods sheet upsert
```

**Why quantities are always editable, never auto-trusted (explicit user requirement).** A vision model estimating "one bowl of rice" from a 2D photo is guessing at grams — a genuinely useful starting point, not something to log as fact. The review screen shows every item with a quantity multiplier defaulting to 1.0 (i.e. "the portion as the AI estimated it") that recomputes that item's calories/protein/carbs/fat/fiber live as it's adjusted, plus a per-item "not in my meal — remove" option for a misidentified item. Nothing is saved until the user has looked at and optionally corrected every line. `handleSaveMeal_` then recomputes the meal's totals itself by summing whatever items were actually submitted — it does not trust any client-computed total, the same defensive pattern the rest of this backend uses for anything a client could get wrong.

**Fiber as a first-class field (explicit user requirement).** `FOOD_REPORT_SCHEMA_`'s `fiberG` is a required field on every item, alongside calories/protein/carbs/fat — not bundled into a free-text note. `Meals.TotalFiberG` and `Foods.FiberG` were added as real spreadsheet columns (see section 4) specifically so fiber can be filtered/summed/charted like every other macro, not just retained inside the `ItemsJSON` blob.

**Strict-coach voice extended to food, not just form.** `buildFoodAnalysisPrompt_` carries the same ground rules as `buildFormCheckPrompt_` (section 13): don't default to praise, weigh the meal honestly against the person's actual stated goals, and say so plainly if a meal works against them — via a `coachNote` field the review screen surfaces prominently, not a hidden log field.

**Foods-sheet upsert, case-insensitive.** `upsertFoodEntry_` matches an incoming item's name against the shared `Foods` sheet case-insensitively (`findRowObjectByMatchCI_`, a new `SheetService.gs` helper) — "Paneer Tikka" and "paneer tikka" logged on different days bump the same row's `TimesUsed`/`LastUsed` rather than creating near-duplicate entries. First-seen macro values are kept stable on repeat matches (they're only ever used as a naming hint fed back into future prompts via `getFrequentFoodNames_`, not as nutrition ground truth for any specific meal) — see the reasoning in `Meals.gs`'s comments for why averaging or overwriting them would be wrong.

**Testing.** Unlike the form-check pipeline's pose-detection step (section 14), nothing in this pipeline depends on a network host this sandbox can't reach — the Gemini call itself is mocked in tests (a real key was never needed to verify the logic), but every line of actual logic around it is exercised for real:
- `apps-script/test/meals.test.js` (8/8 passing) — a Node mock-harness that loads the REAL `.gs` source files into a `vm` context with small in-memory fakes for `SpreadsheetApp`/`DriveApp`/`PropertiesService`/etc., and calls the real handler functions. Confirms: `handleAnalyzeFood_` never touches Sheets or Drive (proposal-only); `handleSaveMeal_` recomputes totals from items rather than trusting a client total, including the new `TotalFiberG` column; a photo is uploaded to a dated Drive subfolder only when one is provided; missing macro fields are rejected; an empty items array is rejected; the Foods upsert creates-then-increments correctly across a case-different repeat log; and a previously-logged food name actually appears in the next prompt sent to Gemini.
- `apps-script/test/code-routing.test.js` (3/3 passing) — verifies `Code.gs`'s `doPost` actually wires `analyzeFood`/`saveMeal` to the right handlers **through the real `Auth.gs` session-auth path** (a seeded approved session, not a bypass), and that an invalid session is still correctly rejected for both new actions. This is the specific layer where an earlier real bug in this project happened (an action wired into `Code.gs` whose handler file hadn't been pasted into the Apps Script editor) — this test would have caught that class of mistake at the routing level, not just inside the handler.

## 16. Real-device test feedback — four fixes (gallery upload, MediaPipe timestamp bug, schedule-aware coaching, redirect diagnostics)

Sections 14-15 shipped checkpoint 2 and the food-photo pipeline having only been tested from this sandbox (network-blocked for MediaPipe, no real device). This section covers what came back from the FIRST real-device test pass — ten screenshots showing Add Food working well end-to-end on a real meal, Form Check's fallback correctly catching a genuine MediaPipe error, a broken name-update, and three explicit asks. Unlike sections 14-15, every fix below was verified either by a Node test or a Playwright DOM test actually added this round (not just "should work") — see the counts at the end of this section.

**Fix 1 — gallery/library upload.** `#formcheck-video-input` and `#addfood-photo-input` both had `capture="environment"`, which on many mobile browsers (confirmed by the user's own device) skips straight to the live camera and never offers "Photo Library" / "Choose File". The attribute is removed from both inputs entirely — an `<input type="file" accept="...">` with no `capture` attribute is what makes iOS/Android show the full action sheet (camera AND library). A one-line hint (`.hint-text`) was added under each input so it's clear both options are available. Regression-tested: `pwa/test/browser.test.js` now asserts `capture` is `null` on both elements.

**Fix 2 — the real MediaPipe `CalculatorGraph::Run()` "Packet timestamp mismatch" error.** Root cause, confirmed by reading MediaPipe's actual constraint (VIDEO-mode `PoseLandmarker.detectForVideo()` requires timestamps to strictly increase for the *lifetime of one graph instance*) against what the old code did: `getPoseLandmarker_()` cached a single `PoseLandmarker` in a module-level `poseLandmarkerPromise_` and reused it across every separate "Analyze form" attempt, while `runPoseAnalysis_` restarts its own `t` counter at 0 for every new video. Feeding a second video's `t=0` into an instance that already saw a much later timestamp from the first video throws exactly the error in the user's screenshot ("expected timestamp is 12300001 but received 0"). Fix: split the old function into `getVisionFileset_()` (caches the stateless JS module + WASM fileset — safe to reuse) and `createPoseLandmarker_()` (creates a **brand new** `PoseLandmarker` for every attempt, closing the previous one first via `.close()`). A new instance has no memory of any prior timestamp, so this class of error cannot recur. This could not be exercised against the real MediaPipe CDN from this sandbox (same network-block as section 14), but the refactor was syntax- and logic-checked, and the existing Playwright fallback test (which exercises `createPoseLandmarker_` up to the point the CDN import fails) still passes unchanged.

**Fix 3 — schedule-aware coaching.** The user's core complaint: a night-shift worker (6:30pm-3:30am) eating what is, for them, a normal dinner gets judged as if a normal 9-5 person ate a late-night snack. Root cause: `getCoachingContext_` never read the `TypicalSchedule` Profile column (it exists in the sheet — section 4 — the Profile screen already collects it — but nothing downstream used it), and `buildFoodAnalysisPrompt_`/`handleAnalyzeFood_` never told the model what time it currently is at all, so there was nothing to check meal timing against in the first place. Fix: `getCoachingContext_` now also returns `schedule` (the raw `TypicalSchedule` text); `handleAnalyzeFood_` computes the actual current time (`Utilities.formatDate(new Date(), Session.getScriptTimeZone(), ...)`) and passes both into `buildFoodAnalysisPrompt_`, which now instructs the model explicitly: check the logging time against THIS person's stated schedule before saying anything about timing, and never call a meal a bad choice on clock time alone. `buildFormCheckPrompt_` (Ai.gs) got the same schedule line for consistency, since the same logic applies to "training late at night." This intentionally does NOT relax the strict-coach tone requirement — the model is still told to be blunt about the food itself; it's just told not to fabricate a timing objection that doesn't apply to this person. Tested: two new cases in `apps-script/test/meals.test.js` — one seeds a Profile row with a night-shift schedule and asserts the prompt contains both the schedule text and an explicit "don't judge by clock time alone" instruction; the other confirms a user with no Profile row yet still gets a valid prompt (no schedule line, no crash).

**Fix 4 — the "backend redirected through a Google account-picker page" error (Profile name-update, Add Food).** This is `api.js`'s own pre-existing diagnostic firing as designed — it only throws this specific message when the actual final response URL (`res.url`, post-redirect) contains a `/u/<number>/` segment. Investigation this round: `apps-script/appsscript.json`'s `webapp` block already specifies `"access": "ANYONE_ANONYMOUS", "executeAs": "USER_DEPLOYING"` — i.e. the manifest itself asks for a fully public, no-sign-in-required deployment, which should never redirect through an account picker at all. That means the live, actually-active deployment on script.google.com has almost certainly drifted from this manifest (a manual "Manage deployments" edit that wasn't followed by clicking Deploy again, or the URL in the phone's `config.js` is a `/dev` Test-deployment link rather than the `/exec` Web-app link — a Test-deployment link always requires picking a Google account, by design, regardless of any access setting). Since this sandbox has no way to inspect the user's live deployment configuration or their actual deployed `config.js`, two defensive, code-side improvements were made instead of a guess: (a) `validateConfig_()` in `app.js` now runs before any network call at all and blocks with a specific, actionable message if the configured URL is still the placeholder, contains `/u/<number>/`, or ends in `/dev`; (b) `api.js`'s runtime error message (for the case a URL passes the static check but still redirects — e.g. a browser-side multi-account cookie quirk) now spells out three concrete things to check in order, including trying the same action in a private/incognito tab. **This is the one fix in this section that still needs a decision only the user can make on the actual Apps Script deployment** — the code now surfaces exactly what to check, but cannot fix a live deployment's access setting from here. Tested: two new Playwright tests serve a deliberately-broken `config.js` (one with `/u/1/`, one ending `/dev`) to a fresh page and confirm `validateConfig_` blocks before sign-in with the right message in both cases.

**Build tags bumped** (per the project's existing "confirm the deployed file matches" convention): `app.js` → `email-code-auth-v10`, `api.js` → `email-code-auth-v6`, service worker cache → `fit-tracker-shell-v8`.

**Testing tally for this section:** `apps-script/test/meals.test.js` 10/10 (was 8/8 — 2 new), `apps-script/test/code-routing.test.js` 3/3 (unchanged, but now also needed a `Session` mock added to its harness once `handleAnalyzeFood_` started calling `Session.getScriptTimeZone()`), `pwa/js/test/rep-analysis.test.js` 9/9 (unchanged — pure math, untouched by any fix here), `pwa/test/browser.test.js` 10/10 (was 7/7 — 3 new: capture-attribute check, and the two config-validation blocking tests). **32/32 passing overall.**

**Workspace-revert note, for the record.** At the start of this round, the cloud sandbox's local working copy had reverted to the ORIGINAL Phase 1 skeleton — missing `Ai.gs`, `Auth.gs`, `Meals.gs`, `rep-analysis.js`, and every test file, i.e. everything built in sections 13-15. This was a much larger revert than the file-subset reverts noted in sections 14-15. Recovery: every file that mattered was re-pulled from the actual device folder (`device_list_dir` + `device_stage_files`, not assumed from memory) before any edit was made, confirmed by line counts and spot-check `md5sum` against what this document already recorded. The device folder remains the only trustworthy source of truth for this project — the cloud sandbox's disk should be treated as scratch space that can be wiped at any point mid-session, never as the record of what's actually been built.

## 17. Second real-device test round — exercise mismatch detection, editable portion grams, personalized coaching language

Three more concrete issues from a second real-device test pass (Add Food and Form Check screenshots showing the app working, but with specific rough edges):

**Exercise mismatch detection (Form Check).** The user selected "Squat" in the dropdown but filmed a different exercise (a dumbbell movement) — the app confidently critiqued squat depth/knee-bend on it anyway. Root cause: `buildFormCheckPrompt_` told Gemini "Exercise: Squat" as a flat fact and instructed it to treat the knee-angle pose-tracking numbers as unconditional ground truth, with no instruction to ever question the logged label. Separately, `rep-analysis.js`'s on-device pose math (`computeKneeAngleSeries`) is inherently squat-specific — it was never built to recognize *any* exercise, only to segment reps from a knee-angle time series, which is meaningless for a non-knee-dominant movement. Given that, full multi-exercise auto-classification (having the on-device pose math recognize which of N exercises is being performed) is out of scope for this round — the form dropdown genuinely only offers "Squat" today. What WAS fixed, and is a meaningful step toward "act like AI, not a hardcoded dataset": `FORM_REPORT_SCHEMA_` gained two required fields — `exerciseMatchesVideo` (boolean) and `detectedExercise` (string, always filled in, even on a match) — and `buildFormCheckPrompt_` now explicitly instructs Gemini to independently look at the frames and identify what's actually being performed BEFORE reasoning about anything else, rather than trusting the logged label. If it doesn't match, the model is told to say so plainly, to treat the knee-angle numbers as likely meaningless rather than ground truth, and to base its feedback on what it actually sees instead of force-fitting squat criteria onto a different movement. The client (`renderFormCheckReport_` in `app.js`, new `#formcheck-mismatch` banner in `index.html`) shows this loudly, above the score, whenever `exerciseMatchesVideo` is false. This is honestly still a partial fix — it can't turn a squat-only rep-counter into a general movement classifier — but it stops the app from confidently lying about what it saw, which was the actual complaint ("it should correct the user... instead of a hardcoded version"). Tested: new `apps-script/test/formcheck.test.js` (3/3) confirms the prompt contains the "don't trust the label" and "numbers may be meaningless on mismatch" instructions, and that `handleAnalyzeForm_` passes a mismatched response through completely unmodified (same "AI proposes, this layer never overrides" rule as the rest of the backend). New Playwright test confirms the mismatch banner renders with both the detected and logged exercise named.

**Directly editable portion in grams (Add Food).** Previously the only way to correct an AI-estimated portion (e.g. "~380g") was the "Quantity ×" multiplier — to get from 380g to an actual 100g, the user would have had to compute and type 0.263. Added a second, directly editable "Portion (g)" field per item, pre-filled with the AI's estimated grams, that recomputes the multiplier (`grams / item.estimatedGrams`) and syncs back to the ×multiplier field (and vice versa) so either field can be used, and macros/totals recompute live from whichever was just edited. No backend change was needed — `Meals.gs`'s `handleSaveMeal_` already only cares about the final scaled macro values in the submitted `quantityMultiplier`/macro fields, not how the client arrived at them. Tested: new Playwright test edits a rice item's grams field directly (180g estimate → 45g) and confirms the ×multiplier field updates to match (0.25), the row's macros recompute correctly, and the saved payload reflects the gram-derived values.

**Personalized coaching language, not generic hedged advice (Add Food).** The coach note kept saying things like "if fat loss is your main objective, watch the carbs" — despite the person's goal being a known, already-stated fact (from their Profile), not a hypothetical. This read like a generic nutrition label, not "a personal trainer who already knows this client" — which is exactly the contrast the user drew against their own separate Gemini chat. Fixed by extending `buildFoodAnalysisPrompt_`'s ground rules: the goals line is now explicitly framed as "a known fact about THIS specific person, not a hypothetical," with an instruction never to phrase feedback as "if your goal is X" and instead state it as fact ("Since your goal is X, ..."), plus a direct instruction to write personally (using the person's name when known) like an ongoing coaching relationship rather than a generic label. This is a tone/context fix, not a tone-softening one — the existing "do not default to praise" and "say so plainly if a meal works against their goals" rules are untouched. Tested: new case in `apps-script/test/meals.test.js` seeds a Users row with a real name and a Profile row with a real goal, and confirms the prompt contains both the anti-hedging instruction and the name-personalized example.

**Testing tally for this section:** `apps-script/test/formcheck.test.js` — new file, 3/3. `apps-script/test/meals.test.js` — 11/11 (was 10/10, 1 new). `pwa/test/browser.test.js` — 12/12 (was 10/10, 2 new: grams-editing sync, exercise-mismatch banner). `apps-script/test/code-routing.test.js` and `pwa/js/test/rep-analysis.test.js` unchanged at 3/3 and 9/9. **38/38 passing overall.**

## 18. Phase 3, Checkpoint A — manual workout logging (Log Workout finally enabled)

The user asked for a "ready to use application" they could personally start using now, referencing a real App Store app they recorded a video of (name given for reference/style only — "Liftpeak"; this app is not being renamed to that, per the user's own clarification) for its workout-tracking UI: enter reps/weight/exercise, see last time's numbers while repeating an exercise, get a live Volume/Sets/Records header, and a warmup/normal/failed-rep set-type indicator. This had been in the original Phase 1 schema (Workouts/Exercises/Workout Plan sheets) but the "Log Workout" quick-action button had sat `disabled` since Phase 1 — nothing behind it was ever built. This checkpoint builds the whole vertical slice: schema → backend → frontend → tests, working end to end with no AI involved at all (pure data entry + arithmetic; the "AI reviews your performance" half of the request is Checkpoint B, reading these same rows).

**Data model.** One row per SET (not per exercise, not per session) in the `Workouts` sheet — `SessionId`/`Exercise`/`SetNumber` identify a set; `SetType` is `'warmup' | 'normal' | 'failed'` (the gold-W / plain-number / red-X badges in the reference UI); `IsPR` is computed once at log time and stored, not recomputed on every read, so history stays stable even if the PR rule changes later. A new `Workout Sessions` sheet holds one row per workout with live-updated `TotalVolumeKg`/`TotalSets`/`PRCount` — this is what a session list, and later Checkpoint B's weekly rating, reads instead of re-summing every set row on every request. `Exercises` (shared across users, same pattern as `Foods`) gained `IconEmoji` (a plain emoji — deliberately no image-upload flow for a personal app) and `TimesUsed`/`LastUsed` so the picker surfaces "your usual" exercises first. `runMigrationAddWorkoutTracking()` in `Setup.gs` brings an existing spreadsheet up to date (extends the two existing empty Workouts/Exercises tabs' headers, creates Workout Sessions, seeds 12 starter exercises) — run once from the Apps Script editor before this version goes live.

**Backend (`apps-script/Workouts.gs`, new file).** `getExerciseLibrary` (sorted most-used-first); `addCustomExercise` (case-insensitive upsert, same dedup pattern as Meals.gs's Foods upsert); `startWorkoutSession` (creates the session rollup row immediately, all zeros, so the header has something to show from set one); `getPreviousSetData` (returns the most recent PRIOR session's completed sets for an exercise, keyed by set number); `logSet` (upserts by `(sessionId, exercise, setNumber)` — re-checking a set updates that row instead of duplicating, since the client re-sends the whole set on every toggle); `finishWorkoutSession` (stamps `EndedAt`/duration, final totals); `getRecentWorkoutSessions` (finished sessions only, most recent first). Two real logic bugs were caught by self-review while writing this, before any test ran against them, and both are now covered by tests: (1) `getPreviousSetData` originally didn't exclude the CURRENT in-progress session, so a set completed minutes earlier in the same workout could show up as its own "previous" reference — fixed by requiring a `sessionId` and filtering it out; (2) PR detection originally credited a brand-new exercise's very first-ever logged set as a PR (since "no prior weight" defaulted to 0, and any real weight beats 0) — fixed by requiring at least one prior COMPLETED set (in a different session) to exist before a PR is possible, since a record means beating a previous one. Every write goes through `SheetService.gs`'s generic helpers, same convention as every other handler file — no direct `SpreadsheetApp` calls in `Workouts.gs`.

**Frontend.** The "Log Workout" quick-action and the previously-disabled, unused "Log" bottom-nav slot (repurposed as "History" 📈, since nothing else used that slot) are both enabled. New screens: `screen-workout` (active session — one card per added exercise, each with its own SET/PREVIOUS/KG/REPS rows, a live Volume/Sets/Records header, a rest-timer chip that starts the moment a set is checked off using that exercise's `DefaultRestSec`); `screen-exercise-picker` (search the shared library, or type a brand-new name inline via `addCustomExercise`); `screen-log` (finished-session history cards). Tapping a set's number badge cycles it through normal → warm-up (gold "W") → failed (red "✕") before logging, matching the reference UI. Completing a set is an upsert-toggle (tap again to undo) that always posts the full row to `logSet`; a PR flagged by the backend renders a small trophy badge inline under that set — this layer never decides a PR itself, only displays what the backend already computed. Every workout-specific loading state (exercise library fetch, session start, history fetch) shows a bouncing barbell emoji instead of the app's plain spinner, per the user's request for an exercise-themed loading indicator. `showScreen()` now adds a short fade/slide-in animation class on every screen change app-wide (not just the new workout screens) for the "good animation for jumping from 1 option to another" ask.

**What this checkpoint deliberately does NOT do yet**, so the next round has a clear starting point: no weekly performance rating or growth/trend charts (Checkpoint B — reads the `Workout Sessions` rows this checkpoint writes); no AI review of workout performance; a workout in progress lives only in memory (`workoutState_` in `app.js`) — refreshing the page mid-workout loses the in-progress card list, though every individually completed set is already safely saved server-side via `logSet`, so nothing already checked off is lost, only the picker state; no app rebrand/icon/animation-polish pass (Checkpoint C, deferred per the user's own build-plan ordering); the reference video's other screens (weekly rating, growth view, navigation) were never watched (Google Drive video playback stalled repeatedly in this sandbox's network-limited browser — see the troubleshooting note this session left in the project doc) — this checkpoint was built from the one screen that WAS captured plus the user's own written description, and the user has agreed to send screenshots of the rest for Checkpoint B.

**Tested:** new `apps-script/test/workouts.test.js` (17/17) — exercise library sort order, custom-exercise case-insensitive upsert, session start, both fixed bugs specifically re-verified under test (previous-session exclusion, PR-requires-prior-history, plus the same-session-doesn't-count-as-prior edge case), log-set upsert-by-match, exercise-usage bump, session-totals recomputation (completed sets only), finish-session rollup math, and history filtering to finished sessions only. New `pwa/test/workout-browser.test.js` (10/10) — starting a workout jumps into the picker, search filtering, previous-value pre-fill from a canned `getPreviousSetData` response, completing a set posts `logSet` and starts the rest chip, adding a set row, a backend-flagged PR renders the trophy badge, live header stats, finishing posts `finishWorkoutSession` and shows the summary, and the History tab renders a finished session. **Full regression: 56/56 passing** (34 backend across four `apps-script/test/*.test.js` files + 22 frontend across two `pwa/test/*.test.js` files).
- `pwa/test/browser.test.js`'s Add Food portion (5/5 passing, part of the 7/7 total in section 14) — a real headless-Chromium DOM test: a photo is picked, `analyzeFood` (mocked) returns two items, both render as editable rows; editing one item's quantity live-recomputes both that row's macros and the running total; removing an item excludes it from both the total and (verified via the captured `saveMeal` request body) what actually gets saved; the saved payload is asserted to contain the user's EDITED values (a halved rice portion), not the AI's raw estimate — directly exercising the "always confirm or edit the quantity" requirement end-to-end, not just checking that a UI element exists.
