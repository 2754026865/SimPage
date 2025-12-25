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
  wallpaperUrl: "https://bing.img.run/uhd.php", // 🆕 添加默认壁纸 URL
});

const DEFAULT_STATS = Object.freeze({
  visitorCount: 0,
});

const DEFAULT_WEATHER_CONFIG = Object.freeze({
  city: "åäº¬",
});

const DEFAULT_ADMIN_PASSWORD = "admin123";
const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 hours in seconds
const AUTH_HEADER_PREFIX = "Bearer ";

// =================================================================================
// API Routes
// =================================================================================

router.post("/api/login", handleLogin);
router.get("/api/data", handleGetData);
router.get("/api/weather", handleGetWeather);
router.get("/api/admin/data", requireAuth, handleGetAdminData);
router.put("/api/admin/data", requireAuth, handleDataUpdate);
router.put("/api/data", requireAuth, handleDataUpdate); // Legacy endpoint
router.post("/api/admin/password", requireAuth, handlePasswordUpdate);
router.post("/api/admin/weather-test", requireAuth, handleWeatherTest);
router.get("/api/fetch-logo", requireAuth, handleFetchLogo);

// =================================================================================
// Static Asset and Fallback Routes
// =================================================================================

router.get("/admin", (request, env, ctx) => serveStatic(request, env, ctx, "/admin.html"));
router.get("/admin/", (request, env, ctx) => serveStatic(request, env, ctx, "/admin.html"));

// Fallback for all other GET requests to serve static assets or index.html
router.get("*", (request, env, ctx) => serveStatic(request, env, ctx));

// 404 for all other methods
router.all("*", () => new Response("Not Found", { status: 404 }));

// =================================================================================
// Main Fetch Handler
// =================================================================================

export default {
  async fetch(request, env, ctx) {
    try {
      return await router.handle(request, env, ctx);
    } catch (error) {
      console.error("Unhandled error:", error);
      const errorResponse = {
        success: false,
        message: error.message,
        stack: error.stack,
      };
      return new Response(JSON.stringify(errorResponse, null, 2), {
        status: 500,
        headers: { "Content-Type": "application/json;charset=UTF-8" },
      });
    }
  },
};

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
    // Intercept requests for static data files and serve them from KV
    if (url.pathname.startsWith("/data/")) {
      const key = url.pathname.substring(1); // remove leading '/'
      const object = await env.__STATIC_CONTENT.get(key, { type: "arrayBuffer" });
      if (object === null) {
        return new Response("Not found", { status: 404 });
      }
      const headers = {
        "content-type": "application/json;charset=UTF-8",
        "cache-control": "public, max-age=3600", // Cache for 1 hour
      };
      return new Response(object, { headers });
    }

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
    // For SPA-like behavior, only fall back to index.html for navigation requests
    const isHTMLRequest = (request.headers.get("accept") || "").includes("text/html");
    const isRoot = new URL(request.url).pathname === "/";

    if (isHTMLRequest || isRoot) {
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
    
    // For other asset types (JS, CSS, etc.), return a 404
    return new Response("Not Found", { status: 404 });
  }
}

// =================================================================================
// API Handlers
// =================================================================================

async function handleLogin(request, env) {
  const body = await request.json().catch(() => null);
  const password = typeof body?.password === "string" ? body.password : "";
  if (!password) {
    return jsonResponse({ success: false, message: "è¯·è¾å¥å¯ç ã" }, 400);
  }

  const fullData = await readFullData(env);
  let admin = fullData.admin;
  if (!admin || !admin.passwordSalt || !admin.passwordHash) {
    const credentials = await createDefaultAdminCredentials();
    const updatedData = {
      ...fullData,
      admin: credentials,
    };
    await writeFullData(env, updatedData);
    admin = credentials;
  }

  const isMatch = await verifyPassword(password, admin.passwordSalt, admin.passwordHash);
  if (!isMatch) {
    return jsonResponse({ success: false, message: "å¯ç éè¯¯ã" }, 401);
  }

  const token = generateToken();
  await env.SESSIONS.put(token, "active", { expirationTtl: SESSION_TTL_SECONDS });

  return jsonResponse({ success: true, token });
}

async function handleGetData(request, env) {
  try {
    const data = await incrementVisitorCountAndReadData(env);
    return jsonResponse(data);
  } catch (error) {
    console.error("Error in handleGetData:", error);
    return jsonResponse(
      {
        success: false,
        message: `Error fetching data: ${error.message}`,
        stack: error.stack,
      },
      500
    );
  }
}


