import { getAssetFromKV } from "@cloudflare/kv-asset-handler";
import { Router } from "itty-router";
import manifest from "__STATIC_CONTENT_MANIFEST";

const assetManifest = JSON.parse(manifest);
const router = Router();


// =================================================================================
// Constants and Defaults
// =================================================================================

const BASE_DEFAULT_SETTINGS = Object.freeze({
  siteName: "SimPage",
  siteLogo: "",
  greeting: "",
  footer: "",
  glassOpacity: 40, // 🆕 添加默认透明度
  useWallpaper: true, // 🆕 添加
  wallpaperUrl: "https://bing.img.run/uhd.php", // 🆕 添加默认壁纸 URL
});

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
const SESSION_REVOKED_MARKER = "revoked";
const SESSION_REVOKED_TTL_SECONDS = 60; // 覆盖 KV 最终一致性窗口
const AUTH_HEADER_PREFIX = "Bearer ";
const SESSION_COOKIE_NAME = "simpage_session";
const VISITOR_COOKIE_NAME = "simpage_visitor";
const VISITOR_COOKIE_MAX_AGE = 60 * 60; // 1 hour
const COOKIE_PATH = "/";
const COOKIE_MAX_AGE = SESSION_TTL_SECONDS;
const MAX_PASSWORD_LENGTH = 256;
const LOGIN_FAIL_THRESHOLD = 5;
const LOGIN_LOCK_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const LOGIN_RATE_LIMIT_DO_NAME = "global";
const PBKDF2_ITERATIONS_LEGACY = 100000;
const PBKDF2_ITERATIONS_CURRENT = 600000;
const PBKDF2_ALGO_LEGACY = "pbkdf2-sha256-100k";
const PBKDF2_ALGO_CURRENT = "pbkdf2-sha256-600k";
const ICON_LINK_API_URL = "https://ancient-art-7e23.2754026865.workers.dev/api/icon";
// IconLink requires this Origin header for server-to-server API requests.
const ICON_LINK_API_REQUEST_ORIGIN = "https://nav.439933.xyz";
const ICON_LINK_API_TIMEOUT_MS = 30000;

// =================================================================================
// API Routes
// =================================================================================

router.post("/api/login", handleLogin);
router.get("/api/data", handleGetData);
router.get("/api/weather", handleGetWeather);
router.get("/api/admin/data", requireAuth, handleGetAdminData);
router.put("/api/admin/data", requireAuth, handleDataUpdate);
router.patch("/api/admin/apps", requireAuth, handlePatchApps);
router.patch("/api/admin/bookmarks", requireAuth, handlePatchBookmarks);
router.patch("/api/admin/settings", requireAuth, handlePatchSettings);
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
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.font.im",
  "img-src 'self' data: https:",
  "font-src 'self' https://fonts.font.im data:",
  "connect-src 'self' https://v1.hitokoto.cn https://geocoding-api.open-meteo.com https://api.open-meteo.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

