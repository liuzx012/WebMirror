// lib/crawler.js — 递归页面爬虫
// 从HTML中提取链接，BFS遍历子页面触发更多资源加载

const Crawler = {
  _visited: new Set(),
  _queue: [],
  _domain: '',
  _maxDepth: 2,
  _tabId: null,
  _stopped: false,
  _onProgress: null,
  _onPageCaptured: null,

  // 从HTML中提取同域链接
  extractLinks(html, baseUrl) {
    if (!html) return [];
    const links = new Set();
    const domain = Utils.getHost(baseUrl);

    // 使用正则提取所有href
    const hrefPattern = /href=["']([^"']+)["']/gi;
    let match;
    while ((match = hrefPattern.exec(html)) !== null) {
      const href = match[1];
      try {
        const resolved = new URL(href, baseUrl);
        // 只保留同域、http/https的链接
        if ((resolved.protocol === 'http:' || resolved.protocol === 'https:') &&
            resolved.host === domain) {
          // 标准化URL：去hash、去query、去尾部斜杠，避免重复爬取
          resolved.hash = '';
          resolved.search = '';  // 去掉查询参数，/?p=1 和 /?p=2 视为同一页面
          let normalized = resolved.href;
          if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
          // 过滤非HTML资源链接
          const path = resolved.pathname.toLowerCase();
          if (!/\.(png|jpg|jpeg|bmp|gif|webp|ico|woff|woff2|ttf|otf|eot|mp4|mp3|wav|webm)(\?|$)/.test(path)) {
            links.add(normalized);
          }
        }
      } catch (e) {
        // 无效URL跳过
      }
    }

    // 同样检查src属性中的链接（iframe等）
    const srcPattern = /src=["']([^"']+)["']/gi;
    while ((match = srcPattern.exec(html)) !== null) {
      try {
        const resolved = new URL(match[1], baseUrl);
        if ((resolved.protocol === 'http:' || resolved.protocol === 'https:') &&
            resolved.host === domain) {
          resolved.hash = '';
          resolved.search = '';
          let normalized2 = resolved.href;
          if (normalized2.endsWith('/')) normalized2 = normalized2.slice(0, -1);
          const path = resolved.pathname.toLowerCase();
          if (!/\.(png|jpg|jpeg|bmp|gif|webp|ico|woff|woff2|ttf|otf|eot|mp4|mp3|wav|webm)(\?|$)/.test(path)) {
            links.add(normalized2);
          }
        }
      } catch (e) {}
    }

    return [...links];
  },

  // 初始化爬虫
  init(startUrl, options = {}) {
    this._visited = new Set();
    this._queue = [];
    this._domain = Utils.getHost(startUrl);
    this._maxDepth = options.maxDepth ?? 2;
    this._tabId = options.tabId;
    this._stopped = false;
    this._sameDomainOnly = options.sameDomainOnly !== false;

    // 起始URL入队
    this._queue.push({ url: startUrl, depth: 0 });
    this._visited.add(startUrl);
  },

  // 设置回调
  onProgress(cb) { this._onProgress = cb; },
  onPageCaptured(cb) { this._onPageCaptured = cb; },

  // 停止爬虫
  stop() {
    this._stopped = true;
  },

  // 是否有待爬URL
  hasMore() {
    return this._queue.length > 0 && !this._stopped;
  },

  // 获取下一个URL
  next() {
    return this._queue.shift();
  },

  // 获取队列长度
  queueSize() {
    return this._queue.length;
  },

  // 已访问数量
  visitedCount() {
    return this._visited.size;
  },

  // 处理捕获到的页面，提取新链接
  processCapturedPage(url, depth, html) {
    if (this._stopped) return;

    if (this._onPageCaptured) {
      this._onPageCaptured({ url, depth, linkCount: 0 });
    }

    // 如未达最大深度，提取子链接
    if (depth < this._maxDepth && html) {
      const links = this.extractLinks(html, url);

      let addedCount = 0;
      for (const link of links) {
        if (!this._visited.has(link)) {
          this._visited.add(link);
          this._queue.push({ url: link, depth: depth + 1 });
          addedCount++;
        }
      }

      if (this._onPageCaptured) {
        this._onPageCaptured({ url, depth, linkCount: links.length, addedCount });
      }
    }
  },

  // 导航到指定URL
  async navigateTo(url) {
    if (!this._tabId) throw new Error('Tab ID not set');

    return new Promise((resolve, reject) => {
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('Navigation timeout'));
      }, 30000);

      const listener = (tabId, changeInfo) => {
        if (tabId === this._tabId && changeInfo.status === 'complete') {
          if (settled) return;
          settled = true;
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timeout);
          resolve();
        }
      };

      // 每500ms检查停止信号
      const stopChecker = setInterval(() => {
        if (this._stopped) {
          if (settled) return;
          settled = true;
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timeout);
          clearInterval(stopChecker);
          reject(new Error('Stopped by user'));
        }
      }, 500);

      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs.update(this._tabId, { url }, (tab) => {
        if (chrome.runtime.lastError) {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timeout);
          clearInterval(stopChecker);
          reject(new Error(chrome.runtime.lastError.message));
        }
      });
    });
  }
};
