import { getAssetFromKV } from "@cloudflare/kv-asset-handler";
import { Router } from "itty-router";
import manifest from "__STATIC_CONTENT_MANIFEST";

const assetManifest = JSON.parse(manifest);
const router = Router();


// =================================================================================
// Constants and Defaults
// =================================================================================

const BASE_DEFAULT_SETTINGS = Object.freeze({
  siteName: "SimPage",
  siteLogo: "",
  greeting: "",
  footer: "",
  glassOpacity: 40, // 🆕 添加默认透明度
  useWallpaper: true, // 🆕 添加
  wallpaperUrl: "https://bing.img.run/uhd.php", // 🆕 添加默认壁纸 URL
});

const DEFAULT_STATS = Object.freeze({
  visitorCount: 0,
  siteStartDate: null, // 🆕 添加
});

const DEFAULT_WEATHER_CONFIG = Object.freeze({
  city: "北京",
});

const DEFAULT_ADMIN_PASSWORD = "admin123";
const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 hours in seconds
const AUTH_HEADER_PREFIX = "Bearer ";

// 🆕 Security Configuration
// =================================================================================
const SECURITY_CONFIG = Object.freeze({
  ACCESS_TOKEN_TTL: 15 * 60, // 15 分钟
  REFRESH_TOKEN_TTL: 7 * 24 * 60 * 60, // 7 天
  MAX_LOGIN_ATTEMPTS: 5, // 最大失败次数
  LOCKOUT_DURATION: 15 * 60, // 锁定时长（秒）
  ENABLE_SSO: true, // 启用单点登录
  ENABLE_IP_CHECK: false, // IP 变化检测（可选）
});
// =================================================================================
// API Routes
// =================================================================================

router.post("/api/login", handleLogin);
router.get("/api/data", handleGetData);
router.get("/api/weather", handleGetWeather);
router.get("/api/admin/data", requireAuth, handleGetAdminData);
router.put("/api/admin/data", requireAuth, handleDataUpdate);
router.put("/api/data", requireAuth, handleDataUpdate); // Legacy endpoint
router.post("/api/admin/password", requireAuth, handlePasswordUpdate);
router.get("/api/fetch-logo", requireAuth, handleFetchLogo);
// 🆕 新增 API 路由
router.post("/api/refresh", handleRefreshToken);
router.post("/api/logout", handleLogout);
router.get("/api/admin/sessions", requireAuth, handleGetSessions);

// =================================================================================
// Static Asset and Fallback Routes
// =================================================================================

router.get("/admin", (request, env, ctx) => serveStatic(request, env, ctx, "/admin.html"));
// 🆕 将 /admin/ 重定向到 /admin（301 永久重定向）
router.get("/admin/", () => {
  return Response.redirect("/admin", 301);
});

// Fallback for all other GET requests to serve static assets or index.html
router.get("*", (request, env, ctx) => serveStatic(request, env, ctx));

// 404 for all other methods
router.all("*", () => new Response("Not Found", { status: 404 }));

// =================================================================================
// Main Fetch Handler
// =================================================================================

export default {
  async fetch(request, env, ctx) {
    try {
      return await router.handle(request, env, ctx);
    } catch (error) {
      console.error("Unhandled error:", error);
      const errorResponse = {
        success: false,
        message: error.message,
        stack: error.stack,
      };
      return new Response(JSON.stringify(errorResponse, null, 2), {
        status: 500,
        headers: { "Content-Type": "application/json;charset=UTF-8" },
      });
    }
  },
};

// =================================================================================
// Static Asset Handler
// =================================================================================

async function serveStatic(request, env, ctx, forcePath) {
  const url = new URL(request.url);
  // Use a forced path for routes like /admin
  if (forcePath) {
    url.pathname = forcePath;
    request = new Request(url.toString(), request);
  }

  try {
    // Intercept requests for static data files and serve them from KV
    if (url.pathname.startsWith("/data/")) {
      const key = url.pathname.substring(1); // remove leading '/'
      const object = await env.__STATIC_CONTENT.get(key, { type: "arrayBuffer" });
      if (object === null) {
        return new Response("Not found", { status: 404 });
      }
      const headers = {
        "content-type": "application/json;charset=UTF-8",
        "cache-control": "public, max-age=3600", // Cache for 1 hour
      };
      return new Response(object, { headers });
    }

    const asset = await getAssetFromKV(
      {
        request,
        waitUntil: (promise) => ctx.waitUntil(promise),
      },
      {
        ASSET_NAMESPACE: env.__STATIC_CONTENT,
        ASSET_MANIFEST: assetManifest,
      }
    );
    return asset;
  } catch (e) {
    // 🆕 只对根路径做 fallback，移除 isHTMLRequest 判断
    const currentUrl = new URL(request.url);
    const isRoot = currentUrl.pathname === "/";

    if (isRoot) {
      try {
        const notFoundRequest = new Request(new URL("/index.html", request.url), request);
        return await getAssetFromKV(
          {
            request: notFoundRequest,
            waitUntil: (promise) => ctx.waitUntil(promise),
          },
          {
            ASSET_NAMESPACE: env.__STATIC_CONTENT,
            ASSET_MANIFEST: assetManifest,
          }
        );
      } catch (e2) {
        return new Response("Not Found", { status: 404 });
      }
    }
    
    // 🆕 其他所有路径返回 404
    return new Response("Not Found", { status: 404 });
  }
}


