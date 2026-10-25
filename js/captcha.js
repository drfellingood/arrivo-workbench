// The Turnstile widget on the sign-in page. No DOM work of its own beyond handing Turnstile a container, and the
// Turnstile API is passed in, so tests run it with a fake (tests/captcha.test.mjs).
//
// The widget renders once when the sign-in form shows and solves in the background ("interaction-only": it is only
// visible when Cloudflare wants a click). take() hands out the current token and immediately resets the widget, because
// a token is valid for one sign-in only. Two-step verification (TOTP) does not need a token.
import { ServiceError } from './backend-supabase.js';
import { isCaptchaToken, turnstileLanguage } from './domain.js';

export const CAPTCHA_WAIT_MS = 90_000;

/** status: idle | loading | ready | interactive | expired | failed | unavailable */
export class Captcha {
  constructor({ load, siteKey, lang = 'zh-Hans', onChange = () => {}, timers = { set: (fn, ms) => setTimeout(fn, ms), clear: id => clearTimeout(id) } }) {
    Object.assign(this, { load, siteKey, lang, onChange, timers });
    this.status = 'idle';
    this.api = null;
    this.widgetId = null;
    this.mounting = null;
    this.current = null;
    this.waiters = [];
  }

  set(status) {
    if (this.status === status) return;
    this.status = status;
    this.onChange(status);
  }

  /** Renders the widget into `slot` once. Safe to call on every page render. */
  mount(slot) {
    if (this.widgetId !== null || this.mounting) return this.mounting ?? Promise.resolve();
    this.set('loading');
    const mounting = (async () => {
      try { this.api ??= await this.load(); }
      catch {
        this.fail('unavailable', 'captcha_unavailable');
        return;
      }
      this.widgetId = this.api.render(slot, {
        sitekey: this.siteKey,
        action: 'workbench_signin',
        language: turnstileLanguage(this.lang),
        theme: 'light',
        size: 'flexible',
        appearance: 'interaction-only',
        callback: token => this.got(token),
        'expired-callback': () => { this.current = null; this.set('expired'); },
        'timeout-callback': () => { this.current = null; this.fail('failed', 'captcha_failed'); },
        'before-interactive-callback': () => this.set('interactive'),
        'after-interactive-callback': () => { if (this.status === 'interactive') this.set('loading'); },
        // Returning true tells Turnstile the page handles the error (shows its own message, offers a retry).
        'error-callback': () => { this.current = null; this.fail('failed', 'captcha_failed'); return true; },
      });
    })();
    // Cleared when done, whether or not loading needed to wait (with api.js already loaded, the work above is synchronous).
    const done = mounting.finally(() => { if (this.mounting === done) this.mounting = null; });
    this.mounting = done;
    return done;
  }

  got(token) {
    if (!isCaptchaToken(token)) { this.fail('failed', 'captcha_failed'); return; }
    this.current = token;
    this.set('ready');
    const waiters = this.waiters.splice(0);
    if (waiters.length) {
      const next = this.consume();
      for (const waiter of waiters) waiter.resolve(next);
    }
  }

  fail(status, code) {
    this.set(status);
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.reject(new ServiceError(status === 'unavailable' ? 'network' : 'rejected', code, code));
  }

  /** The current token, once: the widget starts on a new one right away. */
  consume() {
    const token = this.current;
    this.current = null;
    this.reset();
    return token;
  }

  /**
   * A token for one sign-in. Waits while the widget is still working (or waiting for a click), up to `wait` ms.
   * Rejects with ServiceError code captcha_unavailable (could not load), captcha_failed, or captcha_timeout. After a
   * failure the widget is reset, so trying again gets a fresh challenge.
   */
  take(wait = CAPTCHA_WAIT_MS) {
    if (this.current) return Promise.resolve(this.consume());
    if (this.status === 'unavailable') return Promise.reject(new ServiceError('network', 'captcha_unavailable', 'captcha_unavailable'));
    if (this.status === 'failed') {
      this.reset();
      return Promise.reject(new ServiceError('rejected', 'captcha_failed', 'captcha_failed'));
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: token => { this.timers.clear(timer); resolve(token); },
        reject: error => { this.timers.clear(timer); reject(error); },
      };
      const timer = this.timers.set(() => {
        this.waiters = this.waiters.filter(item => item !== waiter);
        this.reset();
        reject(new ServiceError('rejected', 'captcha_timeout', 'captcha_timeout'));
      }, wait);
      this.waiters.push(waiter);
    });
  }

  /**
   * For one sign-in: { token, failure }. token is null when the check could not produce one (could not load, failed,
   * timed out); failure is then that error. The page still signs in, without a token, and Supabase decides: with
   * CAPTCHA protection off the sign-in works, with it on Supabase answers captcha_failed. So switching the protection
   * off in Supabase really restores sign-in even when Cloudflare is the problem.
   */
  async tokenForSignIn(wait = CAPTCHA_WAIT_MS) {
    try { return { token: await this.take(wait), failure: null }; }
    catch (failure) { return { token: null, failure }; }
  }

  /** Starts a new challenge (after a token was used, or after a failure). */
  reset() {
    this.current = null;
    if (this.widgetId === null || !this.api) return;
    try { this.api.reset(this.widgetId); this.set('loading'); }
    catch { this.fail('failed', 'captcha_failed'); }
  }

  /** Takes the widget off the page (signed in). Waiting sign-ins are refused. */
  remove() {
    if (this.widgetId !== null && this.api) { try { this.api.remove(this.widgetId); } catch { /* already gone */ } }
    this.widgetId = null;
    this.current = null;
    for (const waiter of this.waiters.splice(0)) waiter.reject(new ServiceError('rejected', 'captcha_failed', 'captcha_failed'));
    this.set('idle');
  }

  /** After "could not load": try loading api.js again. */
  retry(slot) {
    if (this.status === 'unavailable') { this.status = 'idle'; return this.mount(slot); }
    this.reset();
    return Promise.resolve();
  }
}
