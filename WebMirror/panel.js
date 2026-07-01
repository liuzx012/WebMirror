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
  crawlDepth: 2,
  crawlDelay: 3000,
  sameDomainOnly: true,
  beautify: false,
  ignoreEmpty: true,
  pagesCrawled: 0,
  totalResources: 0,
  totalSize: 0,
  htmlPages: 0,

  // 待下载ZIP
  _pendingZip: null,
  _pendingZipName: '',

  // 收集所有页面的完整捕获数据
  capturedPages: new Map(),    // urlPath -> { pageInfo, html, resources }
  allResources: new Map(),    // filePath -> { url, path, content, mimeType, size, type }
  htmlSources: new Map(),     // urlPath -> html content
  staticResourcePaths: new Set(), // 已捕获的静态资源URL集合
  pageOrder: []               // 爬取顺序
};

// ========== DOM 引用 ==========
const $ = (sel) => document.querySelector(sel);
const dom = {
  currentUrl: $('#current-url'),
  depthSelect: $('#depth-select'),
  delaySelect: $('#delay-select'),
  sameDomainCheck: $('#same-domain-check'),
  beautifyCheck: $('#beautify-check'),
  ignoreEmptyCheck: $('#ignore-empty-check'),
  btnStart: $('#btn-start'),
  btnStop: $('#btn-stop'),
  btnReset: $('#btn-reset'),
  statPages: $('#stat-pages'),
  statQueue: $('#stat-queue'),
  statResources: $('#stat-resources'),
  statSize: $('#stat-size'),
  statHtml: $('#stat-html'),
  progressBar: $('#progress-bar'),
  statusText: $('#status-text'),
  logContainer: $('#log-container'),
  pagesList: $('#pages-list'),
  resourcesList: $('#resources-list'),
  htmlPagesList: $('#html-pages-list'),
  downloadSection: $('#download-section'),
  resourceFilter: $('#resource-filter'),
  typeFilter: $('#type-filter'),
  tabs: document.querySelectorAll('.tab'),
  tabContents: document.querySelectorAll('.tab-content')
};

// ========== 日志系统 ==========
function log(msg, type = 'info') {
  const entry = document.createElement('div');
  entry.className = 'log-entry ' + type;
  const time = new Date().toLocaleTimeString();
  entry.textContent = `[${time}] ${msg}`;
  dom.logContainer.appendChild(entry);
  dom.logContainer.scrollTop = dom.logContainer.scrollHeight;

  // 保留最近500条
  while (dom.logContainer.children.length > 500) {
    dom.logContainer.firstChild.remove();
  }
}

// ========== UI 更新 ==========
function updateStats() {
  dom.statPages.textContent = state.pagesCrawled;
  dom.statQueue.textContent = Crawler.queueSize();
  dom.statResources.textContent = state.allResources.size;
  dom.statSize.textContent = Utils.formatBytes(state.totalSize);
  dom.statHtml.textContent = state.htmlSources.size;
}

function setProgress(percent) {
  dom.progressBar.style.width = Math.min(100, Math.max(0, percent)) + '%';
}

function setStatus(msg) {
  dom.statusText.textContent = msg;
}

function setButtons(crawling) {
  dom.btnStart.disabled = crawling;
  dom.btnStop.disabled = !crawling;
  dom.depthSelect.disabled = crawling;
  dom.delaySelect.disabled = crawling;
  dom.sameDomainCheck.disabled = crawling;
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
function updatePagesList() {
  dom.pagesList.innerHTML = '';
  if (state.pageOrder.length === 0) {
    dom.pagesList.innerHTML = '<div class="empty-hint">尚未开始爬取</div>';
    return;
  }
  for (const url of state.pageOrder) {
    const item = document.createElement('div');
    item.className = 'resource-item';
    const depth = state.capturedPages.get(url)?.depth ?? 0;
    item.innerHTML = `
      <span class="type-badge html">PAGE</span>
      <span class="res-path" title="${escapeHtml(url)}">${escapeHtml(truncateUrl(url))}</span>
      <span class="res-size">深度 ${depth}</span>
    `;
    dom.pagesList.appendChild(item);
  }
}

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

  for (const [path, res] of entries) {
    const item = document.createElement('div');
    item.className = 'resource-item';
    item.innerHTML = `
      <span class="type-badge ${res.type}">${res.type}</span>
      <span class="res-path" title="${escapeHtml(path)}">${escapeHtml(path)}</span>
      <span class="res-size">${Utils.formatBytes(res.size)}</span>
    `;
    dom.resourcesList.appendChild(item);
  }
}