function applySecurityHeaders(response) {
  if (!response) return response;
  // 重定向(3xx)与 304 不附加 CSP,避免破坏头部不可变性
  const status = response.status;
  if (status >= 300 && status < 400) {
    return response;
  }
  try {
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
    if (!headers.has("Content-Security-Policy")) {
      headers.set("Content-Security-Policy", SECURITY_CSP);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (_error) {
    return response;
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      const response = await router.handle(request, env, ctx);
      return applySecurityHeaders(response);
    } catch (error) {
      console.error("Unhandled error:", error);
      const errorResponse = buildErrorResponse(error, env);
      return applySecurityHeaders(
        new Response(JSON.stringify(errorResponse, null, 2), {
          status: 500,
          headers: { "Content-Type": "application/json;charset=UTF-8" },
        })
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
    const ip = url.searchParams.get("ip") || "unknown";
    const now = Date.now();
    const stored = (await this.state.storage.get(ip)) || { fails: 0, lockedUntil: 0 };

    // 锁已过期则重置
    if (stored.lockedUntil > 0 && stored.lockedUntil <= now) {
      stored.fails = 0;
      stored.lockedUntil = 0;
    }

    if (url.pathname === "/check") {
      const locked = stored.lockedUntil > now;
      return jsonSuccess({ locked, retryAfterMs: locked ? stored.lockedUntil - now : 0 });
    }

    if (url.pathname === "/fail") {
      stored.fails += 1;
      if (stored.fails >= LOGIN_FAIL_THRESHOLD) {
        stored.lockedUntil = now + LOGIN_LOCK_DURATION_MS;
        stored.fails = 0;
      }
      await this.state.storage.put(ip, stored);
      const locked = stored.lockedUntil > now;
      return jsonSuccess({ locked, retryAfterMs: locked ? stored.lockedUntil - now : 0 });
    }

    if (url.pathname === "/success") {
      await this.state.storage.delete(ip);
      return jsonSuccess({});
    }

    return new Response("Not Found", { status: 404 });
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
  const body = await request.json().catch(() => null);
  const password = typeof body?.password === "string" ? body.password : "";
  if (!password) {
    return jsonFailure("请输入密码。", 400);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return jsonFailure("密码长度超出限制。", 400);
  }

  const clientIp = getClientIp(request);
  const lockState = await callLoginRateLimit(env, "/check", clientIp);
  if (lockState.locked) {
    const retryAfterSec = Math.max(1, Math.ceil(lockState.retryAfterMs / 1000));
    const response = jsonFailure("尝试次数过多,请稍后再试。", 429);
    response.headers.set("Retry-After", String(retryAfterSec));
    return response;
  }

  const fullData = await readFullDataFresh(env);
  let admin = fullData.admin;

  if (!admin || !admin.passwordSalt || !admin.passwordHash) {
    const bootstrapPassword = resolveBootstrapPassword(env);
    if (!bootstrapPassword) {
      return jsonFailure("后台初始密码未配置。", 503);
    }
    admin = await createAdminCredentialsFromPassword(bootstrapPassword);
    fullData.admin = admin;
    await writeFullData(env, fullData);
  }

  const isMatch = await verifyPassword(
    password,
    admin.passwordSalt,
    admin.passwordHash,
    admin.passwordHashAlgo
  );
  if (!isMatch) {
    const failState = await callLoginRateLimit(env, "/fail", clientIp);
    if (failState.locked) {
      const retryAfterSec = Math.max(1, Math.ceil(failState.retryAfterMs / 1000));
      const response = jsonFailure("尝试次数过多,请稍后再试。", 429);
      response.headers.set("Retry-After", String(retryAfterSec));
      return response;
    }
    return jsonFailure("密码错误。", 401);
  }

  // 登录成功:清除失败计数(异步,不阻塞响应)
  if (hasLoginRateLimitBinding(env)) {
    const clearTask = callLoginRateLimit(env, "/success", clientIp);
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(clearTask);
    } else {
      void clearTask;
    }
  }

  // 旧算法登录成功后,异步升级到当前算法,不阻塞响应
  if (admin.passwordHashAlgo !== PBKDF2_ALGO_CURRENT) {
    const upgradeTask = (async () => {
      try {
        await commitFullData(env, async (current) => {
          const next = await createAdminCredentialsFromPassword(password);
          return { ...current, admin: next };
        });
      } catch (error) {
        console.error("Auto-upgrade password hash failed:", error);
      }
    })();
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(upgradeTask);
    } else {
      void upgradeTask;
    }
  }

  const token = generateToken();
  await env.SESSIONS.put(token, "active", { expirationTtl: SESSION_TTL_SECONDS });

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
  const fullData = await readFullData(env);
  const data = sanitiseData(fullData);
  data.visitorCount = await getPersistedVisitorCount(env, data.visitorCount);
  const weather = normaliseWeatherSettingsValue(
    fullData.settings?.weather ?? fullData.settings?.weatherLocation
  );
  const cityString = Array.isArray(weather.city) ? weather.city.join(" ") : weather.city;
  data.settings.weather = { city: cityString };
  return jsonSuccess({ data });
}

async function handleDataUpdate(request, env) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return jsonFailure("请求数据不能为空。", 400);
    }

    const hasInput = ["apps", "bookmarks", "settings", "stats"].some((key) =>
      Object.prototype.hasOwnProperty.call(body, key)
    );
    if (!hasInput) {
      return jsonFailure("请求数据不能为空。", 400);
    }

    const updated = await commitFullData(env, async (existing) => {
      const settingsInput = body.settings ?? existing.settings;
      const appsInput = Array.isArray(body.apps) ? body.apps : existing.apps;
      const bookmarksInput = Array.isArray(body.bookmarks) ? body.bookmarks : existing.bookmarks;

      const normalisedApps = normaliseCollection(appsInput, { label: "应用", type: "apps" });
      const normalisedBookmarks = normaliseCollection(bookmarksInput, { label: "书签", type: "bookmarks" });
      const normalisedSettings = normaliseSettingsInput(settingsInput);

      const persistedVisitorCount = await getPersistedVisitorCount(
        env,
        existing.stats?.visitorCount || DEFAULT_STATS.visitorCount
      );

      const normalisedStats = {
        visitorCount: persistedVisitorCount,
        siteStartDate:
          typeof body.stats?.siteStartDate === "string"
            ? body.stats.siteStartDate
            : existing.stats?.siteStartDate || null,
      };

      return {
        ...existing,
        settings: normalisedSettings,
        apps: normalisedApps,
        bookmarks: normalisedBookmarks,
        stats: normalisedStats,
        admin: existing.admin,
      };
    });
    return jsonSuccess({ data: sanitiseData(updated) });
  } catch (error) {
    const status = error?.statusCode || 400;
    return jsonFailure(error?.message || "数据更新失败。", status);
  }
}

