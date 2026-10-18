// 「出岛」向导工作台 · the guide workbench (DECISIONS 50). A static page: no build step, no server code, no keys in the code.
// Sign-in: email + password, then a TOTP code (first time: set up an authenticator app). Only admin accounts at aal2
// see data; the database functions check the same (RLS + private.is_admin()), so this page is not the security boundary.
// Everything a request contains is shown as text (dom.js); nothing is ever parsed as HTML.
import { h, img, replace } from './dom.js';
import {
  APPOINTMENT_WINDOW, FILTERS, IDLE_MS, SPAM_MAX, LANGS, actionsFor, brisbaneDate, brisbaneToIso, checkConfig, cleanTotp, filterList,
  fmt, formatAppointment, formatDate, formatDay, isIdle, parseLang, qrImageSrc, questionLabel, serviceTitle, sortForAdmin, upcomingDates,
  validateConfirm, validateNote,
} from './domain.js';
import { strings } from './strings.js';
import { content } from './content.js';
import { ServiceError, createSupabaseBackend } from './backend-supabase.js';
import { loadSupabase } from './load-supabase.js';

const LANG_KEY = 'chudao.workbench.lang';
const ACTIVE_KEY = 'workbench.lastActive';
const ARMED_FOR = 4000;

// ---------------------------------------------------------------------------
// Small storage helpers: every access may throw (private mode, blocked storage), and nothing here must break the page.
// ---------------------------------------------------------------------------
const store = {
  get(area, key) { try { return window[area].getItem(key); } catch { return null; } },
  set(area, key, value) { try { window[area].setItem(key, value); } catch { /* not kept */ } },
  remove(area, key) { try { window[area].removeItem(key); } catch { /* nothing to do */ } },
};

const emptyDetail = () => ({ action: null, date: '', time: '', note: '', errors: {}, failure: '', done: '', busy: false, armed: false });
const state = {
  lang: parseLang(store.get('localStorage', LANG_KEY)) ?? 'zh-Hans',
  phase: 'loading', // loading | config | signin | session
  configError: '',
  mode: null,
  backend: null,
  session: null,
  email: '',
  signinNote: '',
  busy: false,
  error: '',
  enrollment: null,
  list: null,
  listError: '',
  loading: false,
  filter: 'all',
  openId: null,
  selecting: false,
  selected: [],
  spamArmed: false,
  spamBusy: false,
  message: null,
  detail: emptyDetail(),
};
let armTimer = null;

const t = () => strings[state.lang];
const root = () => document.getElementById('app');

function announce(message) {
  const region = document.getElementById('announce');
  if (!region) return;
  region.textContent = '';
  setTimeout(() => { region.textContent = message; }, 30);
}

/** Message for a failed call, in the current language. */
function explain(error) {
  const e = t().errors;
  if (!(error instanceof ServiceError)) return e.generic;
  if (error.kind === 'network') return e.network;
  switch (error.code) {
    case 'invalid_credentials': return e.invalidCredentials;
    case 'invalid_code': return e.invalidCode;
    case 'no_factor': return e.noFactor;
    case 'forbidden': return e.forbidden;
    case 'not_authenticated': return e.notAuthenticated;
    case 'invalid_transition': return e.invalidTransition;
    case 'appointment_in_past': return e.appointmentInPast;
    case 'note_required': return e.noteRequired;
    case 'rate_limited': return e.rateLimited;
    case 'invalid_ids': return fmt(e.tooMany, { max: SPAM_MAX });
    default: return e.other;
  }
}

// ---------------------------------------------------------------------------
// Idle lock: 15 minutes without a tap, key, scroll or typing → signed out (this tab keeps nothing that could reopen it).
// The last activity is kept in sessionStorage, so reloading after a long pause also locks.
// ---------------------------------------------------------------------------
let lastActive = Date.now();
let lastSaved = 0;
function bump() {
  lastActive = Date.now();
  if (lastActive - lastSaved > 5000) { lastSaved = lastActive; store.set('sessionStorage', ACTIVE_KEY, String(lastActive)); }
}
function storedActive() {
  const value = Number(store.get('sessionStorage', ACTIVE_KEY));
  return Number.isFinite(value) && value > 0 ? value : null;
}
async function lockIfIdle() {
  if (state.phase !== 'session') return;
  if (!isIdle(lastActive, Date.now(), IDLE_MS)) return;
  await signOut(t().idleNote);
  announce(t().idleNote);
}
setInterval(() => { void lockIfIdle(); }, 15_000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void lockIfIdle(); });
for (const type of ['pointerdown', 'keydown', 'input', 'wheel', 'touchstart']) document.addEventListener(type, bump, { passive: true, capture: true });

