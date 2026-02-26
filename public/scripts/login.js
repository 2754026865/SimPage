import { fetchJson, getPayloadMessage } from "./shared/api-utils.js";

const LOGIN_ENDPOINT = "/api/login";

const form = document.getElementById("login-form");
const passwordInput = document.getElementById("login-password");
const errorEl = document.getElementById("login-error");
const submitBtn = document.getElementById("login-submit");

function showError(message) {
  if (!errorEl) return;
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function hideError() {
  if (!errorEl) return;
  errorEl.textContent = "";
  errorEl.hidden = true;
}

function setSubmittingState(isSubmitting) {
  if (!passwordInput || !submitBtn) return;
  submitBtn.disabled = isSubmitting;
  passwordInput.disabled = isSubmitting;
  submitBtn.textContent = isSubmitting ? "登录中..." : "登录";
}

async function handleSubmit(event) {
  event.preventDefault();
  if (!passwordInput || !submitBtn) return;
  hideError();

  const password = passwordInput.value.trim();
  if (!password) {
    showError("请输入密码。");
    passwordInput.focus();
    return;
  }

  setSubmittingState(true);

  try {
    const { response, payload } = await fetchJson(LOGIN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });

    if (!response.ok || payload?.success !== true) {
      throw new Error(getPayloadMessage(payload, "登录失败"));
    }

    window.location.href = "/admin";
  } catch (error) {
    showError(error?.message || "登录失败，请重试。");
    passwordInput.focus();
  } finally {
    setSubmittingState(false);
  }
}

async function checkExistingSession() {
  try {
    const { response } = await fetchJson("/api/admin/data", { cache: "no-store" });
    if (response.ok) {
      window.location.replace("/admin");
    }
  } catch (_error) {
    // ignore
  }
}

if (form) {
  form.addEventListener("submit", handleSubmit);
}
checkExistingSession();