async function handlePatchApps(request, env) {
  return patchCollectionData(request, env, {
    key: "apps",
    type: "apps",
    label: "应用",
  });
}

async function handlePatchBookmarks(request, env) {
  return patchCollectionData(request, env, {
    key: "bookmarks",
    type: "bookmarks",
    label: "书签",
  });
}

async function patchCollectionData(request, env, { key, type, label }) {
  try {
    const body = await readJsonBody(request);
    const operations = resolvePatchOperations(body);
    if (!operations.length) {
      return jsonFailure("请求数据不能为空。", 400);
    }

    const updated = await commitFullData(env, async (fullData) => {
      const source = Array.isArray(fullData[key]) ? fullData[key] : [];
      const collection = normaliseCollection(source, { label, type });
      applyCollectionPatchOperations(collection, operations, { type, label });
      return {
        ...fullData,
        [key]: collection,
      };
    });
    const data = sanitiseData(updated);
    return jsonSuccess({
      data: {
        [key]: data[key],
      },
    });
  } catch (error) {
    const status = error?.statusCode || 400;
    return jsonFailure(error?.message || `${label} 增量更新失败。`, status);
  }
}

async function handlePatchSettings(request, env) {
  try {
    const body = await readJsonBody(request);
    const patch = extractSettingsPatchInput(body);

    const hasInput = [
      "siteName",
      "siteLogo",
      "greeting",
      "footer",
      "weather",
      "weatherLocation",
      "glassOpacity",
      "useWallpaper",
      "wallpaperUrl",
    ].some((key) => Object.prototype.hasOwnProperty.call(patch, key));

    if (!hasInput) {
      return jsonFailure("请求数据不能为空。", 400);
    }

    const updated = await commitFullData(env, async (fullData) => {
      const existingSettings =
        fullData.settings && typeof fullData.settings === "object"
          ? fullData.settings
          : createDefaultSettings();
      const mergedSettings = { ...existingSettings, ...patch };

      if (Object.prototype.hasOwnProperty.call(patch, "weather")) {
        mergedSettings.weather = patch.weather;
      } else if (Object.prototype.hasOwnProperty.call(patch, "weatherLocation")) {
        mergedSettings.weather = patch.weatherLocation;
      } else {
        mergedSettings.weather = existingSettings.weather ?? existingSettings.weatherLocation;
      }

      const normalisedSettings = normaliseSettingsInput(mergedSettings);
      return {
        ...fullData,
        settings: normalisedSettings,
      };
    });
    const data = sanitiseData(updated);
    return jsonSuccess({
      data: {
        settings: data.settings,
      },
    });
  } catch (error) {
    const status = error?.statusCode || 400;
    return jsonFailure(error?.message || "站点设置增量更新失败。", status);
  }
}


