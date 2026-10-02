# WebMirror v7.0

Chrome DevTools Extension — 网站镜像工具。递归导航触发 JS 资源加载，全量捕获网络请求与网页源码，内置 HaE 敏感信息扫描 + 智能错误页检测与跳过，打包 ZIP 保留原始目录结构，支持离线重新托管。

大站点自动分卷下载，避免内存溢出；监听黑名单自动规避 `delete`/`logout` 等危险接口，只读镜像不触发业务副作用。

集成六大智能模块：
- **FindSomething 被动监听** — 实时抓取请求响应体中的路径/URL/IP
- **VueCrack 自动 Vue 路由分析** — 打开网页自动提取 Vue Router 内存路由表（含隐藏路由）
- **HaE 敏感信息扫描** — 19 条规则检测密钥/令牌/内网信息
- **智能错误页检测** — HTTP 状态码 + URL 偏移 + DOM 骨架指纹 + 自动聚类，自动跳过 404/403/500/拦截页
- **分卷下载** — 按页数自动切卷打包下载，大站点不爆内存
- **监听黑名单** — 命中 `delete`/`logout` 等关键字的接口只展示不爬取，避免触发删除/注销

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
| 敏感信息扫描 | ❌ | ✅ HaE 规则引擎 |
| 被动路径监听 | ❌ | ✅ FindSomething 引擎 |
| Vue 路由提取 | ❌ | ✅ VueCrack 引擎 |
| 智能错误页跳过 | ❌ | ✅ 5 信号 + 骨架指纹 |
| 资源捕获率 | ~40% | **~95%** |

## 使用流程

### 第一步：被动监听（可选）

点「监听」按钮，手动浏览网站功能点（点击菜单、翻页、搜索等），所有请求的路径/URL/Vue 路由被实时抓取并去重缓存。

- 「监听路径」Tab 实时查看
- 支持按类型筛选：Path / IncompletePath / Vue / POST / Url / Domain / IP / IP:Port
- POST 条目显示 body 预览，自动扫描 body 中的敏感信息
- **黑名单**：命中关键字的接口仍会显示在监听路径中（便于查看），但爬取时直接跳过不请求
- 点「停止监听」后缓存保留

### 第二步：开始爬取

点「开始爬取」→ 爬虫按以下阶段自动执行：

```
Phase 0:   下载 Webpack Chunk（勾选「提取映射」时执行）
Phase 0.5: 注入监听缓存路径到队列头部（优先爬取功能点）
Phase 1:   BFS 递归爬取
  ├─ 导航 → 等待 JS 执行 → 网络空闲检测
  ├─ 错误页检测（5 信号判定，秒级跳过）
  ├─ 自动滚动触发懒加载
  ├─ 三路捕获（Network API + 静态资源 + outerHTML）
  ├─ HaE 实时敏感扫描
  └─ DOM 提链 + 正则兜底 → 新 URL 入队
```

爬取完成后自动打包 ZIP，底部出现下载按钮。开启分卷时，每爬满设定页数会自动下载一卷并清空内存，然后继续爬取。

### 参数详解

| 参数 | 默认 | 说明 |
|------|------|------|
| 爬取深度 | 5 | 0=仅当前页，N=递归子页面层数 |
| 页面等待 | 0.3s | 网络空闲检测基准 |
| 分卷大小 | 1000页 | 达到页数自动打包下载并清空内存，0=不分卷；可选 500~5000 页 |
| 仅同域 | ✅ | 爬虫仅跟踪同域名链接 |
| 子域同主域 | ❌ | 默认关闭；开启后 `*.example.com` 视为同域（按 eTLD 判断） |
| 保留query | ✅ | 保留 URL 参数，按参数名签名去重 |
| 美化文件 | ✅ | JSON/HTML 格式化输出 |
| 自动滚动 | ✅ | 导航后渐进滚动触发懒加载 |
| 离线重写 | ✅ | HTML/CSS 链接改写为相对路径 |
| 提取映射 | ✅ | 下载 Webpack Chunk + 解析 sourcemap 源文件 |
| 忽略空文件 | ✅ | 跳过内容为空的资源 |
| 敏感扫描 | ✅ | 对捕获资源执行 HaE 规则扫描 |

另有一项文本框参数：

