import { getAssetFromKV } from "@cloudflare/kv-asset-handler";
import { Router } from "itty-router";
import manifest from "__STATIC_CONTENT_MANIFEST";
import { handleGetWallpaper, handleFetchLogo, fetchOpenMeteoWeather, runTasksWithConcurrency, WEATHER_MAX_CONCURRENCY } from "./server/upstream.mjs";
import { AppStateCore, isSessionToken } from "./server/state.mjs";
import { readBoundedJson, AUTH_BODY_LIMIT, DATA_BODY_LIMIT, MAX_COLLECTION_ITEMS, inputError, limitedText, checkedUrl, checkedIcon, requiredVersion } from "./server/request.mjs";
import { DEFAULT_SETTINGS, WEATHER_MAX_CITIES, parseWeatherCities, normaliseFooterValue, normaliseVisualSettings, normaliseItemFields } from "./public/scripts/lib/shared.js";

const assetManifest = JSON.parse(manifest);
const router = Router();


// =================================================================================
// Constants and Defaults
// =================================================================================

const BASE_DEFAULT_SETTINGS = DEFAULT_SETTINGS;

const DEFAULT_STATS = Object.freeze({
  visitorCount: 0,
  siteStartDate: null, // 🆕 添加
});

const DEFAULT_WEATHER_CONFIG = Object.freeze({
  city: "北京",
});

const DEFAULT_INITIAL_FOOTER = "欢迎来到我的主页";
const DEFAULT_INITIAL_WEATHER_CITIES = Object.freeze(["北京", "青岛"]);
const FULL_DATA_CACHE_TTL_MS = 5000;
const VISITOR_COUNTER_DO_NAME = "global";
const VISITOR_COUNTER_STORAGE_KEY = "count";

const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 hours in seconds
const AUTH_HEADER_PREFIX = "Bearer ";
const SESSION_COOKIE_NAME = "simpage_session";
const VISITOR_COOKIE_NAME = "simpage_visitor";
const VISITOR_COOKIE_MAX_AGE = 60 * 60; // 1 hour
const COOKIE_PATH = "/";
const COOKIE_MAX_AGE = SESSION_TTL_SECONDS;
const MAX_PASSWORD_LENGTH = 256;
const LOGIN_FAIL_THRESHOLD = 5;
const LOGIN_LOCK_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const PBKDF2_ITERATIONS_LEGACY = 100000;
const PBKDF2_ITERATIONS_CURRENT = 600000;
const PBKDF2_ALGO_LEGACY = "pbkdf2-sha256-100k";
const PBKDF2_ALGO_CURRENT = "pbkdf2-sha256-600k";

// =================================================================================
// API Routes
// =================================================================================

router.post("/api/login", handleLogin);
router.get("/api/data", handleGetData);
router.get("/api/weather", handleGetWeather);
router.get("/api/wallpaper", handleGetWallpaper);
router.get("/api/admin/data", requireAuth, handleGetAdminData);
router.put("/api/admin/data", requireAuth, handleRetiredAdminWrite);
router.patch("/api/admin/data", requireAuth, handleBatchDataUpdate);
router.patch("/api/admin/apps", requireAuth, handleRetiredAdminWrite);
router.patch("/api/admin/bookmarks", requireAuth, handleRetiredAdminWrite);
router.patch("/api/admin/settings", requireAuth, handleRetiredAdminWrite);
router.post("/api/admin/password", requireAuth, handlePasswordUpdate);
router.get("/api/fetch-logo", requireAuth, handleFetchLogo);
router.post("/api/logout", handleLogout);

// =================================================================================
// Static Asset and Fallback Routes
// =================================================================================

// 登录页面路由
router.get("/login", async (request, env, ctx) => {
  const response = await serveStatic(request, env, ctx, "/login.html");
  return withNoStore(response);
});
router.get("/login/", (request) => redirectWithBase(request, "/login", 301));
router.get("/login.html", (request) => redirectWithBase(request, "/login", 301));

// 后台管理页面 - 需要验证 token
router.get("/admin", handleAdminPage);
router.get("/admin/", (request) => redirectWithBase(request, "/admin", 301));
router.get("/admin.html", (request) => redirectWithBase(request, "/admin", 301));

// Fallback for all other GET requests to serve static assets or index.html
router.get("*", (request, env, ctx) => serveStatic(request, env, ctx));

// 404 for all other methods
router.all("*", () => new Response("Not Found", { status: 404 }));

// =================================================================================
// Main Fetch Handler
// =================================================================================

