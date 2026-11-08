import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const adminSource = read('../public/scripts/pages/admin.js');
const adminHtml = read('../public/admin.html');
const stripModules = (source) => source
  .replace(/^import[\s\S]*?;\s*/gm, '')
  .replace(/^export\s*\{[^}]*\}(?:\s*from\s*['"][^'"]+['"])?;?\s*/gm, '')
  .replace(/\bexport\s+(?=(?:async\s+)?(?:function|const|let|class)\b)/g, '');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.value = '';
    this.textContent = '';
    this.children = [];
    this.attrs = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.disabled = false;
    this.hidden = false;
    this.isConnected = true;
    this.renderCount = 0;
    const classes = new Set();
    this.classList = { add: (v) => classes.add(v), remove: (v) => classes.delete(v), contains: (v) => classes.has(v) };
  }
  appendChild(node) { this.children.push(node); node.parentNode = this; return node; }
  replaceChildren(...nodes) { this.children = nodes; this.renderCount += 1; }
  replaceWith(node) { node.parentNode = this.parentNode; node.isConnected = true; this.isConnected = false; }
  setAttribute(key, value) { this.attrs.set(key, String(value)); }
  getAttribute(key) { return this.attrs.get(key) ?? null; }
  removeAttribute(key) { this.attrs.delete(key); }
  hasAttribute(key) { return this.attrs.has(key); }
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  async dispatch(name) {
    if (this.disabled) return;
    await Promise.all((this.listeners.get(name) || []).map((listener) => listener({ preventDefault() {}, target: this })));
  }
  querySelectorAll(selector) {
    return this.children.filter((element) => selector === 'input[type="password"]' && element.type === 'password');
  }
  querySelector(selector) {
    return this.children.find((element) => selector === 'button[type="submit"]' && element.type === 'submit') || null;
  }
  focus() { this.focused = true; }
  select() {}
  reset() { this.children.forEach((child) => { child.value = ''; }); }
}

const item = (id, name = id) => ({ id, name, url: `https://${id}.example/`, description: '', icon: '' });
const dataFixture = (overrides = {}) => ({
  _version: 1,
  apps: [item('first')],
  bookmarks: [{ ...item('bookmark'), category: '' }],
  settings: { siteName: 'Navigation', siteLogo: '', greeting: '', footer: '', weather: { city: '北京' }, glassOpacity: 40, useWallpaper: true, wallpaperUrl: '/api/wallpaper' },
  siteStartDate: null,
  ...overrides,
});
const response = (data, status = 200) => ({ response: { ok: status >= 200 && status < 300, status, statusText: 'Request failed' }, payload: { success: status < 400, data } });