| 参数 | 默认 | 说明 |
|------|------|------|
| URL附加参数 | 空 | 对每个请求附加 query（如 `refresh=uuid`），部分网站需特定参数才能访问，直接请求会跳转首页 |

> 已移除「最大页数」限制。爬虫会爬完所有发现的 URL，仅受 500MB 总大小上限约束；未开启分卷时爬到 2000 页会提示内存风险。

## 分卷下载

大站点全量镜像时内存会持续增长，开启分卷后每爬满 N 页（默认 1000）自动构建当前卷 ZIP、触发下载并清空已捕获资源，爬虫无中断继续下一卷。统计栏页面数显示 `[本卷页数/累计页数]`。

- 分卷文件命名：`example.com_part1_2026-10-02.zip`、`example.com_part2_2026-10-02.zip`
- 不分卷时命名：`example.com_2026-10-02.zip`
- 不开启分卷爬到 2000 页时会提示内存风险，建议大站点开启

## 监听黑名单

被动监听与爬取阶段的风险控制：命中黑名单关键字的接口（仅匹配 path+query，大小写不敏感、词边界匹配防误杀 `deleteFile` 这类正常路径）仍会显示在「监听路径」中，但**不会进入爬虫队列**，避免递归爬取误触发删除/注销等破坏性操作。

默认关键字：`delete` `logout` `loginout` `signout` `sign-out` `sign_out` `deactivate` `remove` `drop` `truncate` `purge` `destroy`

「监听路径」Tab → 「黑名单」按钮可展开编辑（每行一个关键字），支持保存 / 恢复默认，配置持久化到浏览器存储。

## 错误页检测与跳过

WebMirror 内置五层信号检测机制，自动识别并跳过错误页面，避免浪费时间爬取 404/403/500/拦截页。

### 五信号判定

| 信号 | 检测方式 | 触发条件 |
|------|---------|---------|
| Signal 1 | HAR 查 HTTP 状态码 | 状态码 ≥ 400 |
| Signal 2 | URL 偏移检测 | 请求 URL vs 落地 URL 不同（非 http→https 协议升级） |
| Signal 3 | DOM 骨架指纹命中 | 页面骨架与已知错误模板匹配 |
| Signal 4 | title 关键词匹配 | title 含 404/403/500/不存在/错误/拦截等关键词 |
| Signal 5 | 空壳页面检测 | 页面可见文字 < 50 字符且 DOM 节点 < 15 |

> 非 HTML 页面（`.js` 后缀）不执行 Signal 3-5，仅用 Signal 1-2 判定，避免 Chrome 纯文本包装器误判。

### DOM 骨架指纹（自动学习）

```
Signal 1/2 命中 → 提取 DOM 骨架 → 直接录入指纹库 ✅
Signal 4/5 命中 → 仅入候选池 🔶（需 Phase 3 聚类确认）
手动标记      → 提取 DOM 骨架 → 直接录入指纹库 ✅

Phase 3 聚类: 每 15 页自动执行
  同一骨架出现 ≥10 次 且 ≥3 次携带错误信号 → 自动晋升为指纹
```

骨架指纹只对 HTML 页面生效。`.js` 等静态资源不参与指纹检测，避免误判。

### 手动控制

- **手动跳过按钮**：爬取中在统计栏显示「跳过」按钮（下方小字「卡住点击」），点击后立即中断当前页处理，跳转到下一个 URL
- **页级超时**：单页处理超过 60s 自动跳过
- **错误指纹 Tab**：可查看/删除已学习的错误页指纹，也可手动标记当前页为错误页

## 各 Tab 用途

| Tab | 用途 |
|-----|------|
| 日志 | 实时操作日志，保留最近 5000 条，不自动滚动 |
| 监听路径 | 被动监听 + Vue 路由汇总，支持类型筛选/复制/清空/黑名单编辑 |
| 资源列表 | 已捕获的文件资源，敏感文件标 `⚠N` 徽章 |
| 扫描结果 | HaE 敏感信息命中，按级别过滤，支持规则导入/导出 |
| 错误指纹 | 已确认的 DOM 骨架指纹，可手动标记/删除 |
| 正则匹配 | 文件后缀白名单管理，勾选的后缀才会被捕获 |

## 安装