const SECURITY_CSP = [
  "default-src 'self'",
  "script-src 'self' https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https://fonts.font.im",
  "img-src 'self' data: https:",
  "font-src 'self' https://fonts.font.im data:",
  "connect-src 'self' https://v1.hitokoto.cn https://geocoding-api.open-meteo.com https://api.open-meteo.com https://cloudflareinsights.com",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

function applySecurityHeaders(response, request) {
  if (!response) return response;
  // 重定向(3xx)与 304 不附加 CSP,避免破坏头部不可变性
  const status = response.status;
  if (status >= 300 && status < 400) {
    return response;
  }
  const headers = new Headers(response.headers);
  if (!headers.has("X-Content-Type-Options")) {
    headers.set("X-Content-Type-Options", "nosniff");
  }
  if (!headers.has("Referrer-Policy")) {
    headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  }
  if (!headers.has("Permissions-Policy")) {
    headers.set("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  }
  const isHtml = /^text\/html(?:;|$)/i.test(headers.get("Content-Type") || "");
  let nonce = "";
  if (!headers.has("Content-Security-Policy")) {
    if (isHtml) {
      nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    headers.set("Content-Security-Policy", nonce
      ? SECURITY_CSP.replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`)
      : SECURITY_CSP);
  }
  if (isHtml) {
    // Cache the raw KV asset, never the HTML carrying a per-response nonce.
    headers.set("Cache-Control", "no-store, must-revalidate");
    headers.set("CDN-Cache-Control", "no-store");
    headers.set("Cloudflare-CDN-Cache-Control", "no-store");
    headers.delete("ETag");
    headers.delete("Last-Modified");
    headers.delete("Content-Length");
  }
  const secured = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  if (!nonce) return secured;

  const origin = new URL(request.url).origin;
  // Cloudflare reads the nonce from the response CSP for its injected scripts.
  // Only mark our existing same-origin scripts, not arbitrary inline/external code.
  return new HTMLRewriter().on("script[src]", {
    element(element) {
      try {
        const scriptUrl = new URL(element.getAttribute("src"), request.url);
        if ((scriptUrl.protocol === "https:" || scriptUrl.protocol === "http:") && scriptUrl.origin === origin) {
          element.setAttribute("nonce", nonce);
        }
      } catch (_error) {
        // Invalid script URLs remain subject to the regular CSP restrictions.
      }
    },
  }).transform(secured);
}

export default {
  async fetch(request, env, ctx) {
    try {
      const response = await router.handle(request, env, ctx);
      return applySecurityHeaders(response, request);
    } catch (error) {
      console.error("Unhandled error:", error);
      const errorResponse = buildErrorResponse(error, env);
      return applySecurityHeaders(
        new Response(JSON.stringify(errorResponse, null, 2), {
          status: error?.statusCode || 500,
          headers: { "Content-Type": "application/json;charset=UTF-8" },
        }),
        request
      );
    }
  },
};

export class VisitorCounterDO {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const seed = toSafeNonNegativeInteger(url.searchParams.get("seed"), 0);

    if (url.pathname === "/increment") {
      const count = await this.increment(seed);
      return jsonSuccess({ count });
    }

    if (url.pathname === "/get") {
      const count = await this.get(seed);
      return jsonSuccess({ count });
    }

    return new Response("Not Found", { status: 404 });
  }

  async increment(seed) {
    return this.state.storage.transaction(async (tx) => {
      const stored = await tx.get(VISITOR_COUNTER_STORAGE_KEY);
      const base = toSafeNonNegativeInteger(stored, seed);
      const next = base + 1;
      await tx.put(VISITOR_COUNTER_STORAGE_KEY, next);
      return next;
    });
  }

  async get(seed) {
    const stored = await this.state.storage.get(VISITOR_COUNTER_STORAGE_KEY);
    if (typeof stored === "number" && Number.isFinite(stored) && stored >= 0) {
      return Math.floor(stored);
    }
    if (seed > 0) {
      await this.state.storage.put(VISITOR_COUNTER_STORAGE_KEY, seed);
      return seed;
    }
    return 0;
  }
}

export class LoginRateLimitDO {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();
    if (url.pathname === "/retire" && request.method === "POST") {
      // Only the old global instance is called here by the state migration.
      await this.state.storage.deleteAll();
      return jsonSuccess();
    }
    if (url.pathname === "/reserve") {
      const result = await this.state.storage.transaction(async tx => {
        const previous = await tx.get("attempts") || [];
        const attempts = previous.filter(time => time > now - LOGIN_LOCK_DURATION_MS);
        if (attempts.length >= LOGIN_FAIL_THRESHOLD) return { locked: true, retryAfterMs: attempts[0] + LOGIN_LOCK_DURATION_MS - now };
        attempts.push(now);
        await tx.put("attempts", attempts);
        await tx.setAlarm(attempts.at(-1) + LOGIN_LOCK_DURATION_MS);
        return { locked: false, retryAfterMs: 0 };
      });
      return jsonSuccess(result);
    }
    return new Response("Not Found", { status: 404 });
  }

  async alarm() {
    // A delayed alarm must not erase attempts accepted after it was scheduled.
    await this.state.storage.transaction(async tx => {
      const attempts = ((await tx.get("attempts")) || []).filter(time => time > Date.now() - LOGIN_LOCK_DURATION_MS);
      if (attempts.length) {
        await tx.put("attempts", attempts);
        await tx.setAlarm(attempts.at(-1) + LOGIN_LOCK_DURATION_MS);
      } else {
        await tx.delete("attempts");
      }
    });
  }
}

export class AppStateDO extends AppStateCore {
  constructor(state, env) {
    super(state, env, { createDefaultData, createCredentials: createAdminCredentialsFromPassword });
  }
}

// =================================================================================
// Static Asset Handler
// =================================================================================

async function serveStatic(request, env, ctx, forcePath) {
  const url = new URL(request.url);
  // Use a forced path for routes like /admin
  if (forcePath) {
    url.pathname = forcePath;
    request = new Request(url.toString(), request);
  }

  // A 304/206 would reuse an old HTML body with a different response nonce.
  // Request the complete raw asset while retaining the KV asset cache itself.
  const lastSegment = url.pathname.split("/").pop() || "";
  const isHtmlRequest = !lastSegment.includes(".") || /\.html?$/i.test(lastSegment);
  if (isHtmlRequest) {
    const headers = new Headers(request.headers);
    for (const name of ["If-None-Match", "If-Modified-Since", "Range", "If-Range"]) {
      headers.delete(name);
    }
    request = new Request(request, { headers });
  }

  try {
    const asset = await getAssetFromKV(
      {
        request,
        waitUntil: (promise) => ctx.waitUntil(promise),
      },
      {
        ASSET_NAMESPACE: env.__STATIC_CONTENT,
        ASSET_MANIFEST: assetManifest,
      }
    );
    return asset;
  } catch (e) {
    const currentUrl = new URL(request.url);
    const isRoot = currentUrl.pathname === "/";

    if (isRoot) {
      try {
        const notFoundRequest = new Request(new URL("/index.html", request.url), request);
        return await getAssetFromKV(
          {
            request: notFoundRequest,
            waitUntil: (promise) => ctx.waitUntil(promise),
          },
          {
            ASSET_NAMESPACE: env.__STATIC_CONTENT,
            ASSET_MANIFEST: assetManifest,
          }
        );
      } catch (e2) {
        return new Response("Not Found", { status: 404 });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
}


// =================================================================================
// API Handlers
// =================================================================================

/**
 * 处理后台管理页面访问
 * 验证 token 是否有效，未登录则重定向到登录页面
 */
async function handleAdminPage(request, env, ctx) {
  const session = await resolveSession(request, env);
  if (!session.isValid) {
    return redirectWithBase(request, "/login", 302);
  }
  const response = await serveStatic(request, env, ctx, "/admin.html");
  return withNoStore(response);
}

function withNoStore(response) {
  if (!response) return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store, must-revalidate");
  headers.set("Pragma", "no-cache");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function redirectWithBase(request, pathname, status = 302) {
  const target = new URL(pathname, request.url).toString();
  return Response.redirect(target, status);
}



async function handleLogin(request, env, ctx) {
  const body = await readBoundedJson(request, AUTH_BODY_LIMIT);
  const password = typeof body?.password === "string" ? body.password : "";
  if (!password) {
    return jsonFailure("请输入密码。", 400);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return jsonFailure("密码长度超出限制。", 400);
  }

  const clientIp = getClientIp(request);
  const lockState = await callLoginRateLimit(env, "/reserve", clientIp);
  if (lockState.locked) {
    const retryAfterSec = Math.max(1, Math.ceil(lockState.retryAfterMs / 1000));
    const response = jsonFailure("尝试次数过多,请稍后再试。", 429);
    response.headers.set("Retry-After", String(retryAfterSec));
    return response;
  }

  const fullData = await readFullDataFresh(env);
  const admin = fullData.admin;

  if (!admin || !admin.passwordSalt || !admin.passwordHash) {
    return jsonFailure("后台初始密码未配置。", 503);
  }

  const isMatch = await verifyPassword(
    password,
    admin.passwordSalt,
    admin.passwordHash,
    admin.passwordHashAlgo
  );
  if (!isMatch) {
    return jsonFailure("密码错误。", 401);
  }

  const token = generateToken();
  const upgradedAdmin = admin.passwordHashAlgo !== PBKDF2_ALGO_CURRENT
    ? await createAdminCredentialsFromPassword(password) : null;
  await callAppState(env, "/session/create", { token, verifiedAdmin: admin, upgradedAdmin });
  fullDataCache = null;

  const response = jsonSuccess();
  response.headers.set("Set-Cookie", buildSessionCookie(token));
  return response;
}

async function handleGetData(request, env, ctx) {
  try {
    const cookies = parseCookies(request);
    const isReturningVisitor = Boolean(cookies[VISITOR_COOKIE_NAME]);

    let data;
    if (isReturningVisitor) {
      // 1 小时内同一浏览器只读不增,避免刷新刷量
      const fullData = await readFullData(env);
      data = sanitiseData(fullData);
      data.visitorCount = await getPersistedVisitorCount(
        env,
        fullData.stats?.visitorCount || DEFAULT_STATS.visitorCount
      );
    } else {
      data = await incrementVisitorCountAndReadData(env, ctx);
    }

    const response = jsonResponse(data);
    if (!isReturningVisitor) {
      response.headers.set("Set-Cookie", buildVisitorCookie());
    }
    return response;
  } catch (error) {
    console.error("Error in handleGetData:", error);
    return jsonResponse(buildErrorResponse(error, env, "Error fetching data"), 500);
  }
}
async function handleGetWeather(request, env, ctx) {
  try {
    const fullData = await readFullData(env);
    const weatherSettings = normaliseWeatherSettingsValue(
      fullData.settings?.weather ?? fullData.settings?.weatherLocation
    );
    let cities = weatherSettings.city;
    if (!Array.isArray(cities) || cities.length === 0) {
      cities = [DEFAULT_WEATHER_CONFIG.city];
    }
    cities = cities.slice(0, WEATHER_MAX_CITIES);

    const weatherTasks = cities.map((city) => async () =>
      fetchOpenMeteoWeather(city, ctx)
        .then(weather => ({ ...weather, city, success: true }))
        .catch(error => {
          console.error(`获取城市 ${city} 的天气信息失败：`, error);
          return { city, success: false, message: error.message };
        })
    );

    const results = await runTasksWithConcurrency(weatherTasks, WEATHER_MAX_CONCURRENCY);
    const successfulWeatherData = results.filter(r => r.success);

    if (successfulWeatherData.length === 0 && results.length > 0) {
      const firstError = results.find(r => !r.success);
      const errorMessage = firstError?.message || "无法获取任何城市的天气信息。";
      return jsonFailure(errorMessage, 502);
    }

    return jsonSuccess({ data: successfulWeatherData });
  } catch (error) {
    const statusCode = error.statusCode || 502;
    return jsonFailure(error?.message || "天气数据请求失败。", statusCode);
  }
}

async function handleGetAdminData(request, env) {
  const fullData = await readFullDataFresh(env);
  const data = sanitiseData(fullData);
  data.visitorCount = await getPersistedVisitorCount(env, data.visitorCount);
  const weather = normaliseWeatherSettingsValue(
    fullData.settings?.weather ?? fullData.settings?.weatherLocation
  );
  const cityString = Array.isArray(weather.city) ? weather.city.join(" ") : weather.city;
  data.settings.weather = { city: cityString };
  return jsonSuccess({ data });
}

function handleRetiredAdminWrite() {
  return jsonFailure("管理页面已更新，请刷新后重试。", 410);
}

async function handleBatchDataUpdate(request, env) {
  try {
    const body = await readJsonBody(request);
    const expectedVersion = requiredVersion(body);
    if (!isSessionToken(body.requestId)) throw inputError("缺少有效的请求编号。");
    const operations = body.operations ?? {};
    if (!operations || typeof operations !== "object" || Array.isArray(operations)) throw inputError("增量操作格式不正确。");
    if (!body.settings && !body.stats && !operations.apps?.length && !operations.bookmarks?.length) throw inputError("请求数据不能为空。");
    const digest = bufferToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(body))));
    const updated = await commitFullData(env, fullData => {
      const next = { ...fullData };
      for (const key of ["apps", "bookmarks"]) {
        if (operations[key] === undefined) continue;
        if (!Array.isArray(operations[key])) throw inputError("增量操作应为数组。");
        if (!operations[key].length) continue;
        const label = key === "apps" ? "应用" : "书签";
        const collection = normaliseCollection(fullData[key] || [], { label, type: key });
        applyCollectionPatchOperations(collection, operations[key], { label, type: key });
        next[key] = normaliseCollection(collection, { label, type: key });
      }
      if (body.settings !== undefined) {
        if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings)) throw inputError("站点设置格式不正确。");
        next.settings = normaliseSettingsInput({ ...fullData.settings, ...body.settings });
      }
      if (body.stats !== undefined) {
        if (!body.stats || typeof body.stats !== "object" || Array.isArray(body.stats)) throw inputError("统计设置格式不正确。");
        next.stats = { ...fullData.stats, siteStartDate: normaliseStartDate(body.stats.siteStartDate) };
      }
      return next;
    }, { request, expectedVersion, requestId: body.requestId, digest });
    return jsonSuccess({ data: sanitiseData(updated) });
  } catch (error) {
    return jsonFailure(error.statusCode ? error.message : "数据更新失败。", error.statusCode || 400);
  }
}



async function handlePasswordUpdate(request, env) {
  const body = await readBoundedJson(request, AUTH_BODY_LIMIT);
  const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const newPasswordRaw = typeof body?.newPassword === "string" ? body.newPassword : "";

  if (!currentPassword) {
    return jsonFailure("请输入当前密码。", 400);
  }
  if (currentPassword.length > MAX_PASSWORD_LENGTH) {
    return jsonFailure("密码长度超出限制。", 400);
  }
  const cleanNewPassword = newPasswordRaw.trim();
  if (!cleanNewPassword || cleanNewPassword.length < 6) {
    return jsonFailure("新密码长度至少为 6 位。", 400);
  }
  if (cleanNewPassword.length > MAX_PASSWORD_LENGTH) {
    return jsonFailure(`新密码长度不能超过 ${MAX_PASSWORD_LENGTH} 位。`, 400);
  }

  try {
    const lockState = await callLoginRateLimit(env, "/reserve", getClientIp(request));
    if (lockState.locked) {
      const response = jsonFailure("尝试次数过多，请稍后再试。", 429);
      response.headers.set("Retry-After", String(Math.max(1, Math.ceil(lockState.retryAfterMs / 1000))));
      return response;
    }
    const rotateToken = generateToken();
    const updated = await commitFullData(env, async (fullData) => {
      const admin = fullData.admin;
      if (!admin || !admin.passwordHash || !admin.passwordSalt) {
        throw Object.assign(new Error("密码修改功能暂不可用。"), { statusCode: 500 });
      }

      const isMatch = await verifyPassword(
        currentPassword,
        admin.passwordSalt,
        admin.passwordHash,
        admin.passwordHashAlgo
      );
      if (!isMatch) {
        throw Object.assign(new Error("当前密码不正确。"), { statusCode: 401 });
      }

      const isSameAsOld = await verifyPassword(
        cleanNewPassword,
        admin.passwordSalt,
        admin.passwordHash,
        admin.passwordHashAlgo
      );
      if (isSameAsOld) {
        throw Object.assign(new Error("新密码不能与当前密码相同。"), { statusCode: 400 });
      }

      const nextAdmin = await createAdminCredentialsFromPassword(cleanNewPassword);
      return {
        ...fullData,
        admin: nextAdmin,
      };
    }, { request, rotateToken });
    const response = jsonSuccess({ message: "密码已更新，其他设备的登录已失效。", data: { _version: updated._version } });
    response.headers.set("Set-Cookie", buildSessionCookie(rotateToken));
    return response;
  } catch (error) {
    const status = error?.statusCode || 500;
    return jsonFailure(error.statusCode ? error.message : "密码更新失败。", status);
  }
}

/**
 * 🆕 计算网站运行天数
 */
function calculateRunningDays(startDate) {
  if (!startDate) return 0;

  try {
    const start = parseDateAsLocalDay(startDate);
    const now = new Date();

    if (!start) return 0;

    const nowDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diffTime = nowDay.getTime() - start.getTime();
    const diffDays = Math.floor(diffTime / 86400000);

    return Math.max(0, diffDays);
  } catch (error) {
    console.error("计算运行天数失败:", error);
    return 0;
  }
}

function parseDateAsLocalDay(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    return null;
  }

  const yyyyMmDd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (yyyyMmDd) {
    const year = Number(yyyyMmDd[1]);
    const month = Number(yyyyMmDd[2]);
    const day = Number(yyyyMmDd[3]);
    const localDate = new Date(year, month - 1, day);
    const isValid =
      localDate.getFullYear() === year &&
      localDate.getMonth() === month - 1 &&
      localDate.getDate() === day;
    return isValid ? localDate : null;
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}


async function handleLogout(request, env) {
  const token = getSessionTokenFromRequest(request);
  if (isSessionToken(token)) {
    await callAppState(env, "/session/revoke", { token });
  }
  const response = jsonSuccess();
  response.headers.set("Set-Cookie", buildClearSessionCookie());
  return response;
}

// =================================================================================
// Authentication Middleware
// =================================================================================

async function requireAuth(request, env) {
  const session = await resolveSession(request, env);
  if (!session.token) {
    return jsonFailure("请先登录后再执行此操作。", 401);
  }

  if (!session.isValid) {
    return jsonFailure("登录状态已失效，请重新登录。", 401);
  }
  // Session expiry, revocation and credential epochs are checked by AppStateDO.
}

// =================================================================================
// Authoritative data (Durable Object) and bounded public read cache
// =================================================================================

let fullDataCache = null;
let visitorCountCache = null;
let visitorCountRead = null;

async function callAppState(env, pathname, body = {}) {
  if (!env?.APP_STATE || typeof env.APP_STATE.idFromName !== "function") throw inputError("数据服务未配置，请联系站点管理员。", 503);
  const stub = env.APP_STATE.get(env.APP_STATE.idFromName("global"));
  const response = await stub.fetch(`https://app-state${pathname}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true) throw inputError(payload?.message || "数据服务暂时不可用。", response.status >= 400 ? response.status : 503);
  return payload.data;
}

async function readFullData(env, options = {}) {
  const bypassCache = options && options.bypassCache === true;
  if (!bypassCache) {
    const cached = getCachedFullData();
    if (cached) {
      return cached;
    }
  }

  const parsed = await callAppState(env, "/read");
  updateFullDataCache(parsed);
  return getCachedFullData() || parsed;
}

async function readFullDataFresh(env) {
  return readFullData(env, { bypassCache: true });
}

async function commitFullData(env, mutator, { request, expectedVersion, requestId, digest, rotateToken } = {}) {
  const current = await readFullDataFresh(env);
  const token = getSessionTokenFromRequest(request);
  if (expectedVersion !== undefined && expectedVersion !== current._version) {
    return callAppState(env, "/commit", { token, expectedVersion, requestId, digest, data: null });
  }
  const updated = await mutator(cloneData(current));
  if (!updated || typeof updated !== "object") throw inputError("写入失败：数据格式不正确。");
  if (new TextEncoder().encode(JSON.stringify(updated)).byteLength > DATA_BODY_LIMIT) throw inputError("站点数据总量超出大小限制。", 413);
  const committed = await callAppState(env, "/commit", {
    token, expectedVersion: expectedVersion ?? current._version,
    data: updated, requestId, digest, rotateToken,
  });
  updateFullDataCache(committed);
  return committed;
}

async function incrementVisitorCountAndReadData(env, ctx) {
  const fullData = await readFullData(env);
  const sanitised = sanitiseData(fullData);
  const currentCount = toSafeNonNegativeInteger(
    fullData.stats?.visitorCount,
    DEFAULT_STATS.visitorCount
  );

  if (hasVisitorCounterBinding(env)) {
    try {
      const nextVisitorCount = await incrementVisitorCountFromDO(env, currentCount);
      sanitised.visitorCount = nextVisitorCount;

      // Counting visits must never renew or overwrite a configuration snapshot.
      cacheVisitorCount(nextVisitorCount);
      return sanitised;
    } catch (error) {
      console.error("Visitor counter DO increment failed, returning last-known count:", error);
    }
  }

  // DO 不可用时返回当前计数,不再回退到 KV 写入。
  // 原因:并发请求会同时读到相同的 currentCount 然后各自写入 currentCount+1,
  // 导致计数不增长。让 DO 单点处理写入是唯一安全的方式。
  sanitised.visitorCount = currentCount;
  return sanitised;
}

// =================================================================================
// Data normalization and sanitization helpers
// =================================================================================

function sanitiseData(fullData) {
  const defaults = createDefaultSettings();
  const sourceSettings = fullData.settings || defaults;
  const weather = normaliseWeatherSettingsValue(
    sourceSettings.weather ?? sourceSettings.weatherLocation
  );
  const visualSettings = normaliseVisualSettings(sourceSettings);
  // 🆕 计算运行天数
  const siteStartDate = fullData.stats?.siteStartDate || null;
  const runningDays = calculateRunningDays(siteStartDate);

  return {
    _version: Number.isSafeInteger(fullData._version) ? fullData._version : 0,
    settings: {
      siteName: sourceSettings.siteName || defaults.siteName,
      siteLogo: sourceSettings.siteLogo || defaults.siteLogo,
      greeting: sourceSettings.greeting || defaults.greeting,
      footer: normaliseFooterValue(sourceSettings.footer),
      weather: { city: weather.city },
      glassOpacity: visualSettings.glassOpacity,
      useWallpaper: visualSettings.useWallpaper,
      wallpaperUrl: visualSettings.wallpaperUrl,
    },
    apps: Array.isArray(fullData.apps) ? fullData.apps : [],
    bookmarks: Array.isArray(fullData.bookmarks) ? fullData.bookmarks : [],
    visitorCount: fullData.stats?.visitorCount || DEFAULT_STATS.visitorCount,
    runningDays, // 🆕 添加
    siteStartDate, // 🆕 添加（用于后台编辑）
    config: {
      weather: {
        defaultCity: DEFAULT_WEATHER_CONFIG.city,
      },
    },
  };
}

function normaliseSettingsInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw inputError("站点设置格式不正确。");
  const siteName = limitedText(input.siteName, "网站名称", 120, { required: true });
  const visualSettings = normaliseVisualSettings(input);
  visualSettings.wallpaperUrl = checkedUrl(visualSettings.wallpaperUrl, "壁纸地址", { allowRelative: true });
  const footer = normaliseFooterValue(input.footer);
  if (footer.length > 20000) throw inputError("页脚不能超过 20000 个字符。");

  return {
    siteName,
    siteLogo: checkedIcon(input.siteLogo, "网站图标"),
    greeting: limitedText(input.greeting, "问候语", 500),
    footer,
    weather: normaliseWeatherSettingsInput(input.weather ?? input.weatherLocation),
    glassOpacity: visualSettings.glassOpacity,
    useWallpaper: visualSettings.useWallpaper,
    wallpaperUrl: visualSettings.wallpaperUrl,
  };
}

function normaliseCollection(value, { label, type }) {
  if (!Array.isArray(value)) throw inputError(`${label} 数据格式不正确，应为数组。`);
  if (value.length > MAX_COLLECTION_ITEMS) throw inputError(`${label}最多允许 ${MAX_COLLECTION_ITEMS} 条。`);
  const seen = new Set();
  return value.map((item) => {
    const normalised = normaliseItem(item, type);
    if (seen.has(normalised.id)) {
      throw inputError(`${label}存在重复的条目编号。`);
    }
    seen.add(normalised.id);
    return normalised;
  });
}

function normaliseItem(input, type) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw inputError("数据项格式不正确。");
  const payload = normaliseItemFields(input, type, { trim: true });
  payload.id = limitedText(input.id, "条目编号", 128) || crypto.randomUUID();
  payload.name = limitedText(input.name, "名称", 120, { required: true });
  payload.url = checkedUrl(input.url, "链接", { allowEmpty: false });
  payload.description = limitedText(input.description, "描述", 1000);
  payload.icon = checkedIcon(input.icon, "图标");
  if (type === "bookmarks") {
    payload.category = limitedText(input.category, "分类", 120);
  }
  return payload;
}

function normaliseWeatherSettingsValue(input) {
  const fallback = createDefaultWeatherSettings();
  let cities = parseWeatherCities(input);
  if (!cities.length) {
    cities = fallback.city;
  }
  return { city: cities };
}

function normaliseWeatherSettingsInput(rawWeather) {
  if (rawWeather === undefined || rawWeather === null) {
    return createDefaultWeatherSettings();
  }
  const cities = parseWeatherCities(rawWeather);
  if (!cities.length) {
    throw inputError("天气城市不能为空。");
  }
  if (cities.length > WEATHER_MAX_CITIES || cities.some(city => city.length > 80)) throw inputError(`天气最多支持 ${WEATHER_MAX_CITIES} 个城市，每个名称不超过 80 个字符。`);
  return { city: cities };
}

function normaliseStartDate(value) {
  if (value === null || value === "") return null;
  const clean = limitedText(value, "开始日期", 10, { required: true });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean) || !Number.isFinite(Date.parse(`${clean}T00:00:00Z`)) || new Date(`${clean}T00:00:00Z`).toISOString().slice(0, 10) !== clean) throw inputError("开始日期格式不正确。");
  return clean;
}


function createDefaultSettings() {
  return {
    ...BASE_DEFAULT_SETTINGS,
    weather: createDefaultWeatherSettings(),
  };
}

function createDefaultWeatherSettings() {
  return { city: [DEFAULT_WEATHER_CONFIG.city] };
}

async function createDefaultData(env) {
  const admin = await resolveInitialAdmin(env);

  const settings = {
    ...createDefaultSettings(),
    footer: DEFAULT_INITIAL_FOOTER,
    weather: { city: [...DEFAULT_INITIAL_WEATHER_CITIES] },
  };

  return {
    settings,
    apps: createDefaultApps(),
    bookmarks: createDefaultBookmarks(),
    stats: { ...DEFAULT_STATS },
    admin,
    _version: 0,
  };
}

function createDefaultApps() {
  return [
    {
      id: "app-figma",
      name: "Figma",
      url: "https://www.figma.com/",
      description: "协作式界面设计工具。",
      icon: "🎨",
    },
    {
      id: "app-notion",
      name: "Notion",
      url: "https://www.notion.so/",
      description: "多合一的笔记与知识管理平台。",
      icon: "🗂️",
    },
    {
      id: "app-slack",
      name: "Slack",
      url: "https://slack.com/",
      description: "团队即时沟通与协作中心。",
      icon: "💬",
    },
    {
      id: "app-github",
      name: "GitHub",
      url: "https://github.com/",
      description: "代码托管与协作平台。",
      icon: "🐙",
    },
    {
      id: "app-canva",
      name: "Canva",
      url: "https://www.canva.com/",
      description: "简单易用的在线设计工具。",
      icon: "🖌️",
    },
  ];
}

function createDefaultBookmarks() {
  return [
    {
      id: "bookmark-oschina",
      name: "开源中国",
      url: "https://www.oschina.net/",
      description: "聚焦开源信息与技术社区。",
      icon: "🌐",
      category: "技术社区",
    },
    {
      id: "bookmark-sspai",
      name: "少数派",
      url: "https://sspai.com/",
      description: "关注效率工具与生活方式的媒体。",
      icon: "📰",
      category: "效率与生活",
    },
    {
      id: "bookmark-zhihu",
      name: "知乎",
      url: "https://www.zhihu.com/",
      description: "问答与知识分享社区。",
      icon: "❓",
      category: "知识学习",
    },
    {
      id: "bookmark-jike",
      name: "即刻",
      url: "https://m.okjike.com/",
      description: "兴趣社交与资讯聚合平台。",
      icon: "📮",
      category: "资讯聚合",
    },
    {
      id: "bookmark-juejin",
      name: "稀土掘金",
      url: "https://juejin.cn/",
      description: "开发者技术社区与优质内容。",
      icon: "💡",
      category: "技术社区",
    },
  ];
}

function resolveBootstrapPassword(env) {
  const raw = env?.ADMIN_PASSWORD;
  if (typeof raw !== "string") {
    return "";
  }
  return raw.trim();
}

async function createAdminCredentialsFromPassword(password) {
  return hashPassword(password);
}

async function resolveInitialAdmin(env) {
  const bootstrapPassword = resolveBootstrapPassword(env);
  if (!bootstrapPassword) {
    return null;
  }
  return createAdminCredentialsFromPassword(bootstrapPassword);
}

// =================================================================================
// Crypto Functions (Web Crypto API)
// =================================================================================

function generateToken() {
  return crypto.randomUUID();
}

async function deriveHashHex(password, saltBuffer, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBuffer,
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    512
  );

  return bufferToHex(new Uint8Array(derivedBits));
}

function resolveIterationsForAlgo(algo) {
  if (algo === PBKDF2_ALGO_CURRENT) return PBKDF2_ITERATIONS_CURRENT;
  if (algo === PBKDF2_ALGO_LEGACY) return PBKDF2_ITERATIONS_LEGACY;
  return null;
}

async function hashPassword(password) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const saltHex = bufferToHex(salt);
  const passwordHash = await deriveHashHex(password, salt, PBKDF2_ITERATIONS_CURRENT);
  return {
    passwordHash,
    passwordSalt: saltHex,
    passwordHashAlgo: PBKDF2_ALGO_CURRENT,
  };
}

