/**
 * app.js
 *
 * Phase 1 app logic: register the service worker, decide whether to
 * show the setup screen or the dashboard, wire up the setup form, and
 * handle bottom-nav screen switching. Later phases add real data to
 * the dashboard and enable the Log/Coach nav buttons.
 */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}

const screens = {
  setup: document.getElementById('screen-setup'),
  dashboard: document.getElementById('screen-dashboard'),
  profile: document.getElementById('screen-profile')
};
const bottomNav = document.getElementById('bottom-nav');

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => (s.hidden = true));
  const el = document.getElementById(id);
  if (el) el.hidden = false;
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.screen === id);
  });
}

document.getElementById('bottom-nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-btn');
  if (!btn || btn.disabled) return;
  showScreen(btn.dataset.screen);
});

async function init() {
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
    // Backend not reachable/configured yet — still let the user fill
    // out setup; submitting will surface a clearer error.
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

  try {
    await apiPost('saveProfile', payload);
    const { profile } = await apiGet('getProfile');
    renderProfile(profile);
    bottomNav.hidden = false;
    showScreen('screen-dashboard');
  } catch (err) {
    errorEl.textContent = 'Could not save profile: ' + err.message +
      ' — check js/config.js has the correct Apps Script URL and token.';
    errorEl.hidden = false;
  }
});

init();