1. Chrome → `chrome://extensions/`
2. 右上角打开「开发者模式」
3. 点击「加载已解压的扩展程序」→ 选择本 `WebMirror/` 目录
4. 打开目标网站 → F12 → 切换到 **WebMirror** 面板

> 修改源码后，点 WebMirror 卡片的「刷新」按钮重新加载。

## 常见问题

**Q：爬取卡住了？**
A：点「跳过」按钮（统计栏「已跳过」旁边），会立即中断当前页跳到下一个 URL。爬取中每页有 60s 超时保护。

**Q：正常页面被跳过了？**
A：切到「错误指纹」Tab 查看已学习的指纹，找到误匹配的删除即可。正常 HTML 页面不会被误判（需 ≥10 次出现才自动晋升）。

**Q：爬下来的 ZIP 里有哪些文件？**
A：`url.txt` 列出所有成功爬取的 URL，`0AHaE触发.txt` 是敏感信息扫描报告，其余为网站资源镜像。

**Q：日志不滚动了？**
A：设计如此。关闭自动滚动方便查看跳过的 URL，手动拖动滚动条即可。

**Q：爬大站点浏览器卡死/崩溃？**
A：开启「分卷大小」（如 1000 页/卷）。每卷自动下载并释放内存，爬取全程内存占用保持稳定。

**Q：为什么有些接口没有被爬取？**
A：可能命中了监听黑名单（如包含 `delete`/`logout` 的接口）。这是保护机制，避免误触发破坏性操作。可在「监听路径」Tab →「黑名单」中查看和调整。

## ZIP 输出

```
example.com_2026-10-02.zip          # 分卷时为 example.com_part1_2026-10-02.zip
└── example.com/
    ├── url.txt              ← 成功爬取的所有 URL 列表（跳过的不会出现）
    ├── 0AHaE触发.txt        ← 敏感信息扫描报告
    ├── index.html
    ├── css/style.css
    ├── js/main.js
    └── ...
```

## 敏感扫描规则

| 级别 | 规则 | 检测内容 |
|------|------|----------|
| 🔴 Critical | Aliyun AK, JDBC, Auth Basic/Bearer, Generic Secret | 云密钥、数据库连接串、认证令牌 |
| 🟠 High | Password Field, JWT, Chinese ID, Config Secret | 密码赋值、JWT令牌、身份证号 |
| 🟡 Medium | Internal IP, Email, Windows Path, Mobile, MAC | 内网IP、邮箱、路径、手机号 |
| 🔵 Low | Source Map, Swagger, Druid, Vite Dev, All URL | SourceMap引用、API文档、监控面板 |

> 规则可自定义：扫描结果 Tab → 导出/导入/重置。

## 目录结构

```
WebMirror/
├── manifest.json
├── background.js
├── devtools.html / devtools.js
├── panel.html / panel.css / panel.js
├── lib/
│   ├── crawler.js              # BFS 爬虫 + 链接提取 + 导航
│   ├── resource-capture.js     # Network + Static 双源捕获
│   ├── sensitive-scanner.js    # HaE 敏感信息扫描引擎
│   ├── passive-monitor.js      # FindSomething 被动监听引擎
│   ├── vue-analyzer.js         # VueCrack Vue 路由自动分析
│   ├── webpack-extractor.js    # Webpack chunk 穷举 + sourcemap
│   ├── error-detector.js       # 错误页检测 + DOM 骨架指纹 + 聚类
│   ├── url-resolver.js         # URL → 本地文件路径转换
│   ├── zip-builder.js          # 浏览器端 ZIP
│   └── utils.js                # MIME 映射、工具函数
├── icons/
├── LICENSE
└── README.md
```

## 整合来源

| 项目 | 贡献 |
|------|------|
| ResourcesSaverExt | 双源捕获、URL→路径、魔数推断、面板架构 |
| ClonerWebSites | 递归爬取思路 |
| Webpack_extract | HaE 敏感信息扫描规则 |
| FindSomething 2.1.12 | 被动监听引擎（Wi 正则字典、Cs 静态拆分） |
| VueCrack | Vue Router 自动路由分析（仅保留只读分析） |

## 免责声明

本工具仅用于**授权的安全测试与安全研究**。使用者应确保对目标站点拥有合法测试授权，并自行承担因使用本工具产生的一切法律责任。请勿用于未经授权的数据抓取或任何违法用途。

## License

[MIT](LICENSE)
