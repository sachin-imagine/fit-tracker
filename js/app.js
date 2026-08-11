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
console.info('Fit Tracker app.js — build: email-code-auth-v6 (merged with your name-editor edits + null-safety)');

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

function renderProfile(profile) {
  // Matches your current index.html's #profile-json <pre> dump.
  const dump = el_('profile-json');
  if (dump) {
    dump.textContent = JSON.stringify(profile, null, 2);
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