async function verifyPassword(password, saltHex, expectedHashHex, algo) {
  const isUnmarked = algo == null || algo === "";
  const iterations = resolveIterationsForAlgo(algo);
  // Unknown explicit algorithms must not silently fall back to a legacy hash.
  if (!iterations && !isUnmarked) return false;
  if (typeof saltHex !== "string" || typeof expectedHashHex !== "string" ||
      !/^(?:[0-9a-f]{2})+$/i.test(saltHex) || !/^[0-9a-f]{128}$/i.test(expectedHashHex)) {
    return false;
  }
  const salt = hexToBuffer(saltHex);
  const actualHashHex = await deriveHashHex(password, salt, iterations || PBKDF2_ITERATIONS_LEGACY);
  if (timingSafeEqual(expectedHashHex, actualHashHex)) return true;
  if (!isUnmarked) return false;
  // Older records used 100k; a previous bug also saved 600k hashes without a marker.
  // A successful login upgrades either unmarked format with an explicit algorithm.
  const currentHashHex = await deriveHashHex(password, salt, PBKDF2_ITERATIONS_CURRENT);
  return timingSafeEqual(expectedHashHex, currentHashHex);
}



// =================================================================================
// Weather API Fetcher
// =================================================================================

const PATCH_MAX_OPERATIONS = 200;

