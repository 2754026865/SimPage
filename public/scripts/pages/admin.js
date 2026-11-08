import { renderMarkdown } from "../lib/markdown.js";
import {
  createFaviconController,
  createItemIcon,
  normaliseFooterValue,
  replaceChildrenSafe,
  scrollToTop as sharedScrollToTop,
  setBackToTopVisibility,
  setDocumentTitle,
} from "../lib/ui.js";
import { fetchJson, getPayloadData, getPayloadMessage } from "../lib/api.js";
import { normaliseCollectionItems, normaliseWeatherSettingsForEditor } from "../lib/data.js";
import { normaliseItemFields, normaliseSiteSettings, parseWeatherCities, WEATHER_MAX_CITIES } from "../lib/shared.js";

const appsEditor = document.getElementById("apps-editor");
const bookmarksEditor = document.getElementById("bookmarks-editor");
const addButtons = document.querySelectorAll(".add-button");
const saveButton = document.getElementById("save-button");
const reloadButton = document.getElementById("reload-button");
const statusBar = document.getElementById("status-bar");
const modal = document.getElementById("editor-modal");
const modalForm = document.getElementById("editor-form");
const modalTitle = document.getElementById("editor-modal-title");
const modalError = document.getElementById("editor-error");
const modalNameInput = document.getElementById("editor-name");
const modalUrlInput = document.getElementById("editor-url");
const modalDescriptionInput = document.getElementById("editor-description");
const modalIconInput = document.getElementById("editor-icon");
const fetchLogoButton = document.getElementById("fetch-logo-button");
const modalCategoryField = document.getElementById("editor-category-field");
const modalCategoryInput = document.getElementById("editor-category");
const modalCategoryPlaceholder =
  modalCategoryField ? document.createComment("modal-category-placeholder") : null;

if (modalCategoryField && modalCategoryPlaceholder && modalCategoryField.parentNode) {
  modalCategoryField.replaceWith(modalCategoryPlaceholder);
  if (modalCategoryInput) {
    modalCategoryInput.disabled = true;
  }
}

const modalCancelButton = document.getElementById("editor-cancel-button");
const modalCloseButton = document.getElementById("editor-close-button");
const modalOverlay = document.getElementById("editor-modal-overlay");
const siteNameInput = document.getElementById("site-name");
const siteLogoInput = document.getElementById("site-logo");
const siteGreetingInput = document.getElementById("site-greeting");
const siteFooterInput = document.getElementById("site-footer-content");
const siteFooterPreview = document.getElementById("site-footer-preview");
const siteWeatherCityInput = document.getElementById("site-weather-city");
const siteWeatherSummary = document.getElementById("site-weather-summary");
const siteGlassOpacityInput = document.getElementById("site-glass-opacity"); // 🆕 添加
const opacityValueDisplay = document.getElementById("opacity-value-display"); // 🆕 添加
const siteUseWallpaperInput = document.getElementById("site-use-wallpaper"); // 🆕 添加
const siteWallpaperUrlInput = document.getElementById("site-wallpaper-url"); // 🆕 添加
const categorySuggestions = document.getElementById("category-suggestions");
const logoutButton = document.getElementById("logout-button");
const passwordForm = document.getElementById("password-form");
const currentPasswordInput = document.getElementById("current-password");
const newPasswordInput = document.getElementById("new-password");
const confirmPasswordInput = document.getElementById("confirm-password");
const passwordMessage = document.getElementById("password-message");
const backToTopButton = document.getElementById("back-to-top");
const faviconLink = document.getElementById("site-favicon");
const backToAppsButton = document.getElementById("back-to-apps-button");
const backToBookmarksButton = document.getElementById("back-to-bookmarks-button");
const siteStartDateInput = document.getElementById("site-start-date"); // 🆕 添加


const typeLabels = {
  apps: "应用",
  bookmarks: "书签",
};

const DATA_ENDPOINT = "/api/admin/data";
const PASSWORD_ENDPOINT = "/api/admin/password";

const defaultDocumentTitle = document.title || "导航后台编辑";
const defaultFaviconHref = faviconLink?.getAttribute("href") || "data:,";
const defaultFaviconType = faviconLink?.getAttribute("type") || "";
const defaultFaviconSizes = faviconLink?.getAttribute("sizes") || "";
const DEFAULT_FAVICON_SYMBOL = "🧭";
const ADMIN_TITLE_SUFFIX = " · 后台管理";
const BACK_TO_TOP_THRESHOLD = 320;
const scrollToTop = sharedScrollToTop;

const { updateFavicon } = createFaviconController({
  faviconLink,
  defaultHref: defaultFaviconHref,
  defaultType: defaultFaviconType,
  defaultSizes: defaultFaviconSizes,
  defaultSymbol: DEFAULT_FAVICON_SYMBOL,
});

const DEFAULT_WEATHER_SETTINGS = {
  city: "北京",
};

const defaultSettings = {
  siteName: siteNameInput && siteNameInput.value.trim() ? siteNameInput.value.trim() : "SimPage",
  siteLogo: siteLogoInput && siteLogoInput.value.trim() ? siteLogoInput.value.trim() : "",
  greeting: siteGreetingInput && siteGreetingInput.value.trim() ? siteGreetingInput.value.trim() : "",
  footer: siteFooterInput && siteFooterInput.value ? normaliseFooterValue(siteFooterInput.value) : "",
  weather: createDefaultWeatherSettings(),
  glassOpacity: 40, // 🆕 添加默认透明度
  useWallpaper: true, // 🆕 添加默认值
  wallpaperUrl: "/api/wallpaper",
};

