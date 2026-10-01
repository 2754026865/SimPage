import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
function load(fetch) {
  const context = vm.createContext({
    fetch, URL, Response, AbortController, setTimeout, clearTimeout,
    console: { error() {} },
  });
  const defaults = source.slice(source.indexOf('const BASE_DEFAULT_SETTINGS'), source.indexOf('const DEFAULT_STATS'));
  const handler = source.slice(source.indexOf('async function handleGetWallpaper('), source.indexOf('async function handleFetchLogo('));
  const settings = source.slice(source.indexOf('function normaliseVisualSettings('), source.indexOf('function toSafeNonNegativeInteger('));
  vm.runInContext(defaults + handler + settings, context);
  return context;
}

test('daily wallpaper proxies UAPI image bytes and keeps its key server-side', async () => {
  const bytes = Uint8Array.from([82, 73, 70, 70, 1, 2, 3, 4, 87, 69, 66, 80]);
  const app = load(async (url, init) => {
    assert.equal(url, 'https://uapis.cn/api/v1/image/bing-daily?resolution=4k');
    assert.equal(init.headers.Authorization, 'Bearer test-secret');
    assert.equal(init.redirect, 'manual');
    return new Response(bytes, { headers: { 'Content-Type': 'image/webp', 'X-Debug-Key': 'test-secret', 'Set-Cookie': 'upstream=private' } });
  });
  const response = await app.handleGetWallpaper(new Request('https://example.com/api/wallpaper'), { UAPI_KEY: ' test-secret ' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'image/webp');
  assert.equal(response.headers.get('Location'), null);
  assert.equal(response.headers.get('X-Debug-Key'), null);
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=1800');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test('missing key uses the documented anonymous endpoint', async () => {
  const app = load(async (url, init) => {
    assert.equal(init.headers.Authorization, undefined);
    return new Response('image bytes', { headers: { 'Content-Type': 'image/webp' } });
  });
  assert.equal((await app.handleGetWallpaper()).status, 200);
});

test('upstream failures, redirects and non-images produce an uncached error without leaking details', async () => {
  for (const fixture of [
    () => new Response('unavailable', { status: 503 }),
    () => new Response('invalid test-secret', { status: 401 }),
    () => new Response(null, { status: 302, headers: { Location: 'https://other.example/?key=test-secret' } }),
    () => Response.json({ error: 'test-secret' }),
    () => new Response('', { headers: { 'Content-Type': 'image/webp' } }),
  ]) {
    const app = load(async () => fixture());
    const response = await app.handleGetWallpaper();
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.doesNotMatch(await response.text(), /test-secret/);
  }
});

test('upstream timeout produces 504', async () => {
  const app = load(async () => { throw Object.assign(new Error('timeout'), { name: 'AbortError' }); });
  assert.equal((await app.handleGetWallpaper()).status, 504);
});

test('legacy default is migrated in memory without replacing custom wallpaper or disabled state', () => {
  const app = load();
  assert.equal(app.normaliseVisualSettings({ wallpaperUrl: 'https://bing.img.run/uhd.php' }).wallpaperUrl, '/api/wallpaper');
  assert.equal(app.normaliseVisualSettings({}).wallpaperUrl, '/api/wallpaper');
  const custom = app.normaliseVisualSettings({ useWallpaper: false, wallpaperUrl: 'https://example.com/custom.jpg' });
  assert.equal(custom.wallpaperUrl, 'https://example.com/custom.jpg');
  assert.equal(custom.useWallpaper, false);
});