// =================================================================================
// Utility Functions
// =================================================================================

async function readJsonBody(request) {
  const body = await readBoundedJson(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw inputError("请求数据不能为空。");
  }
  return body;
}


function applyCollectionPatchOperations(collection, operations, { type, label }) {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw inputError("缺少有效的增量操作。");
  }
  if (operations.length > PATCH_MAX_OPERATIONS) {
    throw inputError(`单次最多允许 ${PATCH_MAX_OPERATIONS} 条操作。`);
  }

  const byId = new Map(collection.map(item => [item.id, item]));
  for (let i = 0; i < operations.length; i += 1) {
    const operation = operations[i];
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
      throw inputError(`第 ${i + 1} 条操作格式不正确。`);
    }

    const op = typeof operation.op === "string" ? operation.op.trim().toLowerCase() : "";
    if (!op) {
      throw inputError(`第 ${i + 1} 条操作缺少 op 字段。`);
    }

    if (op === "upsert") {
      const rawItem =
        operation.item && typeof operation.item === "object" && !Array.isArray(operation.item)
          ? operation.item
          : operation;
      const normalised = normaliseItem(rawItem, type);
      byId.set(normalised.id, normalised);
      continue;
    }

    if (op === "patch") {
      const id = typeof operation.id === "string" ? operation.id.trim() : "";
      if (!id) {
        throw inputError(`第 ${i + 1} 条 patch 操作缺少 id。`);
      }
      if (!byId.has(id)) {
        throw inputError(`${label}不存在，id: ${id}`);
      }

      const changes =
        operation.changes && typeof operation.changes === "object" && !Array.isArray(operation.changes)
          ? operation.changes
          : operation.item && typeof operation.item === "object" && !Array.isArray(operation.item)
          ? operation.item
          : null;
      if (!changes) {
        throw inputError(`第 ${i + 1} 条 patch 操作缺少 changes/item。`);
      }

      const merged = {
        ...byId.get(id),
        ...changes,
        id,
      };
      byId.set(id, normaliseItem(merged, type));
      continue;
    }

    if (op === "delete") {
      const id = typeof operation.id === "string" ? operation.id.trim() : "";
      if (!id) {
        throw inputError(`第 ${i + 1} 条 delete 操作缺少 id。`);
      }
      // Deleting an already absent item is a successful idempotent operation.
      byId.delete(id);
      continue;
    }

    throw inputError(`第 ${i + 1} 条操作不支持: ${op}`);
  }
  if (byId.size > MAX_COLLECTION_ITEMS) throw inputError(`${label}最多允许 ${MAX_COLLECTION_ITEMS} 条。`);
  collection.splice(0, collection.length, ...byId.values());
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json;charset=UTF-8", "Cache-Control": "no-store" },
  });
}

