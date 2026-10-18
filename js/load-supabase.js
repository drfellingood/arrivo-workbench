// Loads supabase-js from jsDelivr: one pinned file, checked with Subresource Integrity (the browser refuses it if a
// single byte differs). The same URL is the only external script the Content-Security-Policy in index.html allows.
// Version 2.117.2 = the version in mobile/package-lock.json. To update: change both constants and the CSP line,
// compute the new hash (workbench/README.md, "Updating supabase-js"), and run the checks.
export const SUPABASE_JS_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js';
export const SUPABASE_JS_SRI = 'sha384-Rj26LVGvoeRVR6+mwQmFfcR3QOBEwT+ZmuCWpuiqeTzJpCs0ER4ITAWGb4Hiy3Ok';

/** The Trusted Types policy allowed by the CSP ("trusted-types workbench"): it lets exactly one script URL through. */
let policy = null;
function scriptUrl() {
  if (!window.trustedTypes) return SUPABASE_JS_URL;
  policy ??= window.trustedTypes.createPolicy('workbench', {
    createScriptURL: value => {
      if (value !== SUPABASE_JS_URL) throw new TypeError('script URL not allowed');
      return value;
    },
  });
  return policy.createScriptURL(SUPABASE_JS_URL);
}

let loading = null;
/** Resolves with the supabase-js namespace (window.supabase). */
export function loadSupabase() {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.integrity = SUPABASE_JS_SRI;
    script.crossOrigin = 'anonymous';
    script.referrerPolicy = 'no-referrer';
    script.onload = () => window.supabase?.createClient ? resolve(window.supabase) : reject(new Error('supabase-js missing'));
    script.onerror = () => { loading = null; reject(new Error('supabase-js could not be loaded')); };
    script.src = scriptUrl();
    document.head.append(script);
  });
  return loading;
}
