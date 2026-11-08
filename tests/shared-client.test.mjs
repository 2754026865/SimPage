import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { fetchJson } from '../public/scripts/lib/api.js';
import { parseWeatherCities, normaliseSiteSettings, normaliseItemFields, normalizeUrl } from '../public/scripts/lib/shared.js';
import { normaliseCollectionItems } from '../public/scripts/lib/data.js';
import { renderMarkdown } from '../public/scripts/lib/markdown.js';
import { getWeekNumber, createDailyCalendarCache } from '../public/scripts/lib/date.js';
import { createFaviconController, createItemIcon } from '../public/scripts/lib/ui.js';
import { withBrowserGlobals } from './helpers/browser-globals.mjs';

test('shared city rules support legacy shapes, punctuation and duplicate cities', () => {
  assert.deepEqual(parseWeatherCities({ weatherLocation: ['北京，青岛', '北京', { city: '上海;QINGDAO qingdao' }] }), ['北京', '青岛', '上海', 'QINGDAO']);
  const cyclic = {}; cyclic.city = cyclic;
  assert.deepEqual(parseWeatherCities(cyclic), []);
  assert.equal(normaliseSiteSettings({ weatherLocation: '青岛，上海' }, { weatherMode: 'editor' }).weather.city, '青岛 上海');
  assert.deepEqual(normaliseSiteSettings({ weatherLocation: '青岛' }).weather, { city: '青岛' });
});

test('shared settings and collection rules retain migration while rejecting malformed entries', () => {
  const settings = normaliseSiteSettings({ wallpaperUrl: ' https://bing.img.run/uhd.php ', glassOpacity: NaN, useWallpaper: false, footer: '甲\r\n乙' });
  assert.equal(settings.wallpaperUrl, '/api/wallpaper');
  assert.equal(settings.glassOpacity, 40);
  assert.equal(settings.useWallpaper, false);
  assert.equal(settings.footer, '甲\n乙');
  assert.deepEqual(normaliseCollectionItems([null, { id: '1', name: ' A ' }], 'apps'), [{ id: '1', name: ' A ', url: '', description: '', icon: '' }]);
  assert.equal(normaliseItemFields({ name: ' A ' }, 'apps', { trim: true }).name, 'A');
});

test('shared URL rule accepts destinations and rejects active protocols and credentials', () => {
  assert.equal(normalizeUrl('example.com/a_b'), 'https://example.com/a_b');
  assert.equal(normalizeUrl('/about'), '/about');
  for (const value of ['javascript:alert(1)', 'data:text/html,test', 'https://user:secret@example.com/', 'https://exam\nple.com/']) assert.equal(normalizeUrl(value), '');
});

test('Markdown keeps underscores and query parameters inside link destinations', () => {
  assert.equal(renderMarkdown('[文档](https://example.com/file_name_more?first=a_b&other=c_d)'), '<p><a href="https://example.com/file_name_more?first=a_b&amp;other=c_d" target="_blank" rel="noopener noreferrer">文档</a></p>');
  assert.match(renderMarkdown('`[x](https://example.com/a_b)`'), /<code>\[x\]\(https:\/\/example.com\/a_b\)<\/code>/);
  assert.match(renderMarkdown('[**标题**](https://example.com/a_b)'), /<strong>标题<\/strong>/);
});

test('Markdown escapes raw HTML and attribute delimiters and rejects executable URLs', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n[x](javascript:alert(1))\n![" onerror="x](https://example.com/p.png?x="&y=1)');
  assert.doesNotMatch(html, /<script|href="javascript:|\sonerror="/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /alt="&quot; onerror=&quot;x"/);
  assert.match(html, /referrerpolicy="no-referrer"/);
});

test('week number is stable within a date and changes on Sunday', () => {
  for (const hour of [0, 12, 23]) assert.equal(getWeekNumber(new Date(2026, 0, 3, hour, 59)), 1);
  assert.equal(getWeekNumber(new Date(2026, 0, 4, 0)), 2);
  assert.equal(getWeekNumber(new Date(2027, 0, 1)), 1);
});

test('calendar cache calculates date and lunar text once per local day', () => {
  let dateCalls = 0, lunarCalls = 0;
  const get = createDailyCalendarCache({ formatDate: () => `date${++dateCalls}`, formatLunar: () => `lunar${++lunarCalls}` });
  const first = get(new Date(2026, 10, 8, 0));
  for (let hour = 1; hour < 24; hour++) assert.equal(get(new Date(2026, 10, 8, hour)), first);
  assert.equal(lunarCalls, 1);
  assert.notEqual(get(new Date(2026, 10, 9)), first);
  assert.equal(dateCalls, 2);
});

