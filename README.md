<MARKDOWN>
<p align="center">
  <img src="./public/simpage-logo.svg" alt="SimPage Logo" width="160" />
</p>

# SimPage · 现代化导航页

一个集成时间问候、天气信息、智能搜索，以及应用与书签快捷入口的现代化导航页示例。项目已适配 **Cloudflare Workers**，通过 KV 存储实现数据持久化，提供后台编辑页面，便于轻量快速地部署和管理。

## ✨ 功能特性

### 🎨 视觉与交互
- **亮暗主题切换**：支持手动切换或跟随系统主题自动切换
- **毛玻璃效果**：现代化的半透明毛玻璃视觉设计
- **可调节透明度**：后台可自定义容器透明度（0-100%），适配不同壁纸
- **自定义壁纸**：支持设置任意图片 URL 作为背景，默认使用 Bing 每日壁纸
- **响应式布局**：完美适配桌面端、平板和移动设备

### 📊 概览区域
- **实时时钟**：显示当前时间、日期和星期
- **智能问候语**：根据时间段自动切换问候语，支持自定义
- **一言集成**：自动获取一言（Hitokoto）诗词名句
- **实时天气**：使用 Open-Meteo 免费 API，支持多城市轮播显示
- **全局搜索**：支持网页搜索（Google/Bing/百度）和本地应用/书签搜索

### 🚀 应用与书签
- **自适应网格**：4-5 列响应式布局，自动适配屏幕尺寸
- **书签分类**：支持为书签设置分类，自动分组展示
- **图标支持**：支持 Emoji 或图片 URL 作为图标
- **自动获取图标**：后台编辑时可一键获取网站 Logo

### 🔧 后台管理
- **密码保护**：后台页面需密码登录（默认 `admin123`）
- **可视化编辑**：无需编辑代码，通过表单即可管理所有内容
- **站点配置**：自定义网站名称、Logo、问候语、页脚内容
- **天气配置**：支持多城市天气（空格分隔），自动轮播显示
- **透明度调节**：实时预览容器透明度效果
- **壁纸管理**：自定义背景图片 URL
- **Markdown 支持**：页脚内容支持 Markdown 语法
- **密码修改**：后台可修改登录密码

### 💾 数据存储
- **Cloudflare KV**：高性能、高可用的全球分布式存储
- **自动初始化**：首次部署自动创建默认数据
- **数据持久化**：所有配置和内容永久保存

## 🎯 快速开始

### Cloudflare Workers 部署（推荐）

#### 1. 环境准备

