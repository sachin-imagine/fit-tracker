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
console.info('Fit Tracker app.js — build: email-code-auth-v3 (seamless reload, verify spinner, pending auto-poll, reminders, logout)');

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

function showScreen(id) {
  // Any screen change other than landing on screen-pending itself
  // stops the background poll — otherwise it would keep silently
  // hitting the backend from screens that no longer need it.
  if (id !== 'screen-pending') stopPendingPoll_();
  document.querySelectorAll('.screen').forEach((s) => (s.hidden = true));
  const el = document.getElementById(id);
  if (el) el.hidden = false;
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.screen === id);
  });
}

function setWelcomeName(name) {
  document.querySelectorAll('.welcome-name').forEach((el) => {
    el.textContent = name || '';
  });
}

document.getElementById('bottom-nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-btn');
  if (!btn || btn.disabled) return;
  showScreen(btn.dataset.screen);
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
  document.getElementById('loading-text').hidden = false;
  document.getElementById('loading-text').textContent = message || 'Loading…';
  document.getElementById('loading-spinner').hidden = false;
  document.getElementById('loading-error').hidden = true;
  document.getElementById('loading-retry-btn').hidden = true;
  showScreen('screen-loading');
}

function showLoadingError_(message) {
  document.getElementById('loading-text').hidden = true;
  document.getElementById('loading-spinner').hidden = true;
  document.getElementById('loading-error').hidden = false;
  document.getElementById('loading-error').textContent = message;
  document.getElementById('loading-retry-btn').hidden = false;
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
    await apiPost('requestLoginCode', { email });
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
    const { sessionToken } = await apiPost('verifyLoginCode', { email: pendingEmail, code });
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
    await apiPost('requestLoginCode', { email: pendingEmail });
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
    const result = await apiPost('requestApprovalReminder', {});
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
    // A network hiccup or the "/u/N/" redirect issue shouldn't throw
    // away a perfectly good session — that was the old behavior, and
    // it's exactly what forced re-entering the email address after
    // any transient failure. Show a retry screen instead, unless this
    // was a silent background poll (in which case just try again on
    // the next tick and leave the current screen alone).
    if (!silent) {
      showLoadingError_(err.message);
    }
  }
}

async function loadProfileAndContinue() {
  document.getElementById('today-date').textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'long', month: 'short', day: 'numeric'
  });
  try {
    const { profile } = await apiGet('getProfile');
    if (profile) {
      renderProfile(profile);
      bottomNav.hidden = false;
      showScreen('screen-dashboard');
    } else {
      showScreen('screen-setup');
    }
  } catch (err) {
    console.error(err);
    showScreen('screen-setup');
  }
}

function renderProfile(profile) {
  document.getElementById('profile-json').textContent = JSON.stringify(profile, null, 2);
  document.getElementById('stat-weight').textContent = profile.StartWeightKg
    ? `${profile.StartWeightKg} kg`
    : '–';
}

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

  try {
    await apiPost('saveProfile', payload);
    const { profile } = await apiGet('getProfile');
    renderProfile(profile);
    bottomNav.hidden = false;
    showScreen('screen-dashboard');
  } catch (err) {
    errorEl.textContent = 'Could not save profile: ' + err.message;
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
