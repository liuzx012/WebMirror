(function () {
'use strict';
// panel.js — WebMirror 主控制器
// 编排递归爬取 → 资源捕获 → 去重合并 → ZIP打包下载

// ========== 全局状态 ==========
const state = {
  tabId: null,
  startUrl: '',
  domain: '',
  isCrawling: false,
  crawlDepth: 5,
  crawlDelay: 300,
  sameDomainOnly: true,
  subdomainOnly: false,         // 子域同主域（默认关闭，仅精确同域）
  beautify: true,
  ignoreEmpty: true,
  keepQuery: true,              // 保留 query（按参数名签名去重）
  autoScroll: true,             // 自动滚动触发懒加载
  rewriteOffline: true,         // 离线 URL 重写（HTML 属性 + CSS）
  extraQuery: '',               // 自定义附加 URL 参数（如 refresh=uuid，部分网站验证用）
  volumeSize: 0,                // 分卷大小（页数），0=不分卷
  volumeIndex: 0,               // 当前分卷编号（从1开始）
  totalPagesCrawled: 0,        // 累计爬取页数（跨分卷）
  _keepAlivePort: null,        // SW 保活长连接端口
  maxTotalSize: 500 * 1024 * 1024, // 最大体积上限 500MB
  pagesCrawled: 0,
  totalResources: 0,
  totalSize: 0,
  htmlPages: 0,
  scanEnabled: true,
  extractMap: true,         // 提取映射（Webpack chunk / sourcemap 提取）
  scanResults: [],          // 扫描命中结果
  scanHitPaths: new Map(),  // filePath → hitCount 快速查找

  // 待下载ZIP
  _pendingZip: null,
  _pendingZipName: '',

  // 收集所有页面的完整捕获数据
  capturedPages: new Map(),    // urlPath -> { pageInfo, html, resources }
  allResources: new Map(),    // filePath -> { url, path, content, mimeType, size, type }
  htmlSources: new Map(),     // urlPath -> html content
  staticResourcePaths: new Set(), // 已捕获的静态资源URL集合
  pageOrder: [],              // 爬取顺序（后台记录，前端不展示）

  // 正则匹配：文件后缀过滤
  allowedExtensions: null,    // Set=仅允许这些后缀, null=未初始化
  extensionCounts: new Map(), // ext -> count 统计
  extFilterInited: false,    // 是否已初始化UI

  // FindSomething 被动监听
  monitorListening: false,           // 是否正在监听
  monitorCounts: { path: 0, incomplete_path: 0, url: 0, ip: 0, ip_port: 0, domain: 0, static: 0, vue: 0, total: 0 },
  _monitorLogThrottle: null,         // 监听日志节流定时器

  // 手动跳过
  _skipCurrentPage: false,

  // 暂停/恢复（停止按钮变身暂停：点击停止=暂停，再次点击开始爬取=恢复）
  isPaused: false,           // 是否处于暂停状态
  _resumeResolve: null,      // 暂停恢复 Promise 的 resolve 回调
  _bfsActive: false,         // BFS 循环是否运行中（用于禁止在非爬取阶段暂停）

  // 成功爬取的 URL 列表（用于生成 url.txt）
  successfulUrls: [],

  // VueCrack 自动 Vue 路由分析
  vueAnalyzing: false,               // 是否正在执行 Vue 分析（防并发重入）
  _vueNavListener: null,             // webNavigation 监听器引用（便于注销）
  _vueFirstLogDone: false,           // 是否已打过首次 Vue 日志（避免非Vue站点重复探测日志）
};

// ========== DOM 引用 ==========
const $ = (sel) => document.querySelector(sel);
const dom = {
  currentUrl: $('#current-url'),
  depthSelect: $('#depth-select'),
  delaySelect: $('#delay-select'),
  sameDomainCheck: $('#same-domain-check'),
  subdomainCheck: $('#subdomain-check'),
  beautifyCheck: $('#beautify-check'),
  ignoreEmptyCheck: $('#ignore-empty-check'),
  btnStart: $('#btn-start'),
  btnStop: $('#btn-stop'),
  btnReset: $('#btn-reset'),
  btnMonitor: $('#btn-monitor'),
  statPages: $('#stat-pages'),
  statQueue: $('#stat-queue'),
  statResources: $('#stat-resources'),
  statSize: $('#stat-size'),
  statHtml: $('#stat-html'),
  statWpack: $('#stat-wpack'),
  progressBar: $('#progress-bar'),
  statusText: $('#status-text'),
  logContainer: $('#log-container'),
  resourcesList: $('#resources-list'),
  downloadSection: $('#download-section'),
  resourceFilter: $('#resource-filter'),
  typeFilter: $('#type-filter'),
  tabs: document.querySelectorAll('.tab'),
  tabContents: document.querySelectorAll('.tab-content'),
  scanCheck: $('#scan-check'),
  keepQueryCheck: $('#keep-query-check'),
  autoScrollCheck: $('#auto-scroll-check'),
  rewriteCheck: $('#rewrite-check'),
  extractMapCheck: $('#extract-map-check'),
  extraQueryInput: $('#extra-query-input'),
  volumeSelect: $('#volume-select'),
  scanList: $('#scan-list'),
  scanFilter: $('#scan-filter'),
  scanSeverityFilter: $('#scan-severity-filter'),
  scanSummaryBar: $('#scan-summary-bar'),
  btnExportRules: $('#btn-export-rules'),
  btnImportRules: $('#btn-import-rules'),
  btnResetRules: $('#btn-reset-rules'),
  rulesFileInput: $('#rules-file-input'),
  extFilterContainer: $('#ext-filter-container'),
  extSelectAll: $('#ext-select-all'),
  btnExtPreset: $('#btn-ext-preset'),
  extApplyHint: $('#ext-apply-hint'),
  monitorList: $('#monitor-list'),
  monitorFilter: $('#monitor-filter'),
  monitorTypeFilter: $('#monitor-type-filter'),
  monitorStatsBar: $('#monitor-stats-bar'),
  btnMonitorClear: $('#btn-monitor-clear'),
  btnMonitorCopy: $('#btn-monitor-copy'),
  btnMonitorDelete: $('#btn-monitor-delete'),
  btnBlacklistToggle: $('#btn-monitor-blacklist-toggle'),
  blacklistSection: $('#monitor-blacklist-section'),
  blacklistTextarea: $('#monitor-blacklist-textarea'),
  btnBlacklistSave: $('#btn-blacklist-save'),
  btnBlacklistReset: $('#btn-blacklist-reset'),
  blacklistStatus: $('#blacklist-status'),
  statSkipped: $('#stat-skipped'),
  fingerprintList: $('#fingerprint-list'),
  btnMarkErrpage: $('#btn-mark-errpage'),
  btnClearFingerprints: $('#btn-clear-fingerprints'),
  errpageInfo: $('#errpage-info'),
  btnSkipPage: $('#btn-skip-page'),
};

// ========== 日志系统 ==========
function log(msg, type = 'info') {
  const entry = document.createElement('div');
  entry.className = 'log-entry ' + type;
  const time = new Date().toLocaleTimeString();
  entry.textContent = `[${time}] ${msg}`;
  dom.logContainer.appendChild(entry);

  // 保留最近5000条
  while (dom.logContainer.children.length > 5000) {
    dom.logContainer.firstChild.remove();
  }
}

// ========== UI 更新 ==========
function updateStats() {
  // 分卷模式下显示 [当前卷/累计] 格式
  if (state.volumeSize > 0 && state.totalPagesCrawled > 0) {
    dom.statPages.textContent = state.pagesCrawled + '/' + state.totalPagesCrawled;
  } else {
    dom.statPages.textContent = state.pagesCrawled;
  }
  dom.statQueue.textContent = Crawler.queueSize();
  dom.statResources.textContent = state.allResources.size;
  dom.statSize.textContent = Utils.formatBytes(state.totalSize);
  dom.statHtml.textContent = state.htmlSources.size;
  dom.statWpack.textContent = WebpackExtractor.getChunkManifest().length;
}

function setProgress(percent) {
  dom.progressBar.style.width = Math.min(100, Math.max(0, percent)) + '%';
}

function setStatus(msg) {
  dom.statusText.textContent = msg;
}

function setButtons(crawling) {
  dom.btnStart.disabled = crawling;
  dom.btnStart.textContent = '开始爬取';
  dom.btnStop.disabled = !crawling;
  dom.btnStop.textContent = '停止';
  dom.btnStop.classList.add('btn-danger');
  dom.btnStop.classList.remove('btn-warning');
  dom.depthSelect.disabled = crawling;
  dom.delaySelect.disabled = crawling;
  dom.sameDomainCheck.disabled = crawling;
  // 爬取中禁用监听按钮（避免与爬虫的 clearNetworkEntries 冲突）
  dom.btnMonitor.disabled = crawling;
  // 跳过按钮仅在爬取中显示
  dom.btnSkipPage.style.display = crawling ? '' : 'none';
}

// ========== Tab 切换 ==========
dom.tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    dom.tabs.forEach(t => t.classList.remove('active'));
    dom.tabContents.forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    const targetId = 'tab-' + tab.dataset.tab;
    const target = document.getElementById(targetId);
    if (target) target.classList.add('active');
  });
});

