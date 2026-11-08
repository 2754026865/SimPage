const WALLPAPER_UPSTREAM_URL = "https://api.bimg.cc/today";
const WALLPAPER_FRESH_SECONDS = 30 * 60;
const WALLPAPER_RETAIN_SECONDS = 24 * 60 * 60;
const WALLPAPER_MAX_BYTES = 8 * 1024 * 1024;
const WEATHER_JSON_MAX_BYTES = 256 * 1024;
const ICON_JSON_MAX_BYTES = 64 * 1024;
const ICON_LINK_API_URL = "https://iconcc.439933.xyz/api/icon";
const ICON_LINK_API_REQUEST_ORIGIN = "https://nav.439933.xyz";
export const WEATHER_MAX_CONCURRENCY = 3;

const jsonSuccess = (payload = {}) => Response.json({ success: true, ...payload });
const jsonFailure = (message, status = 400) => Response.json({ success: false, message }, { status });
const upstreamError = (message, statusCode = 502, extra = {}) => Object.assign(new Error(message), { statusCode, ...extra });

// Returns a bounded immutable body without a second JS-side concatenation buffer.
// The deadline also cancels a stalled stream after headers have arrived.
export async function readLimitedBody(response, maxBytes, signal) {
  if (Number(response.headers.get("Content-Length")) > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw upstreamError("上游响应超出大小限制。");
  }
  if (!response.body) return new Blob();
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        throw upstreamError("上游响应超出大小限制。");
      }
      chunks.push(value);
    }
    return new Blob(chunks);
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export function createUpstreamServices({
  fetch: fetchImpl = (...args) => globalThis.fetch(...args),
  getCache = () => globalThis.caches?.default,
  now = () => Date.now(),
  setTimeout: setTimer = (...args) => globalThis.setTimeout(...args),
  clearTimeout: clearTimer = (id) => globalThis.clearTimeout(id),
  logger = console,
} = {}) {
  const weatherRequests = new Map();
  let wallpaperRequest = null;

  async function withDeadline(operation, milliseconds) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimer(() => {
        const error = new DOMException("上游请求超时。", "AbortError");
        controller.abort(error);
        reject(error);
      }, milliseconds);
    });
    try { return await Promise.race([operation(controller.signal), deadline]); }
    finally { clearTimer(timer); }
  }

  function saveCache(cache, key, response, seconds, ctx) {
    if (!cache) return Promise.resolve();
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", `public, max-age=${seconds}`);
    const stored = new Response(response.body, { status: response.status, headers });
    const task = withDeadline(async (signal) => {
      const cancel = () => { void stored.body?.cancel().catch(() => {}); };
      signal.addEventListener("abort", cancel, { once: true });
      try { await cache.put(key, stored); }
      finally { signal.removeEventListener("abort", cancel); }
    }, 1000).catch(() => {
      logger.warn("Optional upstream cache write failed");
    });
    if (ctx?.waitUntil) ctx.waitUntil(task);
    return task;
  }

  async function readJson(response, maxBytes, signal) {
    const body = await readLimitedBody(response, maxBytes, signal);
    signal?.throwIfAborted();
    const text = await body.text();
    signal?.throwIfAborted();
    try { return JSON.parse(text); }
    catch { throw upstreamError("上游返回的 JSON 格式不正确。"); }
  }

  async function fetchWallpaperImage(signal) {
    let url = new URL(WALLPAPER_UPSTREAM_URL);
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (url.protocol !== "https:" || url.username || url.password || url.port ||
          !(url.hostname === "api.bimg.cc" || url.hostname === "bing.com" || url.hostname.endsWith(".bing.com"))) {
        throw upstreamError("Unsupported wallpaper redirect");
      }
      const response = await fetchImpl(url.href, {
        headers: { Accept: "image/webp,image/*;q=0.9" }, redirect: "manual", signal,
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("Location");
      void response.body?.cancel().catch(() => {});
      if (!location) throw upstreamError("Missing wallpaper redirect location");
      url = new URL(location, url);
    }
    throw upstreamError("Too many wallpaper redirects");
  }

  function wallpaperResponse(record) {
    return new Response(record.body, { headers: {
      "Content-Type": record.contentType,
      "Content-Length": String(record.body.size),
      "Cache-Control": `public, max-age=${WALLPAPER_RETAIN_SECONDS}`,
      "X-Wallpaper-Cached-At": String(record.storedAt),
      "Referrer-Policy": "no-referrer",
    } });
  }

  function refreshWallpaper(cache, key, ctx) {
    if (!wallpaperRequest) {
      const pending = withDeadline(async (signal) => {
        const response = await fetchWallpaperImage(signal);
        const contentType = (response.headers.get("Content-Type") || "").split(";", 1)[0].trim().toLowerCase();
        if (!response.ok || !["image/webp", "image/jpeg", "image/png", "image/avif"].includes(contentType)) {
          void response.body?.cancel().catch(() => {});
          throw upstreamError("Wallpaper upstream did not return an image");
        }
        const body = await readLimitedBody(response, WALLPAPER_MAX_BYTES, signal);
        if (!body.size) throw upstreamError("Empty wallpaper image");
        return { body, contentType, storedAt: now() };
      }, 10000).then((record) => {
        void saveCache(cache, key, wallpaperResponse(record), WALLPAPER_RETAIN_SECONDS, ctx);
        return record;
      });
      // Share only completed immutable bytes, never another request's Response stream.
      wallpaperRequest = pending.finally(() => { wallpaperRequest = null; });
    }
    if (ctx?.waitUntil) ctx.waitUntil(wallpaperRequest.catch(() => {}));
    return wallpaperRequest;
  }

  async function handleGetWallpaper(request, _env, ctx) {
    const cache = getCache();
    const cacheKey = new Request(new URL("/__cache/wallpaper/bimg-v1", request.url));
    let cached = null;
    let cachedAge = Infinity;
    try {
      cached = cache ? await cache.match(cacheKey) : null;
      const storedAt = Number(cached?.headers.get("X-Wallpaper-Cached-At"));
      cachedAge = storedAt > 0 ? (now() - storedAt) / 1000 : Infinity;
      if (cachedAge < 0 || cachedAge >= WALLPAPER_RETAIN_SECONDS) cached = null;
    } catch { /* The cache is optional. */ }
    if (cached && cachedAge < WALLPAPER_FRESH_SECONDS) {
      return wallpaperClientResponse(cached, "hit", Math.max(1, Math.floor(WALLPAPER_FRESH_SECONDS - cachedAge)));
    }
    if (cached && ctx?.waitUntil) {
      ctx.waitUntil(refreshWallpaper(cache, cacheKey, ctx).catch(() => {}));
      return wallpaperClientResponse(cached, "stale", 60);
    }
    try {
      const record = await refreshWallpaper(cache, cacheKey, ctx);
      return wallpaperClientResponse(wallpaperResponse(record), "fresh", WALLPAPER_FRESH_SECONDS);
    } catch (error) {
      if (cached) return wallpaperClientResponse(cached, "stale", 60);
      logger.warn("每日壁纸暂时不可用:", error?.name === "AbortError" ? "上游请求超时" : "上游图片加载失败");
      return new Response(JSON.stringify({ ok: false, error: "每日壁纸暂时不可用" }), {
        status: error?.name === "AbortError" ? 504 : 502,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
  }

  async function handleFetchLogo(request) {
    try {
      const target = new URL(request.url).searchParams.get("targetUrl")?.trim();
      if (!target) return jsonFailure("缺少有效的 targetUrl 参数");
      if (target.length > 2048) return jsonFailure("目标网址长度不能超过 2048 个字符。");
      if (/[\\\u0000-\u0020\u007f]/.test(target)) return jsonFailure("无效的网址。");
      if (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^https?:\/\//i.test(target)) {
        return jsonFailure("网址仅支持 HTTP 或 HTTPS 协议。");
      }
      let siteUrl;
      try { siteUrl = new URL(/^https?:\/\//i.test(target) ? target : `https://${target}`); }
      catch { return jsonFailure("无效的网址。"); }
      if (!["http:", "https:"].includes(siteUrl.protocol) || siteUrl.username || siteUrl.password) {
        return jsonFailure("网址不能包含账号密码或其他协议。");
      }
      const { status, ok, payload } = await withDeadline(async (signal) => {
        const response = await fetchImpl(ICON_LINK_API_URL, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json", Origin: ICON_LINK_API_REQUEST_ORIGIN },
          // Icon discovery only needs the public site origin, never a signed/private path.
          body: JSON.stringify({ url: siteUrl.origin }), signal, redirect: "manual",
        });
        let payload;
        try { payload = await readJson(response, ICON_JSON_MAX_BYTES, signal); }
        catch (error) {
          if (error?.name === "AbortError") throw error;
          payload = null;
        }
        return { status: response.status, ok: response.ok, payload };
      }, 30000);
      if (!ok || !payload?.ok) {
        const message = typeof payload?.error === "string" && payload.error.trim()
          ? payload.error.trim().slice(0, 200) : `图标 API 请求失败（HTTP ${status}）`;
        return jsonFailure(message, status >= 400 && status < 500 ? status : 502);
      }
      const rawLogo = typeof payload.short_url === "string" ? payload.short_url.trim() : "";
      let logo;
      try { logo = new URL(rawLogo); } catch { /* rejected below */ }
      if (rawLogo.length > 2048 || !logo || !["http:", "https:"].includes(logo.protocol) || logo.username || logo.password) {
        return jsonFailure("图标 API 未返回有效的短链。", 502);
      }
      return jsonSuccess({ logoUrl: logo.href });
    } catch (error) {
      if (error?.name === "AbortError") return jsonFailure("获取网站图标超时，请稍后重试。", 504);
      logger.error("调用图标 API 失败");
      return jsonFailure("无法访问图标 API，请稍后重试。", 502);
    }
  }

  async function fetchAndCache(url, ctx) {
    const key = url.toString();
    if (weatherRequests.has(key)) return weatherRequests.get(key);
    if (weatherRequests.size >= 32) throw upstreamError("天气服务繁忙，请稍后重试。", 503);
    const task = withDeadline(async (signal) => {
      const cache = getCache();
      let response;
      try { response = cache ? await cache.match(key) : null; }
      catch { logger.warn("Optional weather cache read failed"); }
      if (response) {
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw upstreamError(`API请求失败: ${response.status}`, response.status, { cachedFailure: true });
        }
        try { return await readJson(response, WEATHER_JSON_MAX_BYTES, signal); }
        catch (error) { if (error?.name === "AbortError") throw error; }
      }
      response = await fetchImpl(key, { signal, headers: { Accept: "application/json" }, redirect: "manual" });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        const negative = new Response(null, { status: response.status });
        void saveCache(cache, key, negative, 60, ctx);
        throw upstreamError(`API请求失败: ${response.status}`, response.status, { cachedFailure: true });
      }
      const payload = await readJson(response, WEATHER_JSON_MAX_BYTES, signal);
      // Cache only fully read, valid bounded JSON; never an unconsumed network clone.
      void saveCache(cache, key, Response.json(payload), 900, ctx);
      return payload;
    }, 5000).finally(() => { weatherRequests.delete(key); });
    weatherRequests.set(key, task);
    if (ctx?.waitUntil) ctx.waitUntil(task.catch(() => {}));
    return task;
  }

  async function geocodeCity(cityName, ctx) {
    const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
    url.searchParams.set("name", cityName);
    url.searchParams.set("count", "1");
    url.searchParams.set("language", "zh");
    url.searchParams.set("format", "json");
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt) await new Promise((resolve) => setTimer(resolve, 300 * 2 ** (attempt - 1)));
        const payload = await fetchAndCache(url, ctx);
        const location = payload?.results?.[0];
        if (!location) throw upstreamError(`未找到城市 "${cityName}" 的地理位置信息。`, 404);
        if (!Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) throw upstreamError("地理位置信息无效。");
        return { latitude: location.latitude, longitude: location.longitude, name: location.name || cityName };
      } catch (error) {
        lastError = error;
        if (error?.cachedFailure || (error?.statusCode >= 400 && error?.statusCode < 500)) throw error;
      }
    }
    throw lastError || upstreamError("地理编码服务获取失败。");
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
    if (!current || !Number.isFinite(current.temperature) || !Number.isFinite(current.weathercode)) {
      throw upstreamError("天气数据格式异常。");
    }
    return {
      text: getWeatherDescription(current.weathercode), temperature: current.temperature,
      windspeed: Number.isFinite(current.windspeed) ? current.windspeed : 0,
      weathercode: current.weathercode, time: typeof current.time === "string" ? current.time : null,
    };
  }
  return { handleGetWallpaper, handleFetchLogo, fetchOpenMeteoWeather, fetchAndCache, geocodeCity };
}

