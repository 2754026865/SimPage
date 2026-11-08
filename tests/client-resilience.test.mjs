import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { createItemIcon, createFaviconController } from '../public/scripts/lib/ui.js';
import { withBrowserGlobals } from './helpers/browser-globals.mjs';

const home = readFileSync(new URL('../public/scripts/pages/home.js', import.meta.url), 'utf8');
const quoteSource = home.slice(home.indexOf('function formatYiyanQuote('), home.indexOf('function normaliseWeatherSetting('));

function quoteHarness(fetchJson, cache = new Map(), extra = {}) {
  const timers = new Map();
  const warnings = [];
  const displays = [];
  let nextTimer = 0;
  const context = vm.createContext({
    greetingElement: {}, AbortController, Date,
    fetchJson,
    window: { sessionStorage: { getItem(key) { return cache.get(key) ?? null; }, setItem(key, value) { cache.set(key, value); } } },
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    console: { warn(message) { warnings.push(message); }, error() { assert.fail('Optional quote failures should not be reported as uncaught errors'); } },
    ...extra,
  });
  context.updateGreetingDisplay = () => displays.push(vm.runInContext('yiyanMessage', context));
  vm.runInContext(`let yiyanMessage = ''; ${quoteSource}`, context);
  return { context, cache, timers, warnings, displays, load: () => context.loadYiyanQuote() };
}

test('a successful quote is cached for reloads in this session', async () => {
  const cache = new Map();
  const first = quoteHarness(async () => ({ response: { ok: true }, payload: { hitokoto: '云开见山', from: '随笔' } }), cache);
  await first.load();
  assert.deepEqual(first.displays, ['云开见山 —— 随笔']);
  assert.equal(first.timers.size, 0);
  const second = quoteHarness(() => assert.fail('A fresh cache should not fetch again'), cache);
  await second.load();
  assert.deepEqual(second.displays, first.displays);
});

test('expired quotes refresh and malformed or blocked storage does not break fetching', async () => {
  const cases = [
    new Map([['simpage:yiyan:v1', JSON.stringify({ message: '旧句子', savedAt: Date.now() - 31 * 60 * 1000 })]]),
    new Map([['simpage:yiyan:v1', '{broken']]),
  ];
  for (const cache of cases) {
    const h = quoteHarness(async () => ({ response: { ok: true }, payload: { hitokoto: '新句子' } }), cache);
    await h.load();
    assert.deepEqual(h.displays, ['新句子']);
  }
  const h = quoteHarness(async () => ({ response: { ok: true }, payload: { hitokoto: '可用句子' } }), new Map(), {
    window: { get sessionStorage() { throw new Error('Storage is disabled'); } },
  });
  await h.load();
  assert.deepEqual(h.displays, ['可用句子']);
});

test('quote timeout preserves the current greeting and releases its timer', async () => {
  const h = quoteHarness((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  const pending = h.load();
  [...h.timers.values()][0]();
  await pending;
  assert.equal(h.displays.length, 0);
  assert.equal(h.timers.size, 0);
  assert.match(h.warnings[0], /超时/);
});

test('empty or unsuccessful quote responses keep the current greeting', async () => {
  for (const result of [{ response: { ok: false }, payload: null }, { response: { ok: true }, payload: {} }]) {
    const h = quoteHarness(async () => result);
    await h.load();
    assert.equal(h.displays.length, 0);
    assert.equal(h.cache.size, 0);
    assert.equal(h.timers.size, 0);
  }
});

function makeElement(tagName) {
  return {
    tagName, children: [], attrs: new Map(), textContent: '',
    classList: { add() {} },
    appendChild(child) { this.children.push(child); },
    setAttribute(key, value) { this.attrs.set(key, value); },
    removeAttribute(key) { this.attrs.delete(key); },
  };
}

test('a failed tile icon falls back to the first character without changing its link', () => {
  const document = { createElement: makeElement };
  const context = vm.createContext({ document, normalizeUrl: url => url,
    createItemIcon: options => withBrowserGlobals({ document }, () => createItemIcon(options)),
  });
  vm.runInContext(home.slice(home.indexOf('function createTile('), home.indexOf('function performLocalSearch(')), context);
  const tile = context.createTile({ name: '导航', url: 'https://example.com/', icon: 'https://example.com/broken.png' });
  const icon = tile.children[0];
  icon.children[0].onerror();
  assert.equal(icon.textContent, '导');
  assert.equal(tile.href, 'https://example.com/');
  assert.equal(icon.children[0].onerror, null);
});

function faviconHarness() {
  const images = [];
  const timers = new Map();
  let nextTimer = 0;
  const link = makeElement('link');
  const globals = {
    Image: class { constructor() { images.push(this); } removeAttribute(key) { delete this[key]; } },
    window: { setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); } },
  };
  const controller = createFaviconController({ faviconLink: link, defaultHref: '/simpage-logo.svg', defaultType: 'image/svg+xml' });
  return { images, timers, link, update: (...args) => withBrowserGlobals(globals, () => controller.updateFavicon(...args)) };
}

test('failed or timed out custom favicon retains the local icon', () => {
  for (const fail of ['error', 'timeout']) {
    const h = faviconHarness();
    h.update('https://example.com/broken.ico', '导航');
    assert.equal(h.link.href, '/simpage-logo.svg');
    if (fail === 'error') h.images[0].onerror();
    else [...h.timers.values()][0]();
    assert.equal(h.link.href, '/simpage-logo.svg');
    assert.equal(h.link.attrs.get('type'), 'image/svg+xml');
    assert.equal(h.images[0].src, undefined);
    assert.equal(h.timers.size, 0);
  }
});

test('a superseded favicon request cannot replace newer settings', () => {
  const h = faviconHarness();
  h.update('https://example.com/old.ico', '导航');
  const lateSuccess = h.images[0].onload;
  h.update('https://example.com/new.ico', '导航');
  assert.equal(h.images[0].src, undefined);
  h.images[1].onload();
  lateSuccess();
  assert.equal(h.link.href, 'https://example.com/new.ico');
  assert.equal(h.timers.size, 0);
});

test('identical favicon settings reuse both pending and completed image requests', () => {
  const h = faviconHarness();
  h.update('https://example.com/icon.ico', '导航');
  h.update('https://example.com/icon.ico', '新名称');
  assert.equal(h.images.length, 1);
  h.images[0].onload();
  h.update('https://example.com/icon.ico', '另一个名称');
  assert.equal(h.images.length, 1);
  assert.equal(h.link.href, 'https://example.com/icon.ico');
});

test('favicon loads safe root-relative images and rejects ambiguous relative network paths', () => {
  const h = faviconHarness();
  h.update('/images/local-icon.svg', 'Local');
  assert.equal(h.images[0].src, '/images/local-icon.svg');
  h.images[0].onload();
  assert.equal(h.link.href, '/images/local-icon.svg');
  const document = { createElement: () => ({ getContext: () => null }) };
  withBrowserGlobals({ document }, () => {
    for (const icon of ['//other.example/icon.svg', '/\\other.example/icon.svg', '/bad\npath.svg', '/bad path.svg']) h.update(icon, 'Local');
  });
  assert.equal(h.images.length, 1);
  assert.equal(h.timers.size, 0);
});
