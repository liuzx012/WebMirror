// lib/resource-capture.js — 资源捕获模块
// 通过 DevTools API 捕获网络请求、静态资源和HTML源码

const ResourceCapture = {

  _networkEntries: [],
  _staticResources: [],
  _htmlSources: {},
  _capturingNetwork: false,
  _onRequestFinished: null,

  // 初始化网络监听
  initNetworkCapture() {
    // 支持重复初始化：先移除旧监听，避免异常重启后同一请求被记录多次
    this.stopNetworkCapture();
    this._networkEntries = [];
    this._onRequestFinished = (request) => {
      this._networkEntries.push(request);
      this._notifyListeners('network', request);
    };
    chrome.devtools.network.onRequestFinished.addListener(this._onRequestFinished);
    this._capturingNetwork = true;
  },

  // 停止网络监听
  stopNetworkCapture() {
    if (this._onRequestFinished) {
      chrome.devtools.network.onRequestFinished.removeListener(this._onRequestFinished);
      this._onRequestFinished = null;
    }
    this._capturingNetwork = false;
  },

  // 获取当前已捕获的网络请求
  getNetworkEntries() {
    return [...this._networkEntries];
  },

  // 清空网络请求记录（每次页面导航后调用）
  clearNetworkEntries() {
    this._networkEntries = [];
  },

  // 通过getHAR获取完整的HAR日志
  async getHAR() {
    return new Promise((resolve) => {
      chrome.devtools.network.getHAR((harLog) => {
        resolve(harLog);
      });
    });
  },

  // 带超时的 getContent（防止错误页面挂住）
  _getContentWithTimeout(entry, timeoutMs = 8000) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; resolve(null); }
      }, timeoutMs);
      try {
        entry.getContent((content, encoding) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(content != null ? { content, encoding } : null);
        });
      } catch (e) {
        if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
      }
    });
  },

  // 提取当前页面的网络资源（含响应体）
  // 返回 [{url, path, content, mimeType, size, status}]
  async extractNetworkResources() {
    const entries = this._networkEntries;
    const resources = [];

    for (const entry of entries) {
      try {
        const url = entry.request.url;
        // 跳过data:和特殊协议
        if (url.startsWith('data:') || url.startsWith('chrome-extension://') ||
            url.startsWith('debugger:') || url.startsWith('ws:') || url.startsWith('wss:')) {
          continue;
        }

        const mimeType = entry.response?.content?.mimeType || '';
        const status = entry.response?.status || 0;

        // 只捕获成功响应和缓存命中
        if (status !== 200 && status !== 304 && status !== 0) continue;

        let content;
        try {
          content = await this._getContentWithTimeout(entry);
        } catch (e) {
          content = null;
        }
        // 拿不到内容则跳过（status===0 的取消/阻断请求、空响应等不再产生空资源项）
        if (!content || content.content == null || content.content === '') continue;

        resources.push({
          url,
          mimeType,
          status,
          content: content.content,
          encoding: content.encoding || 'utf-8',
          size: entry.response?.content?.size || entry.response?.bodySize || 0,
          requestHeaders: entry.request?.headers || [],
          responseHeaders: entry.response?.headers || []
        });
      } catch (e) {
        // 跳过无法获取内容的请求
      }
    }

    return resources;
  },

  // 通过inspectedWindow获取静态资源
  async getStaticResources() {
    return new Promise((resolve) => {
      chrome.devtools.inspectedWindow.getResources((resources) => {
        if (chrome.runtime.lastError) {
          resolve([]);
          return;
        }
        resolve(resources.filter(r => r.type !== 'document' && r.type !== 'xhr' && r.type !== 'fetch'));
      });
    });
  },

  // 提取静态资源内容
  async extractStaticResources() {
    const staticRes = await this.getStaticResources();
    const resources = [];

    for (const res of staticRes) {
      try {
        let content = null;
        content = await this._getContentWithTimeout(res);

        resources.push({
          url: res.url,
          mimeType: _devtoolsTypeToMime(res.type),
          content: content?.content || '',
          encoding: content?.encoding || 'utf-8',
          size: content?.content?.length || 0
        });
      } catch (e) {
        // 跳过无内容的资源
      }
    }

    return resources;
  },

  // 捕获当前页面的HTML源码（JS执行后的完整DOM）
  // 修复6: 递归捕获同域 iframe 内容（跨域 iframe 浏览器策略禁止访问，静默跳过）
  // 最多递归 3 层，防 iframe 套娃导致无限递归
  async captureHTML() {
    return new Promise((resolve) => {
      chrome.devtools.inspectedWindow.eval(
        `(function() {
          var MAX_DEPTH = 3;
          // 递归收集 doc 及其内部同域 iframe 的 outerHTML
          function collect(doc, depth, idx) {
            if (!doc || !doc.documentElement || depth > MAX_DEPTH) return '';
            var part = '';
            try { part = doc.documentElement.outerHTML; } catch(e) { return ''; }
            var iframes = doc.querySelectorAll('iframe');
            for (var i = 0; i < iframes.length; i++) {
              try {
                var innerDoc = iframes[i].contentDocument || (iframes[i].contentWindow && iframes[i].contentWindow.document);
                if (innerDoc) {
                  var label = depth === 0 ? 'IFRAME[' + i + ']' : 'IFRAME[d' + depth + '-' + idx + '-' + i + ']';
                  var sub = collect(innerDoc, depth + 1, i);
                  if (sub) part += '\\n<!-- ' + label + ' ' + (iframes[i].src || '') + ' -->\\n' + sub;
                }
              } catch (e) {
                // 跨域 iframe 抛 SecurityError，静默跳过
              }
            }
            return part;
          }
          return collect(document, 0, 0);
        })()`,
        (result, isException) => {
          if (isException || chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(result);
        }
      );
    });
  },

  // 自动滚动触发懒加载（修复5）
  // 渐进 scrollTo 遍历页面，触发 IntersectionObserver 等懒加载机制
  // 最多滚动 30 步（防无限长页面卡死），每步 150ms，滚完回到顶部
  async autoScroll() {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; resolve(); }
      }, 8000);
      try {
        chrome.devtools.inspectedWindow.eval(
          `(function() {
            return new Promise(function(resolve) {
              try {
                var total = document.body ? document.body.scrollHeight : 0;
                var pos = 0, step = 600, count = 0;
                function scroll() {
                  pos += step;
                  window.scrollTo(0, pos);
                  count++;
                  if (pos < total && count < 30) {
                    setTimeout(scroll, 150);
                  } else {
                    window.scrollTo(0, 0);
                    resolve();
                  }
                }
                if (total > window.innerHeight) { scroll(); }
                else { resolve(); }
              } catch (e) { resolve(); }
            });
          })()`,
          (result, isException) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        );
      } catch (e) {
        if (!settled) { settled = true; clearTimeout(timer); resolve(); }
      }
    });
  },

  // 捕获当前页面的标题和URL
  async capturePageInfo() {
    return new Promise((resolve) => {
      chrome.devtools.inspectedWindow.eval(
        `JSON.stringify({
          title: document.title,
          url: location.href,
          doctype: document.doctype ? document.doctype.name : ''
        })`,
        (result, isException) => {
          if (isException || !result) {
            resolve({ title: '', url: '', doctype: '' });
            return;
          }
          try { resolve(JSON.parse(result)); } catch (e) { resolve({ title: '', url: '', doctype: '' }); }
        }
      );
    });
  },

  // 完整捕获：网络资源 + 静态资源 + HTML源码
  async captureAll() {
    // 四个数据源彼此独立，并行读取可显著缩短资源较多页面的捕获时间
    const [pageInfo, html, networkRes, staticRes] = await Promise.all([
      this.capturePageInfo(),
      this.captureHTML(),
      this.extractNetworkResources(),
      this.extractStaticResources()
    ]);

    return {
      pageInfo,
      html,
      networkResources: networkRes,
      staticResources: staticRes
    };
  },

  // 等待网络空闲（一段时间内无新请求），确保资源加载完整
  // stopSignal: 可选回调，返回true时立即中止等待
  async waitForNetworkIdle(idleTime = 300, maxWait = 3000, stopSignal) {
    return new Promise((resolve) => {
      let lastRequestTime = Date.now();
      let settled = false;

      const onRequest = () => { lastRequestTime = Date.now(); };
      chrome.devtools.network.onRequestFinished.addListener(onRequest);

      const check = () => {
        if (settled) return;
        if (stopSignal && stopSignal()) {
          settled = true;
          chrome.devtools.network.onRequestFinished.removeListener(onRequest);
          resolve();
          return;
        }
        const elapsed = Date.now() - lastRequestTime;
        const total = Date.now() - startTime;
        if (elapsed >= idleTime || total >= maxWait) {
          settled = true;
          chrome.devtools.network.onRequestFinished.removeListener(onRequest);
          resolve();
        } else {
          setTimeout(check, 200);
        }
      };

      const startTime = Date.now();
      setTimeout(check, 200);
    });
  },

  // 监听器管理
  _listeners: [],
  addListener(fn) {
    this._listeners.push(fn);
  },
  removeListener(fn) {
    this._listeners = this._listeners.filter(f => f !== fn);
  },
  _notifyListeners(type, data) {
    this._listeners.forEach(fn => {
      try { fn(type, data); } catch (e) {}
    });
  }
};

// DevTools Resource.type → MIME 映射
function _devtoolsTypeToMime(type) {
  const map = {
    'script': 'application/javascript',
    'stylesheet': 'text/css',
    'image': 'image/png',
    'font': 'font/woff2',
    'document': 'text/html',
    'xhr': 'application/json',
    'fetch': 'application/json',
    'media': 'video/mp4',
    'manifest': 'application/json',
    'other': 'application/octet-stream',
  };
  return map[type] || type || 'application/octet-stream';
}
