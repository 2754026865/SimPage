import { renderMarkdown } from "../lib/markdown.js";
import { formatLunar } from "../lib/lunar.js"; // 🆕 导入农历工具
import "../features/theme.js";
import { DEFAULT_SETTINGS, normaliseSiteSettings } from "../lib/shared.js";
import { createDailyCalendarCache } from "../lib/date.js";
import { loadImage } from "../lib/image.js";
import {
  createFaviconController,
  createItemIcon,
  normaliseFooterValue,
  replaceChildrenSafe,
  scrollToTop as sharedScrollToTop,
  setBackToTopVisibility,
  setDocumentTitle,
} from "../lib/ui.js";
import {
  normaliseCollectionItems,
  normaliseWeatherSettingsForRuntime,
  normalizeUrl,
} from "../lib/data.js";
import { fetchJson, getPayloadData, getPayloadMessage } from "../lib/api.js";
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
const footerVisitorsElement = document.getElementById("site-footer-visitors");
const runningDaysElement = document.getElementById("site-running-days");
const visitorCountElement = document.getElementById("site-visitor-count");
const faviconLink = document.getElementById("site-favicon");
const wallpaperContainer = document.getElementById("wallpaper-container");

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

const defaultDocumentTitle = document.title || "SimPage";
const defaultSiteName = siteNameElement?.textContent?.trim() || defaultDocumentTitle || "SimPage";
const defaultWeather = {
  city: "北京",
};
const DEFAULT_SITE_SETTINGS = {
  ...DEFAULT_SETTINGS,
  siteName: defaultSiteName,
  weather: { ...defaultWeather },
};

const defaultFaviconHref = faviconLink?.getAttribute("href") || "data:,";
const defaultFaviconType = faviconLink?.getAttribute("type") || "";
const defaultFaviconSizes = faviconLink?.getAttribute("sizes") || "";
const DEFAULT_FAVICON_SYMBOL = "🧭";
const BACK_TO_TOP_THRESHOLD = 320;
const scrollToTop = sharedScrollToTop;

const { updateFavicon } = createFaviconController({
  faviconLink,
  defaultHref: defaultFaviconHref,
  defaultType: defaultFaviconType,
  defaultSizes: defaultFaviconSizes,
  defaultSymbol: DEFAULT_FAVICON_SYMBOL,
});

let customGreeting = "";
let yiyanMessage = "";
let footerContentValue = "";
let hasRunningDaysValue = false;
let hasVisitorCountValue = false;
let clockIntervalId = null;
let viewportEffectsQueued = false;
let weatherRotationInterval = null;
let weatherRotationItems = [];
let weatherRotationRaws = [];
let weatherRotationIndex = 0;
let currentWeatherRaw = null;
let wallpaperTaskToken = 0;
let cancelWallpaperLoad = null;
let localSearchDebounceId = null;

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


const getDailyCalendar = createDailyCalendarCache({
  formatDate: (date) => dateFormatter.format(date),
  formatLunar,
});

const runtimeConfig = {
  weather: {
    defaultCity: defaultWeather.city,
  },
};

let activeWeather = { city: runtimeConfig.weather.defaultCity };
let weatherRequestToken = 0;
let weatherAbortController = null;
let weatherRetryTimer = null;

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
 * 🆕 根据时间获取动态标签
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
 * 🆕 计算本年第几周
 */
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
 * 🆕 渲染进度条（紧凑：返回 ASCII 字符串供浮动卡使用）
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
 * 🆕 更新主页紧凑进度条（width + 文本）
 */
function updateProgressDisplay(element, progress) {
  if (!element) return;
  const next = String(progress);
  if (element.dataset.progress !== next) {
    element.dataset.progress = next;
    const fill = element.querySelector('.progress-fill');
    if (fill) fill.style.width = `${progress}%`;
    const text = element.querySelector('.progress-text');
    if (text) text.textContent = `今日已过 ${progress}%`;
  }
}

function setTextIfChanged(element, value) {
  if (!element) return;
  const nextValue = typeof value === "string" ? value : String(value ?? "");
  if (element.textContent !== nextValue) {
    element.textContent = nextValue;
  }
}

function scheduleNonCriticalTask(callback, timeout = 1500) {
  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    return window.requestIdleCallback(() => callback(), { timeout });
  }
  return window.setTimeout(callback, 0);
}

function updateViewportEffects() {
  viewportEffectsQueued = false;
  handleBackToTopVisibility();
  handleFloatingVisibility();
}