// =================================================================================
// API Handlers
// =================================================================================

async function handleLogin(request, env) {
  try {
    const body = await request.json().catch(() => null);
    const password = typeof body?.password === "string" ? body.password : "";
    const ip = getClientIP(request);
    const username = "admin";
    
    if (!password) {
      await logLoginAttempt(env, request, false, username, "密码为空");
      return jsonResponse({ success: false, message: "请输入密码。" }, 400);
    }
    
    const lockoutCheck = await checkLoginLockout(env, ip, username);
    if (lockoutCheck.locked) {
      await logLoginAttempt(env, request, false, username, "账号已锁定");
      return jsonResponse({ success: false, message: lockoutCheck.message }, 429);
    }
    
    const fullData = await readFullData(env);
    const admin = fullData.admin;
    if (!admin || !admin.passwordSalt || !admin.passwordHash) {
      return jsonResponse({ success: false, message: "登录功能暂不可用。" }, 500);
    }
    
    const isMatch = await verifyPassword(password, admin.passwordSalt, admin.passwordHash);
    
    if (!isMatch) {
      await recordLoginFailure(env, ip, username);
      await logLoginAttempt(env, request, false, username, "密码错误");
      return jsonResponse({ success: false, message: "密码错误。" }, 401);
    }
    
    await clearLoginAttempts(env, ip, username);
    
    const { session, tokens } = await createSession(env, request, username);
    
    await logLoginAttempt(env, request, true, username, "登录成功");
    
    // 🆕 准备返回的数据（与 handleGetAdminData 逻辑一致）
    const data = sanitiseData(fullData);
    const weather = normaliseWeatherSettingsValue(fullData.settings?.weather);
    const cityString = Array.isArray(weather.city) ? weather.city.join(" ") : weather.city;
    data.settings.weather = { city: cityString };
    
    const response = jsonResponse({
      success: true,
      accessToken: tokens.accessToken,
      expiresIn: SECURITY_CONFIG.ACCESS_TOKEN_TTL,
      data: data, // 🆕 直接返回数据
    });
    
    response.headers.set(
      "Set-Cookie",
      `refreshToken=${tokens.refreshToken}; HttpOnly; Secure; SameSite=Strict; Max-Age=${SECURITY_CONFIG.REFRESH_TOKEN_TTL}; Path=/`
    );
    
    return response;
  } catch (error) {
    console.error("登录失败:", error);
    return jsonResponse({ success: false, message: "登录失败" }, 500);
  }
}


async function handleGetData(request, env) {
  try {
    const data = await incrementVisitorCountAndReadData(env);
    return jsonResponse(data);
  } catch (error) {
    console.error("Error in handleGetData:", error);
    return jsonResponse(
      {
        success: false,
        message: `Error fetching data: ${error.message}`,
        stack: error.stack,
      },
      500
    );
  }
}


async function handleGetWeather(request, env, ctx) {
  try {
    const fullData = await readFullData(env);
    const weatherSettings = normaliseWeatherSettingsValue(fullData.settings?.weather);
    let cities = weatherSettings.city;
    if (!Array.isArray(cities) || cities.length === 0) {
      cities = [DEFAULT_WEATHER_CONFIG.city];
    }

    const weatherPromises = cities.map(city =>
      fetchOpenMeteoWeather(city, env, ctx)
        .then(weather => ({ ...weather, city, success: true }))
        .catch(error => {
          console.error(`获取城市 ${city} 的天气信息失败：`, error);
          return { city, success: false, message: error.message };
        })
    );

    const results = await Promise.all(weatherPromises);
    const successfulWeatherData = results.filter(r => r.success);

    if (successfulWeatherData.length === 0 && results.length > 0) {
      const firstError = results.find(r => !r.success);
      const errorMessage = firstError?.message || "无法获取任何城市的天气信息。";
      return jsonResponse({ success: false, message: errorMessage }, 502);
    }

    return jsonResponse({ success: true, data: successfulWeatherData });
  } catch (error) {
    const statusCode = error.statusCode || 502;
    return jsonResponse({ success: false, message: error.message }, statusCode);
  }
}

async function handleGetAdminData(request, env) {
  const fullData = await readFullData(env);
  const data = sanitiseData(fullData);
  const weather = normaliseWeatherSettingsValue(fullData.settings?.weather);
  const cityString = Array.isArray(weather.city) ? weather.city.join(" ") : weather.city;
  data.settings.weather = { city: cityString };
  return jsonResponse({ success: true, data });
}

async function handleDataUpdate(request, env) {
  try {
    const { apps, bookmarks, settings, stats } = await request.json(); // ⚠️ 添加 stats
    const normalisedApps = normaliseCollection(apps, { label: "应用", type: "apps" });
    const normalisedBookmarks = normaliseCollection(bookmarks, { label: "书签", type: "bookmarks" });
    const normalisedSettings = normaliseSettingsInput(settings);

    const existing = await readFullData(env);
    // 🆕 处理 stats
    const normalisedStats = {
      visitorCount: existing.stats?.visitorCount || 0,
      siteStartDate: typeof stats?.siteStartDate === "string" ? stats.siteStartDate : null,
    };

    const payload = {
      settings: normalisedSettings,
      apps: normalisedApps,
      bookmarks: normalisedBookmarks,
      stats: normalisedStats,
      admin: existing.admin,
    };

    await writeFullData(env, payload);
    return jsonResponse({ success: true, data: sanitiseData(payload) });
  } catch (error) {
    return jsonResponse({ success: false, message: error.message }, 400);
  }
}


