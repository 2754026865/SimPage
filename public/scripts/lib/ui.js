import { normaliseFooterValue } from "./shared.js";
import { loadImage } from "./image.js";
export { normaliseFooterValue };

export function replaceChildrenSafe(target, ...nodes) {
  if (!target) return;
  if (typeof target.replaceChildren === "function") {
    target.replaceChildren(...nodes);
    return;
  }
  target.innerHTML = "";
  nodes.forEach((node) => {
    if (node) {
      target.appendChild(node);
    }
  });
}

export function setDocumentTitle(siteName, { defaultTitle, suffix = "" } = {}) {
  const clean = typeof siteName === "string" ? siteName.trim() : "";
  if (clean) {
    document.title = `${clean}${suffix}`;
    return;
  }
  document.title = defaultTitle || document.title;
}

export function deriveFallbackIcon(name, fallback = "★") {
  if (!name) return fallback;
  const trimmed = String(name).trim();
  return trimmed ? Array.from(trimmed)[0].toUpperCase() : fallback;
}

export function scrollToTop() {
  const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  if (prefersReducedMotion) {
    window.scrollTo(0, 0);
    return;
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

export function setBackToTopVisibility(button, threshold = 320) {
  if (!button) return;
  if (window.scrollY > threshold) {
    if (button.hasAttribute("hidden")) {
      button.removeAttribute("hidden");
    }
    return;
  }
  if (!button.hasAttribute("hidden")) {
    button.setAttribute("hidden", "");
  }
}

function isImageAddress(value) {
  if (/^https?:\/\//i.test(value) || /^data:image\//i.test(value)) return true;
  return value.startsWith("/") && !value.startsWith("//") && !/[\\\u0000-\u0020\u007f]/.test(value);
}

export function createItemIcon({ name, icon, className = "", loading = "lazy" } = {}) {
  const wrapper = document.createElement("span");
  wrapper.className = className;
  const value = typeof icon === "string" ? icon.trim() : "";
  if (isImageAddress(value)) {
    const image = document.createElement("img");
    image.alt = `${name || ""} 图标`;
    image.loading = loading;
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.onerror = () => {
      image.onerror = null;
      wrapper.textContent = deriveFallbackIcon(name);
    };
    wrapper.appendChild(image);
    image.src = value;
  } else {
    wrapper.textContent = value ? Array.from(value).slice(0, 2).join("") : deriveFallbackIcon(name);
  }
  return wrapper;
}

export function createFaviconController({
  faviconLink, defaultHref = "data:,", defaultType = "", defaultSizes = "",
  defaultSymbol = "🧭", emojiColor = "#111827",
} = {}) {
  const faviconCache = new Map();
  const cacheLimit = 16;
  let faviconTaskToken = 0;
  let activeImage = null;
  let lastIdentity = null;

  function applyDefaultFavicon() {
    if (!faviconLink || !defaultHref || defaultHref === "data:,") return false;
    faviconLink.href = defaultHref;
    if (defaultType) faviconLink.setAttribute("type", defaultType);
    else faviconLink.removeAttribute("type");
    if (defaultSizes) faviconLink.setAttribute("sizes", defaultSizes);
    else faviconLink.removeAttribute("sizes");
    return true;
  }

  function createEmojiFavicon(value) {
    const symbol = Array.from(String(value || "").trim())[0] || defaultSymbol;
    if (faviconCache.has(symbol)) {
      const cached = faviconCache.get(symbol);
      faviconCache.delete(symbol);
      faviconCache.set(symbol, cached);
      return cached;
    }
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.clearRect(0, 0, 64, 64);
    context.font = '45px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = emojiColor;
    context.fillText(symbol, 32, 32);
    const dataUrl = canvas.toDataURL("image/png");
    faviconCache.set(symbol, dataUrl);
    if (faviconCache.size > cacheLimit) faviconCache.delete(faviconCache.keys().next().value);
    return dataUrl;
  }

  function applySymbol(symbol) {
    const dataUrl = createEmojiFavicon(symbol);
    if (!dataUrl) return false;
    faviconLink.href = dataUrl;
    faviconLink.setAttribute("type", "image/png");
    faviconLink.setAttribute("sizes", "64x64");
    return true;
  }

  function applyFallback(siteName) {
    if (applyDefaultFavicon() || applySymbol(siteName || defaultSymbol)) return;
    faviconLink.href = defaultHref || "data:,";
    faviconLink.removeAttribute("type");
    faviconLink.removeAttribute("sizes");
  }

  function updateFavicon(rawValue, siteName) {
    if (!faviconLink) return;
    const value = typeof rawValue === "string" ? rawValue.trim() : "";
    const hasDefault = defaultHref && defaultHref !== "data:,";
    const identity = `${value}|${hasDefault ? "" : siteName || ""}`;
    if (identity === lastIdentity) return;
    lastIdentity = identity;
    const taskToken = ++faviconTaskToken;
    activeImage?.cancel();
    activeImage = null;
    if (isImageAddress(value)) {
      applyDefaultFavicon();
      const task = loadImage(value, {
        timeoutMs: 10000,
        onLoad() {
          if (taskToken !== faviconTaskToken) return;
          activeImage = null;
          faviconLink.href = value;
          faviconLink.removeAttribute("type");
          faviconLink.removeAttribute("sizes");
        },
        onError() {
          if (taskToken !== faviconTaskToken) return;
          activeImage = null;
          applyFallback(siteName);
        },
      });
      if (task.pending) activeImage = task;
      return;
    }
    if (value && applySymbol(value)) return;
    applyFallback(siteName);
  }

  return { updateFavicon };
}