function queueViewportEffects() {
  if (viewportEffectsQueued) {
    return;
  }
  viewportEffectsQueued = true;
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(updateViewportEffects);
    return;
  }
  updateViewportEffects();
}

function shouldUpdateFloatingCard() {
  if (!floatingCard) {
    return false;
  }
  return (
    floatingCard.classList.contains("is-visible") ||
    floatingCard.classList.contains("is-expanded")
  );
}

/**
 * 🆕 处理浮动卡片显示/隐藏
 */
const FLOATING_THRESHOLD = 300; // 滚动 300px 后显示

function handleFloatingVisibility() {
  if (!floatingCard) return;
  
  const scrollY = window.scrollY;
  if (scrollY > FLOATING_THRESHOLD) {
    const wasVisible = floatingCard.classList.contains("is-visible");
    floatingCard.classList.add("is-visible");
    if (!wasVisible) updateFloatingCard();
  } else {
    floatingCard.classList.remove('is-visible');
  }
}

/**
 * 🆕 提取天气温度信息
 */
function extractWeatherTempFromRaw(raw) {
  if (!raw || typeof raw !== 'object') return '🌤️';
  const condition = typeof raw.text === 'string' ? raw.text : '';
  const tempNum = Number(raw.temperature);
  const tempStr = Number.isFinite(tempNum) ? `${Math.round(tempNum)}°C` : '';
  const icon = condition ? getWeatherEmoji(condition) : '🌤️';
  return tempStr ? `${icon} ${tempStr}` : icon;
}

/**
 * 🆕 更新浮动卡片内容
 */
function updateFloatingCard(now = new Date()) {
  if (!shouldUpdateFloatingCard()) return;
  const hour = now.getHours();
  
  // 获取动态数据
  const badge = getDynamicBadge(hour);
  const time = timeFormatter.format(now);
  const timeShort = time.substring(0, 5); // 只取 HH:MM
  const { date, lunar, weekNum } = getDailyCalendar(now);
  const progress = getTodayProgress();
  const progressBar = renderProgressBar(progress);
  const weatherText = weatherElement ? weatherElement.textContent : '';
  
  // 更新紧凑模式
  if (compactBadge) {
    const badgeEmoji = badge.split(' ')[0]; // 提取 emoji
    setTextIfChanged(compactBadge, `${badgeEmoji} ${timeShort}`);
  }
  
  if (compactProgress) {
    setTextIfChanged(compactProgress, `💡 ${progress}%`);
  }
  
  if (compactWeather) {
    setTextIfChanged(compactWeather, extractWeatherTempFromRaw(currentWeatherRaw));
  }
  
  // 更新展开模式
  if (expandedBadge) {
    setTextIfChanged(expandedBadge, badge);
  }
  
  if (expandedTime) {
    setTextIfChanged(expandedTime, time);
  }
  
  if (expandedDate) {
    setTextIfChanged(expandedDate, date);
  }
  
  if (expandedLunar) {
    setTextIfChanged(expandedLunar, `${lunar} · 第${weekNum}周`);
  }
  
  if (expandedProgressFull) {
    setTextIfChanged(expandedProgressFull, progressBar);
  }
  
  if (expandedWeather) {
    setTextIfChanged(expandedWeather, weatherText);
  }
}


function updateClock() {
  const now = new Date();
  const hour = now.getHours();
  const calendar = getDailyCalendar(now);
  
  // 更新时间
  if (timeElement) {
    setTextIfChanged(timeElement, timeFormatter.format(now));
  }
  
  // 更新日期
  if (dateElement) {
    setTextIfChanged(dateElement, calendar.date);
  }
  
  // 🆕 更新动态标签
  if (dynamicBadgeElement) {
    setTextIfChanged(dynamicBadgeElement, getDynamicBadge(hour));
  }
  
  // 🆕 更新农历和周数
  if (lunarDateElement) {
    setTextIfChanged(lunarDateElement, `${calendar.lunar} · 第${calendar.weekNum}周`);
  }
  
  // 🆕 更新今日进度
  if (todayProgressElement) {
    const progress = getTodayProgress();
    updateProgressDisplay(todayProgressElement, progress);
  }
  
  // 更新问候语
  updateGreetingDisplay(hour);

  if (shouldUpdateFloatingCard()) {
    updateFloatingCard();
  }
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
    setTextIfChanged(greetingElement, customGreeting);
    return;
  }
  if (shouldUseYiyan) {
    setTextIfChanged(greetingElement, yiyanMessage);
    return;
  }
  setTextIfChanged(greetingElement, getGreeting(hour));
}

