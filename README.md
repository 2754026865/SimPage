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

默认壁纸通过本站 `/api/wallpaper` 调用 `https://api.bimg.cc/today`，**无需 Key**。Worker 跟随该接口到 Bing 图片的 HTTPS 跳转，只允许 bimg/Bing 域名，限制跳转次数和图片大小。之前配置的 `UAPI_KEY` 已不再读取，可以从 Worker 的变量和机密中移除。

成功图片在边缘缓存中保留最多一天，30 分钟内直接复用；过期刷新失败时可以继续使用一天以内的成功图片，不使用 KV 存储壁纸。边缘缓存可能提前被驱逐，因此前台另外内置本地备用背景，默认请求失败最多重试一次。已有的自定义壁纸继续生效，旧默认地址 `https://bing.img.run/uhd.php` 会自动改走本站接口。

后台保存密码时会记录哈希算法；无算法标识的旧密码记录会兼容验证，在成功登录后自动迁移。无需重置已有密码或清空站点数据。

### Cloudflare 与资源加载

- CSP 仅放行 Cloudflare Analytics 所需的脚本与上报域。HTML 每次响应生成随机 nonce，供本站脚本及 Cloudflare JavaScript Detections 使用；没有开放脚本 `unsafe-inline`。带 nonce 的 HTML 不缓存，CSS、JS 和图片仍保留各自缓存策略。
- 如果 `/api/wallpaper` 返回 `403`、`Content-Type: text/html` 且 `cf-mitigated: challenge`，这是 Cloudflare 在 Worker 运行前返回了验证页。应在 Cloudflare 安全事件中定位触发规则，调整该规则对图片/API 路径的交互质询范围；代码无法替图片请求完成验证。只针对已确认的规则和路径调整，保留其他防护。
- 外部图标失败会显示名称首字，站点 favicon 失败会恢复本地图标。一言有 8 秒超时和 30 分钟会话缓存，失败保留当前问候。

### 验证代码

```bash
npm test
npm run test:worker
```

单元测试覆盖密码兼容及迁移、壁纸代理/缓存/重试、CSP、图标和一言降级。`test:worker` 先执行构建预检（不上传），再用本地 workerd 检查真实密码校验、HTML nonce 改写及 Cache API；上游请求为本地模拟，不读取线上 KV。真实 Cloudflare 安全规则及第三方服务可用性仍需部署后核查。

> 安全说明：`wrangler.toml` 中的 KV `id` 与 Durable Object 绑定信息**不是机密**，可以随仓库公开提交。真正的机密是你的 Cloudflare 账户 API Token / `ADMIN_PASSWORD`：前者请通过 CI 的 secrets 注入，后者通过 `wrangler secret put` 写入，**永远不要写入仓库**。

## 数据管理

- `SIMPAGE_DATA`：站点设置、应用、书签等核心业务数据。
- `SESSIONS`：后台登录会话。
- `__STATIC_CONTENT`：Wrangler 自动上传的静态资源。
- `VISITOR_COUNTER`：访问量计数 Durable Object。

## 目录结构

```text
├── public/                          # 静态资源目录（Wrangler 会整体上传到 __STATIC_CONTENT）
│   ├── index.html                   # 前台导航页
│   ├── admin.html                   # 后台管理页
│   ├── login.html                   # 登录页
│   ├── simpage-logo.svg             # 站点 Logo / favicon
│   ├── icons/
│   │   └── sprite.svg               # 集中式 SVG sprite（主题切换、搜索引擎图标）
│   ├── styles/
│   │   ├── main.css                 # 主样式（三个页面共用)
│   │   └── login.css                # 登录页专属样式
│   ├── scripts/
│   │   ├── pages/                   # 页面入口脚本（与 HTML 一一对应)
│   │   │   ├── home.js              # 前台导航页
│   │   │   ├── admin.js             # 后台管理页
│   │   │   └── login.js             # 登录页
│   │   ├── lib/                     # 纯工具库（无副作用，仅 export）
│   │   │   ├── api.js               # fetch / payload 解析
│   │   │   ├── data.js              # 应用、书签、天气数据规范化
│   │   │   ├── ui.js                # DOM / favicon / 滚动等通用 UI 工具
│   │   │   ├── lunar.js             # 农历计算
│   │   │   └── markdown.js          # 轻量 Markdown 渲染
│   │   └── features/                # 跨页面功能模块（自执行 / 有副作用）
│   │       ├── theme.js             # 明暗主题切换
│   │       └── font-loader.js       # 字体异步加载
│   └── data/
│       ├── china-cities.json        # 中国城市基础数据
│       └── weather-cities.json      # 天气可选城市数据
├── worker.js                        # Cloudflare Worker 入口
├── wrangler.toml                    # Wrangler 配置（含 KV / Durable Object 绑定）
├── package.json
├── package-lock.json
└── README.md
```

### 前端代码组织约定

- **`pages/`**：每个页面唯一的入口脚本，HTML 中通过 `<script type="module" src="/scripts/pages/xxx.js">` 引入。
- **`lib/`**：只 `export` 函数，不直接操作全局 DOM，可被任意页面/模块复用。
- **`features/`**：自执行的功能模块（如主题切换、字体加载），通过 `import "../features/xxx.js"` 在需要的页面里激活。
- **`styles/`**：所有 CSS 集中存放，按"主样式 + 页面专属样式"组织。

## 说明

- 仓库已经移除本地 Node.js 服务端、Docker 部署和本地文件数据存储逻辑。
- 如果您之前使用过旧版本的本地文件存储，需要自行迁移数据到 Cloudflare KV。
