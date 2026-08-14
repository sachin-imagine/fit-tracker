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
console.info('Fit Tracker app.js — build: ux-polish-v3 (Add Diet layout fix + auto-reset after save, macro-input overflow fix, coach auto-scroll-to-bottom fix, Form Check icon, set-row sizing, log-set pending state, water intake logging)');

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}

const bottomNav = document.getElementById('bottom-nav');
let currentUser = null; // { email, name, status }
let currentProfile_ = null; // the last Profile row rendered — kept so Edit Profile can pre-fill from it
let editProfileMode_ = false; // true while screen-setup is being reused to EDIT an existing profile, not create the first one
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
  if (target) {
    target.hidden = false;
    // Re-trigger the fade/slide-in animation every time, even if this
    // screen was shown before — remove the class, force a reflow
    // (offsetWidth read), then re-add it. Without the reflow the
    // browser coalesces the remove+add into a no-op and the animation
    // never restarts on a repeat visit to the same screen.
    target.classList.remove('screen-enter');
    void target.offsetWidth;
    target.classList.add('screen-enter');
  }
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.screen === id);
  });
  updateActiveWorkoutPill_(id);
}

/**
 * Measures the REAL height of the bottom nav (only possible once it's
 * visible — offsetHeight is 0 while [hidden]) and writes it to the
 * --nav-height CSS variable, so every "sit just above the nav"
 * position (the active-workout pill, the coach chat input bar, #app's
 * own scroll clearance) derives from one real number instead of
 * separate hardcoded guesses that can drift out of sync with each
 * other and with the actual rendered nav.
 */
function syncNavHeight_() {
  if (!bottomNav || bottomNav.hidden) return;
  const h = bottomNav.offsetHeight;
  if (h) document.documentElement.style.setProperty('--nav-height', h + 'px');
}

window.addEventListener('resize', () => {
  syncNavHeight_();
  updateCoachInputBarPosition_();
});

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
  if (btn.dataset.screen === 'screen-log') {
    loadWorkoutHistory_();
  }
  if (btn.dataset.screen === 'screen-coach') {
    loadCoachHistory_();
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
  if (errorEl) { errorEl.hidden = false; errorEl.textContent = humanizeErrorMessage_(message); }
  const retryEl = el_('loading-retry-btn');
  if (retryEl) retryEl.hidden = false;
  showScreen('screen-loading');
}

/**
 * Turns a raw error message — which might be our own short, already
 * plain-language validation text ("Type an exercise name first."), or
 * might be a backend/Gemini/network failure carrying technical detail
 * nobody outside this codebase should have to read (HTTP status
 * codes, "UNAVAILABLE", a raw JSON error blob, a sheet/stack-trace
 * message) — into something a non-technical person can act on. This
 * app is used by everyday people, not developers, so nothing shown on
 * screen should ever look like debug output. Real detail still reaches
 * the browser console (every catch block that calls this also had, or
 * still has, its own console.error/console.warn) for whoever needs to
 * actually debug it.
 */
function humanizeErrorMessage_(rawMessage) {
  const msg = String(rawMessage || '');
  if (/503|UNAVAILABLE|overloaded|high demand|rate limit|429/i.test(msg)) {
    return 'We\'re getting a lot of requests right now. Please try again in a few minutes.';
  }
  if (/timeout|timed out|abort|failed to fetch|network|offline/i.test(msg)) {
    return 'That\'s taking longer than expected. Please check your internet connection and try again.';
  }
  // Deliberately specific phrases, not the bare word "session" — this
  // app has an unrelated, perfectly legitimate "Workout Sessions"
  // concept, and a generic /session/i match was misfiring on THAT
  // ("Sheet not found: Workout Sessions...") and showing a wrong
  // "please sign in again" message for what was really a backend/setup
  // error.
  if (/session (expired|invalid|has ended)|unauthorized|not signed in|no valid session token|401\b|403\b/i.test(msg)) {
    return 'Your session has ended. Please sign in again.';
  }
  // Looks like a raw technical/system error — a JSON error blob, a
  // stack-trace class name, an HTTP status, an internal sheet/setup
  // detail — rather than something written for a person. Hide it
  // behind one plain message instead of showing raw response text.
  if (/\{\s*"(code|error|message)"|referenceerror|typeerror|sheet not found|run setup|http \d{3}|raw response|internal server error|unexpected token/i.test(msg)) {
    return 'Something went wrong on our end. Please try again in a moment.';
  }
  // Already short, plain-language text we wrote ourselves (client-side
  // validation, or a clean backend validation message) — safe as-is.
  return msg || 'Something went wrong. Please try again.';
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

  // Move to the "enter code" screen IMMEDIATELY rather than leaving the
  // user staring at "Sending..." here for however long Apps Script
  // takes to actually send the mail (a real-device report: the code
  // WAS arriving, but this screen sat on "Sending..." for a long time
  // regardless, since nothing here depended on watching the inbox —
  // the code is delivered independently by email either way, so
  // there's nothing to gain by waiting here for the request to
  // resolve before switching screens). The verify screen shows its own
  // "still sending" notice for the gap, and reports an error there
  // (with "Use a different email" as the way back) if the send itself
  // actually fails.
  pendingEmail = email;
  document.getElementById('verify-email').textContent = email;
  document.getElementById('verify-form').reset();
  showScreen('screen-verify');
  const sendingNotice = document.getElementById('verify-sending-notice');
  const verifyErrorEl = document.getElementById('verify-error');
  if (verifyErrorEl) verifyErrorEl.hidden = true;
  if (sendingNotice) sendingNotice.hidden = false;
  const resendBtn = document.getElementById('resend-code-btn');
  if (resendBtn) resendBtn.disabled = true;

  try {
    // GET, not POST — see the note at the top of Code.gs: a redirect on
    // a POST silently drops the body, but a redirect on a GET preserves
    // the query string, so sign-in survives the "/u/N/" account-slot
    // quirk regardless of which account is active in this browser.
    await apiGet('requestLoginCode', { email });
    if (sendingNotice) sendingNotice.hidden = true;
    // The countdown that matters is on the screen the user is now
    // looking at (Resend code) — the Send code button they just left
    // isn't visible, so put it back to normal for if they return via
    // "Use a different email".
    resetCooldown_(submitBtn, 'Send code');
    startResendCooldown_(resendBtn, RESEND_COOLDOWN_SECONDS, 'Resend code');
  } catch (err) {
    if (sendingNotice) sendingNotice.hidden = true;
    if (verifyErrorEl) {
      verifyErrorEl.textContent = humanizeErrorMessage_(err.message);
      verifyErrorEl.hidden = false;
    }
    if (resendBtn) { resendBtn.disabled = false; resendBtn.textContent = 'Resend code'; }
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
    errorEl.textContent = humanizeErrorMessage_(err.message);
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
    errorEl.textContent = humanizeErrorMessage_(err.message);
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
    errorEl.textContent = humanizeErrorMessage_(err.message);
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
  // offsetHeight is 0 while the nav has [hidden] set, so this can only
  // be measured now that it's actually visible — see the --nav-height
  // comment in style.css for why this replaces two drifting hardcoded
  // magic numbers (84px/74px) that stood in for "the real nav height".
  syncNavHeight_();
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
  await refreshTodaySummary_();
}

/**
 * Populates the Calories/Protein dashboard tiles from today's actually-
 * logged meals. A real-device report: these tiles kept showing "– / –"
 * even right after logging food — handleSaveMeal_ always wrote real
 * totals per meal, nothing on the dashboard ever read them back. Called
 * once when the dashboard loads and again right after a meal is saved
 * (see the addfood-save handler) so the numbers update the moment you
 * log something, not just on the next full app load.
 */
async function refreshTodaySummary_() {
  const caloriesEl = el_('stat-calories');
  const proteinEl = el_('stat-protein');
  const waterEl = el_('stat-water');
  try {
    const { todaySummary } = await apiGet('getTodaySummary');
    if (caloriesEl) {
      caloriesEl.textContent = todaySummary.mealsLoggedToday > 0
        ? `${todaySummary.caloriesToday} kcal` : '–';
    }
    if (proteinEl) {
      proteinEl.textContent = todaySummary.mealsLoggedToday > 0
        ? `${todaySummary.proteinGToday}g` : '–';
    }
    if (waterEl) {
      const haveWaterTarget = todaySummary.waterTargetMl > 0;
      const waterL = (Number(todaySummary.waterMlToday) || 0) / 1000;
      const targetL = (Number(todaySummary.waterTargetMl) || 0) / 1000;
      waterEl.textContent = haveWaterTarget
        ? `${waterL.toFixed(1)} / ${targetL.toFixed(1)} L`
        : '– / –';
    }
  } catch (err) {
    // Non-critical to the rest of the dashboard rendering — leave the
    // tiles at their "–" default and log for debugging rather than
    // interrupting the whole screen over a stats-tile fetch failing.
    console.error('Could not load today\'s food summary:', err);
  }
}

/**
 * Water quick-add buttons on the Today dashboard. A real-device report:
 * the Water stat tile had shown a target since Phase 1 but nothing on
 * the app ever let a person actually log any water — this wires the
 * three pill buttons to the new `logWater` backend action and refreshes
 * the stat tile immediately after, same "optimistic-ish but re-fetch
 * the real number" pattern as the rest of the dashboard.
 */
function initWaterQuickAdd_() {
  const errorEl = el_('dashboard-error');
  document.querySelectorAll('.water-add-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      if (errorEl) errorEl.hidden = true;
      const amountMl = Number(btn.dataset.ml);
      const allButtons = document.querySelectorAll('.water-add-btn');
      allButtons.forEach((b) => { b.disabled = true; });
      try {
        await apiPost('logWater', { amountMl });
        await refreshTodaySummary_();
      } catch (err) {
        console.error('Could not log water:', err);
        if (errorEl) {
          errorEl.textContent = humanizeErrorMessage_(err.message || 'Could not log water.');
          errorEl.hidden = false;
        }
      } finally {
        allButtons.forEach((b) => { b.disabled = false; });
      }
    });
  });
}

