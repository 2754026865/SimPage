import assert from 'node:assert/strict';
import { createUpstreamServices } from '../server/upstream.mjs';
import { normaliseVisualSettings } from '../public/scripts/lib/shared.js';
import { test } from 'node:test';

const now = 1_800_000_000_000;
const imageBytes = Uint8Array.from([255, 216, 255, 224, 1, 2, 3, 4]);
const request = () => new Request('https://example.com/api/wallpaper');
const imageResponse = (headers = {}) => new Response(imageBytes, { headers: { 'Content-Type': 'image/jpeg', ...headers } });

function load(fetch, extra = {}) {
  return { ...createUpstreamServices({ fetch, now: () => now, getCache: () => extra.caches?.default, logger: { warn() {}, error() {} } }), normaliseVisualSettings };
}

test('daily wallpaper follows the bimg redirect without a key and returns only image headers', async () => {
  const calls = [];
  const app = load(async (url, init) => {
    calls.push(url);
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.redirect, 'manual');
    if (calls.length === 1) {
      assert.equal(url, 'https://api.bimg.cc/today');
      return new Response(null, { status: 302, headers: { Location: 'https://bing.com/th?id=today.jpg' } });
    }
    assert.equal(url, 'https://bing.com/th?id=today.jpg');
    return imageResponse({ 'X-Upstream-Private': 'private-value', 'Set-Cookie': 'upstream=private' });
  });
  const response = await app.handleGetWallpaper(request(), {});
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(response.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(response.headers.get('X-Upstream-Private'), null);
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal(response.headers.get('X-Wallpaper-Cached-At'), null);
  assert.equal(response.headers.get('X-Wallpaper-Cache'), 'fresh');
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=1800');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), imageBytes);
});

test('direct image responses also work without environment secrets', async () => {
  const app = load(async () => imageResponse());
  assert.equal((await app.handleGetWallpaper(request())).status, 200);
});

test('redirects outside HTTPS bimg and Bing hosts are rejected before making a request', async () => {
  for (const location of ['https://evil.example/image.jpg', 'http://bing.com/image.jpg', 'https://bing.com.evil.example/', 'https://user:pass@bing.com/', 'https://bing.com:8443/image']) {
    let calls = 0;
    const app = load(async () => {
      calls++;
      return new Response(null, { status: 302, headers: { Location: location } });
    });
    assert.equal((await app.handleGetWallpaper(request())).status, 502, location);
    assert.equal(calls, 1, location);
  }
});

test('redirect loops stop after the bounded number of requests', async () => {
  let calls = 0;
  const app = load(async () => {
    calls++;
    return new Response(null, { status: 302, headers: { Location: '/today' } });
  });
  assert.equal((await app.handleGetWallpaper(request())).status, 502);
  assert.equal(calls, 4);
});

test('upstream errors, challenge HTML, missing redirects and empty images return uncached errors', async () => {
  for (const fixture of [
    () => new Response('private upstream details', { status: 503 }),
    () => new Response('challenge', { status: 403, headers: { 'CF-Mitigated': 'challenge' } }),
    () => new Response(null, { status: 302 }),
    () => Response.json({ error: 'private upstream details' }),
    () => new Response('', { headers: { 'Content-Type': 'image/jpeg' } }),
  ]) {
    let writes = 0;
    const app = load(async () => fixture(), { caches: { default: { match: async () => null, put: async () => writes++ } } });
    const response = await app.handleGetWallpaper(request());
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.doesNotMatch(await response.text(), /private upstream details/);
    assert.equal(writes, 0);
  }
});

test('upstream timeout produces 504 when no cached image exists', async () => {
  const app = load(async () => { throw Object.assign(new Error('timeout'), { name: 'AbortError' }); });
  assert.equal((await app.handleGetWallpaper(request())).status, 504);
});

test('both declared and streamed image size are limited', async () => {
  let canceled = false;
  for (const response of [
    imageResponse({ 'Content-Length': String(8 * 1024 * 1024 + 1) }),
    new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); },
      cancel() { canceled = true; },
    }), { headers: { 'Content-Type': 'image/jpeg' } }),
  ]) {
    const app = load(async () => response);
    assert.equal((await app.handleGetWallpaper(request())).status, 502);
  }
  assert.equal(canceled, true);
});

test('fresh cache avoids the upstream and removes internal timestamp from the response', async () => {
  const app = load(async () => { assert.fail('fresh cache should not fetch'); }, {
    caches: { default: { match: async () => imageResponse({ 'X-Wallpaper-Cached-At': String(now - 100_000) }) } },
  });
  const response = await app.handleGetWallpaper(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Wallpaper-Cache'), 'hit');
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=1700');
  assert.equal(response.headers.get('X-Wallpaper-Cached-At'), null);
});

test('successful responses populate a single query-independent cache entry for a day', async () => {
  const pending = [];
  let storedResponse;
  let storedKey;
  const app = load(async () => imageResponse(), {
    caches: { default: {
      match: async () => null,
      async put(key, response) { storedKey = key; storedResponse = response; },
    } },
  });
  const response = await app.handleGetWallpaper(new Request('https://example.com/api/wallpaper?random=value'), {}, { waitUntil(p) { pending.push(p); } });
  await response.arrayBuffer();
  await Promise.all(pending);
  assert.equal(storedKey.url, 'https://example.com/__cache/wallpaper/bimg-v1');
  assert.equal(storedResponse.headers.get('Cache-Control'), 'public, max-age=86400');
  assert.equal(storedResponse.headers.get('X-Wallpaper-Cached-At'), String(now));
  assert.deepEqual(new Uint8Array(await storedResponse.arrayBuffer()), imageBytes);
});

test('a failed refresh serves the last successful image for at most one day', async () => {
  for (const ageSeconds of [3600, 86401]) {
    const app = load(async () => { throw new Error('offline'); }, {
      caches: { default: { match: async () => imageResponse({ 'X-Wallpaper-Cached-At': String(now - ageSeconds * 1000) }) } },
    });
    const response = await app.handleGetWallpaper(request());
    assert.equal(response.status, ageSeconds < 86400 ? 200 : 502);
    if (ageSeconds < 86400) {
      assert.equal(response.headers.get('X-Wallpaper-Cache'), 'stale');
      assert.equal(response.headers.get('Cache-Control'), 'public, max-age=60');
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), imageBytes);
    }
  }
});

test('cache read and write failures do not break a successful upstream response', async () => {
  const app = load(async () => imageResponse(), {
    caches: { default: {
      async match() { throw new Error('cache unavailable'); },
      async put() { throw new Error('cache unavailable'); },
    } },
  });
  assert.equal((await app.handleGetWallpaper(request())).status, 200);
});

test('legacy default migrates without replacing custom wallpaper or disabled state', () => {
  const app = load();
  assert.equal(app.normaliseVisualSettings({ wallpaperUrl: 'https://bing.img.run/uhd.php' }).wallpaperUrl, '/api/wallpaper');
  assert.equal(app.normaliseVisualSettings({}).wallpaperUrl, '/api/wallpaper');
  const custom = app.normaliseVisualSettings({ useWallpaper: false, wallpaperUrl: 'https://example.com/custom.jpg' });
  assert.equal(custom.wallpaperUrl, 'https://example.com/custom.jpg');
  assert.equal(custom.useWallpaper, false);
});