async function handleGetWeather(request, env, ctx) {
  try {
    const fullData = await readFullData(env);
    const weatherSettings = normaliseWeatherSettingsValue(fullData.settings?.weather);
    const apiKey = resolveApiKeyFromWeather(weatherSettings, env);
    const locations = Array.isArray(weatherSettings.locations) ? weatherSettings.locations : [];

    if (!apiKey) {
      return jsonResponse({ success: false, message: "Missing QWeather API Key." }, 400);
    }

    if (locations.length > 0) {
      const weatherPromises = locations.map((location) =>
        fetchQWeatherNowByLocation(location, apiKey, env, ctx)
          .then((weather) => ({
            ...weather,
            city: location.name || location.city || "",
            success: true,
          }))
          .catch((error) => {
            const label = location.name || location.city || "Unknown";
            console.error(`Weather fetch failed for ${label}:`, error);
            return { city: label, success: false, message: error.message };
          })
      );

      const results = await Promise.all(weatherPromises);
      const successfulWeatherData = results.filter((result) => result.success);

      if (successfulWeatherData.length === 0 && results.length > 0) {
        const firstError = results.find((result) => !result.success);
        const errorMessage = firstError?.message || "Unable to fetch weather data.";
        return jsonResponse({ success: false, message: errorMessage }, 502);
      }

      return jsonResponse({ success: true, data: successfulWeatherData });
    }

    let cities = weatherSettings.city;
    if (!Array.isArray(cities) || cities.length === 0) {
      cities = [DEFAULT_WEATHER_CONFIG.city];
    }

    const queryList = alignWeatherQueries(cities, weatherSettings.query);
    const weatherPromises = cities.map((city, index) =>
      fetchQWeatherNowByCity(city, apiKey, env, ctx, queryList[index])
        .then(weather => ({ ...weather, city, success: true }))
        .catch(error => {
          console.error(`è·ååå¸ ${city} çå¤©æ°ä¿¡æ¯å¤±è´¥ï¼`, error);
          return { city, success: false, message: error.message };
        })
    );

    const results = await Promise.all(weatherPromises);
    const successfulWeatherData = results.filter(r => r.success);

    if (successfulWeatherData.length === 0 && results.length > 0) {
      const firstError = results.find(r => !r.success);
      const errorMessage = firstError?.message || "Unable to fetch weather data.";
      return jsonResponse({ success: false, message: errorMessage }, 502);
    }

    return jsonResponse({ success: true, data: successfulWeatherData });
  } catch (error) {
    const statusCode = error.statusCode || 502;
    return jsonResponse({ success: false, message: error.message }, statusCode);
  }
}

async function handleGetAdminData(request, env) {
  const fullData = await readFullData(env);
  const data = sanitiseData(fullData);
  const weather = normaliseWeatherSettingsValue(fullData.settings?.weather);
  const cityString = Array.isArray(weather.city) ? weather.city.join(" ") : weather.city;
  data.settings.weather = { city: cityString, apiKey: weather.apiKey || "", query: weather.query || [] };
  return jsonResponse({ success: true, data });
}

async function handleDataUpdate(request, env, ctx) {
  try {
    const { apps, bookmarks, settings } = await request.json();
    const normalisedApps = normaliseCollection(apps, { label: "åºç¨", type: "apps" });
    const normalisedBookmarks = normaliseCollection(bookmarks, { label: "ä¹¦ç­¾", type: "bookmarks" });
    const normalisedSettings = normaliseSettingsInput(settings);
    const weatherLocations = await resolveWeatherLocationsFromSettings(normalisedSettings.weather, env, ctx);
    normalisedSettings.weather = {
      ...normalisedSettings.weather,
      locations: weatherLocations,
    };

    const existing = await readFullData(env);
    const payload = {
      settings: normalisedSettings,
      apps: normalisedApps,
      bookmarks: normalisedBookmarks,
      stats: existing.stats,
      admin: existing.admin,
    };

    await writeFullData(env, payload);
    return jsonResponse({ success: true, data: sanitiseData(payload) });
  } catch (error) {
    return jsonResponse({ success: false, message: error.message }, 400);
  }
}

async function handleWeatherTest(request, env, ctx) {
  try {
    const body = await request.json().catch(() => null);
    const city = typeof body?.city === "string" ? body.city.trim() : "";
    const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
    const queryList = normaliseWeatherQueryInput({ query: body?.query });
    const query = queryList[0] || "";

    if (!city) {
      return jsonResponse({ success: false, message: "City name is required." }, 400);
    }
    if (!apiKey) {
      return jsonResponse({ success: false, message: "Missing QWeather API Key." }, 400);
    }

    const location = await geocodeCity(city, apiKey, env, ctx, query);
    const weather = await fetchQWeatherNowByLocation(location, apiKey, env, ctx);
    return jsonResponse({
      success: true,
      data: {
        city: location.name || city,
        ...weather,
      },
    });
  } catch (error) {
    const statusCode = error.statusCode || 502;
    return jsonResponse({ success: false, message: error.message }, statusCode);
  }
}