initWaterQuickAdd_();

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
  currentProfile_ = profile || null;
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
// firstname.lastname pattern — this lets someone override it. Pencil-
// icon view/edit toggle: a permanently-visible "Save" button made no
// sense when nothing was actively being edited — now Save only exists
// once you've tapped the pencil.

function syncNameInput_() {
  const input = el_('name-input');
  const displayEl = el_('name-display-text');
  const name = (currentUser && currentUser.name) || '';
  if (input) input.value = name;
  if (displayEl) displayEl.textContent = name || '–';
  showNameViewMode_();
}

function showNameViewMode_() {
  const viewRow = el_('name-view-row');
  const editRow = el_('name-edit-row');
  if (viewRow) viewRow.hidden = false;
  if (editRow) editRow.hidden = true;
  const errorEl = el_('name-error');
  const savedEl = el_('name-saved');
  if (errorEl) errorEl.hidden = true;
  if (savedEl) savedEl.hidden = true;
}

function showNameEditMode_() {
  const viewRow = el_('name-view-row');
  const editRow = el_('name-edit-row');
  if (viewRow) viewRow.hidden = true;
  if (editRow) editRow.hidden = false;
  const input = el_('name-input');
  if (input) { input.focus(); input.select(); }
}

document.getElementById('edit-name-btn')?.addEventListener('click', showNameEditMode_);

document.getElementById('cancel-name-btn')?.addEventListener('click', () => {
  syncNameInput_(); // resets the input back to the current saved name too
});

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
    const displayEl = el_('name-display-text');
    if (displayEl) displayEl.textContent = name;
    showNameViewMode_();
    if (savedEl) { savedEl.textContent = 'Saved.'; savedEl.hidden = false; }
    // Note: deliberately NOT calling renderProfile() here — the
    // display name lives on the Users sheet, not the Profile sheet,
    // so there's nothing profile-related to re-render, and passing
    // currentUser (which only has {email, name, status}) into
    // renderProfile would have blanked out the profile dump instead.
  } catch (err) {
    if (errorEl) { errorEl.textContent = humanizeErrorMessage_(err.message || 'Save failed.'); errorEl.hidden = false; }
  } finally {
    btn.disabled = false;
    btn.textContent = idleLabel;
  }
});

// --- Profile setup / edit --------------------------------------------------
// screen-setup and #setup-form are shared between first-run setup and
// LATER edits — this is a fully functional personal-trainer app, not a
// one-time-configured tracker, so every profile field (goals, diet,
// schedule, equipment...) needs to stay editable as life changes, not
// just at signup. editProfileMode_ picks which behavior applies once
// the form is submitted.

const GOAL_CHECKBOX_VALUES_ = ['Fat loss', 'Muscle gain', 'Recomposition', 'General fitness / maintenance', 'Strength', 'Endurance'];

function setSetupScreenMode_(mode) {
  editProfileMode_ = mode === 'edit';
  const cancelBtn = el_('setup-cancel-btn');
  const title = el_('setup-title');
  const subtitle = el_('setup-subtitle');
  const submitBtn = el_('setup-submit-btn');
  // Cancel lives at the BOTTOM of the form next to Save (not up in the
  // header) — see the index.html comment on screen-setup for why.
  if (cancelBtn) cancelBtn.hidden = !editProfileMode_;
  if (editProfileMode_) {
    if (title) title.textContent = 'Edit your profile';
    if (subtitle) subtitle.textContent = 'Update anything that\'s changed — your coach uses this to personalize every recommendation.';
    if (submitBtn) submitBtn.textContent = 'Save changes';
  } else {
    if (title) title.innerHTML = 'Welcome, <span class="welcome-name"></span> 👋';
    if (subtitle) subtitle.textContent = 'Let\'s set up your fitness profile. This runs once — you can edit it later.';
    if (submitBtn) submitBtn.textContent = 'Save profile & continue';
    setWelcomeName(currentUser && currentUser.name);
  }
}

/**
 * Pre-fills every #setup-form field from the currently-loaded profile
 * (currentProfile_) so editing feels like editing, not re-entering
 * everything from scratch. Goals is a comma-joined string in the
 * sheet (see Profile.gs) — split back into the matching checkboxes.
 */
function populateSetupForm_(profile) {
  const form = el_('setup-form');
  if (!form || !profile) return;
  const setVal = (name, value) => {
    const field = form.elements[name];
    if (field) field.value = (value === undefined || value === null) ? '' : value;
  };
  setVal('age', profile.Age);
  setVal('heightCm', profile.HeightCm);
  setVal('startWeightKg', profile.StartWeightKg);
  setVal('targetWeightKg', profile.TargetWeightKg);
  setVal('trainingExperience', profile.TrainingExperience);
  setVal('workoutDaysPerWeek', profile.WorkoutDaysPerWeek);
  setVal('preferredWorkoutDurationMin', profile.PreferredWorkoutDurationMin);
  setVal('availableEquipment', profile.AvailableEquipment);
  setVal('dietaryPreferences', profile.DietaryPreferences);
  setVal('typicalSchedule', profile.TypicalSchedule);

  const goalsStr = profile.Goal || profile.Goals || '';
  const goalsSet = new Set(goalsStr.split(',').map((g) => g.trim()).filter(Boolean));
  GOAL_CHECKBOX_VALUES_.forEach((value) => {
    const checkbox = Array.from(form.elements['goals'] || []).find((el) => el.value === value);
    if (checkbox) checkbox.checked = goalsSet.has(value);
  });
}

function openEditProfile_() {
  setSetupScreenMode_('edit');
  populateSetupForm_(currentProfile_);
  const errorEl = el_('setup-error');
  if (errorEl) errorEl.hidden = true;
  showScreen('screen-setup');
}

document.getElementById('edit-profile-btn')?.addEventListener('click', openEditProfile_);

