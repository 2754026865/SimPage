import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUpstreamServices } from '../server/upstream.mjs';

const quiet = { warn() {}, error() {} };
const bytes = Uint8Array.from([255, 216, 255, 224, 1, 2, 3, 4]);
const image = (headers = {}) => new Response(bytes, { headers: { 'Content-Type': 'image/jpeg', ...headers } });
const request = () => new Request('https://example.com/api/wallpaper');

test('concurrent cold wallpaper requests share one bounded download and independent response bodies', async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const begin = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const app = createUpstreamServices({
    logger: quiet, getCache: () => null,
    fetch: async () => { calls++; started(); await gate; return image(); },
  });
  const first = app.handleGetWallpaper(request());
  const second = app.handleGetWallpaper(request());
  await begin;
  release();
  const responses = await Promise.all([first, second]);
  assert.equal(calls, 1);
  for (const response of responses) assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  await app.handleGetWallpaper(request());
  assert.equal(calls, 2, 'the completed flight must not retain image data indefinitely');
});

test('stale wallpaper returns immediately while one background refresh populates the cache', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const now = 1800000000000;
  const tasks = [];
  let written;
  const app = createUpstreamServices({
    logger: quiet, now: () => now,
    getCache: () => ({
      match: async () => image({ 'X-Wallpaper-Cached-At': String(now - 3600000) }),
      put: async (_key, value) => { written = value; },
    }),
    fetch: async () => { await gate; return image(); },
  });
  const response = await app.handleGetWallpaper(request(), {}, { waitUntil(task) { tasks.push(task); } });
  assert.equal(response.headers.get('X-Wallpaper-Cache'), 'stale');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.equal(written, undefined);
  release();
  await Promise.all(tasks);
  assert.equal(written.headers.get('X-Wallpaper-Cached-At'), String(now));
  await written.arrayBuffer();
});

test('weather deadline remains active for a stalled body and cancels its reader', async () => {
  const timers = new Map();
  let readStarted, canceled = false;
  const reading = new Promise(resolve => { readStarted = resolve; });
  const app = createUpstreamServices({
    logger: quiet, getCache: () => null,
    setTimeout(callback, delay) { timers.set(1, { callback, delay }); return 1; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async () => new Response(new ReadableStream({
      pull() { readStarted(); },
      cancel() { canceled = true; },
    }), { headers: { 'Content-Type': 'application/json' } }),
  });
  const pending = app.fetchAndCache(new URL('https://api.open-meteo.com/test'));
  await reading;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.get(1).delay, 5000);
  timers.get(1).callback();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(canceled, true);
  assert.equal(timers.size, 0);
});

test('a stalled optional wallpaper cache write cannot delay a completed image', async () => {
  const timers = new Map();
  const tasks = [];
  let sequence = 0;
  const app = createUpstreamServices({
    logger: quiet,
    getCache: () => ({ match: async () => null, put: () => new Promise(() => {}) }),
    fetch: async () => image(),
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const response = await app.handleGetWallpaper(request(), {}, { waitUntil(task) { tasks.push(task); } });
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  const cacheDeadline = [...timers.values()].find(timer => timer.delay === 1000);
  assert.ok(cacheDeadline, 'background cache writes also need a finite deadline');
  cacheDeadline.callback();
  await Promise.all(tasks);
  assert.equal(timers.size, 0);
});

test('weather cache read and write failures cannot discard a successful upstream result', async () => {
  const tasks = [];
  const app = createUpstreamServices({
    logger: quiet,
    getCache: () => ({ match() { throw new Error('read unavailable'); }, put() { throw new Error('write unavailable'); } }),
    fetch: async () => Response.json({ current_weather: { temperature: 20 } }),
  });
  const result = await app.fetchAndCache(new URL('https://api.open-meteo.com/test'), { waitUntil(task) { tasks.push(task); } });
  assert.equal(result.current_weather.temperature, 20);
  await Promise.all(tasks);
});

test('a cached upstream failure is not retried through the same circuit breaker', async () => {
  let fetches = 0;
  const app = createUpstreamServices({
    logger: quiet,
    getCache: () => ({ match: async () => new Response(null, { status: 503 }) }),
    fetch: async () => { fetches++; return Response.json({}); },
  });
  await assert.rejects(app.geocodeCity('北京'), error => error.statusCode === 503 && error.cachedFailure);
  assert.equal(fetches, 0);
});

test('weather rejects oversized streamed JSON without caching it', async () => {
  let canceled = false, writes = 0;
  const app = createUpstreamServices({
    logger: quiet,
    getCache: () => ({ match: async () => null, put: async () => { writes++; } }),
    fetch: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); },
      cancel() { canceled = true; },
    }), { headers: { 'Content-Type': 'application/json' } }),
  });
  await assert.rejects(app.fetchAndCache(new URL('https://api.open-meteo.com/test')), /超出大小/);
  assert.equal(canceled, true);
  assert.equal(writes, 0);
});

test('icon discovery rejects credentials and sends only the public origin', async () => {
  const bodies = [];
  const app = createUpstreamServices({
    logger: quiet,
    fetch: async (_url, init) => { bodies.push(JSON.parse(init.body)); return Response.json({ ok: true, short_url: 'https://example.com/icon.png' }); },
  });
  const target = value => new Request('https://example.com/api/fetch-logo?targetUrl=' + encodeURIComponent(value));
  assert.equal((await app.handleFetchLogo(target('https://user:password@example.com/private'))).status, 400);
  assert.equal(bodies.length, 0);
  assert.equal((await app.handleFetchLogo(target('https://example.com/private/path?signature=not-a-real-token#private'))).status, 200);
  assert.deepEqual(bodies, [{ url: 'https://example.com' }]);
});

