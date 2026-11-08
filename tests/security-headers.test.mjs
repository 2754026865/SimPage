import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const security = source.slice(source.indexOf('const SECURITY_CSP ='), source.indexOf('export default {'));
const assets = source.slice(source.indexOf('async function serveStatic('), source.indexOf('// API Handlers'));

// Exercise our rewrite callbacks without substituting for Cloudflare's HTML parser.
class HTMLRewriterStub {
  on(selector, handler) {
    assert.equal(selector, 'script[src]');
    this.handler = handler;
    return this;
  }

  transform(response) {
    const handler = this.handler;
    const body = new ReadableStream({
      async start(controller) {
        try {
          const text = (await response.text()).replace(/<script\b([^>]*)>/g, (tag, attributes) => {
            const src = attributes.match(/\bsrc="([^"]*)"/);
            if (!src) return tag;
            let nonce;
            handler.element({
              getAttribute(name) { return name === 'src' ? src[1] : null; },
              setAttribute(name, value) { assert.equal(name, 'nonce'); nonce = value; },
            });
            return nonce ? `<script${attributes} nonce="${nonce}">` : tag;
          });
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
    return new Response(body, response);
  }
}

function load(getAssetFromKV = async () => new Response('asset')) {
  const context = vm.createContext({
    crypto: webcrypto, URL, Request, Response, Headers, Uint8Array,
    HTMLRewriter: HTMLRewriterStub, getAssetFromKV, assetManifest: {},
  });
  vm.runInContext(security + assets, context);
  return context;
}

const request = new Request('https://nav.example/');
const htmlResponse = (body = '<script src="/scripts/pages/home.js"></script>') => new Response(body, {
  headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=600',
    ETag: '"raw-html"',
    'Last-Modified': 'Sun, 08 Nov 2026 00:00:00 GMT',
    'Content-Length': String(body.length),
  },
});

test('HTML nonce matches trusted script tags and does not authorize other inline or external code', async () => {
  const app = load();
  const response = app.applySecurityHeaders(htmlResponse([
    '<script src="/home.js"></script>',
    '<script src="https://nav.example/shared.js"></script>',
    '<script src="//untrusted.example/script.js"></script>',
    '<script src="blob:https://nav.example/untrusted"></script>',
    '<script>untrustedInline()</script>',
  ].join('\n')), request);
  const csp = response.headers.get('Content-Security-Policy');
  const scriptDirective = csp.split('; ').find(value => value.startsWith('script-src '));
  const nonce = scriptDirective.match(/'nonce-([a-f0-9]{32})'/)?.[1];
  assert.ok(nonce);
  assert.match(scriptDirective, /https:\/\/static\.cloudflareinsights\.com(?: |$)/);
  assert.doesNotMatch(scriptDirective, /unsafe-inline|unsafe-eval|\*/);
  assert.match(csp, /connect-src [^;]*https:\/\/cloudflareinsights\.com(?:;|$)/);
  assert.match(csp, /object-src 'none'/);
  const body = await response.text();
  assert.ok(body.includes(`<script src="/home.js" nonce="${nonce}">`));
  assert.ok(body.includes(`<script src="https://nav.example/shared.js" nonce="${nonce}">`));
  assert.ok(body.includes('<script src="//untrusted.example/script.js">'));
  assert.ok(body.includes('<script src="blob:https://nav.example/untrusted">'));
  assert.ok(body.includes('<script>untrustedInline()</script>'));
});

test('each HTML response gets a fresh nonce and cannot reuse old validators or cached transformed HTML', async () => {
  const app = load();
  const first = app.applySecurityHeaders(htmlResponse(), request);
  const second = app.applySecurityHeaders(htmlResponse(), request);
  assert.notEqual(first.headers.get('Content-Security-Policy'), second.headers.get('Content-Security-Policy'));
  for (const response of [first, second]) {
    assert.equal(response.headers.get('Cache-Control'), 'no-store, must-revalidate');
    assert.equal(response.headers.get('CDN-Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Cloudflare-CDN-Cache-Control'), 'no-store');
    for (const name of ['ETag', 'Last-Modified', 'Content-Length']) assert.equal(response.headers.get(name), null);
    await response.text();
  }
});

test('non-HTML content keeps its body, status and cache validators', async () => {
  const app = load();
  const response = app.applySecurityHeaders(new Response('image bytes', {
    headers: { 'Content-Type': 'image/jpeg', ETag: '"image"', 'Cache-Control': 'public, max-age=1800' },
  }), request);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'image bytes');
  assert.equal(response.headers.get('ETag'), '"image"');
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=1800');
  assert.doesNotMatch(response.headers.get('Content-Security-Policy'), /nonce-/);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
});

test('redirects and non-HTML 304 responses remain intact', () => {
  const app = load();
  for (const status of [301, 302, 304, 307]) {
    const original = new Response(null, { status, headers: { Location: '/login', ETag: '"asset"' } });
    const result = app.applySecurityHeaders(original, request);
    assert.equal(result, original);
    assert.equal(result.headers.get('Content-Security-Policy'), null);
  }
});

test('an explicit existing CSP is not weakened', async () => {
  const app = load();
  const original = htmlResponse('<p>Locked down document</p>');
  original.headers.set('Content-Security-Policy', "default-src 'none'");
  const result = app.applySecurityHeaders(original, request);
  assert.equal(result.headers.get('Content-Security-Policy'), "default-src 'none'");
  assert.equal(await result.text(), '<p>Locked down document</p>');
});

test('HTML asset reads remove conditional and range headers before the KV cache lookup', async () => {
  const seen = [];
  const app = load(async ({ request: assetRequest }) => {
    seen.push(assetRequest);
    if (assetRequest.headers.has('If-None-Match')) return new Response(null, { status: 304 });
    if (assetRequest.headers.has('Range')) return new Response('partial', { status: 206 });
    return htmlResponse();
  });
  for (const [path, forcePath] of [['/', undefined], ['/index.html', undefined], ['/login', '/login.html'], ['/admin', '/admin.html']]) {
    const original = new Request(`https://nav.example${path}`, {
      headers: { 'If-None-Match': '"old"', 'If-Modified-Since': 'Sun, 08 Nov 2026 00:00:00 GMT', Range: 'bytes=0-9', 'If-Range': '"old"' },
    });
    const response = await app.serveStatic(original, {}, { waitUntil() {} }, forcePath);
    assert.equal(response.status, 200);
    assert.equal(original.headers.get('If-None-Match'), '"old"');
    const assetRequest = seen.at(-1);
    for (const header of ['If-None-Match', 'If-Modified-Since', 'Range', 'If-Range']) assert.equal(assetRequest.headers.get(header), null);
    const secured = app.applySecurityHeaders(response, original);
    assert.match(await secured.text(), /nonce="[a-f0-9]{32}"/);
  }
});

test('HTML root fallback also reads a complete asset while JS keeps conditional caching', async () => {
  const seen = [];
  const app = load(async ({ request: assetRequest }) => {
    seen.push(assetRequest);
    if (new URL(assetRequest.url).pathname === '/') throw new Error('fallback');
    if (assetRequest.headers.has('If-None-Match')) return new Response(null, { status: 304 });
    return htmlResponse();
  });
  const root = new Request('https://nav.example/', { headers: { 'If-None-Match': '"old"' } });
  assert.equal((await app.serveStatic(root, {}, { waitUntil() {} })).status, 200);
  assert.equal(new URL(seen.at(-1).url).pathname, '/index.html');
  assert.equal(seen.at(-1).headers.get('If-None-Match'), null);
  const script = new Request('https://nav.example/home.js', { headers: { 'If-None-Match': '"script"' } });
  assert.equal((await app.serveStatic(script, {}, { waitUntil() {} })).status, 304);
  assert.equal(seen.at(-1).headers.get('If-None-Match'), '"script"');
});