document.getElementById('setup-cancel-btn')?.addEventListener('click', () => {
  setSetupScreenMode_('setup'); // reset chrome for next time this screen is needed fresh
  showScreen('screen-profile');
});

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

  // The save itself and "now show me the dashboard/profile" afterward
  // are two separate steps with two separate failure modes.
  // Conflating them used to mean a harmless rendering hiccup right
  // after a SUCCESSFUL save got reported as "Could not save profile"
  // — not just confusing, actively wrong, and could prompt
  // re-submitting a duplicate row for data that already saved fine.
  try {
    await apiPost('saveProfile', payload);
  } catch (err) {
    errorEl.textContent = 'Could not save your profile — ' + humanizeErrorMessage_(err.message);
    errorEl.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = idleLabel;
    return;
  }

  const wasEditing = editProfileMode_;
  try {
    const { profile } = await apiGet('getProfile');
    if (wasEditing) {
      renderProfile(profile);
      setSetupScreenMode_('setup'); // reset chrome before leaving edit mode
      showScreen('screen-profile');
      submitBtn.disabled = false;
      submitBtn.textContent = idleLabel;
    } else {
      await enterAppShell_(profile);
    }
  } catch (err) {
    console.error('Profile saved, but refreshing the view afterward failed:', err);
    errorEl.textContent = 'Your profile was saved. Please reload the app to see the update.';
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
// A hard ceiling on how long a Form Check clip can be. Two real
// reasons, not an arbitrary number: (1) a longer clip means more
// on-device pose-tracking work and more frames base64-encoded into the
// Gemini request, which is exactly what pushes a slow phone/network
// past the 25s request timeout in api.js; (2) Gemini has its own
// request-size ceiling, and a multi-minute clip risks tripping it
// outright rather than just being slow. One rep of one exercise fits
// comfortably in well under a minute, so this is not a real limit on
// what Form Check can be used for.
const FORMCHECK_MAX_VIDEO_SEC_ = 60;

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

let visionFilesetPromise_ = null; // stateless module+wasm load — safe to cache across attempts
let lastPoseLandmarker_ = null;   // the instance from the MOST RECENT attempt only — see createPoseLandmarker_
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
 * Lazily loads (and caches) the MediaPipe vision module + WASM fileset.
 * These are stateless — safe to reuse across every "Analyze form"
 * attempt for the whole page session — unlike the PoseLandmarker
 * instance itself (see createPoseLandmarker_ below). If loading fails
 * (including timing out — see withTimeout_ above), the cached promise
 * is cleared so the NEXT attempt gets a fresh try instead of being
 * stuck on a permanently-rejected promise for the rest of the session
 * (e.g. the user's wifi comes back).
 */
function getVisionFileset_() {
  if (!visionFilesetPromise_) {
    visionFilesetPromise_ = withTimeout_((async () => {
      const vision = await import(POSE_VISION_BUNDLE_URL_);
      const wasmFileset = await vision.FilesetResolver.forVisionTasks(POSE_WASM_BASE_);
      return { vision, wasmFileset };
    })(), POSE_LOAD_TIMEOUT_MS_, 'Loading the pose-tracking runtime took too long (check your connection).');
    visionFilesetPromise_.catch(() => { visionFilesetPromise_ = null; });
  }
  return visionFilesetPromise_;
}

/**
 * Creates a BRAND NEW PoseLandmarker instance for this "Analyze form"
 * attempt, closing whatever instance the previous attempt created.
 *
 * Root cause of a real bug hit on-device (not a hypothetical): an
 * earlier version of this file cached a SINGLE PoseLandmarker instance
 * (poseLandmarkerPromise_) and reused it across every separate
 * analysis attempt, while runPoseAnalysis_ below restarts its own `t`
 * timestamp counter at 0 for every video it processes. MediaPipe's
 * VIDEO-mode PoseLandmarker requires timestamps to strictly increase
 * for the lifetime of ONE graph instance — feeding a second video's
 * t=0 into an instance that already saw a later timestamp from a prior
 * video throws a real `CalculatorGraph::Run()` "Packet timestamp
 * mismatch" error deep in the WASM graph. A fresh instance per attempt
 * has no memory of any prior timestamp, so this can't happen. The
 * (small) cost of recreating the landmarker each time is worth the
 * correctness guarantee; the expensive parts — the JS module and WASM
 * fileset — stay cached via getVisionFileset_ above.
 */
async function createPoseLandmarker_() {
  const { vision, wasmFileset } = await getVisionFileset_();
  if (lastPoseLandmarker_) {
    try { lastPoseLandmarker_.close(); } catch (e) { /* already invalid — ignore */ }
    lastPoseLandmarker_ = null;
  }
  const landmarker = await withTimeout_(
    vision.PoseLandmarker.createFromOptions(wasmFileset, {
      baseOptions: { modelAssetPath: POSE_MODEL_URL_ },
      runningMode: 'VIDEO',
      numPoses: 1
    }),
    POSE_LOAD_TIMEOUT_MS_,
    'Loading the pose-tracking model took too long (check your connection).'
  );
  lastPoseLandmarker_ = landmarker;
  return landmarker;
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
  // Deliberately does NOT probe the video's duration here (e.g. via
  // loadVideoFile_) — that shares one off-screen <video> element with
  // the submit handler below, and a person who picks a file then taps
  // "Analyze form" quickly enough could fire both loads at once,
  // racing to overwrite each other's onloadedmetadata/src on the same
  // element. Length enforcement (FORMCHECK_MAX_VIDEO_SEC_) happens once,
  // authoritatively, in the submit handler instead — see there.
  const statusEl = el_('formcheck-video-status');
  const errorEl = el_('formcheck-error');
  const file = e.target.files && e.target.files[0];
  if (!statusEl) return;
  if (errorEl) errorEl.hidden = true;
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
  const landmarker = await createPoseLandmarker_();
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
    if (errorEl) { errorEl.textContent = humanizeErrorMessage_(err.message); errorEl.hidden = false; }
    submitBtn.disabled = false;
    submitBtn.textContent = idleLabel;
    return;
  }

  // Belt-and-suspenders re-check (the file-picker's own change handler
  // already screens this, but a picked file can only be trusted at the
  // moment it's actually used) — see FORMCHECK_MAX_VIDEO_SEC_'s comment.
  if (duration > FORMCHECK_MAX_VIDEO_SEC_) {
    cleanup();
    if (errorEl) {
      showAndRevealError_(errorEl, `That clip is ${Math.round(duration)}s long — please pick one under ` +
        `${FORMCHECK_MAX_VIDEO_SEC_}s. One rep of the exercise is all that's needed.`);
    }
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
        errorEl.textContent = 'We couldn\'t automatically count your reps for this clip. ' +
          'Enter how many reps you did below and hit "Analyze form" again.';
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
    if (errorEl) { errorEl.textContent = humanizeErrorMessage_(err.message); errorEl.hidden = false; }
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = idleLabel;
  }
});

function renderFormCheckReport_(report) {
  // Surfaces a genuine mismatch loudly, above everything else — if the
  // AI decided what was filmed doesn't match what was logged, that's
  // more important to see first than the score, since the score/depth
  // numbers below were computed assuming the LOGGED exercise and may
  // not mean anything for what was actually performed.
  const mismatchEl = el_('formcheck-mismatch');
  if (mismatchEl) {
    if (report.exerciseMatchesVideo === false) {
      mismatchEl.textContent = '⚠️ This doesn\'t look like "' + (formCheckState_.exercise || 'the logged exercise') +
        '" — it looks like: ' + (report.detectedExercise || 'a different exercise') + '. The rep count, ' +
        'depth, and tempo numbers below were computed by pose-tracking software built for the logged ' +
        'exercise and may not be meaningful here — the coach\'s notes below are based on what it actually saw.';
      mismatchEl.hidden = false;
    } else {
      mismatchEl.hidden = true;
    }
  }

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
    if (saveErrorEl) { saveErrorEl.textContent = humanizeErrorMessage_(err.message); saveErrorEl.hidden = false; }
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
  const manualForm = el_('addfood-manual-form');
  if (manualForm) { manualForm.reset(); }
  const manualErrorEl = el_('addfood-manual-error');
  if (manualErrorEl) manualErrorEl.hidden = true;
  setAddFoodMode_('scan');
  showAddFoodPicker_(true);
}

/**
 * Toggles between the full scan/manual picker and its collapsed
 * "+ Add another item" form once at least one item is already in the
 * review list — see the comment on #addfood-picker in index.html for
 * why this exists (a real-device report: the full picker sitting above
 * the confidence/items card pushed the actual results below the fold).
 */
function showAddFoodPicker_(visible) {
  const pickerEl = el_('addfood-picker');
  const addAnotherBtn = el_('addfood-add-another-btn');
  const subtitleEl = el_('addfood-subtitle');
  if (pickerEl) pickerEl.hidden = !visible;
  if (addAnotherBtn) addAnotherBtn.hidden = visible;
  // The subtitle explains the two ways IN — only relevant while
  // actually choosing/using one of them, not while reviewing items
  // already added.
  if (subtitleEl) subtitleEl.hidden = !visible;
}

document.getElementById('addfood-add-another-btn')?.addEventListener('click', () => {
  showAddFoodPicker_(true);
});

/**
 * Switches between the two ways into Add Diet — scanning a photo (the
 * original AI flow) and typing an item in by hand. Both paths feed
 * the SAME addFoodState_.items/review list, so this only toggles which
 * capture form is visible; it never touches items already added.
 */
function setAddFoodMode_(mode) {
  const scanForm = el_('addfood-capture-form');
  const manualForm = el_('addfood-manual-form');
  const scanTab = el_('addfood-mode-scan-btn');
  const manualTab = el_('addfood-mode-manual-btn');
  if (scanForm) scanForm.hidden = mode !== 'scan';
  if (manualForm) manualForm.hidden = mode !== 'manual';
  if (scanTab) scanTab.classList.toggle('active', mode === 'scan');
  if (manualTab) manualTab.classList.toggle('active', mode === 'manual');
}

document.getElementById('addfood-mode-scan-btn')?.addEventListener('click', () => setAddFoodMode_('scan'));
document.getElementById('addfood-mode-manual-btn')?.addEventListener('click', () => setAddFoodMode_('manual'));

