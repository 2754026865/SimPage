import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AppStateCore, SESSION_TTL_MS } from '../server/state.mjs';
import { AUTH_BODY_LIMIT, DATA_BODY_LIMIT, readBoundedJson } from '../server/request.mjs';
import { createWorkerHarness, memoryState } from './helpers/worker-harness.mjs';

const update = (_version, changes = {}) => ({ _version, requestId: randomUUID(), operations: { apps: [], bookmarks: [] }, ...changes });
const readAdmin = async (h, cookie) => (await (await h.request('GET', '/api/admin/data', undefined, { cookie })).json()).data;
async function authenticated(options) {
  const h = await createWorkerHarness(options);
  const login = await h.login();
  assert.equal(login.response.status, 200);
  return { h, cookie: login.cookie };
}

test('one batch atomically saves all sections, preserves emoji icons and is safe to replay', async () => {
  const { h, cookie } = await authenticated();
  const initial = await readAdmin(h, cookie);
  const id = randomUUID();
  const body = update(initial._version, {
    operations: {
      apps: [{ op: 'upsert', item: { id, name: 'New tool', url: 'example.com/tool', icon: '🎯' } }],
      bookmarks: [{ op: 'delete', id: initial.bookmarks[0].id }],
    },
    settings: { siteName: 'Saved together', siteLogo: '🧭', weather: { city: '北京，青岛 北京' } },
    stats: { siteStartDate: '2026-11-08' },
  });
  const first = await h.request('PATCH', '/api/admin/data', body, { cookie });
  assert.equal(first.status, 200, await first.clone().text());
  const stored = await readAdmin(h, cookie);
  assert.equal(stored._version, initial._version + 1);
  assert.equal(stored.settings.siteName, 'Saved together');
  assert.equal(stored.settings.siteLogo, '🧭');
  assert.equal(stored.settings.weather.city, '北京 青岛');
  assert.equal(stored.apps.find(item => item.id === id).icon, '🎯');
  assert.equal(stored.siteStartDate, '2026-11-08');
  assert.ok(!stored.bookmarks.some(item => item.id === initial.bookmarks[0].id));
  assert.equal((await h.request('PATCH', '/api/admin/data', body, { cookie })).status, 200);
  const replayed = await readAdmin(h, cookie);
  assert.equal(replayed._version, stored._version);
  assert.equal(replayed.apps.filter(item => item.id === id).length, 1);
  assert.equal((await h.request('PATCH', '/api/admin/data', { ...body, settings: { siteName: 'Changed retry' } }, { cookie })).status, 409);
  assert.equal(h.kvWrites, 0);
});

test('two simultaneous saves from the same version cannot both overwrite each other', async () => {
  const { h, cookie } = await authenticated();
  const initial = await readAdmin(h, cookie);
  const changes = [
    update(initial._version, { settings: { siteName: 'First writer' } }),
    update(initial._version, { settings: { greeting: 'Second writer' } }),
  ];
  const responses = await Promise.all(changes.map(body => h.request('PATCH', '/api/admin/data', body, { cookie })));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const first = await readAdmin(h, cookie);
  assert.equal(first._version, initial._version + 1);
  const loser = responses.findIndex(response => response.status === 409);
  const rebased = { ...changes[loser], _version: first._version, requestId: randomUUID() };
  assert.equal((await h.request('PATCH', '/api/admin/data', rebased, { cookie })).status, 200);
  const final = await readAdmin(h, cookie);
  assert.equal(final.settings.siteName, 'First writer');
  assert.equal(final.settings.greeting, 'Second writer');
  assert.equal(final._version, initial._version + 2);
});

test('invalid later sections roll back the whole batch and repeated deletion is harmless', async () => {
  const { h, cookie } = await authenticated();
  const initial = await readAdmin(h, cookie);
  const addedId = randomUUID();
  const invalid = update(initial._version, {
    operations: {
      apps: [{ op: 'upsert', item: { id: addedId, name: 'Must not be added', url: 'https://example.test' } }],
      bookmarks: [{ op: 'patch', id: 'missing-bookmark', changes: { name: 'Missing' } }],
    },
  });
  assert.equal((await h.request('PATCH', '/api/admin/data', invalid, { cookie })).status, 400);
  const after = await readAdmin(h, cookie);
  assert.equal(after._version, initial._version);
  assert.ok(!after.apps.some(item => item.id === addedId));
  const remove = update(after._version, { operations: { apps: [{ op: 'delete', id: 'already-absent' }] } });
  assert.equal((await h.request('PATCH', '/api/admin/data', remove, { cookie })).status, 200);
});

