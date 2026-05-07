export function normaliseCollectionItems(collection, type) {
  if (!Array.isArray(collection)) return [];
  return collection.map((item) => ({
    id: typeof item.id === "string" ? item.id : "",
    name: typeof item.name === "string" ? item.name : "",
    url: typeof item.url === "string" ? item.url : "",
    description: typeof item.description === "string" ? item.description : "",
    icon: typeof item.icon === "string" ? item.icon : "",
    ...(type === "bookmarks"
      ? { category: typeof item.category === "string" ? item.category : "" }
      : {}),
  }));
}

export function normalizeUrl(url) {
  if (!url) return "#";
  const trimmed = String(url).trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function appendWeatherCity(buffer, value) {
  if (value === null || value === undefined) {
    return;
  }

  const text = String(value).trim();
  if (!text) {
    return;
  }

  const parts = text.split(/[\s,，、;；]+/).map((item) => item.trim()).filter(Boolean);
  buffer.push(...parts);
}

function collectWeatherCities(raw, buffer) {
  if (raw === null || raw === undefined) {
    return;
  }

  if (typeof raw === "string" || typeof raw === "number") {
    appendWeatherCity(buffer, raw);
    return;
  }

  if (Array.isArray(raw)) {
    raw.forEach((item) => collectWeatherCities(item, buffer));
    return;
  }

  if (typeof raw === "object") {
    if (Object.prototype.hasOwnProperty.call(raw, "city")) {
      collectWeatherCities(raw.city, buffer);
      return;
    }

    if (Object.prototype.hasOwnProperty.call(raw, "weatherLocation")) {
      collectWeatherCities(raw.weatherLocation, buffer);
      return;
    }

    appendWeatherCity(buffer, raw.label);
    appendWeatherCity(buffer, raw.name);
    appendWeatherCity(buffer, raw.id);
  }
}

export function parseWeatherCities(raw) {
  const values = [];
  collectWeatherCities(raw, values);
  const unique = [];
  const seen = new Set();
  values.forEach((city) => {
    const key = city.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    unique.push(city);
  });
  return unique;
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