async function handlePasswordUpdate(request, env) {
  const body = await request.json().catch(() => null);
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
    await commitFullData(env, async (fullData) => {
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
    });
    return jsonSuccess({ message: "密码已更新，下次登录请使用新密码。" });
  } catch (error) {
    const status = error?.statusCode || 500;
    return jsonFailure(error?.message || "密码更新失败。", status);
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


async function handleFetchLogo(request, env) {
  try {
    const { searchParams } = new URL(request.url);
    const targetUrl = searchParams.get("targetUrl");

    if (!targetUrl || typeof targetUrl !== "string" || !targetUrl.trim()) {
      return jsonFailure("缺少有效的 targetUrl 参数", 400);
    }

    const trimmed = targetUrl.trim();
    if (trimmed.length > 2048) {
      return jsonFailure("目标网址长度不能超过 2048 个字符。", 400);
    }

    let siteUrl;
    try {
      const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
      siteUrl = new URL(candidate);
    } catch (_error) {
      return jsonFailure("无效的网址。", 400);
    }

    if (siteUrl.protocol !== "http:" && siteUrl.protocol !== "https:") {
      return jsonFailure("网址仅支持 HTTP 或 HTTPS 协议。", 400);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ICON_LINK_API_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(ICON_LINK_API_URL, {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "Origin": ICON_LINK_API_REQUEST_ORIGIN,
        },
        body: JSON.stringify({ url: siteUrl.toString() }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      const message =
        typeof payload?.error === "string" && payload.error.trim()
          ? payload.error.trim()
          : `图标 API 请求失败（HTTP ${response.status}）`;
      const status = response.status >= 400 && response.status < 500 ? response.status : 502;
      return jsonFailure(message, status);
    }

    const logoUrl = typeof payload.short_url === "string" ? payload.short_url.trim() : "";
    if (!/^https?:\/\//i.test(logoUrl)) {
      return jsonFailure("图标 API 未返回有效的短链。", 502);
    }

    return jsonSuccess({ logoUrl });

  } catch (error) {
    if (error?.name === "AbortError") {
      return jsonFailure("获取网站图标超时，请稍后重试。", 504);
    }
    console.error("调用图标 API 失败:", error);
    return jsonFailure("无法访问图标 API，请稍后重试。", 502);
  }
}
async function handleLogout(request, env) {
  const token = getSessionTokenFromRequest(request);
  if (token) {
    // 用 revoked 标记覆盖原 active 值,在 KV 一致性窗口期内仍能识别为失效。
    // 60 秒后自动过期清除,不占用长期空间。
    await env.SESSIONS.put(token, SESSION_REVOKED_MARKER, {
      expirationTtl: SESSION_REVOKED_TTL_SECONDS,
    });
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
  // The TTL is handled by KV, so if the session exists, it's valid.
}

// =================================================================================
// Data Management (KV)
// =================================================================================

const DATA_KEY = "data";
let fullDataCache = null;

async function readFullData(env, options = {}) {
  const bypassCache = options && options.bypassCache === true;
  if (!bypassCache) {
    const cached = getCachedFullData();
    if (cached) {
      return cached;
    }
  }

  const raw = await env.SIMPAGE_DATA.get(DATA_KEY);
  if (!raw) {
    const defaultData = await createDefaultData(env);
    await writeFullData(env, defaultData);
    return cloneData(defaultData);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("存储数据格式损坏，无法解析。");
  }

  if (!parsed.admin || !parsed.admin.passwordHash || !parsed.admin.passwordSalt) {
    const bootstrapPassword = resolveBootstrapPassword(env);
    if (bootstrapPassword) {
      parsed.admin = await createAdminCredentialsFromPassword(bootstrapPassword);
      await writeFullData(env, parsed);
    }
  }

  updateFullDataCache(parsed);
  return cloneData(parsed);
}

async function readFullDataFresh(env) {
  return readFullData(env, { bypassCache: true });
}

async function writeFullData(env, fullData) {
  await env.SIMPAGE_DATA.put(DATA_KEY, JSON.stringify(fullData));
  updateFullDataCache(fullData);
}

/**
 * 乐观锁写入:基于 _version 字段在写前再次校验,
 * 中间被其他会话改过则重试,达到上限抛 409。
 * 不能完全消除 KV 最终一致性窗口,但能在常见管理员单人场景下避免静默丢失更新。
 */
async function commitFullData(env, mutator, retries = 3) {
  let lastConflict = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    const current = await readFullDataFresh(env);
    const baseVersion = Number.isFinite(current?._version) ? current._version : 0;

    const updated = await mutator(current);
    if (!updated || typeof updated !== "object") {
      throw new Error("写入失败:数据格式不正确。");
    }

    const verifyRaw = await env.SIMPAGE_DATA.get(DATA_KEY);
    let verifyVersion = 0;
    if (verifyRaw) {
      try {
        const parsed = JSON.parse(verifyRaw);
        verifyVersion = Number.isFinite(parsed?._version) ? parsed._version : 0;
      } catch (_error) {
        verifyVersion = 0;
      }
    }

    if (verifyVersion !== baseVersion) {
      lastConflict = Object.assign(
        new Error("数据已被其他会话修改,请刷新后重试。"),
        { statusCode: 409 }
      );
      continue;
    }

    updated._version = baseVersion + 1;
    await writeFullData(env, updated);
    return updated;
  }
  throw lastConflict || new Error("写入失败,请重试。");
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

      const cachedData = {
        ...fullData,
        stats: { ...fullData.stats, visitorCount: nextVisitorCount },
      };
      updateFullDataCache(cachedData);
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
    apps: fullData.apps?.map((item) => ({ ...item })) || [],
    bookmarks: fullData.bookmarks?.map((item) => ({ ...item })) || [],
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
  const siteName = typeof input?.siteName === "string" ? input.siteName.trim() : "";
  if (!siteName) throw new Error("网站名称不能为空。");
  const visualSettings = normaliseVisualSettings(input);

  return {
    siteName,
    siteLogo: typeof input?.siteLogo === "string" ? input.siteLogo.trim() : "",
    greeting: typeof input?.greeting === "string" ? input.greeting.trim() : "",
    footer: normaliseFooterValue(input?.footer),
    weather: normaliseWeatherSettingsInput(input?.weather),
    glassOpacity: visualSettings.glassOpacity,
    useWallpaper: visualSettings.useWallpaper,
    wallpaperUrl: visualSettings.wallpaperUrl,
  };
}

function normaliseCollection(value, { label, type }) {
  if (!Array.isArray(value)) throw new Error(`${label} 数据格式不正确，应为数组。`);
  const seen = new Set();
  return value.map((item) => {
    const normalised = normaliseItem(item, type);
    if (seen.has(normalised.id)) {
      normalised.id = crypto.randomUUID();
    }
    seen.add(normalised.id);
    return normalised;
  });
}

function normaliseItem(input, type) {
  if (!input || typeof input !== "object") throw new Error("数据项格式不正确。");
  const name = String(input.name || "").trim();
  const url = String(input.url || "").trim();
  if (!name) throw new Error("名称不能为空。");
  if (!url) throw new Error("链接不能为空。");

  const payload = {
    id: typeof input.id === "string" && input.id.trim() ? input.id.trim() : crypto.randomUUID(),
    name,
    url: ensureUrlProtocol(url),
    description: typeof input.description === "string" ? input.description.trim() : "",
    icon: typeof input.icon === "string" ? input.icon.trim() : "",
  };
  if (type === "bookmarks") {
    payload.category = typeof input.category === "string" ? input.category.trim() : "";
  }
  return payload;
}

function normaliseFooterValue(value) {
  if (typeof value !== "string") return "";
  const normalised = value.replace(/\r\n?/g, "\n");
  return normalised.trim() ? normalised : "";
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
  if (!rawWeather || typeof rawWeather !== "object") {
    return createDefaultWeatherSettings();
  }
  const cities = parseWeatherCities(rawWeather);
  if (!cities.length) {
    throw new Error("天气城市不能为空。");
  }
  return { city: cities };
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
  const { passwordHash, passwordSalt } = await hashPassword(password);
  return { passwordHash, passwordSalt };
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

function ensureUrlProtocol(url) {
  if (/^https?:\/\//i.test(url)) return url;
  return `https://${url}`;
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
  // 旧数据没有 algo 字段时按遗留 100k 处理
  return PBKDF2_ITERATIONS_LEGACY;
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
  const salt = hexToBuffer(saltHex);
  const iterations = resolveIterationsForAlgo(algo);
  const actualHashHex = await deriveHashHex(password, salt, iterations);
  return timingSafeEqual(expectedHashHex, actualHashHex);
}



// =================================================================================
// Weather API Fetcher
// =================================================================================

const WEATHER_API_TIMEOUT_MS = 5000;
const GEOLOCATION_MAX_RETRIES = 3;
const GEOLOCATION_RETRY_DELAY_BASE_MS = 300;
const WEATHER_MAX_CITIES = 8;
const WEATHER_MAX_CONCURRENCY = 3;
const PATCH_MAX_OPERATIONS = 200;

function buildCacheableResponse(response, maxAgeSeconds) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", `public, max-age=${maxAgeSeconds}`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function cacheApiResponse(cache, url, response, maxAgeSeconds, ctx) {
  const storedResponse = buildCacheableResponse(response, maxAgeSeconds);
  const putPromise = cache.put(url, storedResponse);
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(putPromise);
    return;
  }
  void putPromise.catch((error) => {
    console.warn("cache.put failed:", error);
  });
}

async function fetchAndCache(url, ctx) {
  const cache = caches.default;
  let response = await cache.match(url);

  if (!response) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WEATHER_API_TIMEOUT_MS);

    try {
      response = await fetch(url.toString(), {
        signal: controller.signal,
        headers: {
          "Accept": "application/json",
        },
      });

      // Clone the response to be able to read the body for caching and for returning
      const cacheableResponse = response.clone();

      if (response.ok) {
        // Cache successful upstream responses for 15 minutes.
        cacheApiResponse(cache, url, cacheableResponse, 900, ctx);
      } else {
        // Cache failure briefly as a circuit breaker to avoid hammering the API.
        cacheApiResponse(cache, url, cacheableResponse, 60, ctx);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (!response.ok) {
    throw createWeatherError(`API请求失败: ${response.status}`, response.status);
  }

  return response.json();
}

async function geocodeCity(cityName, ctx) {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", cityName);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "zh");
  url.searchParams.set("format", "json");

  let lastError = null;
  for (let attempt = 0; attempt < GEOLOCATION_MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        const delay = GEOLOCATION_RETRY_DELAY_BASE_MS * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const payload = await fetchAndCache(url, ctx);

      if (!payload?.results?.[0]) {
        throw createWeatherError(`未找到城市 "${cityName}" 的地理位置信息。`, 404);
      }
      const { latitude, longitude, name } = payload.results[0];
      if (typeof latitude !== "number" || typeof longitude !== "number") {
        throw createWeatherError("地理位置信息无效。");
      }
      return { latitude, longitude, name: name || cityName }; // Success
    } catch (error) {
      lastError = error;
      // Don't retry on client errors (e.g., 404 Not Found)
      if (error?.statusCode >= 400 && error.statusCode < 500) {
        throw error;
      }
      console.warn(
        `geocodeCity failed (attempt ${attempt + 1}/${GEOLOCATION_MAX_RETRIES}), retrying...`,
        error.message
      );
    }
  }

  // If the loop completes, all retries have failed.
  throw lastError || createWeatherError("地理编码服务获取失败，且所有重试均告失败。", 502);
}

async function fetchOpenMeteoWeather(cityName, ctx) {
  const location = await geocodeCity(cityName, ctx);
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
  url.searchParams.set("current_weather", "true");
  url.searchParams.set("timezone", "auto");

  const payload = await fetchAndCache(url, ctx);
  const current = payload?.current_weather;
  if (!current || typeof current !== "object") {
    throw createWeatherError("天气数据格式异常。");
  }

  return {
    text: getWeatherDescription(Number(current.weathercode)),
    temperature: Number(current.temperature),
    windspeed: Number(current.windspeed),
    weathercode: Number(current.weathercode),
    time: current.time || null,
  };
}

function createWeatherError(message, statusCode = 502) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getWeatherDescription(code) {
  const map = {
    0: "晴天", 1: "晴朗", 2: "多云", 3: "阴天", 45: "雾", 48: "冻雾",
    51: "小雨", 53: "中雨", 55: "大雨", 56: "小冻雨", 57: "冻雨",
    61: "小雨", 63: "中雨", 65: "大雨", 66: "小冻雨", 67: "冻雨",
    71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒", 80: "阵雨",
    81: "中阵雨", 82: "大阵雨", 85: "小阵雪", 86: "大阵雪", 95: "雷雨",
    96: "雷雨伴冰雹", 99: "雷雨伴大冰雹",
  };
  return map[code] || "未知";
}

async function runTasksWithConcurrency(tasks, concurrency) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return [];
  }

  const limit = Math.max(1, Math.min(concurrency, tasks.length));
  const results = new Array(tasks.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < tasks.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await tasks[index]();
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

// =================================================================================
// Utility Functions
// =================================================================================

async function readJsonBody(request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    throw new Error("请求数据不能为空。");
  }
  return body;
}

function extractSettingsPatchInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("请求数据不能为空。");
  }
  const candidate = body.settings;
  if (candidate !== undefined) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("settings 数据格式不正确。");
    }
    return candidate;
  }
  return body;
}

