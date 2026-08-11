/**
 * api.js
 *
 * Single module for talking to the Apps Script backend. All other
 * frontend code calls apiGet()/apiPost() and never touches fetch()
 * directly, so the CORS workaround (see Code.gs) and the current
 * session token both live in one place.
 *
 * The session token is persisted to localStorage (this is a real
 * deployed app on your own GitHub Pages URL, not a chat preview, so
 * that's the correct/standard place to keep a "stay signed in"
 * token) so reloading the app doesn't force signing in again until
 * the 30-day session actually expires.
 */

console.info('Fit Tracker api.js — build: email-code-auth-v3 (redirect-aware errors)');

const SESSION_STORAGE_KEY = 'fitTrackerSessionToken';
let currentSessionToken = localStorage.getItem(SESSION_STORAGE_KEY) || null;

function setSessionToken(token) {
  currentSessionToken = token;
  if (token) {
    localStorage.setItem(SESSION_STORAGE_KEY, token);
  } else {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  }
}

function getSessionToken() {
  return currentSessionToken;
}

async function apiGet(action, params) {
  const url = new URL(CONFIG.APPS_SCRIPT_URL);
  url.searchParams.set('action', action);
  if (currentSessionToken) url.searchParams.set('sessionToken', currentSessionToken);
  if (params) {
    Object.keys(params).forEach((k) => url.searchParams.set(k, params[k]));
  }
  const res = await fetch(url.toString(), { method: 'GET' });
  return parseApiResponse_(res);
}

async function apiPost(action, payload) {
  // IMPORTANT: Content-Type must stay "text/plain" (a "simple
  // request") so the browser does not send a CORS preflight OPTIONS
  // request, which Apps Script web apps cannot answer. The body is
  // still a JSON string; Code.gs parses it as JSON on the server.
  const body = JSON.stringify({
    action,
    sessionToken: currentSessionToken,
    payload: payload || {}
  });
  const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body
  });
  return parseApiResponse_(res);
}

async function parseApiResponse_(res) {
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    // res.url reflects the FINAL URL after any redirect fetch followed.
    // If it grew a "/u/<number>/" segment, or the body looks like an
    // HTML account-chooser page, this is that recurring Google
    // multi-account quirk — and it's a real functional bug (not just a
    // cosmetic one) for POST calls specifically: a redirect on a POST
    // request gets re-sent as a bodiless GET, which is exactly why
    // "verifying a code" can fail while "checking status" (GET) still
    // works. The fix lives in config.js, not in this file.
    if (/\/u\/\d+\//.test(res.url) || /<html/i.test(text)) {
      throw new Error(
        'The backend redirected through a Google account-picker page instead of answering directly. ' +
        'Open pwa/js/config.js and make sure APPS_SCRIPT_URL has no "/u/<number>/" segment in it — ' +
        'it should look like https://script.google.com/macros/s/…/exec.'
      );
    }
    throw new Error('Backend returned an unreadable response (status ' + res.status + ')');
  }
  if (!json.ok) {
    const err = new Error(json.error || 'Unknown backend error');
    err.status = json.status || null; // 'pending' | 'rejected' | 'signed_out' when relevant
    throw err;
  }
  return json.data;
}
