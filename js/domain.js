// Pure helpers of the guide workbench. No DOM, no network: `node --test workbench/tests` loads this file directly.
// Dates follow the app (mobile/src/domain.ts): Brisbane is UTC+10 all year (Queensland has no daylight saving).

export const LANGS = ['zh-Hans', 'zh-Hant', 'en'];
/** The workbench locks (signs out) after this long without a tap, key or scroll. Same as the old in-app backstage. */
export const IDLE_MS = 15 * 60 * 1000;
/** Replies are at most this many characters (code points), like the server's char_length check. */
export const NOTE_MAX = 500;
/** How far ahead an agreed date can be chosen. */
export const APPOINTMENT_WINDOW = 60;
/** admin_delete_spam takes at most this many IDs at once (0001_booking_requests.sql). */
export const SPAM_MAX = 200;
/** Status filters, in display order. */
export const FILTERS = ['all', 'submitted', 'confirmed', 'declined', 'cancelled'];
export const STATUSES = ['submitted', 'confirmed', 'declined', 'cancelled'];

const HOUR = 3_600_000;
const BRISBANE_OFFSET = 10 * HOUR;

/** "还差 {n} 件" + { n: 2 } → "还差 2 件". Unknown placeholders stay as they are. */
export function fmt(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) => key in params ? String(params[key]) : whole);
}

/** Characters as the server counts them (Unicode code points). */
export const charCount = text => [...String(text)].length;

export function isIdle(lastActive, now, limit = IDLE_MS) {
  return now - lastActive >= limit;
}

/** A TOTP code as typed: six digits, spaces ignored; null when it cannot be one. */
export function cleanTotp(code) {
  const digits = String(code ?? '').replace(/\s+/g, '');
  return /^\d{6}$/.test(digits) ? digits : null;
}

export function brisbaneDate(now = new Date()) {
  return new Date(now.getTime() + BRISBANE_OFFSET).toISOString().slice(0, 10);
}

/** The next `count` calendar days in Brisbane, starting today, as YYYY-MM-DD. */
export function upcomingDates(count, now = new Date()) {
  const start = new Date(brisbaneDate(now) + 'T00:00:00Z').getTime();
  return Array.from({ length: count }, (_, day) => new Date(start + day * 86_400_000).toISOString().slice(0, 10));
}