document.getElementById('addfood-manual-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const errorEl = el_('addfood-manual-error');
  if (errorEl) errorEl.hidden = true;

  const form = new FormData(e.target);
  const name = (form.get('name') || '').toString().trim();
  const mealType = (form.get('mealType') || '').toString();
  const calories = Number(form.get('calories'));
  const proteinG = Number(form.get('proteinG'));
  const carbsG = form.get('carbsG') ? Number(form.get('carbsG')) : 0;
  const fatG = form.get('fatG') ? Number(form.get('fatG')) : 0;

  if (!name) {
    showAndRevealError_(errorEl, 'Type a food name first.');
    return;
  }
  if (isNaN(calories) || calories < 0 || isNaN(proteinG) || proteinG < 0) {
    showAndRevealError_(errorEl, 'Enter at least calories and protein for this item.');
    return;
  }

  // Everything here shares the SAME item shape the AI-analyzed path
  // produces (see the addfood-capture-form submit handler above), so
  // the one review/edit/save UI below works identically regardless of
  // which door an item came in through. estimatedGrams is a nominal
  // 100g "baseline" purely so the existing quantity-multiplier math
  // (×1 = what you typed, ×0.5 = half, etc.) keeps working the same
  // way it does for a photo-estimated item.
  if (!addFoodState_.items) {
    addFoodState_.items = [];
    addFoodState_.mealType = mealType;
  }
  addFoodState_.items.push({
    name,
    portionDescription: 'Entered manually',
    estimatedGrams: 100,
    calories,
    proteinG,
    carbsG,
    fatG,
    fiberG: 0,
    confidence: 'manual',
    multiplier: 1,
    removed: false
  });

  renderAddFoodReview_();
  const reviewEl = el_('addfood-review');
  if (reviewEl) reviewEl.hidden = false;
  showAddFoodPicker_(false);
  e.target.reset();
});

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

    // Append to (never replace) any items already in the review list —
    // someone can switch to "Add manually" first, add an item, then
    // switch back and scan a photo too, all for the same meal.
    // Wholesale-replacing addFoodState_ here would have silently
    // thrown away whatever they'd already added by hand.
    const existingItems = addFoodState_.items || [];
    addFoodState_ = {
      items: existingItems.concat((proposal.items || []).map((item) => Object.assign({ multiplier: 1, removed: false }, item))),
      overallConfidence: proposal.overallConfidence,
      coachNote: proposal.coachNote,
      mealType: addFoodState_.mealType || mealType,
      notes,
      photoBase64: photo.base64,
      photoMimeType: photo.mimeType
    };
    renderAddFoodReview_();
    const reviewEl = el_('addfood-review');
    if (reviewEl) reviewEl.hidden = false;
    showAddFoodPicker_(false);
  } catch (err) {
    if (errorEl) { errorEl.textContent = humanizeErrorMessage_(err.message); errorEl.hidden = false; }
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
  // The confidence/coach-note card only means something when a photo
  // was actually analyzed — a fully hand-typed meal has no AI
  // confidence to report, so don't show an empty "Confidence: –" card
  // for it.
  const confCardEl = el_('addfood-confidence-card');
  if (confCardEl) confCardEl.hidden = !addFoodState_.overallConfidence && !addFoodState_.coachNote;

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
  removeBtn.textContent = item.removed ? 'Undo' : 'Remove';
  removeBtn.addEventListener('click', () => {
    item.removed = !item.removed;
    renderAddFoodReview_();
  });
  top.appendChild(nameEl);
  top.appendChild(removeBtn);
  row.appendChild(top);

  const portionEl = document.createElement('div');
  portionEl.className = 'food-item-portion';
  // A manually-typed item has no AI guess behind it — say so plainly
  // instead of an "AI estimate: ... confidence" line that would be
  // misleading (there was no AI involved in this item at all).
  portionEl.textContent = item.confidence === 'manual'
    ? `Entered manually — ${Math.round(item.estimatedGrams)}g baseline`
    : `AI estimate: ${item.portionDescription} (~${Math.round(item.estimatedGrams)}g, ${item.confidence} confidence)`;
  row.appendChild(portionEl);

  const qtyRow = document.createElement('div');
  qtyRow.className = 'food-item-qty-row';
  const qtyLabel = document.createElement('span');
  qtyLabel.textContent = 'Quantity ×';
  const qtyInput = document.createElement('input');
  qtyInput.type = 'number';
  qtyInput.className = 'food-item-qty-input';
  qtyInput.min = '0';
  qtyInput.step = '0.1';
  qtyInput.value = String(item.multiplier);

  // Directly editable portion in grams — the multiplier above is
  // useful for "half of this" type edits, but a user correcting the
  // AI's ~380g guess to an actual 100g wants to type "100," not do
  // the division themselves. Both fields stay in sync: editing either
  // one recomputes the other (via item.estimatedGrams as the shared
  // reference point) and both recompute macros/totals.
  const gramsLabel = document.createElement('span');
  gramsLabel.className = 'food-item-grams-label';
  gramsLabel.textContent = 'Portion (g)';
  const gramsInput = document.createElement('input');
  gramsInput.type = 'number';
  gramsInput.className = 'food-item-grams-input';
  gramsInput.min = '0';
  gramsInput.step = '1';
  gramsInput.value = String(Math.round(item.estimatedGrams * item.multiplier));

  qtyInput.addEventListener('input', () => {
    const val = Number(qtyInput.value);
    item.multiplier = isNaN(val) || val < 0 ? 0 : val;
    gramsInput.value = String(Math.round(item.estimatedGrams * item.multiplier));
    renderAddFoodItemMacros_(row, item);
    recomputeAddFoodTotals_();
  });
  gramsInput.addEventListener('input', () => {
    const grams = Number(gramsInput.value);
    if (isNaN(grams) || grams < 0) return;
    item.multiplier = item.estimatedGrams > 0 ? grams / item.estimatedGrams : 0;
    qtyInput.value = String(round1_(item.multiplier));
    renderAddFoodItemMacros_(row, item);
    recomputeAddFoodTotals_();
  });

  qtyRow.appendChild(qtyLabel);
  qtyRow.appendChild(qtyInput);
  qtyRow.appendChild(gramsLabel);
  qtyRow.appendChild(gramsInput);
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

    // Provenance for the Meals sheet — 'photo-ai' when every saved
    // item came from the scanned photo, 'manual' when every item was
    // typed in, 'mixed' on the (rare but possible) case someone scans
    // a photo AND adds another item by hand before saving the same
    // meal.
    const allManual = activeItems.every((item) => item.confidence === 'manual');
    const anyManual = activeItems.some((item) => item.confidence === 'manual');
    const source = allManual ? 'manual' : (anyManual ? 'mixed' : 'photo-ai');

    await apiPost('saveMeal', {
      mealType: addFoodState_.mealType,
      notes: addFoodState_.notes,
      photo: addFoodState_.photoBase64 ? { base64: addFoodState_.photoBase64, mimeType: addFoodState_.photoMimeType } : null,
      items,
      overallConfidence: addFoodState_.overallConfidence,
      coachNote: addFoodState_.coachNote,
      source
    });
    if (saveNoticeEl) saveNoticeEl.hidden = false;
    btn.textContent = 'Saved';
    // So the dashboard's Calories/Protein tiles reflect what was just
    // logged immediately, not only after the next full app reload —
    // this is exactly the gap a real-device report caught.
    refreshTodaySummary_();
    // A real-device report: saving left the person staring at a
    // disabled "Saved" button with nowhere to go, on a screen whose
    // whole purpose is logging more food — the natural next thing to
    // do is log another meal, not sit here. Brief pause so "Saved." is
    // actually readable, then reset straight back to a fresh entry
    // (still on this screen, not the dashboard — see resetAddFoodScreen_).
    setTimeout(() => {
      if (!el_('screen-addfood')?.hidden) resetAddFoodScreen_();
    }, 1200);
  } catch (err) {
    if (saveErrorEl) { saveErrorEl.textContent = humanizeErrorMessage_(err.message); saveErrorEl.hidden = false; }
    btn.disabled = false;
    btn.textContent = idleLabel;
  }
});

// =====================================================================
// Workout logging (Phase 3, Checkpoint A)
//
// Design mirrors the reference app the user recorded (see DESIGN.md
// section 18): one card per exercise added this session, each with its
// own SET / PREVIOUS / KG / REPS rows; a live Volume/Sets/Records
// header; a rest timer chip that starts the moment a set is checked
// off; and a gold-W / plain-number / red-X set-type badge you cycle by
// tapping it. All the math (previous-value lookup, PR detection,
// session totals) is server-side in Workouts.gs — this file only
// renders what the backend returns and never invents its own numbers.
// =====================================================================

let workoutState_ = null; // null when no workout is in progress
let exerciseLibraryCache_ = null; // fetched once per app load, refreshed after adding a custom exercise
let workoutElapsedInterval_ = null;
let workoutRestInterval_ = null;

function freshWorkoutState_(sessionId, startedAt) {
  return {
    sessionId,
    startedAt,
    exercises: [], // { name, muscleGroup, iconEmoji, defaultRestSec, sets: [...] }
    totals: { volumeKg: 0, sets: 0, prCount: 0 }
  };
}

function findWorkoutExercise_(name) {
  return workoutState_ && workoutState_.exercises.find((ex) => ex.name === name);
}

// --- Starting / resuming / discarding a session ----------------------

document.getElementById('quick-workout-btn')?.addEventListener('click', async () => {
  if (workoutState_) {
    // Already mid-workout (e.g. navigated away to Add Food and back) —
    // resume exactly where it was rather than silently starting a
    // second, orphaned session.
    renderWorkoutScreen_();
    showScreen('screen-workout');
    return;
  }
  // Deliberately do NOT create the session or start the clock here —
  // tapping "Log Workout" only opens the exercise picker. The session
  // (and its elapsed-time clock) is created in selectExerciseForWorkout_,
  // the moment the user actually picks their first exercise, so time
  // spent browsing/searching the exercise list before deciding never
  // gets counted as workout time.
  openExercisePicker_();
});

document.getElementById('workout-cancel-btn')?.addEventListener('click', () => {
  stopWorkoutElapsedTimer_();
  stopRestTimer_();
  workoutState_ = null;
  showScreen('screen-dashboard');
});

document.getElementById('workout-add-exercise-btn')?.addEventListener('click', () => {
  openExercisePicker_();
});

function startWorkoutElapsedTimer_() {
  stopWorkoutElapsedTimer_();
  const el = el_('workout-elapsed');
  const pillTimeEl = el_('active-workout-pill-time');
  const tick = () => {
    if (!workoutState_) return;
    const elapsedSec = Math.max(0, Math.round((Date.now() - new Date(workoutState_.startedAt).getTime()) / 1000));
    const m = Math.floor(elapsedSec / 60);
    const s = elapsedSec % 60;
    const mmss = `${m}:${s < 10 ? '0' + s : s}`;
    if (el) el.textContent = `${mmss} elapsed`;
    // Also drives the persistent resume pill (see updateActiveWorkoutPill_)
    // so its time keeps ticking even while a completely different
    // screen — Add Food, History, Profile — is what's actually showing.
    if (pillTimeEl) pillTimeEl.textContent = mmss;
  };
  tick();
  workoutElapsedInterval_ = setInterval(tick, 1000);
}

