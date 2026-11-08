const DATA_KEY = 'data';
const META_KEY = 'auth-meta';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_LIMIT = 256;
const RECEIPT_LIMIT = 128;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const LEGACY_DATA_LIMIT = 1536 * 1024;
export const isSessionToken = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const failure = (message, statusCode) => Object.assign(new Error(message), { statusCode });
const sameCredentials = (left, right) => Boolean(left && right && left.passwordHash === right.passwordHash && left.passwordSalt === right.passwordSalt && left.passwordHashAlgo === right.passwordHashAlgo);

// All authoritative data and session operations run in this one object. The
// explicit queue also covers network awaits during the one-time KV migration.
export class AppStateCore {
  constructor(state, env, { createDefaultData, createCredentials, now = () => Date.now() }) {
    this.state = state;
    this.env = env;
    this.now = now;
    this.queue = Promise.resolve();
    this.ready = state.blockConcurrencyWhile(async () => {
      const persisted = await state.storage.get(DATA_KEY);
      if (persisted) {
        // A site may have been opened before its bootstrap secret was set.
        // Repair only absent credentials, never overwrite an existing password.
        const password = typeof env.ADMIN_PASSWORD === 'string' ? env.ADMIN_PASSWORD.trim() : '';
        if ((!persisted.admin?.passwordHash || !persisted.admin?.passwordSalt) && password) {
          persisted.admin = await createCredentials(password);
          persisted._version += 1;
          await state.storage.transaction(async tx => {
            const meta = await tx.get(META_KEY);
            await tx.put(DATA_KEY, persisted);
            await tx.put(META_KEY, { epoch: (meta?.epoch || 0) + 1, legacyUntil: 0 });
          });
        }
        await this.retireLegacyRateLimit();
        return;
      }
      const raw = await env.SIMPAGE_DATA.get(DATA_KEY);
      let data;
      let migrateSessions = false;
      if (raw) {
        if (new TextEncoder().encode(raw).byteLength > LEGACY_DATA_LIMIT) throw failure('原有站点数据超出迁移大小限制，已保留原 KV 数据，请先导出并精简。', 503);
        try { data = JSON.parse(raw); } catch { throw failure('原有站点数据无法解析，迁移已停止。', 503); }
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure('原有站点数据格式不正确，迁移已停止。', 503);
        migrateSessions = Boolean(data.admin?.passwordHash && data.admin?.passwordSalt);
        if (!data.admin?.passwordHash || !data.admin?.passwordSalt) {
          const password = typeof env.ADMIN_PASSWORD === 'string' ? env.ADMIN_PASSWORD.trim() : '';
          if (password) data.admin = await createCredentials(password);
        }
      } else {
        data = await createDefaultData(env);
      }
      data._version = Number.isSafeInteger(data._version) && data._version >= 0 ? data._version : 0;
      await state.storage.transaction(async tx => {
        await tx.put(DATA_KEY, data);
        await tx.put(META_KEY, { epoch: 0, legacyUntil: migrateSessions ? this.now() + SESSION_TTL_MS : 0 });
      });
      await state.storage.setAlarm(this.now() + CLEANUP_INTERVAL_MS);
      await this.retireLegacyRateLimit();
    });
  }

  async retireLegacyRateLimit() {
    const binding = this.env.LOGIN_RATE_LIMIT;
    if (!binding || typeof binding.idFromName !== 'function') return;
    const meta = await this.state.storage.get(META_KEY);
    if (meta?.legacyLimiterCleaned) return;
    try {
      const legacy = binding.get(binding.idFromName('global'));
      const response = await legacy.fetch('https://login-rate-limit/retire', { method: 'POST' });
      if (!response.ok) throw new Error('Legacy limiter cleanup rejected');
      await this.state.storage.put(META_KEY, { ...meta, legacyLimiterCleaned: true });
    } catch {
      // Retry on the next object startup; optional housekeeping cannot block login.
      console.warn('Legacy login limiter cleanup deferred');
    }
  }

  async fetch(request) {
    const run = this.queue.then(async () => {
      await this.ready;
      if (request.method !== 'POST') throw failure('Method not allowed', 405);
      const body = await request.json();
      return this.dispatch(new URL(request.url).pathname, body);
    });
    this.queue = run.catch(() => {});
    try { return Response.json({ success: true, data: await run }); }
    catch (error) {
      const status = error.statusCode || 503;
      if (!error.statusCode) console.error('Application state operation failed:', error);
      return Response.json({ success: false, message: error.statusCode ? error.message : '数据服务暂时不可用。' }, { status });
    }
  }

  async dispatch(path, body) {
    if (path === '/read') return this.state.storage.get(DATA_KEY);
    if (path === '/session/resolve') return { isValid: Boolean(await this.resolveSession(body.token)) };
    if (path === '/session/revoke') {
      const session = await this.resolveSession(body.token);
      if (session) {
        const meta = await this.state.storage.get(META_KEY);
        if (session.legacy && meta.legacyUntil > this.now()) {
          await this.state.storage.put(`session:${body.token}`, { revoked: true, expiresAt: meta.legacyUntil });
        } else {
          await this.state.storage.delete(`session:${body.token}`);
        }
        await this.scheduleCleanup();
      }
      return { revoked: Boolean(session) };
    }
    if (path === '/session/create') return this.createSession(body);
    if (path === '/commit') return this.commit(body);
    throw failure('Unknown state operation', 404);
  }