const state = {
  apps: [],
  bookmarks: [],
  settings: {
    siteName: defaultSettings.siteName,
    siteLogo: defaultSettings.siteLogo,
    greeting: defaultSettings.greeting,
    footer: defaultSettings.footer,
    weather: { ...defaultSettings.weather },
    glassOpacity: defaultSettings.glassOpacity, // 🆕 添加
    useWallpaper: defaultSettings.useWallpaper, // 🆕 添加
    wallpaperUrl: defaultSettings.wallpaperUrl, // 🆕 添加
  },
  stats: { // 🆕 添加
    siteStartDate: null,
  },
};

let isDirty = false;
let modalContext = null;
let activeOperation = null;
let lockedControls = [];
let hasLoadedData = false;
let pendingSave = null;
let logoRequest = null;
let logoRequestToken = 0;
let lastPageIdentity = null;
const fetchLogoButtonLabel = fetchLogoButton?.textContent || "自动获取";
const savedSnapshot = {
  _version: null,
  apps: [],
  bookmarks: [],
  settings: {
    siteName: defaultSettings.siteName,
    siteLogo: defaultSettings.siteLogo,
    greeting: defaultSettings.greeting,
    footer: defaultSettings.footer,
    weather: createDefaultWeatherSettings(),
    glassOpacity: defaultSettings.glassOpacity,
    useWallpaper: defaultSettings.useWallpaper,
    wallpaperUrl: defaultSettings.wallpaperUrl,
  },
  stats: {
    siteStartDate: null,
  },
};

function setStatus(message, variant = "neutral") {
  if (!statusBar) return;
  statusBar.textContent = message;
  if (variant === "neutral") {
    statusBar.removeAttribute("data-variant");
  } else {
    statusBar.dataset.variant = variant;
  }
}

function markDirty() {
  if (!isDirty) {
    isDirty = true;
    if (saveButton) {
      saveButton.disabled = Boolean(activeOperation) || !hasLoadedData;
    }
  }
}

function resetDirty() {
  isDirty = false;
  if (saveButton) {
    saveButton.disabled = true;
  }
}

function beginOperation(name) {
  if (activeOperation) return false;
  cancelLogoRequest();
  activeOperation = name;
  lockedControls = Array.from(document.querySelectorAll("input, textarea, select, button"))
    .map((control) => ({ control, disabled: control.disabled }));
  lockedControls.forEach(({ control }) => { control.disabled = true; });
  return true;
}

function endOperation() {
  lockedControls.forEach(({ control, disabled }) => { control.disabled = disabled; });
  lockedControls = [];
  activeOperation = null;
  if (saveButton) saveButton.disabled = !isDirty || !hasLoadedData;
}

function createBlankItem(type) {
  return {
    id: crypto.randomUUID(),
    name: "",
    url: "",
    description: "",
    icon: "",
    ...(type === "bookmarks" ? { category: "" } : {}),
  };
}

function normaliseSettingsIncoming(input) {
  return normaliseSiteSettings(input, { defaults: defaultSettings, weatherMode: "editor" });
}

function createDefaultWeatherSettings() {
  return {
    city: DEFAULT_WEATHER_SETTINGS.city,
  };
}

function normaliseWeatherSettingsIncoming(raw) {
  return normaliseWeatherSettingsForEditor(raw, DEFAULT_WEATHER_SETTINGS.city);
}

function toAppPayload(item) {
  return normaliseItemFields(item, "apps", { trim: true });
}

function toBookmarkPayload(item) {
  return normaliseItemFields(item, "bookmarks", { trim: true });
}

function normaliseSiteStartDate(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function syncSavedSnapshot() {
  savedSnapshot.apps = state.apps.map(toAppPayload);
  savedSnapshot.bookmarks = state.bookmarks.map(toBookmarkPayload);
  savedSnapshot.settings = buildSettingsPayload(state.settings);
  savedSnapshot.stats = {
    siteStartDate: normaliseSiteStartDate(state.stats?.siteStartDate),
  };
}

function areValuesEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function diffCollectionItem(previous, next, keys) {
  const changes = {};
  keys.forEach((key) => {
    if (!areValuesEqual(previous?.[key], next?.[key])) {
      changes[key] = next?.[key];
    }
  });
  return changes;
}

function buildCollectionPatchOperations(previousItems, currentItems, type) {
  const toPayload = type === "bookmarks" ? toBookmarkPayload : toAppPayload;
  const compareKeys =
    type === "bookmarks"
      ? ["name", "url", "description", "icon", "category"]
      : ["name", "url", "description", "icon"];

  const previousPayload = Array.isArray(previousItems) ? previousItems.map(toPayload) : [];
  const currentPayload = Array.isArray(currentItems) ? currentItems.map(toPayload) : [];

  const previousById = new Map();
  previousPayload.forEach((item) => {
    if (item.id) {
      previousById.set(item.id, item);
    }
  });

  const currentIds = new Set();
  const operations = [];

  currentPayload.forEach((item) => {
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) {
      operations.push({ op: "upsert", item });
      return;
    }

    currentIds.add(id);
    const previous = previousById.get(id);
    if (!previous) {
      operations.push({ op: "upsert", item });
      return;
    }

    const changes = diffCollectionItem(previous, item, compareKeys);
    if (Object.keys(changes).length > 0) {
      operations.push({ op: "patch", id, changes });
    }
  });

  previousById.forEach((_item, id) => {
    if (!currentIds.has(id)) {
      operations.push({ op: "delete", id });
    }
  });

  return operations;
}

function buildSettingsPatch(previousSettings, nextSettings) {
  const previousPayload = buildSettingsPayload(previousSettings || {});
  const nextPayload = buildSettingsPayload(nextSettings || {});
  const patch = {};
  Object.keys(nextPayload).forEach((key) => {
    if (!areValuesEqual(previousPayload[key], nextPayload[key])) {
      patch[key] = nextPayload[key];
    }
  });
  return patch;
}

