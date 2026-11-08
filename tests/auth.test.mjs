import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const section = (start, end) => {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `Missing source section: ${start}`);
  return source.slice(startIndex, endIndex);
};
const currentAlgorithm = 'pbkdf2-sha256-600k';
const legacyAlgorithm = 'pbkdf2-sha256-100k';

function harness({ admin = null, beforeCommit = async () => {} } = {}) {
  let stored = { admin, _version: 0 };
  const tasks = [];
  const errors = [];
  const sessions = new Map();
  const env = {
    ADMIN_PASSWORD: 'test-initial-password',
    SESSIONS: { async put(token, value) { sessions.set(token, value); } },
  };
  const app = vm.createContext({
    crypto: webcrypto, TextEncoder, Uint8Array, Request, Response, Headers, URL,
    console: { error(...args) { errors.push(args); } },
    getClientIp: () => 'test-client',
    callLoginRateLimit: async () => ({ locked: false }),
    hasLoginRateLimitBinding: () => false,
    readFullDataFresh: async () => structuredClone(stored),
    writeFullData: async (_env, data) => { stored = structuredClone(data); },
    commitFullData: async (_env, mutator) => {
      await beforeCommit();
      const next = await mutator(structuredClone(stored));
      stored = structuredClone({ ...next, _version: stored._version + 1 });
      return stored;
    },
    jsonFailure: (message, status) => Response.json({ ok: false, message }, { status }),
    jsonSuccess: (payload = {}) => Response.json({ ok: true, ...payload }),
  });
  vm.runInContext([
    section('const SESSION_TTL_SECONDS', 'const ICON_LINK_API_URL'),
    section('async function handleLogin(', 'async function handleGetData('),
    section('async function handlePasswordUpdate(', 'function calculateRunningDays('),
    section('function resolveBootstrapPassword(', '// Weather API Fetcher'),
    section('function buildSessionCookie(', 'function buildClearSessionCookie('),
    source.slice(source.indexOf('function bufferToHex(')),
  ].join('\n'), app);
  const request = (path, body) => new Request(`https://example.com${path}`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  });
  return {
    app, errors, sessions, tasks,
    get stored() { return stored; },
    setAdmin(value) { stored = { ...stored, admin: structuredClone(value) }; },
    login(password) {
      return app.handleLogin(request('/api/login', { password }), env, {
        waitUntil(task) { tasks.push(task); },
      });
    },
    changePassword(currentPassword, newPassword) {
      return app.handlePasswordUpdate(request('/api/admin/password', { currentPassword, newPassword }), env);
    },
  };
}

async function credentials(app, password, iterations, algorithm) {
  const salt = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
  const result = {
    passwordSalt: app.bufferToHex(salt),
    passwordHash: await app.deriveHashHex(password, salt, iterations),
  };
  if (algorithm !== undefined) result.passwordHashAlgo = algorithm;
  return result;
}

test('initial credentials preserve their algorithm and allow subsequent logins', async () => {
  const h = harness();
  assert.equal((await h.login('test-initial-password')).status, 200);
  assert.equal(h.stored.admin.passwordHashAlgo, currentAlgorithm);
  assert.equal((await h.login('test-initial-password')).status, 200);
  assert.equal((await h.login('wrong-password')).status, 401);
  assert.equal(h.sessions.size, 2);
  assert.equal(h.tasks.length, 0);
});

for (const [label, iterations, algorithm] of [
  ['unmarked legacy hashes', 100000, undefined],
  ['explicit legacy hashes', 100000, legacyAlgorithm],
  ['unmarked current hashes saved by the old bug', 600000, undefined],
]) {
  test(`${label} verify and migrate only after a successful login`, async () => {
    const h = harness();
    h.setAdmin(await credentials(h.app, 'test-saved-password', iterations, algorithm));
    const original = structuredClone(h.stored);
    assert.equal((await h.login('incorrect-password')).status, 401);
    assert.deepEqual(h.stored, original);
    assert.equal(h.tasks.length, 0);
    assert.equal((await h.login('test-saved-password')).status, 200);
    await Promise.all(h.tasks);
    assert.equal(h.stored.admin.passwordHashAlgo, currentAlgorithm);
    assert.equal((await h.login('test-saved-password')).status, 200);
    assert.equal(h.errors.length, 0);
  });
}

test('unknown explicit algorithms and malformed stored hashes fail closed', async () => {
  const h = harness();
  const legacy = await credentials(h.app, 'test-saved-password', 100000);
  assert.equal(await h.app.verifyPassword('test-saved-password', legacy.passwordSalt, legacy.passwordHash, 'unknown'), false);
  assert.equal(await h.app.verifyPassword('test-saved-password', legacy.passwordSalt, legacy.passwordHash, currentAlgorithm), false);
  for (const [salt, hash] of [[null, legacy.passwordHash], ['xyz', legacy.passwordHash], [legacy.passwordSalt, null], [legacy.passwordSalt, '00']]) {
    assert.equal(await h.app.verifyPassword('test-saved-password', salt, hash), false);
  }
});

test('changing an unmarked current password saves valid marked credentials', async () => {
  const h = harness();
  h.setAdmin(await credentials(h.app, 'test-old-password', 600000));
  const original = structuredClone(h.stored);
  assert.equal((await h.changePassword('incorrect-password', 'test-new-password')).status, 401);
  assert.deepEqual(h.stored, original);
  assert.equal((await h.changePassword('test-old-password', 'test-new-password')).status, 200);
  assert.equal(h.stored.admin.passwordHashAlgo, currentAlgorithm);
  assert.equal((await h.login('test-new-password')).status, 200);
  assert.equal((await h.login('test-old-password')).status, 401);
});

test('a delayed login upgrade cannot overwrite a password changed in the meantime', async () => {
  let releaseUpgrade;
  let markUpgradeReady;
  const upgradeGate = new Promise(resolve => { releaseUpgrade = resolve; });
  const upgradeReady = new Promise(resolve => { markUpgradeReady = resolve; });
  let delayFirstCommit = true;
  const h = harness({
    async beforeCommit() {
      if (delayFirstCommit) {
        delayFirstCommit = false;
        markUpgradeReady();
        await upgradeGate;
      }
    },
  });
  h.setAdmin(await credentials(h.app, 'test-old-password', 100000));
  assert.equal((await h.login('test-old-password')).status, 200);
  await upgradeReady;
  assert.equal((await h.changePassword('test-old-password', 'test-new-password')).status, 200);
  const changed = structuredClone(h.stored);
  releaseUpgrade();
  await Promise.all(h.tasks);
  assert.deepEqual(h.stored, changed);
  assert.equal((await h.login('test-new-password')).status, 200);
  assert.equal((await h.login('test-old-password')).status, 401);
  assert.equal(h.errors.length, 0);
});
