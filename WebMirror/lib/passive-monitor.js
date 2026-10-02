// lib/passive-monitor.js — FindSomething 2.1.12 实时被动监听引擎
// 被动捕获 Network API 请求，对响应体内容跑 FindSomething 的 Wi 正则字典，
// 提取并去重 path / incomplete_path / url / ip / ip_port / domain 路径类信息。
// 监听停止后缓存供爬取注入；正则字典逐字移植自 FindSomething background.bundle.js
//
// 移植自: FindSomething 2.1.12
//   Wi 字典: background.bundle.js:358429
//   Cs 静态后缀: background.bundle.js:274457
//   Hi 分类函数: background.bundle.js:360364
//   Rs 去引号:   background.bundle.js:275006
//   Ts 静态拆分: background.bundle.js:274745
//   Ps 合并去重: background.bundle.js:274656

const PassiveMonitor = {

  // ========== 运行状态 ==========
  _listening: false,
  _onEntry: null,            // 新路径回调 (entries[]) => void
  _onScanHit: null,          // POST/GET 扫描命中回调 (hits[]) => void（修复12）
  _onRequest: null,          // onRequestFinished 监听器引用（用于注销）

  // ========== 缓存 ==========
  _paths: new Map(),         // normalizedUrl -> { raw, type, source, ts }
  _staticSet: new Set(),     // 静态资源 path（拆分自 Cs 后缀）
  _counts: {                 // 各类计数
    path: 0, incomplete_path: 0, url: 0,
    ip: 0, ip_port: 0, domain: 0, static: 0, vue: 0, post: 0,
  },

  // ========== 黑名单（收集阶段拦截 delete/logout 等危险接口）==========
  // 命中黑名单的 URL 不进 _paths / _counts / 扫描回调
  _defaultBlacklist: [
    'delete', 'logout', 'loginout', 'signout', 'sign-out', 'sign_out',
    'deactivate', 'remove', 'drop', 'truncate', 'purge', 'destroy',
  ],
  _blacklist: null,          // 运行时缓存（默认列表 + 用户自定义，合并去重），null=未初始化
  _blacklistStorageKey: 'webmirror_monitor_blacklist',

  // ========== FindSomething Wi 正则字典（逐字移植） ==========
  // 只启用路径/URL 类正则（path/incomplete_path/url/ip/ip_port/domain），
  // secret/sfz/mobile/mail/jwt/algorithm 由现有 HaE SensitiveScanner 负责，避免重复扫描。
  // TLD 列表与引号边界、`./`/`../` 开头判断与原版完全一致。
  _TLD: 'xin|com|cn|net|com.cn|vip|top|cc|shop|club|wang|xyz|luxe|site|news|pub|fun|online|win|red|loan|ren|mom|net.cn|org|link|biz|bid|help|tech|date|mobi|so|me|tv|co|vc|pw|video|party|pics|website|store|ltd|ink|trade|live|wiki|space|gift|lol|work|band|info|click|photo|market|tel|social|press|game|kim|org.cn|games|pro|men|love|studio|rocks|asia|group|science|design|software|engineer|lawyer|fit|beer|tw|我爱你|中国|公司|网络|在线|网址|网店|集团|中文网',

  // Wi.path — 以 / ../ ./ 开头的路径（带引号边界）
  _rePath: /["'](?:\/|\.\.\/|\.\/)[^\/\>\< \)\(\{\}\,\'\"\\]([^\>\< \)\(\{\}\,\'\"\\])*?["']/g,
  // Wi.incomplete_path — 不以 / 开头但含 / 的片段
  _reIncompletePath: /["'][^\/\>\< \)\(\{\}\,\'\"\\][\w\/]*?\/[\w\/]*?["']/g,
  // Wi.url — 带 TLD 后缀的完整 URL
  _reUrl: function () {
    return new RegExp(
      '["\'](([a-zA-Z0-9]+:)?//)?[a-zA-Z0-9\\-\\.]*?\\.(' + this._TLD + ')(\\:\\d{1,5})?(/.*?)?["\']', 'g'
    );
  },
  // Hi 二次提取（从 url 项里抠 ip / ip_port / domain）
  _reIp: /["'](([a-zA-Z0-9]+:)?\/\/)?\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g,
  _reIpPort: /["'](([a-zA-Z0-9]+:)?\/\/)?\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\:\d{1,5}(\/.*?)?["']/g,
  _reDomain: function () {
    return new RegExp(
      '["\'](([a-zA-Z0-9]+:)?//)?[a-zA-Z0-9\\-\\.]*?\\.(' + this._TLD + ')(\\:\\d{1,5})?(/)?["\']', 'g'
    );
  },

  // ========== FindSomething Cs 静态资源后缀（逐字移植） ==========
  _staticSuffixes: ['.jpg', '.png', '.gif', '.css', '.svg', '.ico', '.js', '.jpeg', '.html', 'html'],

  // ========== FindSomething Rs — 去掉首尾引号 ==========
  _stripQuotes(arr) {
    if (!arr) return [];
    const out = [];
    for (const s of arr) {
      let start = 0, end = s.length;
      if (s.startsWith("'") || s.startsWith('"')) start = 1;
      if (s.endsWith("'") || s.endsWith('"')) end = s.length - 1;
      out.push(s.substring(start, end));
    }
    return out;
  },

  // ========== FindSomething Ps — 合并去重（返回新数组） ==========
  _mergeUnique(a, b) {
    if (!a) return b || [];
    if (!b) return a;
    a.forEach(e => { if (b.indexOf(e) < 0) b.push(e); });
    return b;
  },

  // ========== FindSomething Ts — 静态资源拆分 ==========
  // 把含 Cs 后缀的项移入 static 组，其余留在 arr1
  _splitStatic(arr) {
    const main = arr.slice(0, arr.length);
    arr.forEach(e => {
      for (const suf of this._staticSuffixes) {
        if (e.indexOf(suf) >= 0) {
          // .js 但非 .jsp 的特判（原版逻辑）
          if (suf === '.js' && e.indexOf('.jsp') >= 0) continue;
          const idx = main.indexOf(e);
          if (idx >= 0) main.splice(idx, 1);
          if (!this._staticSet.has(e)) this._staticSet.add(e);
          break;
        }
      }
    });
    return main;
  },

  // ========== FindSomething Hi — 主分类流程 ==========
  // 对 source 字符串跑全部启用正则，返回 { path, incomplete_path, url, ip, ip_port, domain }
  // 忠实移植原版 Hi(e)：先对所有 Wi 正则做全文 match，再对 url 项二次提取 ip/ip_port/domain
  _classify(text) {
    const result = {
      path: null, incomplete_path: null, url: null,
      ip: null, ip_port: null, domain: null,
    };

    // 第一步：对所有启用正则做全文 match（对应原版 Object.keys(Wi).forEach）
    this._rePath.lastIndex = 0;
    this._reIncompletePath.lastIndex = 0;
    this._reIp.lastIndex = 0;
    this._reIpPort.lastIndex = 0;
    const reUrl = this._reUrl();
    const reDomain = this._reDomain();
    reUrl.lastIndex = 0;
    reDomain.lastIndex = 0;

    result.path = text.match(this._rePath);
    result.incomplete_path = text.match(this._reIncompletePath);
    result.url = text.match(reUrl);
    result.ip = text.match(this._reIp);
    result.ip_port = text.match(this._reIpPort);
    result.domain = text.match(reDomain);

    // 第二步（Hi 二次提取）：从每个 url 项里再抠 ip/ip_port/domain（Ps 合并去重）
    if (result.url) {
      result.url.forEach(u => {
        this._reIp.lastIndex = 0;
        this._reIpPort.lastIndex = 0;
        const reDomain2 = this._reDomain();
        reDomain2.lastIndex = 0;
        result.ip = this._mergeUnique(result.ip, u.match(this._reIp));
        result.ip_port = this._mergeUnique(result.ip_port, u.match(this._reIpPort));
        result.domain = this._mergeUnique(result.domain, u.match(reDomain2));
      });
    }

    return result;
  },

  // ========== 判断是否应处理此响应体 ==========
  // 相对 FindSomething 原版的性能优化：跳过二进制类型（图片/字体/音视频），
  // 只对文本类响应体跑正则。正则字典本身与原版 100% 一致。
  _shouldProcess(mimeType) {
    if (!mimeType) return true; // 未知类型保守处理
    const m = mimeType.toLowerCase();
    if (m.startsWith('image/') && !m.includes('svg')) return false;
    if (m.startsWith('font/')) return false;
    if (m.startsWith('video/') || m.startsWith('audio/')) return false;
    if (m.includes('octet-stream')) return false;
    return true;
  },

  // ========== getContent（带超时，监听模式用较短超时） ==========
  _getContent(entry, timeoutMs) {
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
          resolve(content != null ? content : null);
        });
      } catch (e) {
        if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
      }
    });
  },

  // ========== 处理单个请求 ==========
  async _handleRequest(request) {
    try {
      const url = request.request?.url || '';
      // 跳过非 http(s) 协议
      if (!url || (!url.startsWith('http:') && !url.startsWith('https:'))) return;

      // 注：黑名单（delete/logout 等）在这里【不拦截】，仍正常收集进缓存并在监听路径中展示；
      // 拦截点在 getPaths()——递归爬虫不会请求黑名单接口，避免误触发注销/删除导致会话失效。

      const status = request.response?.status || 0;
      // 只处理成功响应/缓存命中（与 resource-capture 一致）
      if (status !== 200 && status !== 304 && status !== 0) return;

      // ===== 请求方向：POST body + GET query 收集与扫描（修复12）=====
      const method = (request.request?.method || 'GET').toUpperCase();
      const scanHits = []; // 本次请求的扫描命中

      // POST body 收集 + 扫描
      if (method === 'POST') {
        const postData = request.request?.postData;
        const body = postData?.text || '';
        const bodyMime = postData?.mimeType || '';
        if (body && body.length >= 2) {
          // endpoint 入 _paths（type='post'，存 body 预览）
          this._addPostEntry(url, body, bodyMime);
          // body 直接喂 HaE 扫描（统一用 text/plain，避免表单 application/x-www-form-urlencoded
          // 等非白名单 MIME 被 SensitiveScanner._shouldScan 跳过）
          const fileLabel = '[POST] ' + this._shortUrl(url);
          const hits = this._scanText(body, 'text/plain', fileLabel);
          if (hits.length > 0) scanHits.push(...hits);
        }
      }

      // GET query 参数扫描（几乎零成本，补全 query 里的敏感信息）
      if (method === 'GET') {
        try {
          const u = new URL(url);
          if (u.search && u.search.length > 1) {
            const fileLabel = '[GET] ' + this._shortUrl(url);
            // query 字符串当 text/plain 扫
            const hits = this._scanText(u.search, 'text/plain', fileLabel);
            if (hits.length > 0) scanHits.push(...hits);
          }
        } catch (e) {}
      }

      // 扫描命中通过回调上报
      if (scanHits.length > 0 && this._onScanHit) {
        this._onScanHit(scanHits);
      }

      const mimeType = request.response?.content?.mimeType || '';
      if (!this._shouldProcess(mimeType)) return;

      // 拿响应体
      const content = await this._getContent(request, 3000);
      if (!content || content.length < 2) return;

      // 跑 Hi 分类
      const classified = this._classify(content);

      // 收集本次新增条目
      const newEntries = [];
      const addEntries = (arr, type) => {
        if (!arr) return;
        const cleaned = this._stripQuotes(arr);
        for (const raw of cleaned) {
          if (!raw || raw.length < 2) continue;
          const norm = this._normalize(raw);
          if (this._paths.has(norm)) continue;
          const entry = { raw, type, norm, source: url, ts: Date.now() };
          this._paths.set(norm, entry);
          newEntries.push(entry);
          this._counts[type] = (this._counts[type] || 0) + 1;
        }
      };

      // 修复: 先拆分静态资源（.js/.css/.png 等）到 _staticSet，
      // 拆分后的业务 path 才进 _paths（参照 FindSomething Ts 流程）
      // 避免静态资源 URL 被注入爬虫队列
      const mainPaths = classified.path ? this._splitStatic([...classified.path]) : [];
      const mainIncomplete = classified.incomplete_path ? this._splitStatic([...classified.incomplete_path]) : [];

      addEntries(mainPaths, 'path');
      addEntries(mainIncomplete, 'incomplete_path');
      addEntries(classified.url, 'url');
      addEntries(classified.ip, 'ip');
      addEntries(classified.ip_port, 'ip_port');
      addEntries(classified.domain, 'domain');

      // 统计静态拆分（不作为独立条目，仅更新计数）
      this._counts.static = this._staticSet.size;

      // 通知 UI（有新增才回调，减少无效刷新）
      if (newEntries.length > 0 && this._onEntry) {
        this._onEntry(newEntries);
      }
    } catch (e) {
      // 单个请求处理失败不影响整体监听
    }
  },

  // ========== 添加 POST 端点条目（修复12）==========
  // endpoint 去参数值后入 _paths（type='post'），body 存 entry 供 UI 预览
  _addPostEntry(url, body, bodyMime) {
    try {
      const u = new URL(url);
      // endpoint 归一化：去 query 值（保留参数名签名，与爬虫去重一致）
      const paramNames = [...new Set([...u.searchParams.keys()])].sort().join(',');
      const endpoint = u.origin + u.pathname + (paramNames ? '|' + paramNames : '');
      if (this._paths.has(endpoint)) {
        // 已存在：若新 body 更长则更新（保留信息量更大的）
        const existing = this._paths.get(endpoint);
        if (body.length > (existing.bodyPreview || '').length) {
          existing.bodyPreview = body.substring(0, 500);
          existing.bodyMime = bodyMime;
        }
        return;
      }
      this._paths.set(endpoint, {
        raw: u.origin + u.pathname,   // 展示用：去 query 的纯净 endpoint
        type: 'post',
        norm: endpoint,
        source: url,
        ts: Date.now(),
        bodyPreview: body.substring(0, 500),  // body 预览（截断防膨胀）
        bodyMime: bodyMime,
      });
      this._counts.post = (this._counts.post || 0) + 1;
    } catch (e) {}
  },

  // ========== 扫描文本（封装 SensitiveScanner，扫描失败静默）==========
  _scanText(text, mimeType, fileLabel) {
    try {
      if (typeof SensitiveScanner === 'undefined' || !SensitiveScanner.scanContent) return [];
      return SensitiveScanner.scanContent(text, mimeType, fileLabel);
    } catch (e) {
      return [];
    }
  },

  // ========== 短 URL（扫描标签用，去 query/hash）==========
  _shortUrl(url) {
    try {
      const u = new URL(url);
      return u.host + u.pathname;
    } catch (e) { return url; }
  },

  // ========== 归一化（去 query/hash，用于去重 key） ==========
  _normalize(str) {
    let s = str.trim();
    // 去 hash
    const hashIdx = s.indexOf('#');
    if (hashIdx >= 0) s = s.substring(0, hashIdx);
    // 去 query（FindSomething 路径去重粒度：同 path 不同 query 视为一条）
    const qIdx = s.indexOf('?');
    if (qIdx >= 0) s = s.substring(0, qIdx);
    return s;
  },

  // ========== 启动监听 ==========
  start(options = {}) {
    if (this._listening) return false;
    this._listening = true;
    this._onEntry = options.onEntry || null;
    this._onScanHit = options.onScanHit || null;  // 修复12: POST/GET 扫描命中回调

    this._onRequest = (request) => {
      // 异步处理，不阻塞 Network API
      this._handleRequest(request);
    };
    try {
      chrome.devtools.network.onRequestFinished.addListener(this._onRequest);
    } catch (e) {
      this._listening = false;
      return false;
    }
    return true;
  },

  // ========== 停止监听（保留缓存） ==========
  stop() {
    if (!this._listening) return;
    this._listening = false;
    if (this._onRequest) {
      try {
        chrome.devtools.network.onRequestFinished.removeListener(this._onRequest);
      } catch (e) {}
      this._onRequest = null;
    }
  },

  isListening() { return this._listening; },

  // ========== 清空缓存（重置时调用） ==========
  clear() {
    this._paths.clear();
    this._staticSet.clear();
    this._counts = { path: 0, incomplete_path: 0, url: 0, ip: 0, ip_port: 0, domain: 0, static: 0, vue: 0, post: 0 };
  },

  getCounts() { return { ...this._counts, total: this._paths.size }; },

  // ========== 黑名单 API ==========

  // 判断 URL 是否命中黑名单（只匹配 path+query，不匹配 host）
  // 大小写不敏感，词边界 \b 防误杀 deleteFile 这类正常路径
  _isBlacklisted(url) {
    const list = this._blacklist || this._defaultBlacklist;
    if (!list || list.length === 0) return false;
    let target;
    try {
      const u = new URL(url);
      target = (u.pathname + u.search).toLowerCase();
    } catch (e) { return false; }
    for (const kw of list) {
      if (!kw) continue;
      const k = String(kw).toLowerCase();
      // 正则转义防注入，词边界匹配
      const re = new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
      if (re.test(target)) return true;
    }
    return false;
  },

  // 从 chrome.storage.local 加载用户自定义黑名单（合并默认列表）
  // 加载完成前用默认列表兜底，避免空窗期漏拦
  loadBlacklist() {
    return new Promise((resolve) => {
      try {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
          this._blacklist = [...this._defaultBlacklist];
          resolve(this._blacklist);
          return;
        }
        chrome.storage.local.get([this._blacklistStorageKey], (result) => {
          if (chrome.runtime.lastError || !result || !result[this._blacklistStorageKey]) {
            this._blacklist = [...this._defaultBlacklist];
            resolve(this._blacklist);
            return;
          }
          const custom = result[this._blacklistStorageKey];
          if (!Array.isArray(custom)) {
            this._blacklist = [...this._defaultBlacklist];
            resolve(this._blacklist);
            return;
          }
          // 合并默认 + 用户自定义，去重去空
          const merged = [...new Set([...this._defaultBlacklist, ...custom].map(s => String(s).trim()).filter(Boolean))];
          this._blacklist = merged;
          resolve(merged);
        });
      } catch (e) {
        this._blacklist = [...this._defaultBlacklist];
        resolve(this._blacklist);
      }
    });
  },

  // 保存黑名单到 storage（用户编辑后调用）
  // list: string[]（完整列表，含默认项）
  saveBlacklist(list) {
    const cleaned = [...new Set((list || []).map(s => String(s).trim()).filter(Boolean))];
    this._blacklist = cleaned;
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [this._blacklistStorageKey]: cleaned }, () => {
          if (chrome.runtime.lastError) console.warn('PassiveMonitor: 黑名单持久化失败', chrome.runtime.lastError);
        });
      }
    } catch (e) { /* storage 不可用时静默 */ }
    return cleaned;
  },

  // 重置为默认列表
  resetBlacklist() {
    this._blacklist = [...this._defaultBlacklist];
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.remove([this._blacklistStorageKey], () => {
          if (chrome.runtime.lastError) console.warn('PassiveMonitor: 黑名单清除失败', chrome.runtime.lastError);
        });
      }
    } catch (e) {}
    return this._blacklist;
  },

  getBlacklist() {
    return [...(this._blacklist || this._defaultBlacklist)];
  },

  // ========== 批量删除缓存条目（UI 勾选删除用）==========
  // norms: string[]（entry.norm 数组）
  // 返回实际删除条数
  removeEntries(norms) {
    if (!norms || !norms.length) return 0;
    let removed = 0;
    for (const n of norms) {
      if (this._paths.has(n)) {
        const e = this._paths.get(n);
        this._counts[e.type] = Math.max(0, (this._counts[e.type] || 0) - 1);
        this._paths.delete(n);
        removed++;
      }
    }
    return removed;
  },

  // ========== 取同域可爬路径（完整 URL 数组，供注入 Crawler 队列） ==========
  // 只返回 path / incomplete_path / domain 类中可拼成同域完整 URL 的项；
  // url/ip 等跨域项不注入爬虫（避免爬 CDN），但保留在缓存中供 UI 展示。
  getPaths(originDomain, scheme) {
    const out = [];
    const origin = (scheme || 'https') + '://' + (originDomain || '');
    for (const [, entry] of this._paths) {
      const raw = entry.raw;
      if (!raw) continue;
      // 取路径类（path / incomplete_path / vue）
      // vue 路由本质是 /admin /user/list 这类绝对路径，与 path 类同等参与爬取注入
      if (entry.type !== 'path' && entry.type !== 'incomplete_path' && entry.type !== 'vue') continue;
      // 跳过静态资源
      if (this._staticSet.has(raw)) continue;
      // 跳过已是完整 URL 的（跨域）
      if (/^https?:\/\//i.test(raw)) continue;
      // 跳过协议相对 //
      if (raw.startsWith('//')) continue;
      // 跳过明显非路径（含空格等非法字符）
      if (/\s/.test(raw)) continue;

      let full;
      try {
        // ./ ../ /path 都按 origin 解析；vue 路由 /admin 同样解析为 origin+/admin
        full = new URL(raw, origin + '/').href;
      } catch (e) { continue; }

      // 仅同域
      try {
        if (new URL(full).host !== originDomain) continue;
      } catch (e) { continue; }

      // ===== 黑名单拦截：delete/logout 等危险接口不入爬虫队列，避免递归爬取触发注销/删除 =====
      // 仅阻止爬虫请求；接口仍在 _paths 缓存中，监听路径 Tab 照常展示
      if (this._isBlacklisted(full)) continue;

      out.push(full);
    }
    // 去重
    return [...new Set(out)];
  },

  // ========== 取全部缓存条目（供 UI 展示，含跨域） ==========
  getAllEntries() {
    return [...this._paths.values()];
  },
};
