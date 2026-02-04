import { renderMarkdown } from "./markdown.js";
import { formatLunar } from "./lunar.js"; // 🆕 导入农历工具
import "./theme-toggle.js";
// 🆕 天气切换间隔
const WEATHER_ROTATION_INTERVAL = 3000;
const siteNameElement = document.getElementById("site-name");
const timeElement = document.getElementById("current-time");
const dateElement = document.getElementById("current-date");
const greetingElement = document.getElementById("greeting-text");
const weatherElement = document.getElementById("weather-info");
const appsGrid = document.getElementById("apps-grid");
const bookmarksGrid = document.getElementById("bookmarks-grid");
const appsEmpty = document.getElementById("apps-empty");
const bookmarksEmpty = document.getElementById("bookmarks-empty");
const appsPanel = document.getElementById("apps-panel");
const bookmarksPanel = document.getElementById("bookmarks-panel");
const collectionToggle = document.getElementById("collection-toggle");
const collectionToggleButtons = collectionToggle
  ? Array.from(collectionToggle.querySelectorAll(".collection-toggle-button"))
  : [];
const searchForm = document.getElementById("global-search-form");
const searchInput = document.getElementById("global-search");
const searchTargetSelect = document.getElementById("search-target");
const searchEngineInput = document.getElementById("search-engine");
const searchEngineWrapper = document.querySelector('.search-select[data-control="engine"]');
const searchEngineButtons = searchEngineWrapper
  ? Array.from(searchEngineWrapper.querySelectorAll(".search-engine-button"))
  : [];
const searchFeedback = document.getElementById("local-search-feedback");
const backToTopButton = document.getElementById("back-to-top");
const footerElement = document.getElementById("site-footer");
const footerContentElement = document.getElementById("site-footer-content");
const footerMetaElement = document.getElementById("site-footer-meta");
const runningDaysElement = document.getElementById("site-running-days");
const faviconLink = document.getElementById("site-favicon");

const dynamicBadgeElement = document.getElementById("dynamic-badge"); // 🆕
const lunarDateElement = document.getElementById("lunar-date"); // 🆕
const todayProgressElement = document.getElementById("today-progress"); // 🆕

// 🆕 浮动卡片元素引用
const floatingCard = document.getElementById("floating-summary");
const compactBadge = document.getElementById("compact-badge");
const compactProgress = document.getElementById("compact-progress");
const compactWeather = document.getElementById("compact-weather");
const expandedBadge = document.getElementById("expanded-badge");
const expandedTime = document.getElementById("expanded-time");
const expandedDate = document.getElementById("expanded-date");
const expandedLunar = document.getElementById("expanded-lunar");
const expandedProgressFull = document.getElementById("expanded-progress-full");
const expandedWeather = document.getElementById("expanded-weather");


const collectionPanels = {
  apps: appsPanel,
  bookmarks: bookmarksPanel,
};




function replaceChildrenSafe(target, ...nodes) {
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

const defaultDocumentTitle = document.title || "SimPage";
const defaultSiteName = siteNameElement?.textContent?.trim() || defaultDocumentTitle || "SimPage";
const defaultWeather = {
  city: "北京",
};
const DEFAULT_SITE_SETTINGS = {
  siteName: defaultSiteName,
  siteLogo: "",
  greeting: "",
  footer: "",
  weather: { ...defaultWeather },
  glassOpacity: 40, // 🆕 添加默认透明�?
  useWallpaper: true, // 🆕 添加
  wallpaperUrl: "https://bing.img.run/uhd.php", // 🆕 添加
};

const defaultFaviconHref = faviconLink?.getAttribute("href") || "data:,";
const defaultFaviconType = faviconLink?.getAttribute("type") || "";
const defaultFaviconSizes = faviconLink?.getAttribute("sizes") || "";
const DEFAULT_FAVICON_SYMBOL = "🧭";
const faviconCache = new Map();
const BACK_TO_TOP_THRESHOLD = 320;

let customGreeting = "";
let yiyanMessage = "";
let footerContentValue = "";
let hasRunningDaysValue = false;

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "long",
});


const runtimeConfig = {
  weather: {
    defaultCity: defaultWeather.city,
  },
};

let activeWeather = { city: runtimeConfig.weather.defaultCity };
let weatherSource = "default";
let weatherRequestToken = 0;

const appsEmptyDefault = appsEmpty ? appsEmpty.textContent : "";
const bookmarksEmptyDefault = bookmarksEmpty ? bookmarksEmpty.textContent : "";

const originalData = {
  apps: [],
  bookmarks: [],
};

let currentSearchTarget = "web";
let activeCollection = "apps";