function jsonSuccess(payload = {}, status = 200) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return jsonResponse({ success: true, ...payload }, status);
  }
  return jsonResponse({ success: true, data: payload }, status);
}

function jsonFailure(message, status = 400, extra = {}) {
  const cleanMessage =
    typeof message === "string" && message.trim() ? message : "请求失败。";
  const extras = extra && typeof extra === "object" && !Array.isArray(extra) ? extra : {};
  return jsonResponse({ success: false, message: cleanMessage, ...extras }, status);
}
function isProduction(env) {
  const mode = typeof env?.ENVIRONMENT === "string" ? env.ENVIRONMENT : env?.NODE_ENV;
  return !(typeof mode === "string" && mode.toLowerCase() === "development");
}

function buildErrorResponse(error, env, fallbackMessage) {
  const message =
    (error?.statusCode && error.statusCode < 500 || !isProduction(env)) && typeof error?.message === "string" && error.message.trim()
      ? error.message
      : fallbackMessage || "Server error";
  const payload = { success: false, message };
  if (!isProduction(env) && error?.stack) {
    payload.stack = error.stack;
  }
  return payload;
}

async function resolveSession(request, env) {
  const token = getSessionTokenFromRequest(request);
  if (!isSessionToken(token)) {
    return { token: "", isValid: false };
  }
  const session = await callAppState(env, "/session/resolve", { token });
  return {
    token,
    isValid: session.isValid === true,
  };
}

