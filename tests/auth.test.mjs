import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createWorkerHarness, loadWorker } from './helpers/worker-harness.mjs';

const currentAlgorithm = 'pbkdf2-sha256-600k';
const legacyAlgorithm = 'pbkdf2-sha256-100k';
const legacyData = admin => ({ settings: { siteName: 'Legacy site' }, apps: [], bookmarks: [], stats: { visitorCount: 7 }, admin, _version: 0 });
async function credentials(password, iterations, algorithm) {
  const { app } = loadWorker();
  const salt = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
  const admin = { passwordSalt: app.bufferToHex(salt), passwordHash: await app.deriveHashHex(password, salt, iterations) };
  if (algorithm !== undefined) admin.passwordHashAlgo = algorithm;
  return admin;
}

test('initial credentials preserve their algorithm and allow subsequent logins without writing legacy KV', async () => {
  const h = await createWorkerHarness();
  assert.equal((await h.login()).response.status, 200);
  assert.equal((await h.state.storage.get('data')).admin.passwordHashAlgo, currentAlgorithm);
  assert.equal((await h.login()).response.status, 200);
  assert.equal((await h.login('wrong-password')).response.status, 401);
  assert.equal((await h.state.storage.list({ prefix: 'session:' })).size, 2);
  assert.equal(h.kvWrites, 0);
});

for (const [label, iterations, algorithm] of [
  ['unmarked legacy hashes', 100000, undefined],
  ['explicit legacy hashes', 100000, legacyAlgorithm],
  ['unmarked current hashes saved by the old bug', 600000, undefined],
]) {
  test(label + ' verify and migrate only after a successful login', async () => {
    const admin = await credentials('test-saved-password', iterations, algorithm);
    const h = await createWorkerHarness({ legacyData: legacyData(admin) });
    const original = await h.state.storage.get('data');
    assert.equal((await h.login('incorrect-password')).response.status, 401);
    assert.deepEqual(await h.state.storage.get('data'), original);
    assert.equal((await h.login('test-saved-password')).response.status, 200);
    const stored = await h.state.storage.get('data');
    assert.equal(stored.admin.passwordHashAlgo, currentAlgorithm);
    assert.equal(stored.settings.siteName, 'Legacy site');
    assert.equal((await h.login('test-saved-password')).response.status, 200);
    assert.equal(h.kvWrites, 0);
  });
}

test('unknown explicit algorithms and malformed stored hashes fail closed', async () => {
  const { app } = loadWorker();
  const legacy = await credentials('test-saved-password', 100000);
  assert.equal(await app.verifyPassword('test-saved-password', legacy.passwordSalt, legacy.passwordHash, 'unknown'), false);
  assert.equal(await app.verifyPassword('test-saved-password', legacy.passwordSalt, legacy.passwordHash, currentAlgorithm), false);
  for (const [salt, hash] of [[null, legacy.passwordHash], ['xyz', legacy.passwordHash], [legacy.passwordSalt, null], [legacy.passwordSalt, '00']]) {
    assert.equal(await app.verifyPassword('test-saved-password', salt, hash), false);
  }
});

test('changing an unmarked current password saves valid marked credentials and revokes all older sessions', async () => {
  const admin = await credentials('test-old-password', 600000);
  const token = randomUUID();
  const unimportedToken = randomUUID();
  const h = await createWorkerHarness({ legacyData: legacyData(admin), legacySessions: new Map([[token, 'active'], [unimportedToken, 'active']]) });
  const cookie = 'simpage_session=' + token;
  const original = await h.state.storage.get('data');
  assert.equal((await h.request('POST', '/api/admin/password', { currentPassword: 'incorrect-password', newPassword: 'test-new-password' }, { cookie })).status, 401);
  assert.deepEqual(await h.state.storage.get('data'), original);
  const changed = await h.request('POST', '/api/admin/password', { currentPassword: 'test-old-password', newPassword: 'test-new-password' }, { cookie });
  assert.equal(changed.status, 200);
  const newCookie = changed.headers.get('Set-Cookie').split(';')[0];
  assert.equal((await h.state.storage.get('data')).admin.passwordHashAlgo, currentAlgorithm);
  assert.equal((await h.request('GET', '/api/admin/data', undefined, { cookie })).status, 401);
  assert.equal((await h.request('GET', '/api/admin/data', undefined, { cookie: 'simpage_session=' + unimportedToken })).status, 401);
  assert.equal((await h.request('GET', '/api/admin/data', undefined, { cookie: newCookie })).status, 200);
  assert.equal((await h.login('test-new-password')).response.status, 200);
  assert.equal((await h.login('test-old-password')).response.status, 401);
});

test('a delayed login upgrade cannot overwrite a password changed in the meantime', async () => {
  const admin = await credentials('test-old-password', 100000);
  const token = randomUUID();
  const h = await createWorkerHarness({ legacyData: legacyData(admin), legacySessions: new Map([[token, 'active']]) });
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const originalCreate = h.app.createAdminCredentialsFromPassword;
  h.app.createAdminCredentialsFromPassword = async password => {
    if (password === 'test-old-password') { entered(); await gate; }
    return originalCreate(password);
  };
  const lateLogin = h.login('test-old-password');
  await ready;
  const changed = await h.request('POST', '/api/admin/password', { currentPassword: 'test-old-password', newPassword: 'test-new-password' }, { cookie: 'simpage_session=' + token });
  assert.equal(changed.status, 200);
  const stored = await h.state.storage.get('data');
  release();
  assert.equal((await lateLogin).response.status, 409);
  assert.deepEqual(await h.state.storage.get('data'), stored);
  assert.equal((await h.login('test-new-password')).response.status, 200);
});