async function handlePasswordUpdate(request, env) {
  const body = await request.json().catch(() => null);
  const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const newPasswordRaw = typeof body?.newPassword === "string" ? body.newPassword : "";

  if (!currentPassword) {
    return jsonResponse({ success: false, message: "è¯·è¾å¥å½åå¯ç ã" }, 400);
  }
  const cleanNewPassword = newPasswordRaw.trim();
  if (!cleanNewPassword || cleanNewPassword.length < 6) {
    return jsonResponse({ success: false, message: "æ°å¯ç é¿åº¦è³å°ä¸º 6 ä½ã" }, 400);
  }

  const fullData = await readFullData(env);
  const admin = fullData.admin;
  if (!admin || !admin.passwordHash || !admin.passwordSalt) {
    return jsonResponse({ success: false, message: "å¯ç ä¿®æ¹åè½æä¸å¯ç¨ã" }, 500);
  }

  const isMatch = await verifyPassword(currentPassword, admin.passwordSalt, admin.passwordHash);
  if (!isMatch) {
    return jsonResponse({ success: false, message: "å½åå¯ç ä¸æ­£ç¡®ã" }, 401);
  }

  const isSameAsOld = await verifyPassword(cleanNewPassword, admin.passwordSalt, admin.passwordHash);
  if (isSameAsOld) {
    return jsonResponse({ success: false, message: "æ°å¯ç ä¸è½ä¸å½åå¯ç ç¸åã" }, 400);
  }

  const { passwordHash, passwordSalt } = await hashPassword(cleanNewPassword);
  const updatedData = {
    ...fullData,
    admin: { passwordHash, passwordSalt },
  };

  await writeFullData(env, updatedData);
  return jsonResponse({ success: true, message: "å¯ç å·²æ´æ°ï¼ä¸æ¬¡ç»å½è¯·ä½¿ç¨æ°å¯ç ã" });
}

function handleFetchLogo(request, env) {
  try {
    const { searchParams } = new URL(request.url);
    const targetUrl = searchParams.get("targetUrl");

    if (!targetUrl || typeof targetUrl !== "string" || !targetUrl.trim()) {
      return jsonResponse({ success: false, message: "ç¼ºå°ææç targetUrl åæ°" }, 400);
    }

    // ç§»é¤åè®® (http, https)
    let domain = targetUrl.trim().replace(/^(https?:\/\/)?/, "");
    // ç§»é¤ç¬¬ä¸ä¸ªææ åçææåå®¹ (è·¯å¾, æ¥è¯¢åæ°, åå¸)
    domain = domain.split("/")[0];

    if (!domain) {
      return jsonResponse({ success: false, message: "æ æ³ä»é¾æ¥ä¸­æåååã" }, 400);
    }

    const logoUrl = `https://icon.ooo/${domain}`;
    return jsonResponse({ success: true, logoUrl: logoUrl });

  } catch (error) {
    console.error("çæ Logo é¾æ¥æ¶åçåé¨éè¯¯:", error);
    return jsonResponse({ success: false, message: "çæ Logo é¾æ¥å¤±è´¥" }, 500);
  }
}

// =================================================================================
// Authentication Middleware
// =================================================================================

async function requireAuth(request, env) {
  const raw = request.headers.get("authorization");
  if (!raw || !raw.startsWith(AUTH_HEADER_PREFIX)) {
    return jsonResponse({ success: false, message: "è¯·ç»å½ååæ§è¡æ­¤æä½ã" }, 401);
  }

  const token = raw.slice(AUTH_HEADER_PREFIX.length).trim();
  if (!token) {
    return jsonResponse({ success: false, message: "è¯·ç»å½ååæ§è¡æ­¤æä½ã" }, 401);
  }

  const session = await env.SESSIONS.get(token);
  if (!session) {
    return jsonResponse({ success: false, message: "ç»å½ç¶æå·²å¤±æï¼è¯·éæ°ç»å½ã" }, 401);
  }
  // The TTL is handled by KV, so if the session exists, it's valid.
}

// =================================================================================
// Data Management (KV)
// =================================================================================

const DATA_KEY = "data";

async function readFullData(env) {
  const raw = await env.SIMPAGE_DATA.get(DATA_KEY);
  if (!raw) {
    const defaultData = await createDefaultData();
    await writeFullData(env, defaultData);
    return defaultData;
  }
  const parsed = JSON.parse(raw);
  // Basic validation/normalization can be added here if needed
  return parsed;
}

async function writeFullData(env, fullData) {
  await env.SIMPAGE_DATA.put(DATA_KEY, JSON.stringify(fullData, null, 2));
}