function hasVisitorCounterBinding(env) {
  return Boolean(env?.VISITOR_COUNTER && typeof env.VISITOR_COUNTER.idFromName === "function");
}

function hasLoginRateLimitBinding(env) {
  return Boolean(env?.LOGIN_RATE_LIMIT && typeof env.LOGIN_RATE_LIMIT.idFromName === "function");
}

function getClientIp(request) {
  const direct = request.headers.get("cf-connecting-ip");
  if (direct && direct.trim()) return direct.trim();
  return "unknown";
}

async function callLoginRateLimit(env, action, ip) {
  if (!hasLoginRateLimitBinding(env)) {
    throw inputError("登录保护服务暂时不可用，请稍后重试。", 503);
  }
  try {
    const ipHash = bufferToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip)));
    const id = env.LOGIN_RATE_LIMIT.idFromName(`ip:${ipHash}`);
    const stub = env.LOGIN_RATE_LIMIT.get(id);
    const url = new URL(`https://login-rate-limit${action}`);
    const response = await stub.fetch(url.toString());
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.success !== true) {
      throw new Error("Invalid limiter response");
    }
    return {
      locked: Boolean(payload.locked),
      retryAfterMs: Number.isFinite(payload.retryAfterMs) ? payload.retryAfterMs : 0,
    };
  } catch (error) {
    console.error("Login rate limit DO call failed:", error);
    throw inputError("登录保护服务暂时不可用，请稍后重试。", 503);
  }
}

