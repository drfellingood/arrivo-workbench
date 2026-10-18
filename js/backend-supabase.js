// The workbench on Supabase. Ported from the app's former SupabaseAdminService (mobile/src/requests/supabase.ts,
// removed 2026-10-19 with the in-app backstage). Everything goes through the existing database functions
// (supabase/migrations/0001_booking_requests.sql, 0004_topics.sql); the page has no table access at all:
//   backstage_status, admin_list_requests, admin_confirm_request, admin_decline_request, admin_cancel_request, admin_delete_spam.
// Every admin_* function checks private.is_admin(): an account listed in public.admins whose session finished TOTP (aal2).
// No DOM here: tests pass a fake client.

export class ServiceError extends Error {
  /** kind: 'network' (retrying may help) or 'rejected' (the service refused). code: why, when known. */
  constructor(kind, message, code) {
    super(message);
    this.kind = kind;
    if (code) this.code = code;
  }
}

/** Our own SQLSTATEs (see the migration's header). */
export const serverCodes = {
  CD001: 'not_authenticated',
  CD002: 'forbidden',
  CD003: 'not_found',
  CD004: 'invalid_transition',
  CD005: 'cancel_window_closed',
  CD006: 'daily_limit',
  CD007: 'age_not_confirmed',
  CD008: 'invalid_input',
  CD009: 'immutable_column',
  CD010: 'site_busy',
};
/** CD008 carries the exact reason in its message. */
const inputReasons = ['appointment_in_past', 'note_required', 'note_too_long', 'invalid_ids'];

/** Supabase Auth's rate-limit codes (HTTP 429). */
const RATE_LIMIT_CODES = ['over_request_rate_limit', 'over_email_send_rate_limit', 'over_sms_send_rate_limit'];

/** A database-function (RPC) error. */
export function mapRpcError(error, status) {
  const code = String(error?.code ?? '');
  const message = error?.message || 'rpc failed';
  if (status === 429) return new ServiceError('rejected', message, 'rate_limited');
  if (code === 'CD008' && inputReasons.includes(message)) return new ServiceError('rejected', message, message);
  if (serverCodes[code]) return new ServiceError('rejected', message, serverCodes[code]);
  if (/^(22|23|42|P0)/.test(code)) return new ServiceError('rejected', message, code);
  if (/^PGRST[12]/.test(code)) return new ServiceError('rejected', message, code);
  if (status !== undefined && status >= 400 && status < 500 && ![401, 408, 429].includes(status) && code !== '') return new ServiceError('rejected', message, code);
  return new ServiceError('network', message, code || undefined);
}

/** A Supabase Auth error. Fetch failures, rate limits and 5xx are `network`; a refusal is `rejected`. */
export function mapAuthError(error) {
  const message = error?.message || 'auth failed';
  const code = error?.code !== undefined ? String(error.code) : undefined;
  const status = error?.status;
  // Too many attempts: say so, instead of "connection problem".
  if (status === 429 || RATE_LIMIT_CODES.includes(code)) return new ServiceError('rejected', message, 'rate_limited');
  if (!error || error.name === 'AuthRetryableFetchError' || !status || status >= 500 || status === 429 || status === 408) return new ServiceError('network', message, code);
  return new ServiceError('rejected', message, code);
}

