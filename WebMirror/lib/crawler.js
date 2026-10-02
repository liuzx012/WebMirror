// lib/crawler.js — 递归页面爬虫
// 从HTML中提取链接，BFS遍历子页面触发更多资源加载
//
// 修复1: DOM API 提链（主通道）+ 正则提链（兜底），覆盖动态渲染/无引号/data-url
// 修复2: query 按参数名签名去重（保留 query，按参数名组合签名）
// 修复4: eTLD 同主域过滤（最后两段）

const Crawler = {
  _visited: new Set(),       // 存放「URL 签名 key」（去 query 值后的 path+参数名签名）
  _queue: [],
  _queueHead: 0,             // 队头游标，避免 Array.shift() 在大队列下反复搬移元素
  _domain: '',
  _maxDepth: 2,
  _tabId: null,
  _stopped: false,
  _onProgress: null,
  _onPageCaptured: null,

  // 链接提取选项（由 init 注入）
  _keepQuery: true,          // 保留 query（按参数名签名去重）
  _sameDomainOnly: true,     // 是否限制同域，由面板选项注入
  _isSameDomainFn: null,     // 同域判断函数（host => bool），由 panel.js 注入（含 eTLD 逻辑）
  _blacklistCheckFn: null,   // 黑名单判断函数（url => bool），由 panel.js 注入（PassiveMonitor._isBlacklisted）

  // 非页面资源后缀（不作为爬取目标）
  _staticExtRegex: /\.(png|jpg|jpeg|bmp|gif|webp|ico|woff|woff2|ttf|otf|eot|mp4|mp3|wav|webm|pdf|zip|gz|tar|rar|7z|exe|dll|doc|docx|xls|xlsx)(\?|$)/i,

  // ========== URL 签名（去重 key）==========
  // keepQuery=false: 去 query，返回 origin+path
  // keepQuery=true:  保留 query 但按「参数名排序签名」去重（/list?id=1 与 ?id=2 同签名）
  _normalizeUrl(rawUrl) {
    let u;
    try { u = new URL(rawUrl); } catch (e) { return rawUrl; }
    u.hash = '';
    if (!this._keepQuery) {
      u.search = '';
      let n = u.href;
      if (n.endsWith('/')) n = n.slice(0, -1);
      return n;
    }
    // 保留 query：签名 = origin+path + '|' + 参数名排序
    const paramNames = [...new Set([...u.searchParams.keys()])].sort().join(',');
    let path = u.pathname;
    if (path.endsWith('/') && path.length > 1) path = path.slice(0, -1);
    return u.origin + path + '|' + paramNames;
  },

  // ========== 同域判断（委托给注入的函数，含 eTLD 逻辑）==========
  _isSameDomain(host) {
    if (this._isSameDomainFn) return this._isSameDomainFn(host);
    return host === this._domain;
  },

  // ========== DOM API 提链（主通道，修复1）==========
  // 在页面上下文执行 querySelectorAll，提取真实渲染后的链接
  // 提取: a[href] / [src] / form[action] / [data-url] / [data-href]
  async extractLinksFromDOM(baseUrl) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve([]), 8000);
      try {
        chrome.devtools.inspectedWindow.eval(`(function(){
          try {
            var links = new Set();
            var nodes;
            // a[href]
            nodes = document.querySelectorAll('a[href]');
            for (var i = 0; i < nodes.length; i++) links.add(nodes[i].getAttribute('href'));
            // [src]
            nodes = document.querySelectorAll('[src]');
            for (var j = 0; j < nodes.length; j++) links.add(nodes[j].getAttribute('src'));
            // form[action]
            nodes = document.querySelectorAll('form[action]');
            for (var k = 0; k < nodes.length; k++) links.add(nodes[k].getAttribute('action'));
            // [data-url] [data-href]
            nodes = document.querySelectorAll('[data-url],[data-href]');
            for (var m = 0; m < nodes.length; m++) {
              links.add(nodes[m].getAttribute('data-url'));
              links.add(nodes[m].getAttribute('data-href'));
            }
            var arr = [];
            links.forEach(function(v){ if (v) arr.push(v); });
            return JSON.stringify(arr);
          } catch(e) { return JSON.stringify([]); }
        })()`, (result, isException) => {
          clearTimeout(timer);
          if (isException || !result) { resolve([]); return; }
          try {
            const arr = JSON.parse(result);
            resolve(this._filterLinks(arr, baseUrl));
          } catch (e) { resolve([]); }
        });
      } catch (e) {
        clearTimeout(timer);
        resolve([]);
      }
    });
  },

  // ========== 正则提链（兜底，修复1 保留）==========
  // 从HTML字符串提取 href/src，作为 DOM 提链的补充（处理 iframe 内嵌、动态未渲染等）
  extractLinks(html, baseUrl) {
    if (!html) return [];
    const rawLinks = [];
    // href
    let match;
    const hrefPattern = /href=["']([^"']+)["']/gi;
    while ((match = hrefPattern.exec(html)) !== null) rawLinks.push(match[1]);
    // src
    const srcPattern = /src=["']([^"']+)["']/gi;
    while ((match = srcPattern.exec(html)) !== null) rawLinks.push(match[1]);
    return this._filterLinks(rawLinks, baseUrl);
  },

  // ========== 链接过滤（同域 + 协议 + 去静态资源）==========
  // 输入原始 href/src 数组，输出规范化后的完整 URL 数组
  _filterLinks(rawLinks, baseUrl) {
    const out = new Set();
    for (const href of rawLinks) {
      if (!href) continue;
      // 跳过 javascript: mailto: tel: # 等
      if (/^(javascript|mailto|tel|blob|data|about|chrome|file):/i.test(href)) continue;
      if (href.startsWith('#')) continue;
      try {
        const resolved = new URL(href, baseUrl);
        // 只保留 http/https
        if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
        // 同域过滤（含 eTLD）
        if (this._sameDomainOnly && !this._isSameDomain(resolved.host)) continue;
        // 过滤静态资源
        if (this._staticExtRegex.test(resolved.pathname.toLowerCase())) continue;
        // 黑名单拦截：delete/logout 等危险接口不爬取（直接跳过，不入队也不导航）
        if (this._blacklistCheckFn && this._blacklistCheckFn(resolved.href)) continue;
        out.add(resolved.href);
      } catch (e) {
        // 无效URL跳过
      }
    }
    return [...out];
  },

  // 初始化爬虫
  init(startUrl, options = {}) {
    this._visited = new Set();
    this._queue = [];
    this._queueHead = 0;
    this._domain = Utils.getHost(startUrl);
    this._maxDepth = options.maxDepth ?? 2;
    this._tabId = options.tabId;
    this._stopped = false;
    this._keepQuery = options.keepQuery !== false;        // 默认保留 query
    this._sameDomainOnly = options.sameDomainOnly !== false;
    this._isSameDomainFn = options.isSameDomainFn || null; // eTLD 判断函数
    this._blacklistCheckFn = options.blacklistCheckFn || null; // 黑名单判断（url => bool）

    // 起始URL入队（用签名做去重）
    this._queue.push({ url: startUrl, depth: 0 });
    this._visited.add(this._normalizeUrl(startUrl));
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
    return this._queueHead < this._queue.length && !this._stopped;
  },

  // 获取下一个URL
  next() {
    if (this._queueHead >= this._queue.length) return undefined;
    const item = this._queue[this._queueHead++];
    // 定期压缩已消费区间，兼顾 O(1) 出队与长任务内存占用
    if (this._queueHead >= 1024 && this._queueHead * 2 >= this._queue.length) {
      this._queue = this._queue.slice(this._queueHead);
      this._queueHead = 0;
    }
    return item;
  },

  // 获取队列长度
  queueSize() {
    return Math.max(0, this._queue.length - this._queueHead);
  },

  // 已访问数量
  visitedCount() {
    return this._visited.size;
  },

  // 处理捕获到的页面，提取新链接（异步，DOM 提链为主，正则为辅）
  async processCapturedPage(url, depth, html) {
    if (this._stopped) return;

    // 如未达最大深度，提取子链接
    if (depth < this._maxDepth) {
      // 主通道：DOM 提链（真实渲染后的链接）
      const domLinks = await this.extractLinksFromDOM(url);
      // 兜底通道：正则提链（处理 iframe 内嵌等 DOM 未覆盖的）
      const regexLinks = html ? this.extractLinks(html, url) : [];
      // 合并去重
      const allLinks = [...new Set([...domLinks, ...regexLinks])];

      let addedCount = 0;
      for (const link of allLinks) {
        const sig = this._normalizeUrl(link);
        if (!this._visited.has(sig)) {
          this._visited.add(sig);
          this._queue.push({ url: link, depth: depth + 1 });
          addedCount++;
        }
      }

      if (this._onPageCaptured) {
        this._onPageCaptured({ url, depth, linkCount: allLinks.length, addedCount });
      }
    } else if (this._onPageCaptured) {
      // 达到最大深度，不再提链，仅通知一次
      this._onPageCaptured({ url, depth, linkCount: 0, addedCount: 0 });
    }
  },

  // 导航到指定URL（含 SW 断连重试）
  async navigateTo(url) {
    if (!this._tabId) throw new Error('Tab ID not set');

    const doNavigate = () => new Promise((resolve, reject) => {
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        chrome.tabs.onUpdated.removeListener(listener);
        clearInterval(stopChecker);
        reject(new Error('Navigation timeout'));
      }, 30000);

      const listener = (tabId, changeInfo) => {
        if (tabId === this._tabId && changeInfo.status === 'complete') {
          if (settled) return;
          settled = true;
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timeout);
          clearInterval(stopChecker);
          chrome.tabs.get(this._tabId, (tab) => {
            if (chrome.runtime.lastError) {
              resolve({ finalUrl: url }); // SW 断了但导航已完成，用原始 url
            } else {
              resolve({ finalUrl: (tab && tab.url) ? tab.url : url });
            }
          });
        }
      };

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

    // 尝试导航，遇到 SW 断连则唤醒后重试一次
    try {
      return await doNavigate();
    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('Extension context invalidated')) {
        // SW 已断连，尝试 ping 唤醒
        try {
          await new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: 'ping' }, (resp) => {
              if (chrome.runtime.lastError) {
                // SW 彻底死了，等一下让它从磁盘启动
                setTimeout(resolve, 1500);
              } else {
                resolve(null);
              }
            });
          });
        } catch (e) { /* ignore */ }
        // 额外等待确保 SW 就绪
        await new Promise(r => setTimeout(r, 500));
        // 重试
        return await doNavigate();
      }
      throw err;
    }
  },

  // ========== 断点续爬（修复9）==========
  // 持久化已访问 URL 签名集合到 chrome.storage.local（不存内容，体积小）
  // 崩溃/关闭 DevTools 后，下次 init 可恢复，避免重复爬已爬页面

  // 保存进度（每 N 页调用一次）
  saveProgress(meta) {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
      const data = {
        visited: [...this._visited],   // 已访问签名集合
        domain: this._domain,
        keepQuery: this._keepQuery,
        ts: Date.now(),
        meta: meta || {}               // startUrl / depth 等附加信息
      };
      chrome.storage.local.set({ webmirror_progress: data }, () => {
        if (chrome.runtime.lastError) {
          console.warn('Crawler: 进度持久化失败', chrome.runtime.lastError);
        }
      });
    } catch (e) {
      // storage 不可用时静默降级
    }
  },

  // 加载进度（恢复 _visited）
  loadProgress() {
    return new Promise((resolve) => {
      try {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
          resolve(null); return;
        }
        chrome.storage.local.get(['webmirror_progress'], (result) => {
          if (chrome.runtime.lastError || !result || !result.webmirror_progress) {
            resolve(null); return;
          }
          const p = result.webmirror_progress;
          // 域名或 keepQuery 配置不匹配则视为过期进度，不恢复
          // （keepQuery 不同会导致签名格式不一致，恢复后去重失效）
          if (!p.visited || !Array.isArray(p.visited) || p.domain !== this._domain ||
              !!p.keepQuery !== !!this._keepQuery) {
            resolve(null); return;
          }
          // 恢复 _visited 签名集合
          for (const sig of p.visited) this._visited.add(sig);
          resolve(p);
        });
      } catch (e) {
        resolve(null);
      }
    });
  },

  // 清除进度（爬取正常结束 / reset 时调用）
  clearProgress() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.remove(['webmirror_progress'], () => {
        if (chrome.runtime.lastError) {
          console.warn('Crawler: 进度清除失败', chrome.runtime.lastError);
        }
      });
    } catch (e) {}
  }
};
