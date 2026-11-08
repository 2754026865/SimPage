import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

// SimPage delegates image discovery to IconLink. Test that integration here;
// the standalone image-discovery worker is not part of this repository.
const source = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const constants = source.slice(source.indexOf('const ICON_LINK_API_URL'), source.indexOf('// =================================================================================', source.indexOf('const ICON_LINK_API_URL')));
const handler = source.slice(source.indexOf('async function handleFetchLogo('), source.indexOf('async function handleLogout('));
const helpers = source.slice(source.indexOf('function jsonResponse('), source.indexOf('function isProduction('));

function load(fetch) {
  const timers = new Map();
  let nextTimerId = 0;
  const context = vm.createContext({
    URL, Request, Response, Headers, AbortController, fetch,
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    console: { error() {} },
  });
  vm.runInContext(constants + handler + helpers, context);
  return { app: context, timers };
}

function request(targetUrl) {
  const url = new URL('https://nav.example/api/fetch-logo');
  if (targetUrl !== undefined) url.searchParams.set('targetUrl', targetUrl);
  return new Request(url);
}

test('rejects missing, blank, oversized and malformed targets before contacting IconLink', async () => {
  const { app, timers } = load(() => assert.fail('invalid input must not make a network request'));
  for (const target of [undefined, '', '   ', 'a'.repeat(2049), 'https://', 'https://[invalid', 'https://bad host.example']) {
    const response = await app.handleFetchLogo(request(target));
    assert.equal(response.status, 400, String(target));
    assert.equal((await response.json()).success, false);
  }
  assert.equal(timers.size, 0);
});

test('sends normalized site URLs to the fixed IconLink endpoint and returns only the selected logo', async () => {
  const targets = ['example.com/page?q=hello', ' http://example.com/path ', 'https://example.com/图标?q=标签'];
  const seen = [];
  const { app, timers } = load(async (url, init) => {
    assert.equal(url, 'https://iconcc.439933.xyz/api/icon');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Accept, 'application/json');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.equal(init.headers.Origin, 'https://nav.439933.xyz');
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.signal.aborted, false);
    seen.push(JSON.parse(init.body));
    return Response.json({
      ok: true,
      short_url: ' https://iconcc.439933.xyz/i/test-logo ',
      site_url: 'https://example.com',
      diagnostic: 'upstream details should not be forwarded',
    });
  });
  const env = new Proxy({}, { get() { assert.fail('fetching a logo must not access KV or credentials'); } });
  for (const target of targets) {
    const response = await app.handleFetchLogo(request(target), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, logoUrl: 'https://iconcc.439933.xyz/i/test-logo' });
  }
  assert.deepEqual(seen, [
    { url: 'https://example.com/page?q=hello' },
    { url: 'http://example.com/path' },
    { url: new URL('https://example.com/图标?q=标签').href },
  ]);
  assert.equal(timers.size, 0);
});

test('preserves actionable upstream client errors and maps upstream service failures to 502', async () => {
  for (const [upstreamStatus, expectedStatus] of [[400, 400], [404, 404], [429, 429], [500, 502], [503, 502]]) {
    const { app, timers } = load(async () => Response.json({ ok: false, error: ' 请求暂不可用 ' }, { status: upstreamStatus }));
    const response = await app.handleFetchLogo(request('https://example.com'));
    assert.equal(response.status, expectedStatus);
    assert.deepEqual(await response.json(), { success: false, message: '请求暂不可用' });
    assert.equal(timers.size, 0);
  }
});

test('rejects HTML, malformed JSON and unsuccessful payloads instead of accepting a broken logo', async () => {
  for (const fixture of [
    () => new Response('<html>verification required</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('{broken json', { headers: { 'Content-Type': 'application/json' } }),
    () => Response.json(null),
    () => Response.json({ ok: false }),
    () => Response.json({ short_url: 'https://example.com/icon.png' }),
  ]) {
    const { app, timers } = load(async () => fixture());
    const response = await app.handleFetchLogo(request('https://example.com'));
    assert.equal(response.status, 502);
    assert.equal((await response.json()).success, false);
    assert.equal(timers.size, 0);
  }
});

test('rejects missing or executable logo URLs from an otherwise successful upstream payload', async () => {
  for (const shortUrl of [undefined, null, 123, '', '   ', 'javascript:alert(1)', 'data:image/svg+xml,<svg/>', '/relative-icon.png']) {
    const { app, timers } = load(async () => Response.json({ ok: true, short_url: shortUrl }));
    const response = await app.handleFetchLogo(request('https://example.com'));
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { success: false, message: '图标 API 未返回有效的短链。' });
    assert.equal(timers.size, 0);
  }
});

test('network errors are contained and do not expose connection details in the API response', async () => {
  const { app, timers } = load(async () => { throw new Error('private diagnostic: upstream credential'); });
  const response = await app.handleFetchLogo(request('https://example.com'));
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { success: false, message: '无法访问图标 API，请稍后重试。' });
  assert.equal(timers.size, 0);
});

test('the upstream request deadline aborts the request and returns a retryable timeout', async () => {
  let upstreamSignal;
  const { app, timers } = load((_url, init) => new Promise((_resolve, reject) => {
    upstreamSignal = init.signal;
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('deadline'), { name: 'AbortError' })), { once: true });
  }));
  const pending = app.handleFetchLogo(request('https://example.com'));
  assert.equal(timers.size, 1);
  const deadline = [...timers.values()][0];
  assert.equal(deadline.delay, 30_000);
  deadline.callback();
  const response = await pending;
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { success: false, message: '获取网站图标超时，请稍后重试。' });
  assert.equal(timers.size, 0);
});

test('the deadline remains active while reading a stalled upstream response body', async () => {
  let bodyStarted;
  let upstreamSignal;
  const readingBody = new Promise((resolve) => { bodyStarted = resolve; });
  const { app, timers } = load(async (_url, init) => {
    upstreamSignal = init.signal;
    return {
      ok: true,
      status: 200,
      json() {
        bodyStarted();
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error('body deadline'), { name: 'AbortError' })), { once: true });
        });
      },
    };
  });
  const pending = app.handleFetchLogo(request('https://example.com'));
  await readingBody;
  assert.equal(timers.size, 1, 'receiving headers must not clear the body-read deadline');
  [...timers.values()][0].callback();
  const response = await pending;
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { success: false, message: '获取网站图标超时，请稍后重试。' });
  assert.equal(timers.size, 0);
});
