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
console.info('Fit Tracker app.js — build: email-code-auth-v2 (with resend cooldown)');

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

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => (s.hidden = true));
  const el = document.getElementById(id);
  if (el) el.hidden = false;
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.screen === id);
  });
}

function setWelcomeName(name) {
  document.querySelectorAll('.welcome-name').forEach((el) => {
    el.textContent = name;
  });
}

document.getElementById('bottom-nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-btn');
  if (!btn || btn.disabled) return;
  showScreen(btn.dataset.screen);
});

document.getElementById('signout-btn').addEventListener('click', () => {
  setSessionToken(null);
  currentUser = null;
  bottomNav.hidden = true;
  showScreen('screen-signin');
});

// --- Resend cooldown helper --------------------------------------------

const RESEND_COOLDOWN_SECONDS = 30;

/**
 * Disables a button and counts down its label for `seconds`, then
 * restores it to idleLabel and re-enables it. Attached to the button
 * element itself so a second call (e.g. switching screens and back)
 * safely replaces any in-flight countdown instead of stacking two.
 */
function startResendCooldown_(buttonEl, seconds, idleLabel) {
  if (buttonEl._cooldownInterval) {
    clearInterval(buttonEl._cooldownInterval);
  }
  let remaining = seconds;
  buttonEl.disabled = true;
  buttonEl.textContent = `Resend in ${remaining}s`;
  buttonEl._cooldownInterval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(buttonEl._cooldownInterval);
      buttonEl._cooldownInterval = null;
      buttonEl.disabled = false;
      buttonEl.textContent = idleLabel;
    } else {
      buttonEl.textContent = `Resend in ${remaining}s`;
    }
  }, 1000);
}

function resetCooldown_(buttonEl, idleLabel) {
  if (buttonEl._cooldownInterval) {
    clearInterval(buttonEl._cooldownInterval);
    buttonEl._cooldownInterval = null;
  }
  buttonEl.disabled = false;
  buttonEl.textContent = idleLabel;
}

// --- Sign-in: request code -------------------------------------------

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
    startResendCooldown_(submitBtn, RESEND_COOLDOWN_SECONDS, 'Send code');
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
    // If the backend itself is enforcing the cooldown (e.g. a stray
    // double-submit got through), reflect that countdown instead of
    // just re-enabling immediately and inviting another failed click.
    if (/wait/i.test(err.message)) {
      startResendCooldown_(submitBtn, RESEND_COOLDOWN_SECONDS, 'Send code');
    } else {
      resetCooldown_(submitBtn, 'Send code');
    }
  }
});

// --- Sign-in: verify code ---------------------------------------------

document.getElementById('verify-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('verify-error');
  errorEl.hidden = true;
  const code = new FormData(e.target).get('code').trim();

  try {
    const { sessionToken } = await apiPost('verifyLoginCode', { email: pendingEmail, code });
    setSessionToken(sessionToken);
    await runAuthCheck();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
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

// --- Auth check / profile flow ----------------------------------------

async function runAuthCheck() {
  try {
    const auth = await apiGet('authCheck');
    currentUser = auth;
    setWelcomeName(auth.name);

    if (auth.status === 'pending') {
      showScreen('screen-pending');
      return;
    }
    if (auth.status === 'rejected') {
      showScreen('screen-rejected');
      return;
    }
    await loadProfileAndContinue();
  } catch (err) {
    console.error(err);
    setSessionToken(null);
    showScreen('screen-signin');
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

  try {
    await apiPost('saveProfile', payload);
    const { profile } = await apiGet('getProfile');
    renderProfile(profile);
    bottomNav.hidden = false;
    showScreen('screen-dashboard');
  } catch (err) {
    errorEl.textContent = 'Could not save profile: ' + err.message;
    errorEl.hidden = false;
  }
});

// --- Startup ------------------------------------------------------------

if (getSessionToken()) {
  showScreen('screen-signin'); // shown briefly until authCheck resolves
  runAuthCheck();
} else {
  showScreen('screen-signin');
}