// ---------------------------------------------------------------------------
// Session flow
// ---------------------------------------------------------------------------
function resetWork() {
  Object.assign(state, { list: null, listError: '', loading: false, filter: 'all', openId: null, selecting: false, selected: [], spamArmed: false, spamBusy: false, message: null, detail: emptyDetail(), enrollment: null });
}

async function signOut(note = '') {
  const email = state.session?.email ?? state.email;
  try { await state.backend?.signOut(); } catch { /* the local session is gone either way */ }
  store.remove('sessionStorage', ACTIVE_KEY);
  resetWork();
  Object.assign(state, { phase: 'signin', session: null, email, signinNote: note, error: '', busy: false });
  render();
  focusHeading();
}

function enterSession(session) {
  lastSaved = 0;
  bump();
  Object.assign(state, { phase: 'session', session, error: '', busy: false, signinNote: '' });
  if (session.stage === 'ready') { resetWork(); void loadList(); }
  if (session.stage === 'enroll') { state.enrollment = null; void startEnroll(); }
  render();
  focusHeading();
}

async function start() {
  if (window.top !== window.self) { state.phase = 'config'; state.configError = 'framed'; render(); return; }
  let config;
  try { config = (await import('../config.js')).default; } catch { config = null; }
  const checked = checkConfig(config, window.location.hostname);
  if (!checked.ok) { Object.assign(state, { phase: 'config', configError: checked.error }); render(); return; }
  state.mode = checked.mode;
  try {
    if (checked.mode === 'mock') {
      const { MockBackend } = await import('../dev/mock-backend.js');
      state.backend = new MockBackend(window.sessionStorage, { latencyMs: Number(config.mockLatencyMs ?? 250) });
    } else {
      state.backend = createSupabaseBackend(await loadSupabase(), checked.url, checked.key);
    }
  } catch {
    Object.assign(state, { phase: 'config', configError: checked.mode === 'mock' ? 'mockMissing' : 'loadFailed' });
    render();
    return;
  }
  let session = null;
  try { session = await state.backend.current(); }
  catch (error) { state.error = explain(error); }
  const since = storedActive();
  if (session && since !== null && isIdle(since, Date.now(), IDLE_MS)) {
    state.session = session;
    await signOut(t().idleNote);
    return;
  }
  if (session?.stage === 'ready') { enterSession(session); return; }
  // A half-finished sign-in kept from earlier starts over.
  if (session) { state.session = session; await signOut(); return; }
  state.phase = 'signin';
  render();
}

async function submitSignIn(email, password) {
  if (!email.trim() || !password) { state.error = t().fillBoth; render(); focusAlert(); return; }
  Object.assign(state, { busy: true, error: '', email: email.trim(), signinNote: '' });
  render();
  try { enterSession(await state.backend.signIn(email, password)); }
  catch (error) { Object.assign(state, { busy: false, error: explain(error) }); render(); focusAlert(); }
}

async function submitCode(code) {
  const clean = cleanTotp(code);
  if (!clean) { state.error = t().need6; render(); focusAlert(); return; }
  Object.assign(state, { busy: true, error: '' });
  render();
  try {
    const session = state.session.stage === 'enroll'
      ? await state.backend.finishEnroll(state.enrollment.factorId, clean)
      : await state.backend.verifyTotp(clean);
    enterSession(session);
  } catch (error) { Object.assign(state, { busy: false, error: explain(error) }); render(); focusAlert(); }
}

async function startEnroll() {
  Object.assign(state, { busy: true, error: '' });
  render();
  try { state.enrollment = await state.backend.startEnroll(); }
  catch (error) { state.error = explain(error); }
  state.busy = false;
  render();
}