- 一个 [Cloudflare](https://www.cloudflare.com/) 账户
- 已安装 [Node.js](https://nodejs.org/) (v16+) 和 npm

#### 2. 安装依赖

```bash
npm install
```

#### 3. 配置 Wrangler

**登录 Wrangler**:
```bash
npx wrangler login
```
这将引导您在浏览器中登录 Cloudflare 账户并授权 Wrangler。

**创建 KV 命名空间**:
```bash
npx wrangler kv:namespace create "SIMPAGE_DATA"
npx wrangler kv:namespace create "SESSIONS"
```
执行上述命令后，Wrangler 会输出每个命名空间的 `id`。

**更新 `wrangler.toml`**:
将获取到的 `id` 填入 `wrangler.toml` 文件：

```toml
kv_namespaces = [
  { binding = "SIMPAGE_DATA", id = "your_simpage_data_id", preview_id = "your_simpage_data_id" },
  { binding = "SESSIONS", id = "your_sessions_id", preview_id = "your_sessions_id" }
]

[site]
bucket = "./public"
```

#### 4. 本地开发

```bash
npm run dev
```

- 前台导航页：[http://localhost:8787/](http://localhost:8787/)
- 后台编辑页：[http://localhost:8787/admin](http://localhost:8787/admin)

> 💡 后台首次登录请使用默认密码 `admin123`

#### 5. 部署到 Cloudflare

```bash
npm run deploy
```

部署成功后，Wrangler 会输出您的 Worker URL。

#### 6. 更新

```bash
git pull
npm run deploy
```

---

### 传统 Node.js 部署

如果您希望使用传统的 Node.js 服务器模式，可以使用 `server.js`。

#### 1. 安装依赖

```bash
npm install
```

#### 2. 启动服务

```bash
npm start
```

#### 3. 后台运行（推荐使用 PM2）

**全局安装 PM2**:
```bash
npm install pm2 -g
```

**使用 PM2 启动应用**:
```bash
pm2 start npm --name "SimPage" -- start
```

**常用 PM2 命令**:
```bash
pm2 list            # 查看所有正在运行的应用
pm2 logs SimPage    # 查看实时日志
pm2 stop SimPage    # 停止应用
pm2 restart SimPage # 重启应用
pm2 delete SimPage  # 删除应用
```

**设置开机自启**:
```bash
pm2 startup
# 复制并执行生成的命令
pm2 save
```

> ⚠️ 注意：`server.js` 和 Cloudflare Worker (`worker.js`) 使用不同的数据存储方式（文件 vs KV），数据不互通。

---

### Docker Compose 部署

项目附带精简的 Docker 部署方案，镜像基于 `node:20-alpine` 构建。

#### 1. 构建镜像

```bash
docker compose build
```

如需强制刷新依赖，可追加 `--no-cache`。

#### 2. 启动服务

```bash
docker compose up -d
```

#### 3. 查看日志

```bash
docker compose logs -f navigation
```

#### 4. 停止服务

```bash
docker compose down
```

#### 5. 更新

```bash
git pull
docker compose build
docker compose up -d
```

**配置说明**：
- 服务默认监听宿主机 `3000` 端口
- 命名卷 `navigation_data` 持久化 `/app/data` 下的数据
- 可通过 `DEFAULT_WEATHER_CITY` 环境变量自定义默认天气城市
- 预设资源限制：0.5 核 CPU、512MiB 内存上限、128MiB 内存预留

---

## 🎨 自定义配置

### 后台配置项

登录后台（`/admin`）可配置以下内容：

| 配置项 | 说明 | 示例 |
|--------|------|------|
| **网站名称** | 显示在页面标题和顶部 | SimPage |
| **网站 Logo** | 支持 Emoji 或图片 URL | 🚀 或 https://... |
| **自定义问候语** | 替代默认的时间问候语 | 祝你今天心情愉快！ |
| **天气城市** | 支持多城市，空格分隔 | 北京 上海 深圳 |
| **容器透明度** | 0-100%，建议 30-60% | 40 |
| **壁纸 URL** | 自定义背景图片 | https://picsum.photos/1920/1080 |
| **页脚内容** | 支持 Markdown 语法 | **SimPage** · 记录每一次启程 |

### 透明度推荐设置

| 壁纸类型 | 推荐透明度 | 效果 |
|---------|----------|------|
| 🌈 色彩丰富 | 30-40% | 更透明，壁纸更突出 |
| 🖼️ 简约纯色 | 40-50% | 平衡，既能看到壁纸又不影响阅读 |
| 📸 复杂图案 | 50-60% | 更不透明，确保内容清晰 |
| 🌃 暗色壁纸 | 35-45% | 暗色模式下的最佳范围 |

### 壁纸 URL 示例

```
# Bing 每日壁纸（默认）
https://bing.img.run/uhd.php

# Unsplash 随机图片
https://source.unsplash.com/random/1920x1080

# Picsum 随机图片
https://picsum.photos/1920/1080

# 自定义图片
https://your-domain.com/wallpaper.jpg
```

---

## 📁 目录结构

```
├── public/                  # 静态资源目录
│   ├── admin.html           # 后台编辑页面
│   ├── index.html           # 前台导航页面
│   ├── scripts/
│   │   ├── main.js          # 前台主逻辑
│   │   ├── admin.js         # 后台主逻辑
│   │   ├── theme-toggle.js  # 主题切换
│   │   └── markdown.js      # Markdown 渲染
│   ├── styles.css           # 全局样式
│   └── simpage-logo.svg     # Logo 图标
├── worker.js                # Cloudflare Worker 入口
├── server.js                # Node.js 服务器入口
├── wrangler.toml            # Wrangler 配置
├── docker-compose.yml       # Docker Compose 配置
├── Dockerfile               # Docker 镜像配置
├── package.json             # 项目依赖
└── README.md                # 项目文档
```

---

## 🔧 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `PORT` | 服务监听端口（Node.js/Docker） | 3000 |
| `DEFAULT_WEATHER_CITY` | 默认天气城市 | 北京 |

---

## 🌐 API 端点

### 前台 API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/data` | GET | 获取导航数据（应用、书签、设置） |
| `/api/weather` | GET | 获取天气信息 |

### 后台 API

| 端点 | 方法 | 说明 | 需要认证 |
|------|------|------|---------|
| `/api/login` | POST | 用户登录 | ❌ |
| `/api/admin/data` | GET | 获取完整数据 | ✅ |
| `/api/admin/data` | PUT | 更新数据 | ✅ |
| `/api/admin/password` | POST | 修改密码 | ✅ |
| `/api/fetch-logo` | GET | 获取网站 Logo | ✅ |

---

## 🎯 使用技巧

### 1. 快速添加应用

1. 进入后台 → 应用区域
2. 点击"+ 添加应用"
3. 填写名称和链接
4. 点击"自动获取"按钮获取网站 Logo
5. 保存

### 2. 书签分类管理

- 输入分类名称时，会自动提示已有分类
- 相同分类的书签会自动分组显示
- 留空分类会归入"未分类"

### 3. 自定义壁纸

**方法 1：使用在线图片**
```
https://source.unsplash.com/random/1920x1080
```

**方法 2：使用本地图片**
1. 将图片上传到图床（如 Imgur、SM.MS）
2. 复制图片 URL
3. 粘贴到"壁纸 URL"输入框

**方法 3：使用 Bing 每日壁纸**
```
https://bing.img.run/uhd.php
```

### 4. Markdown 页脚示例

```markdown
**SimPage** · 记录每一次启程

[GitHub](https://github.com) | [Twitter](https://twitter.com)

© 2024 SimPage. All rights reserved.
```

---

## 🐛 常见问题

### Q: 背景图片不显示？

**A:** 检查以下几点：
1. 打开浏览器控制台（F12）查看是否有错误
2. 确认壁纸 URL 可以正常访问
3. 尝试清除浏览器缓存（Ctrl + F5）
4. 检查图片 URL 是否支持跨域访问

### Q: 透明度调节不生效？

**A:** 
1. 确保已点击"保存修改"按钮
2. 刷新前台页面（Ctrl + F5）
3. 检查浏览器控制台是否有错误

### Q: 天气信息不显示？

**A:**
1. 确认城市名称拼写正确
2. 检查网络连接
3. Open-Meteo API 可能暂时不可用，稍后重试

### Q: 后台密码忘记了？

**A:**
- **Cloudflare Workers**: 删除 KV 中的数据，重新部署会恢复默认密码
- **Node.js/Docker**: 删除 `data/navigation.json` 文件，重启服务

### Q: 如何备份数据？

**A:**
- **Cloudflare Workers**: 在后台导出数据，或使用 Wrangler CLI 导出 KV
- **Node.js/Docker**: 备份 `data/navigation.json` 文件

---

## 🚀 性能优化

- ✅ 静态资源通过 Cloudflare CDN 全球加速
- ✅ KV 存储提供毫秒级读取速度
- ✅ 天气 API 请求带缓存，减少重复请求
- ✅ 图片懒加载，优化首屏加载速度
- ✅ CSS 和 JS 文件已压缩优化

---

## 📄 开源协议

本项目采用 [MIT License](LICENSE) 开源协议。

---

## 🙏 致谢

- [Open-Meteo](https://open-meteo.com/) - 免费天气 API
- [Hitokoto](https://hitokoto.cn/) - 一言 API
- [Cloudflare Workers](https://workers.cloudflare.com/) - 边缘计算平台
- [Bing Wallpaper](https://bing.img.run/) - 每日壁纸服务

---

## 📮 反馈与贡献

欢迎提交 Issue 和 Pull Request！

如果这个项目对你有帮助，请给个 ⭐️ Star 支持一下！

---

<p align="center">
  Made with ❤️ by SimPage Team
</p>
</MARKDOWN>