async function incrementVisitorCountAndReadData(env) {
  const fullData = await readFullData(env);
  const sanitised = sanitiseData(fullData);

  const currentCount = fullData.stats?.visitorCount || 0;
  const nextVisitorCount = currentCount + 1;
  sanitised.visitorCount = nextVisitorCount;

  const updatedData = {
    ...fullData,
    stats: { ...fullData.stats, visitorCount: nextVisitorCount },
  };

  // Fire-and-forget the write operation
  // This makes the user-facing request faster as it doesn't wait for the KV write.
  const promise = writeFullData(env, updatedData);
  if (globalThis.ctx && typeof globalThis.ctx.waitUntil === "function") {
    globalThis.ctx.waitUntil(promise);
  }

  return sanitised;
}

// =================================================================================
// Data Normalization and Sanitization (Copied and adapted from server.js)
// =================================================================================

function sanitiseData(fullData) {
  const defaults = createDefaultSettings();
  const sourceSettings = fullData.settings || defaults;
  const weather = normaliseWeatherSettingsValue(sourceSettings.weather);

  // 🆕 处理透明度
  let glassOpacity = 40;
  if (typeof sourceSettings.glassOpacity === "number") {
    glassOpacity = Math.max(0, Math.min(100, Math.round(sourceSettings.glassOpacity)));
  }
  // 🆕 处理壁纸 URL
  let wallpaperUrl = "https://bing.img.run/uhd.php";
  if (typeof sourceSettings.wallpaperUrl === "string") {
    const trimmed = sourceSettings.wallpaperUrl.trim();
    if (trimmed) {
      wallpaperUrl = trimmed;
    }
  }

  return {
    settings: {
      siteName: sourceSettings.siteName || defaults.siteName,
      siteLogo: sourceSettings.siteLogo || defaults.siteLogo,
      greeting: sourceSettings.greeting || defaults.greeting,
      footer: normaliseFooterValue(sourceSettings.footer),
      weather: { city: weather.city },
      glassOpacity, // 🆕 添加
      wallpaperUrl, // 🆕 添加
    },
    apps: fullData.apps?.map((item) => ({ ...item })) || [],
    bookmarks: fullData.bookmarks?.map((item) => ({ ...item })) || [],
    visitorCount: fullData.stats?.visitorCount || DEFAULT_STATS.visitorCount,
    config: {
      weather: {
        defaultCity: DEFAULT_WEATHER_CONFIG.city,
      },
    },
  };
}

function normaliseSettingsInput(input) {
  const siteName = typeof input?.siteName === "string" ? input.siteName.trim() : "";
  if (!siteName) throw new Error("ç½ç«åç§°ä¸è½ä¸ºç©ºã");

  // 🆕 处理透明度
  let glassOpacity = 40;
  if (typeof input?.glassOpacity === "number") {
    glassOpacity = Math.max(0, Math.min(100, Math.round(input.glassOpacity)));
  }
  // 🆕 处理壁纸 URL
  let wallpaperUrl = "https://bing.img.run/uhd.php";
  if (typeof input?.wallpaperUrl === "string") {
    const trimmed = input.wallpaperUrl.trim();
    if (trimmed) {
      wallpaperUrl = trimmed;
    }
  }

  return {
    siteName,
    siteLogo: typeof input?.siteLogo === "string" ? input.siteLogo.trim() : "",
    greeting: typeof input?.greeting === "string" ? input.greeting.trim() : "",
    footer: normaliseFooterValue(input?.footer),
    weather: normaliseWeatherSettingsInput(input?.weather),
    glassOpacity, // 🆕 添加
    wallpaperUrl, // 🆕 添加
  };
}

function normaliseCollection(value, { label, type }) {
  if (!Array.isArray(value)) throw new Error(`${label} æ°æ®æ ¼å¼ä¸æ­£ç¡®ï¼åºä¸ºæ°ç»ã`);
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
  if (!input || typeof input !== "object") throw new Error("æ°æ®é¡¹æ ¼å¼ä¸æ­£ç¡®ã");
  const name = String(input.name || "").trim();
  const url = String(input.url || "").trim();
  if (!name) throw new Error("åç§°ä¸è½ä¸ºç©ºã");
  if (!url) throw new Error("é¾æ¥ä¸è½ä¸ºç©ºã");

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
  let value = { ...fallback };
  const locations = normaliseWeatherLocationsValue(input);
  const apiKey = resolveApiKeyFromWeather(input, {});
  const query = normaliseWeatherQueryInput(input);

  if (input && typeof input === "object") {
    if (typeof input.city === "string" && input.city.trim()) {
      value.city = input.city.trim().split(/\s+/).filter(Boolean);
    } else if (Array.isArray(input.city)) {
      value.city = input.city.map(c => String(c).trim()).filter(Boolean);
    }
  }

  if (locations.length > 0) {
    value.locations = locations;
  }

  if (apiKey) {
    value.apiKey = apiKey;
  }
  if (query.length > 0) {
    value.query = query;
  }

  if (!value.city || value.city.length === 0) {
    if (locations.length > 0) {
      value.city = locations
        .map((location) => location.name || location.city)
        .filter((name) => typeof name === "string" && name.trim())
        .map((name) => name.trim());
    }
  }

  if (!value.city || value.city.length === 0) {
    value.city = fallback.city;
  }
  return value;
}