async function handlePasswordUpdate(request, env) {
  const body = await request.json().catch(() => null);
  const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const newPasswordRaw = typeof body?.newPassword === "string" ? body.newPassword : "";

  if (!currentPassword) {
    return jsonResponse({ success: false, message: "请输入当前密码。" }, 400);
  }
  const cleanNewPassword = newPasswordRaw.trim();
  if (!cleanNewPassword || cleanNewPassword.length < 6) {
    return jsonResponse({ success: false, message: "新密码长度至少为 6 位。" }, 400);
  }

  const fullData = await readFullData(env);
  const admin = fullData.admin;
  if (!admin || !admin.passwordHash || !admin.passwordSalt) {
    return jsonResponse({ success: false, message: "密码修改功能暂不可用。" }, 500);
  }

  const isMatch = await verifyPassword(currentPassword, admin.passwordSalt, admin.passwordHash);
  if (!isMatch) {
    return jsonResponse({ success: false, message: "当前密码不正确。" }, 401);
  }

  const isSameAsOld = await verifyPassword(cleanNewPassword, admin.passwordSalt, admin.passwordHash);
  if (isSameAsOld) {
    return jsonResponse({ success: false, message: "新密码不能与当前密码相同。" }, 400);
  }

  const { passwordHash, passwordSalt } = await hashPassword(cleanNewPassword);
  const updatedData = {
    ...fullData,
    admin: { passwordHash, passwordSalt },
  };

  await writeFullData(env, updatedData);
  return jsonResponse({ success: true, message: "密码已更新，下次登录请使用新密码。" });
}
/**
 * 🆕 刷新 Token 接口
 */
async function handleRefreshToken(request, env) {
  try {
    const cookies = request.headers.get("cookie") || "";
    const refreshToken = cookies
      .split(";")
      .find(c => c.trim().startsWith("refreshToken="))
      ?.split("=")[1];
    
    if (!refreshToken) {
      return jsonResponse({ success: false, message: "未找到 Refresh Token" }, 401);
    }
    
    const result = await refreshAccessToken(env, refreshToken);
    
    if (!result.success) {
      return jsonResponse({ success: false, message: result.message }, 401);
    }
    
    return jsonResponse({
      success: true,
      accessToken: result.accessToken,
      expiresIn: SECURITY_CONFIG.ACCESS_TOKEN_TTL,
    });
  } catch (error) {
    console.error("刷新 Token 失败:", error);
    return jsonResponse({ success: false, message: "刷新失败" }, 500);
  }
}
/**
 * 🆕 登出接口
 */
async function handleLogout(request, env) {
  try {
    const authHeader = request.headers.get("authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7).trim();
      await logoutSession(env, token);
    }
    
    // 清除 Cookie
    const response = jsonResponse({ success: true, message: "已登出" });
    response.headers.set(
      "Set-Cookie",
      "refreshToken=; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Path=/"
    );
    
    return response;
  } catch (error) {
    console.error("登出失败:", error);
    return jsonResponse({ success: false, message: "登出失败" }, 500);
  }
}
/**
 * 🆕 查看活跃会话
 */
async function handleGetSessions(request, env) {
  try {
    const userId = request.session?.userId || "admin";
    const sessionId = await env.SESSIONS.get(`ACTIVE_SESSION:${userId}`);
    
    if (!sessionId) {
      return jsonResponse({ success: true, sessions: [] });
    }
    
    const session = await env.SESSIONS.get(`SESSION:${sessionId}`, { type: "json" });
    
    if (!session) {
      return jsonResponse({ success: true, sessions: [] });
    }
    
    // 隐藏敏感信息
    const sanitized = {
      sessionId: session.sessionId,
      createdAt: session.createdAt,
      lastAccessAt: session.lastAccessAt,
      deviceInfo: {
        userAgent: session.deviceInfo.userAgent,
        ip: session.deviceInfo.ip,
      },
      isActive: session.isActive,
    };
    
    return jsonResponse({ success: true, sessions: [sanitized] });
  } catch (error) {
    console.error("获取会话失败:", error);
    return jsonResponse({ success: false, message: "获取会话失败" }, 500);
  }
}

/**
 * 🆕 计算网站运行天数
 */
function calculateRunningDays(startDate) {
  if (!startDate) return 0;
  
  try {
    const start = new Date(startDate);
    const now = new Date();
    
    // 验证日期有效性
    if (isNaN(start.getTime())) return 0;
    
    // 计算天数差
    const diffTime = now - start;
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    
    return Math.max(0, diffDays);
  } catch (error) {
    console.error("计算运行天数失败:", error);
    return 0;
  }
}