test('malformed and unknown logout tokens create no persistent state; logout immediately invalidates the real session', async () => {
  const { h, cookie } = await authenticated();
  const before = h.state.snapshot();
  for (const token of ['never-issued', randomUUID()]) {
    assert.equal((await h.request('POST', '/api/logout', undefined, { headers: { Authorization: 'Bearer ' + token } })).status, 200);
  }
  assert.deepEqual(h.state.snapshot(), before);
  assert.equal(h.kvWrites, 0);
  const logout = await h.request('POST', '/api/logout', undefined, { cookie });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.equal((await h.request('GET', '/api/admin/data', undefined, { cookie })).status, 401);
  assert.equal((await h.state.storage.list({ prefix: 'session:' })).size, 0);
});

test('a migrated legacy session stays revoked even while the old KV still says active', async () => {
  const seed = await createWorkerHarness();
  const data = await seed.state.storage.get('data');
  const token = randomUUID();
  const h = await createWorkerHarness({ legacyData: data, legacySessions: new Map([[token, 'active']]) });
  const cookie = 'simpage_session=' + token;
  assert.equal((await h.request('GET', '/api/admin/data', undefined, { cookie })).status, 200);
  assert.equal((await h.request('POST', '/api/logout', undefined, { cookie })).status, 200);
  assert.equal((await h.request('GET', '/api/admin/data', undefined, { cookie })).status, 401);
  const tombstone = await h.state.storage.get('session:' + token);
  assert.equal(tombstone.revoked, true);
  assert.equal(h.kvWrites, 0);
});

test('concurrent bad logins reserve only five expensive verifications and stale alarms keep fresh attempts', async () => {
  let now = 1_800_000_000_000;
  const h = await createWorkerHarness({ now: () => now });
  let verifications = 0;
  const actualVerify = h.app.verifyPassword;
  h.app.verifyPassword = async (...args) => { verifications++; return actualVerify(...args); };
  const attempts = await Promise.all(Array.from({ length: 20 }, () => h.login('wrong-password', { ip: '192.0.2.8' })));
  assert.equal(verifications, 5);
  assert.equal(attempts.filter(item => item.response.status === 401).length, 5);
  assert.equal(attempts.filter(item => item.response.status === 429).length, 15);
  assert.ok(attempts.filter(item => item.response.status === 429).every(item => Number(item.response.headers.get('Retry-After')) > 0));
  const limiter = [...h.limiters.entries()].find(([key]) => key.startsWith('ip:'))[1];
  now += 300001;
  assert.equal((await h.login('wrong-password', { ip: '192.0.2.8' })).response.status, 401);
  await limiter.object.alarm();
  assert.equal((await limiter.state.storage.get('attempts')).length, 1);
  now += 300001;
  await limiter.object.alarm();
  assert.equal(limiter.state.snapshot().size, 0);
  assert.equal(await h.state.storage.get('auth-meta').then(meta => meta.legacyLimiterCleaned), true);
  assert.equal(h.limiters.get('global').state.snapshot().size, 0);
});

test('missing or failing login protection fails closed before password verification', async () => {
  const h = await createWorkerHarness();
  h.app.verifyPassword = () => assert.fail('must not verify when limiter is unavailable');
  const binding = h.env.LOGIN_RATE_LIMIT;
  h.env.LOGIN_RATE_LIMIT = undefined;
  assert.equal((await h.login()).response.status, 503);
  h.env.LOGIN_RATE_LIMIT = { ...binding, get() { throw new Error('private limiter detail'); } };
  const failure = await h.login();
  assert.equal(failure.response.status, 503);
  assert.doesNotMatch(await failure.response.text(), /private limiter detail|stack/);
});