function resolveApiKeyFromWeather(weather, env) {
  const fromSettings = getWeatherApiKey(weather);
  if (fromSettings) {
    return fromSettings;
  }
  const fromEnv = typeof env?.QWEATHER_API_KEY === "string" ? env.QWEATHER_API_KEY.trim() : "";
  return fromEnv;
}

function normaliseQWeatherCityName(city) {
  if (!city) {
    return "";
  }
  const cleaned = city.replace(/\s+/g, "").replace(/(市|省|自治区|特别行政区)$/, "");
  const codeKey = Array.from(cleaned)
    .map((char) => char.codePointAt(0).toString(16))
    .join("-");
  if (QWEATHER_CITY_ALIAS_CODES[codeKey]) {
    return QWEATHER_CITY_ALIAS_CODES[codeKey];
  }
  if (QWEATHER_CITY_ALIASES[cleaned]) {
    return QWEATHER_CITY_ALIASES[cleaned];
  }
  const containsNonAscii = /[^\x00-\x7F]/.test(cleaned);
  return containsNonAscii ? "" : cleaned;
}

function getWeatherApiKey(rawWeather) {
  return typeof rawWeather?.apiKey === "string" ? rawWeather.apiKey.trim() : "";
}

function normaliseWeatherQueryInput(rawWeather) {
  if (!rawWeather || typeof rawWeather !== "object") {
    return [];
  }
  if (typeof rawWeather.query === "string") {
    const trimmed = rawWeather.query.trim();
    return trimmed ? trimmed.split(/\s+/).filter(Boolean) : [];
  }
  if (Array.isArray(rawWeather.query)) {
    return rawWeather.query.map((value) => String(value || "").trim()).filter(Boolean);
  }
  return [];
}

function alignWeatherQueries(cities, queries) {
  if (!Array.isArray(queries) || queries.length === 0) {
    return [];
  }
  if (!Array.isArray(cities) || cities.length === 0) {
    return [];
  }
  if (queries.length === 1 && cities.length > 1) {
    return Array(cities.length).fill(queries[0]);
  }
  if (queries.length >= cities.length) {
    return queries.slice(0, cities.length);
  }
  const padded = queries.slice();
  while (padded.length < cities.length) {
    padded.push("");
  }
  return padded;
}

function normaliseWeatherSettingsInput(rawWeather) {
    if (!rawWeather || typeof rawWeather !== "object") {
        return createDefaultWeatherSettings();
    }
    const citySource = rawWeather.city;
    let cities = [];
    if (typeof citySource === 'string') {
        cities = citySource.split(/\s+/).filter(Boolean);
    } else if (Array.isArray(citySource)) {
        cities = citySource.map(c => String(c).trim()).filter(Boolean);
    }

    const apiKey = getWeatherApiKey(rawWeather);
    const query = normaliseWeatherQueryInput(rawWeather);

    if (cities.length === 0) {
        throw new Error("å¤©æ°åå¸ä¸è½ä¸ºç©ºã");
    }
  return { city: cities, apiKey, query };
}

function normaliseWeatherLocationsValue(input) {
  if (!input || typeof input !== "object") {
    return [];
  }
  const rawLocations = Array.isArray(input.locations) ? input.locations : [];
  return rawLocations
    .map((location) => {
      if (!location || typeof location !== "object") {
        return null;
      }
      const latitude = Number(location.latitude);
      const longitude = Number(location.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return null;
      }
      const city = typeof location.city === "string" ? location.city.trim() : "";
      const name = typeof location.name === "string" ? location.name.trim() : "";
      const id = typeof location.id === "string" ? location.id.trim() : "";
      if (!city && !name) {
        return null;
      }
      return {
        city: city || name,
        name: name || city,
        latitude,
        longitude,
        id,
      };
    })
    .filter(Boolean);
}

function createDefaultSettings() {
  return {
    ...BASE_DEFAULT_SETTINGS,
    weather: createDefaultWeatherSettings(),
  };
}

function createDefaultWeatherSettings() {
  return { city: [DEFAULT_WEATHER_CONFIG.city], locations: [], apiKey: "", query: [] };
}

