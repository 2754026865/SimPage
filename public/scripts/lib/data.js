import { parseWeatherCities, normaliseItemFields, normalizeUrl as normaliseSharedUrl } from "./shared.js";
export { parseWeatherCities } from "./shared.js";

export function normaliseCollectionItems(collection, type) {
  if (!Array.isArray(collection)) return [];
  return collection.filter((item) => item && typeof item === "object")
    .map((item) => normaliseItemFields(item, type));
}

export function normalizeUrl(url) {
  return normaliseSharedUrl(url, { fallback: "#" });
}

export function normaliseWeatherSettingsForEditor(raw, fallbackCity = "北京") {
  const cities = parseWeatherCities(raw);
  const text = cities.length ? cities.join(" ") : String(fallbackCity || "").trim();
  return { city: text || "北京" };
}

export function normaliseWeatherSettingsForRuntime(raw, fallbackCity = "北京") {
  const fallback = String(fallbackCity || "").trim() || "北京";
  const cities = parseWeatherCities(raw);
  const entries = (cities.length ? cities : [fallback]).map((city) => ({ city }));

  if (entries.length === 1) {
    return entries[0];
  }

  return entries;
}
