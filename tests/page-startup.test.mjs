import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withBrowserGlobals } from './helpers/browser-globals.mjs';

// Load real ES modules and their imports rather than cutting page functions out
// of source. A minimal DOM keeps this integration check local and deterministic.
function element(tagName = 'div') {
  const classes = new Set();
  return {
    tagName, textContent: '', value: '', children: [], attrs: new Map(), listeners: new Map(), dataset: {}, disabled: false,
    classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value), toggle(value, state) { if (state) classes.add(value); else classes.delete(value); } },
    style: { setProperty() {}, removeProperty() {} },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    replaceChildren(...children) { this.children = children; },
    setAttribute(key, value) { this.attrs.set(key, value); }, getAttribute(key) { return this.attrs.get(key) ?? null; },
    removeAttribute(key) { this.attrs.delete(key); }, hasAttribute(key) { return this.attrs.has(key); },
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    querySelector() { return null; }, querySelectorAll() { return []; }, focus() {},
  };
}

function browser(ids) {
  const elements = new Map(ids.map(id => [id, element()]));
  const listeners = new Map();
  const document = {
    title: 'Test page', readyState: 'loading', visibilityState: 'visible', body: element('body'), documentElement: element('html'),
    getElementById: id => elements.get(id) || null, querySelector: () => null,
    querySelectorAll: selector => selector === '.add-button' ? [] : [...elements.values()],
    createElement: element, createDocumentFragment: () => element('fragment'),
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  let timer = 0;
  const window = {
    location: { href: '', replace(path) { this.href = path; } },
    setTimeout: () => ++timer, clearTimeout() {}, setInterval: () => ++timer, clearInterval() {},
    addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  const localStorage = { getItem() { throw new Error('Storage denied'); }, setItem() { throw new Error('Storage denied'); } };
  return { document, window, localStorage, elements, listeners };
}

const siteData = {
  _version: 1,
  settings: { siteName: 'Working navigation', useWallpaper: false, weather: { city: '北京' } },
  apps: [{ id: 'app-1', name: 'App one', url: 'https://example.com/' }],
  bookmarks: [{ id: 'bookmark-1', name: 'Bookmark one', url: 'https://example.org/' }],
};

test('real home module and dependencies initialize even when browser storage is unavailable', async () => {
  const b = browser(['site-name', 'current-time', 'current-date', 'apps-grid', 'apps-empty', 'bookmarks-grid', 'bookmarks-empty', 'apps-panel', 'bookmarks-panel']);
  const requests = [];
  await withBrowserGlobals({ document: b.document, window: b.window, localStorage: b.localStorage, fetch: async (url) => {
    requests.push(url); return Response.json(siteData);
  } }, async () => {
    await import('../public/scripts/pages/home.js?startup-check');
    await b.listeners.get('DOMContentLoaded')();
    assert.equal(b.document.title, 'Working navigation');
    assert.equal(b.elements.get('site-name').textContent, 'Working navigation');
    assert.match(b.elements.get('current-time').textContent, /\d{2}:\d{2}/);
    assert.equal(b.elements.get('apps-grid').children[0].children[0].href, 'https://example.com/');
    assert.equal(b.elements.get('bookmarks-grid').children.length, 0);
    assert.deepEqual(requests, ['/api/data']);
  });
});

test('real admin module initializes its editor through the shared request and data modules', async () => {
  const b = browser(['site-name', 'save-button', 'reload-button', 'logout-button', 'status-bar', 'apps-editor', 'bookmarks-editor']);
  await withBrowserGlobals({ document: b.document, window: b.window, fetch: async () => Response.json({ success: true, data: siteData }) }, async () => {
    await import('../public/scripts/pages/admin.js?startup-check');
    await b.listeners.get('DOMContentLoaded')();
    assert.equal(b.elements.get('site-name').value, 'Working navigation');
    assert.equal(b.elements.get('status-bar').textContent, '数据已加载。');
    assert.equal(b.elements.get('save-button').disabled, true);
    assert.equal(b.elements.get('logout-button').disabled, false);
    assert.equal(b.elements.get('apps-editor').children[0].className, 'admin-table-wrapper');
  });
});

test('real login module sends a password through the shared request module and navigates after success', async () => {
  const b = browser(['login-form', 'login-password', 'login-error', 'login-submit']);
  const requests = [];
  await withBrowserGlobals({ document: b.document, window: b.window, fetch: async (url, options) => {
    requests.push({ url, options });
    return url === '/api/admin/data' ? Response.json({ success: false }, { status: 401 }) : Response.json({ success: true });
  } }, async () => {
    await import('../public/scripts/pages/login.js?startup-check');
    await new Promise(resolve => setImmediate(resolve));
    b.elements.get('login-password').value = 'local-test-password';
    await b.elements.get('login-form').listeners.get('submit')({ preventDefault() {} });
    assert.equal(requests[1].url, '/api/login');
    assert.equal(JSON.parse(requests[1].options.body).password, 'local-test-password');
    assert.equal(b.window.location.href, '/admin');
    assert.equal(b.elements.get('login-submit').disabled, false);
  });
});