function collectWeatherSettingsFromInputs(previous = state.settings.weather) {
  const base =
    previous && typeof previous === "object" ? { ...previous } : createDefaultWeatherSettings();

  const cityRaw = siteWeatherCityInput ? siteWeatherCityInput.value : "";

  return {
    ...base,
    city: cityRaw.trim(),
  };
}

function updateWeatherSummary(weather) {
  if (!siteWeatherSummary) return;

  const city = typeof weather?.city === "string" ? weather.city.trim() : "";

  if (!city) {
    siteWeatherSummary.textContent = "请填写城市名称，以便显示天气信息。";
    return;
  }

  siteWeatherSummary.textContent = `${city} · 使用 Open-Meteo 免费天气服务。`;
}

function handleWeatherInputChange() {
  if (activeOperation) return;
  const nextWeather = collectWeatherSettingsFromInputs();
  state.settings.weather = nextWeather;
  updateWeatherSummary(nextWeather);
  markDirty();
  setStatus("天气配置已更新，记得保存。", "neutral");
}

function validateWeatherSettings(weather) {
  const resolved = weather && typeof weather === "object" ? weather : createDefaultWeatherSettings();
  const city = typeof resolved.city === "string" ? resolved.city.trim() : "";
  if (!city) {
    return { valid: false, message: "请填写天气城市。", focus: siteWeatherCityInput };
  }
  const cities = parseWeatherCities(city);
  if (cities.length > WEATHER_MAX_CITIES) {
    return { valid: false, message: `最多配置 ${WEATHER_MAX_CITIES} 个天气城市。`, focus: siteWeatherCityInput };
  }
  return {
    valid: true,
    value: {
      city: cities.join(" "),
    },
  };
}

function buildWeatherPayload(weather) {
  const city = typeof weather?.city === "string" ? weather.city.trim() : "";
  return { city };
}

function updateFooterPreview(content) {
  if (!siteFooterPreview) return;
  const clean = normaliseFooterValue(content);
  if (!clean) {
    siteFooterPreview.innerHTML = "<span class=\"footer-preview-empty\">暂无内容</span>";
    return;
  }
  siteFooterPreview.innerHTML = renderMarkdown(clean);
}

function applySettingsToInputs(settings) {
  if (siteNameInput) siteNameInput.value = settings.siteName || "";
  if (siteLogoInput) siteLogoInput.value = settings.siteLogo || "";
  if (siteGreetingInput) siteGreetingInput.value = settings.greeting || "";
  if (siteFooterInput) siteFooterInput.value = settings.footer || "";
  updateFooterPreview(settings.footer);

  // 🆕 应用透明度设置
  const opacity = typeof settings.glassOpacity === "number" ? settings.glassOpacity : 40;
  if (siteGlassOpacityInput) {
    siteGlassOpacityInput.value = opacity;
  }
  if (opacityValueDisplay) {
    opacityValueDisplay.textContent = `${opacity}%`;
  }
  // 🆕 应用 useWallpaper 状态
  if (siteUseWallpaperInput) {
    siteUseWallpaperInput.checked = settings.useWallpaper !== false;
  }
  // 🆕 应用壁纸 URL 设置
  if (siteWallpaperUrlInput) {
    siteWallpaperUrlInput.value = settings.wallpaperUrl || "";
    // 🆕 根据开关状态禁用/启用输入框
    siteWallpaperUrlInput.disabled = !siteUseWallpaperInput?.checked;
  }


  const normalisedWeather = normaliseWeatherSettingsIncoming(settings.weather);
  state.settings.weather = normalisedWeather;

  if (siteWeatherCityInput) {
    siteWeatherCityInput.value = normalisedWeather.city || "";
  }

  updateWeatherSummary(normalisedWeather);
  updatePageIdentity(settings);
  // 应该从 state.stats 中获取
  if (siteStartDateInput) {
    siteStartDateInput.value = state.stats?.siteStartDate || "";
  }
}

function handleSettingsChange(field, value) {
  if (!state.settings || activeOperation) return;
  let nextValue = value;
  if (field === "footer") {
    nextValue = normaliseFooterValue(value);
    updateFooterPreview(nextValue);
  }
  state.settings[field] = nextValue;
  if (field === "siteName" || field === "siteLogo") {
    updatePageIdentity(state.settings);
  }
  markDirty();
  setStatus("站点信息已更新，记得保存。", "neutral");
}

function updatePageIdentity(settings) {
  const siteName = settings?.siteName || "";
  const siteLogo = settings?.siteLogo || "";
  if (!lastPageIdentity || siteName !== lastPageIdentity.siteName) {
    setDocumentTitle(siteName, {
      defaultTitle: defaultDocumentTitle,
      suffix: ADMIN_TITLE_SUFFIX,
    });
  }
  if (!lastPageIdentity || siteLogo !== lastPageIdentity.siteLogo ||
      (!siteLogo && siteName !== lastPageIdentity.siteName)) {
    updateFavicon(siteLogo, siteName);
  }
  lastPageIdentity = { siteName, siteLogo };
}

function render(type) {
  if (!type || type === "apps") renderList("apps", appsEditor, state.apps);
  if (!type || type === "bookmarks") {
    renderList("bookmarks", bookmarksEditor, state.bookmarks);
    updateCategorySuggestions();
  }
}

