import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../icon.js', import.meta.url), 'utf8');
function load(fetch, extra = {}) {
  const context = vm.createContext({
    URL, Request, Response, Headers, AbortController, TextEncoder, TextDecoder,
    Uint8Array, atob, btoa, setTimeout, clearTimeout, fetch,
    console: { warn() {}, error() {} }, ...extra,
  });
  vm.runInContext(source.replace('export default {', 'const worker = {'), context);
  return context;
}
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64'));

test('rejects mislabeled HTML and continues to the next favicon', async () => {
  const calls = [];
  const app = load(async (url, init) => {
    calls.push({ url, init });
    return new Response(calls.length === 1 ? '<html>denied</html>' : png, {
      headers: { 'Content-Type': calls.length === 1 ? 'image/png' : 'application/octet-stream' },
    });
  });
  const result = await app.fetchFirstIconCandidate(['https://example.com/bad', 'https://example.com/good'], 20, 'https://example.com/page');
  assert.equal(result.iconUrl, 'https://example.com/good');
  assert.equal(result.icon.contentType, 'image/png');
  assert.equal(calls[1].init.headers.Referer, 'https://example.com/page');
  assert.match(calls[0].init.headers['User-Agent'], /^Mozilla\/5\.0/);
});

test('Zhihu shortcut icon is ranked ahead of touch icons', () => {
  const app = load();
  vm.runInContext(`globalThis.collector = new IconMetadataCollector()`, app);
  for (const attrs of [
    { rel: 'apple-touch-icon', href: 'https://static.zhihu.com/heifetz/assets/apple-touch-icon.png' },
    { rel: 'shortcut icon', type: 'image/x-icon', href: 'https://static.zhihu.com/heifetz/favicon.ico' },
  ]) app.collector.element({ tagName: 'link', getAttribute: (key) => attrs[key] ?? null });
  assert.deepEqual(Array.from(app.rankCandidates(app.collector.links, 'https://www.zhihu.com/signin?next=%2F')), ['https://static.zhihu.com/heifetz/favicon.ico']);
  assert.equal(app.iconGroup(['fluid-icon']), 'other');
});

test('sniffs ICO and rejects an empty image response', () => {
  const app = load();
  assert.equal(app.detectImageType(Uint8Array.from([0, 0, 1, 0, 1, 0]), 'application/octet-stream'), 'image/x-icon');
  assert.equal(app.detectImageType(new Uint8Array(), 'image/png'), null);
});

test('recognizes SVG with an XML declaration and comments', () => {
  const app = load();
  assert.equal(app.detectImageType(new TextEncoder().encode('<?xml version="1.0"?>\n<!-- icon -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'text/plain'), 'image/svg+xml');
});

test('recognizes BMP and JPEG without relying on their MIME headers', () => {
  const app = load();
  const bmp = new Uint8Array(26);
  bmp.set([0x42, 0x4d]);
  assert.equal(app.detectImageType(bmp, 'application/octet-stream'), 'image/bmp');
  assert.equal(app.detectImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9, 0]), 'image/jpeg'), 'image/jpeg');
});

test('decodes binary percent-encoded and escaped base64 data icons', () => {
  const app = load();
  const encoded = Array.from(png, (byte) => '%' + byte.toString(16).padStart(2, '0')).join('');
  assert.deepEqual(app.decodeDataImage('data:image/png,' + encoded).bytes, png);
  assert.deepEqual(app.decodeDataImage('data:image/png;base64,' + encodeURIComponent(Buffer.from(png).toString('base64'))).bytes, png);
});

test('body read deadline cancels stalled responses', async () => {
  let canceled = false;
  const app = load(undefined, { setTimeout: (callback) => setTimeout(callback, 20) });
  const response = new Response(new ReadableStream({ cancel() { canceled = true; } }));
  await assert.rejects(app.readLimited(response, 1024, 'too large'), (error) => error.status === 504);
  assert.equal(canceled, true);
});

test('redirect responses are canceled before fetching the next URL', async () => {
  let canceled = false;
  let calls = 0;
  const app = load(async () => {
    calls += 1;
    if (calls === 1) return new Response(new ReadableStream({ cancel() { canceled = true; } }), { status: 302, headers: { Location: '/icon.png' } });
    assert.equal(canceled, true);
    return new Response(png);
  });
  assert.equal((await app.fetchIcon('https://example.com/favicon.ico')).finalUrl, 'https://example.com/icon.png');
});

function forbidStorage(app) {
  Object.defineProperty(app, 'caches', { get() { assert.fail('proxy must not access Cache API'); } });
  return new Proxy({}, { get() { assert.fail('proxy must not access KV bindings'); } });
}