function wallpaperClientResponse(response, state, maxAge) {
  const headers = new Headers(response.headers);
  headers.delete("X-Wallpaper-Cached-At");
  headers.set("Cache-Control", `public, max-age=${maxAge}`);
  headers.set("X-Wallpaper-Cache", state);
  return new Response(response.body, { status: 200, headers });
}

export function getWeatherDescription(code) {
  const descriptions = {
    0: "晴天", 1: "晴朗", 2: "多云", 3: "阴天", 45: "雾", 48: "冻雾",
    51: "小雨", 53: "中雨", 55: "大雨", 56: "小冻雨", 57: "冻雨",
    61: "小雨", 63: "中雨", 65: "大雨", 66: "小冻雨", 67: "冻雨",
    71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒", 80: "阵雨",
    81: "中阵雨", 82: "大阵雨", 85: "小阵雪", 86: "大阵雪", 95: "雷雨",
    96: "雷雨伴冰雹", 99: "雷雨伴大冰雹",
  };
  return descriptions[code] || "未知";
}

export async function runTasksWithConcurrency(tasks, concurrency) {
  if (!Array.isArray(tasks) || !tasks.length) return [];
  const results = new Array(tasks.length);
  let next = 0;
  async function run() {
    while (next < tasks.length) { const index = next++; results[index] = await tasks[index](); }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, run));
  return results;
}

export const { handleGetWallpaper, handleFetchLogo, fetchOpenMeteoWeather } = createUpstreamServices();