const weekdays = {
  'zh-Hans': ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
  'zh-Hant': ['週日', '週一', '週二', '週三', '週四', '週五', '週六'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
};
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "12月1日" + "周二" / "1 Dec" + "Tue"; the input itself (and no weekday) when it is not a valid YYYY-MM-DD. */
export function formatDate(value, lang = 'zh-Hans') {
  const date = new Date(value + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return { day: String(value), weekday: '' };
  const day = lang === 'en' ? `${date.getUTCDate()} ${months[date.getUTCMonth()]}` : `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
  return { day, weekday: (weekdays[lang] ?? weekdays['zh-Hans'])[date.getUTCDay()] };
}

/** "12月1日 周二" / "Tue 1 Dec". */
export function formatDay(value, lang = 'zh-Hans') {
  const { day, weekday } = formatDate(value, lang);
  if (!weekday) return day;
  return lang === 'en' ? `${weekday} ${day}` : `${day} ${weekday}`;
}

/** An instant as Brisbane wall-clock time: "10月8日 周四 15:00" / "Thu 8 Oct 15:00"; the input when it is not valid. */
export function formatAppointment(iso, lang = 'zh-Hans') {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return String(iso);
  const local = new Date(ms + BRISBANE_OFFSET);
  const hh = String(local.getUTCHours()).padStart(2, '0');
  const mm = String(local.getUTCMinutes()).padStart(2, '0');
  return `${formatDay(local.toISOString().slice(0, 10), lang)} ${hh}:${mm}`;
}

/** A time as typed with a Chinese input method: full-width digits and colon (１５：００) become 15:00. */
export function normalizeTime(time) {
  return String(time ?? '').replace(/[０-９]/g, digit => String.fromCharCode(digit.charCodeAt(0) - 0xFF10 + 48)).replace(/[：﹕]/g, ':').trim();
}

/** A Brisbane date (YYYY-MM-DD) and time (H:MM or HH:MM, 24-hour, full-width accepted) as an ISO instant; null when either is not valid. */
export function brisbaneToIso(date, time) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
  const t = /^(\d{1,2}):(\d{2})$/.exec(normalizeTime(time));
  if (!d || !t) return null;
  const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const [h, min] = [Number(t[1]), Number(t[2])];
  if (h > 23 || min > 59) return null;
  const utc = Date.UTC(y, m - 1, day, h, min);
  if (new Date(utc).toISOString().slice(0, 10) !== date) return null;
  return new Date(utc - BRISBANE_OFFSET).toISOString();
}

/** The reply: required for confirm and decline, at most 500 characters. Returns error codes by field. */
export function validateNote(note, required = true) {
  const clean = String(note ?? '').trim();
  if (!clean && required) return { note: 'noteRequired' };
  if (charCount(clean) > NOTE_MAX) return { note: 'noteTooLong' };
  return {};
}

/** Confirming: the agreed time must be valid and in the future, and the reply is required. */
export function validateConfirm({ date, time, note }, now = new Date()) {
  const errors = {};
  const at = brisbaneToIso(date, time);
  if (!date) errors.date = 'confirmDateRequired';
  else if (!at) errors.time = 'confirmTimeFormat';
  else if (Date.parse(at) <= now.getTime()) errors.time = 'confirmTimePast';
  return { ...errors, ...validateNote(note) };
}

const statusOrder = { submitted: 0, confirmed: 1, declined: 2, cancelled: 2 };
/** Same order as the server's admin_list_requests: waiting (by wanted date), confirmed (by agreed time), then newest first. */
export function sortForAdmin(list) {
  const key = item => item.status === 'submitted' ? item.preferredDate : item.status === 'confirmed' ? item.appointmentAt ?? '' : '';
  return [...list].sort((a, b) => (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3)
    || key(a).localeCompare(key(b))
    || String(b.submittedAt).localeCompare(String(a.submittedAt)));
}

export const filterList = (list, filter) => list.filter(item => filter === 'all' || item.status === filter);

/** What the guide may do with a request in this status (the database trigger enforces the same). */
export function actionsFor(status) {
  if (status === 'submitted') return ['confirm', 'decline', 'cancel'];
  if (status === 'confirmed') return ['cancel'];
  return [];
}

/** Supabase returns the TOTP QR code as an SVG data URL. Anything else is not shown (the key is shown either way). */
export function qrImageSrc(qr) {
  return typeof qr === 'string' && /^data:image\/svg\+xml[;,]/.test(qr) ? qr : null;
}

export function parseLang(raw) {
  return LANGS.includes(raw) ? raw : null;
}

/** The text of a question ID in this language; undefined for an ID the content no longer has. */
export function questionLabel(id, lang, content) {
  const item = content.questions[id];
  return item ? item[lang] ?? item['zh-Hans'] : undefined;
}

export function serviceTitle(id, lang, content) {
  const item = content.services[id];
  return item ? item[lang] ?? item['zh-Hans'] : undefined;
}

export const isLocalHost = hostname => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(String(hostname));

/** The payload of a JWT, or null when the value is not one. */
function jwtPayload(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(base64 + '='.repeat((4 - base64.length % 4) % 4)));
  } catch { return null; }
}

/**
 * Checks config.js. Used by the page (refuses to start on a bad config) and by tools/package.mjs (refuses to package one).
 *   mock:     only on this computer (localhost); the page then loads dev/, which is never deployed.
 *   supabase: https://<project>.supabase.co and the anon / publishable key. A secret / service_role key is refused:
 *             it would bypass every database permission, and this page is public.
 * Returns { ok: true, mode, url, key } or { ok: false, error } with an error code.
 */
export function checkConfig(config, hostname) {
  if (!config || typeof config !== 'object') return { ok: false, error: 'missing' };
  if (config.mode === 'mock') return isLocalHost(hostname) ? { ok: true, mode: 'mock' } : { ok: false, error: 'mockNotLocal' };
  if (config.mode !== 'supabase') return { ok: false, error: 'mode' };
  const url = String(config.supabaseUrl ?? '').trim().replace(/\/+$/, '');
  const key = String(config.supabaseAnonKey ?? '').trim();
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)) return { ok: false, error: 'url' };
  if (key.length < 20) return { ok: false, error: 'key' };
  if (/^sb_secret_/i.test(key) || /service_role/i.test(key)) return { ok: false, error: 'secretKey' };
  const payload = key.startsWith('sb_publishable_') ? null : jwtPayload(key);
  if (!key.startsWith('sb_publishable_')) {
    if (!payload) return { ok: false, error: 'key' };
    if (payload.role !== 'anon') return { ok: false, error: 'secretKey' };
  }
  return { ok: true, mode: 'supabase', url, key };
}
