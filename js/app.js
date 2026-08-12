/**
 * app.js
 *
 * Phase 1 app logic with emailed one-time-code sign-in: register the
 * service worker, sign the user in, check their approval status, then
 * decide whether to show the setup screen or the dashboard. Later
 * phases add real data to the dashboard and enable the Log/Coach nav
 * buttons.
 */

// Bump this string whenever app.js changes, and check it in the
// browser console (F12 > Console) to confirm the deployed file
// actually matches what you think you pushed — partial updates
// across index.html/app.js/api.js are a common source of confusing
// bugs otherwise.
console.info('Fit Tracker app.js — build: email-code-auth-v9 (form-check checkpoint 2 + add-food)');

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}

const bottomNav = document.getElementById('bottom-nav');
let currentUser = null; // { email, name, status }
let pendingEmail = null; // the email a code was just sent to, while on screen-verify
let pendingPollInterval = null;
const PENDING_POLL_SECONDS = 15;

/**
 * document.getElementById wrapper that warns instead of crashing when
 * an element is missing. This app has been bitten more than once by a
 * caching mismatch, or an index.html/app.js edit landing out of sync
 * with each other — every DOM lookup that isn't guaranteed-present
 * goes through this so a missing element degrades to a console
 * warning instead of a raw "Cannot set properties of null" error.
 */
function el_(id) {
  const node = document.getElementById(id);
  if (!node) {
    console.warn(`Expected element #${id} was not found — index.html may be out of sync with app.js.`);
  }
  return node;
}

function showScreen(id) {
  // Any screen change other than landing on screen-pending itself
  // stops the background poll — otherwise it would keep silently
  // hitting the backend from screens that no longer need it.
  if (id !== 'screen-pending') stopPendingPoll_();
  document.querySelectorAll('.screen').forEach((s) => (s.hidden = true));
  const target = el_(id);
  if (target) target.hidden = false;
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.screen === id);
  });
}

function setWelcomeName(name) {
  document.querySelectorAll('.welcome-name').forEach((node) => {
    node.textContent = name || '';
  });
}

document.getElementById('bottom-nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-btn');
  if (!btn || btn.disabled) return;
  showScreen(btn.dataset.screen);
  if (btn.dataset.screen === 'screen-profile') {
    syncNameInput_();
  }
});

function doSignOut_() {
  stopPendingPoll_();
  setSessionToken(null);
  currentUser = null;
  pendingEmail = null;
  bottomNav.hidden = true;
  showScreen('screen-signin');
}

// Every screen (profile, pending, rejected) shares one sign-out
// button style/handler — .signout-btn, not a single id — so "log out"
// is always reachable, not just buried on the profile tab.
document.querySelectorAll('.signout-btn').forEach((btn) => {
  btn.addEventListener('click', doSignOut_);
});

// --- Loading / retry screen ---------------------------------------------
// Shown at startup (instead of flashing the sign-in screen) whenever we
// already have a session token and are just confirming what it's for.

function showLoading_(message) {
  const textEl = el_('loading-text');
  if (textEl) { textEl.hidden = false; textEl.textContent = message || 'Loading…'; }
  const spinnerEl = el_('loading-spinner');
  if (spinnerEl) spinnerEl.hidden = false;
  const errorEl = el_('loading-error');
  if (errorEl) errorEl.hidden = true;
  const retryEl = el_('loading-retry-btn');
  if (retryEl) retryEl.hidden = true;
  showScreen('screen-loading');
}

function showLoadingError_(message) {
  const textEl = el_('loading-text');
  if (textEl) textEl.hidden = true;
  const spinnerEl = el_('loading-spinner');
  if (spinnerEl) spinnerEl.hidden = true;
  const errorEl = el_('loading-error');
  if (errorEl) { errorEl.hidden = false; errorEl.textContent = message; }
  const retryEl = el_('loading-retry-btn');
  if (retryEl) retryEl.hidden = false;
  showScreen('screen-loading');
}

document.getElementById('loading-retry-btn').addEventListener('click', () => {
  showLoading_('Checking your session…');
  runAuthCheck();
});

// --- Countdown helpers ---------------------------------------------------

const RESEND_COOLDOWN_SECONDS = 30;