async function createDefaultData() {
  const admin = await createDefaultAdminCredentials();
  // Hardcode the full initial data to ensure KV is populated correctly on first run,
  // but dynamically generate the admin credentials.
  return {
    "settings": {
      "siteName": "SimPage",
      "siteLogo": "",
      "greeting": "",
      "footer": "æ¬¢è¿æ¥å°æçä¸»é¡µ",
      "glassOpacity": 40, // 🆕 添加
      "wallpaperUrl": "https://bing.img.run/uhd.php", // 🆕 添加
      "weather": {
        "city": ["åäº¬", "ä¸æµ·"]
      }
    },
    "apps": [
      { "id": "app-figma", "name": "Figma", "url": "https://www.figma.com/", "description": "åä½å¼çé¢è®¾è®¡å·¥å·ã", "icon": "ð¨" },
      { "id": "app-notion", "name": "Notion", "url": "https://www.notion.so/", "description": "å¤åä¸çç¬è®°ä¸ç¥è¯ç®¡çå¹³å°ã", "icon": "ðï¸" },
      { "id": "app-slack", "name": "Slack", "url": "https://slack.com/", "description": "å¢éå³æ¶æ²éä¸åä½ä¸­å¿ã", "icon": "ð¬" },
      { "id": "app-github", "name": "GitHub", "url": "https://github.com/", "description": "ä»£ç æç®¡ä¸åä½å¹³å°ã", "icon": "ð" },
      { "id": "app-canva", "name": "Canva", "url": "https://www.canva.com/", "description": "ç®åæç¨çå¨çº¿è®¾è®¡å·¥å·ã", "icon": "ðï¸" }
    ],
    "bookmarks": [
      { "id": "bookmark-oschina", "name": "å¼æºä¸­å½", "url": "https://www.oschina.net/", "description": "èç¦å¼æºä¿¡æ¯ä¸ææ¯ç¤¾åºã", "icon": "ð", "category": "ææ¯ç¤¾åº" },
      { "id": "bookmark-sspai", "name": "å°æ°æ´¾", "url": "https://sspai.com/", "description": "å³æ³¨æçå·¥å·ä¸çæ´»æ¹å¼çåªä½ã", "icon": "ð°", "category": "æçä¸çæ´»" },
      { "id": "bookmark-zhihu", "name": "ç¥ä¹", "url": "https://www.zhihu.com/", "description": "é®ç­ä¸ç¥è¯åäº«ç¤¾åºã", "icon": "â", "category": "ç¥è¯å­¦ä¹ " },
      { "id": "bookmark-jike", "name": "å³å»", "url": "https://m.okjike.com/", "description": "å´è¶£ç¤¾äº¤ä¸èµè®¯èåå¹³å°ã", "icon": "ð®", "category": "èµè®¯èå" },
      { "id": "bookmark-juejin", "name": "ç¨åæé", "url": "https://juejin.cn/", "description": "å¼åèææ¯ç¤¾åºä¸ä¼è´¨åå®¹ã", "icon": "ð¡", "category": "ææ¯ç¤¾åº" }
    ],
    "stats": {
      "visitorCount": 0
    },
    "admin": admin
  };
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

async function hashPassword(password) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const saltHex = bufferToHex(salt);

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
      salt: salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    512 // 64 bytes
  );

  const hashHex = bufferToHex(new Uint8Array(derivedBits));
  return { passwordHash: hashHex, passwordSalt: saltHex };
}

async function verifyPassword(password, saltHex, expectedHashHex) {
  const salt = hexToBuffer(saltHex);
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
      salt: salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    512
  );

  const actualHashHex = bufferToHex(new Uint8Array(derivedBits));
  return timingSafeEqual(expectedHashHex, actualHashHex);
}

async function createDefaultAdminCredentials() {
  return await hashPassword(DEFAULT_ADMIN_PASSWORD);
}

// =================================================================================
// Weather API Fetcher
// =================================================================================

const WEATHER_API_TIMEOUT_MS = 5000;
const GEOLOCATION_MAX_RETRIES = 3;
const GEOLOCATION_RETRY_DELAY_BASE_MS = 300;