function updateHtmlPagesList() {
  dom.htmlPagesList.innerHTML = '';
  if (state.htmlSources.size === 0) {
    dom.htmlPagesList.innerHTML = '<div class="empty-hint">尚未保存HTML页面</div>';
    return;
  }
  for (const [path, html] of state.htmlSources) {
    const item = document.createElement('div');
    item.className = 'resource-item';
    const size = new TextEncoder().encode(html).length;
    item.innerHTML = `
      <span class="type-badge html">HTML</span>
      <span class="res-path" title="${escapeHtml(path)}">${escapeHtml(path)}</span>
      <span class="res-size">${Utils.formatBytes(size)}</span>
    `;
    dom.htmlPagesList.appendChild(item);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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

// ========== 处理捕获的资源 ==========
// 检查URL是否属于目标域名
function isSameDomain(url) {
  try { return new URL(url).host === state.domain; } catch (e) { return false; }
}

function processResources(captured, pageUrl, pageDepth) {
  const addedPaths = [];
  const pagePath = UrlResolver.resolve(pageUrl, 'text/html', null).path;

  // 处理HTML源码
  if (captured.html) {
    const htmlPath = pagePath;
    state.htmlSources.set(htmlPath, captured.html);
    state.htmlPages++;
    addedPaths.push({ path: htmlPath, html: captured.html });

    // 同时作为资源添加
    addToAllResources(htmlPath, captured.html, 'text/html');
  }

  // 处理网络资源
  for (const res of (captured.networkResources || [])) {
    if (!res.url || !res.content) continue;
    if (state.ignoreEmpty && (!res.content || res.content.length === 0)) continue;

    const resolved = UrlResolver.resolve(res.url, res.mimeType, res.content);
    const filePath = resolved.path;

    // 去重：同一文件路径只保留一次
    if (state.staticResourcePaths.has(res.url)) continue;
    state.staticResourcePaths.add(res.url);

    // 仅同域过滤：跳过CDN/统计/第三方域名资源
    if (!isSameDomain(res.url)) continue;

    addToAllResources(filePath, res.content, res.mimeType);
  }

  // 处理静态资源
  for (const res of (captured.staticResources || [])) {
    if (!res.url || !res.content) continue;
    if (state.ignoreEmpty && (!res.content || res.content.length === 0)) continue;

    const resolved = UrlResolver.resolve(res.url, res.mimeType, res.content);
    const filePath = resolved.path;

    if (state.staticResourcePaths.has(res.url)) continue;
    state.staticResourcePaths.add(res.url);

    if (!isSameDomain(res.url)) continue;

    addToAllResources(filePath, res.content, res.mimeType);
  }

  // 保存页面完整数据
  state.capturedPages.set(pageUrl, {
    depth: pageDepth,
    pageInfo: captured.pageInfo,
    html: captured.html,
    resourceCount: (captured.networkResources?.length || 0) + (captured.staticResources?.length || 0)
  });

  if (!state.pageOrder.includes(pageUrl)) {
    state.pageOrder.push(pageUrl);
  }

  return addedPaths;
}

function addToAllResources(filePath, content, mimeType) {
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
    type: type
  });
  state.totalSize += size;
  state.totalResources = state.allResources.size;
}

// ========== 文件美化 ==========
function beautifyContent(content, mimeType) {
  if (!content) return content;
  const mime = (mimeType || '').toLowerCase();

  try {
    if (mime.includes('json') || (typeof content === 'string' &&
        (content.trim().startsWith('{') || content.trim().startsWith('[')))) {
      return JSON.stringify(JSON.parse(content), null, 2);
    }
  } catch (e) {
    // JSON美化失败，返回原文
  }

  // HTML/CSS/JS 简单格式化
  try {
    if (mime.includes('html') || mime.includes('css') || mime.includes('javascript')) {
      return content
        .replace(/></g, '>\n<')
        .replace(/}\s*/g, '}\n')
        .replace(/;\s*/g, ';\n  ');
    }
  } catch (e) {}

  return content;
}