function renderList(type, container, items) {
  if (!container) return;

  if (!Array.isArray(items) || !items.length) {
    const hint = document.createElement("p");
    hint.className = "empty-hint";
    hint.textContent =
      type === "apps" ? "暂无应用，点击上方按钮添加。" : "暂无书签，点击上方按钮添加。";
    replaceChildrenSafe(container, hint);
    return;
  }

  const columns = getTableColumns(type);
  const wrapper = document.createElement("div");
  wrapper.className = "admin-table-wrapper";

  const scroller = document.createElement("div");
  scroller.className = "admin-table-scroll";

  const table = document.createElement("table");
  table.className = `admin-table admin-table-${type}`;

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  columns.forEach((column) => {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = column.label;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const rowsFragment = document.createDocumentFragment();
  items.forEach((item, index) => {
    rowsFragment.appendChild(buildTableRow(type, item, index, columns));
  });
  tbody.appendChild(rowsFragment);
  table.appendChild(tbody);
  bindTableInteractions(table);

  scroller.appendChild(table);
  wrapper.appendChild(scroller);
  replaceChildrenSafe(container, wrapper);
}

function resolveRowContext(row) {
  if (!row) {
    return null;
  }
  const type = row.dataset.type;
  const indexRaw = row.dataset.index;
  const index = Number(indexRaw);
  if ((type !== "apps" && type !== "bookmarks") || !Number.isInteger(index) || index < 0) {
    return null;
  }
  return { type, index };
}

function bindTableInteractions(table) {
  if (!table) {
    return;
  }

  table.addEventListener("click", (event) => {
    const actionButton = event.target.closest("button[data-action]");
    if (actionButton) {
      const row = actionButton.closest("tr[data-clickable='true']");
      const context = resolveRowContext(row);
      if (!context) {
        return;
      }
      const action = actionButton.dataset.action;
      if (action === "edit") {
        openEditor(context.type, context.index);
      } else if (action === "delete") {
        handleDelete(context.type, context.index);
      }
      return;
    }

    const row = event.target.closest("tr[data-clickable='true']");
    const context = resolveRowContext(row);
    if (!context) {
      return;
    }
    openEditor(context.type, context.index);
  });

  table.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    if (event.target.closest("button[data-action]")) {
      return;
    }
    const row = event.target.closest("tr[data-clickable='true']");
    const context = resolveRowContext(row);
    if (!context) {
      return;
    }
    event.preventDefault();
    openEditor(context.type, context.index);
  });
}

function updateCategorySuggestions() {
  if (!categorySuggestions) return;
  const categories = new Set();
  state.bookmarks.forEach((item) => {
    const label = typeof item.category === "string" ? item.category.trim() : "";
    if (label) {
      categories.add(label);
    }
  });
  const fragment = document.createDocumentFragment();
  Array.from(categories)
    .sort((a, b) => a.localeCompare(b, "zh-CN"))
    .forEach((label) => {
      const option = document.createElement("option");
      option.value = label;
      fragment.appendChild(option);
    });
  replaceChildrenSafe(categorySuggestions, fragment);
}

function getTableColumns(type) {
  if (type === "bookmarks") {
    return [
      { key: "name", label: "名称" },
      { key: "category", label: "分类" },
      { key: "description", label: "描述" },
      { key: "url", label: "链接" },
      { key: "actions", label: "操作" },
    ];
  }

  return [
    { key: "name", label: "名称" },
    { key: "description", label: "描述" },
    { key: "url", label: "链接" },
    { key: "actions", label: "操作" },
  ];
}

function buildTableRow(type, item, index, columns) {
  const row = document.createElement("tr");
  row.dataset.clickable = "true";
  row.dataset.type = type;
  row.dataset.index = String(index);
  row.tabIndex = 0;

  columns.forEach((column) => {
    const cell = document.createElement("td");
    cell.dataset.column = column.key;

    switch (column.key) {
      case "name": {
        cell.appendChild(createNameCell(type, item, index));
        break;
      }
      case "category": {
        const label = typeof item.category === "string" ? item.category.trim() : "";
        cell.textContent = label || "—";
        break;
      }
      case "description": {
        const description = typeof item.description === "string" ? item.description.trim() : "";
        cell.textContent = description || "—";
        break;
      }
      case "url": {
        const url = typeof item.url === "string" ? item.url.trim() : "";
        cell.textContent = url || "—";
        if (url) {
          cell.title = url;
        }
        break;
      }
      case "actions": {
        cell.appendChild(createActionCell(type, index));
        break;
      }
      default: {
        cell.textContent = "";
      }
    }

    row.appendChild(cell);
  });

  return row;
}

function createNameCell(type, item, index) {
  const wrapper = document.createElement("div");
  wrapper.className = "admin-item";

  const displayName =
    typeof item.name === "string" && item.name.trim()
      ? item.name.trim()
      : `${typeLabels[type]} ${index + 1}`;

  const iconWrapper = createItemIcon({ name: displayName, icon: item.icon, className: "admin-item-icon" });

  wrapper.appendChild(iconWrapper);

  const name = document.createElement("p");
  name.className = "admin-item-name";
  name.textContent = displayName;
  wrapper.appendChild(name);

  return wrapper;
}

function createActionCell(type, index) {
  const actions = document.createElement("div");
  actions.className = "admin-table-actions";

  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.className = "secondary-button";
  editButton.dataset.action = "edit";
  editButton.dataset.type = type;
  editButton.dataset.index = String(index);
  editButton.textContent = "编辑";

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "delete-button";
  deleteButton.dataset.action = "delete";
  deleteButton.dataset.type = type;
  deleteButton.dataset.index = String(index);
  deleteButton.textContent = "删除";

  actions.appendChild(editButton);
  actions.appendChild(deleteButton);
  return actions;
}

function showBookmarkCategoryField(value) {
  if (!modalCategoryField || !modalCategoryPlaceholder) return;
  if (!modalCategoryField.isConnected && modalCategoryPlaceholder.parentNode) {
    modalCategoryPlaceholder.replaceWith(modalCategoryField);
  }
  modalCategoryField.hidden = false;
  modalCategoryField.removeAttribute("hidden");
  modalCategoryField.removeAttribute("aria-hidden");
  if (modalCategoryInput) {
    modalCategoryInput.disabled = false;
    modalCategoryInput.value = value || "";
  }
}