async function loadList() {
  Object.assign(state, { loading: true, listError: '' });
  render();
  try {
    state.list = await state.backend.list();
    if (state.openId && !state.list.some(item => item.id === state.openId)) { state.openId = null; state.detail = emptyDetail(); }
  } catch (error) { state.listError = explain(error); }
  state.loading = false;
  render();
}

async function deleteSpam() {
  if (state.selected.length === 0 || state.spamBusy) return;
  Object.assign(state, { spamBusy: true, spamArmed: false, listError: '' });
  render();
  try {
    const removed = state.selected;
    const count = await state.backend.deleteSpam(removed);
    // Kept as a key, so it follows a language switch.
    Object.assign(state, { message: { key: 'deleted', params: { count } }, selected: [], selecting: false, spamBusy: false });
    state.list = state.list?.filter(item => !removed.includes(item.id)) ?? null;
    const message = fmt(t().deleted, { count });
    if (state.openId && !state.list?.some(item => item.id === state.openId)) state.openId = null;
    announce(message);
    await loadList();
  } catch (error) { Object.assign(state, { spamBusy: false, listError: explain(error) }); render(); }
}

async function runAction(request) {
  const detail = state.detail;
  if (!detail.action || detail.busy) return;
  const errors = detail.action === 'confirm' ? validateConfirm(detail) : detail.action === 'decline' ? validateNote(detail.note) : validateNote(detail.note, false);
  detail.errors = errors; detail.failure = '';
  const first = Object.values(errors).find(Boolean);
  if (first) { render(); announce(t().fields[first]); focusFirstInvalid(); return; }
  detail.busy = true; detail.armed = false;
  render();
  try {
    const note = detail.note.trim();
    const updated = detail.action === 'confirm' ? await state.backend.confirm(request.id, brisbaneToIso(detail.date, detail.time), note)
      : detail.action === 'decline' ? await state.backend.decline(request.id, note)
      : await state.backend.cancel(request.id, note || undefined);
    state.list = sortForAdmin(state.list.map(item => item.id === updated.id ? updated : item));
    state.detail = { ...emptyDetail(), done: updated.status };
    announce(fmt(t().saved, { status: t().status[updated.status] }));
    render();
    focusHeading('#detail-title');
  } catch (error) {
    detail.busy = false;
    detail.failure = explain(error);
    announce(detail.failure);
    render();
    if (error instanceof ServiceError && error.code === 'invalid_transition') void loadList();
  }
}

// ---------------------------------------------------------------------------
// Rendering. The whole page is rebuilt from `state` on every change; typing only updates `state`.
// ---------------------------------------------------------------------------
function focusHeading(selector = 'h1') {
  requestAnimationFrame(() => { const el = root()?.querySelector(selector); if (el) { el.setAttribute('tabindex', '-1'); el.focus({ preventScroll: false }); } });
}
function focusAlert() { requestAnimationFrame(() => root()?.querySelector('[role=alert]')?.focus?.()); }
function focusFirstInvalid() { requestAnimationFrame(() => root()?.querySelector('[aria-invalid=true], .chip-group.invalid .chip')?.focus()); }

const alertBox = (message, kind = 'error') => message ? h('p', { class: `alert ${kind}`, role: kind === 'error' ? 'alert' : 'status', tabindex: '-1' }, message) : null;

function button(label, onclick, { kind = 'primary', disabled = false, type = 'button', extra = {} } = {}) {
  return h('button', { type, class: `btn ${kind}`, disabled, onclick, ...extra }, label);
}

function statusTag(status) {
  return h('span', { class: `tag status-${status}` }, t().status[status] ?? status);
}

function header() {
  const s = t();
  return h('header', { class: 'top' },
    h('div', { class: 'brand' },
      img('icons/icon-192.png', { alt: '', width: 40, height: 40 }),
      h('div', {}, h('strong', {}, s.brand), h('span', {}, s.title))),
    h('div', { class: 'langs', role: 'group', 'aria-label': s.language },
      LANGS.map(lang => h('button', {
        type: 'button', class: 'lang', lang, 'aria-pressed': String(state.lang === lang),
        onclick: () => { state.lang = lang; store.set('localStorage', LANG_KEY, lang); document.documentElement.lang = lang; render(); },
      }, s.langNames[lang]))));
}