const QWEATHER_GEO_ENDPOINT = "https://jg359c629y.re.qweatherapi.com/geo/v2/city/lookup";
const QWEATHER_NOW_ENDPOINT = "https://jg359c629y.re.qweatherapi.com/v7/weather/now";
const WEATHER_CACHE_TTL_SECONDS = 300;
const GEO_CACHE_TTL_SECONDS = 24 * 60 * 60;
const ERROR_CACHE_TTL_SECONDS = 60;
const QWEATHER_CITY_ALIASES = Object.freeze({
  "åäº¬": "Beijing",
  "ä¸æµ·": "Shanghai",
  "å¹¿å·": "Guangzhou",
  "æ·±å³": "Shenzhen",
  "æ­å·": "Hangzhou",
  "åäº¬": "Nanjing",
  "å¤©æ´¥": "Tianjin",
  "æ­¦æ±": "Wuhan",
  "æé½": "Chengdu",
  "éåº": "Chongqing",
  "è¥¿å®": "Xian",
  "èå·": "Suzhou",
  "éå²": "Qingdao",
  "å¦é¨": "Xiamen",
  "å¤§è¿": "Dalian",
  "å®æ³¢": "Ningbo",
  "æ²é³": "Shenyang",
  "åå°æ»¨": "Harbin",
  "é¿æ¥": "Changchun",
  "é¿æ²": "Changsha",
  "éå·": "Zhengzhou",
  "æµå": "Jinan",
  "ç¦å·": "Fuzhou",
  "åè¥": "Hefei",
  "ææ": "Kunming",
  "åå®": "Nanning",
  "è´µé³": "Guiyang",
  "å°å·": "Lanzhou",
  "å¤ªå": "Taiyuan",
  "ç³å®¶åº": "Shijiazhuang",
  "ä¹é²æ¨é½": "Urumqi",
  "æè¨": "Lhasa",
  "é¦æ¸¯": "Hong Kong",
  "æ¾³é¨": "Macau",
  "å°å": "Taipei",
});
const QWEATHER_CITY_ALIAS_CODES = Object.freeze({
  "5317-4eac": "Beijing",
  "4e0a-6d77": "Shanghai",
  "5e7f-5dde": "Guangzhou",
  "6df1-5733": "Shenzhen",
  "676d-5dde": "Hangzhou",
  "5357-4eac": "Nanjing",
  "5929-6d25": "Tianjin",
  "6b66-6c49": "Wuhan",
  "6210-90fd": "Chengdu",
  "91cd-5e86": "Chongqing",
  "897f-5b89": "Xian",
  "82cf-5dde": "Suzhou",
  "9752-5c9b": "Qingdao",
  "53a6-95e8": "Xiamen",
  "5927-8fde": "Dalian",
  "5b81-6ce2": "Ningbo",
  "6c88-9633": "Shenyang",
  "54c8-5c14-6ee8": "Harbin",
  "957f-6625": "Changchun",
  "957f-6c99": "Changsha",
  "90d1-5dde": "Zhengzhou",
  "6d4e-5357": "Jinan",
  "798f-5dde": "Fuzhou",
  "5408-80a5": "Hefei",
  "6606-660e": "Kunming",
  "5357-5b81": "Nanning",
  "8d35-9633": "Guiyang",
  "5170-5dde": "Lanzhou",
  "592a-539f": "Taiyuan",
  "77f3-5bb6-5e84": "Shijiazhuang",
  "4e4c-9c81-6728-9f50": "Urumqi",
  "62c9-8428": "Lhasa",
  "9999-6e2f": "Hong Kong",
  "6fb3-95e8": "Macau",
  "53f0-5317": "Taipei",
});

async function resolveWeatherLocationsFromSettings(weather, env, ctx) {
  const apiKey = resolveApiKeyFromWeather(weather, env);
  const cities = Array.isArray(weather?.city) ? weather.city : [];
  const trimmedCities = cities
    .map((city) => (typeof city === "string" ? city.trim() : ""))
    .filter(Boolean);
  const queryList = alignWeatherQueries(trimmedCities, normaliseWeatherQueryInput(weather));

  if (trimmedCities.length === 0) {
    return [];
  }

  if (!apiKey) {
    throw new Error("Missing QWeather API Key.");
  }

  const locations = await Promise.all(
    trimmedCities.map(async (city, index) => {
      const location = await geocodeCity(city, apiKey, env, ctx, queryList[index]);
      return {
        city,
        name: location.name || city,
        latitude: location.latitude,
        longitude: location.longitude,
        id: location.id || "",
      };
    })
  );

  return locations;
}

async function fetchAndCache(url, ctx, successTtlSeconds = WEATHER_CACHE_TTL_SECONDS, errorTtlSeconds = ERROR_CACHE_TTL_SECONDS) {
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
          "Accept-Encoding": "identity",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      });

      // Clone the response to be able to read the body for caching and for returning
      const cacheableResponse = response.clone();

      if (response.ok) {
        // If the request was successful, cache it briefly.
        const newHeaders = new Headers(cacheableResponse.headers);
        newHeaders.set("Cache-Control", `public, max-age=${successTtlSeconds}`);

        const cacheResponseForStorage = new Response(cacheableResponse.body, {
          status: cacheableResponse.status,
          statusText: cacheableResponse.statusText,
          headers: newHeaders,
        });
        ctx.waitUntil(cache.put(url, cacheResponseForStorage));
      } else {
        // If the request failed (e.g., 429 rate limit), cache the failure for a short period.
        // This acts as a circuit breaker to prevent hammering the API.
        const newHeaders = new Headers(cacheableResponse.headers);
        newHeaders.set("Cache-Control", `public, max-age=${errorTtlSeconds}`); // Cache failure briefly

        const failedResponseForStorage = new Response(cacheableResponse.body, {
          status: cacheableResponse.status,
          statusText: cacheableResponse.statusText,
          headers: newHeaders,
        });
        ctx.waitUntil(cache.put(url, failedResponseForStorage));
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (!response.ok) {
    throw createWeatherError(`APIè¯·æ±å¤±è´¥: ${response.status}`, response.status);
  }

  return response.json();
}