function hideBookmarkCategoryField() {
  if (!modalCategoryField || !modalCategoryPlaceholder) return;
  if (modalCategoryField.isConnected) {
    modalCategoryField.hidden = true;
    modalCategoryField.setAttribute("hidden", "");
    modalCategoryField.setAttribute("aria-hidden", "true");
    modalCategoryField.replaceWith(modalCategoryPlaceholder);
  }
  if (modalCategoryInput) {
    modalCategoryInput.value = "";
    modalCategoryInput.disabled = true;
  }
}

function openEditor(type, index) {
  if (activeOperation || !hasLoadedData) return;
  cancelLogoRequest();
  const isNew = typeof index !== "number";
  const reference = isNew ? createBlankItem(type) : state[type][index];
  if (!reference) return;

  modalContext = { type, index, isNew, id: reference.id || crypto.randomUUID() };

  if (modalTitle) {
    modalTitle.textContent = isNew ? `添加${typeLabels[type]}` : `编辑${typeLabels[type]}`;
  }

  if (modalNameInput) modalNameInput.value = reference.name || "";
  if (modalUrlInput) modalUrlInput.value = reference.url || "";
  if (modalDescriptionInput) modalDescriptionInput.value = reference.description || "";
  if (modalIconInput) modalIconInput.value = reference.icon || "";

  if (type === "bookmarks") {
    showBookmarkCategoryField(reference.category || "");
  } else {
    hideBookmarkCategoryField();
  }

  if (modalError) {
    modalError.textContent = "";
  }

  showModal();
}

function showModal() {
  if (!modal) return;
  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  if (modalNameInput) {
    modalNameInput.focus();
    modalNameInput.select();
  }
}

function closeEditor() {
  if (activeOperation) return;
  cancelLogoRequest();
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  if (modalError) {
    modalError.textContent = "";
  }
  hideBookmarkCategoryField();
  modalContext = null;
}

function setModalError(message) {
  if (!modalError) return;
  modalError.textContent = message;
}

function collectPayloadFromModal() {
  if (!modalContext) return null;

  const type = modalContext.type;
  const name = modalNameInput ? modalNameInput.value.trim() : "";
  const url = modalUrlInput ? modalUrlInput.value.trim() : "";
  const description = modalDescriptionInput ? modalDescriptionInput.value.trim() : "";
  const icon = modalIconInput ? modalIconInput.value.trim() : "";
  const category = modalCategoryInput ? modalCategoryInput.value.trim() : "";

  if (!name) {
    setModalError("请填写名称。");
    if (modalNameInput) modalNameInput.focus();
    return null;
  }

  if (!url) {
    setModalError("请填写链接地址。");
    if (modalUrlInput) modalUrlInput.focus();
    return null;
  }

  const existingId =
    !modalContext.isNew && typeof modalContext.index === "number"
      ? state[type][modalContext.index]?.id || ""
      : modalContext.id;

  const payload = {
    id: existingId,
    name,
    url,
    description,
    icon,
  };

  if (type === "bookmarks") {
    payload.category = category;
  }

  return payload;
}

function applyModalChanges(event) {
  event.preventDefault();
  if (!modalContext || activeOperation) return;

  const payload = collectPayloadFromModal();
  if (!payload) return;

  const { type, index, isNew } = modalContext;

  if (isNew) {
    state[type].push(payload);
  } else if (typeof index === "number") {
    state[type][index] = { ...state[type][index], ...payload };
  }

  render(type);
  markDirty();
  setStatus(`${typeLabels[type]}已${modalContext.isNew ? "添加" : "更新"}，记得保存。`, "neutral");
  closeEditor();
}

function handleDelete(type, index) {
  if (activeOperation || !Array.isArray(state[type])) return;
  const confirmed = window.confirm(`确定要删除该${typeLabels[type]}吗？`);
  if (!confirmed) return;
  state[type].splice(index, 1);
  render(type);
  markDirty();
  setStatus(`${typeLabels[type]}已删除，记得保存修改。`, "neutral");
}

function buildSettingsPayload(settings) {
  return {
    siteName: (settings.siteName || "").trim(),
    siteLogo: (settings.siteLogo || "").trim(),
    greeting: (settings.greeting || "").trim(),
    footer: normaliseFooterValue(settings.footer),
    weather: buildWeatherPayload(settings.weather),
    glassOpacity: typeof settings.glassOpacity === "number" ? settings.glassOpacity : 40, // 🆕 添加
    useWallpaper: typeof settings.useWallpaper === "boolean" ? settings.useWallpaper : true, // 🆕 添加
    wallpaperUrl: (settings.wallpaperUrl || "").trim(), // 🆕 添加
  };
}

function updateStateFromResponse(data) {
  if (!data || !Array.isArray(data.apps) || !Array.isArray(data.bookmarks) ||
      !data.settings || typeof data.settings !== "object" || Array.isArray(data.settings) ||
      !Number.isSafeInteger(data._version) || data._version < 0) {
    throw new Error("后台数据响应不完整，当前编辑已保留，请稍后重试。");
  }
  state.apps = normaliseCollectionItems(data?.apps, "apps");
  state.bookmarks = normaliseCollectionItems(data?.bookmarks, "bookmarks");
  state.settings = normaliseSettingsIncoming(data?.settings);
  // ⚠️ 关键修复：正确设置 stats
  state.stats = {
    siteStartDate: data?.siteStartDate || null,
  };
  applySettingsToInputs(state.settings);
  render();
  savedSnapshot._version = data._version;
  syncSavedSnapshot();
  hasLoadedData = true;
  resetDirty();
}