// ========== 主爬取流程 ==========
async function startCrawling() {
  log('收到开始爬取指令...', 'info');

  if (state.isCrawling) {
    log('爬取已在运行中，忽略重复点击', 'warning');
    return;
  }

  // 立即标记运行中并启用停止按钮，确保任何阶段都能点停止
  state.isCrawling = true;
  setButtons(true);

  // 获取参数
    state.crawlDepth = parseInt(dom.depthSelect.value);
    state.crawlDelay = parseInt(dom.delaySelect.value) * 1000;
    state.sameDomainOnly = dom.sameDomainCheck.checked;
    state.beautify = dom.beautifyCheck.checked;
    state.ignoreEmpty = dom.ignoreEmptyCheck.checked;

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
  log('爬取深度: ' + state.crawlDepth + ', 等待时间: ' + (state.crawlDelay / 1000) + 's', 'info');
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
    sameDomainOnly: state.sameDomainOnly
  });

  Crawler.onPageCaptured((data) => {
    log(`页面发现: ${data.url} (深度${data.depth}, 新增${data.addedCount || 0}个链接)`, 'info');
  });

  // 爬取循环
  try {
    while (Crawler.hasMore()) {
      const item = Crawler.next();
      const { url, depth } = item;

      log(`[${state.pagesCrawled + 1}/${state.pagesCrawled + 1 + Crawler.queueSize()}] 导航到: ${url} (深度${depth})`, 'info');
      setStatus(`正在爬取: ${url}`);

      // 清空当前页network记录
      ResourceCapture.clearNetworkEntries();

      // 导航到目标URL
      try {
        await Crawler.navigateTo(url);
      } catch (navErr) {
        log(`导航失败: ${url} - ${navErr.message}`, 'error');
        if (Crawler._stopped) break;
        try { await Crawler.navigateTo(state.startUrl); } catch (e) {}
        continue;
      }
      if (Crawler._stopped) break;

      // 等待网络空闲（连续2s无新请求 或 最长等待时间），确保资源全部加载
      const idleTime = state.crawlDelay;
      const maxWait = state.crawlDelay * 3;
      log(`等待网络空闲 (空闲阈值${idleTime / 1000}s, 最长${maxWait / 1000}s)...`, 'info');
      await ResourceCapture.waitForNetworkIdle(idleTime, maxWait, () => Crawler._stopped);
      if (Crawler._stopped) break;

      // 捕获所有资源
      setStatus(`捕获资源: ${url}`);
      log(`捕获资源中...`, 'info');
      const captured = await ResourceCapture.captureAll();
      if (Crawler._stopped) break;

      if (captured.html) {
        log(`HTML源码: ${captured.html.length} 字符`, 'info');
      }
      log(`网络资源: ${captured.networkResources.length} 个`, 'info');
      log(`静态资源: ${captured.staticResources.length} 个`, 'info');

      // 处理捕获的资源
      processResources(captured, url, depth);
      state.pagesCrawled++;

      // 提取子链接并加入队列
      Crawler.processCapturedPage(url, depth, captured.html);

      // 更新UI
      updateStats();
      setProgress(Math.min(100, Math.round((state.pagesCrawled / (state.pagesCrawled + Crawler.queueSize() + 1)) * 100)));
      updatePagesList();
      updateResourcesList(dom.resourceFilter.value, dom.typeFilter.value === 'all' ? null : dom.typeFilter.value);
      updateHtmlPagesList();
    }

    // 爬取完成
    log('========================================', 'success');
    log('爬取完成! 共爬取 ' + state.pagesCrawled + ' 个页面', 'success');
    log('捕获资源: ' + state.allResources.size + ' 个文件', 'success');
    log('HTML页面: ' + state.htmlSources.size + ' 个', 'success');
    log('总大小: ' + Utils.formatBytes(state.totalSize), 'success');
    log('========================================', 'success');

    // 回到起始页
    try {
      log('返回起始页面...', 'info');
      await Crawler.navigateTo(state.startUrl);
    } catch (e) {}

    setStatus('爬取完成，正在构建ZIP...');
    await buildZip();

  } catch (err) {
    log('爬取出错: ' + err.message, 'error');
    console.error('startCrawling error:', err);
    setStatus('出错: ' + err.message);
  } finally {
    finishCrawl();
  }

