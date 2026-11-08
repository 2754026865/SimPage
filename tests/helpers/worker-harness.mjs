import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { AppStateCore, isSessionToken } from '../../server/state.mjs';
import * as requestHelpers from '../../server/request.mjs';
import * as shared from '../../public/scripts/lib/shared.js';

export function memoryState() {
  let data = new Map();
  let alarm = null;
  let queue = Promise.resolve();
  const storage = {
    async get(key) { return structuredClone(data.get(key)); },
    async put(key, value) { data.set(key, structuredClone(value)); },
    async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key); },
    async deleteAll() { data.clear(); alarm = null; },
    async list({ prefix = '', limit = Infinity } = {}) { return new Map([...data].filter(([key]) => key.startsWith(prefix)).slice(0, limit).map(([key, value]) => [key, structuredClone(value)])); },
    async setAlarm(value) { alarm = value; },
    async getAlarm() { return alarm; },
    async transaction(callback) {
      const run = queue.then(async () => {
        const before = structuredClone(data);
        const beforeAlarm = alarm;
        try { return await callback(storage); }
        catch (error) { data = before; alarm = beforeAlarm; throw error; }
      });
      queue = run.catch(() => {});
      return run;
    },
  };
  return { storage, blockConcurrencyWhile: callback => callback(), snapshot: () => structuredClone(data) };
}

export function loadWorker({ now = () => Date.now() } = {}) {
  const source = readFileSync(new URL('../../worker.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\r?$/gm, '')
    .replace('export default {', 'const workerExport = {')
    .replace(/^export class /gm, 'class ');
  const routes = {};
  const router = Object.fromEntries(['get', 'post', 'put', 'patch', 'all'].map(method => [method, (path, ...handlers) => { routes[`${method.toUpperCase()} ${path}`] = handlers; return router; }]));
  const app = vm.createContext({
    ...requestHelpers, ...shared, AppStateCore, isSessionToken,
    manifest: '{}', Router: () => router,
    getAssetFromKV: async () => new Response('asset'),
    handleGetWallpaper() {}, handleFetchLogo() {}, fetchOpenMeteoWeather() {}, runTasksWithConcurrency() {}, WEATHER_MAX_CONCURRENCY: 3,
    crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer,
    Request, Response, Headers, URL, AbortController, structuredClone,
    Date: class extends Date { static now() { return now(); } },
    setTimeout, clearTimeout, console: { error() {}, warn() {}, log() {} },
  });
  vm.runInContext(`${source}\nglobalThis.AppStateDO = AppStateDO; globalThis.LoginRateLimitDO = LoginRateLimitDO;`, app);
  return { app, routes };
}

export async function createWorkerHarness({ legacyData = null, legacySessions = new Map(), password = 'test-initial-password', now = () => Date.now() } = {}) {
  const { app, routes } = loadWorker({ now });
  const state = memoryState();
  const limiters = new Map();
  let kvWrites = 0;
  const env = {
    ADMIN_PASSWORD: password,
    SIMPAGE_DATA: { get: async () => legacyData ? JSON.stringify(legacyData) : null, put: async () => { kvWrites++; } },
    SESSIONS: { get: async token => legacySessions.get(token), put: async () => { kvWrites++; } },
    LOGIN_RATE_LIMIT: {
      idFromName: name => name,
      get(name) {
        if (!limiters.has(name)) {
          const limiterState = memoryState();
          limiters.set(name, { state: limiterState, object: new app.LoginRateLimitDO(limiterState) });
        }
        return { fetch: (url, init) => limiters.get(name).object.fetch(new Request(url, init)) };
      },
    },
  };
  const stateObject = new app.AppStateDO(state, env);
  stateObject.now = now;
  env.APP_STATE = { idFromName: () => 'global', get: () => ({ fetch: (url, init) => stateObject.fetch(new Request(url, init)) }) };
  await stateObject.ready;
  let sequence = 0;
  const request = async (method, path, body, { cookie = '', ip = `192.0.2.${++sequence}`, headers = {} } = {}) => {
    const req = new Request(`https://example.test${path}`, { method, headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const handlers = routes[`${method} ${path}`];
    if (!handlers) throw new Error(`Unknown test route ${method} ${path}`);
    try {
      for (const handler of handlers) { const result = await handler(req, env, { waitUntil() {} }); if (result) return result; }
    } catch (error) { return Response.json(app.buildErrorResponse(error, env), { status: error.statusCode || 500 }); }
  };
  const login = async (value = password, options) => {
    const response = await request('POST', '/api/login', { password: value }, options);
    return { response, cookie: response.headers.get('Set-Cookie')?.split(';')[0] || '' };
  };
  return { app, env, state, stateObject, limiters, request, login, get kvWrites() { return kvWrites; } };
}