async function requestAuthJson(
  url,
  { method = "GET", body, signal, timeoutMs, unauthorizedMessage = "登录已过期，请重新登录。" } = {}
) {
  const options = { method, signal, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
  if (body !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }

  const { response, payload } = await fetchJson(url, options);

  if (response.status === 401) {
    handleUnauthorized(unauthorizedMessage);
    const error = new Error(unauthorizedMessage);
    error.isUnauthorized = true;
    throw error;
  }

  if (!response.ok || payload?.success !== true) {
    const error = new Error(getPayloadMessage(payload, response.statusText || "请求失败"));
    error.status = response.status;
    throw error;
  }

  return payload;
}

async function loadData(showStatus = true) {
  if (!beginOperation("loading")) return false;
  try {
    const payload = await requestAuthJson(DATA_ENDPOINT);
    const data = getPayloadData(payload);

    updateStateFromResponse(data);
    pendingSave = null;
    if (showStatus) {
      setStatus("数据已加载。", "neutral");
    }
    return true;
  } catch (error) {
    if (error?.isUnauthorized) {
      return false;
    }
    console.error("加载数据失败", error);
    setStatus(error.message || "无法加载数据", "error");
    return false;
  } finally {
    endOperation();
  }
}

async function saveChanges() {
  if (!saveButton || activeOperation) return;
  if (!hasLoadedData) {
    setStatus("请先成功加载后台数据，再保存修改。", "error");
    return;
  }
  if (modalContext) {
    setModalError("请先保存或取消当前条目编辑，再保存站点修改。");
    modalNameInput?.focus();
    return;
  }

  const weatherValidation = validateWeatherSettings(state.settings.weather);
  if (!weatherValidation.valid) {
    setStatus(weatherValidation.message, "error");
    if (weatherValidation.focus && typeof weatherValidation.focus.focus === "function") {
      weatherValidation.focus.focus();
    }
    return;
  }

  state.settings.weather = {
    ...state.settings.weather,
    city: weatherValidation.value.city,
  };

  if (siteWeatherCityInput) {
    siteWeatherCityInput.value = state.settings.weather.city;
  }
  updateWeatherSummary(state.settings.weather);

  const payloadSettings = buildSettingsPayload(state.settings);
  if (!payloadSettings.siteName) {
    setStatus("请填写网站名称。", "error");
    if (siteNameInput) siteNameInput.focus();
    return;
  }
  const appOperations = buildCollectionPatchOperations(savedSnapshot.apps, state.apps, "apps");
  const bookmarkOperations = buildCollectionPatchOperations(
    savedSnapshot.bookmarks,
    state.bookmarks,
    "bookmarks"
  );
  const settingsPatch = buildSettingsPatch(savedSnapshot.settings, state.settings);
  const nextSiteStartDate = normaliseSiteStartDate(state.stats?.siteStartDate);
  const savedSiteStartDate = normaliseSiteStartDate(savedSnapshot.stats?.siteStartDate);
  const isSiteStartDateChanged = nextSiteStartDate !== savedSiteStartDate;

  const hasChanges =
    appOperations.length > 0 ||
    bookmarkOperations.length > 0 ||
    Object.keys(settingsPatch).length > 0 ||
    isSiteStartDateChanged;

  if (!hasChanges) {
    if (pendingSave) {
      setStatus("上次保存结果尚未确认，当前编辑已保留。请先核对最新数据，再决定是否重新加载。", "error");
      return;
    }
    resetDirty();
    setStatus("没有可保存的更改。", "neutral");
    return;
  }

  const changes = {
    _version: savedSnapshot._version,
    operations: { apps: appOperations, bookmarks: bookmarkOperations },
    settings: settingsPatch,
    ...(isSiteStartDateChanged ? { stats: { siteStartDate: nextSiteStartDate } } : {}),
  };
  const fingerprint = JSON.stringify(changes);
  if (!pendingSave || pendingSave.fingerprint !== fingerprint) {
    pendingSave = { fingerprint, body: { ...changes, requestId: crypto.randomUUID() } };
  }
  if (!beginOperation("saving")) return;
  setStatus("正在保存修改，完成前暂时锁定编辑...", "neutral");
  try {
    const payload = await requestAuthJson(DATA_ENDPOINT, { method: "PATCH", body: pendingSave.body });
    updateStateFromResponse(getPayloadData(payload));
    pendingSave = null;
    setStatus("保存成功！", "success");
  } catch (error) {
    if (error?.isUnauthorized) {
      return;
    }
    console.error("保存失败", error);
    if (error?.status === 409) {
      pendingSave = null;
      setStatus("其他页面已更新数据，当前编辑已保留。请先核对最新数据并合并更改；点击“放弃更改”会重新加载并清除本页编辑。", "error");
    } else {
      setStatus(`${error.message || "保存失败，请稍后再试。"} 当前编辑已保留，再次保存相同内容会安全确认本次提交。`, "error");
    }
  } finally {
    endOperation();
  }
}

function handleUnauthorized(message) {
  setStatus(message || "登录状态已失效，正在跳转到登录页...", "error");
  window.location.replace("/login");
}

async function handleLogout() {
  if (activeOperation) return;
  if (isDirty && !window.confirm("退出登录将放弃未保存的修改，确定退出吗？")) return;
  if (!beginOperation("logout")) return;
  try {
    await requestAuthJson("/api/logout", { method: "POST" });
    resetDirty();
    pendingSave = null;
    setStatus("已退出登录，正在返回首页。", "neutral");
    window.location.replace("/");
  } catch (error) {
    if (!error?.isUnauthorized) {
      setStatus(error.message || "退出登录失败，请重试。", "error");
    }
  } finally {
    endOperation();
  }
}

function setPasswordMessage(message, variant = "neutral") {
  if (!passwordMessage) return;
  if (!message) {
    passwordMessage.textContent = "";
    passwordMessage.hidden = true;
    passwordMessage.removeAttribute("data-variant");
    return;
  }
  passwordMessage.textContent = message;
  passwordMessage.hidden = false;
  if (variant === "success" || variant === "error") {
    passwordMessage.dataset.variant = variant;
  } else {
    passwordMessage.removeAttribute("data-variant");
  }
}

async function handlePasswordSubmit(event) {
  event.preventDefault();
  if (!passwordForm || activeOperation) return;

  

  const currentValue = currentPasswordInput ? currentPasswordInput.value : "";
  const trimmedCurrent = currentValue.trim();
  if (!trimmedCurrent) {
    setPasswordMessage("请输入当前密码。", "error");
    if (currentPasswordInput) currentPasswordInput.focus();
    return;
  }

  const newRaw = newPasswordInput ? newPasswordInput.value : "";
  const confirmRaw = confirmPasswordInput ? confirmPasswordInput.value : "";
  const newValue = newRaw.trim();
  const confirmValue = confirmRaw.trim();

  if (!newValue) {
    setPasswordMessage("请输入新密码。", "error");
    if (newPasswordInput) newPasswordInput.focus();
    return;
  }

  if (newValue.length < 6) {
    setPasswordMessage("新密码长度至少需 6 位。", "error");
    if (newPasswordInput) newPasswordInput.focus();
    return;
  }

  if (!confirmValue) {
    setPasswordMessage("请再次输入新密码。", "error");
    if (confirmPasswordInput) confirmPasswordInput.focus();
    return;
  }

  if (newValue !== confirmValue) {
    setPasswordMessage("两次输入的新密码不一致。", "error");
    if (confirmPasswordInput) confirmPasswordInput.focus();
    return;
  }

  setPasswordMessage("正在更新密码...");
  setStatus("正在更新密码...", "neutral");
  if (!beginOperation("password")) return;

  const submitButton = passwordForm.querySelector('button[type="submit"]');
  const passwordInputs = Array.from(passwordForm.querySelectorAll('input[type="password"]'));
  passwordInputs.forEach((input) => {
    input.disabled = true;
  });
  if (submitButton) submitButton.disabled = true;

  let focusCurrentInput = false;

  try {
    const { response, payload } = await fetchJson(PASSWORD_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: trimmedCurrent, newPassword: newValue }),
    });

    if (response.status === 401) {
      const message = getPayloadMessage(payload, "登录已过期，请重新登录后再修改密码。");
      if (message && message.includes("当前密码")) {
        setPasswordMessage(message, "error");
        setStatus(message, "error");
        focusCurrentInput = true;
        return;
      }
      handleUnauthorized(message || "登录已过期，请重新登录后再修改密码。");
      return;
    }

    if (!response.ok || payload?.success !== true) {
      const message = getPayloadMessage(payload, response.statusText);
      throw new Error(message || "密码更新失败");
    }

    const newVersion = getPayloadData(payload)?._version;
    // A password-only commit advances the data version without changing our draft.
    // If other commits intervened, keep the old version so saving cannot mask a conflict.
    if (Number.isSafeInteger(newVersion) && newVersion === savedSnapshot._version + 1) {
      savedSnapshot._version = newVersion;
    }
    passwordForm.reset();
    setPasswordMessage("密码已更新，其他设备的登录已失效。", "success");
    setStatus("密码已更新，其他设备的登录已失效。", "success");
    focusCurrentInput = true;
  } catch (error) {
    console.error("更新密码失败", error);
    const message = error && error.message ? error.message : "密码更新失败，请稍后再试。";
    setPasswordMessage(message, "error");
    setStatus(message, "error");
  } finally {
    if (submitButton) submitButton.disabled = false;
    passwordInputs.forEach((input) => {
      input.disabled = false;
    });
    if (focusCurrentInput && currentPasswordInput) {
      currentPasswordInput.focus();
    }
    endOperation();
  }
}

