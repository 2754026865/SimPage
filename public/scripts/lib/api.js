export async function parseJsonSafely(response, fallback = null) {
  try {
    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") throw error;
    return fallback;
  }
}

export async function fetchJson(url, options = {}) {
  const { signal, timeoutMs = 15000, ...fetchOptions } = options;
  const controller = new AbortController();
  const isWrite = !["GET", "HEAD", "OPTIONS"].includes(String(fetchOptions.method || "GET").toUpperCase());
  let rejectAbort;
  const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
  const abort = (reason) => {
    if (controller.signal.aborted) return;
    controller.abort(reason);
    rejectAbort(reason);
  };
  const onAbort = () => abort(signal?.reason || new DOMException("请求已取消", "AbortError"));
  const duration = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000;
  const timer = setTimeout(() => {
    const error = new Error(isWrite ? "请求超时，保存结果尚未确认，请重新读取后再操作。" : "请求超时，请稍后重试。");
    error.name = "TimeoutError";
    error.outcomeUnknown = isWrite;
    abort(error);
  }, duration);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    return await Promise.race([
      aborted,
      (async () => {
        if (controller.signal.aborted) throw controller.signal.reason;
        const response = await fetch(url, { ...fetchOptions, signal: controller.signal });
        const payload = await parseJsonSafely(response, null);
        if (controller.signal.aborted) throw controller.signal.reason;
        return { response, payload };
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
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
