export async function parseJsonSafely(response, fallback = null) {
  try {
    return await response.json();
  } catch (_error) {
    return fallback;
  }
}

export async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await parseJsonSafely(response, null);
  return { response, payload };
}

export function getPayloadMessage(payload, fallback = "") {
  if (payload && typeof payload === "object" && typeof payload.message === "string") {
    const message = payload.message.trim();
    if (message) {
      return message;
    }
  }
  return fallback;
}

export function getPayloadData(payload) {
  if (payload && typeof payload === "object" && Object.prototype.hasOwnProperty.call(payload, "data")) {
    return payload.data;
  }
  return payload;
}