  async resolveSession(token) {
    if (!isSessionToken(token)) return null;
    const now = this.now();
    const meta = await this.state.storage.get(META_KEY);
    const key = `session:${token}`;
    const stored = await this.state.storage.get(key);
    if (stored) return !stored.revoked && stored.epoch === meta.epoch && stored.expiresAt > now ? stored : null;
    // A password change permanently closes this gate. Revocation tombstones
    // outlive the migration window, so a stale KV value cannot revive a token.
    if (meta.epoch !== 0 || now >= meta.legacyUntil || !this.env.SESSIONS) return null;
    if (await this.env.SESSIONS.get(token) !== 'active') return null;
    await this.ensureSessionCapacity();
    const migrated = { epoch: 0, expiresAt: meta.legacyUntil, legacy: true };
    await this.state.storage.put(key, migrated);
    await this.scheduleCleanup();
    return migrated;
  }

  async ensureSessionCapacity() {
    await this.cleanup();
    const sessions = await this.state.storage.list({ prefix: 'session:', limit: SESSION_LIMIT });
    if (sessions.size >= SESSION_LIMIT) throw failure('登录会话数量已达上限，请退出不再使用的设备后重试。', 429);
  }

  async createSession(body) {
    if (!isSessionToken(body.token)) throw failure('Invalid session token', 400);
    await this.ensureSessionCapacity();
    const data = await this.state.storage.get(DATA_KEY);
    if (!sameCredentials(data.admin, body.verifiedAdmin)) throw failure('密码已发生变化，请使用当前密码重新登录。', 409);
    const meta = await this.state.storage.get(META_KEY);
    await this.state.storage.transaction(async tx => {
      if (body.upgradedAdmin) {
        data.admin = body.upgradedAdmin;
        data._version += 1;
        await tx.put(DATA_KEY, data);
      }
      await tx.put(`session:${body.token}`, { epoch: meta.epoch, expiresAt: this.now() + SESSION_TTL_MS });
    });
    await this.scheduleCleanup();
    return { _version: data._version };
  }

  async commit(body) {
    if (!await this.resolveSession(body.token)) throw failure('登录状态已失效，请重新登录。', 401);
    const current = await this.state.storage.get(DATA_KEY);
    if (body.requestId) {
      const receipt = await this.state.storage.get(`receipt:${body.requestId}`);
      if (receipt) {
        if (receipt.digest !== body.digest) throw failure('同一请求编号不能用于不同的修改。', 409);
        return current;
      }
    }
    if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion !== current._version) throw failure('数据已被其他会话修改，请刷新后合并你的修改。', 409);
    const next = body.data;
    if (!next || typeof next !== 'object' || Array.isArray(next)) throw failure('无效的数据。', 400);
    if (!body.rotateToken && !sameCredentials(next.admin, current.admin)) throw failure('密码修改必须同时更新会话。', 400);
    next._version = current._version + 1;
    const meta = await this.state.storage.get(META_KEY);
    if (body.rotateToken && !isSessionToken(body.rotateToken)) throw failure('Invalid session token', 400);
    await this.state.storage.transaction(async tx => {
      await tx.put(DATA_KEY, next);
      if (body.rotateToken) {
        meta.epoch += 1;
        meta.legacyUntil = 0;
        await tx.put(META_KEY, meta);
        await tx.put(`session:${body.rotateToken}`, { epoch: meta.epoch, expiresAt: this.now() + SESSION_TTL_MS });
      }
      if (body.requestId) await tx.put(`receipt:${body.requestId}`, { digest: body.digest, createdAt: this.now() });
    });
    await this.trimReceipts();
    await this.scheduleCleanup();
    return next;
  }

  async trimReceipts() {
    const rows = await this.state.storage.list({ prefix: 'receipt:' });
    const expired = [...rows].sort((a, b) => b[1].createdAt - a[1].createdAt).slice(RECEIPT_LIMIT);
    if (expired.length) await this.state.storage.delete(expired.map(([key]) => key));
  }

  async cleanup() {
    const meta = await this.state.storage.get(META_KEY);
    if (!meta) return;
    const rows = await this.state.storage.list({ prefix: 'session:' });
    const now = this.now();
    const expired = [...rows].filter(([, value]) => value.expiresAt <= now || (!value.revoked && value.epoch !== meta.epoch)).map(([key]) => key);
    if (expired.length) await this.state.storage.delete(expired);
  }

  async scheduleCleanup() {
    if (!await this.state.storage.getAlarm()) await this.state.storage.setAlarm(this.now() + CLEANUP_INTERVAL_MS);
  }

  async alarm() {
    const run = this.queue.then(async () => {
      await this.ready;
      await this.cleanup();
      const rows = await this.state.storage.list({ prefix: 'session:', limit: 1 });
      if (rows.size) await this.state.storage.setAlarm(this.now() + CLEANUP_INTERVAL_MS);
    });
    this.queue = run.catch(() => {});
    return run;
  }
}