// ========== 页面/资源列表更新 ==========
function updateResourcesList(filterText, filterType) {
  dom.resourcesList.innerHTML = '';
  let entries = [...state.allResources.entries()];

  if (filterText) {
    const lower = filterText.toLowerCase();
    entries = entries.filter(([path]) => path.toLowerCase().includes(lower));
  }
  if (filterType && filterType !== 'all') {
    entries = entries.filter(([, r]) => r.type === filterType);
  }

  if (entries.length === 0) {
    dom.resourcesList.innerHTML = '<div class="empty-hint">无匹配资源</div>';
    return;
  }

  // 一次构建严重级别索引，避免每个资源都遍历全部扫描结果
  const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
  const highestSeverityByPath = new Map();
  for (const hit of state.scanResults) {
    const current = highestSeverityByPath.get(hit.filePath) || '';
    if ((severityOrder[hit.severity] || 0) > (severityOrder[current] || 0)) {
      highestSeverityByPath.set(hit.filePath, hit.severity);
    }
  }

  const fragment = document.createDocumentFragment();
  for (const [path, res] of entries) {
    const item = document.createElement('div');
    item.className = 'resource-item';
    // 扫描标记
    const hitCount = state.scanHitPaths.get(path) || 0;
    const sev = highestSeverityByPath.get(path) || '';
    const marker = hitCount > 0 ? `<span class="scan-marker ${sev}" title="${hitCount}处匹配">⚠${hitCount}</span>` : '';
    item.innerHTML = `
      <span class="type-badge ${res.type}">${res.type}</span>
      ${marker}
      <span class="res-path" title="${escapeHtml(path)}">${escapeHtml(path)}</span>
      <span class="res-size">${Utils.formatBytes(res.size)}</span>
    `;
    fragment.appendChild(item);
  }
  dom.resourcesList.appendChild(fragment);
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function truncateUrl(url, maxLen = 60) {
  if (url.length <= maxLen) return url;
  return url.substring(0, maxLen - 3) + '...';
}

// ========== 资源类型分类 ==========
function classifyResource(mimeType, url) {
  const mime = (mimeType || '').toLowerCase();
  const path = url.toLowerCase();

  if (mime.startsWith('text/html') || path.includes('.html') || path.includes('.htm')) return 'html';
  if (mime.startsWith('text/css') || path.includes('.css')) return 'css';
  if (mime.includes('javascript') || path.includes('.js')) return 'js';
  if (mime.startsWith('image/') || /\.(png|jpg|jpeg|gif|svg|webp|ico)$/i.test(path)) return 'img';
  if (mime.startsWith('font/') || mime.includes('font-') || /\.(woff2?|ttf|otf|eot)$/i.test(path)) return 'font';
  return 'other';
}

// ========== 正则匹配：文件后缀过滤 ==========

// 预设默认勾选后缀（按渗透信息收集价值排序）
const PRESET_CHECKED = new Set([
  // Tier 1: JS 与 Source Map — 信息收集之王（API端点/密钥/隐藏路径/源码还原）
  '.js', '.mjs', '.map', '.ts', '.tsx', '.jsx', '.vue',
  // Tier 2: 配置文件 — 裸奔的数据库密码/内网IP/云凭证
  '.env', '.json', '.yaml', '.yml', '.xml', '.ini', '.conf', '.config', '.cnf',
  '.htaccess', '.htpasswd', '.aws', '.s3cfg', '.rdp', '.reg',
  // Tier 3: 服务端源码 — 逻辑漏洞/硬编码/SQL注入点
  '.php', '.py', '.java', '.go', '.rb', '.asp', '.aspx',
  '.jsp', '.jspx', '.jsw', '.jsv', '.jspf', '.pl', '.pm', '.cgi',
  '.inc', '.sql', '.class',
  // Tier 4: 备份与临时文件 — 整站源码打包/编辑器交换文件
  '.bak', '.backup', '.bkp', '.old', '.swp', '.swo', '.tmp',
  // Tier 5: 日志与文档 — 路径泄露/报错信息/内部笔记
  '.log', '.txt', '.md',
  // Tier 6: 办公文档 — 修订记录藏密码/内部拓扑
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.csv', '.rtf',
  // Tier 7: 压缩包 — 整站备份/数据库dump
  '.zip', '.rar', '.7z', '.tar', '.gz',
  // Tier 8: 二进制/编译文件 — strings 提取硬编码密钥
  '.exe', '.dll', '.so', '.wasm', '.bin', '.dat',
]);

// 预设默认不勾选后缀（媒体/字体/样式 — 非核心资产，排在后面）
const PRESET_UNCHECKED = new Set([
  '.avi', '.bmp', '.css', '.eot', '.gif', '.htm', '.html', '.ico',
  '.jpeg', '.jpg', '.mov', '.mp3', '.mp4', '.ogg', '.otf',
  '.png', '.svg', '.ttf', '.wav', '.webm', '.webp', '.woff', '.woff2',
]);

function getExtension(filePath) {
  const name = (filePath || '').split('/').pop().split('?')[0].split('#')[0];
  if (!name.includes('.')) return '(无后缀)';
  return '.' + name.split('.').pop().toLowerCase();
}

function isExtensionAllowed(filePath) {
  if (!state.allowedExtensions) return true;
  const ext = getExtension(filePath);
  return state.allowedExtensions.has(ext);
}

// 给 URL 附加自定义 query 参数（用于需要验证参数的网站）
function appendExtraQuery(url, extraQuery) {
  if (!extraQuery) return url;
  const q = extraQuery.startsWith('?') ? extraQuery.slice(1) : extraQuery;
  if (!q) return url;
  try {
    const u = new URL(url);
    // 解析 extraQuery 中的参数，逐个 set（覆盖已有同名参数）
    const params = new URLSearchParams(q);
    for (const [k, v] of params) {
      u.searchParams.set(k, v);
    }
    return u.href;
  } catch (e) {
    // URL 解析失败，手动拼接
    const sep = url.includes('?') ? '&' : '?';
    return url + sep + q;
  }
}

// 收集已发现资源的所有后缀
function collectDiscoveredExtensions() {
  state.extensionCounts.clear();
  for (const [path] of state.allResources) {
    const ext = getExtension(path);
    state.extensionCounts.set(ext, (state.extensionCounts.get(ext) || 0) + 1);
  }
}

// 获取所有已知后缀（按预设顺序排列：已勾选 → 未勾选 → 新发现）
function getAllKnownExtensions() {
  const seen = new Set();
  const result = [];
  // 1. 先排 PRESET_CHECKED（保持代码中的顺序）
  for (const ext of PRESET_CHECKED) {
    seen.add(ext);
    result.push(ext);
  }
  // 2. 再排 PRESET_UNCHECKED（保持代码中的顺序）
  for (const ext of PRESET_UNCHECKED) {
    if (!seen.has(ext)) {
      seen.add(ext);
      result.push(ext);
    }
  }
  // 3. 新发现的后缀排在最后，按字母排序
  const newExts = [...state.extensionCounts.keys()]
    .filter(ext => !seen.has(ext))
    .sort((a, b) => a.localeCompare(b));
  result.push(...newExts);
  return result;
}

// 初始化 / 更新后缀过滤 UI
async function updateExtensionFilter() {
  const container = dom.extFilterContainer;
  if (!container) return;
  container.innerHTML = '';

  // 首次初始化：从 storage 加载持久化配置，否则用预设
  if (!state.allowedExtensions) {
    try {
      const stored = await chrome.storage.local.get('extFilterConfig');
      if (stored && stored.extFilterConfig && Array.isArray(stored.extFilterConfig)) {
        state.allowedExtensions = new Set(stored.extFilterConfig);
      }
    } catch(e) {}
    if (!state.allowedExtensions) {
      state.allowedExtensions = new Set(PRESET_CHECKED);
    }
  }

  // 合并已发现的后缀
  collectDiscoveredExtensions();

  const allExts = getAllKnownExtensions();

  if (allExts.length === 0) {
    container.innerHTML = '<span class="ext-hint">暂无后缀信息</span>';
    return;
  }

  for (const ext of allExts) {
    const count = state.extensionCounts.get(ext) || 0;
    const checked = state.allowedExtensions.has(ext) ? 'checked' : '';
    const discovered = count > 0 ? ' ext-discovered' : '';

    const label = document.createElement('label');
    label.className = 'ext-checkbox-label' + discovered;
    label.innerHTML = `
      <input type="checkbox" class="ext-checkbox" value="${ext}" ${checked}>
      <span class="ext-name">${ext}</span>
      ${count > 0 ? `<span class="ext-count">${count}</span>` : '<span class="ext-count ext-missing">0</span>'}
    `;
    const cb = label.querySelector('input');
    cb.addEventListener('change', () => {
      applyExtensionFilter();
    });
    container.appendChild(label);
  }

  updateExtensionSelectAllState();
  state.extFilterInited = true;
}

// 读取 UI 中所有勾选的后缀，写入 allowedExtensions 并持久化
function applyExtensionFilter() {
  const checkboxes = dom.extFilterContainer.querySelectorAll('.ext-checkbox');
  const selected = new Set();
  checkboxes.forEach(cb => {
    if (cb.checked) selected.add(cb.value);
  });
  state.allowedExtensions = selected;
  // 持久化到 storage，下次启动自动生效
  chrome.storage.local.set({ extFilterConfig: [...selected] }).catch(() => {});
  updateExtensionSelectAllState();
  updateResourcesList(dom.resourceFilter.value, dom.typeFilter.value === 'all' ? null : dom.typeFilter.value);
  if (dom.extApplyHint) {
    dom.extApplyHint.textContent = '已保存 (' + selected.size + ' 个后缀)';
    dom.extApplyHint.style.color = '#4caf50';
    setTimeout(() => {
      if (dom.extApplyHint) {
        dom.extApplyHint.textContent = '勾选即生效，配置已持久化';
        dom.extApplyHint.style.color = 'var(--text-secondary)';
      }
    }, 2000);
  }
}

function updateExtensionSelectAllState() {
  if (!dom.extSelectAll) return;
  const checkboxes = dom.extFilterContainer.querySelectorAll('.ext-checkbox');
  const total = checkboxes.length;
  let selected = 0;
  checkboxes.forEach(cb => { if (cb.checked) selected++; });
  dom.extSelectAll.checked = (selected === total);
  dom.extSelectAll.indeterminate = (selected > 0 && selected < total);
  dom.extSelectAll.nextElementSibling.textContent =
    '全选 (' + selected + '/' + total + ')';
}

// 全选/取消全选（即时生效并持久化）
function toggleSelectAllExtensions() {
  if (!dom.extSelectAll) return;
  const checkboxes = dom.extFilterContainer.querySelectorAll('.ext-checkbox');
  const allChecked = [...checkboxes].every(cb => cb.checked);

  checkboxes.forEach(cb => {
    cb.checked = !allChecked;
  });

  applyExtensionFilter();
}

// 恢复预设勾选（即时生效并持久化）
function resetExtensionPreset() {
  const checkboxes = dom.extFilterContainer.querySelectorAll('.ext-checkbox');
  checkboxes.forEach(cb => {
    cb.checked = PRESET_CHECKED.has(cb.value);
  });
  applyExtensionFilter();
}

// ========== 处理捕获的资源 ==========
// 取主域（eTLD+1）。IP 直接返回；多段 TLD（com.cn/co.uk 等）取倒数三段
const SECOND_LEVEL_TLD = new Set([
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.hk', 'net.hk', 'org.hk', 'gov.hk', 'edu.hk',
  'com.tw', 'net.tw', 'org.tw', 'gov.tw',
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk',
  'co.jp', 'or.jp', 'ne.jp', 'go.jp', 'ac.jp',
  'com.au', 'net.au', 'org.au', 'gov.au', 'edu.au',
  'co.nz', 'net.nz', 'org.nz',
  'co.kr', 'or.kr', 'go.kr',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'co.in', 'net.in', 'org.in', 'gen.in',
  'com.sg', 'net.sg', 'org.sg', 'gov.sg',
  'com.my', 'net.my', 'org.my',
  'com.tr', 'net.tr', 'org.tr', 'gov.tr',
  'com.ru', 'net.ru', 'org.ru',
  'com.mx', 'net.mx', 'org.mx',
  'co.za', 'net.za', 'org.za', 'web.za',
]);
function getBaseDomain(host) {
  if (!host) return '';
  host = String(host).toLowerCase();
  // eTLD 比较不应受端口影响；IPv6 保留完整字面量
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end >= 0) return host.slice(0, end + 1);
  } else if (host.includes(':')) {
    host = host.split(':')[0];
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host; // IPv4
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  // 检查最后两段是否为已知二级 TLD（如 com.cn），是则取倒数三段
  const lastTwo = parts.slice(-2).join('.');
  if (parts.length >= 3 && SECOND_LEVEL_TLD.has(lastTwo)) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}
// 检查URL是否属于目标域名
function isSameDomain(url) {
  try {
    const urlHost = new URL(url).host;
    // 子域同主域：按 eTLD 最后两段比较
    if (state.subdomainOnly) {
      return getBaseDomain(urlHost) === getBaseDomain(state.domain);
    }
    // 严格同 host
    return urlHost === state.domain;
  } catch (e) { return false; }
}

function processResources(captured, pageUrl, pageDepth) {
  const addedPaths = [];
  const pagePath = UrlResolver.resolve(pageUrl, 'text/html', null).path;
  let filteredCount = 0;
  let passedCount = 0;

  // 处理HTML源码（后缀过滤）
  if (captured.html) {
    const htmlPath = pagePath;
    if (isExtensionAllowed(htmlPath)) {
      state.htmlSources.set(htmlPath, captured.html);
      state.htmlPages++;
      addedPaths.push({ path: htmlPath, html: captured.html });
      addToAllResources(htmlPath, captured.html, 'text/html', pageUrl);
      passedCount++;
    } else {
      filteredCount++;
    }
    // 注意：即使HTML源码因后缀过滤被跳过，Crawler.processCapturedPage()
    // 仍会使用原始captured.html提取链接，所以爬虫不受影响
  }

  // 处理网络资源
  for (const res of (captured.networkResources || [])) {
    if (!res.url || !res.content) continue;
    if (state.ignoreEmpty && (!res.content || res.content.length === 0)) continue;

    const resolved = UrlResolver.resolve(res.url, res.mimeType, res.content);
    const filePath = resolved.path;

    // 后缀过滤：未勾选的后缀直接跳过（但仍从中提取链接路径供爬虫使用）
    if (!isExtensionAllowed(filePath)) {
      extractLinksFromSkippedResource(res, pageDepth);
      filteredCount++;
      continue;
    }

    // 去重：同一文件路径只保留一次
    if (state.staticResourcePaths.has(res.url)) continue;
    state.staticResourcePaths.add(res.url);

    // 仅同域过滤：跳过CDN/统计/第三方域名资源
    if (state.sameDomainOnly && !isSameDomain(res.url)) continue;

    addToAllResources(filePath, res.content, res.mimeType, res.url);
    passedCount++;
  }

  // 处理静态资源
  for (const res of (captured.staticResources || [])) {
    if (!res.url || !res.content) continue;
    if (state.ignoreEmpty && (!res.content || res.content.length === 0)) continue;

    const resolved = UrlResolver.resolve(res.url, res.mimeType, res.content);
    const filePath = resolved.path;

    // 后缀过滤：未勾选的后缀直接跳过（但仍从中提取链接路径供爬虫使用）
    if (!isExtensionAllowed(filePath)) {
      extractLinksFromSkippedResource(res, pageDepth);
      filteredCount++;
      continue;
    }

    if (state.staticResourcePaths.has(res.url)) continue;
    state.staticResourcePaths.add(res.url);

    if (state.sameDomainOnly && !isSameDomain(res.url)) continue;

    addToAllResources(filePath, res.content, res.mimeType, res.url);
    passedCount++;
  }

  // 后台记录页面数据（前端不展示，供扩展使用）
  state.capturedPages.set(pageUrl, {
    depth: pageDepth,
    pageInfo: captured.pageInfo,
    html: captured.html,
    resourceCount: (captured.networkResources?.length || 0) + (captured.staticResources?.length || 0)
  });
  if (!state.pageOrder.includes(pageUrl)) {
    state.pageOrder.push(pageUrl);
  }

  return { addedPaths, filteredCount, passedCount };
}

