// Pure rules shared by the browser and Worker; no environment access here.
export const DEFAULT_SETTINGS = Object.freeze({
  siteName: "SimPage", siteLogo: "", greeting: "", footer: "",
  glassOpacity: 40, useWallpaper: true, wallpaperUrl: "/api/wallpaper",
});
export const DEFAULT_WEATHER_CITY = "北京";
export const WEATHER_MAX_CITIES = 8;

export function normaliseItemFields(input, type, { trim = false } = {}) {
  const source = input && typeof input === "object" ? input : {};
  const result = {};
  const keys = ["id", "name", "url", "description", "icon"];
  if (type === "bookmarks") keys.push("category");
  for (const key of keys) {
    const value = typeof source[key] === "string" ? source[key] : "";
    result[key] = trim ? value.trim() : value;
  }
  return result;
}

export function parseWeatherCities(raw) {
  const cities = [];
  const seen = new Set();
  const visited = new WeakSet();
  function collect(value, depth = 0) {
    if (value === null || value === undefined || depth > 32) return;
    if (typeof value === "string" || typeof value === "number") {
      for (const city of String(value).trim().split(/[\s,，、;；]+/).filter(Boolean)) {
        const key = city.toLowerCase();
        if (!seen.has(key)) { seen.add(key); cities.push(city); }
      }
      return;
    }
    if (typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) value.forEach((item) => collect(item, depth + 1));
    else if (Object.prototype.hasOwnProperty.call(value, "city")) collect(value.city, depth + 1);
    else if (Object.prototype.hasOwnProperty.call(value, "weatherLocation")) collect(value.weatherLocation, depth + 1);
    else for (const key of ["label", "name", "id"]) collect(value[key], depth + 1);
  }
  collect(raw);
  return cities;
}

export function normaliseFooterValue(value) {
  if (typeof value !== "string") return "";
  const normalised = value.replace(/\r\n?/g, "\n");
  return normalised.trim() ? normalised : "";
}

export function normalizeUrl(value, { fallback = "" } = {}) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || /[\u0000-\u001f\u007f]/.test(text)) return fallback;
  if (text.startsWith("/") && !text.startsWith("//") && !text.includes("\\")) return text;
  if (/^[a-z][a-z\d+.-]*:/i.test(text) && !/^https?:\/\//i.test(text)) return fallback;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return fallback;
    return url.href;
  } catch (_error) { return fallback; }
}

export function normaliseVisualSettings(source, defaults = DEFAULT_SETTINGS) {
  const opacity = source?.glassOpacity;
  const rawUrl = typeof source?.wallpaperUrl === "string" ? source.wallpaperUrl.trim() : "";
  return {
    glassOpacity: Number.isFinite(opacity) ? Math.max(0, Math.min(100, Math.round(opacity))) : defaults.glassOpacity,
    useWallpaper: typeof source?.useWallpaper === "boolean" ? source.useWallpaper : defaults.useWallpaper,
    wallpaperUrl: !rawUrl || rawUrl === "https://bing.img.run/uhd.php" ? defaults.wallpaperUrl : rawUrl,
  };
}

export function normaliseSiteSettings(source, { defaults = DEFAULT_SETTINGS, weatherMode = "runtime" } = {}) {
  const input = source && typeof source === "object" ? source : {};
  const fallbackCity = parseWeatherCities(defaults.weather)[0] || DEFAULT_WEATHER_CITY;
  const cities = parseWeatherCities(input.weather ?? input.weatherLocation);
  const resolvedCities = cities.length ? cities : [fallbackCity];
  const weather = weatherMode === "editor"
    ? { city: resolvedCities.join(" ") }
    : resolvedCities.length === 1 ? { city: resolvedCities[0] } : resolvedCities.map((city) => ({ city }));
  return {
    siteName: typeof input.siteName === "string" && input.siteName.trim() ? input.siteName.trim() : defaults.siteName,
    siteLogo: typeof input.siteLogo === "string" ? input.siteLogo.trim() : defaults.siteLogo,
    greeting: typeof input.greeting === "string" ? input.greeting.trim() : defaults.greeting,
    footer: normaliseFooterValue(input.footer ?? defaults.footer),
    ...normaliseVisualSettings(input, defaults), weather,
  };
}
