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
          content = await new Promise((resolve, reject) => {
            entry.getContent((content, encoding) => {
              if (chrome.runtime.lastError) {
                resolve(null);
                return;
              }
              resolve({ content, encoding });
            });
          });
        } catch (e) {
          content = null;
        }

        resources.push({
          url,
          mimeType,
          status,
          content: content?.content || '',
          encoding: content?.encoding || 'utf-8',
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
        content = await new Promise((resolve) => {
          res.getContent((content, encoding) => {
            resolve({ content, encoding });
          });
        });

        resources.push({
          url: res.url,
          mimeType: res.type || '',
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
  async captureHTML() {
    return new Promise((resolve) => {
      chrome.devtools.inspectedWindow.eval(
        'document.documentElement.outerHTML',
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
    const pageInfo = await this.capturePageInfo();
    const html = await this.captureHTML();
    const networkRes = await this.extractNetworkResources();
    const staticRes = await this.extractStaticResources();

    return {
      pageInfo,
      html,
      networkResources: networkRes,
      staticResources: staticRes
    };
  },

  // 等待网络空闲（一段时间内无新请求），确保资源加载完整
  // stopSignal: 可选回调，返回true时立即中止等待
  async waitForNetworkIdle(idleTime = 2000, maxWait = 15000, stopSignal) {
    return new Promise((resolve) => {
      let lastRequestTime = Date.now();
      let settled = false;

      const onRequest = () => { lastRequestTime = Date.now(); };
      chrome.devtools.network.onRequestFinished.addListener(onRequest);

      const check = () => {
        if (settled) return;
        // 检查停止信号
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
          setTimeout(check, 500);
        }
      };

      const startTime = Date.now();
      setTimeout(check, 500);
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