test('request and field bounds reject oversized data without changing stored state', async () => {
  const { h, cookie } = await authenticated();
  const initial = await readAdmin(h, cookie);
  assert.equal((await h.request('POST', '/api/login', { password: 'x', padding: 'a'.repeat(AUTH_BODY_LIMIT) })).status, 413);
  assert.equal((await h.request('POST', '/api/login', { password: 'x' }, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  const tooLarge = update(initial._version, { settings: { footer: 'a'.repeat(DATA_BODY_LIMIT) } });
  assert.equal((await h.request('PATCH', '/api/admin/data', tooLarge, { cookie })).status, 413);
  for (const changes of [
    { settings: { siteName: 'x'.repeat(121) } },
    { settings: { weather: { city: '一 二 三 四 五 六 七 八 九' } } },
    { stats: { siteStartDate: '2026-02-30' } },
    { operations: { apps: [{ op: 'upsert', item: { name: 'Bad URL', url: 'javascript:alert(1)' } }] } },
  ]) {
    const response = await h.request('PATCH', '/api/admin/data', update(initial._version, changes), { cookie });
    assert.equal(response.status, 400);
  }
  assert.equal((await readAdmin(h, cookie))._version, initial._version);
  const stored = await h.state.storage.get('data');
  stored.apps = Array.from({ length: 1000 }, (_, index) => ({ id: String(index), name: 'Item', url: 'https://example.test', description: '', icon: '' }));
  await h.state.storage.put('data', stored);
  const overLimit = update(initial._version, { operations: { apps: [{ op: 'upsert', item: { id: 'extra', name: 'One too many', url: 'https://example.test' } }] } });
  assert.equal((await h.request('PATCH', '/api/admin/data', overLimit, { cookie })).status, 400);
  assert.equal((await h.state.storage.get('data')).apps.length, 1000);
});

test('retired split and full-replacement writes reject old clients without changing data', async () => {
  const { h, cookie } = await authenticated();
  const initial = await h.state.storage.get('data');
  for (const [method, path] of [
    ['PUT', '/api/admin/data'], ['PATCH', '/api/admin/apps'],
    ['PATCH', '/api/admin/bookmarks'], ['PATCH', '/api/admin/settings'],
  ]) {
    const response = await h.request(method, path, { _version: initial._version, settings: { siteName: 'Must not write' }, operations: [{ op: 'delete', id: initial.apps[0].id }] }, { cookie });
    assert.equal(response.status, 410);
    assert.match((await response.json()).message, /管理页面已更新.*刷新/);
    assert.equal((await h.request(method, path, {})).status, 401);
  }
  assert.deepEqual(await h.state.storage.get('data'), initial);
});

test('streamed JSON size limits cancel the body without trusting Content-Length', async () => {
  let canceled = false;
  const request = new Request('https://example.test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, duplex: 'half',
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(AUTH_BODY_LIMIT + 1)); }, cancel() { canceled = true; } }),
  });
  await assert.rejects(readBoundedJson(request, AUTH_BODY_LIMIT), error => error.statusCode === 413);
  assert.equal(canceled, true);
});

test('new visitors do not extend the lifetime of a stale configuration snapshot', async () => {
  let now = 1_800_000_000_000;
  const h = await createWorkerHarness({ now: () => now });
  let visitorCount = 0;
  h.env.VISITOR_COUNTER = { idFromName: name => name, get: () => ({ fetch: async url => Response.json({ success: true, count: new URL(url).pathname === '/increment' ? ++visitorCount : visitorCount }) }) };
  const first = await (await h.request('GET', '/api/data')).json();
  const changed = await h.state.storage.get('data');
  changed.settings.siteName = 'Updated elsewhere';
  changed._version++;
  await h.state.storage.put('data', changed);
  now += 4000;
  assert.equal((await (await h.request('GET', '/api/data')).json()).settings.siteName, first.settings.siteName);
  now += 4000;
  assert.equal((await (await h.request('GET', '/api/data')).json()).settings.siteName, 'Updated elsewhere');
  assert.equal(visitorCount, 3);
});

