/**
 * app.js
 *
 * Phase 1 app logic with emailed one-time-code sign-in: register the
 * service worker, sign the user in, check their approval status, then
 * decide whether to show the setup screen or the dashboard. Later
 * phases add real data to the dashboard and enable the Log/Coach nav
 * buttons.
 */

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

// --- Sign-in: request code -------------------------------------------

document.getElementById('signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('signin-error');
  errorEl.hidden = true;
  const email = new FormData(e.target).get('email').trim().toLowerCase();

  try {
    await apiPost('requestLoginCode', { email });
    pendingEmail = email;
    document.getElementById('verify-email').textContent = email;
    document.getElementById('verify-form').reset();
    showScreen('screen-verify');
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
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
  const errorEl = document.getElementById('verify-error');
  errorEl.hidden = true;
  try {
    await apiPost('requestLoginCode', { email: pendingEmail });
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

document.getElementById('use-different-email-btn').addEventListener('click', () => {
  pendingEmail = null;
  document.getElementById('signin-form').reset();
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
