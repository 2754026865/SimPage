import assert from 'node:assert/strict';
import { randomUUID, pbkdf2Sync } from 'node:crypto';
import { createLocalWorker, wallpaperPng } from './local-worker.mjs';

const { mf, upstreamCalls } = createLocalWorker();
let ipSequence = 1;
const api = (method, path, body, cookie = '', extraHeaders = {}) => mf.dispatchFetch('https://example.com' + path, {
  method, headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.' + ipSequence++, ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const cookieOf = response => response.headers.get('Set-Cookie')?.split(';')[0] || '';

try {
  const first = await mf.dispatchFetch('https://example.com/');
  assert.equal(first.status, 200);
  const nonce = first.headers.get('Content-Security-Policy').match(/nonce-([a-f0-9]{32})/)[1];
  assert.ok((await first.text()).includes('nonce="' + nonce + '"'));
  assert.equal(first.headers.get('Cache-Control'), 'no-store, must-revalidate');
  const second = await mf.dispatchFetch('https://example.com/', { headers: { 'If-None-Match': '"old-html"', Range: 'bytes=0-8' } });
  assert.equal(second.status, 200);
  assert.ok(!second.headers.get('Content-Security-Policy').includes(nonce));
  assert.ok((await second.text()).includes('</html>'));
  console.log('PASS real HTMLRewriter, per-response nonces and conditional HTML requests');

  const login = await api('POST', '/api/login', { password: 'test-local-runtime-only' });
  assert.equal(login.status, 200, await login.clone().text());
  const session = cookieOf(login);
  await login.arrayBuffer();
  const initial = await api('GET', '/api/admin/data', undefined, session);
  assert.equal(initial.status, 200);
  const before = (await initial.json()).data;
  assert.ok(Number.isSafeInteger(before._version));
  const newId = randomUUID();
  const batch = {
    _version: before._version, requestId: randomUUID(),
    operations: { apps: [{ op: 'upsert', item: { id: newId, name: 'Runtime item', url: 'https://example.com/', description: '', icon: '🧭' } }] },
    settings: { greeting: 'Runtime saved', weather: { city: '北京，青岛 北京' } },
    stats: { siteStartDate: '2026-01-01' },
  };
  const saved = await api('PATCH', '/api/admin/data', batch, session);
  assert.equal(saved.status, 200, await saved.clone().text());
  const after = (await saved.json()).data;
  assert.equal(after.settings.greeting, 'Runtime saved');
  assert.equal(after.apps.filter(item => item.id === newId).length, 1);
  assert.equal(after._version, before._version + 1);
  const repeated = await api('PATCH', '/api/admin/data', batch, session);
  assert.equal(repeated.status, 200);
  const repeatedData = (await repeated.json()).data;
  assert.equal(repeatedData._version, after._version);
  assert.equal(repeatedData.apps.filter(item => item.id === newId).length, 1);
  const competing = await Promise.all(['one', 'two'].map(greeting => api('PATCH', '/api/admin/data', {
    _version: after._version, requestId: randomUUID(), settings: { greeting },
  }, session)));
  assert.deepEqual(competing.map(response => response.status).sort(), [200, 409]);
  await Promise.all(competing.map(response => response.arrayBuffer()));
  console.log('PASS SQLite state initialization, atomic batch save, idempotent retry and concurrent version conflict');

  const change = await api('POST', '/api/admin/password', {
    currentPassword: 'test-local-runtime-only', newPassword: 'test-new-runtime-only',
  }, session);
  assert.equal(change.status, 200, await change.clone().text());
  const rotated = cookieOf(change);
  await change.arrayBuffer();
  assert.ok(rotated && rotated !== session);
  const invalidOld = await api('GET', '/api/admin/data', undefined, session);
  assert.equal(invalidOld.status, 401);
  await invalidOld.arrayBuffer();
  const validCurrent = await api('GET', '/api/admin/data', undefined, rotated);
  assert.equal(validCurrent.status, 200);
  await validCurrent.arrayBuffer();
  for (const [password, expected] of [['test-new-runtime-only', 200], ['test-local-runtime-only', 401]]) {
    const result = await api('POST', '/api/login', { password });
    assert.equal(result.status, expected, await result.clone().text());
    await result.arrayBuffer();
  }
  const logout = await api('POST', '/api/logout', undefined, rotated);
  assert.equal(logout.status, 200);
  await logout.arrayBuffer();
  const revoked = await api('GET', '/api/admin/data', undefined, rotated);
  assert.equal(revoked.status, 401);
  await revoked.arrayBuffer();
  console.log('PASS real Workers password hashing, session rotation, old-session invalidation and immediate logout');

  const attempts = await Promise.all(Array.from({ length: 10 }, () =>
    api('POST', '/api/login', { password: 'incorrect' }, '', { 'CF-Connecting-IP': '198.51.100.12' })));
  assert.equal(attempts.filter(response => response.status === 401).length, 5);
  assert.equal(attempts.filter(response => response.status === 429).length, 5);
  await Promise.all(attempts.map(response => response.arrayBuffer()));
  console.log('PASS real Durable Object pre-validation limit under concurrent login requests');

  for (const path of ['/styles/main.css', '/styles/home.css', '/styles/admin.css', '/styles/login.css', '/images/wallpaper-fallback.svg', '/scripts/lib/shared.js']) {
    const asset = await mf.dispatchFetch('https://example.com' + path);
    assert.equal(asset.status, 200, path);
    await asset.arrayBuffer();
  }
  const wallpapers = await Promise.all([1, 2].map(() => mf.dispatchFetch('https://example.com/api/wallpaper')));
  for (const wallpaper of wallpapers) {
    assert.equal(wallpaper.status, 200);
    assert.deepEqual(Buffer.from(await wallpaper.arrayBuffer()), wallpaperPng);
  }
  const cached = await mf.dispatchFetch('https://example.com/api/wallpaper?ignored=query');
  assert.equal(cached.headers.get('X-Wallpaper-Cache'), 'hit');
  assert.deepEqual(Buffer.from(await cached.arrayBuffer()), wallpaperPng);
  assert.equal(upstreamCalls.filter(path => path === 'https://api.bimg.cc/today').length, 1);
  const weather = await api('GET', '/api/weather');
  assert.equal(weather.status, 200, await weather.clone().text());
  assert.equal((await weather.json()).data.length, 2);
  console.log('PASS split static assets, concurrent wallpaper download, Cache API and normalized multi-city weather');
} finally {
  await mf.dispose();
}

// Verify the upgrade path against a separate local legacy namespace.
const legacy = createLocalWorker();
try {
  const kv = await legacy.mf.getKVNamespace('SIMPAGE_DATA');
  const salt = Buffer.alloc(16, 7);
  const stored = {
    _version: 11, settings: { siteName: 'Preserved legacy site', weatherLocation: '北京 青岛', useWallpaper: false },
    apps: [{ id: randomUUID(), name: 'Existing', url: 'https://example.com', icon: '🧭' }], bookmarks: [],
    stats: { visitorCount: 7, siteStartDate: '2020-01-01' },
    admin: { passwordSalt: salt.toString('hex'), passwordHash: pbkdf2Sync('legacy-runtime-only', salt, 100000, 64, 'sha256').toString('hex') },
  };
  const legacyJson = JSON.stringify(stored);
  await kv.put('data', legacyJson);
  const login = await legacy.mf.dispatchFetch('https://example.com/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.1' },
    body: JSON.stringify({ password: 'legacy-runtime-only' }),
  });
  assert.equal(login.status, 200, await login.clone().text());
  const cookie = cookieOf(login);
  await login.arrayBuffer();
  const result = await legacy.mf.dispatchFetch('https://example.com/api/admin/data', { headers: { Cookie: cookie } });
  assert.equal(result.status, 200);
  const data = (await result.json()).data;
  assert.equal(data.settings.siteName, stored.settings.siteName);
  assert.equal(data.apps[0].id, stored.apps[0].id);
  assert.equal(data.settings.useWallpaper, false);
  assert.equal(await kv.get('data'), legacyJson, 'migration must preserve the original KV snapshot');
  console.log('PASS migration of existing KV data and legacy password without overwriting the original namespace');
} finally {
  await legacy.mf.dispose();
}
