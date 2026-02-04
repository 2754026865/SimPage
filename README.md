<p align="center">
  <img src="./public/simpage-logo.svg" alt="SimPage Logo" width="160" />
</p>

# SimPage · 现代化导航页

一个集成时间问候、天气信息、智能搜索，以及应用与书签快捷入口的现代化导航页。项目支持 **Cloudflare Workers** 与传统 **Node.js** 部署，内置后台管理与数据持久化，适合快速搭建个人主页或团队导航。

## 功能特性

- **时间与状态概览**：时间/日期/农历/周数/今日进度条，动态问候标签；滚动后出现浮动摘要卡片，并支持一键回到顶部。
- **天气展示**：Open-Meteo 免费 API，多城市（空格分隔）轮播，默认 3 秒切换；失败自动重试并降级提示。
- **搜索体验**：网页搜索支持 Bing / Google / 百度切换；应用/书签支持本地即时搜索。
- **应用与书签分区**：卡片式网格布局，应用/书签标签切换，书签支持子分类提示。
- **主题与视觉**：明暗主题跟随系统并可手动覆盖；毛玻璃透明度可调；支持背景壁纸开关与自定义 URL（默认 Bing 每日壁纸）。
- **个性化配置**：站点名称、Logo（Emoji/图片 URL）、自定义问候语、页脚 Markdown 与实时预览。
- **一言问候**：未设置自定义问候语时，自动获取一言内容作为替代。
- **后台管理**：`/login` 登录页、`/admin` 管理页；支持密码修改、数据保存、退出登录。
- **运行天数统计**：可设置“网站开始日期”，前台页脚展示“已平稳运行 X 天”。
- **数据持久化**：Node 模式写入 `data/navigation.json`；Worker 模式写入 KV；两种存储互不共享。
- **图标自动获取**：后台编辑条目可根据链接自动抓取站点图标（icon.ooo）。

## 品牌视觉

- 仓库内提供 `public/simpage-logo.svg` 作为默认品牌 Logo，页面 favicon 也可由 Emoji / 图片 URL 自动生成。
- 部署时可直接复用该 Logo，或在此基础上调整配色与排版以匹配自有品牌。

## 传统 Node.js 部署

如果您希望使用传统 Node.js 服务模式，可直接运行 `server.js`。

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量（首次启动必须）

- `ADMIN_PASSWORD`：后台初始密码（必填，首次生成管理员信息用）。
- `PORT`：服务端口（默认 3000）。
- `DEFAULT_WEATHER_CITY` / `DEFAULT_WEATHER_LABEL`：默认天气城市（可选）。

示例：

```bash
# macOS / Linux
ADMIN_PASSWORD=your_password npm start
```

```powershell
# Windows PowerShell
$env:ADMIN_PASSWORD = "your_password"
npm start
```

### 3. 启动服务

```bash
npm start
```

访问地址：

- 前台导航页：`http://localhost:3000/`
- 登录页：`http://localhost:3000/login`
- 后台管理页：`http://localhost:3000/admin`

> 请注意，Node.js 版本的数据存储为 `data/navigation.json`，首次启动会自动生成。

## Cloudflare Workers 部署

推荐使用 Cloudflare Workers 部署，结合 KV 提供高可用、免维护的数据存储。

### 1. 环境准备

- 一个 Cloudflare 账户
- 已安装 Node.js 与 npm

### 2. 安装依赖

```bash
npm install
```

### 3. 配置 Wrangler

1. **登录 Wrangler**
   ```bash
   npx wrangler login
   ```

2. **创建 KV 命名空间**
   ```bash
   npx wrangler kv:namespace create "SIMPAGE_DATA"
   npx wrangler kv:namespace create "SESSIONS"
   ```

3. **更新 `wrangler.toml`**
   将上述命名空间 `id` 写入 `wrangler.toml` 的 `kv_namespaces`。静态资源会通过 `[site]` 自动上传到 `__STATIC_CONTENT`，无需手动创建。

4. **设置后台初始密码**
   ```bash
   npx wrangler secret put ADMIN_PASSWORD
   ```

### 4. 本地开发

```bash
npm run dev
```

- 前台导航页：`http://localhost:8787/`
- 登录页：`http://localhost:8787/login`
- 后台管理页：`http://localhost:8787/admin`

### 5. 部署到 Cloudflare

```bash
npm run deploy
```

### 6. 更新

```bash
git pull
npm run deploy
```

## Docker Compose 部署

项目附带精简的 Docker 部署方案（`node:20-alpine`），仅安装生产依赖并启用健康检查。

1. 手动构建镜像
   ```bash
   docker compose build
   ```
   如需强制刷新依赖，可追加 `--no-cache`。

2. 后台启动服务
   ```bash
   docker compose up -d
   ```
   若仍使用旧版 `docker-compose`，可替换为 `docker-compose up -d`。

3. 查看运行日志
   ```bash
   docker compose logs -f navigation
   ```

4. 停止容器（保留数据）
   ```bash
   docker compose down
   ```

5. 更新
   ```bash
git pull
# 重新构建镜像并启动
docker compose build
docker compose up -d
   ```

部署配置要点：

- 默认监听宿主机 `3000` 端口，可在 `docker-compose.yml` 中调整映射或 `PORT` 环境变量。
- 建议在 `docker-compose.yml` 中添加 `ADMIN_PASSWORD` 以初始化后台登录。
- 命名卷 `navigation_data` 会持久化 `/app/data` 下的导航配置与后台密码哈希，镜像重建时数据不会丢失。
- 可通过 `DEFAULT_WEATHER_CITY` 环境变量自定义默认天气城市。

## 运行时配置

- `ADMIN_PASSWORD`：后台初始密码（必填，仅首次生成管理员信息时使用）。
- `PORT`：Node.js 服务端口（默认 3000）。
- `DEFAULT_WEATHER_CITY` / `DEFAULT_WEATHER_LABEL`：默认天气城市（可选，仅 Node.js 模式使用）。

## 数据管理

- **Node.js 模式**：数据写入 `data/navigation.json`，包含站点设置、应用、书签与管理员信息。
- **Workers 模式**：`SIMPAGE_DATA` 存储业务数据，`SESSIONS` 存储登录会话，静态资源由 `__STATIC_CONTENT` 托管。
- Node 与 Workers 的数据存储方式不同，数据互不通用。

## 目录结构

```
├── public/                  # 静态资源目录
│   ├── admin.html           # 后台管理页面
│   ├── login.html           # 登录页面
│   ├── index.html           # 前台导航页面
│   ├── styles.css
│   ├── simpage-logo.svg
│   ├── data/                # 静态数据
│   │   ├── china-cities.json
│   │   └── weather-cities.json
│   └── scripts/
│       ├── admin.js
│       ├── main.js
│       ├── lunar.js
│       ├── markdown.js
│       └── theme-toggle.js
├── data/                    # Node 本地数据目录（运行后生成 navigation.json）
├── server.js                # Node.js 服务入口
├── worker.js                # Cloudflare Worker 入口
├── wrangler.toml            # Wrangler 配置
├── Dockerfile
├── docker-compose.yml
├── package.json
└── README.md
```

祝使用愉快！