function getVisitorCounterStub(env) {
  if (!hasVisitorCounterBinding(env)) {
    return null;
  }
  const id = env.VISITOR_COUNTER.idFromName(VISITOR_COUNTER_DO_NAME);
  return env.VISITOR_COUNTER.get(id);
}

async function requestVisitorCounter(stub, pathname, seed) {
  if (!stub || typeof stub.fetch !== "function") {
    throw new Error("Visitor counter Durable Object is unavailable.");
  }
  const url = new URL(`https://visitor-counter${pathname}`);
  url.searchParams.set("seed", String(toSafeNonNegativeInteger(seed, 0)));
  const response = await stub.fetch(url.toString(), {
    method: "GET",
    headers: { "Accept": "application/json" },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.success !== true) {
    throw new Error("Visitor counter Durable Object request failed.");
  }
  return toSafeNonNegativeInteger(payload.count, 0);
}

async function incrementVisitorCountFromDO(env, fallbackCount) {
  const stub = getVisitorCounterStub(env);
  return requestVisitorCounter(stub, "/increment", fallbackCount);
}

async function getVisitorCountFromDO(env, fallbackCount) {
  const stub = getVisitorCounterStub(env);
  return requestVisitorCounter(stub, "/get", fallbackCount);
}

async function getPersistedVisitorCount(env, fallbackCount) {
  const fallback = toSafeNonNegativeInteger(fallbackCount, DEFAULT_STATS.visitorCount);
  if (visitorCountCache && visitorCountCache.expiresAt > Date.now()) return visitorCountCache.value;
  if (!hasVisitorCounterBinding(env)) {
    return fallback;
  }
  if (!visitorCountRead) {
    visitorCountRead = getVisitorCountFromDO(env, fallback)
      .then(count => cacheVisitorCount(count))
      .catch(error => {
        console.error("Visitor counter DO read failed, use fallback:", error);
        return visitorCountCache?.value ?? fallback;
      })
      .finally(() => { visitorCountRead = null; });
  }
  return visitorCountRead;
}

function cacheVisitorCount(count) {
  const value = Math.max(visitorCountCache?.value || 0, toSafeNonNegativeInteger(count));
  visitorCountCache = { value, expiresAt: Date.now() + FULL_DATA_CACHE_TTL_MS };
  return value;
}

function getCachedFullData() {
  if (!fullDataCache) {
    return null;
  }
  if (Date.now() >= fullDataCache.expiresAt) {
    fullDataCache = null;
    return null;
  }
  return fullDataCache.data;
}

function updateFullDataCache(fullData) {
  if (fullDataCache && fullDataCache.data._version > fullData._version) return;
  fullDataCache = {
    // Read-only snapshots can be shared by readers. Only write paths clone.
    data: freezeData(fullData),
    expiresAt: Date.now() + FULL_DATA_CACHE_TTL_MS,
  };
}

function freezeData(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}

function cloneData(data) {
  if (typeof structuredClone === "function") {
    return structuredClone(data);
  }
  return JSON.parse(JSON.stringify(data));
}

function parseCookies(request) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const pairs = cookieHeader.split(";").map((part) => part.trim()).filter(Boolean);
  const cookies = Object.create(null);
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    cookies[key] = value;
  }
  return cookies;
}