const iso = value => {
  if (typeof value !== 'string' || !value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isServerId = id => UUID.test(String(id));
const STATUSES = ['submitted', 'confirmed', 'declined', 'cancelled'];

/** One row of admin_json() → the request as the page uses it. Strings only, so nothing else can reach the DOM. */
export function toRequest(row) {
  const r = row ?? {};
  const submittedAt = iso(r.submitted_at);
  const updatedAt = iso(r.updated_at);
  if (typeof r.id !== 'string' || !STATUSES.includes(r.status) || !submittedAt || !updatedAt) throw new ServiceError('network', 'unreadable row');
  const appointmentAt = iso(r.appointment_at);
  return {
    id: r.id, status: r.status, submittedAt, updatedAt,
    serviceId: String(r.service_id ?? ''),
    name: String(r.name ?? ''),
    contact: String(r.contact ?? ''),
    preferredDate: String(r.preferred_date ?? ''),
    question: String(r.question ?? ''),
    topics: Array.isArray(r.topics) ? r.topics.filter(id => typeof id === 'string') : [],
    ...(typeof r.guide_note === 'string' && r.guide_note ? { guideNote: r.guide_note } : {}),
    ...(appointmentAt ? { appointmentAt } : {}),
  };
}

async function call(client, fn, args) {
  let response;
  try { response = await client.rpc(fn, args); }
  catch (error) { throw new ServiceError('network', error instanceof Error ? error.message : 'network'); }
  if (response.error) throw mapRpcError(response.error, response.status);
  return response.data;
}

async function auth(work) {
  let result;
  try { result = await work(); }
  catch (error) { throw new ServiceError('network', error instanceof Error ? error.message : 'network'); }
  if (result.error) throw mapAuthError(result.error);
  return result.data;
}

/**
 * Sign-in stages: ready (admin + aal2) / totp (admin, enter code) / enroll (admin without an authenticator) / denied.
 * The page shows data only at `ready`; the database refuses everything else anyway (CD002).
 */
export class SupabaseBackend {
  constructor(client) { this.client = client; }

  async session() {
    let result;
    try { result = await this.client.auth.getSession(); }
    catch (error) { throw new ServiceError('network', error instanceof Error ? error.message : 'network'); }
    if (result.error) throw new ServiceError('network', result.error.message || 'session', result.error.code !== undefined ? String(result.error.code) : undefined);
    return result.data.session;
  }

  async describe(session) {
    if (!session) return null;
    const email = session.user?.email ?? '';
    if (session.user?.is_anonymous) return { email, stage: 'denied' };
    const status = await call(this.client, 'backstage_status');
    if (!status?.admin_account) return { email, stage: 'denied' };
    if (status.aal2) return { email, stage: 'ready' };
    return { email, stage: (await this.verifiedFactor()) ? 'totp' : 'enroll' };
  }

  async verifiedFactor() {
    const factors = await auth(() => this.client.auth.mfa.listFactors());
    return (factors?.totp ?? []).find(factor => factor.status === 'verified');
  }

  async challengeAndVerify(factorId, code) {
    const challenge = await auth(() => this.client.auth.mfa.challenge({ factorId }));
    if (!challenge) throw new ServiceError('network', 'no challenge');
    try { await auth(() => this.client.auth.mfa.verify({ factorId, challengeId: challenge.id, code: String(code).trim() })); }
    catch (error) {
      if (error instanceof ServiceError && error.kind === 'rejected') throw new ServiceError('rejected', 'wrong code', 'invalid_code');
      throw error;
    }
    const session = await this.describe(await this.session());
    if (!session) throw new ServiceError('rejected', 'signed out', 'not_authenticated');
    return session;
  }

  async current() { return this.describe(await this.session()); }

  async signIn(email, password) {
    let result;
    try { result = await this.client.auth.signInWithPassword({ email: String(email).trim(), password }); }
    catch (error) { throw new ServiceError('network', error instanceof Error ? error.message : 'network'); }
    if (result.error || !result.data?.session) throw mapAuthError(result.error);
    return this.describe(result.data.session);
  }

  async verifyTotp(code) {
    const factor = await this.verifiedFactor();
    if (!factor) throw new ServiceError('rejected', 'no factor', 'no_factor');
    return this.challengeAndVerify(factor.id, code);
  }

  async startEnroll() {
    // An unfinished setup from before would block a new one with the same name: remove it first.
    const factors = await auth(() => this.client.auth.mfa.listFactors());
    for (const factor of factors?.all ?? []) {
      if (factor.factor_type === 'totp' && factor.status !== 'verified') await auth(() => this.client.auth.mfa.unenroll({ factorId: factor.id }));
    }
    const enrolled = await auth(() => this.client.auth.mfa.enroll({ factorType: 'totp', issuer: '出岛向导工作台', friendlyName: '出岛向导工作台' }));
    if (!enrolled) throw new ServiceError('network', 'no enrolment');
    return { factorId: enrolled.id, secret: String(enrolled.totp.secret), uri: String(enrolled.totp.uri), qrSvg: enrolled.totp.qr_code };
  }

  async finishEnroll(factorId, code) { return this.challengeAndVerify(factorId, code); }

  async signOut() {
    const { error } = await this.client.auth.signOut({ scope: 'local' });
    if (error) throw mapAuthError(error);
  }

  async list() {
    const rows = await call(this.client, 'admin_list_requests', { p_status: null });
    return Array.isArray(rows) ? rows.map(toRequest) : [];
  }
  async confirm(id, appointmentAt, note) {
    return toRequest(await call(this.client, 'admin_confirm_request', { p_id: id, p_appointment_at: appointmentAt, p_note: note }));
  }
  async decline(id, note) {
    return toRequest(await call(this.client, 'admin_decline_request', { p_id: id, p_note: note }));
  }
  async cancel(id, note) {
    return toRequest(await call(this.client, 'admin_cancel_request', { p_id: id, p_note: note || null }));
  }
  async deleteSpam(ids) {
    const serverIds = ids.filter(isServerId);
    if (serverIds.length === 0) return 0;
    return Number(await call(this.client, 'admin_delete_spam', { p_ids: serverIds })) || 0;
  }
}

/**
 * The real client. supabase-js is loaded by load-supabase.js (pinned version, SRI). The session lives in sessionStorage:
 * it survives a reload of this tab and is gone when the tab or browser closes. Nothing is kept in localStorage.
 */
export function createSupabaseBackend(supabase, url, key) {
  const client = supabase.createClient(url, key, {
    auth: { storage: window.sessionStorage, storageKey: 'chudao-workbench-auth', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  return new SupabaseBackend(client);
}
