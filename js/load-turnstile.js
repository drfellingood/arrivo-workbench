// Loads Cloudflare Turnstile (the CAPTCHA in front of Supabase sign-in; supabase/README.md section 2).
// Cloudflare requires api.js to be fetched from this exact URL, never proxied or cached
// (https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/), and it changes over time, so it
// cannot carry an SRI hash like supabase-js. The CSP in index.html allows https://challenges.cloudflare.com in
// script-src, frame-src and connect-src (https://developers.cloudflare.com/turnstile/reference/content-security-policy/).
//
// Trusted Types: this file owns two policies, both listed in the CSP ("trusted-types workbench turnstile default").
//   turnstile: lets exactly TURNSTILE_API_URL through, for the script element below.
//   default:   api.js can replace itself with a newer build: it copies its own src, adds _upgrade=true and
//              _cb=<time>, and assigns that string to a new <script>'s .src. Under Trusted Types that string assignment
//              is blocked unless a default policy accepts it. This one accepts exactly that form (isTurnstileScript)
//              and nothing else: no other path or query (e.g. no other ?onload= callback), no HTML, no inline script.
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
export const TURNSTILE_READY = 'arrivoTurnstileReady';
export const TURNSTILE_API_URL = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js?render=explicit&onload=${TURNSTILE_READY}`;
const LOAD_TIMEOUT_MS = 20_000;

const ALLOWED_PARAMS = {
  render: value => value === 'explicit',
  onload: value => value === TURNSTILE_READY,
  _upgrade: value => value === 'true',
  _cb: value => /^\d{1,16}$/.test(value),
};
/**
 * Whether a script URL is the api.js this page loads, or api.js's upgrade of itself: https://challenges.cloudflare.com,
 * path /turnstile/v0/api.js (or a versioned /turnstile/v0/<x>/<build>/api.js), query render=explicit and
 * onload=<our callback> (both required), optionally _upgrade=true and _cb=<digits>; nothing else, no repeats.
 */
export function isTurnstileScript(value) {
  let url;
  try { url = new URL(String(value)); } catch { return false; }
  if (url.origin !== TURNSTILE_ORIGIN || url.username || url.password || url.hash) return false;
  if (!/^\/turnstile\/v0\/(?:[a-z0-9]{1,8}\/[A-Za-z0-9]{1,40}\/)?api\.js$/.test(url.pathname)) return false;
  const seen = new Set();
  for (const [key, val] of url.searchParams) {
    if (seen.has(key) || !Object.hasOwn(ALLOWED_PARAMS, key) || !ALLOWED_PARAMS[key](val)) return false;
    seen.add(key);
  }
  return seen.has('render') && seen.has('onload');
}

let policy = null;
function scriptUrl() {
  const types = window.trustedTypes;
  if (!types) return TURNSTILE_API_URL;
  if (!types.defaultPolicy) {
    types.createPolicy('default', { createScriptURL: value => isTurnstileScript(value) ? value : null });
  }
  policy ??= types.createPolicy('turnstile', {
    createScriptURL: value => {
      if (value !== TURNSTILE_API_URL) throw new TypeError('script URL not allowed');
      return value;
    },
  });
  return policy.createScriptURL(TURNSTILE_API_URL);
}

let loading = null;
/** Resolves with window.turnstile once api.js has called back; rejects when it cannot load (offline, blocked). */
export function loadTurnstile() {
  loading ??= new Promise((resolve, reject) => {
    const fail = () => {
      clearTimeout(timer);
      delete window[TURNSTILE_READY];
      script.remove();
      loading = null;
      reject(new Error('turnstile could not be loaded'));
    };
    const timer = setTimeout(fail, LOAD_TIMEOUT_MS);
    window[TURNSTILE_READY] = () => {
      clearTimeout(timer);
      delete window[TURNSTILE_READY];
      if (window.turnstile?.render) resolve(window.turnstile); else fail();
    };
    const script = document.createElement('script');
    script.onerror = fail;
    script.src = scriptUrl();
    document.head.append(script);
  });
  return loading;
}