function handleFetchLogo(request, env) {
  try {
    const { searchParams } = new URL(request.url);
    const targetUrl = searchParams.get("targetUrl");

    if (!targetUrl || typeof targetUrl !== "string" || !targetUrl.trim()) {
      return jsonResponse({ success: false, message: "缺少有效的 targetUrl 参数" }, 400);
    }

    // 移除协议 (http, https)
    let domain = targetUrl.trim().replace(/^(https?:\/\/)?/, "");
    // 移除第一个斜杠后的所有内容 (路径, 查询参数, 哈希)
    domain = domain.split("/")[0];

    if (!domain) {
      return jsonResponse({ success: false, message: "无法从链接中提取域名。" }, 400);
    }

    const logoUrl = `https://icon.ooo/${domain}`;
    return jsonResponse({ success: true, logoUrl: logoUrl });

  } catch (error) {
    console.error("生成 Logo 链接时发生内部错误:", error);
    return jsonResponse({ success: false, message: "生成 Logo 链接失败" }, 500);
  }
}
// =================================================================================
// 🆕 Security Utility Functions
// =================================================================================
/**
 * 生成设备指纹
 */
function generateDeviceFingerprint(request) {
  const userAgent = request.headers.get("user-agent") || "";
  const acceptLanguage = request.headers.get("accept-language") || "";
  const acceptEncoding = request.headers.get("accept-encoding") || "";
  
  const fingerprint = `${userAgent}|${acceptLanguage}|${acceptEncoding}`;
  return hashString(fingerprint);
}
/**
 * 简单字符串哈希
 */
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}
/**
 * 获取客户端 IP
 */
function getClientIP(request) {
  return request.headers.get("cf-connecting-ip") || 
         request.headers.get("x-forwarded-for")?.split(",")[0] || 
         "unknown";
}
/**
 * 生成 Token 对
 */
function generateTokenPair() {
  return {
    accessToken: crypto.randomUUID(),
    refreshToken: crypto.randomUUID(),
  };
}
/**
 * 检查是否被锁定
 */
async function checkLoginLockout(env, ip, username) {
  const key = `LOGIN_ATTEMPTS:${ip}:${username}`;
  const data = await env.SESSIONS.get(key, { type: "json" });
  
  if (!data) return { locked: false };
  
  const now = Date.now();
  if (data.lockedUntil && now < data.lockedUntil) {
    const remainingSeconds = Math.ceil((data.lockedUntil - now) / 1000);
    return {
      locked: true,
      remainingSeconds,
      message: `账号已被锁定，请 ${remainingSeconds} 秒后重试。`,
    };
  }
  
  return { locked: false, attempts: data.attempts || 0 };
}
/**
 * 记录登录失败
 */
async function recordLoginFailure(env, ip, username) {
  const key = `LOGIN_ATTEMPTS:${ip}:${username}`;
  const data = await env.SESSIONS.get(key, { type: "json" }) || { attempts: 0 };
  
  data.attempts += 1;
  data.lastAttempt = Date.now();
  
  if (data.attempts >= SECURITY_CONFIG.MAX_LOGIN_ATTEMPTS) {
    data.lockedUntil = Date.now() + (SECURITY_CONFIG.LOCKOUT_DURATION * 1000);
  }
  
  await env.SESSIONS.put(key, JSON.stringify(data), {
    expirationTtl: SECURITY_CONFIG.LOCKOUT_DURATION,
  });
  
  return data;
}
/**
 * 清除登录失败记录
 */
async function clearLoginAttempts(env, ip, username) {
  const key = `LOGIN_ATTEMPTS:${ip}:${username}`;
  await env.SESSIONS.delete(key);
}
/**
 * 创建会话
 */
async function createSession(env, request, userId = "admin") {
  const ip = getClientIP(request);
  const userAgent = request.headers.get("user-agent") || "";
  const deviceFingerprint = generateDeviceFingerprint(request);
  const tokens = generateTokenPair();
  
  const sessionId = crypto.randomUUID();
  const now = Date.now();
  
  const session = {
    sessionId,
    userId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    createdAt: now,
    lastAccessAt: now,
    expiresAt: now + (SECURITY_CONFIG.REFRESH_TOKEN_TTL * 1000),
    deviceInfo: {
      userAgent,
      ip,
      fingerprint: deviceFingerprint,
    },
    isActive: true,
  };
  
  // 单点登录：踢出旧会话
  if (SECURITY_CONFIG.ENABLE_SSO) {
    await revokeUserSessions(env, userId);
  }
  
  // 存储会话
  await env.SESSIONS.put(
    `SESSION:${sessionId}`,
    JSON.stringify(session),
    { expirationTtl: SECURITY_CONFIG.REFRESH_TOKEN_TTL }
  );
  
  // 存储 Access Token 映射
  await env.SESSIONS.put(
    `ACCESS_TOKEN:${tokens.accessToken}`,
    sessionId,
    { expirationTtl: SECURITY_CONFIG.ACCESS_TOKEN_TTL }
  );
  
  // 存储 Refresh Token 映射
  await env.SESSIONS.put(
    `REFRESH_TOKEN:${tokens.refreshToken}`,
    sessionId,
    { expirationTtl: SECURITY_CONFIG.REFRESH_TOKEN_TTL }
  );
  
  // 记录活跃会话
  await env.SESSIONS.put(
    `ACTIVE_SESSION:${userId}`,
    sessionId,
    { expirationTtl: SECURITY_CONFIG.REFRESH_TOKEN_TTL }
  );
  
  return { session, tokens };
}
/**
 * 验证 Access Token
 */
