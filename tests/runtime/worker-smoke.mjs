import assert from 'node:assert/strict';
import { Miniflare, createFetchMock } from 'miniflare';

// Run the built worker in workerd. All upstream traffic and storage are local.
const fetchMock = createFetchMock();
fetchMock.disableNetConnect();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
fetchMock.get('https://api.bimg.cc').intercept({ path: '/today' }).reply(302, '', {
  headers: { Location: 'https://bing.com/test-wallpaper.png' },
});
fetchMock.get('https://bing.com').intercept({ path: '/test-wallpaper.png' }).reply(200, png, {
  headers: { 'Content-Type': 'image/png' },
});

const mf = new Miniflare({
  scriptPath: '.cache/build/worker.js', modules: true,
  compatibilityDate: '2024-03-26',
  kvNamespaces: ['SIMPAGE_DATA', 'SESSIONS'],
  durableObjects: { VISITOR_COUNTER: 'VisitorCounterDO', LOGIN_RATE_LIMIT: 'LoginRateLimitDO' },
  sitePath: 'public', fetchMock,
  bindings: { ADMIN_PASSWORD: 'test-local-runtime-only' },
});

try {
  const first = await mf.dispatchFetch('https://example.com/');
  assert.equal(first.status, 200);
  const nonce = first.headers.get('Content-Security-Policy').match(/nonce-([a-f0-9]{32})/)[1];
  assert.ok((await first.text()).includes(`nonce="${nonce}"`));
  assert.equal(first.headers.get('Cache-Control'), 'no-store, must-revalidate');
  const second = await mf.dispatchFetch('https://example.com/', { headers: { 'If-None-Match': '"old-html"', Range: 'bytes=0-8' } });
  assert.equal(second.status, 200);
  assert.ok(!second.headers.get('Content-Security-Policy').includes(nonce));
  assert.ok((await second.text()).includes('</html>'));
  console.log('PASS real HTMLRewriter, per-response nonces and complete HTML with conditional requests');

  const login = await mf.dispatchFetch('https://example.com/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-local-runtime-only' }),
  });
  assert.equal(login.status, 200, 'Initial password must work in the actual Workers WebCrypto implementation');
  const session = login.headers.get('Set-Cookie').split(';')[0];
  const change = await mf.dispatchFetch('https://example.com/api/admin/password', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: session },
    body: JSON.stringify({ currentPassword: 'test-local-runtime-only', newPassword: 'test-new-runtime-only' }),
  });
  assert.equal(change.status, 200);
  for (const [password, expected] of [['test-new-runtime-only', 200], ['test-local-runtime-only', 401]]) {
    const result = await mf.dispatchFetch('https://example.com/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
    });
    assert.equal(result.status, expected);
    await result.arrayBuffer();
  }
  console.log('PASS Workers password initialization, authenticated password change and subsequent login');

  const fallback = await mf.dispatchFetch('https://example.com/images/wallpaper-fallback.svg');
  assert.equal(fallback.status, 200);
  assert.match(fallback.headers.get('Content-Type'), /image\/svg\+xml/);
  await fallback.arrayBuffer();
  const wallpaper = await mf.dispatchFetch('https://example.com/api/wallpaper');
  assert.equal(wallpaper.status, 200);
  assert.equal(wallpaper.headers.get('X-Wallpaper-Cache'), 'fresh');
  assert.deepEqual(Buffer.from(await wallpaper.arrayBuffer()), png);
  // dispatchFetch awaits waitUntil tasks, so the next request must use the Cache API.
  const cached = await mf.dispatchFetch('https://example.com/api/wallpaper?ignored=query');
  assert.equal(cached.status, 200);
  assert.equal(cached.headers.get('X-Wallpaper-Cache'), 'hit');
  assert.deepEqual(Buffer.from(await cached.arrayBuffer()), png);
  fetchMock.assertNoPendingInterceptors();
  console.log('PASS local fallback asset, bimg redirect proxy and actual Workers Cache API');
} finally {
  await mf.dispose();
  await fetchMock.close();
}
