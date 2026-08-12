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

console.info('Fit Tracker api.js — build: email-code-auth-v6 (more actionable redirect diagnostics)');

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
    // Always log the raw response so a real diagnosis is possible from
    // the browser console instead of guessing — a previous version of
    // this file guessed "Google account-picker page" for ANY non-JSON
    // response, which was misleading when the real cause was something
    // else entirely (a transient Apps Script hiccup, a script error
    // page, a quota message, etc.). Only claim the specific "/u/N/"
    // account-slot redirect when the final URL (res.url, which reflects
    // the URL AFTER any redirect fetch followed) actually shows it.
    console.error('Non-JSON response from backend.', {
      url: res.url, status: res.status, bodyPreview: text.slice(0, 500)
    });
    if (/\/u\/\d+\//.test(res.url)) {
      throw new Error(
        'The backend redirected through a Google account-picker page ("/u/<number>/" in the final ' +
        'URL) instead of answering directly. This can happen even with a clean config.js URL — three ' +
        'things to check on the phone/browser where this just failed: (1) In the Apps Script editor, ' +
        'Deploy > Manage deployments > edit the Web app deployment > confirm "Who has access" is ' +
        'exactly "Anyone", then click Deploy again to make sure that setting is actually live (editing ' +
        'the field alone does not apply it — you must redeploy). (2) Confirm config.js\'s URL ends in ' +
        '"/exec", not "/dev" — a "/dev" URL is the Test-deployment link and always requires picking a ' +
        'Google account. (3) If both of those are already correct, try this same action in a private/' +
        'incognito tab — some mobile browsers insert an account-chooser step when multiple Google ' +
        'accounts are signed in, even for a fully public deployment, and a private tab has none. See ' +
        'the browser console for the full raw response.'
      );
    }
    throw new Error(
      'Backend returned something that was not valid JSON (status ' + res.status + '). This is usually a ' +
      'transient Apps Script hiccup — check the browser console for the raw response, or check the ' +
      'Executions log in the Apps Script editor for an error, then try again.'
    );
  }
  if (!json.ok) {
    const err = new Error(json.error || 'Unknown backend error');
    err.status = json.status || null; // 'pending' | 'rejected' | 'signed_out' when relevant
    throw err;
  }
  return json.data;
}
