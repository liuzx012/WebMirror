// lib/webpack-extractor.js — Webpack 资源深度提取（增强版）
// 融合 Webpack_extract-master 的全面 chunk 枚举能力
// 1. 从 webpack 运行时穷举所有 chunk（不限于已加载的）
// 2. Linkfinder 正则从 JS 中提取所有 URL
// 3. 解析 sourcemap 拉取源文件
// 4. 批量下载所有 chunk

const WebpackExtractor = {

  _fetchedUrls: new Set(),
  _chunkManifest: [], // 穷举出的所有 chunk URL

  // ========== 提取映射（增强版）==========
  async extractFromPage(logFn) {
    const log = logFn || (() => {});
    const discovered = new Map();

    // Phase 1: 全面扫描 JS/CSS → 找 sourceMappingURL + 返回内容
    log('Phase 1: 扫描所有 JS/CSS 资源...');
    const { maps, sources, jsContents, fetchedUrls } = await this._scanAllWithContent();
    // 标记扫描过的 URL 避免重复下载
    if (fetchedUrls) fetchedUrls.forEach(u => this._fetchedUrls.add(u));
    log(maps.length + ' 个 sourcemap, ' + sources.length + ' 个源文件引用');

    // Phase 2: Linkfinder 提取所有 JS 中的 URL
    log('Phase 2: Linkfinder 提取 JS 中的 URL...');
    let allExtractedUrls = [];
    for (const { url, text } of jsContents) {
      const extracted = this._linkfinderExtract(text, url);
      allExtractedUrls = allExtractedUrls.concat(extracted);
    }
    const uniqueUrls = [...new Set(allExtractedUrls)];
    log('Linkfinder 提取: ' + uniqueUrls.length + ' 个 URL');

    // Phase 3: 穷举 webpack 运行时所有 chunk
    log('Phase 3: 穷举 Webpack chunk...');
    const chunkInfo = await this._enumerateChunksFromRuntime();
    this._chunkManifest = chunkInfo.chunks || [];
    log('穷举到 ' + this._chunkManifest.length + ' 个 chunk');

    // Phase 4: 拉取 sourcemap 文件
    for (const url of maps) {
      if (this._fetchedUrls.has(url)) continue;
      this._fetchedUrls.add(url);
      const c = await this._xhrGet(url);
      if (c) discovered.set(url, c);
    }

    // Phase 5: 拉取 sourcemap 中的源文件
    const pending = sources.filter(u => !discovered.has(u));
    for (let i = 0; i < pending.length; i += 8) {
      const batch = pending.slice(i, i + 8);
      const results = await Promise.all(batch.map(u => {
        if (this._fetchedUrls.has(u)) return null;
        this._fetchedUrls.add(u);
        return this._xhrGet(u);
      }));
      for (let j = 0; j < batch.length; j++) {
        if (results[j]) discovered.set(batch[j], results[j]);
      }
    }

    // Phase 6: 拉取所有 webpack chunk + Linkfinder 提取的 JS/CSS URL
    const chunkUrls = this._chunkManifest.filter(u => !discovered.has(u));
    const extractedResUrls = uniqueUrls.filter(u => {
      try {
        const p = new URL(u).pathname.toLowerCase();
        return /\.(js|css|json|xml|svg|map)(\?|$)/i.test(p);
      } catch (e) { return false; }
    });
    const combinedUrls = [...new Set([...chunkUrls, ...extractedResUrls])];
    log('拉取 ' + combinedUrls.length + ' 个资源 (chunk + Linkfinder)...');
    for (let i = 0; i < combinedUrls.length; i += 8) {
      const batch = combinedUrls.slice(i, i + 8);
      const results = await Promise.all(batch.map(u => {
        if (this._fetchedUrls.has(u)) return null;
        this._fetchedUrls.add(u);
        return this._xhrGet(u);
      }));
      for (let j = 0; j < batch.length; j++) {
        if (results[j]) discovered.set(batch[j], results[j]);
      }
    }

    const resources = [];
    for (const [url, c] of discovered) {
      resources.push({ url, content: c.content, mimeType: c.mimeType });
    }
    log('完成: ' + resources.length + ' 个资源（含 sourcemap 源文件 + Linkfinder 提取）');
    return resources;
  },

  // ========== 一键下载所有 Webpack Chunk（仿 Webpack_extract）==========
  async downloadAllChunks(logFn) {
    const log = logFn || (() => {});
    const discovered = new Map();

    // Step 1: 扫描已加载 JS 内容，用 Linkfinder 提取所有 URL
    log('扫描已加载 JS/CSS 并提取 URL...');
    const { maps, sources, jsContents, fetchedUrls } = await this._scanAllWithContent();
    if (fetchedUrls) fetchedUrls.forEach(u => this._fetchedUrls.add(u));
    log('找到 ' + maps.length + ' 个 sourcemap, ' + sources.length + ' 个源文件');

    // Linkfinder: 从每个 JS 内容中提取 URL
    const linkfinderUrls = [];
    for (const { url, text } of jsContents) {
      const extracted = this._linkfinderExtract(text, url);
      linkfinderUrls.push(...extracted);
    }
    const uniqueLinkfinderUrls = [...new Set(linkfinderUrls)];
    log('Linkfinder 提取: ' + uniqueLinkfinderUrls.length + ' 个 URL');

    // Step 2: 穷举 webpack chunk
    log('穷举 Webpack chunk...');
    const chunkInfo = await this._enumerateChunksFromRuntime();
    this._chunkManifest = chunkInfo.chunks || [];
    log('穷举到 ' + this._chunkManifest.length + ' 个 chunk');

    // Step 3: 合并所有待下载 URL
    let allUrls = [...this._chunkManifest];
    allUrls = allUrls.concat(maps.filter(u => !allUrls.includes(u)));
    allUrls = allUrls.concat(sources.filter(u => !allUrls.includes(u)));
    // 只保留 JS/CSS/JSON/map 等资源类型的 Linkfinder URL
    const linkfinderResUrls = uniqueLinkfinderUrls.filter(u => {
      try {
        const p = new URL(u).pathname.toLowerCase();
        return /\.(js|css|json|xml|svg|map|woff2?|ttf|png|jpg|jpeg|gif|webp)(\?|$)/i.test(p) || p.length > 4;
      } catch(e) { return false; }
    });
    allUrls = allUrls.concat(linkfinderResUrls.filter(u => !allUrls.includes(u)));

    log('共 ' + allUrls.length + ' 个资源待下载');

    // Step 4: 分批下载
    for (let i = 0; i < allUrls.length; i += 8) {
      const batch = allUrls.slice(i, i + 8);
      const results = await Promise.all(batch.map(u => {
        if (this._fetchedUrls.has(u)) return null;
        this._fetchedUrls.add(u);
        return this._xhrGet(u);
      }));
      for (let j = 0; j < batch.length; j++) {
        if (results[j]) discovered.set(batch[j], results[j]);
      }
      log('下载进度: ' + Math.min(i + 8, allUrls.length) + '/' + allUrls.length);
    }

    const resources = [];
    for (const [url, c] of discovered) {
      resources.push({ url, content: c.content, mimeType: c.mimeType });
    }
    log('下载完成: ' + resources.length + ' 个 chunk');
    return resources;
  },

  // ========== 获取已穷举的 chunk URL 列表 ==========
  getChunkManifest() {
    return [...this._chunkManifest];
  },

  // ========== 仅下载已知的 chunk manifest（不再重新扫描）==========
  async downloadKnownChunks(logFn) {
    const log = logFn || (() => {});
    const discovered = new Map();

    if (this._chunkManifest.length === 0) {
      log('Chunk 清单为空，先扫描...');
      return this.downloadAllChunks(logFn);
    }

    log('使用已有 Chunk 清单: ' + this._chunkManifest.length + ' 个');
    const allUrls = [...this._chunkManifest];

    for (let i = 0; i < allUrls.length; i += 8) {
      const batch = allUrls.slice(i, i + 8);
      const results = await Promise.all(batch.map(u => {
        if (this._fetchedUrls.has(u)) return null;
        this._fetchedUrls.add(u);
        return this._xhrGet(u);
      }));
      for (let j = 0; j < batch.length; j++) {
        if (results[j]) discovered.set(batch[j], results[j]);
      }
      if (allUrls.length > 50) {
        log('下载进度: ' + Math.min(i + 8, allUrls.length) + '/' + allUrls.length);
      }
    }

    const resources = [];
    for (const [url, c] of discovered) {
      resources.push({ url, content: c.content, mimeType: c.mimeType });
    }
    log('Chunk 下载完成: ' + resources.length + ' 个');
    return resources;
  },

  // ========== 核心：穷举 webpack 运行时所有 chunk（push 拦截技术）==========
  // 关键突破：__webpack_require__ 通常在闭包中，不是全局变量
  // 必须通过拦截 webpackChunk.push 来捕获运行时注入的 require 对象
  _enumerateChunksFromRuntime() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ chunks: [], publicPath: '', hasWebpack: false }), 30000);
      chrome.devtools.inspectedWindow.eval(`
        (function() {
          try {
            var result = { chunks: [], publicPath: '', hasWebpack: false };
            var seen = {};

            // 首先尝试直接访问（某些老版本 webpack 暴露为全局）
            var wpRequire = null;
            try {
              if (typeof __webpack_require__ !== 'undefined') wpRequire = __webpack_require__;
            } catch(e) {}

            // 方式1：查找 webpackChunk 全局数组
            var webpackChunkArr = null;
            for (var key in self) {
              if (/^webpackChunk/.test(key) && Array.isArray(self[key])) {
                webpackChunkArr = self[key];
                result.hasWebpack = true;
                break;
              }
            }

            // ★核心技术★ 方式2：直接 push 假 chunk 来捕获 __webpack_require__
            // webpack 5 格式：push = webpackJsonpCallback.bind(null, push.bind(chunkLoadingGlobal))
            // 当我们直接 push [chunkIds, modules, runtimeFn] 时，webpackJsonpCallback 会调用 runtimeFn(__webpack_require__)
            if (!wpRequire && webpackChunkArr) {
              var captured = null;
              try {
                // 随机 chunk ID 避免重复推送时 webpack 跳过 runtime
                var chunkId = '_wpx' + Math.random().toString(36).substr(2, 8);
                webpackChunkArr.push([[chunkId], {}, function(require) {
                  if (require && require.u) captured = require;
                }]);
              } catch(e2) {}

              if (captured) {
                wpRequire = captured;
              }
            }

            // 方式3：遍历全局对象的属性找 webpack require
            if (!wpRequire) {
              for (var k in self) {
                try {
                  var v = self[k];
                  if (v && typeof v === 'object' && v.m && v.c && typeof v.p === 'string' && typeof v.u === 'function') {
                    wpRequire = v;
                    break;
                  }
                  if (v && typeof v === 'function' && v.m && v.c && typeof v.u === 'function') {
                    wpRequire = v;
                    break;
                  }
                } catch(e2) {}
              }
            }

            // 解析 chunk map
            if (wpRequire) {
              result.hasWebpack = true;
              if (typeof wpRequire.p === 'string') {
                result.publicPath = wpRequire.p;
              }

              if (typeof wpRequire.u === 'function') {
                var fnSrc = wpRequire.u.toString();

                // 提取函数体中的 chunk map 对象
                // 格式: e=>"js/"+e+"."+{6:"hash1",57:"hash2"...}[e]+".js"
                var mapMatch = fnSrc.match(/\\{([^}]+)\\}/);
                if (mapMatch) {
                  // 手动解析键值对（处理科学计数法 ID: 1e3, 8e3 等）
                  var rawMap = mapMatch[1];
                  // 正则匹配: "key":"value" 或 key:"value" 或 key:"value"
                  var kvRegex = /"?\\b(\\d+(?:e\\d+)?)"?\\s*:\\s*"([^"]+)"/g;
                  var kvMatch;
                  while ((kvMatch = kvRegex.exec(rawMap)) !== null) {
                    var chunkId = kvMatch[1];
                    var hash = kvMatch[2];
                    // 科学计数法转数字
                    var numericId = chunkId;
                    if (/^\\d+e\\d+$/.test(chunkId)) {
                      numericId = String(Math.floor(parseFloat(chunkId)));
                    }
                    var filename = 'js/' + chunkId + '.' + hash + '.js';
                    try {
                      var url = new URL(filename, result.publicPath || location.href).href;
                      if (!seen[url]) {
                        seen[url] = true;
                        result.chunks.push(url);
                      }
                    } catch(e3) {
                      var raw = (result.publicPath || '') + filename;
                      if (!seen[raw]) {
                        seen[raw] = true;
                        result.chunks.push(raw);
                      }
                    }
                  }
                }

                // 备选：直接调用 .u(id) 穷举（如果正则没提取到）
                if (result.chunks.length === 0) {
                  for (var id = 0; id < 500; id++) {
                    try {
                      var filename = wpRequire.u(id + '');
                      if (filename && typeof filename === 'string' && filename.length > 3) {
                        try {
                          var url = new URL(filename, result.publicPath || location.href).href;
                          if (!seen[url]) {
                            seen[url] = true;
                            result.chunks.push(url);
                          }
                        } catch(e4) {}
                      }
                    } catch(e5) {}
                  }
                }
              }
            }

            return JSON.stringify(result);
          } catch(e) { return JSON.stringify({ chunks: [], publicPath: '', hasWebpack: false }); }
        })()
      `, (result, isException) => {
        clearTimeout(timer);
        if (isException || !result) { resolve({ chunks: [], publicPath: '', hasWebpack: false }); return; }
        try { resolve(JSON.parse(result)); } catch(e) { resolve({ chunks: [], publicPath: '', hasWebpack: false }); }
      });
    });
  },

  // ========== Linkfinder: 从 JS 内容提取所有 URL ==========
  _linkfinderExtract(text, baseUrl) {
    if (!text || text.length < 10) return [];
    const urls = new Set();
    // 正则来自 Rules.js Linkfinder 规则（增强版）
    const patterns = [
      // 完整 URL: https?://...
      /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g,
      // 相对路径: "/path/to/file.js"
      /"(?:\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+){2,}"/g,
      /'(?:\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+){2,}'/g,
      // webpack chunk 引用: "chunk-name"
      /"[A-Za-z0-9\-_]{10,}\.[a-z]{2,4}"/gi,
      /'[A-Za-z0-9\-_]{10,}\.[a-z]{2,4}'/gi,
      // JS/CSS 文件路径: path/to/file.js
      /["']([A-Za-z0-9\-_\.\/]+\.(?:js|css|json|xml|svg|png|jpg|jpeg|gif|webp|woff2?|ttf|map))["']/gi,
      // sourceMappingURL
      /sourceMappingURL\s*=\s*(\S+)/gi,
      // import() 动态引用
      /import\s*\(\s*["']([^"']+)["']\s*\)/g,
      // webpackChunkName 注释
      /\/\*\s*webpackChunkName\s*:\s*["']([^"']+)["']\s*\*\//g,
    ];

    for (const pattern of patterns) {
      let match;
      const regex = new RegExp(pattern.source, pattern.flags);
      while ((match = regex.exec(text)) !== null) {
        let candidate = (match[1] || match[0]).replace(/^["']|["']$/g, '').trim();
        if (!candidate || candidate.length < 2) continue;
        if (candidate.startsWith('data:') || candidate.startsWith('blob:')) continue;
        if (candidate.startsWith('#')) continue;

        try {
          if (/^https?:\/\//i.test(candidate)) {
            urls.add(candidate);
          } else if (candidate.startsWith('//')) {
            urls.add('https:' + candidate);
          } else {
            const resolved = new URL(candidate, baseUrl || 'http://localhost').href;
            urls.add(resolved);
          }
        } catch (e) {
          // 无法解析则跳过
        }
      }
    }

    // 过滤：只保留 web 资源路径
    const result = [];
    for (const u of urls) {
      try {
        const p = new URL(u).pathname.toLowerCase();
        if (p.includes('.') || p.length > 3) {
          result.push(u);
        }
      } catch (e) {}
    }
    return result;
  },

  // ========== 扫描所有 JS 内容并返回 ==========
  _scanJsContents() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ jsContents: [] }), 30000);
      chrome.devtools.inspectedWindow.eval(`
        (function() {
          try {
            var seen = {};
            var jsContents = [];
            var entries = performance.getEntriesByType('resource');
            for (var i = 0; i < entries.length; i++) {
              var url = entries[i].name;
              if (seen[url]) continue;
              if (/\\.(js|css)(\\?|$)/i.test(url)) {
                seen[url] = true;
                try {
                  var x = new XMLHttpRequest();
                  x.open('GET', url, false);
                  x.send();
                  if (x.status === 200 && x.responseText) {
                    jsContents.push({ url: url, text: x.responseText });
                  }
                } catch(e) {}
              }
            }
            return JSON.stringify({ jsContents: jsContents });
          } catch(e) { return JSON.stringify({ jsContents: [] }); }
        })()
      `, (result, isException) => {
        clearTimeout(timer);
        if (isException || !result) { resolve({ jsContents: [] }); return; }
        try { resolve(JSON.parse(result)); } catch(e) { resolve({ jsContents: [] }); }
      });
    });
  },

  // ========== 扫描全部 JS/CSS + 返回内容（用于 Linkfinder）==========
  _scanAllWithContent() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ maps: [], sources: [], jsContents: [] }), 45000);
      chrome.devtools.inspectedWindow.eval(`
        (function() {
          try {
            var seen = {};
            var mapList = [];
            var sourceList = [];
            var jsContents = [];
            var allFetchedUrls = [];

            var entries = performance.getEntriesByType('resource');
            var urls = [];
            entries.forEach(function(e) {
              var n = e.name;
              if (!seen[n] && /\\.(js|css)(\\?|$)/i.test(n)) {
                seen[n] = true;
                urls.push(n);
              }
            });

            for (var i = 0; i < urls.length; i++) {
              try {
                var x = new XMLHttpRequest();
                x.open('GET', urls[i], false);
                x.send();
                if (x.status === 200 && x.responseText) {
                  var t = x.responseText;
                  allFetchedUrls.push(urls[i]);
                  // 保存内容供 Linkfinder 分析
                  jsContents.push({ url: urls[i], text: t });

                  var tail = t.length > 800 ? t.slice(-800) : t;
                  var m = tail.match(/sourceMappingURL\\s*=\\s*(\\S+)/i);
                  if (!m) m = t.match(/sourceMappingURL\\s*=\\s*(\\S+)/i);
                  if (m) {
                    try {
                      var mapUrl = new URL(m[1], urls[i]).href;
                      if (!seen[mapUrl]) {
                        seen[mapUrl] = true;
                        mapList.push(mapUrl);

                        try {
                          var mx = new XMLHttpRequest();
                          mx.open('GET', mapUrl, false);
                          mx.send();
                          if (mx.status === 200 && mx.responseText) {
                            var mapData = JSON.parse(mx.responseText);
                            if (mapData.sources && Array.isArray(mapData.sources)) {
                              mapData.sources.forEach(function(s) {
                                if (!s) return;
                                try { sourceList.push(new URL(s, mapUrl).href); } catch(e) {}
                              });
                            }
                          }
                        } catch(e2) {}
                      }
                    } catch(e) {}
                  }
                }
              } catch(e) {}
            }

            return JSON.stringify({ maps: mapList, sources: sourceList, jsContents: jsContents, fetchedUrls: allFetchedUrls });
          } catch(e) { return JSON.stringify({ maps: [], sources: [], jsContents: [], fetchedUrls: [] }); }
        })()
      `, (result, isException) => {
        clearTimeout(timer);
        if (isException || !result) { resolve({ maps: [], sources: [], jsContents: [], fetchedUrls: [] }); return; }
        try { resolve(JSON.parse(result)); } catch(e) { resolve({ maps: [], sources: [], jsContents: [], fetchedUrls: [] }); }
      });
    });
  },

  // ========== 核心：eval 扫描全部 JS/CSS → 找 sourceMappingURL → 解析源文件 ==========
  _scanAll() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ maps: [], sources: [] }), 45000);
      chrome.devtools.inspectedWindow.eval(`
        (function() {
          try {
            var seen = {};
            var mapList = [];
            var sourceList = [];

            // 1. 收集所有 JS/CSS URL（performance API）
            var entries = performance.getEntriesByType('resource');
            var urls = [];
            entries.forEach(function(e) {
              var n = e.name;
              if (!seen[n] && /\\.(js|css)(\\?|$)/i.test(n)) {
                seen[n] = true;
                urls.push(n);
              }
            });

            // 2. 逐个同步 XHR，找 sourceMappingURL
            for (var i = 0; i < urls.length; i++) {
              try {
                var x = new XMLHttpRequest();
                x.open('GET', urls[i], false);
                x.send();
                if (x.status === 200 && x.responseText) {
                  var t = x.responseText;
                  var tail = t.length > 800 ? t.slice(-800) : t;
                  var m = tail.match(/sourceMappingURL\\s*=\\s*(\\S+)/i);
                  if (!m) m = t.match(/sourceMappingURL\\s*=\\s*(\\S+)/i);
                  if (m) {
                    try {
                      var mapUrl = new URL(m[1], urls[i]).href;
                      if (!seen[mapUrl]) {
                        seen[mapUrl] = true;
                        mapList.push(mapUrl);
                      }

                      // 3. 同步拉取并解析 sourcemap
                      try {
                        var mx = new XMLHttpRequest();
                        mx.open('GET', mapUrl, false);
                        mx.send();
                        if (mx.status === 200 && mx.responseText) {
                          var mapData = JSON.parse(mx.responseText);
                          if (mapData.sources && Array.isArray(mapData.sources)) {
                            mapData.sources.forEach(function(s) {
                              if (!s) return;
                              try { sourceList.push(new URL(s, mapUrl).href); } catch(e) {}
                            });
                          }
                        }
                      } catch(e2) {}
                    } catch(e) {}
                  }
                }
              } catch(e) {}
            }

            return JSON.stringify({ maps: mapList, sources: sourceList });
          } catch(e) { return JSON.stringify({ maps: [], sources: [] }); }
        })()
      `, (result, isException) => {
        clearTimeout(timer);
        if (isException || !result) { resolve({ maps: [], sources: [] }); return; }
        try { resolve(JSON.parse(result)); } catch(e) { resolve({ maps: [], sources: [] }); }
      });
    });
  },

  // ========== 同步 XHR 获取内容 ==========
  _xhrGet(url) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 10000);
      try {
        chrome.devtools.inspectedWindow.eval(
          `(function() {
            try {
              var x = new XMLHttpRequest();
              x.open('GET', ${JSON.stringify(url)}, false);
              x.send();
              if (x.status === 200) return JSON.stringify({c: x.responseText, m: x.getResponseHeader('Content-Type') || ''});
            } catch(e) {}
            return JSON.stringify(null);
          })()`,
          (result, isException) => {
            clearTimeout(timer);
            if (isException || !result) { resolve(null); return; }
            try {
              const p = JSON.parse(result);
              resolve(p && p.c != null ? { content: p.c, mimeType: p.m || 'text/plain' } : null);
            } catch(e) { resolve(null); }
          }
        );
      } catch(e) { clearTimeout(timer); resolve(null); }
    });
  },

  // ========== BFS 爬取中用：内省运行时 + 拉取遗漏的 chunk ==========
  async extractDuringCrawl(baseUrl) {
    const result = { resources: [] };
    const info = await this._introspect();
    if (!info.hasWebpack) return result;

    // 也尝试穷举 chunk（与内省互补）
    const chunkInfo = await this._enumerateChunksFromRuntime();
    const allChunkUrls = new Set([
      ...this._parseChunkUrls(info, baseUrl),
      ...(chunkInfo.chunks || [])
    ]);

    for (const url of allChunkUrls) {
      if (this._fetchedUrls.has(url)) continue;
      this._fetchedUrls.add(url);
      const c = await this._xhrGet(url);
      if (c) result.resources.push({ url, content: c.content, mimeType: c.mimeType });
    }
    return result;
  },

  async extractAfterCrawl(allResources, protocol, logFn) {
    const log = logFn || (() => {});
    const discovered = new Map();
    const mapUrls = new Set();
    for (const [path, res] of allResources) {
      if (!res || !res.content) continue;
      let text = typeof res.content === 'string' ? res.content : '';
      if (!text) {
        try {
          const arr = res.content instanceof Uint8Array ? res.content : new Uint8Array(res.content);
          text = new TextDecoder('utf-8', { fatal: false }).decode(arr);
        } catch(e) {}
      }
      if (!text || text.length < 200) continue;
      const tail = text.length > 600 ? text.slice(-600) : text;
      const m = tail.match(/sourceMappingURL\s*=\s*(\S+)/i) || text.match(/sourceMappingURL\s*=\s*(\S+)/i);
      if (!m) continue;
      try {
        const idx = path.indexOf('/');
        const jsUrl = idx > 0 ? protocol + '://' + path : '';
        const mapUrl = new URL(m[1].trim(), jsUrl || (protocol + '://localhost')).href;
        if (!jsUrl && mapUrl.startsWith(protocol + '://localhost')) continue;
        mapUrls.add(mapUrl);
      } catch(e) {}
    }
    for (const url of mapUrls) {
      if (this._fetchedUrls.has(url)) continue;
      this._fetchedUrls.add(url);
      const c = await this._xhrGet(url);
      if (c) discovered.set(url, c);
    }
    const resources = [];
    for (const [url, c] of discovered) resources.push({ url, content: c.content, mimeType: c.mimeType });
    return resources;
  },

  _introspect() {
    return new Promise((resolve) => {
      chrome.devtools.inspectedWindow.eval(`
        (function() {
          var i = { hasWebpack: false, publicPath: '', chunkFn: '' };
          if (typeof __webpack_require__ !== 'undefined') {
            i.hasWebpack = true;
            if (__webpack_require__.p) i.publicPath = __webpack_require__.p;
            if (typeof __webpack_require__.u === 'function') i.chunkFn = __webpack_require__.u.toString();
          }
          return JSON.stringify(i);
        })()
      `, (r, err) => {
        if (err || !r) { resolve({ hasWebpack: false }); return; }
        try { resolve(JSON.parse(r)); } catch(e) { resolve({ hasWebpack: false }); }
      });
    });
  },

  _parseChunkUrls(info, baseUrl) {
    const urls = [];
    let pp = info.publicPath || baseUrl;
    if (!/\/$/.test(pp) && !pp.endsWith('.js')) pp += '/';
    if (!/^https?:\/\//.test(pp)) { try { pp = new URL(pp, baseUrl).href; } catch(e) { pp = baseUrl; } }
    if (info.chunkFn) {
      const m = info.chunkFn.match(/\{(\d+:"[^"]+",?\s*)+\}/);
      if (m) {
        const re = /(\d+):"([^"]+)"/g; let pm;
        while ((pm = re.exec(m[0])) !== null) {
          try { urls.push(new URL(pm[2], pp).href); } catch(e) {}
        }
      }
    }
    return [...new Set(urls)];
  },

  _guessMime(url) {
    const ext = (url.split('.').pop() || '').toLowerCase().split('?')[0];
    const m = { js: 'application/javascript', mjs: 'application/javascript', css: 'text/css',
      html: 'text/html', json: 'application/json', xml: 'application/xml', svg: 'image/svg+xml',
      vue: 'text/plain', ts: 'application/javascript', jsx: 'application/javascript' };
    return m[ext] || 'text/plain';
  },

  reset() {
    this._fetchedUrls = new Set();
    this._chunkManifest = [];
  },
};