test('a delayed old read cannot overwrite the cache populated by a newer commit', async () => {
  const { h, cookie } = await authenticated();
  const initial = await readAdmin(h, cookie);
  const originalGet = h.env.APP_STATE.get;
  let release, entered, gateNextRead = true;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  h.env.APP_STATE.get = (...args) => {
    const stub = originalGet(...args);
    return { fetch: async (url, init) => {
      const response = await stub.fetch(url, init);
      if (gateNextRead && new URL(url).pathname === '/read') { gateNextRead = false; entered(); await gate; }
      return response;
    } };
  };
  const staleRead = h.app.readFullDataFresh(h.env);
  await ready;
  const save = await h.request('PATCH', '/api/admin/data', update(initial._version, { settings: { siteName: 'New cache' } }), { cookie });
  assert.equal(save.status, 200);
  release();
  assert.equal((await staleRead).settings.siteName, 'New cache');
  assert.equal((await (await h.request('GET', '/api/data')).json()).settings.siteName, 'New cache');
});

test('repeated returning visitors reuse the independent counter cache', async () => {
  const h = await createWorkerHarness();
  let reads = 0;
  h.env.VISITOR_COUNTER = { idFromName: name => name, get: () => ({ fetch: async () => { reads++; return Response.json({ success: true, count: 42 }); } }) };
  for (let index = 0; index < 10; index++) {
    const response = await h.request('GET', '/api/data', undefined, { cookie: 'simpage_visitor=1' });
    assert.equal((await response.json()).visitorCount, 42);
  }
  assert.equal(reads, 1);
});

test('missing bootstrap credentials can be configured later without resetting site data', async () => {
  const h = await createWorkerHarness({ password: '' });
  const stored = await h.state.storage.get('data');
  stored.settings.siteName = 'Keep this site';
  await h.state.storage.put('data', stored);
  h.env.ADMIN_PASSWORD = 'configured-later-password';
  const restarted = new h.app.AppStateDO(h.state, h.env);
  await restarted.ready;
  assert.equal((await h.login('configured-later-password')).response.status, 200);
  assert.equal((await h.state.storage.get('data')).settings.siteName, 'Keep this site');
  assert.equal(h.kvWrites, 0);
});

test('corrupt legacy storage stops migration rather than replacing it with defaults', async () => {
  const state = memoryState();
  const core = new AppStateCore(state, { SIMPAGE_DATA: { get: async () => '{broken' } }, {
    createDefaultData: () => assert.fail('corrupt data must not be overwritten'),
    createCredentials: () => assert.fail('no credentials should be created'),
  });
  await assert.rejects(core.ready, /迁移已停止/);
  assert.equal(state.snapshot().size, 0);
});

test('expired sessions are removed by cleanup and public errors do not leak stack traces', async () => {
  let now = 1_800_000_000_000;
  const { h } = await authenticated({ now: () => now });
  assert.equal((await h.state.storage.list({ prefix: 'session:' })).size, 1);
  now += SESSION_TTL_MS + 1;
  await h.stateObject.alarm();
  assert.equal((await h.state.storage.list({ prefix: 'session:' })).size, 0);
  const payload = h.app.buildErrorResponse(new Error('private diagnostic'), {});
  assert.equal(payload.stack, undefined);
  assert.doesNotMatch(payload.message, /private diagnostic/);
});

test('editing a migrated site keeps its legacy weather field and default icon formats', async () => {
  const seed = await createWorkerHarness();
  const legacy = await seed.state.storage.get('data');
  delete legacy.settings.weather;
  legacy.settings.weatherLocation = '北京，青岛';
  legacy.settings.siteLogo = '🧭';
  const { h, cookie } = await authenticated({ legacyData: legacy });
  const initial = await readAdmin(h, cookie);
  assert.equal((await h.request('PATCH', '/api/admin/data', update(initial._version, { settings: { siteName: 'Renamed legacy site' } }), { cookie })).status, 200);
  const stored = await readAdmin(h, cookie);
  assert.equal(stored.settings.weather.city, '北京 青岛');
  assert.equal(stored.settings.siteLogo, '🧭');
  assert.equal(stored.apps[0].icon, legacy.apps[0].icon);
});

