// The only way the workbench builds DOM. Text (including everything that comes from a booking request) always goes in
// as a text node, never as HTML: this file and every other workbench file avoid innerHTML / outerHTML /
// insertAdjacentHTML / document.write; tests/mock-and-safety.test.mjs fails if any of them is used. Attributes go through an
// allow-list, so request data can never become a src, href, style or event handler. The page's CSP has no
// 'unsafe-inline' and turns on Trusted Types, so the browser itself also refuses inline scripts and HTML sinks.

/** Attributes h() may set. No src / href / style / srcdoc / on* / formaction. */
const ALLOWED = /^(id|class|type|role|name|for|lang|dir|tabindex|title|alt|width|height|rows|maxlength|placeholder|autocomplete|inputmode|enterkeyhint|autocapitalize|spellcheck|readonly|novalidate|method|hidden|aria-[a-z]+|data-[a-z-]+)$/;

/**
 * h('button', { class: 'btn', onclick: fn, 'aria-pressed': true }, 'text', child, [more])
 * Strings and numbers become text nodes; null / undefined / false children are skipped; arrays are flattened.
 * Props: `text` sets textContent; `value`, `checked`, `disabled` set the property; `on<event>` adds a listener.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') el.textContent = String(value);
    else if (key === 'value') el.value = String(value);
    else if (key === 'checked' || key === 'disabled') el[key] = Boolean(value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (ALLOWED.test(key)) el.setAttribute(key, value === true ? (key.startsWith('aria-') ? 'true' : '') : String(value));
    else throw new Error(`attribute not allowed: ${key}`);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else if (child instanceof Node) el.append(child);
    else el.append(document.createTextNode(String(child)));
  }
}

/** An image from this site's own files (icons/…) or an already-checked data:image/svg+xml URL (the TOTP QR code). */
export function img(src, props = {}) {
  if (!/^icons\/[a-z0-9-]+\.png$/.test(src) && !/^data:image\/svg\+xml[;,]/.test(src)) throw new Error('image source not allowed');
  const el = h('img', props);
  el.src = src;
  return el;
}

/** Replaces everything inside `el`. */
export function replace(el, ...children) {
  el.replaceChildren();
  append(el, children);
}