function cancelLogoRequest() {
  logoRequestToken += 1;
  if (logoRequest) logoRequest.abort();
  logoRequest = null;
  if (fetchLogoButton) {
    fetchLogoButton.disabled = Boolean(activeOperation);
    fetchLogoButton.textContent = fetchLogoButtonLabel;
  }
}

async function handleFetchLogo() {
  if (!modalUrlInput || !modalIconInput || !fetchLogoButton || !modalContext || activeOperation) return;

  const targetUrl = modalUrlInput.value.trim();
  if (!targetUrl) {
    setModalError("请先填写链接地址。");
    modalUrlInput.focus();
    return;
  }

  cancelLogoRequest();
  const requestToken = ++logoRequestToken;
  const editorContext = modalContext;
  const initialIcon = modalIconInput.value;
  const controller = new AbortController();
  logoRequest = controller;
  fetchLogoButton.disabled = true;
  fetchLogoButton.textContent = "获取中...";
  setModalError("");

  try {
    const payload = await requestAuthJson(`/api/fetch-logo?targetUrl=${encodeURIComponent(targetUrl)}`, {
      signal: controller.signal,
      timeoutMs: 35000,
    });
    if (requestToken !== logoRequestToken || modalContext !== editorContext ||
        modalUrlInput.value.trim() !== targetUrl || modalIconInput.value !== initialIcon) return;

    if (!payload?.success) {
      throw new Error(getPayloadMessage(payload, "获取 Logo 失败"));
    }

    if (payload.logoUrl) {
      modalIconInput.value = payload.logoUrl;
    } else {
      throw new Error("未能找到 Logo");
    }
  } catch (error) {
    if (requestToken !== logoRequestToken || controller.signal.aborted || error?.isUnauthorized) {
      return;
    }
    console.error("获取 Logo 失败:", error);
    setModalError(error.message || "获取 Logo 失败，请稍后重试。");
  } finally {
    if (requestToken === logoRequestToken) {
      logoRequest = null;
      fetchLogoButton.disabled = Boolean(activeOperation);
      fetchLogoButton.textContent = fetchLogoButtonLabel;
    }
  }
}