function harness() {
  const elements = new Map();
  for (const match of adminHtml.matchAll(/<(\w+)\b([^>]*)>/g)) {
    const id = /\bid="([^"]+)"/.exec(match[2])?.[1];
    if (!id) continue;
    const element = new Element(match[1]);
    element.id = id;
    element.disabled = /\bdisabled(?:\s|>|$)/.test(match[2]);
    element.hidden = /\bhidden(?:\s|>|$)/.test(match[2]);
    element.type = /\btype="([^"]+)"/.exec(match[2])?.[1];
    element.value = /\bvalue="([^"]*)"/.exec(match[2])?.[1] || '';
    elements.set(id, element);
  }
  const categoryField = elements.get('editor-category-field');
  categoryField.parentNode = new Element();
  const passwordForm = elements.get('password-form');
  for (const id of ['current-password', 'new-password', 'confirm-password', 'password-submit']) passwordForm.appendChild(elements.get(id));
  const requests = [];
  const navigations = [];
  const faviconUpdates = [];
  const body = new Element('body');
  const document = {
    title: 'Admin', readyState: 'loading', body,
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) => new Element(tag),
    createComment: () => new Element('comment'),
    createDocumentFragment: () => new Element('fragment'),
    addEventListener() {},
    querySelectorAll: (selector) => selector === '.add-button' ? [] : [...elements.values()].filter((element) => ['input', 'textarea', 'select', 'button'].includes(element.tagName)),
  };
  const context = vm.createContext({
    document, URL, crypto: webcrypto, AbortController, structuredClone,
    window: { addEventListener() {}, confirm: () => true, location: { replace: (path) => navigations.push(path) } },
    console: { error() {} },
    renderMarkdown: (value) => value,
    createFaviconController: () => ({ updateFavicon: (...args) => faviconUpdates.push(args) }),
    createItemIcon: () => new Element('span'),
    setDocumentTitle() {}, sharedScrollToTop() {}, setBackToTopVisibility() {},
    replaceChildrenSafe: (element, ...nodes) => element?.replaceChildren(...nodes),
  });
  function library(path, exports) {
    const source = stripModules(read(path));
    const values = vm.runInContext(`(() => { ${source}\nreturn { ${exports.join(', ')} }; })()`, context);
    Object.assign(context, values);
  }
  library('../public/scripts/lib/shared.js', ['normaliseItemFields', 'normaliseSiteSettings', 'normaliseFooterValue', 'parseWeatherCities', 'WEATHER_MAX_CITIES']);
  library('../public/scripts/lib/data.js', ['normaliseCollectionItems', 'normaliseWeatherSettingsForEditor']);
  library('../public/scripts/lib/api.js', ['getPayloadData', 'getPayloadMessage']);
  let serve = async () => response(dataFixture());
  context.fetchJson = async (url, options = {}) => {
    const request = { url, ...options, body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(request);
    return serve(request);
  };
  vm.runInContext(stripModules(adminSource), context);
  context.bindEvents();
  const evaluate = (source) => vm.runInContext(source, context);
  return {
    context, elements, requests, navigations, faviconUpdates, evaluate,
    serve(handler) { serve = handler; },
    async load(data = dataFixture()) { serve = async () => response(data); await context.loadData(); requests.length = 0; },
    async input(id, value) {
      const element = elements.get(id);
      if (element.disabled) return;
      element.value = value;
      await element.dispatch('input');
    },
    async add(type, name = 'New item') {
      context.openEditor(type);
      await this.input('editor-name', name);
      await this.input('editor-url', 'https://new.example/');
      await elements.get('editor-form').dispatch('submit');
    },
  };
}

test('one atomic save includes stable item IDs, settings and date and uses its response without another GET', async () => {
  const h = harness();
  await h.load();
  await h.add('apps');
  await h.add('bookmarks');
  await h.input('site-name', 'Updated navigation');
  await h.input('site-start-date', '2026-01-01');
  const appId = h.evaluate('state.apps[1].id');
  const bookmarkId = h.evaluate('state.bookmarks[1].id');
  assert.match(appId, /^[\da-f-]{36}$/);
  h.serve(async ({ body }) => response(dataFixture({
    _version: 2,
    apps: [item('first'), body.operations.apps[0].item],
    bookmarks: [{ ...item('bookmark'), category: '' }, body.operations.bookmarks[0].item],
    settings: { ...dataFixture().settings, ...body.settings }, siteStartDate: body.stats.siteStartDate,
  })));
  await h.context.saveChanges();
  assert.equal(h.requests.length, 1);
  const request = h.requests[0];
  assert.equal(request.url, '/api/admin/data');
  assert.equal(request.method, 'PATCH');
  assert.equal(request.body._version, 1);
  assert.equal(request.body.operations.apps[0].item.id, appId);
  assert.equal(request.body.operations.bookmarks[0].item.id, bookmarkId);
  assert.equal(request.body.settings.siteName, 'Updated navigation');
  assert.equal(request.body.stats.siteStartDate, '2026-01-01');
  assert.equal(h.evaluate('savedSnapshot._version'), 2);
  assert.equal(h.evaluate('isDirty'), false);
  assert.equal(h.elements.get('save-button').disabled, true);
});

