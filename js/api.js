/**
 * api.js
 *
 * Single module for talking to the Apps Script backend. All other
 * frontend code calls apiGet()/apiPost() and never touches fetch()
 * directly, so the CORS workaround (see Code.gs) lives in one place.
 */

async function apiGet(action, params) {
  const url = new URL(CONFIG.APPS_SCRIPT_URL);
  url.searchParams.set('action', action);
  url.searchParams.set('token', CONFIG.API_TOKEN);
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
  const body = JSON.stringify({ action, token: CONFIG.API_TOKEN, payload: payload || {} });
  const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body
  });
  return parseApiResponse_(res);
}

async function parseApiResponse_(res) {
  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error('Backend returned an unreadable response (status ' + res.status + ')');
  }
  if (!json.ok) {
    throw new Error(json.error || 'Unknown backend error');
  }
  return json.data;
}