async function validateAccessToken(env, token) {
  // 检查黑名单
  const isBlacklisted = await env.SESSIONS.get(`BLACKLIST:${token}`);
  if (isBlacklisted) {
    return { valid: false, reason: "Token 已被撤销" };
  }
  
  // 获取会话 ID
  const sessionId = await env.SESSIONS.get(`ACCESS_TOKEN:${token}`);
  if (!sessionId) {
    return { valid: false, reason: "Token 无效或已过期" };
  }
  
  // 获取会话信息
  const sessionData = await env.SESSIONS.get(`SESSION:${sessionId}`, { type: "json" });
  if (!sessionData || !sessionData.isActive) {
    return { valid: false, reason: "会话已失效" };
  }
  
  // 更新最后访问时间
  sessionData.lastAccessAt = Date.now();
  await env.SESSIONS.put(
    `SESSION:${sessionId}`,
    JSON.stringify(sessionData),
    { expirationTtl: SECURITY_CONFIG.REFRESH_TOKEN_TTL }
  );
  
  return { valid: true, session: sessionData };
}
/**
 * 刷新 Token
 */
async function refreshAccessToken(env, refreshToken) {
  const sessionId = await env.SESSIONS.get(`REFRESH_TOKEN:${refreshToken}`);
  if (!sessionId) {
    return { success: false, message: "Refresh Token 无效" };
  }
  
  const sessionData = await env.SESSIONS.get(`SESSION:${sessionId}`, { type: "json" });
  if (!sessionData || !sessionData.isActive) {
    return { success: false, message: "会话已失效" };
  }
  
  // 生成新的 Access Token
  const newAccessToken = crypto.randomUUID();
  sessionData.accessToken = newAccessToken;
  sessionData.lastAccessAt = Date.now();
  
  // 更新会话
  await env.SESSIONS.put(
    `SESSION:${sessionId}`,
    JSON.stringify(sessionData),
    { expirationTtl: SECURITY_CONFIG.REFRESH_TOKEN_TTL }
  );
  
  // 存储新的 Access Token 映射
  await env.SESSIONS.put(
    `ACCESS_TOKEN:${newAccessToken}`,
    sessionId,
    { expirationTtl: SECURITY_CONFIG.ACCESS_TOKEN_TTL }
  );
  
  return { success: true, accessToken: newAccessToken };
}
/**
 * 撤销用户所有会话
 */
async function revokeUserSessions(env, userId) {
  const oldSessionId = await env.SESSIONS.get(`ACTIVE_SESSION:${userId}`);
  if (oldSessionId) {
    const oldSession = await env.SESSIONS.get(`SESSION:${oldSessionId}`, { type: "json" });
    if (oldSession) {
      // 将旧 Token 加入黑名单
      await env.SESSIONS.put(
        `BLACKLIST:${oldSession.accessToken}`,
        "revoked",
        { expirationTtl: SECURITY_CONFIG.ACCESS_TOKEN_TTL }
      );
      
      // 标记会话为非活跃
      oldSession.isActive = false;
      await env.SESSIONS.put(
        `SESSION:${oldSessionId}`,
        JSON.stringify(oldSession),
        { expirationTtl: 60 }
      );
    }
  }
}
/**
 * 登出
 */
async function logoutSession(env, accessToken) {
  const sessionId = await env.SESSIONS.get(`ACCESS_TOKEN:${accessToken}`);
  if (!sessionId) return;
  
  const sessionData = await env.SESSIONS.get(`SESSION:${sessionId}`, { type: "json" });
  if (!sessionData) return;
  
  // 加入黑名单
  await env.SESSIONS.put(
    `BLACKLIST:${accessToken}`,
    "revoked",
    { expirationTtl: SECURITY_CONFIG.ACCESS_TOKEN_TTL }
  );
  
  // 标记会话为非活跃
  sessionData.isActive = false;
  await env.SESSIONS.put(
    `SESSION:${sessionId}`,
    JSON.stringify(sessionData),
    { expirationTtl: 60 }
  );
  
  // 删除活跃会话记录
  await env.SESSIONS.delete(`ACTIVE_SESSION:${sessionData.userId}`);
}
/**
 * 记录登录日志
 */
async function logLoginAttempt(env, request, success, userId = "admin", reason = "") {
  const ip = getClientIP(request);
  const userAgent = request.headers.get("user-agent") || "";
  const timestamp = Date.now();
  
  const log = {
    timestamp,
    userId,
    ip,
    userAgent,
    success,
    reason,
  };
  
  const key = `LOGIN_LOG:${timestamp}:${crypto.randomUUID()}`;
  await env.SESSIONS.put(key, JSON.stringify(log), {
    expirationTtl: 30 * 24 * 60 * 60, // 保留30天
  });
}

// =================================================================================
// Authentication Middleware
// =================================================================================

async function requireAuth(request, env) {
  const raw = request.headers.get("authorization");
  if (!raw || !raw.startsWith(AUTH_HEADER_PREFIX)) {
    return jsonResponse({ success: false, message: "请登录后再执行此操作。" }, 401);
  }
  const token = raw.slice(AUTH_HEADER_PREFIX.length).trim();
  if (!token) {
    return jsonResponse({ success: false, message: "请登录后再执行此操作。" }, 401);
  }
  const validation = await validateAccessToken(env, token);
  if (!validation.valid) {
    return jsonResponse({ success: false, message: validation.reason }, 401);
  }
  
  // 将会话信息附加到请求上下文
  request.session = validation.session;
}