function formatMmSs_(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s < 10 ? '0' + s : s}`;
}

/**
 * Disables a button and counts down its label for `seconds`, then
 * restores it to idleLabel and re-enables it. Attached to the button
 * element itself so a second call safely replaces any in-flight
 * countdown instead of stacking two.
 */
function startCountdown_(buttonEl, seconds, idleLabel, renderLabel) {
  if (buttonEl._cooldownInterval) {
    clearInterval(buttonEl._cooldownInterval);
  }
  let remaining = seconds;
  buttonEl.disabled = true;
  buttonEl.textContent = renderLabel(remaining);
  buttonEl._cooldownInterval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(buttonEl._cooldownInterval);
      buttonEl._cooldownInterval = null;
      buttonEl.disabled = false;
      buttonEl.textContent = idleLabel;
    } else {
      buttonEl.textContent = renderLabel(remaining);
    }
  }, 1000);
}

function startResendCooldown_(buttonEl, seconds, idleLabel) {
  startCountdown_(buttonEl, seconds, idleLabel, (r) => `Resend in ${r}s`);
}

function startReminderCooldown_(buttonEl, seconds, idleLabel) {
  startCountdown_(buttonEl, seconds, idleLabel, (r) => `Remind in ${formatMmSs_(r)}`);
}

function resetCooldown_(buttonEl, idleLabel) {
  if (buttonEl._cooldownInterval) {
    clearInterval(buttonEl._cooldownInterval);
    buttonEl._cooldownInterval = null;
  }
  buttonEl.disabled = false;
  buttonEl.textContent = idleLabel;
}

// --- Sign-in: request code ----------------------------------------------

document.getElementById('signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = e.target.querySelector('button[type="submit"]');
  const errorEl = document.getElementById('signin-error');
  errorEl.hidden = true;

  if (submitBtn.disabled) return; // already sending or cooling down — ignore extra clicks/Enter presses

  const email = new FormData(e.target).get('email').trim().toLowerCase();
  submitBtn.disabled = true;
  submitBtn.textContent = 'Sending...';

  try {
    // GET, not POST — see the note at the top of Code.gs: a redirect on
    // a POST silently drops the body, but a redirect on a GET preserves
    // the query string, so sign-in survives the "/u/N/" account-slot
    // quirk regardless of which account is active in this browser.
    await apiGet('requestLoginCode', { email });
    pendingEmail = email;
    document.getElementById('verify-email').textContent = email;
    document.getElementById('verify-form').reset();
    showScreen('screen-verify');
    // The countdown that matters is on the screen the user is now
    // looking at (Resend code) — the Send code button they just left
    // isn't visible, so put it back to normal for if they return via
    // "Use a different email".
    resetCooldown_(submitBtn, 'Send code');
    startResendCooldown_(document.getElementById('resend-code-btn'), RESEND_COOLDOWN_SECONDS, 'Resend code');
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
    if (/wait/i.test(err.message)) {
      startResendCooldown_(submitBtn, RESEND_COOLDOWN_SECONDS, 'Send code');
    } else {
      resetCooldown_(submitBtn, 'Send code');
    }
  }
});

// --- Sign-in: verify code -------------------------------------------------

document.getElementById('verify-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = e.target.querySelector('button[type="submit"]');
  const errorEl = document.getElementById('verify-error');
  errorEl.hidden = true;

  if (submitBtn.disabled) return; // already verifying — ignore double-clicks/double Enter

  const code = new FormData(e.target).get('code').trim();
  const idleLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Verifying...';

  try {
    const { sessionToken } = await apiGet('verifyLoginCode', { email: pendingEmail, code });
    setSessionToken(sessionToken);
    // Move to a neutral loading screen rather than leaving the user
    // staring at a disabled Verify button while authCheck runs.
    showLoading_('Setting things up…');
    await runAuthCheck();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = idleLabel;
  }
});

document.getElementById('resend-code-btn').addEventListener('click', async () => {
  const btn = document.getElementById('resend-code-btn');
  if (btn.disabled) return;
  const errorEl = document.getElementById('verify-error');
  errorEl.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Sending...';

  try {
    await apiGet('requestLoginCode', { email: pendingEmail });
    startResendCooldown_(btn, RESEND_COOLDOWN_SECONDS, 'Resend code');
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
    if (/wait/i.test(err.message)) {
      startResendCooldown_(btn, RESEND_COOLDOWN_SECONDS, 'Resend code');
    } else {
      resetCooldown_(btn, 'Resend code');
    }
  }
});

document.getElementById('use-different-email-btn').addEventListener('click', () => {
  pendingEmail = null;
  const signinForm = document.getElementById('signin-form');
  signinForm.reset();
  resetCooldown_(signinForm.querySelector('button[type="submit"]'), 'Send code');
  resetCooldown_(document.getElementById('resend-code-btn'), 'Resend code');
  showScreen('screen-signin');
});

// --- Pending screen: auto-poll, manual check, remind approver ----------

function stopPendingPoll_() {
  if (pendingPollInterval) {
    clearInterval(pendingPollInterval);
    pendingPollInterval = null;
  }
}

function startPendingPoll_() {
  stopPendingPoll_();
  pendingPollInterval = setInterval(() => {
    runAuthCheck({ silent: true });
  }, PENDING_POLL_SECONDS * 1000);
}

document.getElementById('check-status-btn').addEventListener('click', () => {
  runAuthCheck();
});

document.getElementById('remind-approver-btn').addEventListener('click', async () => {
  const btn = document.getElementById('remind-approver-btn');
  if (btn.disabled) return;
  const errorEl = document.getElementById('pending-error');
  const noticeEl = document.getElementById('pending-notice');
  errorEl.hidden = true;
  noticeEl.hidden = true;
  const idleLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Sending...';

  try {
    const result = await apiGet('requestApprovalReminder');
    noticeEl.textContent = 'Reminder sent to the approver.';
    noticeEl.hidden = false;
    startReminderCooldown_(btn, (result && result.cooldownSeconds) || 300, idleLabel);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
    if (/wait/i.test(err.message)) {
      // The backend enforces its own cooldown too — reflect the
      // default window rather than leaving the button clickable to
      // fail again immediately.
      startReminderCooldown_(btn, 300, idleLabel);
    } else {
      resetCooldown_(btn, idleLabel);
    }
  }
});

// --- Auth check / profile flow -------------------------------------------

async function runAuthCheck(opts) {
  const silent = !!(opts && opts.silent);
  try {
    const auth = await apiGet('authCheck');
    currentUser = auth;
    setWelcomeName(auth.name);

    if (auth.status === 'signed_out') {
      setSessionToken(null);
      showScreen('screen-signin');
      return;
    }
    if (auth.status === 'pending') {
      showScreen('screen-pending');
      startPendingPoll_();
      return;
    }
    if (auth.status === 'rejected') {
      showScreen('screen-rejected');
      return;
    }
    await loadProfileAndContinue();
  } catch (err) {
    console.error(err);
    if (err.status === 'signed_out') {
      setSessionToken(null);
      showScreen('screen-signin');
      return;
    }
    // A network hiccup or a redirect quirk shouldn't throw away a
    // perfectly good session — that was the old behavior, and it's
    // exactly what forced re-entering the email address after any
    // transient failure. Show a retry screen instead, unless this was
    // a silent background poll (in which case just try again on the
    // next tick and leave the current screen alone).
    if (!silent) {
      showLoadingError_(err.message);
    }
  }
}

async function loadProfileAndContinue() {
  try {
    const { profile } = await apiGet('getProfile');
    if (profile) {
      await enterAppShell_(profile);
    } else {
      showScreen('screen-setup');
    }
  } catch (err) {
    console.error(err);
    showScreen('screen-setup');
  }
}

/**
 * The one place that transitions into the dashboard once a profile
 * exists — used both right after initial setup and on every later
 * reload, so the bottom nav, today's date, and the profile view
 * always get populated the same way instead of multiple near-
 * duplicate copies of this logic drifting apart. Tolerant of a
 * missing element (see el_ above) rather than throwing, since a
 * render hiccup here should never be confused with the profile
 * failing to save.
 */
async function enterAppShell_(profile) {
  const dateEl = el_('today-date');
  if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString(undefined, {
      weekday: 'long', month: 'short', day: 'numeric'
    });
  }
  renderProfile(profile);
  bottomNav.hidden = false;
  showScreen('screen-dashboard');

  // No weekly-summary element in the current index.html yet — this
  // stays a harmless no-op via the el_ guard inside renderWeeklySummary_
  // until/unless that card gets added back to the markup.
  try {
    const { weeklySummary } = await apiGet('getWeeklySummary');
    renderWeeklySummary_(weeklySummary);
  } catch (err) {
    console.error(err);
  }
}

function renderWeeklySummary_(summary) {
  const el = el_('weekly-summary-body');
  if (!el) return;
  if (!summary || summary.weighInsThisWeek === 0) {
    el.textContent = 'No weigh-ins logged this week yet.';
    return;
  }
  let text = `${summary.weighInsThisWeek} weigh-in${summary.weighInsThisWeek === 1 ? '' : 's'} logged this week.`;
  if (summary.deltaKg !== null && summary.deltaKg !== 0) {
    const direction = summary.deltaKg < 0 ? 'down' : 'up';
    text += ` Weight is ${direction} ${Math.abs(summary.deltaKg)} kg from the start of the week (${summary.startWeightKg} → ${summary.latestWeightKg} kg).`;
  } else if (summary.deltaKg === 0) {
    text += ` Weight is steady at ${summary.latestWeightKg} kg.`;
  }
  el.textContent = text;
}

/**
 * Renders the Profile screen's #profile-summary <dl> as readable
 * label/value rows instead of a raw JSON dump. Field names match the
 * Profile sheet headers from Config.gs's SHEET_HEADERS (Age,
 * HeightCm, StartWeightKg, ... — see apps-script/Config.gs). "Goal"
 * is read from either `Goal` (the actual current column name) or
 * `Goals` (an older/alternate name), so this keeps working either
 * way instead of silently showing "–" for goals.
 */
function renderProfile(profile) {
  const dl = el_('profile-summary');
  if (dl) {
    const rows = [
      ['Age', profile.Age],
      ['Height', profile.HeightCm ? `${profile.HeightCm} cm` : ''],
      ['Current weight', profile.StartWeightKg ? `${profile.StartWeightKg} kg` : ''],
      ['Target weight', profile.TargetWeightKg ? `${profile.TargetWeightKg} kg` : ''],
      ['Goal', profile.Goal || profile.Goals || ''],
      ['Training experience', profile.TrainingExperience],
      ['Workout days/week', profile.WorkoutDaysPerWeek],
      ['Preferred duration', profile.PreferredWorkoutDurationMin ? `${profile.PreferredWorkoutDurationMin} min` : ''],
      ['Equipment', profile.AvailableEquipment],
      ['Dietary preferences', profile.DietaryPreferences],
      ['Typical schedule', profile.TypicalSchedule]
    ];
    dl.innerHTML = '';
    rows.forEach(([label, value]) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = (value === undefined || value === null || value === '') ? '–' : value;
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
  }
  const statWeight = el_('stat-weight');
  if (statWeight) {
    statWeight.textContent = profile.StartWeightKg ? `${profile.StartWeightKg} kg` : '–';
  }
}

// --- Editable display name (Profile screen) ------------------------------
// The name shown around the app defaults to a guess derived from the
// email address, which can look odd for emails that aren't a clean
// firstname.lastname pattern — this lets someone override it.

function syncNameInput_() {
  const input = el_('name-input');
  if (input && currentUser && currentUser.name) {
    input.value = currentUser.name;
  }
}

document.getElementById('save-name-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('save-name-btn');
  const input = el_('name-input');
  const errorEl = el_('name-error');
  const savedEl = el_('name-saved');
  if (errorEl) errorEl.hidden = true;
  if (savedEl) savedEl.hidden = true;

  const name = input?.value.trim() || '';
  if (!name) {
    if (errorEl) { errorEl.textContent = 'Enter a name.'; errorEl.hidden = false; }
    return;
  }
  if (btn.disabled) return;
  const idleLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    await apiGet('updateName', { name });
    setWelcomeName(name);
    if (currentUser) currentUser.name = name;
    if (savedEl) { savedEl.textContent = 'Saved.'; savedEl.hidden = false; }
    // Note: deliberately NOT calling renderProfile() here — the
    // display name lives on the Users sheet, not the Profile sheet,
    // so there's nothing profile-related to re-render, and passing
    // currentUser (which only has {email, name, status}) into
    // renderProfile would have blanked out the profile dump instead.
  } catch (err) {
    if (errorEl) { errorEl.textContent = err.message || 'Save failed.'; errorEl.hidden = false; }
  } finally {
    btn.disabled = false;
    btn.textContent = idleLabel;
  }
});

// --- Initial profile setup -----------------------------------------------

document.getElementById('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = e.target.querySelector('button[type="submit"]');
  const errorEl = document.getElementById('setup-error');
  errorEl.hidden = true;

  const form = new FormData(e.target);
  const payload = Object.fromEntries(form.entries());
  payload.goals = form.getAll('goals'); // checkboxes sharing name="goals" -> array

  if (payload.goals.length === 0) {
    errorEl.textContent = 'Pick at least one fitness goal.';
    errorEl.hidden = false;
    return;
  }

  if (submitBtn.disabled) return;
  const idleLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving...';

  // The save itself and "now show me the dashboard" afterward are two
  // separate steps with two separate failure modes. Conflating them
  // used to mean a harmless rendering hiccup right after a SUCCESSFUL
  // save got reported to the user as "Could not save profile" — which
  // is not just confusing, it's actively wrong and could prompt
  // re-submitting a duplicate row for data that already saved fine.
  try {
    await apiPost('saveProfile', payload);
  } catch (err) {
    errorEl.textContent = 'Could not save profile: ' + err.message;
    errorEl.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = idleLabel;
    return;
  }

  try {
    const { profile } = await apiGet('getProfile');
    await enterAppShell_(profile);
  } catch (err) {
    console.error('Profile saved, but loading the dashboard afterward failed:', err);
    errorEl.textContent = 'Profile saved. Reload the app to see your dashboard — (' + err.message + ')';
    errorEl.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = idleLabel;
  }
});

// --- Form Check (Phase 2, Slice 1 — checkpoint 2) ------------------------
// Checkpoint 1 proved the capture screen, canvas frame extraction, the
// analyzeForm/saveFormReport round trip, and the review UI all work on
// a real phone, with a manually-typed rep count as a placeholder.
// Checkpoint 2 replaces that placeholder with real on-device pose
// tracking (MediaPipe PoseLandmarker, free, client-side, no API key):
// a dense pass over the video estimates a knee-angle time series,
// pure math in rep-analysis.js segments that into reps and picks a
// small set of representative timestamps, and ONLY those timestamps
// get turned into the JPEG stills that go to Gemini — same "never
// upload the raw video" design as checkpoint 1, see DESIGN.md §13-14.
//
// IMPORTANT, disclosed honestly rather than glossed over: this
// session's cloud sandbox cannot reach MediaPipe's CDN
// (cdn.jsdelivr.net) or its model-hosting storage
// (storage.googleapis.com) — both are blocked by this sandbox's
// network egress allowlist (confirmed via direct curl tests, not
// assumed). That means the MediaPipe API calls below are built from
// the REAL, verified API surface (installed the actual npm package,
// version 1.0.1, and read its vision.d.ts — see DESIGN.md §14) but
// the actual model download + pose inference could NOT be executed or
// tested from within this session. Everything else here (rep-analysis
// math, the fallback path, the UI wiring) has been tested — see
// pwa/js/test/rep-analysis.test.js and the Playwright DOM test. The
// pose-tracking pass itself needs a real run on your phone/laptop
// with a working internet connection before you can trust it.
//
// Resilience by design: if pose detection fails for ANY reason (no
// network, an unsupported browser, a corrupt video, a genuine bug)
// the whole feature degrades to checkpoint 1's manual rep-count entry
// instead of hard-failing — see the catch block in the submit handler.

const FORMCHECK_MAX_FRAME_EDGE_PX_ = 768; // matches Gemini's image-tiling cost breakpoint, see DESIGN.md §13
const FORMCHECK_FALLBACK_FRACTIONS_ = [0.1, 0.5, 0.9]; // used only if pose detection fails
const FORMCHECK_POSE_STEP_MS_ = 150; // ~6-7 samples/sec — enough for rep segmentation without being slow
const FORMCHECK_MAX_POSE_FRAMES_ = 6; // cap on frames actually sent to Gemini (Ai.gs rejects >8)

// MediaPipe Tasks Vision — verified real API/version this session
// (see DESIGN.md §14): ESM entry point, version 1.0.1. Loaded lazily
// via dynamic import() only when Form Check is actually used, so a
// blocked/slow CDN never affects app startup or any other screen.
const POSE_VISION_BUNDLE_URL_ = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs';
const POSE_WASM_BASE_ = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
// Google's standard hosted lite pose model — from general MediaPipe
// documentation knowledge, NOT independently re-verified this session
// (the sandbox can't reach storage.googleapis.com to check it loads).
const POSE_MODEL_URL_ =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';

let poseLandmarkerPromise_ = null;
const POSE_LOAD_TIMEOUT_MS_ = 15000; // see withTimeout_ below

/**
 * A hung network request (as opposed to an outright failure/rejection)
 * would otherwise leave the user staring at "Analyzing movement…"
 * forever with no fallback ever triggering — a genuinely bad failure
 * mode on a flaky connection, distinct from (and worse than) a clean
 * rejection. Every await on a promise that depends on the network
 * (loading MediaPipe's module/wasm/model files) goes through this so
 * a slow-but-not-dead connection still degrades to the manual
 * fallback within a bounded time instead of hanging indefinitely.
 */
function withTimeout_(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

/**
 * Lazily creates (and caches) the PoseLandmarker instance. If creation
 * fails (including timing out — see withTimeout_ above), the cached
 * promise is cleared so the NEXT attempt gets a fresh try instead of
 * being stuck on a permanently-rejected promise for the rest of the
 * session (e.g. the user's wifi comes back).
 */
function getPoseLandmarker_() {
  if (!poseLandmarkerPromise_) {
    poseLandmarkerPromise_ = withTimeout_((async () => {
      const vision = await import(POSE_VISION_BUNDLE_URL_);
      const wasmFileset = await vision.FilesetResolver.forVisionTasks(POSE_WASM_BASE_);
      return vision.PoseLandmarker.createFromOptions(wasmFileset, {
        baseOptions: { modelAssetPath: POSE_MODEL_URL_ },
        runningMode: 'VIDEO',
        numPoses: 1
      });
    })(), POSE_LOAD_TIMEOUT_MS_, 'Loading the pose-tracking model took too long (check your connection).');
    poseLandmarkerPromise_.catch(() => { poseLandmarkerPromise_ = null; });
  }
  return poseLandmarkerPromise_;
}

let formCheckState_ = { exercise: null, frames: null, report: null, autoDetected: null };

document.getElementById('quick-formcheck-btn')?.addEventListener('click', () => {
  resetFormCheckScreen_();
  showScreen('screen-formcheck');
});

document.getElementById('formcheck-back-btn')?.addEventListener('click', () => {
  showScreen('screen-dashboard');
});

document.getElementById('formcheck-discard-btn')?.addEventListener('click', () => {
  resetFormCheckScreen_();
});

function resetFormCheckScreen_() {
  formCheckState_ = { exercise: null, frames: null, report: null, autoDetected: null };
  const form = el_('formcheck-form');
  if (form) { form.hidden = false; form.reset(); }
  const errorEl = el_('formcheck-error');
  if (errorEl) errorEl.hidden = true;
  const statusEl = el_('formcheck-video-status');
  if (statusEl) statusEl.hidden = true;
  const fallbackNotice = el_('formcheck-fallback-notice');
  if (fallbackNotice) fallbackNotice.hidden = true;
  const repField = el_('formcheck-repcount-field');
  if (repField) repField.hidden = true;
  const reportEl = el_('formcheck-report');
  if (reportEl) reportEl.hidden = true;
  const saveErrorEl = el_('formcheck-save-error');
  if (saveErrorEl) saveErrorEl.hidden = true;
  const saveNoticeEl = el_('formcheck-save-notice');
  if (saveNoticeEl) saveNoticeEl.hidden = true;
  const saveBtn = el_('formcheck-save-btn');
  if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save this report'; }
}

document.getElementById('formcheck-video-input')?.addEventListener('change', (e) => {
  const statusEl = el_('formcheck-video-status');
  const file = e.target.files && e.target.files[0];
  if (!statusEl) return;
  if (!file) { statusEl.hidden = true; return; }
  statusEl.hidden = false;
  statusEl.textContent = `Selected: ${file.name} (${Math.round(file.size / 1024)} KB). ` +
    'Analysis starts when you hit "Analyze form".';
});

/**
 * Loads a picked video File into the off-screen <video> element and
 * resolves once its metadata (duration, dimensions) is available.
 * Caller is responsible for calling the returned cleanup() when done
 * with the video, to release the object URL.
 */
function loadVideoFile_(file) {
  return new Promise((resolve, reject) => {
    const videoEl = el_('formcheck-video-el');
    if (!videoEl) {
      reject(new Error('Video element missing from the page.'));
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    const cleanup = () => URL.revokeObjectURL(objectUrl);
    videoEl.onerror = () => {
      cleanup();
      reject(new Error('Could not read that video file — try a different clip or format.'));
    };
    videoEl.onloadedmetadata = () => {
      const duration = videoEl.duration;
      if (!duration || !isFinite(duration)) {
        cleanup();
        reject(new Error("Could not read the video's duration."));
        return;
      }
      resolve({ videoEl, duration, cleanup });
    };
    videoEl.src = objectUrl;
  });
}

function seekTo_(videoEl, timeSec) {
  return new Promise((resolve) => {
    const onSeeked = () => {
      videoEl.removeEventListener('seeked', onSeeked);
      resolve();
    };
    videoEl.addEventListener('seeked', onSeeked);
    videoEl.currentTime = Math.max(0, timeSec);
  });
}

/**
 * Steps through the loaded video at FORMCHECK_POSE_STEP_MS_ intervals,
 * running MediaPipe's PoseLandmarker on each sampled frame. Returns
 * [{ t (ms), landmarks }] — only frames where a person was actually
 * detected are included. This is the one piece that genuinely
 * requires MediaPipe's model files to be reachable; everything
 * downstream (rep-analysis.js) is pure math tested separately.
 */
async function runPoseAnalysis_(videoEl, durationSec) {
  const landmarker = await getPoseLandmarker_();
  const durationMs = durationSec * 1000;
  const frames = [];
  for (let t = 0; t <= durationMs; t += FORMCHECK_POSE_STEP_MS_) {
    await seekTo_(videoEl, t / 1000);
    const result = landmarker.detectForVideo(videoEl, Math.round(t));
    const landmarks = result && result.landmarks && result.landmarks[0];
    if (landmarks) frames.push({ t, landmarks });
  }
  return frames;
}

/**
 * Seeks to each pick's timestamp and draws it onto the off-screen
 * canvas, producing a small set of downscaled JPEG stills — shared by
 * both the auto-detected path (pose-selected timestamps) and the
 * manual-fallback path (fixed fractions of the duration).
 */
async function extractFramesAtTimestamps_(videoEl, picks) {
  const canvasEl = el_('formcheck-canvas-el');
  if (!canvasEl) throw new Error('Canvas element missing from the page.');
  const ctx = canvasEl.getContext('2d');
  const scale = Math.min(1, FORMCHECK_MAX_FRAME_EDGE_PX_ / Math.max(videoEl.videoWidth, videoEl.videoHeight));
  canvasEl.width = Math.round(videoEl.videoWidth * scale);
  canvasEl.height = Math.round(videoEl.videoHeight * scale);

  const frames = [];
  for (let i = 0; i < picks.length; i++) {
    await seekTo_(videoEl, picks[i].t / 1000);
    ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
    const dataUrl = canvasEl.toDataURL('image/jpeg', 0.8);
    frames.push({
      repIndex: i + 1,
      phase: picks[i].label || 'sample',
      base64: dataUrl.split(',')[1] // strip the "data:image/jpeg;base64," prefix
    });
  }
  return frames;
}

document.getElementById('formcheck-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = e.target.querySelector('button[type="submit"]');
  const errorEl = el_('formcheck-error');
  if (errorEl) errorEl.hidden = true;

  if (submitBtn.disabled) return;
  const form = new FormData(e.target);
  const exercise = form.get('exercise');
  const manualRepCountRaw = form.get('repCount');
  const manualRepCount = manualRepCountRaw ? Number(manualRepCountRaw) : null;
  const fileInput = el_('formcheck-video-input');
  const file = fileInput && fileInput.files && fileInput.files[0];

  if (!file) {
    if (errorEl) { errorEl.textContent = 'Pick a video clip first.'; errorEl.hidden = false; }
    return;
  }

  const idleLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Loading video…';

  let videoEl, duration, cleanup;
  try {
    ({ videoEl, duration, cleanup } = await loadVideoFile_(file));
  } catch (err) {
    if (errorEl) { errorEl.textContent = err.message; errorEl.hidden = false; }
    submitBtn.disabled = false;
    submitBtn.textContent = idleLabel;
    return;
  }

  let repSummary, frames, autoDetected;
  try {
    submitBtn.textContent = 'Analyzing movement…';
    const poseFrames = await runPoseAnalysis_(videoEl, duration);
    const series = RepAnalysis.smoothSeries(RepAnalysis.computeKneeAngleSeries(poseFrames), 5);
    const segmentation = RepAnalysis.segmentReps(series);
    if (segmentation.repCount < 1) {
      throw new Error('No reps were detected automatically in this clip.');
    }
    repSummary = RepAnalysis.toRepSummary(segmentation);
    const picks = RepAnalysis.selectRepresentativeTimestamps(segmentation, duration * 1000, FORMCHECK_MAX_POSE_FRAMES_);
    submitBtn.textContent = 'Grabbing key frames…';
    frames = await extractFramesAtTimestamps_(videoEl, picks);
    autoDetected = true;
  } catch (poseErr) {
    console.warn('Automatic rep detection unavailable, falling back to manual entry:', poseErr);
    if (!manualRepCount || manualRepCount < 1) {
      cleanup();
      const fallbackNotice = el_('formcheck-fallback-notice');
      if (fallbackNotice) fallbackNotice.hidden = false;
      const repField = el_('formcheck-repcount-field');
      if (repField) repField.hidden = false;
      if (errorEl) {
        errorEl.textContent = 'Automatic rep detection wasn\'t available (' + poseErr.message +
          '). Enter how many reps you did below and hit "Analyze form" again.';
        errorEl.hidden = false;
      }
      submitBtn.disabled = false;
      submitBtn.textContent = idleLabel;
      return;
    }
    repSummary = { repCount: manualRepCount, avgTempoSec: null, reps: [] };
    const phases = ['start', 'mid', 'finish'];
    const fallbackPicks = FORMCHECK_FALLBACK_FRACTIONS_.map((f, i) => ({ t: duration * 1000 * f, label: phases[i] || 'sample' }));
    submitBtn.textContent = 'Grabbing key frames…';
    frames = await extractFramesAtTimestamps_(videoEl, fallbackPicks);
    autoDetected = false;
  }

  cleanup();
  submitBtn.textContent = 'Asking your coach…';

  try {
    const { report } = await apiPost('analyzeForm', { exercise, repSummary, frames });
    formCheckState_ = { exercise, frames, report, autoDetected };
    renderFormCheckReport_(report);
    const formEl = el_('formcheck-form');
    if (formEl) formEl.hidden = true;
    const reportEl = el_('formcheck-report');
    if (reportEl) reportEl.hidden = false;
  } catch (err) {
    if (errorEl) { errorEl.textContent = err.message; errorEl.hidden = false; }
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = idleLabel;
  }
});

function renderFormCheckReport_(report) {
  const scoreEl = el_('formcheck-score');
  if (scoreEl) scoreEl.textContent = report.overallScore;
  const summaryEl = el_('formcheck-summary');
  if (summaryEl) {
    const detectionNote = formCheckState_.autoDetected === true
      ? ' (reps auto-detected on-device)'
      : formCheckState_.autoDetected === false
        ? ' (manual rep count — auto-detection wasn\'t available for this clip)'
        : '';
    summaryEl.textContent = (report.summary || '') + detectionNote;
  }

  const safetyEl = el_('formcheck-safety');
  if (safetyEl) {
    if (report.safetyFlag && report.safetyFlag.flagged) {
      safetyEl.textContent = '⚠️ ' + (report.safetyFlag.reason || 'Possible safety concern flagged.');
      safetyEl.hidden = false;
    } else {
      safetyEl.hidden = true;
    }
  }

  fillList_('formcheck-good', report.goodPoints || [], (item) => item);
  fillList_('formcheck-corrections', report.corrections || [], (c) =>
    `[${c.severity}] ${c.issue} — ${c.cue}`);

  const recurringBlock = el_('formcheck-recurring-block');
  const hasRecurring = report.recurringIssues && report.recurringIssues.length > 0;
  if (recurringBlock) recurringBlock.hidden = !hasRecurring;
  if (hasRecurring) {
    fillList_('formcheck-recurring', report.recurringIssues, (item) => item);
  }
}

function fillList_(elementId, items, formatFn) {
  const listEl = el_(elementId);
  if (!listEl) return;
  listEl.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.textContent = 'None noted.';
    listEl.appendChild(li);
    return;
  }
  items.forEach((item) => {
    const li = document.createElement('li');
    li.textContent = formatFn(item);
    listEl.appendChild(li);
  });
}

document.getElementById('formcheck-save-btn')?.addEventListener('click', async () => {
  const btn = el_('formcheck-save-btn');
  const saveErrorEl = el_('formcheck-save-error');
  const saveNoticeEl = el_('formcheck-save-notice');
  if (saveErrorEl) saveErrorEl.hidden = true;
  if (!btn || btn.disabled) return;
  if (!formCheckState_.report) return;

  const idleLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    await apiPost('saveFormReport', {
      exercise: formCheckState_.exercise,
      report: formCheckState_.report,
      frames: formCheckState_.frames
    });
    if (saveNoticeEl) saveNoticeEl.hidden = false;
    btn.textContent = 'Saved';
  } catch (err) {
    if (saveErrorEl) { saveErrorEl.textContent = err.message; saveErrorEl.hidden = false; }
    btn.disabled = false;
    btn.textContent = idleLabel;
  }
});

// --- Add Food (Phase 2, Slice 2) ------------------------------------------
// Photo -> Gemini proposal (calories/protein/carbs/fat/fiber per item,
// plus a blunt coach note) -> the user reviews EVERY item and can edit
// its quantity (a multiplier on the AI's estimated portion) or remove
// a misidentified item entirely -> only then does Save actually write
// anything to Sheets/Drive. See DESIGN.md section 15 and Meals.gs.
//
// Quantities are always user-confirmed, never auto-trusted: the
// review list defaults every item's multiplier to 1.0 (i.e. "the
// portion as estimated from the photo") and recomputes calories/
// protein/carbs/fat/fiber live as the multiplier changes, so what
// gets saved is always what the user actually confirmed — not a raw
// AI guess.

const ADDFOOD_MAX_PHOTO_EDGE_PX_ = 1024; // food identification benefits from more detail than pose frames

let addFoodState_ = { items: null, overallConfidence: null, coachNote: null, photoBase64: null, photoMimeType: null };

document.getElementById('quick-addfood-btn')?.addEventListener('click', () => {
  resetAddFoodScreen_();
  showScreen('screen-addfood');
});

document.getElementById('addfood-back-btn')?.addEventListener('click', () => {
  showScreen('screen-dashboard');
});

document.getElementById('addfood-discard-btn')?.addEventListener('click', () => {
  resetAddFoodScreen_();
});

function resetAddFoodScreen_() {
  addFoodState_ = { items: null, overallConfidence: null, coachNote: null, photoBase64: null, photoMimeType: null };
  const form = el_('addfood-capture-form');
  if (form) { form.hidden = false; form.reset(); }
  const errorEl = el_('addfood-error');
  if (errorEl) errorEl.hidden = true;
  const statusEl = el_('addfood-photo-status');
  if (statusEl) statusEl.hidden = true;
  const reviewEl = el_('addfood-review');
  if (reviewEl) reviewEl.hidden = true;
  const saveErrorEl = el_('addfood-save-error');
  if (saveErrorEl) saveErrorEl.hidden = true;
  const saveNoticeEl = el_('addfood-save-notice');
  if (saveNoticeEl) saveNoticeEl.hidden = true;
  const saveBtn = el_('addfood-save-btn');
  if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save this meal'; }
}

document.getElementById('addfood-photo-input')?.addEventListener('change', (e) => {
  const statusEl = el_('addfood-photo-status');
  const file = e.target.files && e.target.files[0];
  if (!statusEl) return;
  if (!file) { statusEl.hidden = true; return; }
  statusEl.hidden = false;
  statusEl.textContent = `Selected: ${file.name} (${Math.round(file.size / 1024)} KB).`;
});

/**
 * Decodes an image File via an off-screen <img>, downscales it on the
 * off-screen canvas so the long edge is at most maxEdgePx, and
 * returns a base64 JPEG. Mirrors the video frame-extraction approach
 * in the Form Check feature — everything stays in the browser except
 * the final small JPEG that gets sent onward.
 */
function downscaleImageFileToBase64_(file, maxEdgePx) {
  return new Promise((resolve, reject) => {
    const imgEl = el_('addfood-img-el');
    const canvasEl = el_('addfood-canvas-el');
    if (!imgEl || !canvasEl) {
      reject(new Error('Image/canvas elements missing from the page.'));
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    const cleanup = () => URL.revokeObjectURL(objectUrl);
    imgEl.onerror = () => {
      cleanup();
      reject(new Error('Could not read that photo — try a different file.'));
    };
    imgEl.onload = () => {
      try {
        const scale = Math.min(1, maxEdgePx / Math.max(imgEl.naturalWidth, imgEl.naturalHeight));
        canvasEl.width = Math.round(imgEl.naturalWidth * scale);
        canvasEl.height = Math.round(imgEl.naturalHeight * scale);
        const ctx = canvasEl.getContext('2d');
        ctx.drawImage(imgEl, 0, 0, canvasEl.width, canvasEl.height);
        const dataUrl = canvasEl.toDataURL('image/jpeg', 0.85);
        cleanup();
        resolve({ base64: dataUrl.split(',')[1], mimeType: 'image/jpeg' });
      } catch (err) {
        cleanup();
        reject(err);
      }
    };
    imgEl.src = objectUrl;
  });
}

document.getElementById('addfood-capture-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = e.target.querySelector('button[type="submit"]');
  const errorEl = el_('addfood-error');
  if (errorEl) errorEl.hidden = true;

  if (submitBtn.disabled) return;
  const form = new FormData(e.target);
  const mealType = form.get('mealType') || '';
  const notes = form.get('notes') || '';
  const fileInput = el_('addfood-photo-input');
  const file = fileInput && fileInput.files && fileInput.files[0];

  if (!file) {
    if (errorEl) { errorEl.textContent = 'Pick or take a photo of your meal first.'; errorEl.hidden = false; }
    return;
  }

  const idleLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Reading photo…';

  try {
    const photo = await downscaleImageFileToBase64_(file, ADDFOOD_MAX_PHOTO_EDGE_PX_);
    submitBtn.textContent = 'Asking your coach…';
    const { proposal } = await apiPost('analyzeFood', { photo, mealType, notes });

    addFoodState_ = {
      items: (proposal.items || []).map((item) => Object.assign({ multiplier: 1, removed: false }, item)),
      overallConfidence: proposal.overallConfidence,
      coachNote: proposal.coachNote,
      mealType,
      notes,
      photoBase64: photo.base64,
      photoMimeType: photo.mimeType
    };
    renderAddFoodReview_();
    const formEl = el_('addfood-capture-form');
    if (formEl) formEl.hidden = true;
    const reviewEl = el_('addfood-review');
    if (reviewEl) reviewEl.hidden = false;
  } catch (err) {
    if (errorEl) { errorEl.textContent = err.message; errorEl.hidden = false; }
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = idleLabel;
  }
});

function renderAddFoodReview_() {
  const confEl = el_('addfood-confidence');
  if (confEl) confEl.textContent = addFoodState_.overallConfidence || '–';
  const noteEl = el_('addfood-coachnote');
  if (noteEl) noteEl.textContent = addFoodState_.coachNote || '';

  const itemsEl = el_('addfood-items');
  if (itemsEl) {
    itemsEl.innerHTML = '';
    addFoodState_.items.forEach((item, index) => {
      itemsEl.appendChild(buildAddFoodItemRow_(item, index));
    });
  }
  recomputeAddFoodTotals_();
}

/**
 * Builds one editable row: name + AI's portion description (read-only
 * context, not editable — the multiplier below is what the user
 * actually adjusts), a quantity multiplier input defaulting to 1.0,
 * a live macro line, and a Remove link for a misidentified item.
 */
function buildAddFoodItemRow_(item, index) {
  const row = document.createElement('div');
  row.className = 'food-item-row';
  row.dataset.index = String(index);

  const top = document.createElement('div');
  top.className = 'food-item-top';
  const nameEl = document.createElement('span');
  nameEl.className = 'food-item-name';
  nameEl.textContent = item.name;
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'food-item-remove-btn';
  removeBtn.textContent = item.removed ? 'Undo remove' : 'Not in my meal — remove';
  removeBtn.addEventListener('click', () => {
    item.removed = !item.removed;
    renderAddFoodReview_();
  });
  top.appendChild(nameEl);
  top.appendChild(removeBtn);
  row.appendChild(top);

  const portionEl = document.createElement('div');
  portionEl.className = 'food-item-portion';
  portionEl.textContent = `AI estimate: ${item.portionDescription} (~${Math.round(item.estimatedGrams)}g, ${item.confidence} confidence)`;
  row.appendChild(portionEl);

  const qtyRow = document.createElement('div');
  qtyRow.className = 'food-item-qty-row';
  const qtyLabel = document.createElement('span');
  qtyLabel.textContent = 'Quantity ×';
  const qtyInput = document.createElement('input');
  qtyInput.type = 'number';
  qtyInput.min = '0';
  qtyInput.step = '0.1';
  qtyInput.value = String(item.multiplier);
  qtyInput.addEventListener('input', () => {
    const val = Number(qtyInput.value);
    item.multiplier = isNaN(val) || val < 0 ? 0 : val;
    renderAddFoodItemMacros_(row, item);
    recomputeAddFoodTotals_();
  });
  qtyRow.appendChild(qtyLabel);
  qtyRow.appendChild(qtyInput);
  row.appendChild(qtyRow);

  const macrosEl = document.createElement('div');
  macrosEl.className = 'food-item-macros';
  row.appendChild(macrosEl);
  renderAddFoodItemMacros_(row, item);

  if (item.removed) row.classList.add('removed');
  return row;
}

function renderAddFoodItemMacros_(row, item) {
  const macrosEl = row.querySelector('.food-item-macros');
  if (!macrosEl) return;
  const m = item.multiplier;
  macrosEl.textContent =
    `${Math.round(item.calories * m)} kcal · P ${round1_(item.proteinG * m)}g · ` +
    `C ${round1_(item.carbsG * m)}g · F ${round1_(item.fatG * m)}g · Fiber ${round1_(item.fiberG * m)}g`;
  row.classList.toggle('removed', !!item.removed);
}

function round1_(n) {
  return Math.round(n * 10) / 10;
}

function recomputeAddFoodTotals_() {
  const totalsEl = el_('addfood-totals');
  if (!totalsEl) return;
  const active = addFoodState_.items.filter((item) => !item.removed);
  const totals = active.reduce((acc, item) => {
    const m = item.multiplier;
    acc.calories += item.calories * m;
    acc.proteinG += item.proteinG * m;
    acc.carbsG += item.carbsG * m;
    acc.fatG += item.fatG * m;
    acc.fiberG += item.fiberG * m;
    return acc;
  }, { calories: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 });
  totalsEl.textContent =
    `${Math.round(totals.calories)} kcal · Protein ${round1_(totals.proteinG)}g · ` +
    `Carbs ${round1_(totals.carbsG)}g · Fat ${round1_(totals.fatG)}g · Fiber ${round1_(totals.fiberG)}g`;
}

document.getElementById('addfood-save-btn')?.addEventListener('click', async () => {
  const btn = el_('addfood-save-btn');
  const saveErrorEl = el_('addfood-save-error');
  const saveNoticeEl = el_('addfood-save-notice');
  if (saveErrorEl) saveErrorEl.hidden = true;
  if (!btn || btn.disabled) return;
  if (!addFoodState_.items) return;

  const activeItems = addFoodState_.items.filter((item) => !item.removed && item.multiplier > 0);
  if (!activeItems.length) {
    if (saveErrorEl) { saveErrorEl.textContent = 'Nothing left to save — every item was removed or set to zero quantity.'; saveErrorEl.hidden = false; }
    return;
  }

  const idleLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    const items = activeItems.map((item) => ({
      name: item.name,
      portionDescription: item.portionDescription,
      quantityMultiplier: item.multiplier,
      estimatedGrams: round1_(item.estimatedGrams * item.multiplier),
      calories: round1_(item.calories * item.multiplier),
      proteinG: round1_(item.proteinG * item.multiplier),
      carbsG: round1_(item.carbsG * item.multiplier),
      fatG: round1_(item.fatG * item.multiplier),
      fiberG: round1_(item.fiberG * item.multiplier),
      confidence: item.confidence
    }));

    await apiPost('saveMeal', {
      mealType: addFoodState_.mealType,
      notes: addFoodState_.notes,
      photo: addFoodState_.photoBase64 ? { base64: addFoodState_.photoBase64, mimeType: addFoodState_.photoMimeType } : null,
      items,
      overallConfidence: addFoodState_.overallConfidence,
      coachNote: addFoodState_.coachNote
    });
    if (saveNoticeEl) saveNoticeEl.hidden = false;
    btn.textContent = 'Saved';
  } catch (err) {
    if (saveErrorEl) { saveErrorEl.textContent = err.message; saveErrorEl.hidden = false; }
    btn.disabled = false;
    btn.textContent = idleLabel;
  }
});

// --- Startup --------------------------------------------------------------
// If we already have a session token, stay on the (already-visible by
// default) loading screen and confirm what it's for — never flash the
// sign-in screen first just to immediately replace it a moment later.

if (getSessionToken()) {
  showLoading_('Signing you in…');
  runAuthCheck();
} else {
  showScreen('screen-signin');
}