// 从被后缀过滤跳过的资源中提取链接路径，供爬虫继续探索
function extractLinksFromSkippedResource(res, pageDepth) {
  if (!res || !res.url || !res.content) return;
  const mime = (res.mimeType || '').toLowerCase();
  let text = null;

  // 仅处理文本类资源（HTML/JS/CSS），二进制资源无法提取链接
  if (mime.includes('html') || mime.includes('javascript') || mime.includes('css') ||
      mime.includes('json') || mime.includes('xml') || mime.includes('text/')) {
    try {
      text = typeof res.content === 'string' ? res.content : new TextDecoder().decode(res.content);
    } catch (e) { return; }
  } else {
    return;
  }

  if (!text) return;

  // 从JS/CSS/JSON中提取URL模式（引号包裹的http/https路径）
  const urlPattern = /["'`](https?:\/\/[^"'`\s<>]+)["'`]/gi;
  let match;
  while ((match = urlPattern.exec(text)) !== null) {
    try {
      const found = new URL(match[1]);
      // 同域过滤（走 isSameDomain，含 eTLD 子域逻辑）
      if (!state.sameDomainOnly || isSameDomain(found.href)) {
        found.hash = '';
        const fullUrl = found.href;
        // 用 Crawler 的签名机制去重（与主流程一致）
        const sig = Crawler._normalizeUrl(fullUrl);
        if (!Crawler._visited.has(sig)) {
          Crawler._visited.add(sig);
          Crawler._queue.push({ url: fullUrl, depth: pageDepth + 1 });
        }
      }
    } catch (e) {}
  }
}

function addToAllResources(filePath, content, mimeType, originalUrl) {
  // 后缀过滤：不勾选的后缀直接跳过
  if (!isExtensionAllowed(filePath)) return;

  const raw = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
  const size = raw.length;
  const type = classifyResource(mimeType, filePath);

  // 同路径去重，保留较大的
  if (state.allResources.has(filePath)) {
    const existing = state.allResources.get(filePath);
    if (size <= existing.size) return;
    state.totalSize -= existing.size;
  }

  state.allResources.set(filePath, {
    path: filePath,
    content: content,
    mimeType: mimeType,
    size: size,
    type: type,
    originalUrl: originalUrl || ''  // 修复3: 供离线 URL 重写映射查询
  });
  state.totalSize += size;
  state.totalResources = state.allResources.size;
}

// ========== 文件美化（安全版：不破坏 JS/CSS 语法）==========
function beautifyContent(content, mimeType) {
  if (!content) return content;
  const mime = (mimeType || '').toLowerCase();

  // JSON：安全美化（JSON.parse + stringify，失败则原样）
  try {
    if (mime.includes('json') || (typeof content === 'string' &&
        (content.trim().startsWith('{') || content.trim().startsWith('[')))) {
      return JSON.stringify(JSON.parse(content), null, 2);
    }
  } catch (e) {
    // JSON美化失败，返回原文
  }

  // HTML：保守美化（标签间加换行，保护 <script>/<style> 内部内容不被破坏）
  try {
    if (mime.includes('html')) {
      // 先把 <script>...</script> 和 <style>...</style> 内容暂存为占位符，
      // 避免内联 JS/CSS 里的 >< 被误插入换行
      const placeholders = [];
      const protect = (m, open, inner, close) => {
        const ph = '\u0000PROTECT' + placeholders.length + '\u0000';
        placeholders.push(open + inner + close);
        return ph;
      };
      let protected_ = content
        .replace(/(<script[^>]*>)([\s\S]*?)<\/script>/gi, protect)
        .replace(/(<style[^>]*>)([\s\S]*?)<\/style>/gi, protect);
      // 对剩余部分（不含内联代码）做标签间换行
      protected_ = protected_.replace(/></g, '>\n<');
      // 还原占位符
      return protected_.replace(/\u0000PROTECT(\d+)\u0000/g, (m, idx) => placeholders[parseInt(idx, 10)]);
    }
  } catch (e) {}

  // CSS/JS：原样返回（避免正则替换破坏字符串字面量和语法）
  return content;
}

// ========== 离线 URL 重写（修复3）==========
// 把 HTML/CSS 中指向「已捕获资源」的绝对/相对 URL 改成离线可访问的相对路径
// 仅重写 HTML 属性（href/src/action）+ CSS url()/@import，不触碰 JS 内容
// 安全策略：只重写指向已捕获资源的 URL，未捕获的保持原样

// 构建 originalUrl → localPath 映射（含多种归一化形式）
function buildOfflineUrlMap() {
  const map = new Map();
  for (const [, res] of state.allResources) {
    if (!res.originalUrl) continue;
    // 存原始 URL 及去 hash 版本
    let u;
    try { u = new URL(res.originalUrl); } catch (e) { continue; }
    u.hash = '';
    map.set(u.href, res.path);
    // 也存 origin+pathname（去 query，匹配 href 里只写 path 的情况）
    const noQuery = u.origin + u.pathname;
    if (noQuery !== u.href) map.set(noQuery, res.path);
  }
  return map;
}

// 计算从 fromPath 到 toPath 的相对路径（如 ./about/index.html）
function relativePath(fromPath, toPath) {
  // fromPath/toPath 格式: host/dir1/dir2/file.html
  const fromDir = fromPath.includes('/') ? fromPath.substring(0, fromPath.lastIndexOf('/')) : '';
  const fromSegs = fromDir ? fromDir.split('/') : [];
  const toSegs = toPath.split('/');
  // 找公共前缀
  let common = 0;
  while (common < fromSegs.length && common < toSegs.length - 1 && fromSegs[common] === toSegs[common]) {
    common++;
  }
  const upCount = fromSegs.length - common;
  const parts = [];
  for (let i = 0; i < upCount; i++) parts.push('..');
  for (let i = common; i < toSegs.length; i++) parts.push(toSegs[i]);
  const rel = parts.join('/') || toPath;
  return rel.startsWith('.') ? rel : './' + rel;
}

// 对单个资源内容做离线 URL 重写
function rewriteOfflineUrls(content, mimeType, pageUrl, pagePath, urlMap) {
  if (typeof content !== 'string' || !content) return content;
  if (!urlMap || urlMap.size === 0) return content;
  const mime = (mimeType || '').toLowerCase();

  // 把原始 URL 转成可查询的形式（去 hash）
  const normalizeLookup = (rawUrl, baseUrl) => {
    try {
      const abs = new URL(rawUrl, baseUrl);
      abs.hash = '';
      return abs.href;
    } catch (e) { return null; }
  };

  if (mime.includes('html')) {
    // 重写 HTML 属性：href / src / action（带引号包裹的值）
    // 用回调式 replace，对每个匹配到的 URL 查映射
    const rewriteAttr = (attrMatch, quote, rawUrl) => {
      const lookup = normalizeLookup(rawUrl, pageUrl);
      if (lookup && urlMap.has(lookup)) {
        const localPath = urlMap.get(lookup);
        const rel = relativePath(pagePath, localPath);
        return attrMatch.replace(rawUrl, rel);
      }
      return attrMatch;
    };
    // 匹配 href="..." src="..." action="..." （单双引号）
    content = content.replace(/((?:href|src|action)\s*=\s*)(["'])([^"']+)\2/gi, (m, pre, q, url) => rewriteAttr(m, q, url));
    return content;
  }

  if (mime.includes('css')) {
    // 重写 CSS url(...) 和 @import "..."
    const cssBaseUrl = pageUrl; // CSS 资源的 originalUrl 作为 base
    const rewriteCssUrl = (rawUrl) => {
      const clean = rawUrl.replace(/^["']|["']$/g, '').trim();
      const lookup = normalizeLookup(clean, cssBaseUrl);
      if (lookup && urlMap.has(lookup)) {
        return rawUrl.replace(clean, relativePath(pagePath, urlMap.get(lookup)));
      }
      return rawUrl;
    };
    // url(...)
    content = content.replace(/url\(([^)]+)\)/gi, (m, inner) => 'url(' + rewriteCssUrl(inner.trim()) + ')');
    // @import "..." / @import url(...)
    content = content.replace(/@import\s+(["'])([^"']+)\1/gi, (m, q, url) => '@import ' + q + rewriteCssUrl(url) + q);
    return content;
  }

  return content;
}

// ========== 主爬取流程 ==========
async function startCrawling() {
  log('收到开始爬取指令...', 'info');

  // 暂停恢复：处于暂停状态时，点击"开始爬取"=恢复爬取
  // 不重置任何状态，仅唤醒等待中的 BFS 循环
  if (state.isPaused) {
    log('恢复爬取...', 'success');
    setStatus('恢复爬取...');
    state.isPaused = false;
    // UI 回到爬取中状态
    dom.btnStart.disabled = true;
    dom.btnStart.textContent = '开始爬取';
    dom.btnStop.disabled = false;
    dom.btnStop.classList.add('btn-danger');
    dom.btnStop.classList.remove('btn-warning');
    dom.btnStop.textContent = '停止';
    dom.btnSkipPage.style.display = '';
    // 唤醒等待中的 BFS 循环（resumeResolve 由 pause gate 设置）
    if (state._resumeResolve) {
      const resolve = state._resumeResolve;
      state._resumeResolve = null;
      resolve();
    }
    return;
  }

  if (state.isCrawling) {
    log('爬取已在运行中，忽略重复点击', 'warning');
    return;
  }

  // 重置停止标志，确保新爬取不被上次停止信号拦截
  Crawler._stopped = false;

  // 监听中自动停止监听，避免与爬虫的 clearNetworkEntries 冲突
  if (state.monitorListening) {
    log('自动停止被动监听，开始爬取...', 'info');
    stopMonitor();
  }

  // 立即标记运行中并启用停止按钮，确保任何阶段都能点停止
  state.isCrawling = true;
  setButtons(true);

  // SW 保活：打开长连接端口，防止 Chrome 空闲 30s 后杀掉 Service Worker
  try {
    if (state._keepAlivePort) state._keepAlivePort.disconnect();
    state._keepAlivePort = chrome.runtime.connect({ name: 'keepalive' });
    state._keepAlivePort.onDisconnect.addListener(() => {
      // SW 意外断开时尝试重连
      if (state.isCrawling) {
        try {
          chrome.runtime.sendMessage({ action: 'ping' }, () => {});
          state._keepAlivePort = chrome.runtime.connect({ name: 'keepalive' });
        } catch (e) {}
      }
    });
  } catch (e) { /* 非致命 */ }

  // 获取参数
    state.crawlDepth = parseInt(dom.depthSelect.value);
    state.crawlDelay = parseFloat(dom.delaySelect.value) * 1000;
    state.sameDomainOnly = dom.sameDomainCheck.checked;
    state.subdomainOnly = dom.subdomainCheck.checked;
    state.beautify = dom.beautifyCheck.checked;
    state.ignoreEmpty = dom.ignoreEmptyCheck.checked;
    state.keepQuery = dom.keepQueryCheck.checked;
    state.autoScroll = dom.autoScrollCheck.checked;
    state.rewriteOffline = dom.rewriteCheck.checked;
    state.extractMap = dom.extractMapCheck.checked;
    state.extraQuery = (dom.extraQueryInput.value || '').trim();
    state.volumeSize = parseInt(dom.volumeSelect.value) || 0;
    state.volumeIndex = 1;
    state.totalPagesCrawled = 0;

    // 直接从 DevTools API 获取当前检查页的 tabId
    const tabId = getDevToolsTabId();
    log('DevTools tabId: ' + tabId, 'info');
    if (!tabId) {
      log('无法获取当前标签页ID，请确认 DevTools 已连接到目标页面', 'error');
      finishCrawl();
      return;
    }
    state.tabId = tabId;

    // 获取当前页面URL（带超时保护，期间可点停止）
    log('正在获取当前页面URL...', 'info');
    const currentUrl = await getCurrentPageUrl();
    if (Crawler._stopped) { log('用户停止', 'warning'); finishCrawl(); return; }
    if (!currentUrl) {
      log('无法获取当前页面URL，请确认页面已完成加载', 'error');
      finishCrawl();
      return;
    }
    state.startUrl = currentUrl;
    state.domain = Utils.getHost(currentUrl);

    if (!state.startUrl.startsWith('http')) {
      log('当前页面不支持爬取 (非HTTP协议): ' + state.startUrl, 'error');
      finishCrawl();
      return;
    }

  log('========================================', 'info');
  log('开始爬取: ' + state.startUrl, 'info');
  log('目标域名: ' + state.domain, 'info');
  log('爬取深度: ' + state.crawlDepth + ', 等待时间: ' + (state.crawlDelay / 1000) + 's' +
    (state.volumeSize > 0 ? ', 分卷: ' + state.volumeSize + '页/卷' : ', 不分卷'), 'info');
  if (state.extraQuery) {
    log('附加URL参数: ' + state.extraQuery, 'info');
  }
  log('========================================', 'info');

  // 重置状态
  state.isCrawling = true;
  state.pagesCrawled = 0;
  state.totalResources = 0;
  state.totalSize = 0;
  state.htmlPages = 0;
  state.capturedPages.clear();
  state.allResources.clear();
  state.htmlSources.clear();
  state.staticResourcePaths.clear();
  state.pageOrder = [];
  state.scanResults = [];
  state.scanHitPaths.clear();
  state.extensionCounts.clear();
  WebpackExtractor.reset();
  ErrorDetector.softReset();
  dom.statSkipped.textContent = '0';
  state.successfulUrls = [];
  state._pendingZip = null;
  state._pendingZipName = '';
  ZipBuilder.init();

  setButtons(true);
  setProgress(0);
  updateStats();
  dom.downloadSection.style.display = 'none';

  // 初始化资源捕获的network监听
  ResourceCapture.initNetworkCapture();

  // 初始化爬虫
  Crawler.init(state.startUrl, {
    maxDepth: state.crawlDepth,
    tabId: state.tabId,
    sameDomainOnly: state.sameDomainOnly,
    keepQuery: state.keepQuery,
    // 注入 eTLD 同域判断函数（修复4：子域同主域）
    isSameDomainFn: (host) => {
      if (state.subdomainOnly) {
        return getBaseDomain(host) === getBaseDomain(state.domain);
      }
      return host === state.domain;
    },
    // 注入黑名单判断：爬虫提链时命中 delete/logout 等危险接口直接跳过不爬取
    blacklistCheckFn: (url) => PassiveMonitor._isBlacklisted(url)
  });

  // 修复9: 恢复断点续爬进度（在 init 之后，避免重复爬已访问页面）
  try {
    const progress = await Crawler.loadProgress();
    if (progress && progress.visited && progress.visited.length > 0) {
      log(`[断点续爬] 恢复 ${progress.visited.length} 个已访问页面记录`, 'success');
    }
  } catch (e) { /* 恢复失败不影响正常爬取 */ }

  Crawler.onPageCaptured((data) => {
    log(`页面发现: ${data.url} (深度${data.depth}, 新增${data.addedCount || 0}个链接)`, 'info');
  });

  // 爬取循环
  try {
    // ===== Phase 0: 自动下载 Webpack Chunk（仿 Webpack_extract）=====
    log('----------------------------------------', 'info');
    if (state.extractMap) {
      log('Phase 0: 下载 Webpack Chunk...', 'info');
      setStatus('正在下载 Webpack Chunk...');
      try {
        const wpChunks = await WebpackExtractor.downloadAllChunks((msg) => log('  [Chunk] ' + msg, 'info'));

        if (wpChunks.length > 0) {
          log('Webpack Chunk 下载完成: ' + wpChunks.length + ' 个文件', 'success');
          for (const r of wpChunks) {
            if (state.staticResourcePaths.has(r.url)) continue;
            state.staticResourcePaths.add(r.url);
            const resolved = UrlResolver.resolve(r.url, r.mimeType, r.content);
            addToAllResources(resolved.path, r.content, r.mimeType, r.url);
          }
          const chunkManifest = WebpackExtractor.getChunkManifest();
          if (chunkManifest.length > 0) {
            log('Webpack Chunk 清单 (' + chunkManifest.length + ' 个)', 'info');
          }
        } else {
          log('未发现 Webpack Chunk（网站可能不使用 Webpack）', 'info');
        }
      } catch (e) {
        log('Webpack Chunk 下载异常: ' + e.message, 'warning');
      }
    } else {
      log('Phase 0: 跳过（提取映射未启用）', 'info');
    }
    log('----------------------------------------', 'info');
    updateExtensionFilter();
    updateStats();
    updateResourcesList(dom.resourceFilter.value, dom.typeFilter.value === 'all' ? null : dom.typeFilter.value);

    // ===== Phase 0.5: 注入 FindSomething 监听缓存路径到队列头部 =====
    // 把监听期间被动抓取的同域 path 拼成完整 URL，作为 depth 0 种子优先爬取，
    // 爬完后再走正常 BFS（用户手动点击发现的功能点优先覆盖）。
    // 排序：正则匹配中勾选的后缀文件优先，确保高价值资源（JS/JSON/源码等）先被爬取
    const scheme = state.startUrl.startsWith('https') ? 'https' : 'http';
    const monitorUrls = PassiveMonitor.getPaths(state.domain, scheme);
    if (monitorUrls.length > 0) {
      log('----------------------------------------', 'info');
      log('Phase 0.5: 注入监听缓存路径 (' + monitorUrls.length + ' 条) 到爬取队列', 'info');
      setStatus('注入监听路径...');
      // 排序：正则匹配中勾选的文件后缀优先
      const allowedExts = state.allowedExtensions;
      monitorUrls.sort((a, b) => {
        const extA = getExtension(a);
        const extB = getExtension(b);
        const aVal = allowedExts ? (allowedExts.has(extA) ? 0 : 1) : 0;
        const bVal = allowedExts ? (allowedExts.has(extB) ? 0 : 1) : 0;
        return aVal - bVal;
      });
      // 监听路径作为 depth 0 种子插入队列头部（附加自定义 query），原起始 URL 排在其后
      const seeds = monitorUrls.map(u => ({ url: appendExtraQuery(u, state.extraQuery), depth: 0 }));
      Crawler._queue = [...seeds, ...Crawler._queue.slice(Crawler._queueHead)];
      Crawler._queueHead = 0;
      // 标记已访问（用签名机制，避免正常 BFS 重复入队）
      monitorUrls.forEach(u => Crawler._visited.add(Crawler._normalizeUrl(u)));
      log('监听路径已注入（优先后缀: ' + [...(allowedExts || [])].filter(e => monitorUrls.some(u => getExtension(u) === e)).slice(0, 10).join(', ') + '），将优先爬取', 'success');
      log('----------------------------------------', 'info');
      updateStats();
    } else {
      log('监听缓存为空（或无同域路径），跳过注入，直接正常爬取', 'info');
    }

    // ===== Phase 1: BFS 递归爬取 =====
    const PAGE_TIMEOUT = 60000; // 单页全局超时 60s

    // 标记 BFS 循环已启动，pauseCrawling 仅在此阶段生效
    state._bfsActive = true;

    while (Crawler.hasMore()) {
      // 暂停门：用户点击"停止"=暂停后，BFS 入口在此等待恢复
      // 当前页若正在处理会先完成，然后在下一轮入口挂起
      if (state.isPaused) {
        log('[暂停] BFS 已挂起，等待用户点击"继续爬取"...', 'warning');
        setStatus('⏸ 已暂停 — 点击"继续爬取"恢复');
        await new Promise((resolve) => { state._resumeResolve = resolve; });
        // 唤醒后检查是否被 reset 中止
        if (Crawler._stopped) {
          log('[暂停] 恢复时检测到已重置，退出 BFS', 'warning');
          break;
        }
        log('[恢复] 继续爬取', 'success');
      }

      // 体积上限保护
      if (state.totalSize >= state.maxTotalSize) {
        log('已达最大体积上限 (' + Utils.formatBytes(state.maxTotalSize) + ')，自动停止', 'warning');
        break;
      }

      const item = Crawler.next();
      const { url, depth } = item;

      // 页级超时 + 手动跳过：共用一个可外部触发的 abort promise
      // 与 captureAll 做 Promise.race，一旦触发立即中断阻塞操作，直接跳到下一个 URL
      let _pageAbortReject = null;
      state._abortReject = null;
      state._skipCurrentPage = false;
      const _pageAbortTimer = setTimeout(() => {
        log(`[超时] 单页处理超时 (${PAGE_TIMEOUT / 1000}s)，强制跳过`, 'warning');
        if (_pageAbortReject) _pageAbortReject({ _timeout: true });
      }, PAGE_TIMEOUT);

      // 附加自定义 query 参数（部分网站需要验证参数才能访问）
      const navUrl = appendExtraQuery(url, state.extraQuery);
      log(`[${state.pagesCrawled + 1}/${state.pagesCrawled + 1 + Crawler.queueSize()}] 导航到: ${navUrl} (深度${depth})`, 'info');
      setStatus(`正在爬取: ${navUrl}`);

      // 清空当前页network记录
      ResourceCapture.clearNetworkEntries();

      // 导航到目标URL（返回 { finalUrl } 供错误页检测）
      let navResult;
      try {
        navResult = await Crawler.navigateTo(navUrl);
      } catch (navErr) {
        log(`导航失败: ${url} - ${navErr.message}`, 'error');
        ErrorDetector.recordSkip(url, '导航失败: ' + navErr.message);
        dom.statSkipped.textContent = ErrorDetector.getSkipCount();
        if (Crawler._stopped) break;
        try { await Crawler.navigateTo(state.startUrl); } catch (e) {}
        clearTimeout(_pageAbortTimer);
        continue;
      }
      if (Crawler._stopped) break;
      
      // ===== 错误页检测（Phase 1 + Phase 2）=====
      const finalUrl = navResult.finalUrl || url;
      const errResult = await ErrorDetector.classifyError(url, finalUrl);
      
      if (errResult.isError) {
        log(`[跳过] ${url} — ${errResult.reason}`, 'warning');
        ErrorDetector.recordSkip(url, errResult.reason);
        ErrorDetector.recordSkeleton(errResult.skeleton, url, true, errResult.reason);
        dom.statSkipped.textContent = ErrorDetector.getSkipCount();
        updateFingerprintList();
        clearTimeout(_pageAbortTimer);
        continue;
      }

      // 记录骨架（正常页面也要记录，供 Phase 3 聚类用）
      if (errResult.skeleton) {
        ErrorDetector.recordSkeleton(errResult.skeleton, url, false, null);
      }

      // 等待网络空闲：空闲阈值固定300ms快速检测，最大等待由用户设置控制
      const idleTime = 300;
      const maxWait = state.crawlDelay;
      log(`等待网络空闲 (空闲阈值${idleTime}ms, 最长${maxWait / 1000}s)...`, 'info');
      await ResourceCapture.waitForNetworkIdle(idleTime, maxWait, () => Crawler._stopped);
      if (Crawler._stopped) break;

      // 自动滚动触发懒加载（修复5：IntersectionObserver、延迟加载图片等）
      if (state.autoScroll) {
        await ResourceCapture.autoScroll();
        if (Crawler._stopped) break;
        // 滚动后再等一次短网络空闲，捕获滚动触发的新请求
        await ResourceCapture.waitForNetworkIdle(idleTime, Math.min(maxWait, 1500), () => Crawler._stopped);
        if (Crawler._stopped) break;
      }

      // 捕获所有资源
      setStatus(`捕获资源: ${url}`);
      log(`捕获资源中...`, 'info');
      // captureAll 与页级超时/手动跳过赛跑：任一触发立即中断
      let captured;
      try {
        captured = await Promise.race([
          ResourceCapture.captureAll(),
          new Promise((_, reject) => { _pageAbortReject = reject; state._abortReject = reject; })
        ]);
      } catch (e) {
        if (e && (e._timeout || e._skipPage)) {
          clearTimeout(_pageAbortTimer);
          const reason = e._timeout ? '页级超时' : '手动跳过';
          ErrorDetector.recordSkip(url, reason);
          dom.statSkipped.textContent = ErrorDetector.getSkipCount();
          continue;
        }
        throw e;
      }
      // captureAll 正常完成，清除 abort 定时器
      _pageAbortReject = null;
      state._abortReject = null;
      clearTimeout(_pageAbortTimer);
      if (Crawler._stopped) break;

      if (captured.html) {
        log(`HTML源码: ${captured.html.length} 字符`, 'info');
      }
      log(`网络资源: ${captured.networkResources.length} 个`, 'info');
      log(`静态资源: ${captured.staticResources.length} 个`, 'info');

      // Webpack 资源深度提取：内省运行时 + 拉取遗漏的 chunk
      if (state.extractMap) {
        try {
          const wpResult = await WebpackExtractor.extractDuringCrawl(url);
          if (wpResult.resources.length > 0) {
            log(`Webpack提取: 补充 ${wpResult.resources.length} 个chunk`, 'info');
            for (const r of wpResult.resources) {
              captured.networkResources.push({
                url: r.url,
                mimeType: r.mimeType || 'application/javascript',
                content: r.content,
                status: 200,
                size: r.content ? r.content.length : 0,
                requestHeaders: [],
                responseHeaders: [],
              });
            }
          }
        } catch (e) {
          // Webpack 提取失败不阻断流程
        }
      }

      // 处理捕获的资源
      const procResult = processResources(captured, url, depth);
      state.pagesCrawled++;
      // Phase 3: 每 15 页自动聚类晋升错误页指纹
      if (state.pagesCrawled % 15 === 0) {
        const cr = ErrorDetector.runClustering();
        if (cr.promoted > 0) {
          log('[错误检测] 自动聚类: ' + cr.promoted + ' 个新指纹已确认（共 ' + ErrorDetector.getFingerprintCount() + ' 个）', 'success');
          updateFingerprintList();
        }
      }
      if (procResult.filteredCount > 0) {
        log(`后缀过滤: 跳过 ${procResult.filteredCount} 个资源, 保留 ${procResult.passedCount} 个`, 'info');
      }

      // 实时敏感扫描：仅扫描通过后缀过滤的资源内容
      if (state.scanEnabled) {
        const batchRes = new Map();
        for (const r of (captured.networkResources || [])) {
          if (r.url && r.content) {
            const resolved = UrlResolver.resolve(r.url, r.mimeType, r.content);
            if (!isExtensionAllowed(resolved.path)) continue;
            batchRes.set(resolved.path, { content: r.content, mimeType: r.mimeType });
          }
        }
        const scanResult = SensitiveScanner.scanBatch(batchRes, null);
        if (scanResult.hits.length > 0) {
          state.scanResults.push(...scanResult.hits);
          scanResult.hitPaths.forEach((count, p) => {
            state.scanHitPaths.set(p, (state.scanHitPaths.get(p) || 0) + count);
          });
        }
        // 也扫描当前页HTML（需通过后缀过滤）
        if (captured.html) {
          const pagePath = UrlResolver.resolve(url, 'text/html', null).path;
          if (isExtensionAllowed(pagePath)) {
            const htmlHits = SensitiveScanner.scanContent(captured.html, 'text/html', pagePath);
            if (htmlHits.length > 0) {
              state.scanResults.push(...htmlHits);
              state.scanHitPaths.set(pagePath, (state.scanHitPaths.get(pagePath) || 0) + htmlHits.length);
            }
          }
        }
      }

      // 提取子链接并加入队列（DOM 提链为主，正则为辅，需 await）
      await Crawler.processCapturedPage(url, depth, captured.html);
      state.successfulUrls.push(url);
      state.totalPagesCrawled++;

      // 未开启分卷时，接近大量页面时给出警告
      if (state.volumeSize === 0 && state.pagesCrawled === 2000) {
        log('[警告] 已爬取2000页，未开启分卷下载。建议设置分卷大小避免内存溢出导致崩溃', 'warning');
      }

      // 分卷下载：达到分卷页数阈值时，自动构建下载ZIP并清空内存
      if (state.volumeSize > 0 && state.pagesCrawled >= state.volumeSize) {
        log('----------------------------------------', 'warning');
        log(`[分卷] 当前卷已达 ${state.pagesCrawled} 页，自动构建第 ${state.volumeIndex} 卷ZIP...`, 'warning');
        setStatus(`构建第 ${state.volumeIndex} 卷ZIP...`);
        await buildZip(String(state.volumeIndex), true);
        if (state._pendingZip) {
          log(`[分卷] 第 ${state.volumeIndex} 卷已下载: ${state._pendingZipName}`, 'success');
          state._pendingZip = null;
          state._pendingZipName = '';
        }
        clearVolumeResources();
        state.volumeIndex++;
        updateStats();
        updateResourcesList(dom.resourceFilter.value, dom.typeFilter.value === 'all' ? null : dom.typeFilter.value);
        log('----------------------------------------', 'info');
      }

      // 修复9: 断点续爬 —— 每 10 页持久化一次已访问集合
      if (state.pagesCrawled % 10 === 0) {
        Crawler.saveProgress({ startUrl: state.startUrl, pagesCrawled: state.pagesCrawled });
      }

      // 更新UI
      updateStats();
      setProgress(Math.min(100, Math.round((state.pagesCrawled / (state.pagesCrawled + Crawler.queueSize() + 1)) * 100)));
      updateResourcesList(dom.resourceFilter.value, dom.typeFilter.value === 'all' ? null : dom.typeFilter.value);
      // 实时更新扫描结果
      if (state.scanEnabled) {
        updateScanResults();
        updateScanSummaryBar();
      }
    }

    // 爬取完成
    log('========================================', 'success');
    if (state.volumeSize > 0 && state.volumeIndex > 1) {
      log('爬取完成! 共爬取 ' + state.totalPagesCrawled + ' 个页面（分 ' + (state.volumeIndex - 1) + ' 卷下载）', 'success');
    } else {
      log('爬取完成! 共爬取 ' + state.pagesCrawled + ' 个页面', 'success');
    }
    log('捕获资源: ' + state.allResources.size + ' 个文件', 'success');
    log('HTML页面: ' + state.htmlSources.size + ' 个', 'success');
    log('总大小: ' + Utils.formatBytes(state.totalSize), 'success');
    log('========================================', 'success');
    // 修复9: 爬取正常完成，清除断点续爬进度
    Crawler.clearProgress();

    // Webpack 提取映射：解析 source map → 拉取完整源文件映射
    if (state.extractMap) {
      try {
        log('正在提取Webpack映射...', 'info');
        const wpResources = await WebpackExtractor.extractAfterCrawl(
          state.allResources,
          state.startUrl.startsWith('https') ? 'https' : 'http',
          (msg) => log(msg, 'info')
        );
        if (wpResources.length > 0) {
          log(`Webpack映射提取: 新增 ${wpResources.length} 个资源`, 'success');
          for (const r of wpResources) {
            if (state.staticResourcePaths.has(r.url)) continue;
            state.staticResourcePaths.add(r.url);
            const resolved = UrlResolver.resolve(r.url, r.mimeType, r.content);
            addToAllResources(resolved.path, r.content, r.mimeType, r.url);
          }
        }
      } catch (e) {
        log('Webpack映射提取异常: ' + e.message, 'warning');
      }
    }

    // 敏感扫描完成，生成报告并加入ZIP
    if (state.scanEnabled && state.scanResults.length > 0) {
      log(`敏感扫描: 发现 ${state.scanResults.length} 处匹配`, 'warning');
      const report = SensitiveScanner.generateReport(state.scanResults, state.domain);
      const reportPath = state.domain + '/0AHaE触发.txt';
      if (isExtensionAllowed(reportPath)) {
        state.allResources.set(reportPath, {
          path: reportPath,
          content: report,
          mimeType: 'text/plain',
          size: new TextEncoder().encode(report).length,
          type: 'other'
        });
        state.totalSize += new TextEncoder().encode(report).length;
      }
      updateScanResults();
      updateScanSummaryBar();
    }

    // 回到起始页
    try {
      log('返回起始页面...', 'info');
      await Crawler.navigateTo(state.startUrl);
    } catch (e) {}

    // 构建最终分卷（分卷模式下只构建有剩余资源的部分）
    if (state.allResources.size > 0 || state.htmlSources.size > 0) {
      setStatus('爬取完成，正在构建ZIP...');
      updateExtensionFilter();
      const finalVolLabel = state.volumeSize > 0 ? String(state.volumeIndex) : '';
      await buildZip(finalVolLabel || undefined);
    } else if (state.volumeSize > 0) {
      log('所有分卷已下载完毕，共 ' + (state.volumeIndex - 1) + ' 卷', 'success');
    }

  } catch (err) {
    log('爬取出错: ' + err.message, 'error');
    console.error('startCrawling error:', err);
    setStatus('出错: ' + err.message);
  } finally {
    finishCrawl();
  }
}

// 清理爬取状态（早期返回 + 正常结束共用）
function finishCrawl() {
  state.isCrawling = false;
  // 清理暂停状态（防止悬空 _resumeResolve / 残留 isPaused）
  state._bfsActive = false;
  state.isPaused = false;
  if (state._resumeResolve) {
    const resolve = state._resumeResolve;
    state._resumeResolve = null;
    resolve();
  }
  ResourceCapture.stopNetworkCapture();
  // 断开 SW 保活端口
  if (state._keepAlivePort) {
    try { state._keepAlivePort.disconnect(); } catch (e) {}
    state._keepAlivePort = null;
  }
  setButtons(false);
  setProgress(100);
  updateStats();
}

// 暂停爬取：停止按钮变身暂停（不构建 ZIP，仅挂起 BFS 循环等待恢复）
// 配合 startCrawling 顶部的恢复逻辑：暂停后点击"开始爬取"=恢复
function pauseCrawling() {
  if (!state.isCrawling || state.isPaused) return;
  // 仅 BFS 循环运行中允许暂停（Phase 0/0.5 阶段不支持）
  if (!state._bfsActive) {
    log('当前阶段不支持暂停（仅在 BFS 爬取阶段可暂停），稍后生效', 'warning');
    // 仍设置 isPaused，下一轮 BFS 入口会捕获
  }
  state.isPaused = true;
  log('========================================', 'warning');
  log('⏸ 爬取已暂停 — 当前页处理完成后将挂起等待恢复', 'warning');
  log('点击"继续爬取"按钮恢复，或"重置"放弃本次进度', 'info');
  log('========================================', 'warning');
  setStatus('⏸ 已暂停 — 点击"继续爬取"恢复');
  // UI: 停止按钮变橙色+禁用，开始按钮变"继续爬取"+启用
  dom.btnStart.disabled = false;
  dom.btnStart.textContent = '继续爬取';
  dom.btnStop.disabled = true;
  dom.btnStop.classList.remove('btn-danger');
  dom.btnStop.classList.add('btn-warning');
  dom.btnStop.textContent = '已暂停';
}

async function stopCrawling() {
  Crawler.stop();
  state.isCrawling = false;
  ResourceCapture.stopNetworkCapture();
  setStatus('用户停止，正在打包已捕获资源...');
  log('========================================', 'warning');
  log('用户手动停止爬取', 'warning');
  log(`已爬取 ${state.pagesCrawled} 个页面，捕获 ${state.allResources.size} 个资源`, 'info');

  if (state.allResources.size > 0 || state.htmlSources.size > 0) {
    try {
      // Webpack 提取映射
      if (state.extractMap) {
        try {
          log('正在提取Webpack映射...', 'info');
          const wpResources = await WebpackExtractor.extractAfterCrawl(
          state.allResources,
          state.startUrl.startsWith('https') ? 'https' : 'http',
          (msg) => log(msg, 'info')
        );
          if (wpResources.length > 0) {
            log(`Webpack映射提取: 新增 ${wpResources.length} 个资源`, 'success');
            for (const r of wpResources) {
              if (state.staticResourcePaths.has(r.url)) continue;
              state.staticResourcePaths.add(r.url);
              const resolved = UrlResolver.resolve(r.url, r.mimeType, r.content);
              addToAllResources(resolved.path, r.content, r.mimeType, r.url);
            }
          }
        } catch (e) { log('Webpack映射提取异常: ' + e.message, 'warning'); }
      }

      // 敏感扫描：生成报告并加入ZIP
      if (state.scanEnabled && state.scanResults.length > 0) {
        log(`敏感扫描: 发现 ${state.scanResults.length} 处匹配`, 'warning');
        const report = SensitiveScanner.generateReport(state.scanResults, state.domain);
        const reportPath = state.domain + '/0AHaE触发.txt';
        if (isExtensionAllowed(reportPath)) {
          state.allResources.set(reportPath, {
            path: reportPath,
            content: report,
            mimeType: 'text/plain',
            size: new TextEncoder().encode(report).length,
            type: 'other'
          });
          state.totalSize += new TextEncoder().encode(report).length;
        }
        updateScanResults();
        updateScanSummaryBar();
      }
      updateExtensionFilter();
      const stopVolLabel = state.volumeSize > 0 && state.totalPagesCrawled > 0 ? String(state.volumeIndex) : '';
      await buildZip(stopVolLabel || undefined);
    } catch (e) {
      log('构建ZIP失败: ' + e.message, 'error');
      setStatus('已停止（ZIP构建失败）');
    }
  } else {
    log('未捕获到任何资源，无法生成ZIP', 'warning');
    setStatus('已停止（无资源可下载）');
  }
  finishCrawl();
}

function resetAll() {
  Crawler.stop();
  // 解除暂停状态：唤醒挂起的 BFS 循环让它检测 _stopped 退出
  state.isPaused = false;
  state._bfsActive = false;
  if (state._resumeResolve) {
    const resolve = state._resumeResolve;
    state._resumeResolve = null;
    resolve();
  }
  state.isCrawling = false;
  state.pagesCrawled = 0;
  state.totalResources = 0;
  state.totalSize = 0;
  state.htmlPages = 0;
  state.capturedPages.clear();
  state.allResources.clear();
  state.htmlSources.clear();
  state.staticResourcePaths.clear();
  state.pageOrder = [];
  state.scanResults = [];
  state.scanHitPaths.clear();
  state.allowedExtensions = new Set(PRESET_CHECKED);
  state.extensionCounts.clear();
  WebpackExtractor.reset();
  Crawler.clearProgress();  // 修复9: 清除断点续爬进度
  state.successfulUrls = [];
  state._pendingZip = null;
  state._pendingZipName = '';
  ZipBuilder.init();

  // 重置 FindSomething 被动监听
  PassiveMonitor.stop();
  PassiveMonitor.clear();
  state.monitorListening = false;
  state.monitorCounts = { path: 0, incomplete_path: 0, url: 0, ip: 0, ip_port: 0, domain: 0, static: 0, vue: 0, post: 0, total: 0 };
  if (dom.btnMonitor) {
    dom.btnMonitor.classList.remove('monitor-recording');
    dom.btnMonitor.textContent = '监听';
  }

  // 重置 Vue 自动分析状态（不注销导航监听器，保持下次自动触发能力）
  state.vueAnalyzing = false;
  state._vueFirstLogDone = false;

  ErrorDetector.softReset();
  ResourceCapture.stopNetworkCapture();
  setButtons(false);
  setProgress(0);
  setStatus('就绪');
  dom.statSkipped.textContent = '0';
  updateStats();
  updateFingerprintList();
  dom.resourcesList.innerHTML = '<div class="empty-hint">尚未捕获资源</div>';
  dom.scanList.innerHTML = '<div class="empty-hint">尚未扫描</div>';
  if (dom.scanSummaryBar) dom.scanSummaryBar.style.display = 'none';
  if (dom.monitorList) dom.monitorList.innerHTML = '<div class="empty-hint">点击「监听」开始被动抓取路径</div>';
  if (dom.monitorStatsBar) dom.monitorStatsBar.style.display = 'none';
  dom.downloadSection.style.display = 'none';
  updateExtensionFilter();
  dom.logContainer.innerHTML = '';
  log('已重置', 'info');
}

// ========== 分卷 ZIP: 清空当前卷资源缓存 ==========
function clearVolumeResources() {
  state.allResources.clear();
  state.htmlSources.clear();
  state.capturedPages.clear();
  state.staticResourcePaths.clear();
  state.pageOrder = [];
  state.successfulUrls = [];
  state.scanResults = [];
  state.scanHitPaths.clear();
  state.extensionCounts.clear();
  state.totalSize = 0;
  state.pagesCrawled = 0;
}

// ========== ZIP 构建（核心，支持分卷命名 + 自动下载） ==========
// autoDownload: 分卷模式下立即下载，不显示按钮
async function buildZip(volumeLabel, autoDownload = false) {
  log('正在构建ZIP文件' + (volumeLabel ? ' (' + volumeLabel + ')' : '') + '...', 'info');
  setStatus('正在构建ZIP' + (volumeLabel ? ' (' + volumeLabel + ')' : '') + '，请稍候...');

  ZipBuilder.init();
  let fileCount = 0;

  // 修复3: 离线 URL 重写 —— 构建 originalUrl → localPath 映射
  let urlMap = null;
  if (state.rewriteOffline) {
    urlMap = buildOfflineUrlMap();
    log('离线重写: 映射表 ' + urlMap.size + ' 条', 'info');
  }

  // 添加所有资源
  for (const [path, res] of state.allResources) {
    let content = res.content;
    if (state.beautify) {
      content = beautifyContent(content, res.mimeType);
    }
    // 修复3: 对 HTML/CSS 做离线 URL 重写（beautify 之后）
    if (urlMap && urlMap.size > 0 && typeof content === 'string') {
      content = rewriteOfflineUrls(content, res.mimeType, res.originalUrl || '', path, urlMap);
    }
    await ZipBuilder.addFile(path, content, res.mimeType);
    fileCount++;
  }

  // 添加HTML页面（后缀过滤）
  for (const [path, html] of state.htmlSources) {
    if (!isExtensionAllowed(path)) continue;
    if (!state.allResources.has(path)) {
      let finalHtml = html;
      // 离线重写兜底的 HTML 页面（无 originalUrl 时用 path 反推）
      if (urlMap && urlMap.size > 0 && typeof finalHtml === 'string') {
        // path 格式 host/xxx，反推一个 origin 作为 base
        const fakeBase = 'https://' + (path.includes('/') ? path.split('/')[0] : path) + '/';
        finalHtml = rewriteOfflineUrls(finalHtml, 'text/html', fakeBase, path, urlMap);
      }
      await ZipBuilder.addFile(path, finalHtml, 'text/html');
      fileCount++;
    }
  }

  const totalSize = ZipBuilder.totalSize();
  log(`ZIP包含 ${fileCount} 个文件, 总大小 ${Utils.formatBytes(totalSize)}`, 'success');

  // 添加成功爬取的 URL 清单
  if (state.successfulUrls.length > 0) {
    const urlList = state.successfulUrls.join('\n') + '\n';
    await ZipBuilder.addFile(state.domain + '/url.txt', urlList, 'text/plain');
    fileCount++;
    log(`URL清单: ${state.successfulUrls.length} 条已加入 url.txt`, 'info');
  }

  // 生成ZIP数据，暂存不下载
  const zipData = await ZipBuilder.generate();
  const hostname = state.domain.replace(/[^a-zA-Z0-9.-]/g, '_');
  const volSuffix = volumeLabel ? '_part' + volumeLabel : '';
  const filename = `${hostname}${volSuffix}_${new Date().toISOString().slice(0, 10)}.zip`;

  // 存储待下载数据
  state._pendingZip = zipData;
  state._pendingZipName = filename;

  // 下载或显示按钮
  if (autoDownload) {
    ZipBuilder.download(zipData, filename);
    log(`[分卷] 自动下载: ${filename} (${Utils.formatBytes(zipData.length)})`, 'success');
    // 不清除 _pendingZip，让调用方可以用标准方式访问
    state._pendingZip = zipData;
    state._pendingZipName = filename;
  } else {
    setStatus('完成! 共 ' + fileCount + ' 个文件, ' + Utils.formatBytes(totalSize));
    log('========================================', 'success');
    log('ZIP已就绪! 点击下方"下载ZIP包"按钮开始下载', 'success');
    log('文件名: ' + filename, 'info');
    log(`文件数: ${fileCount}, 大小: ${Utils.formatBytes(zipData.length)}`, 'info');
    log('========================================', 'success');
    showDownloadButton(filename, zipData.length, fileCount);
  }
  setProgress(100);
}

function showDownloadButton(filename, zipSize, fileCount) {
  dom.downloadSection.innerHTML = `
    <div class="download-info">
      ZIP已就绪 →
      <strong>${escapeHtml(filename)}</strong>
      &nbsp;|&nbsp; ${fileCount} 个文件
      &nbsp;|&nbsp; ${Utils.formatBytes(zipSize)}
    </div>
    <button id="btn-download-zip" class="btn btn-success btn-large">下载ZIP包</button>
  `;
  dom.downloadSection.style.display = 'block';

  document.getElementById('btn-download-zip').onclick = () => {
    if (state._pendingZip) {
      ZipBuilder.download(state._pendingZip, state._pendingZipName);
      log('下载已触发: ' + state._pendingZipName, 'success');
    }
	  };
}

// ========== FindSomething 被动监听 ==========

// 切换监听状态
function toggleMonitor() {
  if (state.monitorListening) {
    stopMonitor();
  } else {
    startMonitor();
  }
}

function startMonitor() {
  // 爬取中不允许开启监听（与 clearNetworkEntries 冲突）
  if (state.isCrawling) {
    log('爬取进行中，无法开启监听', 'warning');
    return;
  }

  // 确保 tabId 已就绪
  if (!state.tabId) {
    state.tabId = getDevToolsTabId();
  }
  if (!state.tabId) {
    log('无法获取当前标签页ID，请确认 DevTools 已连接到目标页面', 'error');
    return;
  }

  const ok = PassiveMonitor.start({
    onEntry: (entries) => {
      // 实时更新 UI（节流，避免高频请求刷屏）
      state.monitorCounts = PassiveMonitor.getCounts();
      updateMonitorStats();
      // 仅当监听路径 Tab 可见或本次新增较多时刷新列表
      const monitorTabVisible = document.getElementById('tab-monitor')?.classList.contains('active');
      if (monitorTabVisible) {
        updateMonitorList(dom.monitorFilter.value, dom.monitorTypeFilter.value === 'all' ? null : dom.monitorTypeFilter.value);
      }
      // 节流日志：500ms 内最多一条汇总
      throttledMonitorLog(entries);
    },
    // 修复12: POST body / GET query 扫描命中回调
    onScanHit: (hits) => {
      if (!hits || hits.length === 0) return;
      state.scanResults.push(...hits);
      // hits 里每条含 filePath（标记 [POST]/[GET] + endpoint），用它更新 scanHitPaths
      for (const h of hits) {
        const fp = h.filePath || '';
        state.scanHitPaths.set(fp, (state.scanHitPaths.get(fp) || 0) + 1);
      }
      // 节流日志
      const now = Date.now();
      if (!state._monitorLogThrottle || now - state._monitorLogThrottle > 800) {
        state._monitorLogThrottle = now;
        const postN = hits.filter(h => (h.filePath||'').startsWith('[POST]')).length;
        const getN = hits.filter(h => (h.filePath||'').startsWith('[GET]')).length;
        log('[监听] 请求参数扫描命中 ' + hits.length + ' 处 (POST ' + postN + ' / GET ' + getN + ')', 'warning');
      }
      // 若扫描结果 Tab 可见则刷新
      const scanTabVisible = document.getElementById('tab-scan')?.classList.contains('active');
      if (scanTabVisible) {
        updateScanResults();
        updateScanSummaryBar();
      }
    }
  });

  if (!ok) {
    log('监听启动失败（Network API 不可用）', 'error');
    return;
  }

  state.monitorListening = true;
  dom.btnMonitor.classList.add('monitor-recording');
  dom.btnMonitor.textContent = '停止监听';
  log('========================================', 'info');
  log('🔍 FindSomething 被动监听已开启', 'success');
  log('手动点击网站功能点，所有请求的路径/URL 将被实时抓取', 'info');
  log('========================================', 'info');
  setStatus('监听中 — 浏览目标网站功能点');
}

function stopMonitor() {
  PassiveMonitor.stop();
  state.monitorListening = false;
  dom.btnMonitor.classList.remove('monitor-recording');
  dom.btnMonitor.textContent = '监听';

  state.monitorCounts = PassiveMonitor.getCounts();
  const c = state.monitorCounts;
  log('========================================', 'info');
  log('⏹ 监听已停止', 'warning');
  log(`缓存: ${c.total} 条 (path=${c.path}, incomplete=${c.incomplete_path}, vue=${c.vue}, post=${c.post}, url=${c.url}, ip=${c.ip}, domain=${c.domain})`, 'info');
  // 计算可注入爬虫的同域路径数
  if (state.domain) {
    const scheme = state.startUrl.startsWith('https') ? 'https' : 'http';
    const crawlable = PassiveMonitor.getPaths(state.domain, scheme);
    log(`同域可爬路径: ${crawlable.length} 条（将在「开始爬取」时优先注入队列）`, 'success');
  }
  log('========================================', 'info');

  updateMonitorStats();
  updateMonitorList(dom.monitorFilter.value, dom.monitorTypeFilter.value === 'all' ? null : dom.monitorTypeFilter.value);
  setStatus('监听已停止，缓存已保留');
}

// 监听日志节流
function throttledMonitorLog(entries) {
  const now = Date.now();
  if (!state._monitorLogThrottle || now - state._monitorLogThrottle > 800) {
    state._monitorLogThrottle = now;
    const types = {};
    for (const e of entries) types[e.type] = (types[e.type] || 0) + 1;
    const summary = Object.entries(types).map(([k, v]) => `${k}+${v}`).join(' ');
    log(`[监听] 新增 ${entries.length} 条: ${summary}`, 'info');
  }
}

// 更新监听路径列表 UI
function updateMonitorList(filterText, filterType) {
  if (!dom.monitorList) return;
  const entries = PassiveMonitor.getAllEntries();

  let filtered = entries;
  if (filterText) {
    const lower = filterText.toLowerCase();
    filtered = filtered.filter(e =>
      (e.raw || '').toLowerCase().includes(lower) ||
      (e.source || '').toLowerCase().includes(lower) ||
      (e.bodyPreview || '').toLowerCase().includes(lower)  // 修复12: body 也参与过滤
    );
  }
  if (filterType) {
    filtered = filtered.filter(e => e.type === filterType);
  }

  if (filtered.length === 0) {
    dom.monitorList.innerHTML = '<div class="empty-hint">' +
      (entries.length === 0 ? '点击「监听」开始被动抓取路径' : '无匹配路径') + '</div>';
    return;
  }

  // 限制渲染条数避免卡顿（保留最新 500 条展示）
  const display = filtered.length > 500 ? filtered.slice(-500) : filtered;
  const truncated = filtered.length > 500;

  let html = '';
  for (const e of display) {
    // 修复12: POST 类型附带 body 预览
    const bodyHtml = (e.type === 'post' && e.bodyPreview)
      ? `<span class="monitor-body" title="${escapeHtml(e.bodyMime || '')}">${escapeHtml(e.bodyPreview)}</span>`
      : '';
    // 复选框 data-norm 用 norm（去重 key）作为删除依据；encodeURIComponent 防属性截断
    html += `<div class="monitor-item">
      <input type="checkbox" class="monitor-check" data-norm="${encodeURIComponent(e.norm || '')}" />
      <span class="type-badge ${e.type}">${e.type}</span>
      <span class="monitor-path" title="${escapeHtml(e.raw)}">${escapeHtml(e.raw)}</span>
      <span class="monitor-source" title="来源: ${escapeHtml(e.source)}">${escapeHtml(e.source)}</span>
      ${bodyHtml}
    </div>`;
  }
  if (truncated) {
    html += `<div class="empty-hint">… 仅显示最新 500 条（共 ${filtered.length} 条）</div>`;
  }
  dom.monitorList.innerHTML = html;
}

// 更新监听计数摘要条
function updateMonitorStats() {
  if (!dom.monitorStatsBar) return;
  const c = PassiveMonitor.getCounts();
  if (c.total === 0) {
    dom.monitorStatsBar.style.display = 'none';
    return;
  }
  dom.monitorStatsBar.innerHTML = `
    <span>共 <span class="stat-strong">${c.total}</span></span>
    <span>Path <span class="stat-strong">${c.path}</span></span>
    <span>Incomplete <span class="stat-strong">${c.incomplete_path}</span></span>
    <span>Vue <span class="stat-strong">${c.vue || 0}</span></span>
    <span>POST <span class="stat-strong">${c.post || 0}</span></span>
    <span>Url <span class="stat-strong">${c.url}</span></span>
    <span>Domain <span class="stat-strong">${c.domain}</span></span>
    <span>IP <span class="stat-strong">${c.ip}</span></span>
    <span>IP:Port <span class="stat-strong">${c.ip_port}</span></span>
    <span>Static <span class="stat-strong">${c.static}</span></span>
  `;
  dom.monitorStatsBar.style.display = 'flex';
}

// 清空监听缓存
function clearMonitorCache() {
  const cnt = PassiveMonitor.getCounts().total;
  PassiveMonitor.clear();
  state.monitorCounts = PassiveMonitor.getCounts();
  updateMonitorStats();
  updateMonitorList(dom.monitorFilter.value, dom.monitorTypeFilter.value === 'all' ? null : dom.monitorTypeFilter.value);
  log('已清空监听缓存 (' + cnt + ' 条)', 'info');
}

// 删除勾选的监听路径
function deleteSelectedMonitorEntries() {
  if (!dom.monitorList) return;
  const checks = dom.monitorList.querySelectorAll('input.monitor-check:checked');
  if (!checks.length) {
    log('未勾选任何路径', 'warning');
    return;
  }
  const norms = [];
  checks.forEach(c => {
    const n = c.getAttribute('data-norm');
    if (n) {
      try { norms.push(decodeURIComponent(n)); }
      catch (e) { norms.push(n); }
    }
  });
  const removed = PassiveMonitor.removeEntries(norms);
  state.monitorCounts = PassiveMonitor.getCounts();
  updateMonitorStats();
  updateMonitorList(dom.monitorFilter.value, dom.monitorTypeFilter.value === 'all' ? null : dom.monitorTypeFilter.value);
  log('已删除勾选路径 ' + removed + ' 条', 'info');
}

// 展开收起黑名单编辑区
function toggleBlacklistSection() {
  if (!dom.blacklistSection) return;
  const open = dom.blacklistSection.style.display === 'none';
  if (open) {
    // 展开时回填当前黑名单
    dom.blacklistTextarea.value = PassiveMonitor.getBlacklist().join('\n');
    dom.blacklistStatus.textContent = '';
  }
  dom.blacklistSection.style.display = open ? 'block' : 'none';
}

// 保存黑名单编辑
function saveMonitorBlacklist() {
  const text = (dom.blacklistTextarea.value || '').trim();
  // 按行分割，去重去空
  const list = [...new Set(text.split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
  PassiveMonitor.saveBlacklist(list);
  dom.blacklistStatus.textContent = '已保存 ' + list.length + ' 个关键字';
  log('黑名单已保存 (' + list.length + ' 个关键字)', 'success');
}

// 恢复默认黑名单
function resetMonitorBlacklist() {
  PassiveMonitor.resetBlacklist();
  dom.blacklistTextarea.value = PassiveMonitor.getBlacklist().join('\n');
  dom.blacklistStatus.textContent = '已恢复默认';
  log('黑名单已恢复默认', 'info');
}

// 复制全部监听路径
function copyMonitorPaths() {
  const entries = PassiveMonitor.getAllEntries();
  if (entries.length === 0) {
    log('无路径可复制', 'warning');
    return;
  }
  const text = entries.map(e => e.raw).join('\n');
  navigator.clipboard.writeText(text).then(() => {
    log('已复制 ' + entries.length + ' 条路径到剪贴板', 'success');
  }).catch(() => {
    // 降级：用 textarea
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); log('已复制 ' + entries.length + ' 条路径到剪贴板', 'success'); }
    catch (e) { log('复制失败', 'error'); }
    ta.remove();
  });
}

// ========== VueCrack 自动 Vue 路由分析 ==========

// 注册导航监听：被检查页面每次主框架导航完成时自动触发 Vue 分析
function setupVueAutoTrigger() {
  // 防止重复注册（面板可能多次 init）
  if (state._vueNavListener) return;

  const listener = (details) => {
    // 仅监听 DevTools inspect 的那个 tab 的主框架
    if (!details || details.tabId !== state.tabId) return;
    if (details.frameId !== 0) return;       // 只主框架
    // 爬取中暂停（爬虫会频繁 navigateTo，避免干扰）
    if (state.isCrawling) return;
    // 防重入
    if (state.vueAnalyzing) return;
    // 非 http(s) 页面跳过
    if (!details.url || (!details.url.startsWith('http:') && !details.url.startsWith('https:'))) return;
    // 延迟等待 Vue 应用挂载完成（VueCrack 用 document_idle，这里额外等 mount）
    setTimeout(() => triggerVueAnalysis(details.url), 800);
  };

  try {
    chrome.webNavigation.onCompleted.addListener(listener);
    state._vueNavListener = listener;
  } catch (e) {
    // webNavigation 不可用时静默降级（init 时的首次分析仍可工作）
  }
}

// 触发一次 Vue 分析，结果注入 PassiveMonitor 缓存池
async function triggerVueAnalysis(url) {
  // 双重保险：爬取中 / 正在分析中 不触发
  if (state.isCrawling || state.vueAnalyzing) return;
  state.vueAnalyzing = true;
  try {
    const result = await VueAnalyzer.analyze();

    // 非 Vue 站点：静默跳过（仅首次打一条提示，便于用户确认能力已生效）
    if (!result || !result.detected) {
      if (!state._vueFirstLogDone) {
        state._vueFirstLogDone = true;
        log('[Vue] 当前页未检测到 Vue（自动分析已就绪，导航到 Vue 站点会自动提取路由）', 'info');
      }
      return;
    }

    // 检测到 Vue：注入缓存
    const routes = (result.routes || []).filter(r => r && r.path);
    const inj = VueAnalyzer.injectToMonitor(routes, url);

    if (inj.added > 0) {
      log(`[Vue] 检测到 ${result.vueVersion || 'Vue'}，提取 ${routes.length} 条路由，新增 ${inj.added} 条到缓存`, 'success');
      state.monitorCounts = PassiveMonitor.getCounts();
      updateMonitorStats();
      // 若监听路径 Tab 可见则刷新列表
      const monitorTabVisible = document.getElementById('tab-monitor')?.classList.contains('active');
      if (monitorTabVisible) {
        updateMonitorList(dom.monitorFilter.value, dom.monitorTypeFilter.value === 'all' ? null : dom.monitorTypeFilter.value);
      }
    } else if (routes.length > 0 && inj.skipped === routes.length) {
      // 路由表未变（全部去重跳过）：不打日志，避免刷屏
    }
  } catch (e) {
    // Vue 分析异常静默处理，不打扰用户
  } finally {
    state.vueAnalyzing = false;
  }
}

// ========== 扫描结果 UI ==========
function updateScanResults() {
  if (!dom.scanList) return;
  dom.scanList.innerHTML = '';

  let hits = [...state.scanResults];
  const filterText = (dom.scanFilter && dom.scanFilter.value || '').toLowerCase();
  const filterSev = dom.scanSeverityFilter ? dom.scanSeverityFilter.value : 'all';

  if (filterText) {
    hits = hits.filter(h =>
      (h.rule || '').toLowerCase().includes(filterText) ||
      (h.match || '').toLowerCase().includes(filterText) ||
      (h.filePath || '').toLowerCase().includes(filterText)
    );
  }
  if (filterSev !== 'all') {
    hits = hits.filter(h => h.severity === filterSev);
  }

  if (hits.length === 0) {
    dom.scanList.innerHTML = '<div class="empty-hint">' + (state.scanResults.length === 0 ? '尚未扫描' : '无匹配结果') + '</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const hit of hits) {
    const div = document.createElement('div');
    div.className = 'scan-item';
    const severity = SensitiveScanner.severityClass(hit.severity);
    div.innerHTML = `
      <span class="type-badge ${severity}">${escapeHtml(hit.severity)}</span>
      <span style="font-weight:600;white-space:nowrap;">${escapeHtml(hit.rule)}</span>
      <span class="scan-match" title="${escapeHtml(hit.match)}">${escapeHtml(hit.match)}</span>
      <span class="scan-file" title="${escapeHtml(hit.filePath)}">${escapeHtml(hit.filePath)}</span>
    `;
    fragment.appendChild(div);
  }
  dom.scanList.appendChild(fragment);
}

function updateScanSummaryBar() {
  if (!dom.scanSummaryBar) return;
  if (state.scanResults.length === 0) {
    dom.scanSummaryBar.style.display = 'none';
    return;
  }
  const c = { critical: 0, high: 0, medium: 0, low: 0 };
  const f = new Set();
  for (const h of state.scanResults) { c[h.severity] = (c[h.severity] || 0) + 1; f.add(h.filePath); }
  dom.scanSummaryBar.innerHTML = `
    <span style="color:#d32f2f;">🔴 ${c.critical}</span>
    <span style="color:#f57c00;">🟠 ${c.high}</span>
    <span style="color:#fbc02d;">🟡 ${c.medium}</span>
    <span style="color:#1976d2;">🔵 ${c.low}</span>
    <span>文件: ${f.size}</span>
  `;
  dom.scanSummaryBar.style.display = 'flex';
}

function getHighestSeverity(path) {
  let maxSev = '';
  const order = { critical: 4, high: 3, medium: 2, low: 1 };
  for (const h of state.scanResults) {
    if (h.filePath === path && (order[h.severity] || 0) > (order[maxSev] || 0)) {
      maxSev = h.severity;
    }
  }
  return maxSev;
}

function exportRules() {
  const json = SensitiveScanner.exportRules();
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'WebMirror_HaE_Rules_' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  log('规则已导出: ' + a.download, 'success');
}

function importRules(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const result = SensitiveScanner.importRules(ev.target.result, false);
    log(result.message, result.success ? 'success' : 'error');
  };
  reader.readAsText(file);
  e.target.value = ''; // 允许重复选择同一文件
}

function resetScanRules() {
  const result = SensitiveScanner.resetRules();
  log(result.message, 'success');
}

// ========== Tab 信息获取 ==========
// DevTools 面板直接从 inspectedWindow 获取 tabId（最可靠方式）
function getDevToolsTabId() {
  return chrome.devtools.inspectedWindow.tabId;
}

function getTabInfo(tabId) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, 10000);
    try {
      chrome.tabs.get(tabId, (tab) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(tab);
      });
    } catch(e) { if (!settled) { settled = true; clearTimeout(timer); resolve(null); } }
  });
}

async function getCurrentPageUrl() {
  return new Promise((resolve) => {
    const tabId = getDevToolsTabId();
    if (!tabId) { resolve(null); return; }
    let settled = false;
    // 主通道: chrome.tabs.get（快但偶发回调不触发）
    const timer = setTimeout(() => {
      // tabs.get 超时，走兜底 eval
      if (settled) return;
      fallbackEval();
    }, 3000);
    const stopCheck = setInterval(() => {
      if (Crawler._stopped) {
        if (!settled) { settled = true; clearTimeout(timer); clearInterval(stopCheck); resolve(null); }
      }
    }, 500);
    try {
      chrome.tabs.get(tabId, (tab) => {
        if (settled) return;
        if (chrome.runtime.lastError || !tab || !tab.url) {
          // tabs.get 返回空，走兜底
          fallbackEval();
          return;
        }
        settled = true; clearTimeout(timer); clearInterval(stopCheck);
        resolve(tab.url);
      });
    } catch(e) {
      if (!settled) { fallbackEval(); }
    }

    // 兜底: inspectedWindow.eval 直接从页面拿 location.href
    function fallbackEval() {
      if (settled) return;
      settled = true; clearTimeout(timer); clearInterval(stopCheck);
      let evalSettled = false;
      const evalTimer = setTimeout(() => {
        if (!evalSettled) {
          evalSettled = true;
          resolve(null);
        }
      }, 5000);
      try {
        chrome.devtools.inspectedWindow.eval('location.href', (result, isException) => {
          if (evalSettled) return;
          evalSettled = true;
          clearTimeout(evalTimer);
          resolve((!isException && result && result.startsWith('http')) ? result : null);
        });
      } catch(e) {
        if (!evalSettled) {
          evalSettled = true;
          clearTimeout(evalTimer);
          resolve(null);
        }
      }
    }
  });
}

// ========== 事件监听 ==========
dom.btnStart.addEventListener('click', startCrawling);
// 停止按钮 = 暂停（不构建 ZIP，挂起 BFS 等待恢复）
// 暂停后点击"开始爬取"= 恢复爬取（见 startCrawling 顶部）
dom.btnStop.addEventListener('click', pauseCrawling);
dom.btnReset.addEventListener('click', resetAll);

// FindSomething 被动监听
dom.btnMonitor.addEventListener('click', toggleMonitor);
dom.btnMonitorClear.addEventListener('click', clearMonitorCache);
dom.btnMonitorCopy.addEventListener('click', copyMonitorPaths);
dom.btnMonitorDelete.addEventListener('click', deleteSelectedMonitorEntries);
dom.btnBlacklistToggle.addEventListener('click', toggleBlacklistSection);
dom.btnBlacklistSave.addEventListener('click', saveMonitorBlacklist);
dom.btnBlacklistReset.addEventListener('click', resetMonitorBlacklist);
dom.monitorFilter.addEventListener('input', Utils.debounce(() => {
  updateMonitorList(dom.monitorFilter.value, dom.monitorTypeFilter.value === 'all' ? null : dom.monitorTypeFilter.value);
}, 300));
dom.monitorTypeFilter.addEventListener('change', () => {
  updateMonitorList(dom.monitorFilter.value, dom.monitorTypeFilter.value === 'all' ? null : dom.monitorTypeFilter.value);
});

// 资源过滤
dom.resourceFilter.addEventListener('input', Utils.debounce(() => {
  updateResourcesList(dom.resourceFilter.value, dom.typeFilter.value === 'all' ? null : dom.typeFilter.value);
}, 300));

dom.typeFilter.addEventListener('change', () => {
  updateResourcesList(dom.resourceFilter.value, dom.typeFilter.value === 'all' ? null : dom.typeFilter.value);
});

// 敏感扫描
dom.scanCheck.addEventListener('change', () => {
  state.scanEnabled = dom.scanCheck.checked;
});

// 提取映射
dom.extractMapCheck.addEventListener('change', () => {
  state.extractMap = dom.extractMapCheck.checked;
});

dom.scanFilter.addEventListener('input', Utils.debounce(() => {
  updateScanResults();
}, 300));

dom.scanSeverityFilter.addEventListener('change', () => {
  updateScanResults();
});

// 正则匹配（后缀过滤）
dom.extSelectAll.addEventListener('change', toggleSelectAllExtensions);
dom.btnExtPreset.addEventListener('click', resetExtensionPreset);

// 手动跳过当前页（触发 _pageAbortReject 中断 captureAll 的 Promise.race）
dom.btnSkipPage.addEventListener('click', () => {
  if (!state.isCrawling) return;
  state._skipCurrentPage = true;
  log('[跳过] 用户手动跳过当前页', 'warning');
  if (state._abortReject) {
    state._abortReject({ _skipPage: true });
    state._abortReject = null;
  }
});

// 错误页指纹
dom.btnMarkErrpage.addEventListener('click', markCurrentAsError);
dom.btnClearFingerprints.addEventListener('click', clearAllFingerprints);

dom.btnExportRules.addEventListener('click', exportRules);
dom.btnImportRules.addEventListener('click', () => dom.rulesFileInput.click());
dom.btnResetRules.addEventListener('click', resetScanRules);
dom.rulesFileInput.addEventListener('change', importRules);

// ========== 错误页指纹管理 UI ==========

function updateFingerprintList() {
  if (!dom.fingerprintList) return;
  const fps = ErrorDetector.getFingerprints();
  if (fps.length === 0) {
    dom.fingerprintList.innerHTML = '<div class="empty-hint">暂无错误页指纹（爬取中自动学习 / 手动标记）</div>';
    if (dom.errpageInfo) dom.errpageInfo.textContent = '指纹库: 0 条';
    return;
  }
  if (dom.errpageInfo) dom.errpageInfo.textContent = '指纹库: ' + fps.length + ' 条 | 候选: ' + ErrorDetector.getCandidateCount() + ' | 历史: ' + ErrorDetector.getHistoryLength();
  let html = '';
  for (const fp of fps) {
    const heading = fp.heading || '';
    const title = fp.title || '无标题';
    const label = heading ? `[${heading}] title: ${title}` : `title: ${title}`;
    html += `<div class="scan-item" style="justify-content:space-between;">
      <span class="type-badge" style="background:#d32f2f;color:#fff;">指纹</span>
      <span style="font-size:11px;font-family:monospace;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0 8px;" title="${escapeHtml(fp.skeleton)}">${escapeHtml(label)}</span>
      <span style="font-size:10px;color:var(--text-secondary);">#${fp.hash}</span>
      <button class="btn btn-secondary fp-del-btn" style="padding:1px 6px;font-size:10px;flex:none;margin-left:8px;" data-del-hash="${fp.hash}">删除</button>
    </div>`;
  }
  dom.fingerprintList.innerHTML = html;
}

async function markCurrentAsError() {
  const info = await ErrorDetector.extractSkeleton();
  if (!info || !info.skeleton) {
    log('无法提取当前页 DOM 骨架', 'error');
    return;
  }
  ErrorDetector.addFingerprint(info.skeleton, info.title || '', info.heading || '');
  log('已标记当前页为错误页，指纹已入库 (title: ' + (info.title || '无') + ')', 'success');
  updateFingerprintList();
}

function clearAllFingerprints() {
  const cnt = ErrorDetector.getFingerprintCount();
  ErrorDetector.reset();
  updateFingerprintList();
  log('已清空错误页指纹库 (' + cnt + ' 条)', 'info');
}

// 删除指纹事件（事件委托，避免 MV3 CSP 拦截内联 onclick）
if (dom.fingerprintList) {
  dom.fingerprintList.addEventListener('click', (e) => {
    const btn = e.target.closest('.fp-del-btn');
    if (!btn) return;
    const hash = btn.getAttribute('data-del-hash');
    if (!hash) return;
    const fps = ErrorDetector.getFingerprints();
    const found = fps.find(f => f.hash === hash);
    if (found) {
      ErrorDetector.removeFingerprint(found.skeleton);
      updateFingerprintList();
      log('已删除指纹 #' + hash, 'info');
    } else {
      log('未找到指纹 #' + hash + '（可能已被删除）', 'warning');
    }
  });
}

// ========== 初始化 ==========
async function init() {
  log('WebMirror v7.0 启动', 'info');
  log('网站镜像工具 - 递归爬取 + 网络捕获 + HTML源码', 'info');
  log('数据源: DevTools Network API + inspectedWindow + HTML源码', 'info');

  // 在用户开始扫描前恢复已持久化的自定义规则
  await SensitiveScanner.init();

  // 加载用户自定义黑名单（加载完成前用默认列表兜底）
  PassiveMonitor.loadBlacklist().then(list => {
    log('监听黑名单已加载 (' + list.length + ' 个关键字)', 'info');
  }).catch(() => {});

  try {
    const tabId = getDevToolsTabId();
    state.tabId = tabId;
    if (tabId) {
      const currentUrl = await getCurrentPageUrl();
      dom.currentUrl.textContent = currentUrl || '未知';
      state.startUrl = currentUrl;
      state.domain = Utils.getHost(currentUrl || '');
      log('当前页面: ' + currentUrl, 'info');
    }
  } catch (e) {
    dom.currentUrl.textContent = '获取URL失败';
  }

  updateStats();
  updateExtensionFilter();
  updateFingerprintList();
  log('就绪 - 设置爬取参数后点击"开始爬取"', 'info');
  log('正则匹配: 后缀过滤已加载持久化配置，勾选即生效', 'info');

  // 注册 Vue 自动分析导航监听（每次页面导航完成自动触发）
  setupVueAutoTrigger();
  // 首次：对当前已加载页面跑一次 Vue 分析（延迟等待页面就绪）
  if (state.tabId && state.startUrl && state.startUrl.startsWith('http')) {
    setTimeout(() => triggerVueAnalysis(state.startUrl), 1000);
  }

  // 修复9: 检测是否有未完成的断点续爬进度（仅提示，不自动恢复）
  if (state.startUrl && state.startUrl.startsWith('http')) {
    Crawler._domain = Utils.getHost(state.startUrl); // 预设 domain 供 loadProgress 匹配
    Crawler.loadProgress().then((p) => {
      if (p && p.visited && p.visited.length > 0) {
        // 注意：loadProgress 已把 visited 恢复进 _visited，但此时 Crawler 还未 init，
        // 下次 startCrawling 时 init 会重置 _visited，故此处仅作提示，恢复在 startCrawling 内进行
        const ts = p.ts ? new Date(p.ts).toLocaleString() : '未知时间';
        log(`[断点续爬] 检测到上次未完成的爬取进度（${p.visited.length} 个已访问页面，${ts}）`, 'warning');
        log('开始爬取时将自动恢复已访问记录，避免重复爬取', 'info');
      }
    });
  }
}

init();
})();
