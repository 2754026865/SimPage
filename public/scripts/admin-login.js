const loginForm = document.getElementById("login-form");
const loginPasswordInput = document.getElementById("login-password");
const loginError = document.getElementById("login-error");

const LOGIN_ENDPOINT = "/api/login";
const STORAGE_KEY = "modern-navigation-admin-token";
const EXPIRY_KEY = "simpage-admin-expiry";

function setLoginError(message) {
  if (!loginError) return;
  if (message) {
    loginError.textContent = message;
    loginError.hidden = false;
  } else {
    loginError.textContent = "";
    loginError.hidden = true;
  }
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  if (!loginPasswordInput) return;

  const password = loginPasswordInput.value.trim();
  if (!password) {
    setLoginError("请输入密码。");
    loginPasswordInput.focus();
    return;
  }

  setLoginError("");
  const submitButton = loginForm.querySelector('button[type="submit"]');
  if (submitButton) submitButton.disabled = true;
  loginPasswordInput.disabled = true;

  try {
    const response = await fetch(LOGIN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });

    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || "登录失败");
    }

    // 存储 token 和过期时间
    localStorage.setItem(STORAGE_KEY, result.token);
    localStorage.setItem(EXPIRY_KEY, result.expiresAt);

    // 跳转到管理控制台
    window.location.replace("/admin/console");
  } catch (error) {
    console.error("登录失败", error);
    setLoginError(error.message || "登录失败，请重试。");
    loginPasswordInput.focus();
  } finally {
    if (submitButton) submitButton.disabled = false;
    loginPasswordInput.disabled = false;
  }
}

// 检查是否已登录
function checkExistingSession() {
  const token = localStorage.getItem(STORAGE_KEY);
  const expiresAt = localStorage.getItem(EXPIRY_KEY);

  if (token && expiresAt && Date.now() < parseInt(expiresAt, 10)) {
    // 已登录且未过期，直接跳转
    window.location.replace("/admin/console");
  }
}

if (loginForm) {
  loginForm.addEventListener("submit", handleLoginSubmit);
}

// 页面加载时检查
checkExistingSession();
