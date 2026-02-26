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

export function normaliseFooterValue(value) {
  if (typeof value !== "string") {
    return "";
  }
  const normalised = value.replace(/\r\n?/g, "\n");
  return normalised.trim() ? normalised : "";
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

export function createFaviconController({
  faviconLink,
  defaultHref = "data:,",
  defaultType = "",
  defaultSizes = "",
  defaultSymbol = "🧭",
  emojiColor = "#111827",
} = {}) {
  const faviconCache = new Map();

  function applyDefaultFavicon() {
    if (!faviconLink) return false;
    if (!defaultHref || defaultHref === "data:,") {
      return false;
    }
    faviconLink.href = defaultHref;
    if (defaultType) {
      faviconLink.setAttribute("type", defaultType);
    } else {
      faviconLink.removeAttribute("type");
    }
    if (defaultSizes) {
      faviconLink.setAttribute("sizes", defaultSizes);
    } else {
      faviconLink.removeAttribute("sizes");
    }
    return true;
  }

  function deriveFaviconSymbol(siteName) {
    if (typeof siteName === "string" && siteName.trim()) {
      const units = Array.from(siteName.trim());
      if (units.length > 0) {
        return units[0];
      }
    }
    return defaultSymbol;
  }

  function createEmojiFavicon(symbolValue) {
    const base = typeof symbolValue === "string" ? symbolValue.trim() : "";
    const units = base ? Array.from(base) : [];
    const symbol = units.length > 0 ? units[0] : defaultSymbol;

    if (faviconCache.has(symbol)) {
      return faviconCache.get(symbol);
    }

    const canvas = document.createElement("canvas");
    const size = 64;
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }

    context.clearRect(0, 0, size, size);
    context.fillStyle = "rgba(0, 0, 0, 0)";
    context.fillRect(0, 0, size, size);
    context.font = `${Math.round(size * 0.7)}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = emojiColor;
    context.fillText(symbol, size / 2, size / 2);

    const dataUrl = canvas.toDataURL("image/png");
    faviconCache.set(symbol, dataUrl);
    return dataUrl;
  }

  function isLogoUrl(value) {
    return typeof value === "string" && (/^https?:\/\//i.test(value) || value.startsWith("data:"));
  }

  function updateFavicon(rawValue, siteName) {
    if (!faviconLink) return;
    const cleanValue = typeof rawValue === "string" ? rawValue.trim() : "";

    if (cleanValue) {
      if (isLogoUrl(cleanValue)) {
        faviconLink.href = cleanValue;
        faviconLink.removeAttribute("type");
        faviconLink.removeAttribute("sizes");
        return;
      }

      const emojiUrl = createEmojiFavicon(cleanValue);
      if (emojiUrl) {
        faviconLink.href = emojiUrl;
        faviconLink.setAttribute("type", "image/png");
        faviconLink.setAttribute("sizes", "64x64");
        return;
      }
    }

    if (applyDefaultFavicon()) {
      return;
    }

    const fallbackUrl = createEmojiFavicon(deriveFaviconSymbol(siteName));
    if (fallbackUrl) {
      faviconLink.href = fallbackUrl;
      faviconLink.setAttribute("type", "image/png");
      faviconLink.setAttribute("sizes", "64x64");
      return;
    }

    if (defaultHref) {
      faviconLink.href = defaultHref;
    } else {
      faviconLink.href = "data:,";
    }
    faviconLink.removeAttribute("type");
    faviconLink.removeAttribute("sizes");
  }

  return {
    updateFavicon,
  };
}