async function loadData() {
  try {
    const { response, payload } = await fetchJson("/api/data");
    if (!response.ok) {
      throw new Error(getPayloadMessage(payload, "数据拉取失败"));
    }
    const data = getPayloadData(payload);

    applyRuntimeConfig(data?.config);
    applySiteSettings(data?.settings);
    updateRunningDays(data?.runningDays, data?.siteStartDate); // 🆕 修改这里
    updateVisitorCount(data?.visitorCount);

    originalData.apps = normaliseCollectionItems(data?.apps, "apps");
    originalData.bookmarks = normaliseCollectionItems(data?.bookmarks, "bookmarks");
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

function prepareSiteSettings(settings) {
  return normaliseSiteSettings(settings, { defaults: DEFAULT_SITE_SETTINGS });
}

/**
 * 应用容器透明度
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
    setTextIfChanged(siteNameElement, prepared.siteName);
  }
  setDocumentTitle(prepared.siteName, { defaultTitle: defaultDocumentTitle });
  updateFavicon(prepared.siteLogo, prepared.siteName);
  updateGreetingDisplay();
  updateFooter(prepared.footer);
  setActiveWeather(prepared.weather);
  applyGlassOpacity(prepared.glassOpacity); // 🆕 应用透明度
  scheduleWallpaperUpdate(prepared.useWallpaper, prepared.wallpaperUrl);
}

/**
 * 移除壁纸背景
 */
function removeWallpaper() {
  if (!wallpaperContainer) {
    return;
  }

  wallpaperContainer.classList.remove("loaded");
  wallpaperContainer.style.backgroundImage = "";
  wallpaperContainer.style.removeProperty("opacity");
}

function scheduleWallpaperUpdate(isEnabled, wallpaperUrl) {
  const taskToken = ++wallpaperTaskToken;
  if (cancelWallpaperLoad) {
    cancelWallpaperLoad();
    cancelWallpaperLoad = null;
  }
  scheduleNonCriticalTask(() => {
    if (taskToken !== wallpaperTaskToken) {
      return;
    }
    if (isEnabled) {
      // Keep an already displayed image while refreshing; first loads get a local background.
      if (wallpaperContainer && !wallpaperContainer.style.backgroundImage) {
        wallpaperContainer.style.backgroundImage = 'url("/images/wallpaper-fallback.svg")';
        wallpaperContainer.style.removeProperty("opacity");
        wallpaperContainer.classList.add("loaded");
      }
      loadWallpaper(wallpaperUrl, taskToken);
      return;
    }
    removeWallpaper();
  });
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
  if (!footerMetaElement || !runningDaysElement) return;

  const parsed = Number(runningDays);
  let days = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : null;
  const hasStartDate = typeof siteStartDate === "string" && siteStartDate.trim().length > 0;

  if (days === null && hasStartDate) {
    const datePart = siteStartDate.split("T")[0];
    const [year, month, day] = datePart.split("-").map(Number);
    if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)) {
      const start = new Date(year, month - 1, day);
      if (!Number.isNaN(start.getTime())) {
        const now = new Date();
        const diffDays = Math.floor((now - start) / (1000 * 60 * 60 * 24));
        days = Math.max(0, diffDays);
      }
    }
  }

  const hasValue = Number.isFinite(days);
  setTextIfChanged(runningDaysElement, hasValue ? days : 0);

  hasRunningDaysValue = hasValue;
  footerMetaElement.hidden = !hasValue;

  refreshFooterVisibility();
}


function updateVisitorCount(value) {
  if (!footerVisitorsElement || !visitorCountElement) return;
  const parsed = Number(value);
  const hasValue = Number.isFinite(parsed) && parsed >= 0;
  setTextIfChanged(visitorCountElement, hasValue ? Math.floor(parsed) : 0);
  hasVisitorCountValue = hasValue;
  footerVisitorsElement.hidden = !hasValue;
  refreshFooterVisibility();
}

function refreshFooterVisibility() {
  if (!footerElement) return;
  const hasContent = Boolean(footerContentValue);
  const shouldShowFooter = hasContent || hasRunningDaysValue || hasVisitorCountValue;
  footerElement.hidden = !shouldShowFooter;
}

