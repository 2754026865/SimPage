const themeToggle = document.getElementById("theme-toggle");
const body = document.body;
let memoryTheme = null;
let storageAvailable = true;

function readTheme() {
  try { if (storageAvailable) memoryTheme = localStorage.getItem("theme"); } catch (_error) { storageAvailable = false; }
  return memoryTheme === "dark" || memoryTheme === "light" ? memoryTheme : null;
}

function saveTheme(theme) {
  memoryTheme = theme;
  try {
    if (theme) localStorage.setItem("theme", theme);
    else localStorage.removeItem("theme");
  } catch (_error) { storageAvailable = false; }
}

// 应用指定的主题到文档
const applyTheme = (theme) => {
  if (theme === "dark") {
    body.classList.add("dark-theme");
    document.documentElement.setAttribute("data-theme", "dark");
  } else {
    body.classList.remove("dark-theme");
    document.documentElement.setAttribute("data-theme", "light");
  }
};

// 同步当前主题，优先使用本地存储，否则根据系统设置
const syncTheme = () => {
  const savedTheme = readTheme();
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

  if (savedTheme) {
    applyTheme(savedTheme);
  } else {
    applyTheme(prefersDark ? "dark" : "light");
  }
};

// 处理主题切换按钮的点击事件
const toggleTheme = () => {
  const savedTheme = readTheme();
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const systemTheme = prefersDark ? "dark" : "light";
  const currentTheme = savedTheme || systemTheme;

  if (currentTheme === systemTheme) {
    // 当前主题与系统一致，切换到相反的主题作为覆盖
    const newTheme = systemTheme === "dark" ? "light" : "dark";
    saveTheme(newTheme);
  } else {
    // 当前主题是覆盖状态，移除覆盖，回归到系统主题
    saveTheme(null);
  }
  
  syncTheme();
};

// 为切换按钮添加点击事件监听器
if (themeToggle) {
  themeToggle.addEventListener("click", toggleTheme);
}

// 监听系统颜色方案的变化
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncTheme);

// 页面加载时初始化主题
syncTheme();
