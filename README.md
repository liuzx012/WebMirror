# WebMirror v1.0

Chrome DevTools Extension — 网站镜像工具。递归导航触发 JS 资源加载，全量捕获网络请求与网页源码，打包 ZIP 保留原始目录结构，支持离线重新托管。

## 为什么不用 wget？

wget 不执行 JavaScript。现代网站 60% 以上资源由 JS 动态加载（chunk、lazy image、XHR、WebSocket），wget 完全不可见。

| 能力 | wget | WebMirror |
|------|:---:|:---:|
| 静态 HTML | ✅ | ✅ |
| JS 动态资源 | ❌ | ✅ Network API |
| XHR/Fetch | ❌ | ✅ Network API |
| SPA 路由 | ❌ | ✅ 导航触发渲染 |
| 浏览器会话 | ❌ | ✅ 当前会话 |
| 递归子页面 | ✅ -m | ✅ BFS 导航 |
| 资源捕获率 | ~40% | **~95%** |

## 安装

1. Chrome → `chrome://extensions/` → 开发者模式
2. 加载已解压的扩展程序 → 选择 `WebMirror/` 目录
3. 打开目标网站 → F12 → 切换到 **WebMirror** 面板

## 使用

| 参数 | 默认 | 说明 |
|------|------|------|
| 爬取深度 | 2 | 0=仅当前页，N=递归子页面层数 |
| 页面等待 | 3s | 网络空闲检测基准（连续无新请求即捕获） |
| 仅同域 | ✅ | 爬虫仅跟踪同域名链接 |
| 美化文件 | ❌ | JSON/HTML/CSS 格式化输出 |
| 忽略空文件 | ✅ | 跳过内容为空的资源 |

**操作步骤：**

1. 设置参数 → 点击「开始爬取」
2. 爬虫自动导航子页面，网络空闲后捕获所有同域资源
3. 随时点击「停止」→ 已捕获资源自动打包，点击下载
4. 爬取完成 → 点击「下载ZIP包」保存

## 爬取流程

```
当前页面 URL
    ↓
导航到 URL → 等 JS 执行 → 网络空闲检测 → 三路捕获
    ├── Network API:  所有 HTTP 请求（含 XHR/Fetch）
    ├── inspectedWindow: 静态资源缓存
    └── outerHTML: JS 渲染后的完整 DOM
    ↓
同域过滤（跳过 CDN/统计/第三方）→ URL → 文件路径 → 去重
    ↓
提取同域链接（去 query string、去尾部斜杠）→ BFS 入队
    ↓
循环直到队列空 或 用户点停止
    ↓
ZIP 打包（deflate 压缩 + CRC32）→ 点击下载
```

## 爬取覆盖

| 分类 | 扩展名 | 方式 |
|------|--------|------|
| 页面 | html htm shtml xhtml php asp aspx jsp pl | 爬虫导航 |
| 数据 | json xml webmanifest sitemap rss atom xps | 爬虫导航 |
| 样式脚本 | css js map | 爬虫导航 |
| 文档 | pdf zip gz tar svg | 爬虫导航 |
| 图片 | png jpg jpeg bmp gif webp ico | Network API |
| 字体 | woff woff2 ttf otf eot | Network API |
| 音视频 | mp4 mp3 wav webm | Network API |

> 资源捕获**仅保留目标域名**的文件，CDN、统计脚本、第三方字体等自动跳过，减小 ZIP 体积。

## 目录结构

```
WebMirror/
├── manifest.json              # Chrome Extension MV3
├── background.js              # Service Worker
├── devtools.html              # DevTools 页面入口
├── devtools.js                # DevTools 面板创建
├── panel.html                 # 主面板 UI
├── panel.css                  # 面板样式（亮色主题）
├── panel.js                   # 主控制器（爬取编排 + ZIP 下载）
├── lib/
│   ├── crawler.js             # BFS 递归爬虫 + 链接提取 + 导航
│   ├── resource-capture.js    # Network + Static 双源捕获 + 网络空闲检测
│   ├── url-resolver.js        # URL → 本地文件路径转换
│   ├── zip-builder.js         # 浏览器端 ZIP（deflate 压缩 + CRC32）
│   └── utils.js               # MIME 映射、魔数检测、格式化工具
├── icons/
│   ├── icon16.png             # 16x16
│   ├── icon48.png             # 48x48
│   ├── icon128.png            # 128x128
│   └── icon512.png            # 512x512（源文件）
└── README.md
```

## ZIP 输出示例

```
example.com.zip
└── example.com/
    ├── index.html
    ├── about/index.html
    ├── css/style.css
    ├── js/main.js
    ├── js/chunk-abc123.js
    ├── images/logo.png
    ├── fonts/Inter.woff2
    ├── api/config.json
    ├── sitemap.xml
    ├── _DataURI/       ← 内联 data: URI 资源
    └── _Special/       ← webpack:// 等非标准协议资源
```

## 整合来源

| 项目 | 贡献 |
|------|------|
| ResourcesSaverExt | 双源捕获、URL→路径、魔数推断、面板架构 |
| ClonerWebSites | 递归爬取思路 |
| Website-downloader | wget 爬取思路 → 改为浏览器导航 |
| zaixianwget | URL 验证、路径安全检查 |