function render() {
  const s = t();
  document.documentElement.lang = state.lang;
  document.title = `${s.title} · ${s.brand}`;
  const view = (() => {
    switch (state.phase) {
      case 'loading': return h('p', { class: 'center muted', role: 'status' }, s.loadingSession);
      case 'config': return configView();
      case 'signin': return signInView();
      default: {
        const stage = state.session?.stage;
        if (stage === 'denied') return deniedView();
        if (stage === 'totp' || stage === 'enroll') return codeView(stage);
        return workspaceView();
      }
    }
  })();
  replace(root(), header(), state.mode === 'mock' ? h('p', { class: 'mock-banner' }, s.mockBanner) : null, h('main', { id: 'main' }, view));
}

function configView() {
  const s = t();
  const text = state.configError === 'framed' ? s.framed : s.config[state.configError] ?? s.config.missing;
  return h('section', { class: 'card narrow' }, h('h1', {}, s.config.title), h('p', { class: 'alert error', role: 'alert' }, text));
}

function signInView() {
  const s = t();
  const email = h('input', { id: 'email', type: 'email', name: 'email', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', value: state.email, placeholder: 'name@example.com', disabled: state.busy, oninput: event => { state.email = event.target.value; } });
  const password = h('input', { id: 'password', type: 'password', name: 'password', autocomplete: 'current-password', placeholder: s.password, disabled: state.busy });
  const form = h('form', { method: 'post', novalidate: true, onsubmit: event => { event.preventDefault(); void submitSignIn(email.value, password.value); } },
    h('label', { for: 'email', class: 'label' }, s.email), email,
    h('label', { for: 'password', class: 'label' }, s.password), password,
    alertBox(state.error),
    button(state.busy ? s.signingIn : s.signIn, null, { type: 'submit', disabled: state.busy }));
  if (!state.email) requestAnimationFrame(() => { if (document.activeElement === document.body) email.focus(); });
  return h('section', { class: 'card narrow' },
    h('h1', {}, s.title),
    h('p', { class: 'intro' }, s.intro),
    state.signinNote ? h('p', { class: 'alert note', role: 'status' }, state.signinNote) : null,
    form,
    h('p', { class: 'fine' }, state.mode === 'mock' ? s.mockNote : s.sessionNote));
}

function deniedView() {
  const s = t();
  return h('section', { class: 'card narrow' },
    h('div', { class: 'denied' }, h('h1', {}, s.deniedTitle), h('p', {}, fmt(s.deniedText, { email: state.session.email || s.thisAccount }))),
    button(s.signOut, () => void signOut(), { kind: 'secondary' }));
}

function codeView(stage) {
  const s = t();
  const enroll = stage === 'enroll';
  const code = h('input', { id: 'code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, placeholder: '123456', class: 'code', disabled: state.busy });
  const ready = !enroll || state.enrollment;
  const qr = enroll && state.enrollment ? qrImageSrc(state.enrollment.qrSvg) : null;
  const form = ready ? h('form', { method: 'post', novalidate: true, onsubmit: event => { event.preventDefault(); void submitCode(code.value); } },
    h('label', { for: 'code', class: 'label' }, s.codeLabel), code,
    alertBox(state.error),
    button(state.busy ? s.verifying : enroll ? s.finishEnroll : s.verify, null, { type: 'submit', disabled: state.busy })) : null;
  if (ready && !state.busy) requestAnimationFrame(() => { if (document.activeElement === document.body || document.activeElement?.tagName === 'H1') code.focus(); });
  return h('section', { class: 'card narrow' },
    h('h1', {}, enroll ? s.enrollTitle : s.totpTitle),
    h('p', { class: 'intro' }, enroll ? s.enrollIntro : s.totpIntro),
    enroll ? h('ol', { class: 'steps' }, h('li', {}, s.enrollStep1), h('li', {}, s.enrollStep2), h('li', {}, s.enrollStep3)) : null,
    h('p', { class: 'meta' }, state.session.email),
    enroll && !state.enrollment && state.busy ? h('p', { class: 'muted', role: 'status' }, s.preparing) : null,
    enroll && state.enrollment ? h('div', { class: 'qr-box' },
      qr ? img(qr, { alt: s.qrAlt, width: 180, height: 180, class: 'qr' }) : null,
      h('p', { class: 'meta' }, s.secretLabel),
      h('code', { class: 'secret' }, state.enrollment.secret)) : null,
    form ?? alertBox(state.error),
    enroll && !state.enrollment && !state.busy ? button(s.retry, () => void startEnroll()) : null,
    button(s.signOut, () => void signOut(), { kind: 'secondary' }));
}

function workspaceView() {
  const open = state.list?.find(item => item.id === state.openId) ?? null;
  return h('div', { class: 'workspace', 'data-view': open ? 'detail' : 'list' },
    h('section', { class: 'pane list-pane', 'aria-labelledby': 'list-title' }, listView(open)),
    h('section', { class: 'pane detail-pane' }, open ? detailView(open) : h('p', { class: 'placeholder muted' }, t().pickOne)));
}

function listView(open) {
  const s = t();
  const list = state.list ?? [];
  const shown = filterList(list, state.filter);
  const count = filter => filterList(list, filter).length;
  const lang = state.lang;
  const cards = shown.map(item => {
    const checked = state.selected.includes(item.id);
    const topics = item.topics.map(id => questionLabel(id, lang, content) ?? s.retiredQuestion);
    const when = item.status === 'confirmed' && item.appointmentAt
      ? fmt(s.appointmentShort, { time: formatAppointment(item.appointmentAt, lang) })
      : fmt(s.wantedShort, { day: formatDay(item.preferredDate, lang), when: formatDate(brisbaneDate(new Date(item.submittedAt)), lang).day });
    return h('li', {},
      h('button', {
        type: 'button', class: `card-button${checked ? ' selected' : ''}${open?.id === item.id ? ' current' : ''}`, 'data-id': item.id,
        'aria-pressed': state.selecting ? String(checked) : undefined, 'aria-current': !state.selecting && open?.id === item.id ? 'true' : undefined,
        onclick: () => {
          if (state.selecting) {
            if (!checked && state.selected.length >= SPAM_MAX) { state.message = { key: 'selectLimit', params: { max: SPAM_MAX } }; render(); return; }
            state.selected = checked ? state.selected.filter(id => id !== item.id) : [...state.selected, item.id];
            state.spamArmed = false; state.message = null; render(); return;
          }
          state.openId = item.id; state.detail = emptyDetail(); state.message = null; render(); focusHeading('#detail-title');
        },
      },
      h('span', { class: 'card-top' },
        state.selecting ? h('span', { class: `box${checked ? ' on' : ''}`, 'aria-hidden': 'true' }, checked ? '✓' : '') : null,
        h('span', { class: 'card-title' }, serviceTitle(item.serviceId, lang, content) ?? s.serviceFallback),
        statusTag(item.status)),
      h('span', { class: 'card-name' }, item.name),
      topics.length ? h('span', { class: 'card-topics' }, topics.join(s.listJoin)) : null,
      h('span', { class: 'meta' }, when)));
  });
  const spam = state.selecting ? h('div', { class: 'spam-bar' },
    h('p', {}, fmt(s.spamText, { count: state.selected.length })),
    // Before the second tap, name exactly what will be deleted.
    state.spamArmed ? h('ul', { class: 'spam-list', 'aria-label': s.spamListLabel },
      (state.list ?? []).filter(item => state.selected.includes(item.id))
        .map(item => h('li', {}, `${serviceTitle(item.serviceId, lang, content) ?? s.serviceFallback} · ${item.name} · ${s.status[item.status] ?? item.status}`))) : null,
    h('button', {
      type: 'button', class: `danger${state.spamArmed ? ' armed' : ''}`, disabled: state.spamBusy || state.selected.length === 0,
      onclick: () => { if (state.spamArmed) void deleteSpam(); else { state.spamArmed = true; render(); armReset(() => { state.spamArmed = false; }); } },
    }, state.spamBusy ? s.deleting : state.spamArmed ? fmt(s.spamArmed, { count: state.selected.length }) : fmt(s.spamDelete, { count: state.selected.length }))) : null;
  return [
    h('div', { class: 'list-head' },
      h('div', {}, h('h1', { id: 'list-title' }, s.listTitle), h('p', { class: 'meta' }, fmt(s.adminTag, { email: state.session.email }))),
      h('button', { type: 'button', class: 'link', onclick: () => void signOut() }, s.signOut)),
    h('div', { class: 'filters', role: 'group', 'aria-label': s.filters },
      FILTERS.map(filter => h('button', {
        type: 'button', class: 'filter', 'aria-pressed': String(state.filter === filter), 'data-filter': filter,
        // A selection the filter would hide could be deleted unseen: changing the filter clears it.
        onclick: () => { state.filter = filter; state.selected = []; state.spamArmed = false; render(); },
      }, `${filter === 'all' ? s.all : s.status[filter]} ${count(filter)}`))),
    h('div', { class: 'select-row' },
      state.selecting ? h('span', { class: 'meta' }, s.selectHint) : h('span'),
      h('button', { type: 'button', class: 'link', onclick: () => { state.selecting = !state.selecting; state.selected = []; state.spamArmed = false; state.message = null; render(); } }, state.selecting ? s.selectCancel : s.selectStart)),
    alertBox(state.message ? fmt(s[state.message.key], state.message.params) : '', 'done'),
    alertBox(state.listError),
    state.list === null && !state.listError ? h('p', { class: 'muted', role: 'status' }, s.loadingList) : null,
    state.list !== null && shown.length === 0 ? h('p', { class: 'empty' }, state.filter === 'all' ? s.emptyAll : fmt(s.emptyFilter, { filter: s.status[state.filter] })) : null,
    h('ul', { class: 'cards' }, cards),
    spam,
    button(state.loading ? s.refreshing : s.refresh, () => void loadList(), { kind: 'secondary', disabled: state.loading }),
  ];
}

/** Typing into a field clears its error without a re-render (which would lose the caret). */
function clearFieldError(key, input) {
  if (!state.detail.errors[key]) return;
  delete state.detail.errors[key];
  input.removeAttribute('aria-invalid');
  if (key === 'note') input.setAttribute('aria-describedby', 'note-privacy'); else input.removeAttribute('aria-describedby');
  document.getElementById(`${key}-error`)?.remove();
}

function armReset(after) {
  clearTimeout(armTimer);
  armTimer = setTimeout(() => { after(); render(); }, ARMED_FOR);
}

function detailView(request) {
  const s = t();
  const lang = state.lang;
  const detail = state.detail;
  const rows = [
    [s.name, request.name],
    [s.contact, request.contact],
    [s.preferred, fmt(s.dayWithDate, { day: formatDay(request.preferredDate, lang), date: request.preferredDate })],
  ];
  const topics = request.topics.map(id => questionLabel(id, lang, content) ?? s.retiredQuestion);
  const actions = actionsFor(request.status);
  const fieldError = key => detail.errors[key] ? h('p', { class: 'field-error', id: `${key}-error` }, s.fields[detail.errors[key]]) : null;
  const setAction = action => { Object.assign(detail, { action, errors: {}, failure: '', done: '', armed: false }); render(); };
  const labels = { confirm: s.actionConfirm, decline: s.actionDecline, cancel: s.actionCancel };

  let form = null;
  if (detail.action) {
    const note = h('textarea', {
      id: 'note', rows: 4, maxlength: 500, 'aria-invalid': detail.errors.note ? 'true' : undefined, 'aria-describedby': detail.errors.note ? 'note-error' : 'note-privacy',
      placeholder: detail.action === 'confirm' ? s.placeholderConfirm : detail.action === 'decline' ? s.placeholderDecline : s.placeholderCancel,
      value: detail.note, oninput: event => { detail.note = event.target.value; clearFieldError('note', event.target); },
    });
    const dates = upcomingDates(APPOINTMENT_WINDOW);
    const time = h('input', { id: 'time', type: 'text', autocomplete: 'off', maxlength: 5, placeholder: s.timePlaceholder, value: detail.time, 'aria-invalid': detail.errors.time ? 'true' : undefined, 'aria-describedby': detail.errors.time ? 'time-error' : undefined, oninput: event => { detail.time = event.target.value; clearFieldError('time', event.target); } });
    form = h('div', { class: 'action-form' },
      detail.action === 'confirm' ? [
        h('p', { class: 'label', id: 'date-label' }, s.dateLabel),
        h('p', { class: 'hint' }, s.dateHint),
        h('div', { class: `chip-group${detail.errors.date ? ' invalid' : ''}`, role: 'radiogroup', 'aria-labelledby': 'date-label' },
          dates.map((value, index) => {
            const label = formatDate(value, lang);
            return h('button', {
              type: 'button', role: 'radio', class: 'chip', 'data-date': value, 'aria-checked': String(detail.date === value),
              onclick: () => { detail.date = value; delete detail.errors.date; render(); root().querySelector(`[data-date="${value}"]`)?.focus(); },
            }, h('span', { class: 'chip-caption' }, index === 0 ? s.today : index === 1 ? s.tomorrow : label.weekday), h('span', { class: 'chip-day' }, label.day));
          })),
        fieldError('date'),
        h('label', { for: 'time', class: 'label' }, s.timeLabel), time, fieldError('time'),
      ] : null,
      h('label', { for: 'note', class: 'label' }, detail.action === 'cancel' ? s.noteCancel : s.reply), note, fieldError('note'),
      h('p', { class: 'fine', id: 'note-privacy' }, s.privacyNote),
      alertBox(detail.failure),
      detail.action === 'cancel'
        ? h('button', {
          type: 'button', class: `danger${detail.armed ? ' armed' : ''}`, disabled: detail.busy,
          onclick: () => { if (detail.armed) void runAction(request); else { detail.armed = true; render(); armReset(() => { detail.armed = false; }); } },
        }, detail.busy ? s.cancelling : detail.armed ? s.cancelArmed : s.cancelButton)
        : button(detail.busy ? s.saving : detail.action === 'confirm' ? s.confirmButton : s.declineButton, () => void runAction(request), { kind: detail.action === 'confirm' ? 'mint' : 'coral', disabled: detail.busy }),
      detail.action === 'cancel' && detail.armed ? h('p', { class: 'fine' }, s.cancelHint) : null);
  }

  return [
    h('button', { type: 'button', class: 'link back', onclick: () => { state.openId = null; state.detail = emptyDetail(); render(); focusHeading('#list-title'); } }, `‹ ${s.back}`),
    h('div', { class: 'detail-head' }, h('h2', { id: 'detail-title' }, serviceTitle(request.serviceId, lang, content) ?? s.serviceFallback), statusTag(request.status)),
    alertBox(detail.done ? fmt(s.saved, { status: s.status[detail.done] }) : '', 'done'),
    h('dl', { class: 'review' },
      rows.map(([label, value]) => h('div', { class: 'row' }, h('dt', {}, label), h('dd', {}, value))),
      topics.length ? h('div', { class: 'row' }, h('dt', {}, s.topics), h('dd', {}, h('ul', { class: 'topics' }, topics.map(label => h('li', {}, label))))) : null,
      request.question.trim() ? h('div', { class: 'row' }, h('dt', {}, topics.length ? content.otherField[lang] : s.topics), h('dd', { class: 'pre' }, request.question)) : null,
      h('div', { class: 'row' }, h('dt', {}, s.submittedTime), h('dd', {}, formatAppointment(request.submittedAt, lang))),
      request.appointmentAt ? h('div', { class: 'row' }, h('dt', {}, s.appointment), h('dd', {}, formatAppointment(request.appointmentAt, lang))) : null,
      request.guideNote ? h('div', { class: 'row' }, h('dt', {}, s.reply), h('dd', { class: 'pre' }, request.guideNote)) : null),
    actions.length ? h('div', { class: 'actions', role: 'radiogroup', 'aria-label': s.handle },
      actions.map(action => h('button', { type: 'button', role: 'radio', class: 'filter action', 'data-action': action, 'aria-checked': String(detail.action === action), onclick: () => setAction(action) }, labels[action])))
      : h('p', { class: 'tag ended' }, s.ended),
    form,
  ];
}

void start();