// 清理爬取状态（早期返回 + 正常结束共用）
function finishCrawl() {
  state.isCrawling = false;
  ResourceCapture.stopNetworkCapture();
  setButtons(false);
  setProgress(100);
  updateStats();
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
      await buildZip();
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
  state._pendingZip = null;
  state._pendingZipName = '';
  ZipBuilder.init();

  ResourceCapture.stopNetworkCapture();
  setButtons(false);
  setProgress(0);
  setStatus('就绪');
  updateStats();
  dom.pagesList.innerHTML = '<div class="empty-hint">尚未开始爬取</div>';
  dom.resourcesList.innerHTML = '<div class="empty-hint">尚未捕获资源</div>';
  dom.htmlPagesList.innerHTML = '<div class="empty-hint">尚未保存HTML页面</div>';
  dom.downloadSection.style.display = 'none';
  dom.logContainer.innerHTML = '';
  log('已重置', 'info');
}

// ========== ZIP 构建 ==========
async function buildZip() {
  log('正在构建ZIP文件...', 'info');
  setStatus('正在构建ZIP，请稍候...');

  ZipBuilder.init();
  let fileCount = 0;

  // 添加所有资源
  for (const [path, res] of state.allResources) {
    let content = res.content;
    if (state.beautify) {
      content = beautifyContent(content, res.mimeType);
    }
    await ZipBuilder.addFile(path, content, res.mimeType);
    fileCount++;
  }

  // 添加HTML页面
  for (const [path, html] of state.htmlSources) {
    if (!state.allResources.has(path)) {
      await ZipBuilder.addFile(path, html, 'text/html');
      fileCount++;
    }
  }

  const totalSize = ZipBuilder.totalSize();
  log(`ZIP包含 ${fileCount} 个文件, 总大小 ${Utils.formatBytes(totalSize)}`, 'success');

  // 生成ZIP数据，暂存不下载
  const zipData = await ZipBuilder.generate();
  const hostname = state.domain.replace(/[^a-zA-Z0-9.-]/g, '_');
  const filename = `${hostname}_${new Date().toISOString().slice(0, 10)}.zip`;

  // 存储待下载数据
  state._pendingZip = zipData;
  state._pendingZipName = filename;

  // 显示下载按钮
  setStatus('完成! 共 ' + fileCount + ' 个文件, ' + Utils.formatBytes(totalSize));
  log('========================================', 'success');
  log('ZIP已就绪! 点击下方"下载ZIP包"按钮开始下载', 'success');
  log('文件名: ' + filename, 'info');
  log(`文件数: ${fileCount}, 大小: ${Utils.formatBytes(zipData.length)}`, 'info');
  log('========================================', 'success');

  showDownloadButton(filename, zipData.length, fileCount);
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

}

// ========== Tab 信息获取 ==========
// DevTools 面板直接从 inspectedWindow 获取 tabId（最可靠方式）
function getDevToolsTabId() {
  return chrome.devtools.inspectedWindow.tabId;
}

function getTabInfo(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(tab);
    });
  });
}

async function getCurrentPageUrl() {
  return new Promise((resolve) => {
    const tabId = getDevToolsTabId();
    if (!tabId) { resolve(null); return; }
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        resolve(null);
        return;
      }
      resolve(tab.url || null);
    });
  });
}

// ========== 事件监听 ==========
dom.btnStart.addEventListener('click', startCrawling);
dom.btnStop.addEventListener('click', stopCrawling);
dom.btnReset.addEventListener('click', resetAll);

// 资源过滤
dom.resourceFilter.addEventListener('input', Utils.debounce(() => {
  updateResourcesList(dom.resourceFilter.value, dom.typeFilter.value === 'all' ? null : dom.typeFilter.value);
}, 300));

dom.typeFilter.addEventListener('change', () => {
  updateResourcesList(dom.resourceFilter.value, dom.typeFilter.value === 'all' ? null : dom.typeFilter.value);
});

// ========== 初始化 ==========
async function init() {
  log('WebMirror v1.0 启动', 'info');
  log('网站镜像工具 - 递归爬取 + 网络捕获 + HTML源码', 'info');
  log('数据源: DevTools Network API + inspectedWindow + HTML源码', 'info');

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
  log('就绪 - 设置爬取参数后点击"开始爬取"', 'info');
}

init();
})();