function stopWorkoutElapsedTimer_() {
  if (workoutElapsedInterval_) { clearInterval(workoutElapsedInterval_); workoutElapsedInterval_ = null; }
}

// --- Persistent "Active Workout" resume pill --------------------------
// Visible above the bottom nav from ANY screen (except screen-workout
// itself, where it would be redundant) while a workout is in
// progress — so navigating off to log a meal or check history never
// makes an in-progress session disappear from view. Re-evaluated on
// every showScreen() call (see that function) rather than only when
// starting/finishing a workout, since the right answer depends on
// BOTH "is a workout active" AND "which screen is showing right now".

function updateActiveWorkoutPill_(currentScreenId) {
  const pill = el_('active-workout-pill');
  if (!pill) return;
  pill.hidden = !workoutState_ || currentScreenId === 'screen-workout';
  // The coach chat's input bar shares the same "just above the nav"
  // spot the pill floats in — whenever the pill's visibility changes,
  // re-check whether the input bar needs to shift up above it.
  updateCoachInputBarPosition_();
}

/**
 * Keeps the Coach chat's input bar correctly positioned: by default it
 * sits just above the bottom nav (the CSS default), but if the
 * active-workout resume pill is ALSO visible right now, it shifts up
 * to sit just above that pill instead — so the two floating bars never
 * overlap. Also tops up #coach-messages' bottom padding so the last
 * message is never hidden behind wherever the (now fixed-position)
 * input bar currently is. Safe to call even when the coach screen
 * isn't showing right now — el_ + hidden-element measurements just
 * become harmless zero-size rects.
 */
function updateCoachInputBarPosition_() {
  const form = el_('coach-form');
  if (!form) return;
  const pill = document.getElementById('active-workout-pill');
  const gap = 12;
  if (pill && !pill.hidden) {
    const pillRect = pill.getBoundingClientRect();
    form.style.bottom = Math.max(0, window.innerHeight - pillRect.top + gap) + 'px';
  } else {
    form.style.bottom = ''; // fall back to the CSS default (just above the nav)
  }
  const messagesEl = el_('coach-messages');
  if (messagesEl) {
    const formRect = form.getBoundingClientRect();
    messagesEl.style.paddingBottom = Math.max(0, window.innerHeight - formRect.top) + 16 + 'px';
  }
}

document.getElementById('active-workout-resume-btn')?.addEventListener('click', () => {
  if (!workoutState_) return;
  renderWorkoutScreen_();
  showScreen('screen-workout');
});

document.getElementById('active-workout-pill-discard-btn')?.addEventListener('click', () => {
  if (!workoutState_) return;
  stopWorkoutElapsedTimer_();
  stopRestTimer_();
  workoutState_ = null;
  updateActiveWorkoutPill_(document.querySelector('.screen:not([hidden])')?.id);
});

// --- Rest timer --------------------------------------------------------

function startRestTimer_(seconds) {
  stopRestTimer_();
  const chip = el_('workout-rest-chip');
  const remainingEl = el_('workout-rest-remaining');
  if (!chip || !remainingEl) return;
  let remaining = seconds;
  chip.hidden = false;
  remainingEl.textContent = remaining;
  workoutRestInterval_ = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      stopRestTimer_();
    } else {
      remainingEl.textContent = remaining;
    }
  }, 1000);
}

function stopRestTimer_() {
  if (workoutRestInterval_) { clearInterval(workoutRestInterval_); workoutRestInterval_ = null; }
  const chip = el_('workout-rest-chip');
  if (chip) chip.hidden = true;
}

document.getElementById('workout-rest-skip-btn')?.addEventListener('click', () => {
  stopRestTimer_();
});

// --- Exercise picker -----------------------------------------------------

async function openExercisePicker_() {
  showScreen('screen-exercise-picker');
  const searchInput = el_('exercise-search-input');
  if (searchInput) searchInput.value = '';
  const errorEl = el_('exercise-picker-error');
  if (errorEl) errorEl.hidden = true;
  const customNameInput = el_('exercise-custom-name');
  if (customNameInput) customNameInput.value = '';

  if (exerciseLibraryCache_) {
    renderExercisePickerList_('');
    return;
  }
  const loadingEl = el_('exercise-picker-loading');
  const listEl = el_('exercise-picker-list');
  if (loadingEl) loadingEl.hidden = false;
  if (listEl) listEl.hidden = true;
  try {
    const result = await apiGet('getExerciseLibrary');
    exerciseLibraryCache_ = result.exercises || [];
    renderExercisePickerList_('');
  } catch (err) {
    if (errorEl) { errorEl.textContent = humanizeErrorMessage_(err.message); errorEl.hidden = false; }
  } finally {
    if (loadingEl) loadingEl.hidden = true;
    if (listEl) listEl.hidden = false;
  }
}

document.getElementById('exercise-picker-back-btn')?.addEventListener('click', () => {
  // No session exists yet if the picker was opened straight from
  // "Log Workout" and the user backed out without picking anything —
  // screen-workout would render a workout screen for a session that
  // was never created, so go back to the dashboard instead.
  showScreen(workoutState_ ? 'screen-workout' : 'screen-dashboard');
});

document.getElementById('exercise-search-input')?.addEventListener('input', (e) => {
  renderExercisePickerList_(e.target.value || '');
});

function renderExercisePickerList_(filterText) {
  const listEl = el_('exercise-picker-list');
  const emptyEl = el_('exercise-picker-empty');
  if (!listEl || !exerciseLibraryCache_) return;
  const needle = filterText.trim().toLowerCase();
  const matches = exerciseLibraryCache_.filter((ex) => !needle || ex.name.toLowerCase().includes(needle));

  listEl.innerHTML = '';
  matches.forEach((ex) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'exercise-picker-item';
    btn.innerHTML = `
      <span class="exercise-icon">${escapeHtml_(deriveExerciseIcon_(ex))}</span>
      <span class="exercise-picker-info">
        <span class="exercise-picker-name">${escapeHtml_(ex.name)}</span>
        <span class="exercise-picker-meta">${escapeHtml_([ex.muscleGroup, ex.equipment].filter(Boolean).join(' · '))}</span>
      </span>
      <span class="exercise-picker-used">${ex.timesUsed ? 'Used ' + ex.timesUsed + 'x' : ''}</span>
    `;
    btn.addEventListener('click', () => selectExerciseForWorkout_(ex));
    listEl.appendChild(btn);
  });
  if (emptyEl) emptyEl.hidden = matches.length > 0;
}

document.getElementById('exercise-custom-add-btn')?.addEventListener('click', async () => {
  const nameInput = el_('exercise-custom-name');
  const errorEl = el_('exercise-picker-error');
  if (!nameInput) return;
  const name = nameInput.value.trim();
  if (errorEl) errorEl.hidden = true;
  if (!name) {
    // Previously a silent no-op — tapping "Add" with nothing typed did
    // nothing at all, no different from a stuck/broken button. Now
    // says exactly what's needed instead of leaving it to guesswork.
    showAndRevealError_(errorEl, 'Type an exercise name first.');
    nameInput.focus();
    return;
  }
  try {
    const result = await apiPost('addCustomExercise', { name });
    exerciseLibraryCache_ = null; // stale after adding — refetch next time the picker opens
    selectExerciseForWorkout_({
      name: result.name, iconEmoji: '', muscleGroup: '', equipment: '', defaultRestSec: 90
    });
  } catch (err) {
    showAndRevealError_(errorEl, err.message);
  }
});

/**
 * Adds `ex` to the in-progress workout (if it isn't already in it —
 * tapping an already-added exercise just returns to the workout screen
 * instead of creating a second card for the same exercise), fetches
 * its "previous" set data scoped to THIS session (so a set logged a
 * minute ago in this same session never shows as its own "previous" —
 * see Workouts.gs's handleGetPreviousSetData_), and seeds one starter
 * set row.
 *
 * Also where the workout session itself (and its elapsed-time clock)
 * actually gets created, if this is the FIRST exercise picked — see
 * the quick-workout-btn handler above for why that moved here instead
 * of firing the moment "Log Workout" was tapped.
 */
async function selectExerciseForWorkout_(ex) {
  if (!workoutState_) {
    showLoading_('Starting your workout…');
    try {
      const result = await apiPost('startWorkoutSession', {});
      workoutState_ = freshWorkoutState_(result.sessionId, result.startedAt);
      startWorkoutElapsedTimer_();
    } catch (err) {
      showLoadingError_(err.message);
      return;
    }
  }
  showScreen('screen-workout');
  let exercise = findWorkoutExercise_(ex.name);
  if (!exercise) {
    exercise = {
      name: ex.name,
      muscleGroup: ex.muscleGroup || '',
      iconEmoji: deriveExerciseIcon_(ex),
      defaultRestSec: ex.defaultRestSec || 90,
      previousSets: [],
      sets: []
    };
    workoutState_.exercises.push(exercise);
    try {
      const prev = await apiGet('getPreviousSetData', { exercise: ex.name, sessionId: workoutState_.sessionId });
      exercise.previousSets = prev.previousSets || [];
    } catch (err) {
      console.warn('Could not load previous set data for ' + ex.name + ':', err.message);
    }
    addSetRow_(exercise);
  }
  renderWorkoutScreen_();
}