function bindEvents() {
  // isDirty 状态下离开页面前弹原生确认,防误关
  window.addEventListener("beforeunload", (event) => {
    if (isDirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  addButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const target = button.dataset.target;
      if (target !== "apps" && target !== "bookmarks") return;
      openEditor(target);
    });
  });

  
  // 🆕 添加透明度滑块事件
  if (siteGlassOpacityInput) {
    siteGlassOpacityInput.addEventListener("input", () => {
      if (activeOperation) return;
      const value = parseInt(siteGlassOpacityInput.value, 10);
      if (opacityValueDisplay) {
        opacityValueDisplay.textContent = `${value}%`;
      }
      state.settings.glassOpacity = value;
      markDirty();
      setStatus("容器透明度已更新，记得保存。", "neutral");
    });
  }

  // 🆕 壁纸 URL 输入框事件
  if (siteWallpaperUrlInput) {
    siteWallpaperUrlInput.addEventListener("input", () => {
      if (activeOperation) return;
      state.settings.wallpaperUrl = siteWallpaperUrlInput.value.trim();
      markDirty();
      setStatus("壁纸 URL 已更新，记得保存。", "neutral");
    });
  }
  // 🆕 添加开关事件监听
  if (siteUseWallpaperInput) {
    siteUseWallpaperInput.addEventListener("change", () => {
      if (activeOperation) return;
      const isEnabled = siteUseWallpaperInput.checked;
      // 启用/禁用 URL 输入框
      if (siteWallpaperUrlInput) {
        siteWallpaperUrlInput.disabled = !isEnabled;
      } 
      // 更新状态
      state.settings.useWallpaper = isEnabled;
      markDirty();
      setStatus(`壁纸${isEnabled ? "启用" : "禁用"}，记得保存。`, "neutral");
    });
  }


  if (saveButton) {
    saveButton.addEventListener("click", saveChanges);
  }

  if (reloadButton) {
    reloadButton.addEventListener("click", async () => {
      if (activeOperation) return;
      if (isDirty) {
        const confirmed = window.confirm("确定要放弃未保存的修改吗？");
        if (!confirmed) return;
      }
      const restored = await loadData(false);
      if (restored) {
        setStatus("已恢复为最新数据。", "neutral");
      }
    });
  }

  if (siteNameInput) {
    siteNameInput.addEventListener("input", () => {
      handleSettingsChange("siteName", siteNameInput.value);
    });
  }

  if (siteLogoInput) {
    siteLogoInput.addEventListener("input", () => {
      handleSettingsChange("siteLogo", siteLogoInput.value);
    });
  }

  if (siteGreetingInput) {
    siteGreetingInput.addEventListener("input", () => {
      handleSettingsChange("greeting", siteGreetingInput.value);
    });
  }

  if (siteFooterInput) {
    siteFooterInput.addEventListener("input", () => {
      handleSettingsChange("footer", siteFooterInput.value);
    });
  }

  if (siteWeatherCityInput) {
    siteWeatherCityInput.addEventListener("input", handleWeatherInputChange);
  }

  if (fetchLogoButton) {
    fetchLogoButton.addEventListener("click", handleFetchLogo);
  }
  modalUrlInput?.addEventListener("input", cancelLogoRequest);
  modalIconInput?.addEventListener("input", cancelLogoRequest);

  if (modalForm) {
    modalForm.addEventListener("submit", applyModalChanges);
  }

  if (modalCancelButton) {
    modalCancelButton.addEventListener("click", (event) => {
      event.preventDefault();
      closeEditor();
    });
  }

  if (modalCloseButton) {
    modalCloseButton.addEventListener("click", () => {
      closeEditor();
    });
  }

  if (modalOverlay) {
    modalOverlay.addEventListener("click", () => {
      closeEditor();
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal && !modal.hidden) {
      closeEditor();
    }
  });

  if (passwordForm) {
    passwordForm.addEventListener("submit", handlePasswordSubmit);
    const passwordInputs = passwordForm.querySelectorAll('input[type="password"]');
    passwordInputs.forEach((input) => {
      input.addEventListener("input", () => {
        setPasswordMessage("");
      });
    });
  }

  if (logoutButton) {
    logoutButton.addEventListener("click", handleLogout);
  }

  if (backToAppsButton) {
    backToAppsButton.addEventListener("click", () => {
      scrollToSection("apps-editor-title");
    });
  }

  if (backToBookmarksButton) {
    backToBookmarksButton.addEventListener("click", () => {
      scrollToSection("bookmarks-editor-title");
    });
  }

  // 🆕 运行开始日期输入事件
  if (siteStartDateInput) {
    siteStartDateInput.addEventListener("input", () => {
      if (activeOperation) return;
      state.stats.siteStartDate = siteStartDateInput.value || null;
      markDirty();
      setStatus("网站运行开始日期已更新，记得保存。", "neutral");
    });
  }
}

function scrollToSection(targetId) {
  const targetElement = document.getElementById(targetId);
  if (!targetElement) return;

  const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  if (prefersReducedMotion) {
    targetElement.scrollIntoView();
    return;
  }
  targetElement.scrollIntoView({ behavior: "smooth" });
}

function handleBackToTopVisibility() {
  setBackToTopVisibility(backToTopButton, BACK_TO_TOP_THRESHOLD);
}

async function initialise() {
  updatePageIdentity(state.settings);
  if (backToTopButton) {
    backToTopButton.addEventListener("click", (event) => {
      event.preventDefault();
      scrollToTop();
    });
    handleBackToTopVisibility();
    window.addEventListener("scroll", handleBackToTopVisibility, { passive: true });
  }
  bindEvents();
  applySettingsToInputs(state.settings);
  render();
  resetDirty();
  setStatus("正在加载数据...", "neutral");

  const success = await loadData(false);
  if (success) {
    setStatus("数据已加载。", "neutral");
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialise);
} else {
  initialise();
}