const searchEngineBuilders = {
  google: (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}`,
  baidu: (query) => `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`,
  bing: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
};

function normaliseFooterValue(value) {
  if (typeof value !== "string") {
    return "";
  }
  const normalised = value.replace(/\r\n?/g, "\n");
  return normalised.trim() ? normalised : "";
}

function setSearchEngine(engine) {
  if (!searchEngineInput) return;
  const resolved = Object.prototype.hasOwnProperty.call(searchEngineBuilders, engine)
    ? engine
    : "google";
  searchEngineInput.value = resolved;
  searchEngineButtons.forEach((button) => {
    const isActive = button.dataset.engineOption === resolved;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
    const tabIndex = searchEngineInput.disabled ? "-1" : isActive ? "0" : "-1";
    button.setAttribute("tabindex", tabIndex);
  });
}

function moveSearchEngineSelection(offset) {
  if (!searchEngineButtons.length || searchEngineInput?.disabled) {
    return;
  }
  const enabledButtons = searchEngineButtons.filter((button) => !button.disabled);
  if (!enabledButtons.length) {
    return;
  }
  const currentValue = searchEngineInput?.value || "google";
  let currentIndex = enabledButtons.findIndex(
    (button) => button.dataset.engineOption === currentValue
  );
  if (currentIndex < 0) {
    currentIndex = 0;
  }
  const nextIndex = (currentIndex + offset + enabledButtons.length) % enabledButtons.length;
  const nextButton = enabledButtons[nextIndex];
  if (!nextButton) {
    return;
  }
  const nextValue = nextButton.dataset.engineOption;
  if (!nextValue) {
    return;
  }
  setSearchEngine(nextValue);
  nextButton.focus();
}

/**
 * 🆕 根据时间获取动态标�?
 */
function getDynamicBadge(hour) {
  if (hour >= 5 && hour < 9) {
    return "☀️ 早安";
  } else if (hour >= 9 && hour < 14) {
    return "🌞 午安";
  } else if (hour >= 14 && hour < 18) {
    return "🌤️ 下午好";
  } else if (hour >= 18 && hour < 22) {
    return "🌙 晚安";
  } else {
    return "⭐ 夜深了";
  }
}

/**
 * 🆕 计算本年第几�?
 */
function getWeekNumber(date) {
  const firstDayOfYear = new Date(date.getFullYear(), 0, 1);
  const pastDaysOfYear = (date - firstDayOfYear) / 86400000;
  return Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
}

/**
 * 🆕 计算今日进度
 */
function getTodayProgress() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const progress = ((now - start) / (end - start)) * 100;
  return Math.round(progress);
}

/**
 * 🆕 渲染进度�?
 */
function renderProgressBar(progress) {
  const totalBlocks = 10;
  const filledBlocks = Math.round((progress / 100) * totalBlocks);
  const emptyBlocks = totalBlocks - filledBlocks;
  
  const filled = '▓'.repeat(filledBlocks);
  const empty = '░'.repeat(emptyBlocks);
  
  return `💡 今日已过 ${progress}% ${filled}${empty}`;
}

/**
 * 🆕 节流函数 - 优化滚动性能
 */
function throttle(func, delay) {
  let lastCall = 0;
  return function (...args) {
    const now = Date.now();
    if (now - lastCall >= delay) {
      lastCall = now;
      func.apply(this, args);
    }
  };
}

/**
 * 🆕 处理浮动卡片显示/隐藏
 */
const FLOATING_THRESHOLD = 300; // 滚动300px后显�?

function handleFloatingVisibility() {
  if (!floatingCard) return;
  
  const scrollY = window.scrollY;
  if (scrollY > FLOATING_THRESHOLD) {
    floatingCard.classList.add('is-visible');
  } else {
    floatingCard.classList.remove('is-visible');
  }
}

/**
 * 🆕 提取天气温度信息
 */
function extractWeatherTemp(weatherText) {
  if (!weatherText) return '🌤️';
  
  // 提取温度
  const tempMatch = weatherText.match(/(-?\d+)°C/);
  const temp = tempMatch ? `${tempMatch[1]}°C` : '';
  
  // 提取天气图标
  const weatherIcon = weatherText.includes('晴') ? '☀️' : 
                     weatherText.includes('云') ? '☁️' :
                     weatherText.includes('雨') ? '🌧️' :
                     weatherText.includes('雪') ? '❄️' : '🌤️';
  
  return temp ? `${weatherIcon} ${temp}` : weatherIcon;
}

/**
 * 🆕 更新浮动卡片内容
 */
function updateFloatingCard() {
  if (!floatingCard) return;
  
  const now = new Date();
  const hour = now.getHours();
  
  // 获取动态数�?
  const badge = getDynamicBadge(hour);
  const time = timeFormatter.format(now);
  const timeShort = time.substring(0, 5); // 只取 HH:MM
  const date = dateFormatter.format(now);
  const lunar = formatLunar(now);
  const weekNum = getWeekNumber(now);
  const progress = getTodayProgress();
  const progressBar = renderProgressBar(progress);
  const weatherText = weatherElement ? weatherElement.textContent : '';
  
  // 更新紧凑模式
  if (compactBadge) {
    const badgeEmoji = badge.split(' ')[0]; // 提取 emoji
    compactBadge.textContent = `${badgeEmoji} ${timeShort}`;
  }
  
  if (compactProgress) {
    compactProgress.textContent = `💡 ${progress}%`;
  }
  
  if (compactWeather) {
    compactWeather.textContent = extractWeatherTemp(weatherText);
  }
  
  // 更新展开模式
  if (expandedBadge) {
    expandedBadge.textContent = badge;
  }
  
  if (expandedTime) {
    expandedTime.textContent = time;
  }
  
  if (expandedDate) {
    expandedDate.textContent = date;
  }
  
  if (expandedLunar) {
    expandedLunar.textContent = `${lunar} · 第${weekNum}周`;
  }
  
  if (expandedProgressFull) {
    expandedProgressFull.textContent = progressBar;
  }
  
  if (expandedWeather) {
    expandedWeather.textContent = weatherText;
  }
}


function updateClock() {
  const now = new Date();
  const hour = now.getHours();
  
  // 更新时间
  if (timeElement) {
    timeElement.textContent = timeFormatter.format(now);
  }
  
  // 更新日期
  if (dateElement) {
    dateElement.textContent = dateFormatter.format(now);
  }
  
  // 🆕 更新动态标�?
  if (dynamicBadgeElement) {
    dynamicBadgeElement.textContent = getDynamicBadge(hour);
  }
  
  // 🆕 更新农历和周�?
  if (lunarDateElement) {
    const lunar = formatLunar(now);
    const weekNum = getWeekNumber(now);
    lunarDateElement.textContent = `${lunar} · 第${weekNum}周`;
  }
  
  // 🆕 更新今日进度
  if (todayProgressElement) {
    const progress = getTodayProgress();
    todayProgressElement.textContent = renderProgressBar(progress);
  }
  
  // 更新问候语
  updateGreetingDisplay(hour);

  // 🆕 更新浮动卡片（关键！�?
  updateFloatingCard();
}


function getGreeting(hour) {
  if (hour < 5) return "夜深了，注意休息";
  if (hour < 9) return "早上好，开启活力新一天";
  if (hour < 12) return "上午好，继续保持效率";
  if (hour < 14) return "中午好，记得适当放松";
  if (hour < 18) return "下午好，进展顺利";
  if (hour < 22) return "晚上好，辛苦啦";
  return "夜深了，注意休息";
}

function updateGreetingDisplay(hour = new Date().getHours()) {
  if (!greetingElement) return;

  const hasCustomGreeting = Boolean(customGreeting);
  const shouldUseYiyan = !hasCustomGreeting && Boolean(yiyanMessage);

  if (greetingElement.classList) {
    greetingElement.classList.toggle("is-yiyan", shouldUseYiyan);
  }

  if (hasCustomGreeting) {
    greetingElement.textContent = customGreeting;
    return;
  }
  if (shouldUseYiyan) {
    greetingElement.textContent = yiyanMessage;
    return;
  }
  greetingElement.textContent = getGreeting(hour);
}

async function loadData() {
  try {
    const response = await fetch("/api/data");
    if (!response.ok) {
      throw new Error("数据拉取失败");
    }
    const payload = await response.json();
    const data = payload && typeof payload === "object" && "data" in payload ? payload.data : payload;

    applySiteSettings(data?.settings);
    updateRunningDays(data?.runningDays, data?.siteStartDate); // 🆕 修改这里
    applyRuntimeConfig(data?.config);

    originalData.apps = prepareCollection(data?.apps, "apps");
    originalData.bookmarks = prepareCollection(data?.bookmarks, "bookmarks");
    renderApps(originalData.apps);
    renderBookmarks(originalData.bookmarks);
    hideLocalSearchFeedback();
  } catch (error) {
    console.error("加载数据失败", error);
    renderApps([], { emptyMessage: "加载应用数据失败，请稍后重试。" });
    renderBookmarks([], { emptyMessage: "加载书签数据失败，请稍后重试。" });
    hideLocalSearchFeedback();
  }
}

function prepareCollection(collection, type) {
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

function prepareSiteSettings(settings) {
  const prepared = {
    ...DEFAULT_SITE_SETTINGS,
    weather: { ...DEFAULT_SITE_SETTINGS.weather },
  };
  if (!settings || typeof settings !== "object") {
    return prepared;
  }
  if (typeof settings.siteName === "string" && settings.siteName.trim()) {
    prepared.siteName = settings.siteName.trim();
  }
  if (typeof settings.siteLogo === "string") {
    prepared.siteLogo = settings.siteLogo.trim();
  }
  if (typeof settings.greeting === "string") {
    prepared.greeting = settings.greeting.trim();
  }
  if (typeof settings.footer === "string") {
    prepared.footer = normaliseFooterValue(settings.footer);
  }
  // 🆕 添加透明度处�?
  if (typeof settings.glassOpacity === "number") {
    const opacity = Math.max(0, Math.min(100, Math.round(settings.glassOpacity)));
    prepared.glassOpacity = opacity;
  }
  // 🆕 添加 useWallpaper 处理
  if (typeof settings.useWallpaper === "boolean") {
    prepared.useWallpaper = settings.useWallpaper;
  }
  // 🆕 添加壁纸 URL 处理
  if (typeof settings.wallpaperUrl === "string") {
    const trimmed = settings.wallpaperUrl.trim();
    if (trimmed) {
      prepared.wallpaperUrl = trimmed;
    }
  }


  const weather = normaliseWeatherSetting(settings.weather);
  if (weather) {
    prepared.weather = weather;
  } else if (settings.weatherLocation) {
    const legacyWeather = normaliseWeatherSetting(settings.weatherLocation);
    if (legacyWeather) {
      prepared.weather = legacyWeather;
    }
  }

  return prepared;
}

/**
 * 应用容器透明�?
 */
function applyGlassOpacity(opacity) {
  const value = typeof opacity === "number" ? opacity : 40;
  const normalised = Math.max(0, Math.min(100, value));
  const opacityValue = normalised / 100;
  document.documentElement.style.setProperty('--glass-opacity', opacityValue);
}


function applySiteSettings(settings) {
  const prepared = prepareSiteSettings(settings);
  customGreeting = prepared.greeting;

  if (siteNameElement) {
    siteNameElement.textContent = prepared.siteName;
  }
  updateDocumentTitle(prepared.siteName);
  updateFavicon(prepared.siteLogo, prepared.siteName);
  updateGreetingDisplay();
  updateFooter(prepared.footer);
  setActiveWeather(prepared.weather, { source: "settings" });
  applyGlassOpacity(prepared.glassOpacity); // 🆕 应用透明�?
  // 🆕 根据开关决定是否加载壁�?
  if (prepared.useWallpaper) {
    loadWallpaper(prepared.wallpaperUrl);
  } else {
    removeWallpaper();
  }
}

/**
 * 移除壁纸背景
 */
function removeWallpaper() {
  const container = document.getElementById('wallpaper-container');
  if (!container) {
    return;
  }
  
  console.log('🚫 移除壁纸背景');
  container.classList.remove('loaded');
  container.style.backgroundImage = '';
  container.style.opacity = '0';
}


function updateDocumentTitle(siteName) {
  const clean = typeof siteName === "string" ? siteName.trim() : "";
  document.title = clean || defaultDocumentTitle;
}

function applyDefaultFavicon() {
  if (!faviconLink) return false;
  if (!defaultFaviconHref || defaultFaviconHref === "data:,") {
    return false;
  }
  faviconLink.href = defaultFaviconHref;
  if (defaultFaviconType) {
    faviconLink.setAttribute("type", defaultFaviconType);
  } else {
    faviconLink.removeAttribute("type");
  }
  if (defaultFaviconSizes) {
    faviconLink.setAttribute("sizes", defaultFaviconSizes);
  } else {
    faviconLink.removeAttribute("sizes");
  }
  return true;
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

  if (defaultFaviconHref) {
    faviconLink.href = defaultFaviconHref;
  } else {
    faviconLink.href = "data:,";
  }
  faviconLink.removeAttribute("type");
  faviconLink.removeAttribute("sizes");
}

function updateFooter(rawContent) {
  if (!footerElement || !footerContentElement) return;
  const clean = normaliseFooterValue(rawContent);
  footerContentValue = clean;
  if (!clean) {
    footerContentElement.innerHTML = "";
    footerContentElement.setAttribute("hidden", "");
  } else {
    footerContentElement.innerHTML = renderMarkdown(clean);
    footerContentElement.removeAttribute("hidden");
  }
  refreshFooterVisibility();
}

function updateRunningDays(runningDays, siteStartDate) {
  if (!footerElement || !footerMetaElement || !runningDaysElement) return;
  
  const parsed = Number(runningDays);
  const hasValidValue = Number.isFinite(parsed);
  const hasStartDate = typeof siteStartDate === "string" && siteStartDate.trim().length > 0;
  const days = hasValidValue ? Math.max(0, Math.floor(parsed)) : 0;
  
  runningDaysElement.textContent = days;
  
  // ?? ???????????????? 0 ??
  hasRunningDaysValue = hasValidValue && hasStartDate;
  footerMetaElement.hidden = !hasRunningDaysValue;
  
  refreshFooterVisibility();
}


function refreshFooterVisibility() {
  if (!footerElement) return;
  const hasContent = Boolean(footerContentValue);
  const shouldShowFooter = hasContent || hasRunningDaysValue; // ?? ??
  footerElement.hidden = !shouldShowFooter;
}

function deriveFaviconSymbol(siteName) {
  if (typeof siteName === "string" && siteName.trim()) {
    const units = Array.from(siteName.trim());
    if (units.length > 0) {
      return units[0];
    }
  }
  return DEFAULT_FAVICON_SYMBOL;
}

function createEmojiFavicon(symbolValue) {
  const base = typeof symbolValue === "string" ? symbolValue.trim() : "";
  const units = base ? Array.from(base) : [];
  const symbol = units.length > 0 ? units[0] : DEFAULT_FAVICON_SYMBOL;

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
  context.fillStyle = "#111827";
  context.fillText(symbol, size / 2, size / 2);

  const dataUrl = canvas.toDataURL("image/png");
  faviconCache.set(symbol, dataUrl);
  return dataUrl;
}

function isLogoUrl(value) {
  return /^https?:\/\//i.test(value) || value.startsWith("data:");
}

function showCollection(view, { focusTab = false } = {}) {
  if (view !== "apps" && view !== "bookmarks") {
    return;
  }
  activeCollection = view;

  collectionToggleButtons.forEach((button) => {
    const target = button.dataset.view;
    const isActive = target === view;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", String(isActive));
    button.setAttribute("tabindex", isActive ? "0" : "-1");
    if (isActive && focusTab) {
      button.focus();
    }
  });

  Object.entries(collectionPanels).forEach(([key, panel]) => {
    if (!panel) return;
    const isActive = key === view;
    panel.classList.toggle("is-active", isActive);
    if (isActive) {
      panel.removeAttribute("hidden");
    } else {
      panel.setAttribute("hidden", "");
    }
  });
}

function renderApps(items, options = {}) {
  renderTileGrid(appsGrid, appsEmpty, items, {
    emptyMessage: options.emptyMessage,
    defaultMessage: appsEmptyDefault,
  });
}

function renderTileGrid(container, emptyHint, items, { emptyMessage, defaultMessage } = {}) {
  if (!container || !emptyHint) return;

  if (!Array.isArray(items) || !items.length) {
    replaceChildrenSafe(container);
    emptyHint.hidden = false;
    if (emptyMessage) {
      emptyHint.textContent = emptyMessage;
    } else if (typeof defaultMessage === "string") {
      emptyHint.textContent = defaultMessage;
    }
    return;
  }

  emptyHint.hidden = true;
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    fragment.appendChild(createTile(item));
  }
  replaceChildrenSafe(container, fragment);
}

function renderBookmarks(items, options = {}) {
  if (!bookmarksGrid || !bookmarksEmpty) return;

  if (!Array.isArray(items) || !items.length) {
    replaceChildrenSafe(bookmarksGrid);
    bookmarksEmpty.hidden = false;
    if (options.emptyMessage) {
      bookmarksEmpty.textContent = options.emptyMessage;
    } else {
      bookmarksEmpty.textContent = bookmarksEmptyDefault;
    }
    return;
  }

  bookmarksEmpty.hidden = true;
  const groups = groupBookmarksByCategory(items);
  const gridFragment = document.createDocumentFragment();

  groups.forEach((group) => {
    const groupElement = document.createElement("section");
    groupElement.className = "bookmark-group";

    const shouldShowTitle = !group.isUncategorised || groups.length > 1;
    if (shouldShowTitle) {
      const title = document.createElement("h3");
      title.className = "bookmark-group-title";
      title.textContent = group.label;
      groupElement.appendChild(title);
    }

    const list = document.createElement("div");
    list.className = "grid";
    list.setAttribute("role", "list");

    const tilesFragment = document.createDocumentFragment();
    group.items.forEach((item) => {
      tilesFragment.appendChild(createTile(item));
    });
    list.appendChild(tilesFragment);

    groupElement.appendChild(list);
    gridFragment.appendChild(groupElement);
  });

  replaceChildrenSafe(bookmarksGrid, gridFragment);
}

function groupBookmarksByCategory(items) {
  const groups = [];
  const map = new Map();

  items.forEach((item) => {
    const rawLabel = typeof item.category === "string" ? item.category.trim() : "";
    const key = rawLabel.toLowerCase() || "__uncategorised__";
    let group = map.get(key);

    if (!group) {
      group = {
        key,
        label: rawLabel || "未分类",
        items: [],
        isUncategorised: !rawLabel,
      };
      map.set(key, group);
      groups.push(group);
    }

    group.items.push(item);
  });

  return groups;
}

function createTile(item) {
  const link = document.createElement("a");
  link.className = "tile";
  link.href = normalizeUrl(item.url);
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.setAttribute("role", "listitem");

  const iconWrapper = document.createElement("span");
  iconWrapper.className = "tile-icon";
  const iconContent = String(item.icon || "").trim();

  if (iconContent.startsWith("http://") || iconContent.startsWith("https://") || iconContent.startsWith("data:")) {
    const img = document.createElement("img");
    img.src = iconContent;
    img.alt = `${item.name || ""} 图标`;
    iconWrapper.appendChild(img);
  } else if (iconContent.length > 0) {
    iconWrapper.textContent = iconContent.slice(0, 4);
  } else {
    iconWrapper.textContent = deriveFallbackIcon(item.name);
  }

  const title = document.createElement("h3");
  title.className = "tile-title";
  title.textContent = item.name || "未命名";

  const description = document.createElement("p");
  description.className = "tile-description";
  const descriptionText = typeof item.description === "string" ? item.description.trim() : "";
  if (descriptionText) {
    description.textContent = descriptionText;
  } else {
    description.classList.add("is-empty");
    description.setAttribute("aria-hidden", "true");
  }

  link.appendChild(iconWrapper);
  link.appendChild(title);
  link.appendChild(description);

  return link;
}

function deriveFallbackIcon(name) {
  if (!name) return "★";
  const trimmed = name.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : "★";
}

function normalizeUrl(url) {
  if (!url) return "#";
  const trimmed = String(url).trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function performLocalSearch(target, query) {
  if (target !== "apps" && target !== "bookmarks") {
    return;
  }
  const trimmed = query.trim();
  if (!trimmed) {
    showCollection(target);
    clearLocalSearchResults();
    return;
  }

  showCollection(target);

  const dataset = target === "apps" ? originalData.apps : originalData.bookmarks;
  const keywords = trimmed.toLowerCase();

  const matches = dataset.filter((item) => {
    const pack = [item.name, item.description];
    if (target === "bookmarks") {
      pack.push(item.category);
    }
    return pack
      .filter((value) => typeof value === "string" && value)
      .some((value) => value.toLowerCase().includes(keywords));
  });

  if (target === "apps") {
    renderApps(matches, { emptyMessage: `未找到与「${trimmed}」匹配的应用。` });
    renderBookmarks(originalData.bookmarks);
  } else {
    renderApps(originalData.apps);
    renderBookmarks(matches, { emptyMessage: `未找到与「${trimmed}」匹配的书签。` });
  }

  updateLocalSearchFeedback(matches.length, target, trimmed);
}

function clearLocalSearchResults() {
  renderApps(originalData.apps);
  renderBookmarks(originalData.bookmarks);
  hideLocalSearchFeedback();
  showCollection(activeCollection);
}

function updateLocalSearchFeedback(count, target, query) {
  if (!searchFeedback) return;
  const label = target === "apps" ? "应用" : "书签";
  const message = count
    ? `共找到 ${count} 条${label}结果，关键词：${query}`
    : `未找到与「${query}」匹配的${label}。`;
  searchFeedback.textContent = message;
  searchFeedback.hidden = false;
}

function hideLocalSearchFeedback() {
  if (!searchFeedback) return;
  searchFeedback.hidden = true;
  searchFeedback.textContent = "";
}

function handleSearchSubmit(event) {
  if (!searchForm || !searchTargetSelect || !searchInput) return;
  event.preventDefault();

  const query = searchInput.value.trim();
  const target = searchTargetSelect.value;

  if (!query) {
    if (target === "web") {
      return;
    }
    clearLocalSearchResults();
    return;
  }

  if (target === "web") {
    const engineKey = searchEngineInput ? searchEngineInput.value : "google";
    const builder = searchEngineBuilders[engineKey] || searchEngineBuilders.google;
    const url = builder(query);
    window.open(url, "_blank", "noopener");
    hideLocalSearchFeedback();
    return;
  }

  performLocalSearch(target, query);
}

function updateSearchControls() {
  if (!searchTargetSelect) return;
  const nextTarget = searchTargetSelect.value;
  const isWebSearch = nextTarget === "web";

  if (searchEngineWrapper) {
    searchEngineWrapper.hidden = !isWebSearch;
  }
  if (searchEngineInput) {
    searchEngineInput.disabled = !isWebSearch;
  }
  if (searchEngineButtons.length) {
    searchEngineButtons.forEach((button) => {
      button.disabled = !isWebSearch;
    });
  }
  if (searchEngineInput) {
    setSearchEngine(searchEngineInput.value || "google");
  }

  const hasChanged = currentSearchTarget !== nextTarget;
  currentSearchTarget = nextTarget;

  if (isWebSearch) {
    if (hasChanged) {
      clearLocalSearchResults();
    } else {
      hideLocalSearchFeedback();
    }
    return;
  }

  showCollection(nextTarget);

  if (!searchInput) return;

  if (searchInput.value.trim()) {
    performLocalSearch(nextTarget, searchInput.value);
  } else if (hasChanged) {
    clearLocalSearchResults();
  }
}

function formatYiyanQuote(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const sentence = typeof payload.hitokoto === "string" ? payload.hitokoto.trim() : "";
  if (!sentence) {
    return "";
  }
  const sources = [];
  const fromWho = typeof payload.from_who === "string" ? payload.from_who.trim() : "";
  const origin = typeof payload.from === "string" ? payload.from.trim() : "";
  if (fromWho) {
    sources.push(fromWho);
  }
  if (origin && sources.indexOf(origin) === -1) {
    sources.push(origin);
  }
  if (!sources.length) {
    return sentence;
  }
  return `${sentence} —— ${sources.join(" · ")}`;
}

async function loadYiyanQuote() {
  if (!greetingElement) return;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timeoutId = null;
  try {
    if (controller) {
      timeoutId = setTimeout(() => controller.abort(), 5000);
    }
    const options = { cache: "no-cache" };
    if (controller) {
      options.signal = controller.signal;
    }
    const response = await fetch("https://v1.hitokoto.cn/?encode=json", options);
    if (!response.ok) {
      throw new Error("一言接口请求失败");
    }
    const data = await response.json();
    const message = formatYiyanQuote(data);
    if (message) {
      yiyanMessage = message;
      updateGreetingDisplay();
    }
  } catch (error) {
    console.error("一言获取失败", error);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function normaliseWeatherSetting(raw) {
  // 🆕 处理对象格式 { city: ["北京", "上海"] }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    if (Array.isArray(raw.city)) {
      // �?{ city: ["北京", "上海"] } 转换�?[{ city: "北京" }, { city: "上海" }]
      return raw.city
        .map(cityName => {
          const trimmed = String(cityName).trim();
          return trimmed ? { city: trimmed } : null;
        })
        .filter(item => item !== null);
    } else if (typeof raw.city === "string") {
      const trimmed = raw.city.trim();
      return trimmed ? [{ city: trimmed }] : null;
    }
  }
  // 处理数组或单个�?
  if (Array.isArray(raw)) {
    return raw.map(item => {
      if (typeof item === "string") {
        const trimmed = item.trim();
        return trimmed ? { city: trimmed } : null;
      }
      if (!item || typeof item !== "object") {
        return null;
      }
      if (typeof item.city === "string" && item.city.trim()) {
        return { city: item.city.trim() };
      }
      if (typeof item.label === "string" && item.label.trim()) {
        return { city: item.label.trim() };
      }
      if (typeof item.name === "string" && item.name.trim()) {
        return { city: item.name.trim() };
      }
      if (typeof item.id === "string" && item.id.trim()) {
        return { city: item.id.trim() };
      }
      return null;
    }).filter(item => item !== null);
  }

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed ? { city: trimmed } : null;
  }
  if (!raw || typeof raw !== "object") {
    return null;
  }
  if (typeof raw.city === "string" && raw.city.trim()) {
    return { city: raw.city.trim() };
  }
  if (typeof raw.label === "string" && raw.label.trim()) {
    return { city: raw.label.trim() };
  }
  if (typeof raw.name === "string" && raw.name.trim()) {
    return { city: raw.name.trim() };
  }
  if (typeof raw.id === "string" && raw.id.trim()) {
    return { city: raw.id.trim() };
  }
  return null;
}

function getDefaultWeather() {
  const cityCandidate =
    typeof runtimeConfig.weather?.defaultCity === "string"
      ? runtimeConfig.weather.defaultCity.trim()
      : "";
  const city = cityCandidate || defaultWeather.city;
  runtimeConfig.weather.defaultCity = city;
  return { city };
}

function applyRuntimeConfig(config) {
  if (!config || typeof config !== "object") {
    return;
  }
  const city =
    typeof config.weather?.defaultCity === "string" ? config.weather.defaultCity.trim() : "";
  if (city) {
    runtimeConfig.weather.defaultCity = city;
    if (weatherSource !== "settings") {
      setActiveWeather({ city }, { source: "default" });
    }
  }
}


function updateActiveWeather(weather) {
  if (!weather) {
    return;
  }
  
  // 🆕 支持数组格式
  if (Array.isArray(weather)) {
    activeWeather = weather;
  } else {
    activeWeather = { city: weather.city };
  }
  
  refreshWeatherDisplay();
}


function setActiveWeather(rawWeather, { source = "settings" } = {}) {
  let weather = normaliseWeatherSetting(rawWeather);
  if (!weather || (Array.isArray(weather) && weather.length === 0)) {
    if (source === "settings") {
      weatherSource = "default";
      updateActiveWeather(getDefaultWeather());
    }
    return;
  }
  if (source === "settings") {
    weatherSource = "settings";
    // 🔧 直接传递数组，不要转换为单个对�?
    updateActiveWeather(weather);
    return;
  }
  if (weatherSource !== "settings") {
    weatherSource = "default";
    // 🔧 直接传递数组，不要转换为单个对�?
    updateActiveWeather(weather);
  }
}


function refreshWeatherDisplay() {
  if (!weatherElement) return;
  
  // 🆕 处理数组格式
  const weather = Array.isArray(activeWeather) && activeWeather.length > 0
    ? activeWeather
    : (activeWeather && activeWeather.city ? activeWeather : getDefaultWeather());
  
  updateWeather(weather);
}


/**
 * 🆕 根据天气状况返回对应的emoji图标
 */
function getWeatherEmoji(condition) {
  const emojiMap = {
    '晴': '☀️',
    '多云': '⛅',
    '阴': '☁️',
    '小雨': '🌦️',
    '中雨': '🌧️',
    '大雨': '⛈️',
    '暴雨': '⛈️',
    '雷阵雨': '⛈️',
    '雨夹雪': '🌨️',
    '小雪': '🌨️',
    '中雪': '❄️',
    '大雪': '❄️',
    '暴雪': '❄️',
    '雾': '🌫️',
    '霾': '😷',
    '沙尘': '🌪️',
    '风': '💨'
  };
  
  // 模糊匹配
  for (const [key, emoji] of Object.entries(emojiMap)) {
    if (condition.includes(key)) {
      return emoji;
    }
  }
  
  return '🌤️'; // 默认图标
}


function formatWeatherItem(item) {
  if (!item || typeof item !== "object") {
    return "";
  }
  const condition = typeof item.text === "string" ? item.text.trim() : "";
  const city = typeof item.city === "string" ? item.city.trim() : "";
  const temperature = Number(item.temperature);
  const temperatureText = Number.isFinite(temperature) ? `${Math.round(temperature)}°C` : "";
  const emoji = condition ? getWeatherEmoji(condition) : "🌤�?";
  const cityLabel = city ? `${city} · ` : "";
  const detail = condition || "天气良好";
  const suffix = temperatureText ? ` ${temperatureText}` : "";
  return `${emoji} ${cityLabel}${detail}${suffix}`.trim();
}

function getFallbackCity(weather) {
  if (Array.isArray(weather)) {
    for (const entry of weather) {
      if (entry && typeof entry.city === "string" && entry.city.trim()) {
        return entry.city.trim();
      }
    }
  } else if (weather && typeof weather.city === "string" && weather.city.trim()) {
    return weather.city.trim();
  }
  return "";
}

async function updateWeather(weather, retryCount = 0) {
  if (!weatherElement) return;
  const requestToken = ++weatherRequestToken;
  const maxRetries = 2;
  const retryDelay = 1000;

  try {
    const response = await fetch("/api/weather", { cache: "no-cache" });
    let payload;
    try {
      payload = await response.json();
    } catch (_error) {
      throw new Error("天气服务响应异常");
    }

    if (!response.ok || !payload || payload.success !== true) {
      const message = payload?.message || "天气数据请求失败";
      throw new Error(message);
    }

    if (requestToken !== weatherRequestToken) {
      return;
    }

    const data = Array.isArray(payload.data) ? payload.data : [];
    const formatted = data.map(formatWeatherItem).filter(Boolean);

    if (!formatted.length) {
      throw new Error("天气数据格式异常");
    }

    if (weatherRotationInterval) {
      clearInterval(weatherRotationInterval);
      weatherRotationInterval = null;
    }

    if (formatted.length > 1) {
      startWeatherRotation(formatted);
      return;
    }

    weatherElement.textContent = formatted[0];
    updateFloatingCard();
  } catch (error) {
    updateFloatingCard();
    console.error("天气数据获取失败", error);

    if (weatherRotationInterval) {
      clearInterval(weatherRotationInterval);
      weatherRotationInterval = null;
    }

    weatherElement.textContent = "天气信息获取失败";

    if (requestToken !== weatherRequestToken) {
      return;
    }

    if (retryCount < maxRetries) {
      console.log(`将在 ${retryDelay}ms 后重试（尝试 ${retryCount + 1}/${maxRetries}）...`);
      setTimeout(() => {
        if (requestToken === weatherRequestToken) {
          updateWeather(weather, retryCount + 1);
        }
      }, retryDelay);
      return;
    }

    const fallbackCity = getFallbackCity(weather) || getDefaultWeather().city;
    const locationLabel = fallbackCity ? `${fallbackCity} · ` : "";
    const rawMessage = error && typeof error.message === "string" ? error.message.trim() : "";
    const message = rawMessage && /[\u4e00-\u9fff]/.test(rawMessage) ? rawMessage : "天气信息暂不可用";
    weatherElement.textContent = `${locationLabel}${message}`.trim();
  }
}
let weatherRotationInterval = null;


function startWeatherRotation(weatherInfo) {
  if (weatherRotationInterval) {
    clearInterval(weatherRotationInterval);
  }

  if (!weatherInfo || weatherInfo.length === 0) {
    return;
  }

  let index = 0;
  weatherElement.textContent = weatherInfo[index];
  updateFloatingCard();

  if (weatherInfo.length > 1) {
    index = 1;
    weatherRotationInterval = setInterval(() => {
      weatherElement.textContent = weatherInfo[index];
      updateFloatingCard();
      index = (index + 1) % weatherInfo.length;
    }, WEATHER_ROTATION_INTERVAL);  // 👈 使用常量
  }
}




function scrollToTop() {
  const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  if (prefersReducedMotion) {
    window.scrollTo(0, 0);
    return;
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function handleBackToTopVisibility() {
  if (!backToTopButton) return;
  if (window.scrollY > BACK_TO_TOP_THRESHOLD) {
    if (backToTopButton.hasAttribute("hidden")) {
      backToTopButton.removeAttribute("hidden");
    }
  } else if (!backToTopButton.hasAttribute("hidden")) {
    backToTopButton.setAttribute("hidden", "");
  }
}

/**
 * 加载壁纸
 * @param {string} wallpaperUrl - 壁纸图片 URL
 */
async function loadWallpaper(wallpaperUrl) {
  const container = document.getElementById('wallpaper-container');
  if (!container) {
    console.warn('⚠️ 壁纸容器不存在');
    return;
  }
  
  // 使用传入�?URL，如果为空则使用默认�?
  const url = (wallpaperUrl && wallpaperUrl.trim()) || 'https://bing.img.run/uhd.php';
  
  console.log('🖼�?开始加载壁�?', url);
  
  try {
    const img = new Image();
    
    img.onload = () => {
      container.style.backgroundImage = `url('${url}')`;
      container.classList.add('loaded');
      console.log('�?壁纸加载成功:', url);
    };
    
    img.onerror = () => {
      console.warn('⚠️ 壁纸加载失败:', url);
      // 如果加载失败且不是默认壁纸，尝试使用默认 Bing 壁纸
      if (url !== 'https://bing.img.run/uhd.php') {
        console.log('🔄 尝试加载默认壁纸...');
        loadWallpaper('https://bing.img.run/uhd.php');
      } else {
        // 默认壁纸也加载失败，保持原有渐变背景
        console.error('�?默认壁纸也加载失败，保持原有背景');
      }
    };
    
    // 开始加载图�?
    img.src = url;
    
  } catch (error) {
    console.error('�?壁纸加载出错:', error);
  }
}



async function initialise() {
  updateDocumentTitle(DEFAULT_SITE_SETTINGS.siteName);
  updateFavicon(DEFAULT_SITE_SETTINGS.siteLogo, DEFAULT_SITE_SETTINGS.siteName);
  updateFooter(DEFAULT_SITE_SETTINGS.footer);
  applyGlassOpacity(DEFAULT_SITE_SETTINGS.glassOpacity); // 🆕 应用默认透明�?


  showCollection(activeCollection);
  if (searchEngineInput) {
    setSearchEngine(searchEngineInput.value || "google");
  }
  updateClock();
  setInterval(updateClock, 1_000);
  const dataPromise = loadData();

  loadYiyanQuote();

  if (backToTopButton) {
    backToTopButton.addEventListener("click", (event) => {
      event.preventDefault();
      scrollToTop();
    });
    handleBackToTopVisibility();
    window.addEventListener("scroll", handleBackToTopVisibility, { passive: true });
  }
  if (collectionToggleButtons.length) {
    collectionToggleButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const view = button.dataset.view;
        if (!view) return;
        showCollection(view);
      });
      button.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
          return;
        }
        event.preventDefault();
        const offset = event.key === "ArrowRight" ? 1 : -1;
        const currentIndex = collectionToggleButtons.indexOf(button);
        const nextIndex =
          (currentIndex + offset + collectionToggleButtons.length) % collectionToggleButtons.length;
        const nextButton = collectionToggleButtons[nextIndex];
        if (!nextButton) return;
        const view = nextButton.dataset.view;
        if (!view) return;
        showCollection(view, { focusTab: true });
      });
    });
  }
  if (searchForm) {
    searchForm.addEventListener("submit", handleSearchSubmit);
  }
  if (searchTargetSelect) {
    searchTargetSelect.addEventListener("change", updateSearchControls);
  }
  if (searchEngineButtons.length) {
    searchEngineButtons.forEach((button) => {
      button.addEventListener("click", () => {
        if (button.disabled || searchEngineInput?.disabled) {
          return;
        }
        const value = button.dataset.engineOption;
        if (value) {
          setSearchEngine(value);
        }
      });
      button.addEventListener("keydown", (event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault();
          moveSearchEngineSelection(1);
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault();
          moveSearchEngineSelection(-1);
        }
      });
    });
  }
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      if (currentSearchTarget !== "web") {
        performLocalSearch(currentSearchTarget, searchInput.value);
      }
    });
  }
  updateSearchControls();

  await dataPromise.catch(() => {});
  if (weatherRequestToken === 0) {
    refreshWeatherDisplay();
  }
  // 🆕 浮动卡片功能
  if (floatingCard) {
    // 监听滚动事件（使用节流优化性能�?
    const throttledScroll = throttle(handleFloatingVisibility, 100);
    window.addEventListener('scroll', throttledScroll, { passive: true });
    
    // 点击交互
    floatingCard.addEventListener('click', (event) => {
      // 移动端：首次点击展开，再次点击回顶部
      if (window.innerWidth <= 768) {
        if (!floatingCard.classList.contains('is-expanded')) {
          event.preventDefault();
          floatingCard.classList.add('is-expanded');
          
          // 3秒后自动收起
          setTimeout(() => {
            floatingCard.classList.remove('is-expanded');
          }, 3000);
        } else {
          // 已展开状态，点击回顶�?
          scrollToTop();
          floatingCard.classList.remove('is-expanded');
        }
      } else {
        // 桌面端：直接回顶�?
        scrollToTop();
      }
    });
    floatingCard.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        floatingCard.click();
      }
    });
    // 初始检查滚动位�?
    handleFloatingVisibility();
    
    // 初始更新内容
    updateFloatingCard();
  }

}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialise);
} else {
  initialise();
}