test('saving locks editing and reload until completion and preserves the submitted content', async () => {
  const h = harness(); await h.load();
  await h.input('site-name', 'Submitted');
  const gate = deferred();
  h.serve(() => gate.promise);
  const saving = h.context.saveChanges();
  assert.equal(h.elements.get('site-name').disabled, true);
  assert.equal(h.elements.get('reload-button').disabled, true);
  assert.equal(h.elements.get('editor-name').disabled, true);
  await h.input('site-name', 'Cannot be typed while saving');
  assert.equal(await h.context.loadData(), false);
  assert.equal(h.requests.length, 1);
  gate.resolve(response(dataFixture({ _version: 2, settings: { ...dataFixture().settings, siteName: 'Submitted' } })));
  await saving;
  assert.equal(h.elements.get('site-name').value, 'Submitted');
  assert.equal(h.elements.get('site-name').disabled, false);
  await h.input('site-name', 'Next edit');
  assert.equal(h.evaluate('isDirty'), true);
  assert.equal(h.evaluate('state.settings.siteName'), 'Next edit');
});

test('uncertain saves retry the same transaction and item IDs without adding duplicates', async () => {
  const h = harness(); await h.load(); await h.add('apps');
  h.serve(async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError', outcomeUnknown: true }); });
  await h.context.saveChanges();
  const first = h.requests[0].body;
  assert.equal(h.evaluate('isDirty'), true);
  assert.equal(h.elements.get('save-button').disabled, false);
  h.serve(async ({ body }) => response(dataFixture({ _version: 2, apps: [item('first'), body.operations.apps[0].item] })));
  await h.context.saveChanges();
  assert.deepEqual(h.requests[1].body, first);
  assert.equal(h.evaluate('state.apps.length'), 2);
});

test('version conflicts and malformed success responses preserve local edits and do not reload them', async () => {
  for (const result of [response(null, 409), response(null)]) {
    const h = harness(); await h.load(); await h.input('site-name', 'Unsaved edit');
    h.serve(async () => result);
    await h.context.saveChanges();
    assert.equal(h.requests.length, 1);
    assert.equal(h.evaluate('state.settings.siteName'), 'Unsaved edit');
    assert.equal(h.evaluate('isDirty'), true);
    assert.equal(h.elements.get('save-button').disabled, false);
    assert.match(h.elements.get('status-bar').textContent, /已保留/);
  }
});

test('initial loading disables editing, and invalid loaded data cannot erase an existing draft', async () => {
  const h = harness();
  const gate = deferred(); h.serve(() => gate.promise);
  const loading = h.context.loadData();
  assert.equal(h.elements.get('site-name').disabled, true);
  gate.resolve(response(dataFixture())); await loading;
  await h.input('site-name', 'Draft');
  h.serve(async () => response({ settings: {} }));
  assert.equal(await h.context.loadData(), false);
  assert.equal(h.evaluate('state.settings.siteName'), 'Draft');
  assert.equal(h.evaluate('isDirty'), true);
});

test('logout is usable, stays on the editor after server failure and navigates only after confirmed logout', async () => {
  const h = harness(); await h.load();
  assert.equal(h.elements.get('logout-button').disabled, false);
  await h.input('site-name', 'Keep this edit');
  h.serve(async () => response(null, 503));
  await h.elements.get('logout-button').dispatch('click');
  assert.deepEqual(h.navigations, []);
  assert.equal(h.evaluate('isDirty'), true);
  assert.equal(h.elements.get('logout-button').disabled, false);
  h.serve(async () => response(null));
  await h.elements.get('logout-button').dispatch('click');
  assert.deepEqual(h.navigations, ['/']);
});

test('closing an editor aborts logo discovery and its late result cannot alter the next item', async () => {
  const h = harness(); await h.load();
  h.context.openEditor('apps', 0);
  const gate = deferred(); h.serve(() => gate.promise);
  const loading = h.context.handleFetchLogo();
  const signal = h.requests[0].signal;
  h.context.closeEditor();
  h.context.openEditor('bookmarks', 0);
  await h.input('editor-icon', 'Second icon');
  assert.equal(signal.aborted, true);
  gate.resolve({ response: { ok: true, status: 200 }, payload: { success: true, logoUrl: 'https://first.example/icon.png' } });
  await loading;
  assert.equal(h.elements.get('editor-icon').value, 'Second icon');
  assert.equal(h.elements.get('fetch-logo-button').disabled, false);
  assert.equal(h.evaluate('isDirty'), false);
});

test('editing the target URL cancels logo discovery and saving the modal keeps a stable new ID', async () => {
  const h = harness(); await h.load();
  h.context.openEditor('apps');
  await h.input('editor-name', 'New'); await h.input('editor-url', 'https://first.example/');
  const id = h.evaluate('modalContext.id');
  const gate = deferred(); h.serve(() => gate.promise);
  const loading = h.context.handleFetchLogo();
  await h.input('editor-url', 'https://second.example/');
  assert.equal(h.requests[0].signal.aborted, true);
  gate.resolve({ response: { ok: true, status: 200 }, payload: { success: true, logoUrl: 'https://first.example/icon.png' } });
  await loading;
  assert.equal(h.elements.get('editor-icon').value, '');
  await h.elements.get('editor-form').dispatch('submit');
  assert.equal(h.evaluate('state.apps[1].id'), id);
});

test('editing one collection preserves the other rendered table and nonidentity input does not refresh favicon', async () => {
  const h = harness();
  await h.load(dataFixture({ settings: { ...dataFixture().settings, siteLogo: 'https://logo.example/icon.png' } }));
  const bookmarksRenders = h.elements.get('bookmarks-editor').renderCount;
  const identityUpdates = h.faviconUpdates.length;
  await h.add('apps');
  assert.equal(h.elements.get('bookmarks-editor').renderCount, bookmarksRenders);
  await h.input('site-greeting', 'Hello'); await h.input('site-footer-content', '**Footer**');
  await h.input('site-name', 'New title');
  assert.equal(h.faviconUpdates.length, identityUpdates);
  await h.input('site-logo', 'https://logo.example/new.png');
  assert.equal(h.faviconUpdates.length, identityUpdates + 1);
});

test('over-limit weather settings and unsaved modal edits stop a site save before any network request', async () => {
  const h = harness(); await h.load();
  await h.input('site-weather-city', '北京 上海 深圳 广州 青岛 济南 天津 南京 苏州');
  await h.context.saveChanges();
  assert.equal(h.requests.length, 0);
  assert.match(h.elements.get('status-bar').textContent, /最多配置 8/);
  h.context.openEditor('apps', 0);
  await h.context.saveChanges();
  assert.equal(h.requests.length, 0);
  assert.match(h.elements.get('editor-error').textContent, /当前条目/);
});

test('password changes advance the editor version without discarding unsaved content', async () => {
  const h = harness(); await h.load();
  await h.input('site-name', 'Keep my draft');
  await h.input('current-password', 'current-test-password');
  await h.input('new-password', 'next-test-password');
  await h.input('confirm-password', 'next-test-password');
  h.serve(async () => response({ _version: 2 }));
  await h.elements.get('password-form').dispatch('submit');
  assert.equal(h.evaluate('savedSnapshot._version'), 2);
  assert.equal(h.evaluate('state.settings.siteName'), 'Keep my draft');
  assert.equal(h.evaluate('isDirty'), true);
  h.serve(async ({ body }) => response(dataFixture({ _version: 3, settings: { ...dataFixture().settings, ...body.settings } })));
  await h.context.saveChanges();
  assert.equal(h.requests[1].body._version, 2);
  assert.equal(h.requests[1].body.settings.siteName, 'Keep my draft');
});

test('a password change does not silently accept unrelated intervening data versions', async () => {
  const h = harness(); await h.load();
  await h.input('site-name', 'Keep my draft');
  await h.input('current-password', 'current-test-password');
  await h.input('new-password', 'next-test-password');
  await h.input('confirm-password', 'next-test-password');
  h.serve(async () => response({ _version: 4 }));
  await h.elements.get('password-form').dispatch('submit');
  assert.equal(h.evaluate('savedSnapshot._version'), 1);
  assert.equal(h.evaluate('state.settings.siteName'), 'Keep my draft');
  assert.equal(h.evaluate('isDirty'), true);
});