function buildWeatherData(payload) {
  if (!payload || payload.code !== "200" || typeof payload.now !== "object") {
    const code = payload && typeof payload.code === "string" ? payload.code : "invalid_response";
    throw createWeatherError(`QWeather now error: ${code}.`);
  }

  const now = payload.now;
  const temperature = Number(now.temp);
  const windspeed = Number(now.windSpeed);

  return {
    text: typeof now.text === "string" ? now.text : "Unknown",
    temperature: Number.isFinite(temperature) ? temperature : null,
    windspeed: Number.isFinite(windspeed) ? windspeed : null,
    weathercode: now.icon || now.code || null,
    time: now.obsTime || null,
  };
}

async function geocodeCity(cityName, apiKey, env, ctx, queryOverride = "") {
  const city = typeof cityName === "string" ? cityName.trim() : "";
  if (!city) {
    throw createWeatherError("City name is required.", 400);
  }
  if (!apiKey) {
    throw createWeatherError("Missing QWeather API Key.", 400);
  }
  const rawQuery = typeof queryOverride === "string" ? queryOverride.trim() : "";
  const querySource = rawQuery || city;
  const queryCity = normaliseQWeatherCityName(querySource) || querySource;

  const url = new URL(QWEATHER_GEO_ENDPOINT);
  url.searchParams.set("location", queryCity);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("number", "1");

  let lastError = null;
  for (let attempt = 0; attempt < GEOLOCATION_MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        const delay = GEOLOCATION_RETRY_DELAY_BASE_MS * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const payload = await fetchAndCache(url, ctx, GEO_CACHE_TTL_SECONDS, ERROR_CACHE_TTL_SECONDS);
      if (!payload) {
        throw createWeatherError(`QWeather geocode error: invalid_response (city=${queryCity}).`, 502);
      }
      if (payload.code !== "200" || !Array.isArray(payload.location) || !payload.location[0]) {
        const code = typeof payload.code === "string" ? payload.code : "invalid_response";
        throw createWeatherError(`QWeather geocode error: ${code} (city=${queryCity}).`, 502);
      }

      const result = payload.location[0];
      const latitude = Number(result.lat);
      const longitude = Number(result.lon);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        throw createWeatherError("Invalid location data.", 502);
      }

      return {
        id: result.id || "",
        name: result.name || city,
        latitude,
        longitude,
      };
    } catch (error) {
      lastError = error;
      if (error?.statusCode >= 400 && error.statusCode < 500) {
        throw error;
      }
      console.warn(
        `geocodeCity failed (attempt ${attempt + 1}/${GEOLOCATION_MAX_RETRIES}), retrying...`,
        error.message
      );
    }
  }

  throw lastError || createWeatherError("Failed to resolve city location.", 502);
}

async function fetchQWeatherNowByCity(cityName, apiKey, env, ctx, queryOverride = "") {
  const location = await geocodeCity(cityName, apiKey, env, ctx, queryOverride);
  return fetchQWeatherNowByLocation(location, apiKey, env, ctx);
}

async function fetchQWeatherNowByLocation(location, apiKey, env, ctx) {
  const latitude = Number(location?.latitude);
  const longitude = Number(location?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw createWeatherError("Invalid location data.", 400);
  }
  if (!apiKey) {
    throw createWeatherError("Missing QWeather API Key.", 400);
  }

  const locationQuery = location?.id ? String(location.id) : `${longitude},${latitude}`;
  const url = new URL(QWEATHER_NOW_ENDPOINT);
  url.searchParams.set("location", locationQuery);
  url.searchParams.set("key", apiKey);

  const payload = await fetchAndCache(url, ctx, WEATHER_CACHE_TTL_SECONDS, ERROR_CACHE_TTL_SECONDS);
  return buildWeatherData(payload);
}

function createWeatherError(message, statusCode = 502) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getWeatherDescription(code) {
  const map = {
    0: "æ´å¤©", 1: "æ´æ", 2: "å¤äº", 3: "é´å¤©", 45: "é¾", 48: "å»é¾",
    51: "å°é¨", 53: "ä¸­é¨", 55: "å¤§é¨", 56: "å°å»é¨", 57: "å»é¨",
    61: "å°é¨", 63: "ä¸­é¨", 65: "å¤§é¨", 66: "å°å»é¨", 67: "å»é¨",
    71: "å°éª", 73: "ä¸­éª", 75: "å¤§éª", 77: "éªç²", 80: "éµé¨",
    81: "ä¸­éµé¨", 82: "å¤§éµé¨", 85: "å°éµéª", 86: "å¤§éµéª", 95: "é·é¨",
    96: "é·é¨ä¼´å°é¹", 99: "é·é¨ä¼´å¤§å°é¹",
  };
  return map[code] || "未知";
}

// =================================================================================
// Utility Functions
// =================================================================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json;charset=UTF-8" },
  });
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