// --- Active workout screen ------------------------------------------------

function addSetRow_(exercise) {
  const setNumber = exercise.sets.length + 1;
  const previous = exercise.previousSets[setNumber - 1];
  exercise.sets.push({
    setNumber,
    setType: 'normal',
    weightKg: previous ? previous.weightKg : '',
    reps: previous ? previous.reps : '',
    completed: false,
    isPR: false
  });
}

const SET_TYPE_CYCLE_ = ['normal', 'warmup', 'failed'];
function cycleSetType_(setType) {
  const idx = SET_TYPE_CYCLE_.indexOf(setType);
  return SET_TYPE_CYCLE_[(idx + 1) % SET_TYPE_CYCLE_.length];
}
function setTypeBadgeLabel_(setType, setNumber) {
  if (setType === 'warmup') return 'W';
  if (setType === 'failed') return '✕';
  return String(setNumber);
}

function recomputeLocalTotals_() {
  const totals = { volumeKg: 0, sets: 0, prCount: 0 };
  workoutState_.exercises.forEach((exercise) => {
    exercise.sets.forEach((set) => {
      if (!set.completed) return;
      totals.volumeKg += (Number(set.weightKg) || 0) * (Number(set.reps) || 0);
      totals.sets += 1;
      if (set.isPR) totals.prCount += 1;
    });
  });
  workoutState_.totals = totals;
}

function renderWorkoutStats_() {
  const volEl = el_('workout-stat-volume');
  const setsEl = el_('workout-stat-sets');
  const prEl = el_('workout-stat-prs');
  if (volEl) volEl.textContent = round1_(workoutState_.totals.volumeKg);
  if (setsEl) setsEl.textContent = workoutState_.totals.sets;
  if (prEl) prEl.textContent = workoutState_.totals.prCount;
  // Small "bump" animation on the stat that likely just changed —
  // reusing the same class on all three is harmless since only the
  // ones actually re-rendered are visible to the user at that moment.
  [volEl, setsEl, prEl].forEach((node) => {
    if (!node) return;
    node.classList.remove('bump');
    void node.offsetWidth;
    node.classList.add('bump');
  });
}

/**
 * Full re-render of the active workout screen from workoutState_. Kept
 * as one function (rebuild everything) rather than fine-grained DOM
 * patching — this app's workout sessions have at most a handful of
 * exercises/sets, so a full re-render is cheap and far less bug-prone
 * than hand-rolled incremental updates.
 */
function renderWorkoutScreen_() {
  if (!workoutState_) return;
  recomputeLocalTotals_();
  renderWorkoutStats_();

  const listEl = el_('workout-exercise-list');
  const emptyEl = el_('workout-empty-notice');
  if (!listEl) return;
  listEl.innerHTML = '';

  if (!workoutState_.exercises.length) {
    if (emptyEl) emptyEl.hidden = false;
    return;
  }
  if (emptyEl) emptyEl.hidden = true;

  workoutState_.exercises.forEach((exercise) => {
    listEl.appendChild(renderExerciseCard_(exercise));
  });
}

function renderExerciseCard_(exercise) {
  const card = document.createElement('div');
  card.className = 'exercise-card';

  const header = document.createElement('div');
  header.className = 'exercise-card-header';
  header.innerHTML = `
    <span class="exercise-icon">${escapeHtml_(exercise.iconEmoji)}</span>
    <span class="exercise-name">${escapeHtml_(exercise.name)}</span>
  `;
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'exercise-card-remove-btn';
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', () => {
    workoutState_.exercises = workoutState_.exercises.filter((ex) => ex !== exercise);
    renderWorkoutScreen_();
  });
  header.appendChild(removeBtn);
  card.appendChild(header);

  const table = document.createElement('div');
  table.className = 'set-table';
  const headerRow = document.createElement('div');
  headerRow.className = 'set-row set-row-header';
  headerRow.innerHTML = '<span>SET</span><span>PREVIOUS</span><span>KG</span><span>REPS</span><span></span>';
  table.appendChild(headerRow);

  exercise.sets.forEach((set) => {
    table.appendChild(renderSetRow_(exercise, set));
    if (set.isPR) {
      const prBadge = document.createElement('div');
      prBadge.className = 'set-pr-badge';
      prBadge.textContent = '🏆 New PR!';
      table.appendChild(prBadge);
    }
  });
  card.appendChild(table);

  const addSetBtn = document.createElement('button');
  addSetBtn.type = 'button';
  addSetBtn.className = 'add-set-btn';
  addSetBtn.textContent = '+ Add Set';
  addSetBtn.addEventListener('click', () => {
    addSetRow_(exercise);
    renderWorkoutScreen_();
  });
  card.appendChild(addSetBtn);

  return card;
}

function renderSetRow_(exercise, set) {
  const row = document.createElement('div');
  row.className = 'set-row' + (set.completed ? ' set-completed' : '');

  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'set-number-badge' + (set.setType !== 'normal' ? ' set-type-' + set.setType : '');
  badge.textContent = setTypeBadgeLabel_(set.setType, set.setNumber);
  badge.title = 'Tap to cycle: normal set / warm-up / failed rep';
  badge.addEventListener('click', () => {
    set.setType = cycleSetType_(set.setType);
    renderWorkoutScreen_();
  });
  row.appendChild(badge);

  const previous = exercise.previousSets[set.setNumber - 1];
  const prevEl = document.createElement('span');
  prevEl.className = 'set-previous';
  prevEl.textContent = previous ? `${previous.weightKg}kg × ${previous.reps}` : '—';
  row.appendChild(prevEl);

  const weightInput = document.createElement('input');
  weightInput.type = 'number';
  weightInput.inputMode = 'decimal';
  weightInput.className = 'set-weight-input';
  weightInput.value = set.weightKg;
  weightInput.addEventListener('input', () => { set.weightKg = weightInput.value; });
  row.appendChild(weightInput);

  const repsInput = document.createElement('input');
  repsInput.type = 'number';
  repsInput.inputMode = 'numeric';
  repsInput.className = 'set-reps-input';
  repsInput.value = set.reps;
  repsInput.addEventListener('input', () => { set.reps = repsInput.value; });
  row.appendChild(repsInput);

  const completeBtn = document.createElement('button');
  completeBtn.type = 'button';
  completeBtn.className = 'set-complete-btn';
  completeBtn.textContent = '✓';
  completeBtn.addEventListener('click', () => toggleSetComplete_(exercise, set, completeBtn));
  row.appendChild(completeBtn);

  return row;
}

/**
 * Logs (or un-logs) a set. Always sends the full set payload — this is
 * an upsert on the backend keyed by (session, exercise, setNumber), so
 * re-toggling the same set updates that one row instead of creating a
 * duplicate (see Workouts.gs's handleLogSet_/findWorkoutSetRowIndex_).
 * Starts the rest timer only when COMPLETING a set, never on undo.
 */
async function toggleSetComplete_(exercise, set, btn) {
  // Every other async button in this app (Save, Analyze, Finish
  // Workout...) disables itself and shows a pending label while its
  // request is in flight — this one never did, so a slow/cold-start
  // backend call (see api.js's 25s timeout) left the checkmark looking
  // completely inert for however long that took: a real-device report
  // of "the save button isn't working" turned out to be exactly this —
  // it WAS working, there was just zero feedback that anything was
  // happening, and nothing stopped a second, third, fourth tap from
  // firing more concurrent requests for the same set in the meantime.
  if (btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '…';
  }
  const nextCompleted = !set.completed;
  const errorEl = el_('workout-error');
  if (errorEl) errorEl.hidden = true;
  try {
    const result = await apiPost('logSet', {
      sessionId: workoutState_.sessionId,
      exercise: exercise.name,
      muscleGroup: exercise.muscleGroup,
      setNumber: set.setNumber,
      setType: set.setType,
      weightKg: Number(set.weightKg) || 0,
      reps: Number(set.reps) || 0,
      completed: nextCompleted,
      restSec: exercise.defaultRestSec
    });
    set.completed = nextCompleted;
    set.isPR = nextCompleted ? !!result.isPR : false;
    if (nextCompleted) startRestTimer_(exercise.defaultRestSec);
    renderWorkoutScreen_(); // rebuilds this button fresh (not disabled) on success
  } catch (err) {
    // A real-device report of "tapping the checkmark does nothing" was
    // this error firing correctly but rendering off-screen, below
    // however many exercise cards were already on the page — see
    // showAndRevealError_. If this fires with a "Sheet not found"-style
    // message, runMigrationAddWorkoutTracking() likely hasn't been run
    // yet on the live spreadsheet (see DESIGN.md section 19/21).
    showAndRevealError_(errorEl, err.message);
    if (btn) { btn.disabled = false; btn.textContent = '✓'; }
  }
}

// --- Finishing a workout --------------------------------------------------