// =================================================================================
// Data Management (KV)
// =================================================================================

const DATA_KEY = "data";

async function readFullData(env) {
  const raw = await env.SIMPAGE_DATA.get(DATA_KEY);
  if (!raw) {
    const defaultData = await createDefaultData();
    await writeFullData(env, defaultData);
    return defaultData;
  }
  const parsed = JSON.parse(raw);
  // Basic validation/normalization can be added here if needed
  return parsed;
}

async function writeFullData(env, fullData) {
  await env.SIMPAGE_DATA.put(DATA_KEY, JSON.stringify(fullData, null, 2));
}

async function incrementVisitorCountAndReadData(env) {
  const fullData = await readFullData(env);
  const sanitised = sanitiseData(fullData);

  const currentCount = fullData.stats?.visitorCount || 0;
  const nextVisitorCount = currentCount + 1;
  sanitised.visitorCount = nextVisitorCount;

  const updatedData = {
    ...fullData,
    stats: { ...fullData.stats, visitorCount: nextVisitorCount },
  };

  // Fire-and-forget the write operation
  // This makes the user-facing request faster as it doesn't wait for the KV write.
  const promise = writeFullData(env, updatedData);
  if (globalThis.ctx && typeof globalThis.ctx.waitUntil === "function") {
    globalThis.ctx.waitUntil(promise);
  }

  return sanitised;
}

// =================================================================================
// Data Normalization and Sanitization (Copied and adapted from server.js)
// =================================================================================

function sanitiseData(fullData) {
  const defaults = createDefaultSettings();
  const sourceSettings = fullData.settings || defaults;
  const weather = normaliseWeatherSettingsValue(sourceSettings.weather);

  // 🆕 处理透明度
  let glassOpacity = 40;
  if (typeof sourceSettings.glassOpacity === "number") {
    glassOpacity = Math.max(0, Math.min(100, Math.round(sourceSettings.glassOpacity)));
  }
  // 🆕 处理 useWallpaper
  let useWallpaper = true;
  if (typeof sourceSettings.useWallpaper === "boolean") {
    useWallpaper = sourceSettings.useWallpaper;
  }

  // 🆕 处理壁纸 URL
  let wallpaperUrl = "https://bing.img.run/uhd.php";
  if (typeof sourceSettings.wallpaperUrl === "string") {
    const trimmed = sourceSettings.wallpaperUrl.trim();
    if (trimmed) {
      wallpaperUrl = trimmed;
    }
  }
  // 🆕 计算运行天数
  const siteStartDate = fullData.stats?.siteStartDate || null;
  const runningDays = calculateRunningDays(siteStartDate);

  return {
    settings: {
      siteName: sourceSettings.siteName || defaults.siteName,
      siteLogo: sourceSettings.siteLogo || defaults.siteLogo,
      greeting: sourceSettings.greeting || defaults.greeting,
      footer: normaliseFooterValue(sourceSettings.footer),
      weather: { city: weather.city },
      glassOpacity, // 🆕 添加
      useWallpaper, // 🆕 添加
      wallpaperUrl, // 🆕 添加
    },
    apps: fullData.apps?.map((item) => ({ ...item })) || [],
    bookmarks: fullData.bookmarks?.map((item) => ({ ...item })) || [],
    visitorCount: fullData.stats?.visitorCount || DEFAULT_STATS.visitorCount,
    runningDays, // 🆕 添加
    siteStartDate, // 🆕 添加（用于后台编辑）
    config: {
      weather: {
        defaultCity: DEFAULT_WEATHER_CONFIG.city,
      },
    },
  };
}

function normaliseSettingsInput(input) {
  const siteName = typeof input?.siteName === "string" ? input.siteName.trim() : "";
  if (!siteName) throw new Error("网站名称不能为空。");

  // 🆕 处理透明度
  let glassOpacity = 40;
  if (typeof input?.glassOpacity === "number") {
    glassOpacity = Math.max(0, Math.min(100, Math.round(input.glassOpacity)));
  }
  // 🆕 处理 useWallpaper
  let useWallpaper = true;
  if (typeof input?.useWallpaper === "boolean") {
    useWallpaper = input.useWallpaper;
  }

  // 🆕 处理壁纸 URL
  let wallpaperUrl = "https://bing.img.run/uhd.php";
  if (typeof input?.wallpaperUrl === "string") {
    const trimmed = input.wallpaperUrl.trim();
    if (trimmed) {
      wallpaperUrl = trimmed;
    }
  }

  return {
    siteName,
    siteLogo: typeof input?.siteLogo === "string" ? input.siteLogo.trim() : "",
    greeting: typeof input?.greeting === "string" ? input.greeting.trim() : "",
    footer: normaliseFooterValue(input?.footer),
    weather: normaliseWeatherSettingsInput(input?.weather),
    glassOpacity, // 🆕 添加
    useWallpaper, // 🆕 添加
    wallpaperUrl, // 🆕 添加
  };
}

function normaliseCollection(value, { label, type }) {
  if (!Array.isArray(value)) throw new Error(`${label} 数据格式不正确，应为数组。`);
  const seen = new Set();
  return value.map((item) => {
    const normalised = normaliseItem(item, type);
    if (seen.has(normalised.id)) {
      normalised.id = crypto.randomUUID();
    }
    seen.add(normalised.id);
    return normalised;
  });
}