function resolvePatchOperations(body) {
  if (Array.isArray(body)) {
    return body;
  }
  if (!body || typeof body !== "object") {
    return [];
  }
  if (Array.isArray(body.operations)) {
    return body.operations;
  }
  if (typeof body.op === "string") {
    return [body];
  }
  return [];
}

function applyCollectionPatchOperations(collection, operations, { type, label }) {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error("缺少有效的增量操作。");
  }
  if (operations.length > PATCH_MAX_OPERATIONS) {
    throw new Error(`单次最多允许 ${PATCH_MAX_OPERATIONS} 条操作。`);
  }

  for (let i = 0; i < operations.length; i += 1) {
    const operation = operations[i];
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
      throw new Error(`第 ${i + 1} 条操作格式不正确。`);
    }

    const op = typeof operation.op === "string" ? operation.op.trim().toLowerCase() : "";
    if (!op) {
      throw new Error(`第 ${i + 1} 条操作缺少 op 字段。`);
    }

    if (op === "upsert") {
      const rawItem =
        operation.item && typeof operation.item === "object" && !Array.isArray(operation.item)
          ? operation.item
          : operation;
      const normalised = normaliseItem(rawItem, type);
      const existingIndex = collection.findIndex((item) => item.id === normalised.id);
      if (existingIndex >= 0) {
        collection[existingIndex] = normalised;
      } else {
        collection.push(normalised);
      }
      continue;
    }

    if (op === "patch") {
      const id = typeof operation.id === "string" ? operation.id.trim() : "";
      if (!id) {
        throw new Error(`第 ${i + 1} 条 patch 操作缺少 id。`);
      }
      const existingIndex = collection.findIndex((item) => item.id === id);
      if (existingIndex < 0) {
        throw new Error(`${label}不存在，id: ${id}`);
      }

      const changes =
        operation.changes && typeof operation.changes === "object" && !Array.isArray(operation.changes)
          ? operation.changes
          : operation.item && typeof operation.item === "object" && !Array.isArray(operation.item)
          ? operation.item
          : null;
      if (!changes) {
        throw new Error(`第 ${i + 1} 条 patch 操作缺少 changes/item。`);
      }

      const merged = {
        ...collection[existingIndex],
        ...changes,
        id,
      };
      collection[existingIndex] = normaliseItem(merged, type);
      continue;
    }

    if (op === "delete") {
      const id = typeof operation.id === "string" ? operation.id.trim() : "";
      if (!id) {
        throw new Error(`第 ${i + 1} 条 delete 操作缺少 id。`);
      }
      const existingIndex = collection.findIndex((item) => item.id === id);
      if (existingIndex < 0) {
        throw new Error(`${label}不存在，id: ${id}`);
      }
      collection.splice(existingIndex, 1);
      continue;
    }

    throw new Error(`第 ${i + 1} 条操作不支持: ${op}`);
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json;charset=UTF-8" },
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
  return typeof mode === "string" && mode.toLowerCase() === "production";
}