function showCollection(view, { focusTab = false } = {}) {
  if (view !== "apps" && view !== "bookmarks") {
    return;
  }
  activeCollection = view;
  renderCollectionIfNeeded(view);

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

const collectionViews = {
  apps: { items: [], options: {}, renderedItems: null, renderedMessage: null },
  bookmarks: { items: [], options: {}, renderedItems: null, renderedMessage: null },
};

function renderCollectionIfNeeded(view) {
  const state = collectionViews[view];
  if (state.renderedItems === state.items && state.renderedMessage === state.options.emptyMessage) return;
  if (view === "apps") {
    renderTileGrid(appsGrid, appsEmpty, state.items, { ...state.options, defaultMessage: appsEmptyDefault });
  } else {
    renderBookmarksNow(state.items, state.options);
  }
  state.renderedItems = state.items;
  state.renderedMessage = state.options.emptyMessage;
}

function setCollectionContent(view, items, options) {
  collectionViews[view].items = items;
  collectionViews[view].options = options;
  if (activeCollection === view) renderCollectionIfNeeded(view);
}

function renderApps(items, options = {}) {
  setCollectionContent("apps", items, options);
}

function renderBookmarks(items, options = {}) {
  setCollectionContent("bookmarks", items, options);
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

function renderBookmarksNow(items, options = {}) {
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

  const iconWrapper = createItemIcon({ name: item.name, icon: item.icon, className: "tile-icon" });

  const title = document.createElement("h3");
  title.className = "tile-title";
  title.textContent = item.name || "未命名";

  const description = document.createElement("p");
  description.className = "tile-description";
  const descriptionText = typeof item.description === "string" ? item.description.trim() : "";
  if (descriptionText) {
    description.textContent = descriptionText;
  } else {
    link.classList.add("tile--compact");
    description.classList.add("is-empty");
    description.setAttribute("aria-hidden", "true");
  }

  link.appendChild(iconWrapper);
  link.appendChild(title);
  link.appendChild(description);

  return link;
}

function performLocalSearch(target, query) {
  if (target !== "apps" && target !== "bookmarks") {
    return;
  }
  const trimmed = query.trim();
  if (!trimmed) {
    clearLocalSearchResults(target);
    return;
  }

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
  } else {
    renderBookmarks(matches, { emptyMessage: `未找到与「${trimmed}」匹配的书签。` });
  }
  const other = target === "apps" ? "bookmarks" : "apps";
  collectionViews[other].items = originalData[other];
  collectionViews[other].options = {};
  showCollection(target);
  updateLocalSearchFeedback(matches.length, target, trimmed);
}

function clearLocalSearchResults(view = activeCollection) {
  for (const key of ["apps", "bookmarks"]) {
    collectionViews[key].items = originalData[key];
    collectionViews[key].options = {};
  }
  hideLocalSearchFeedback();
  showCollection(view);
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
  const cacheKey = "simpage:yiyan:v1";
  try {
    const cached = JSON.parse(window.sessionStorage.getItem(cacheKey) || "null");
    const age = Date.now() - cached?.savedAt;
    if (typeof cached?.message === "string" && cached.message.trim() && age >= 0 && age < 30 * 60 * 1000) {
      yiyanMessage = cached.message;
      updateGreetingDisplay();
      return;
    }
  } catch (_error) {
    // Storage may be unavailable in private browsing; the quote remains optional.
  }
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timeoutId = null;
  let timedOut = false;
  try {
    if (controller) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 8000);
    }
    const options = { cache: "no-cache" };
    if (controller) {
      options.signal = controller.signal;
    }
    const { response, payload } = await fetchJson("https://v1.hitokoto.cn/?encode=json", options);
    if (!response.ok) {
      throw new Error("一言接口请求失败");
    }
    if (!payload || typeof payload !== "object") {
      throw new Error("一言接口响应异常");
    }
    const message = formatYiyanQuote(payload);
    if (!message) throw new Error("一言接口未返回句子");
    yiyanMessage = message;
    updateGreetingDisplay();
    try {
      window.sessionStorage.setItem(cacheKey, JSON.stringify({ message, savedAt: Date.now() }));
    } catch (_error) {
      // A successful quote should still be displayed when storage is disabled.
    }
  } catch (error) {
    console.warn(timedOut || error?.name === "AbortError"
      ? "一言请求超时，继续显示当前问候。"
      : "一言暂时不可用，继续显示当前问候。");
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function normaliseWeatherSetting(raw) {
  return normaliseWeatherSettingsForRuntime(raw, defaultWeather.city);
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
  const city = typeof config?.weather?.defaultCity === "string" ? config.weather.defaultCity.trim() : "";
  if (city) runtimeConfig.weather.defaultCity = city;
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


function setActiveWeather(rawWeather) {
  updateActiveWeather(normaliseWeatherSetting(rawWeather));
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
  const emoji = condition ? getWeatherEmoji(condition) : "🌤️";
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

function stopWeatherRotation(clearItems = false) {
  if (weatherRotationInterval) {
    clearInterval(weatherRotationInterval);
    weatherRotationInterval = null;
  }
  if (clearItems) {
    weatherRotationItems = [];
    weatherRotationRaws = [];
    weatherRotationIndex = 0;
    currentWeatherRaw = null;
  }
}

function applyWeatherText(value, raw = null) {
  currentWeatherRaw = raw;
  setTextIfChanged(weatherElement, value);
  if (shouldUpdateFloatingCard()) {
    updateFloatingCard();
  }
}

async function updateWeather(weather, retryCount = 0) {
  if (!weatherElement) return;
  const requestToken = ++weatherRequestToken;
  weatherAbortController?.abort();
  if (weatherRetryTimer) clearTimeout(weatherRetryTimer);
  const controller = new AbortController();
  weatherAbortController = controller;
  const maxRetries = 2;
  const retryDelay = 1000;

  try {
    const { response, payload } = await fetchJson("/api/weather", { cache: "no-cache", signal: controller.signal, timeoutMs: 20000 });
    if (!payload || typeof payload !== "object") {
      throw new Error("天气服务响应异常");
    }

    if (!response.ok || !payload || payload.success !== true) {
      const message = getPayloadMessage(payload, "天气数据请求失败");
      throw new Error(message);
    }

    if (requestToken !== weatherRequestToken) {
      return;
    }

    const dataPayload = getPayloadData(payload);
    const data = Array.isArray(dataPayload) ? dataPayload : [];
    const formatted = [];
    const raws = [];
    data.forEach((item) => {
      const text = formatWeatherItem(item);
      if (text) {
        formatted.push(text);
        raws.push(item);
      }
    });

    if (!formatted.length) {
      throw new Error("天气数据格式异常");
    }

    stopWeatherRotation(true);

    if (formatted.length > 1) {
      startWeatherRotation(formatted, raws);
      return;
    }

    weatherRotationItems = formatted.slice();
    weatherRotationRaws = raws.slice();
    weatherRotationIndex = 0;
    applyWeatherText(formatted[0], raws[0]);
  } catch (error) {
    if (requestToken !== weatherRequestToken) {
      return;
    }

    updateFloatingCard();
    console.error("天气数据获取失败", error);

    stopWeatherRotation(true);
    applyWeatherText("天气信息获取失败");

    if (retryCount < maxRetries) {
      weatherRetryTimer = setTimeout(() => {
        weatherRetryTimer = null;
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
    applyWeatherText(`${locationLabel}${message}`.trim());
  }
}


function startWeatherRotation(weatherInfo, rawInfo) {
  stopWeatherRotation(false);

  weatherRotationItems = Array.isArray(weatherInfo) ? weatherInfo.slice() : [];
  weatherRotationRaws = Array.isArray(rawInfo) ? rawInfo.slice() : [];
  if (!weatherRotationItems.length) {
    return;
  }

  if (weatherRotationIndex >= weatherRotationItems.length) {
    weatherRotationIndex = 0;
  }
  applyWeatherText(
    weatherRotationItems[weatherRotationIndex],
    weatherRotationRaws[weatherRotationIndex] || null
  );

  if (weatherRotationItems.length > 1 && document.visibilityState !== "hidden") {
    weatherRotationIndex = (weatherRotationIndex + 1) % weatherRotationItems.length;
    weatherRotationInterval = setInterval(() => {
      applyWeatherText(
        weatherRotationItems[weatherRotationIndex],
        weatherRotationRaws[weatherRotationIndex] || null
      );
      weatherRotationIndex = (weatherRotationIndex + 1) % weatherRotationItems.length;
    }, WEATHER_ROTATION_INTERVAL);
  }
}




function handleBackToTopVisibility() {
  setBackToTopVisibility(backToTopButton, BACK_TO_TOP_THRESHOLD);
}

/**
 * 加载壁纸
 * @param {string} wallpaperUrl - 壁纸图片 URL
 */
function loadWallpaper(wallpaperUrl, taskToken = wallpaperTaskToken, defaultAttempt = 0) {
  if (!wallpaperContainer || taskToken !== wallpaperTaskToken) return;
  const defaultUrl = "/api/wallpaper";
  const requestedUrl = typeof wallpaperUrl === "string" ? wallpaperUrl.trim() : "";
  const url = !requestedUrl || requestedUrl === "https://bing.img.run/uhd.php" ? defaultUrl : requestedUrl;
  const task = loadImage(url, {
    timeoutMs: 20000,
    onLoad() {
      if (taskToken !== wallpaperTaskToken) return;
      cancelWallpaperLoad = null;
      wallpaperContainer.style.backgroundImage = `url(${JSON.stringify(url)})`;
      wallpaperContainer.style.removeProperty("opacity");
      wallpaperContainer.classList.add("loaded");
    },
    onError(reason) {
      if (taskToken !== wallpaperTaskToken) return;
      cancelWallpaperLoad = null;
      if (url !== defaultUrl) {
        console.warn(`自定义壁纸${reason}，尝试默认壁纸。`);
        loadWallpaper(defaultUrl, taskToken);
      } else if (defaultAttempt === 0) {
        console.warn(`默认壁纸${reason}，稍后重试一次。`);
        const retryId = window.setTimeout(() => {
          if (taskToken !== wallpaperTaskToken) return;
          cancelWallpaperLoad = null;
          loadWallpaper(defaultUrl, taskToken, 1);
        }, 1000);
        cancelWallpaperLoad = () => window.clearTimeout(retryId);
      } else {
        console.warn(`默认壁纸${reason}，继续使用当前背景。`);
      }
    },
  });
  if (task.pending) cancelWallpaperLoad = task.cancel;
}

function startClockUpdates() {
  if (clockIntervalId !== null) {
    return;
  }
  updateClock();
  clockIntervalId = window.setInterval(updateClock, 1_000);
}

function stopClockUpdates() {
  if (clockIntervalId === null) {
    return;
  }
  clearInterval(clockIntervalId);
  clockIntervalId = null;
}

function handleVisibilityChange() {
  if (document.visibilityState === "hidden") {
    stopClockUpdates();
    stopWeatherRotation(false);
    return;
  }

  startClockUpdates();
  queueViewportEffects();
  if (weatherRotationItems.length > 1) {
    startWeatherRotation(weatherRotationItems, weatherRotationRaws);
    return;
  }
  if (weatherRotationItems.length === 1) {
    applyWeatherText(weatherRotationItems[0], weatherRotationRaws[0] || null);
    return;
  }
  if (weatherRequestToken !== 0) {
    refreshWeatherDisplay();
  }
}



async function initialise() {
  setDocumentTitle(DEFAULT_SITE_SETTINGS.siteName, { defaultTitle: defaultDocumentTitle });
  updateFavicon(DEFAULT_SITE_SETTINGS.siteLogo, DEFAULT_SITE_SETTINGS.siteName);
  updateFooter(DEFAULT_SITE_SETTINGS.footer);
  applyGlassOpacity(DEFAULT_SITE_SETTINGS.glassOpacity);


  showCollection(activeCollection);
  if (searchEngineInput) {
    setSearchEngine(searchEngineInput.value || "google");
  }
  startClockUpdates();
  const dataPromise = loadData();

  scheduleNonCriticalTask(() => {
    void loadYiyanQuote();
  });

  if (backToTopButton || floatingCard) {
    queueViewportEffects();
    window.addEventListener("scroll", queueViewportEffects, { passive: true });
  }
  document.addEventListener("visibilitychange", handleVisibilityChange);

  if (backToTopButton) {
    backToTopButton.addEventListener("click", (event) => {
      event.preventDefault();
      scrollToTop();
    });
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
        if (localSearchDebounceId) {
          clearTimeout(localSearchDebounceId);
        }
        localSearchDebounceId = window.setTimeout(() => {
          performLocalSearch(currentSearchTarget, searchInput.value);
          localSearchDebounceId = null;
        }, 80);
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
          // 已展开状态，点击回顶部
          scrollToTop();
          floatingCard.classList.remove('is-expanded');
        }
      } else {
        // 桌面端：直接回顶部
        scrollToTop();
      }
    });
    floatingCard.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        floatingCard.click();
      }
    });
    // 初始更新内容
    updateFloatingCard();
  }

}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialise);
} else {
  initialise();
}