function normaliseItem(input, type) {
  if (!input || typeof input !== "object") throw new Error("数据项格式不正确。");
  const name = String(input.name || "").trim();
  const url = String(input.url || "").trim();
  if (!name) throw new Error("名称不能为空。");
  if (!url) throw new Error("链接不能为空。");

  const payload = {
    id: typeof input.id === "string" && input.id.trim() ? input.id.trim() : crypto.randomUUID(),
    name,
    url: ensureUrlProtocol(url),
    description: typeof input.description === "string" ? input.description.trim() : "",
    icon: typeof input.icon === "string" ? input.icon.trim() : "",
  };
  if (type === "bookmarks") {
    payload.category = typeof input.category === "string" ? input.category.trim() : "";
  }
  return payload;
}

function normaliseFooterValue(value) {
  if (typeof value !== "string") return "";
  const normalised = value.replace(/\r\n?/g, "\n");
  return normalised.trim() ? normalised : "";
}

function normaliseWeatherSettingsValue(input) {
  const fallback = createDefaultWeatherSettings();
  let value = { ...fallback };
  if (input && typeof input === "object") {
    if (typeof input.city === "string" && input.city.trim()) {
      value.city = input.city.trim().split(/\s+/).filter(Boolean);
    } else if (Array.isArray(input.city)) {
      value.city = input.city.map(c => String(c).trim()).filter(Boolean);
    }
  }
  if (!value.city || value.city.length === 0) {
    value.city = fallback.city;
  }
  return value;
}

function normaliseWeatherSettingsInput(rawWeather) {
    if (!rawWeather || typeof rawWeather !== "object") {
        return createDefaultWeatherSettings();
    }
    const citySource = rawWeather.city;
    let cities = [];
    if (typeof citySource === 'string') {
        cities = citySource.split(/\s+/).filter(Boolean);
    } else if (Array.isArray(citySource)) {
        cities = citySource.map(c => String(c).trim()).filter(Boolean);
    }

    if (cities.length === 0) {
        throw new Error("天气城市不能为空。");
    }
    return { city: cities };
}


function createDefaultSettings() {
  return {
    ...BASE_DEFAULT_SETTINGS,
    weather: createDefaultWeatherSettings(),
  };
}

function createDefaultWeatherSettings() {
  return { city: [DEFAULT_WEATHER_CONFIG.city] };
}

async function createDefaultData() {
  const admin = await createDefaultAdminCredentials();
  // Hardcode the full initial data to ensure KV is populated correctly on first run,
  // but dynamically generate the admin credentials.
  return {
    "settings": {
      "siteName": "SimPage",
      "siteLogo": "",
      "greeting": "",
      "footer": "欢迎来到我的主页",
      "glassOpacity": 40, // 🆕 添加
      "useWallpaper": true, // 🆕 添加
      "wallpaperUrl": "https://bing.img.run/uhd.php", // 🆕 添加
      "weather": {
        "city": ["北京", "青岛"]
      }
    },
    "apps": [
      { "id": "app-figma", "name": "Figma", "url": "https://www.figma.com/", "description": "协作式界面设计工具。", "icon": "🎨" },
      { "id": "app-notion", "name": "Notion", "url": "https://www.notion.so/", "description": "多合一的笔记与知识管理平台。", "icon": "🗂️" },
      { "id": "app-slack", "name": "Slack", "url": "https://slack.com/", "description": "团队即时沟通与协作中心。", "icon": "💬" },
      { "id": "app-github", "name": "GitHub", "url": "https://github.com/", "description": "代码托管与协作平台。", "icon": "🐙" },
      { "id": "app-canva", "name": "Canva", "url": "https://www.canva.com/", "description": "简单易用的在线设计工具。", "icon": "🖌️" }
    ],
    "bookmarks": [
      { "id": "bookmark-oschina", "name": "开源中国", "url": "https://www.oschina.net/", "description": "聚焦开源信息与技术社区。", "icon": "🌐", "category": "技术社区" },
      { "id": "bookmark-sspai", "name": "少数派", "url": "https://sspai.com/", "description": "关注效率工具与生活方式的媒体。", "icon": "📰", "category": "效率与生活" },
      { "id": "bookmark-zhihu", "name": "知乎", "url": "https://www.zhihu.com/", "description": "问答与知识分享社区。", "icon": "❓", "category": "知识学习" },
      { "id": "bookmark-jike", "name": "即刻", "url": "https://m.okjike.com/", "description": "兴趣社交与资讯聚合平台。", "icon": "📮", "category": "资讯聚合" },
      { "id": "bookmark-juejin", "name": "稀土掘金", "url": "https://juejin.cn/", "description": "开发者技术社区与优质内容。", "icon": "💡", "category": "技术社区" }
    ],
    "stats": {
      "visitorCount": 0,
      "siteStartDate": null // 🆕 添加
    },
    "admin": admin
  };
}

// =================================================================================
// Crypto Functions (Web Crypto API)
// =================================================================================

function generateToken() {
  return crypto.randomUUID();
}

function ensureUrlProtocol(url) {
  if (/^https?:\/\//i.test(url)) return url;
  return `https://${url}`;
}

async function hashPassword(password) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const saltHex = bufferToHex(salt);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    512 // 64 bytes
  );

  const hashHex = bufferToHex(new Uint8Array(derivedBits));
  return { passwordHash: hashHex, passwordSalt: saltHex };
}