test('fetch deadline includes a response body that never finishes', async (t) => {
  let requestSignal;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requestSignal = options.signal;
    return { json: () => new Promise(() => {}) };
  });
  await assert.rejects(fetchJson('/slow', { timeoutMs: 10 }), { name: 'TimeoutError' });
  assert.equal(requestSignal.aborted, true);
});

test('write deadline reports an unconfirmed outcome and never retries', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => { calls++; return new Promise(() => {}); });
  await assert.rejects(fetchJson('/save', { method: 'PATCH', timeoutMs: 10 }), error => error.name === 'TimeoutError' && error.outcomeUnknown && /重新读取/.test(error.message));
  assert.equal(calls, 1);
});

test('caller cancellation is forwarded and the external listener is removed', async (t) => {
  const controller = new AbortController();
  const remove = t.mock.method(controller.signal, 'removeEventListener');
  let innerSignal;
  t.mock.method(globalThis, 'fetch', async (_url, options) => { innerSignal = options.signal; return { json: () => new Promise(() => {}) }; });
  const pending = fetchJson('/slow', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(innerSignal.aborted, true);
  assert.equal(remove.mock.callCount(), 1);
});

test('already aborted requests never call fetch and successful JSON keeps its contract', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ value: 3 }); });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchJson('/data', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
  const result = await fetchJson('/data');
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.payload, { value: 3 });
});

test('blocked storage does not prevent theme initialization or in-memory toggling', () => {
  const source = readFileSync(new URL('../public/scripts/features/theme.js', import.meta.url), 'utf8');
  for (const failure of ['read', 'write']) {
    const classes = new Set();
    let toggle;
    const context = vm.createContext({
      document: { getElementById: () => ({ addEventListener: (_type, callback) => { toggle = callback; } }), body: { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } }, documentElement: { setAttribute() {} } },
      localStorage: { getItem() { if (failure === 'read') throw new Error('blocked'); return null; }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } },
      window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
    });
    vm.runInContext(source, context);
    toggle(); assert.equal(classes.has('dark-theme'), true);
    toggle(); assert.equal(classes.has('dark-theme'), false);
  }
});

test('emoji favicon cache evicts old entries while retaining recently used ones', () => {
  let rendered = 0;
  const link = { setAttribute() {}, removeAttribute() {} };
  const document = { createElement() { rendered++; return { getContext: () => ({ clearRect() {}, fillText() {} }), toDataURL: () => `data:image/png,${rendered}` }; } };
  const controller = createFaviconController({ faviconLink: link });
  withBrowserGlobals({ document }, () => {
    for (let i = 0; i < 20; i++) controller.updateFavicon(String.fromCharCode(65 + i), 'Page');
    assert.equal(rendered, 20);
    controller.updateFavicon('S', 'Page'); assert.equal(rendered, 20);
    controller.updateFavicon('A', 'Page'); assert.equal(rendered, 21);
  });
});

test('shared item icons use lazy decoding and a failure fallback', () => {
  const elements = [];
  const document = { createElement: tag => { const element = { tag, children: [], appendChild(item) { this.children.push(item); } }; elements.push(element); return element; } };
  const wrapper = withBrowserGlobals({ document }, () => createItemIcon({ name: '导航', icon: 'https://example.com/icon.png', className: 'tile-icon' }));
  const image = wrapper.children[0];
  assert.equal(image.loading, 'lazy'); assert.equal(image.decoding, 'async'); assert.equal(image.referrerPolicy, 'no-referrer');
  image.onerror(); assert.equal(wrapper.textContent, '导'); assert.equal(image.onerror, null);
});

test('item icons load safe root-relative images but not network-relative or ambiguous paths', () => {
  const document = { createElement: tag => ({ tag, children: [], appendChild(child) { this.children.push(child); } }) };
  withBrowserGlobals({ document }, () => {
    const valid = createItemIcon({ name: 'Local', icon: '/simpage-logo.svg' });
    assert.equal(valid.children[0].tag, 'img');
    assert.equal(valid.children[0].src, '/simpage-logo.svg');
    for (const icon of ['//other.example/icon.svg', '/\\other.example/icon.svg', '/bad\npath.svg', '/bad path.svg']) {
      assert.equal(createItemIcon({ name: 'Local', icon }).children.length, 0, icon);
    }
  });
});
