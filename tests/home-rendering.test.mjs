import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import * as shared from '../public/scripts/lib/shared.js';
import * as data from '../public/scripts/lib/data.js';
import * as ui from '../public/scripts/lib/ui.js';
import * as api from '../public/scripts/lib/api.js';
import * as dates from '../public/scripts/lib/date.js';
import { withBrowserGlobals } from './helpers/browser-globals.mjs';

function element(tag = 'div') {
  const classes = new Set();
  return {
    tag, children: [], textContent: '', updates: 0, hidden: false, attrs: new Map(),
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), toggle(name, value) { if (value) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) },
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; this.updates++; },
    setAttribute(name, value) { this.attrs.set(name, value); }, removeAttribute(name) { this.attrs.delete(name); },
  };
}

function harness() {
  const elements = new Map(['apps-grid', 'apps-empty', 'bookmarks-grid', 'bookmarks-empty', 'apps-panel', 'bookmarks-panel', 'local-search-feedback'].map(id => [id, element()]));
  const document = {
    title: 'Page', readyState: 'loading', getElementById: id => elements.get(id) || null, querySelector: () => null,
    createElement: element, createDocumentFragment: () => element('fragment'), addEventListener() {},
    documentElement: { style: { setProperty() {} } },
  };
  const context = vm.createContext({
    ...shared, ...data, ...ui, ...api, ...dates, document, console, Intl, URL, AbortController,
    formatLunar: () => '农历', sharedScrollToTop() {},
    window: { setTimeout() {}, clearTimeout() {} },
    fetchJson: async () => ({ response: { ok: true }, payload: { data: {
      settings: { siteName: 'Test', useWallpaper: false }, apps: [{ id: '1', name: 'Alpha', url: 'https://example.com' }, { id: '2', name: 'Beta', url: 'https://example.org' }],
      bookmarks: [{ id: '3', name: 'Bookmark', category: '工作', url: 'https://example.net' }],
    } } }),
    createItemIcon: options => withBrowserGlobals({ document }, () => ui.createItemIcon(options)),
  });
  const source = readFileSync(new URL('../public/scripts/pages/home.js', import.meta.url), 'utf8').replace(/^import\s+[^;]+;[^\n]*$/gm, '');
  vm.runInContext(source, context);
  const app = new Proxy(context, {
    get(target, key) {
      const value = target[key];
      return typeof value === 'function'
        ? (...args) => withBrowserGlobals({ document }, () => value(...args))
        : value;
    },
  });
  return { app, elements, document };
}

test('home renders only the visible collection and reuses unchanged tab content', async () => {
  const h = harness();
  await h.app.loadData();
  assert.equal(h.elements.get('apps-grid').updates, 1);
  assert.equal(h.elements.get('bookmarks-grid').updates, 0);
  h.app.showCollection('bookmarks');
  assert.equal(h.elements.get('bookmarks-grid').updates, 1);
  h.app.showCollection('apps'); h.app.showCollection('bookmarks');
  assert.equal(h.elements.get('apps-grid').updates, 1);
  assert.equal(h.elements.get('bookmarks-grid').updates, 1);
});

test('local searches and clearing results do not rebuild a hidden collection', async () => {
  const h = harness();
  await h.app.loadData();
  h.app.showCollection('bookmarks');
  h.app.performLocalSearch('apps', 'Alpha');
  h.app.performLocalSearch('apps', 'Beta');
  h.app.clearLocalSearchResults();
  assert.equal(h.elements.get('bookmarks-grid').updates, 1);
  assert.equal(h.elements.get('apps-grid').updates, 4);
  h.app.showCollection('bookmarks');
  assert.equal(h.elements.get('bookmarks-grid').updates, 1);
});