async function verifyPassword(password, saltHex, expectedHashHex) {
  const salt = hexToBuffer(saltHex);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    512
  );

  const actualHashHex = bufferToHex(new Uint8Array(derivedBits));
  return timingSafeEqual(expectedHashHex, actualHashHex);
}

async function createDefaultAdminCredentials() {
  return await hashPassword(DEFAULT_ADMIN_PASSWORD);
}

// =================================================================================
// Weather API Fetcher
// =================================================================================

const WEATHER_API_TIMEOUT_MS = 5000;
const GEOLOCATION_MAX_RETRIES = 3;
const GEOLOCATION_RETRY_DELAY_BASE_MS = 300;

async function fetchAndCache(url, ctx) {
  const cache = caches.default;
  let response = await cache.match(url);

  if (!response) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WEATHER_API_TIMEOUT_MS);

    try {
      response = await fetch(url.toString(), {
        signal: controller.signal,
        headers: {
          "Accept": "application/json",
          "Accept-Encoding": "identity",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      });

      // Clone the response to be able to read the body for caching and for returning
      const cacheableResponse = response.clone();

      if (response.ok) {
        // If the request was successful, cache it for 15 minutes.
        const newHeaders = new Headers(cacheableResponse.headers);
        newHeaders.set("Cache-Control", "public, max-age=900");

        const cacheResponseForStorage = new Response(cacheableResponse.body, {
          status: cacheableResponse.status,
          statusText: cacheableResponse.statusText,
          headers: newHeaders,
        });
        ctx.waitUntil(cache.put(url, cacheResponseForStorage));
      } else {
        // If the request failed (e.g., 429 rate limit), cache the failure for a short period.
        // This acts as a circuit breaker to prevent hammering the API.
        const newHeaders = new Headers(cacheableResponse.headers);
        newHeaders.set("Cache-Control", "public, max-age=60"); // Cache failure for 60 seconds

        const failedResponseForStorage = new Response(cacheableResponse.body, {
          status: cacheableResponse.status,
          statusText: cacheableResponse.statusText,
          headers: newHeaders,
        });
        ctx.waitUntil(cache.put(url, failedResponseForStorage));
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (!response.ok) {
    throw createWeatherError(`API请求失败: ${response.status}`, response.status);
  }

  return response.json();
}

async function geocodeCity(cityName, env, ctx) {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", cityName);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "zh");
  url.searchParams.set("format", "json");

  let lastError = null;
  for (let attempt = 0; attempt < GEOLOCATION_MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        const delay = GEOLOCATION_RETRY_DELAY_BASE_MS * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const payload = await fetchAndCache(url, ctx);

      if (!payload?.results?.[0]) {
        throw createWeatherError(`未找到城市"${cityName}"的地理位置信息。`, 404);
      }
      const { latitude, longitude, name } = payload.results[0];
      if (typeof latitude !== "number" || typeof longitude !== "number") {
        throw createWeatherError("地理位置信息无效。");
      }
      return { latitude, longitude, name: name || cityName }; // Success
    } catch (error) {
      lastError = error;
      // Don't retry on client errors (e.g., 404 Not Found)
      if (error?.statusCode >= 400 && error.statusCode < 500) {
        throw error;
      }
      console.warn(
        `geocodeCity failed (attempt ${attempt + 1}/${GEOLOCATION_MAX_RETRIES}), retrying...`,
        error.message
      );
    }
  }

  // If the loop completes, all retries have failed.
  throw lastError || createWeatherError("地理编码服务获取失败，且所有重试均告失败。", 502);
}

async function fetchOpenMeteoWeather(cityName, env, ctx) {
  const location = await geocodeCity(cityName, env, ctx);
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
  url.searchParams.set("current_weather", "true");
  url.searchParams.set("timezone", "auto");

  const payload = await fetchAndCache(url, ctx);
  const current = payload?.current_weather;
  if (!current || typeof current !== "object") {
    throw createWeatherError("天气数据格式异常。");
  }

  return {
    text: getWeatherDescription(Number(current.weathercode)),
    temperature: Number(current.temperature),
    windspeed: Number(current.windspeed),
    weathercode: Number(current.weathercode),
    time: current.time || null,
  };
}

function createWeatherError(message, statusCode = 502) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getWeatherDescription(code) {
  const map = {
    0: "晴天", 1: "晴朗", 2: "多云", 3: "阴天", 45: "雾", 48: "冻雾",
    51: "小雨", 53: "中雨", 55: "大雨", 56: "小冻雨", 57: "冻雨",
    61: "小雨", 63: "中雨", 65: "大雨", 66: "小冻雨", 67: "冻雨",
    71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒", 80: "阵雨",
    81: "中阵雨", 82: "大阵雨", 85: "小阵雪", 86: "大阵雪", 95: "雷雨",
    96: "雷雨伴冰雹", 99: "雷雨伴大冰雹",
  };
  return map[code] || "未知";
}

// =================================================================================
// Utility Functions
// =================================================================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json;charset=UTF-8" },
  });
}

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes.buffer;
}

function timingSafeEqual(a, b) {
    if (a.length !== b.length) {
        return false;
    }
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}