document.getElementById('workout-finish-btn')?.addEventListener('click', async () => {
  if (!workoutState_) return;
  const btn = el_('workout-finish-btn');
  const errorEl = el_('workout-error');
  const noticeEl = el_('workout-finish-notice');
  if (errorEl) errorEl.hidden = true;
  if (noticeEl) noticeEl.hidden = true;
  const idleLabel = btn ? btn.textContent : 'Finish Workout';
  if (btn) { btn.disabled = true; btn.textContent = 'Finishing…'; }

  try {
    const summary = await apiPost('finishWorkoutSession', { sessionId: workoutState_.sessionId });
    stopWorkoutElapsedTimer_();
    stopRestTimer_();
    const mins = Math.round(summary.durationSec / 60);
    if (noticeEl) {
      noticeEl.hidden = false;
      noticeEl.textContent = `Workout complete — ${mins} min, ${summary.totalVolumeKg}kg total volume, ` +
        `${summary.totalSets} sets${summary.prCount ? `, 🏆 ${summary.prCount} new record${summary.prCount > 1 ? 's' : ''}` : ''}.`;
    }
    workoutState_ = null;
    setTimeout(() => showScreen('screen-dashboard'), 1800);
  } catch (err) {
    if (errorEl) { errorEl.textContent = humanizeErrorMessage_(err.message); errorEl.hidden = false; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = idleLabel; }
  }
});

// --- Workout history --------------------------------------------------

async function loadWorkoutHistory_() {
  const loadingEl = el_('workout-history-loading');
  const listEl = el_('workout-history-list');
  const emptyEl = el_('workout-history-empty');
  const errorEl = el_('workout-history-error');
  if (errorEl) errorEl.hidden = true;
  if (emptyEl) emptyEl.hidden = true;
  if (listEl) { listEl.hidden = true; listEl.innerHTML = ''; }
  if (loadingEl) loadingEl.hidden = false;

  try {
    const result = await apiGet('getRecentWorkoutSessions', { limit: 20 });
    const sessions = result.sessions || [];
    if (!sessions.length) {
      if (emptyEl) emptyEl.hidden = false;
    } else if (listEl) {
      sessions.forEach((s) => listEl.appendChild(renderHistoryCard_(s)));
      listEl.hidden = false;
    }
  } catch (err) {
    if (errorEl) { errorEl.textContent = humanizeErrorMessage_(err.message); errorEl.hidden = false; }
  } finally {
    if (loadingEl) loadingEl.hidden = true;
  }
}

function renderHistoryCard_(session) {
  const card = document.createElement('div');
  card.className = 'history-card';
  const mins = Math.round((session.durationSec || 0) / 60);
  const exercises = session.exercises || [];
  const exercisesLine = exercises.length
    ? exercises.map(escapeHtml_).join(', ')
    : 'No completed sets';
  // "bestExercise" is the exercise with the highest total volume
  // (weight × reps) in this session — a plain computation, not a
  // judgment call — labeled here as exactly that, not as some more
  // impressive-sounding claim the data doesn't actually support.
  const bestExerciseLine = session.bestExercise
    ? `<span class="history-card-best">🥇 Top by volume: ${escapeHtml_(session.bestExercise)}</span>`
    : '';
  card.innerHTML = `
    <div class="history-card-top"><strong>${escapeHtml_(formatDisplayDate_(session.date))}</strong><span>${mins} min</span></div>
    <div class="history-card-stats">
      <span>Volume: ${session.totalVolumeKg}kg</span>
      <span>Sets: ${session.totalSets}</span>
      <span>🏆 ${session.prCount}</span>
    </div>
    <div class="history-card-exercises">${exercisesLine}</div>
    ${bestExerciseLine}
  `;
  return card;
}

// --- Coach chat ------------------------------------------------------
// An ONGOING conversation, not a one-off analysis screen — the full
// history is loaded fresh every time this tab opens (see Coach.gs's
// handleGetCoachHistory_) and re-sent in full with every new message
// server-side, so the coach's replies stay grounded in real, current
// data instead of treating each visit as a cold start. See DESIGN.md
// section 21 for the memory-model decision this implements.

// Tracks the calendar date (in the viewer's local timezone) of the
// most recently appended message/divider, so appendCoachMessageEl_
// knows when to drop in a new "Today"/"Yesterday"/weekday divider —
// same visual pattern as WhatsApp's chat view, per the user's own
// reference screenshot. Reset at the top of every loadCoachHistory_
// call so re-opening the tab always rebuilds dividers from scratch
// rather than comparing against whatever was left over from before.
let coachLastRenderedDateKey_ = null;

function coachDateKey_(date) {
  return date.getFullYear() + '-' + date.getMonth() + '-' + date.getDate();
}

// "Today" / "Yesterday" / a weekday name for the last week / a full
// date beyond that — the same tiering WhatsApp uses for its own date
// dividers, so this reads as an already-familiar pattern rather than
// a new one to learn.
function formatChatDateLabel_(date) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((startOfToday - startOfDate) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays > 1 && diffDays < 7) return date.toLocaleDateString(undefined, { weekday: 'long' });
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
  });
}

function formatChatTimestamp_(date) {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * Appends one message bubble to the chat, first inserting a date
 * divider ahead of it whenever its calendar date differs from the
 * last thing rendered — so a long-running conversation reads in
 * clearly labeled day groups instead of one undifferentiated scroll of
 * bubbles with no sense of when anything was actually said.
 */
function appendCoachMessageEl_(messagesEl, message, dateOverride) {
  if (!messagesEl) return;
  const date = dateOverride || (message.timestamp ? new Date(message.timestamp) : new Date());
  const key = coachDateKey_(date);
  if (key !== coachLastRenderedDateKey_) {
    const divider = document.createElement('div');
    divider.className = 'coach-date-divider';
    divider.textContent = formatChatDateLabel_(date);
    messagesEl.appendChild(divider);
    coachLastRenderedDateKey_ = key;
  }
  messagesEl.appendChild(renderCoachMessage_(message, date));
}

async function loadCoachHistory_() {
  const loadingEl = el_('coach-history-loading');
  const messagesEl = el_('coach-messages');
  const emptyEl = el_('coach-empty');
  const errorEl = el_('coach-error');
  if (errorEl) errorEl.hidden = true;

  // Reload every time the tab is opened (not just once) — a message
  // sent from another device/tab, or simply re-opening after a while,
  // should always show the true current conversation, never a stale
  // in-memory copy.
  if (loadingEl) loadingEl.hidden = false;
  if (messagesEl) messagesEl.hidden = true;

  try {
    const result = await apiGet('getCoachHistory');
    const messages = result.messages || [];
    if (messagesEl) {
      messagesEl.innerHTML = '';
      coachLastRenderedDateKey_ = null; // rebuilding from scratch — start date-grouping fresh
      messages.forEach((m) => appendCoachMessageEl_(messagesEl, m));
    }
    if (emptyEl) emptyEl.hidden = messages.length > 0;
    scrollCoachToBottom_();
  } catch (err) {
    if (errorEl) { errorEl.textContent = humanizeErrorMessage_(err.message); errorEl.hidden = false; }
  } finally {
    if (loadingEl) loadingEl.hidden = true;
    if (messagesEl) messagesEl.hidden = false;
  }
}

function renderCoachMessage_(message, date) {
  const bubble = document.createElement('div');
  bubble.className = 'coach-msg ' + (message.role === 'user' ? 'coach-msg-user' : 'coach-msg-coach');
  const textEl = document.createElement('span');
  textEl.className = 'coach-msg-text';
  textEl.textContent = message.content;
  const timeEl = document.createElement('span');
  timeEl.className = 'coach-msg-time';
  timeEl.textContent = formatChatTimestamp_(date || (message.timestamp ? new Date(message.timestamp) : new Date()));
  bubble.appendChild(textEl);
  bubble.appendChild(timeEl);
  return bubble;
}

function scrollCoachToBottom_() {
  // #coach-messages' own overflow-y:auto never actually kicks in — its
  // parent (#screen-coach, inside #app) has no bounded height, so the
  // div simply grows to fit every message and the PAGE scrolls instead
  // (same root cause already noted above for why the input bar needed
  // position:fixed, not sticky: there's no scrolling ancestor here).
  // Setting messagesEl.scrollTop was therefore a no-op — real-device
  // report: opening Coach always showed the top of the conversation,
  // requiring a manual scroll down every single time. Scroll the
  // actual scrolling element instead. requestAnimationFrame ensures
  // this runs after the browser has laid out whatever was just
  // appended, not mid-mutation.
  requestAnimationFrame(() => {
    const scroller = document.scrollingElement || document.documentElement;
    scroller.scrollTop = scroller.scrollHeight;
  });
}

document.getElementById('coach-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = el_('coach-message-input');
  const sendBtn = el_('coach-send-btn');
  const errorEl = el_('coach-error');
  const typingEl = el_('coach-typing');
  const messagesEl = el_('coach-messages');
  const emptyEl = el_('coach-empty');
  if (!input) return;

  const message = input.value.trim();
  if (!message) return;
  if (errorEl) errorEl.hidden = true;

  // Optimistic: show the user's own message immediately rather than
  // waiting on the round trip — Coach.gs's handleSendCoachMessage_
  // saves the user's message server-side BEFORE calling Gemini, so
  // this always matches what actually gets persisted even if the
  // Gemini call itself then fails.
  appendCoachMessageEl_(messagesEl, { role: 'user', content: message });
  if (emptyEl) emptyEl.hidden = true;
  scrollCoachToBottom_();
  input.value = '';
  input.disabled = true;
  if (sendBtn) sendBtn.disabled = true;
  if (typingEl) typingEl.hidden = false;

  try {
    const result = await apiPost('sendCoachMessage', { message });
    appendCoachMessageEl_(messagesEl, { role: 'coach', content: result.reply });
    scrollCoachToBottom_();
  } catch (err) {
    showAndRevealError_(errorEl, err.message);
  } finally {
    if (typingEl) typingEl.hidden = true;
    input.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
    input.focus();
  }
});

