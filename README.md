<p align="center">
  <img src="./public/simpage-logo.svg" alt="SimPage Logo" width="160" />
</p>

# SimPage · 现代化导航页

一个集成时间问候、天气信息、智能搜索，以及应用与书签快捷入口的现代化导航页。当前仓库已精简为 **Cloudflare Workers / Pages** 部署方案，不再包含本地 Node.js 服务端代码。

## 功能特性

- **时间与状态概览**：时间/日期/农历/周数/今日进度条，动态问候标签；滚动后出现浮动摘要卡片，并支持一键回到顶部。
- **天气展示**：Open-Meteo 免费 API，多城市轮播，失败自动重试并降级提示。
- **搜索体验**：网页搜索支持 Bing / Google / 百度切换；应用/书签支持本地即时搜索。
- **应用与书签分区**：卡片式网格布局，应用/书签标签切换，书签支持子分类提示。
- **主题与视觉**：明暗主题跟随系统并可手动覆盖；毛玻璃透明度可调；支持背景壁纸开关与自定义 URL。
- **后台管理**：`/login` 登录页、`/admin` 管理页；支持密码修改、数据保存、退出登录。
- **数据持久化**：业务数据写入 Cloudflare KV，静态资源由 Workers 站点资源托管。

## 运行架构

- `worker.js`：Cloudflare Worker 入口，负责 API、鉴权、静态资源分发。
- `public/`：站点静态资源目录，会通过 Wrangler 上传到 `__STATIC_CONTENT`。
- `SIMPAGE_DATA`：存储站点配置、应用、书签等业务数据。
- `SESSIONS`：存储后台登录会话。
- `VISITOR_COUNTER`：Durable Object，用于维护访问计数。

## 快速开始

### 1. 安装依赖

需要 Node.js 与 npm，仅用于运行 Wrangler CLI 和部署 Worker。

```bash
npm install
```

### 2. 登录 Cloudflare

```bash
npx wrangler login
```

### 3. 创建 KV 命名空间

```bash
npx wrangler kv:namespace create "SIMPAGE_DATA"
npx wrangler kv:namespace create "SESSIONS"
```

将生成的 `id` / `preview_id` 更新到 `wrangler.toml` 的 `kv_namespaces` 配置中。

### 4. 设置后台初始密码

```bash
npx wrangler secret put ADMIN_PASSWORD
```

### 5. 本地预览

```bash
npm run dev
```

- 前台导航页：`http://127.0.0.1:8787/`
- 登录页：`http://127.0.0.1:8787/login`
- 后台管理页：`http://127.0.0.1:8787/admin`

这里运行的是 `wrangler dev`，用于本地预览 Cloudflare Worker，不存在独立的 Node.js Web 服务入口。

### 6. 部署到 Cloudflare

```bash
npm run deploy
```

### 7. 更新部署

```bash
git pull
npm run deploy
```

## 运行时配置

- `ADMIN_PASSWORD`：后台初始密码，必须通过 `wrangler secret put` 配置。

## 数据管理

- `SIMPAGE_DATA`：站点设置、应用、书签等核心业务数据。
- `SESSIONS`：后台登录会话。
- `__STATIC_CONTENT`：Wrangler 自动上传的静态资源。
- `VISITOR_COUNTER`：访问量计数 Durable Object。

## 目录结构

```text
├── public/                  # 静态资源目录
│   ├── admin.html
│   ├── login.html
│   ├── index.html
│   ├── styles.css
│   ├── simpage-logo.svg
│   ├── data/
│   └── scripts/
├── worker.js                # Cloudflare Worker 入口
├── wrangler.toml            # Wrangler 配置
├── package.json
├── package-lock.json
└── README.md
```

## 说明

- 仓库已经移除本地 Node.js 服务端、Docker 部署和本地文件数据存储逻辑。
- 如果您之前使用过旧版本的本地文件存储，需要自行迁移数据到 Cloudflare KV。