function buildErrorResponse(error, env, fallbackMessage) {
  const message =
    typeof error?.message === "string" && error.message.trim()
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
  if (!token) {
    return { token: "", isValid: false };
  }
  const session = await env.SESSIONS.get(token);
  return {
    token,
    isValid: Boolean(session) && session !== SESSION_REVOKED_MARKER,
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
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded && forwarded.trim()) return forwarded.split(",")[0].trim();
  return "unknown";
}

async function callLoginRateLimit(env, action, ip) {
  if (!hasLoginRateLimitBinding(env)) {
    return { locked: false, retryAfterMs: 0 };
  }
  try {
    const id = env.LOGIN_RATE_LIMIT.idFromName(LOGIN_RATE_LIMIT_DO_NAME);
    const stub = env.LOGIN_RATE_LIMIT.get(id);
    const url = new URL(`https://login-rate-limit${action}`);
    url.searchParams.set("ip", ip);
    const response = await stub.fetch(url.toString());
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.success !== true) {
      return { locked: false, retryAfterMs: 0 };
    }
    return {
      locked: Boolean(payload.locked),
      retryAfterMs: Number.isFinite(payload.retryAfterMs) ? payload.retryAfterMs : 0,
    };
  } catch (error) {
    console.error("Login rate limit DO call failed:", error);
    return { locked: false, retryAfterMs: 0 };
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
  if (!hasVisitorCounterBinding(env)) {
    return fallback;
  }
  try {
    return await getVisitorCountFromDO(env, fallback);
  } catch (error) {
    console.error("Visitor counter DO read failed, use fallback:", error);
    return fallback;
  }
}