// Minimal HTML-escaping for exercise names/muscle groups interpolated
// via innerHTML above — none of this data is expected to contain
// markup (it's either from the shared Exercises sheet or typed by the
// signed-in user themselves), but escaping costs nothing and removes
// any doubt.
function escapeHtml_(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Client-side mirror of Config.gs's deriveExerciseIcon_ — a real-device
// screenshot showed every single exercise in the picker rendering the
// same barbell emoji, even ones the backend's own seed data assigns a
// distinct icon to. Root cause: the IconEmoji column was added to an
// already-existing Exercises sheet by a later migration, which only
// appends the header — never backfills a value into rows that existed
// before it — so every already-seeded exercise had (and, until the
// user re-runs runMigrationRefreshExerciseIcons server-side, may still
// have) a blank IconEmoji cell, and the old `ex.iconEmoji || '🏋️'`
// fallback then rendered the same generic barbell for all of them.
// This client-side fallback fixes the SAME symptom immediately without
// waiting on that migration, by deriving a varied icon from the
// exercise's own name/muscle group instead of one hardcoded emoji.
//
// Second real-device pass: kept in exact sync with Config.gs's
// deriveExerciseIcon_ — see that file's comment for why the icons
// changed (no more reusing 🦵 for both Squat and Leg Press, no more
// ⬇️/🔽 "UI sort arrow"-looking icons, an actual keyword guess for a
// freshly-typed custom exercise instead of always landing on the bare
// barbell default).
const EXERCISE_NAME_ICONS_ = {
  'bench press (barbell)': '🏋️',
  'squat (barbell)': '🦵',
  'deadlift (barbell)': '🏋️‍♂️',
  'overhead press (barbell)': '🙆',
  'barbell row': '🚣',
  'pull-up': '🧗',
  'push-up': '🫸',
  'dumbbell curl': '💪',
  'bicep curl': '💪',
  'hammer curl': '💪',
  'tricep pushdown': '🦾',
  'tricep extension': '🦾',
  'overhead triceps': '🦾',
  'overhead triceps extension': '🦾',
  'skull crusher': '🦾',
  'lat pulldown': '🏹',
  'leg press': '🦿',
  'leg curl': '🦿',
  'leg extension': '🦿',
  'calf raise': '🦵',
  'lunges': '🚶',
  'hip thrust': '🍑',
  'lateral raise': '🦅',
  'face pull': '🪢',
  'plank': '⏱️',
  'russian twist': '🌀',
  'crunch': '🌀',
  'sit-up': '🌀',
  'cardio': '🏃'
};
const MUSCLE_GROUP_ICONS_ = {
  Chest: '🫸', Legs: '🦵', Back: '🦅', Shoulders: '🙆', Arms: '🦾', Core: '🌀'
};
const EQUIPMENT_ICONS_ = {
  Barbell: '🏋️', Dumbbell: '🏋️‍♀️', Cable: '⛓️', Machine: '⚙️', Bodyweight: '🤸'
};
const NAME_KEYWORD_MUSCLE_GROUP_ = [
  [/curl|tricep|bicep|forearm/i, 'Arms'],
  [/squat|lunge|leg|calf|quad|hamstring/i, 'Legs'],
  [/row|pulldown|pull-?up|deadlift|lat\b/i, 'Back'],
  [/plank|crunch|sit-?up|twist|ab\b|core/i, 'Core'],
  [/shoulder|press.*overhead|overhead.*press|lateral raise|delt/i, 'Shoulders'],
  [/bench|chest|push-?up|fly|pushup/i, 'Chest']
];
function guessMuscleGroupFromName_(name) {
  const match = NAME_KEYWORD_MUSCLE_GROUP_.filter((pair) => pair[0].test(name || ''))[0];
  return match ? match[1] : '';
}
function deriveExerciseIcon_(ex) {
  if (ex && ex.iconEmoji) return ex.iconEmoji;
  const key = ex && ex.name ? ex.name.trim().toLowerCase() : '';
  if (EXERCISE_NAME_ICONS_[key]) return EXERCISE_NAME_ICONS_[key];
  const muscleGroup = (ex && ex.muscleGroup) || guessMuscleGroupFromName_(ex && ex.name);
  if (muscleGroup && MUSCLE_GROUP_ICONS_[muscleGroup]) return MUSCLE_GROUP_ICONS_[muscleGroup];
  if (ex && ex.equipment && EQUIPMENT_ICONS_[ex.equipment]) return EQUIPMENT_ICONS_[ex.equipment];
  return '🏋️';
}

/**
 * Shows an error message AND scrolls it into view. Several error
 * banners on longer, scrollable screens (the active-workout screen
 * especially, once a few exercise cards are added) sit well below
 * where the action that could fail actually happened — a real-device
 * report of "tapping the checkmark does nothing" turned out to be a
 * genuinely-thrown backend error rendering completely out of view, not
 * a silent no-op. Used anywhere an error can be triggered from partway
 * down a screen the user hasn't necessarily scrolled.
 */
function showAndRevealError_(el, message) {
  if (!el) return;
  el.textContent = humanizeErrorMessage_(message);
  el.hidden = false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/**
 * Formats a 'yyyy-MM-dd' (or ISO datetime) date string for display —
 * e.g. "Aug 14, 2026" — instead of showing the raw value a backend
 * response happens to send. Tolerates both shapes defensively: even
 * though Workouts.gs's getRecentWorkoutSessions now always sends a
 * clean date string, a client-side fallback means a display bug here
 * can never again look like the previous raw-ISO-timestamp report.
 */
function formatDisplayDate_(dateStr) {
  if (!dateStr) return '—';
  const datePart = String(dateStr).slice(0, 10); // 'yyyy-MM-dd' prefix either way
  const d = new Date(datePart + 'T00:00:00');
  if (isNaN(d.getTime())) return String(dateStr);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Catches the single most common deploy mistake up front, before a
 * single network call is made, instead of letting every screen fail
 * later with api.js's generic "account-picker redirect" message. Three
 * concrete things are checked, in order of how often they actually
 * turn out to be the cause:
 *  1. config.js was never edited (still the placeholder).
 *  2. The URL has a "/u/<number>/" account-slot segment baked in —
 *     this happens when someone copies the URL from their browser's
 *     address bar (which can silently insert /u/0/, /u/1/, etc. when
 *     signed into multiple Google accounts) instead of from the exact
 *     text shown in Apps Script's Deploy > Manage deployments dialog.
 *  3. The URL ends in "/dev" instead of "/exec" — the "Test
 *     deployments" URL (used from the Apps Script editor's own Run/
 *     Debug flow) always requires the developer's Google account to be
 *     selected, which is exactly the account-picker redirect being
 *     reported — whereas a real "/exec" Web app deployment (Deploy >
 *     New deployment) does not, when its access is "Anyone".
 * Returns true if the config looks usable; false (after showing a
 * blocking, actionable error) if not.
 */
function validateConfig_() {
  const url = CONFIG && CONFIG.APPS_SCRIPT_URL;
  if (!url || url.indexOf('PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE') !== -1) {
    showLoadingError_(
      'pwa/js/config.js still has the placeholder APPS_SCRIPT_URL — paste in your real Apps Script ' +
      'Web app URL (Apps Script editor > Deploy > Manage deployments) and redeploy the PWA.'
    );
    return false;
  }
  if (/\/u\/\d+\//.test(url)) {
    showLoadingError_(
      'config.js\'s APPS_SCRIPT_URL contains a "/u/<number>/" account-slot segment, which breaks ' +
      'sign-in for anyone whose browser is signed into more than one Google account. Go to the Apps ' +
      'Script editor > Deploy > Manage deployments, copy the URL exactly as shown THERE (not from ' +
      'your browser\'s address bar), and paste that into config.js instead.'
    );
    return false;
  }
  if (/\/dev\/?$/.test(url)) {
    showLoadingError_(
      'config.js\'s APPS_SCRIPT_URL ends in "/dev" — that\'s the Apps Script TEST deployment URL, ' +
      'which always requires picking your own Google account (this is very likely the exact ' +
      '"account-picker redirect" error you\'re seeing). Use Deploy > Manage deployments (not "Test ' +
      'deployments") to get the real Web app URL, which ends in "/exec", and confirm its "Who has ' +
      'access" is set to "Anyone" — then paste that URL into config.js.'
    );
    return false;
  }
  return true;
}

// --- Startup --------------------------------------------------------------
// If we already have a session token, stay on the (already-visible by
// default) loading screen and confirm what it's for — never flash the
// sign-in screen first just to immediately replace it a moment later.

if (!validateConfig_()) {
  // Blocking error already shown by validateConfig_ — nothing else to do.
} else if (getSessionToken()) {
  showLoading_('Signing you in…');
  runAuthCheck();
} else {
  showScreen('screen-signin');
}