function toSafeNonNegativeInteger(value, fallback = 0) {
  const fallbackValue = Number.isFinite(fallback) ? Math.max(0, Math.floor(fallback)) : 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return fallbackValue;
    }
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return Math.max(0, Math.floor(numeric));
    }
  }
  return fallbackValue;
}

function getSessionTokenFromRequest(request) {
  const rawAuth = request.headers.get("authorization");
  if (rawAuth && rawAuth.startsWith(AUTH_HEADER_PREFIX)) {
    const token = rawAuth.slice(AUTH_HEADER_PREFIX.length).trim();
    if (token) {
      return token;
    }
  }
  const cookies = parseCookies(request);
  return cookies[SESSION_COOKIE_NAME] || "";
}

function buildSessionCookie(token) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    `Path=${COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${COOKIE_MAX_AGE}`,
    "Secure",
  ];
  return parts.join("; ");
}

function buildClearSessionCookie() {
  return [
    `${SESSION_COOKIE_NAME}=`,
    `Path=${COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    "Secure",
  ].join("; ");
}

function buildVisitorCookie() {
  return [
    `${VISITOR_COOKIE_NAME}=1`,
    `Path=${COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${VISITOR_COOKIE_MAX_AGE}`,
    "Secure",
  ].join("; ");
}

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes.buffer;
}

function timingSafeEqual(a, b) {
    if (a.length !== b.length) {
        return false;
    }
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}