test('generated links rediscover live icons on every request without KV or Cache API', async () => {
  let pageRequests = 0;
  let iconRequests = 0;
  const siteUrl = 'https://example.com/page?theme=current';
  const app = load(async (url) => {
    if (url === siteUrl) {
      pageRequests += 1;
      return new Response('<html><head></head></html>', { headers: { 'Content-Type': 'text/html' } });
    }
    assert.equal(url, 'https://example.com/favicon.ico');
    iconRequests += 1;
    return new Response(`<svg xmlns="http://www.w3.org/2000/svg"><title>version ${iconRequests}</title></svg>`, {
      headers: { 'Content-Type': 'image/svg+xml' },
    });
  }, {
    HTMLRewriter: class {
      on() { return this; }
      transform(response) { return response; }
    },
  });
  const env = forbidStorage(app);
  const ctx = { waitUntil() { assert.fail('proxy must not schedule cache or KV writes'); } };
  const created = await app.routeRequest(new Request(`https://icons.example/api/icon?url=${encodeURIComponent(siteUrl)}`), env, ctx);
  assert.equal(created.status, 200);
  const body = await created.json();
  assert.deepEqual(body, {
    ok: true,
    site_url: siteUrl,
    icon_url: 'https://example.com/favicon.ico',
    short_url: `https://icons.example/i/u_${Buffer.from(siteUrl).toString('base64url')}`,
    storage: 'embedded',
  });
  for (let version = 2; version <= 3; version += 1) {
    const response = await app.routeRequest(new Request(body.short_url), env, ctx);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Cache-Control'), /\bno-store\b/);
    assert.match(response.headers.get('Content-Type'), /image\/svg\+xml/);
    assert.match(await response.text(), new RegExp(`version ${version}`));
  }
  assert.equal(pageRequests, 3);
  assert.equal(iconRequests, 3);
});

test('old KV links explain that regeneration is needed without consulting KV', async () => {
  const app = load(() => assert.fail('old tokens must not fetch a website'));
  const env = forbidStorage(app);
  await assert.rejects(app.routeRequest(new Request('https://icons.example/i/oldStoredToken'), env), (error) => {
    assert.equal(error.status, 410);
    assert.match(error.message, /重新生成/);
    return true;
  });
});

test('invalid embedded links return 400 without accessing storage or the network', async () => {
  const app = load(() => assert.fail('invalid tokens must not fetch a website'));
  const env = forbidStorage(app);
  for (const token of ['u_', 'u_***', 'u_a', 'u_' + Buffer.from('http://localhost/').toString('base64url')]) {
    await assert.rejects(app.routeRequest(new Request(`https://icons.example/i/${token}`), env), (error) => error.status === 400);
  }
});

test('Unicode URLs with long encoded paths round-trip through newly generated proxy links', async () => {
  const app = load();
  const seen = [];
  app.resolveForTest = async (siteUrl) => {
    seen.push(siteUrl);
    return { iconUrl: 'https://example.com/favicon.ico', icon: { bytes: png, contentType: 'image/png' } };
  };
  vm.runInContext('discoverAndFetchIcon = resolveForTest', app);
  const env = forbidStorage(app);
  const input = 'https://example.com/' + '图'.repeat(400) + '?q=标签#fragment';
  const created = await app.routeRequest(new Request('https://icons.example/api/icon', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: input }),
  }), env);
  assert.equal(created.status, 200);
  const body = await created.json();
  assert.equal(body.site_url, new URL(input).href.split('#')[0]);
  assert.equal(body.storage, 'embedded');
  assert.equal((await app.routeRequest(new Request(body.short_url), env)).status, 200);
  assert.deepEqual(seen, [body.site_url, body.site_url]);
});

for (const method of ['GET', 'POST']) {
  test(`${method} preview opt-in returns the fetched image bytes without another discovery or storage`, async () => {
    const siteUrl = 'https://example.com/page';
    const iconBytes = method === 'GET' ? png : new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><title>图标</title></svg>');
    const contentType = method === 'GET' ? 'image/png' : 'image/svg+xml';
    const requests = [];
    const app = load(async (url) => {
      requests.push(url);
      if (url === siteUrl) {
        return new Response('<html><head></head></html>', { headers: { 'Content-Type': 'text/html' } });
      }
      assert.equal(url, 'https://example.com/favicon.ico');
      return new Response(iconBytes, { headers: { 'Content-Type': contentType } });
    }, {
      HTMLRewriter: class {
        on() { return this; }
        transform(response) { return response; }
      },
    });
    const env = forbidStorage(app);
    const ctx = { waitUntil() { assert.fail('preview must not schedule cache or KV writes'); } };
    const endpoint = new URL('https://icons.example/api/icon?preview=1');
    const init = { method };
    if (method === 'GET') endpoint.searchParams.set('url', siteUrl);
    else {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify({ url: siteUrl });
    }
    const response = await app.routeRequest(new Request(endpoint, init), env, ctx);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.preview_data_url, `data:${contentType};base64,${Buffer.from(iconBytes).toString('base64')}`);
    assert.equal(body.short_url, `https://icons.example/i/u_${Buffer.from(siteUrl).toString('base64url')}`);
    assert.deepEqual(requests, [siteUrl, 'https://example.com/favicon.ico']);
  });
}
