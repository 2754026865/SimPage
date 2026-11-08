// Start one bounded image request. Cancellation never invokes application callbacks.
export function loadImage(url, { timeoutMs = 10000, onLoad = () => {}, onError = () => {} } = {}) {
  const timers = window;
  const image = new Image();
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  let settled = false;
  let timer;
  const cleanup = () => {
    timers.clearTimeout(timer);
    image.onload = null;
    image.onerror = null;
  };
  const cancel = () => {
    if (settled) return;
    settled = true;
    cleanup();
    image.removeAttribute("src");
  };
  const finish = (loaded, reason) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (loaded) onLoad(image);
    else {
      image.removeAttribute("src");
      onError(reason);
    }
  };
  image.onload = () => finish(true);
  image.onerror = () => finish(false, "图片请求失败");
  timer = timers.setTimeout(() => finish(false, "加载超时"), timeoutMs);
  try { image.src = url; } catch (_error) { finish(false, "图片请求失败"); }
  return { cancel, image, get pending() { return !settled; } };
}