function getCachedFullData() {
  if (!fullDataCache) {
    return null;
  }
  if (Date.now() > fullDataCache.expiresAt) {
    fullDataCache = null;
    return null;
  }
  return cloneData(fullDataCache.data);
}

function updateFullDataCache(fullData) {
  fullDataCache = {
    data: cloneData(fullData),
    expiresAt: Date.now() + FULL_DATA_CACHE_TTL_MS,
  };
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
  const cookies = {};
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    cookies[key] = value;
  }
  return cookies;
}

function parseWeatherCities(input) {
  if (typeof input === "string") {
    return input.trim().split(/\s+/).filter(Boolean);
  }
  if (Array.isArray(input)) {
    return input.map((city) => String(city).trim()).filter(Boolean);
  }
  if (input && typeof input === "object") {
    const source = Object.prototype.hasOwnProperty.call(input, "city")
      ? input.city
      : input.weatherLocation;
    return parseWeatherCities(source);
  }
  return [];
}

function normaliseVisualSettings(source) {
  const normalised = {
    glassOpacity: BASE_DEFAULT_SETTINGS.glassOpacity,
    useWallpaper: BASE_DEFAULT_SETTINGS.useWallpaper,
    wallpaperUrl: BASE_DEFAULT_SETTINGS.wallpaperUrl,
  };

  if (typeof source?.glassOpacity === "number") {
    normalised.glassOpacity = Math.max(0, Math.min(100, Math.round(source.glassOpacity)));
  }
  if (typeof source?.useWallpaper === "boolean") {
    normalised.useWallpaper = source.useWallpaper;
  }
  if (typeof source?.wallpaperUrl === "string") {
    const trimmed = source.wallpaperUrl.trim();
    if (trimmed) {
      normalised.wallpaperUrl = trimmed;
    }
  }
  return normalised;
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
