// lib/error-detector.js — 错误页面检测引擎
// Phase 1: HTTP状态码 + URL偏移 + title关键词 + 空壳页面
// Phase 2: DOM骨架指纹库（手动标记 + 自动入库）
// Phase 3: 后台自动聚类晋升

const ErrorDetector = {

  // ========== 关键词表 ==========
  _errorKeywords: [
    '404', '403', '500', '502', '503',
    '不存在', '未找到', '错误', '出错', '拦截',
    'not found', 'forbidden', 'access denied', 'error', 'block',
    '请登录', '未登录', '需要登录', '验证码', 'captcha', 'just a moment',
    '页面不存在', '无法访问', '禁止访问', '无权限', 'page not found',
    'bad gateway', 'service unavailable', 'internal server error',
    '无法正常运作', 'http error', '网站所有者联系',
  ],

  // ========== 指纹库 ==========
  _fingerprints: new Map(),           // 确认指纹: Map<skeleton → {skeleton, title}>
  _candidates: new Map(),            // 候选池: skeleton → { count, signalCount }
  _skeletonHistory: [],              // 聚类历史: [{skeleton, url, isError, reason}]
  _sessionSkips: new Map(),          // 本次爬取跳过记录: url → reason
  _totalSkipped: 0,

  // ========== DOM 骨架提取 ==========
  extractSkeleton() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 5000);
      try {
        chrome.devtools.inspectedWindow.eval(`(function(){
          try {
            function getSkel(el, depth) {
              if (!el || depth > 4) return '';
              if (el.nodeType !== 1) return '';
              var tag = el.tagName.toLowerCase();
              if (el.id) tag += '#' + el.id;
              if (el.className && typeof el.className === 'string') {
                var cls = el.className.trim().split(/\\s+/).slice(0, 2).join('.');
                if (cls) tag += '.' + cls;
              }
              var kids = el.children, parts = [];
              for (var i = 0; i < Math.min(kids.length, 30); i++) {
                var s = getSkel(kids[i], depth + 1);
                if (s) parts.push(s);
              }
              return parts.length ? tag + '>' + parts.join('+') : tag;
            }
            var body = document.body;
            var title = document.title || '';
            var visible = body ? body.innerText || '' : '';
            var visibleLen = visible.replace(/\\s+/g, '').length;
            var nodeCnt = document.querySelectorAll('*').length;
            var skel = getSkel(document.documentElement, 0);
            // 提取错误页标识文字：优先 h1，无 h1 则取第一行可见文字
            var heading = '';
            var h1 = document.querySelector('h1');
            if (h1) {
              heading = h1.textContent.trim().substring(0, 80);
            } else {
              var firstLine = visible.trim().split(/\\n/)[0] || '';
              heading = firstLine.substring(0, 80);
            }
            return JSON.stringify({title:title, skeleton:skel, visibleTextLen:visibleLen, nodeCount:nodeCnt, heading:heading});
          } catch(e) { return JSON.stringify(null); }
        })()`, (result, isException) => {
          clearTimeout(timer);
          if (isException || !result) { resolve(null); return; }
          try { resolve(JSON.parse(result)); } catch(e) { resolve(null); }
        });
      } catch(e) { clearTimeout(timer); resolve(null); }
    });
  },

  // ========== 从 HAR 获取主文档 HTTP 状态码 ==========
  getDocumentStatus(requestedUrl) {
    return new Promise((resolve) => {
      // 微延迟确保 HAR 已写入主文档请求（异步时序）
      setTimeout(() => {
        try {
          chrome.devtools.network.getHAR((harLog) => {
            if (!harLog || !harLog.entries) { resolve(0); return; }
            const entries = harLog.entries;
            // URL 匹配：HAR 中可能以不同编码形式存储，遍历末20条全比对
            let decoded, encoded, encodedComp;
            try { decoded = decodeURIComponent(requestedUrl); } catch(e) { decoded = requestedUrl; }
            try { encoded = encodeURI(requestedUrl); } catch(e) { encoded = requestedUrl; }
            try { encodedComp = encodeURIComponent(requestedUrl); } catch(e) { encodedComp = requestedUrl; }
            const variants = new Set([requestedUrl, decoded, encoded, encodedComp]);
            const end = entries.length;
            const start = Math.max(0, end - 30); // 只搜最近 30 条
            for (let i = end - 1; i >= start; i--) {
              if (variants.has(entries[i].request.url)) {
                resolve(entries[i].response.status); return;
              }
            }
            // 兜底: 最后一个 document 类型
            for (let i = entries.length - 1; i >= 0; i--) {
              if (entries[i]._resourceType === 'document') {
                resolve(entries[i].response.status); return;
              }
            }
            resolve(0);
          });
        } catch(e) { resolve(0); }
      }, 200);
    });
  },

  // ========== 轻量 title-only 提取（extractSkeleton 失败时的兜底）==========
  _extractTitleOnly() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 2000);
      try {
        chrome.devtools.inspectedWindow.eval(
          'document.title || ""',
          (result, isException) => {
            clearTimeout(timer);
            resolve((!isException && result) ? String(result) : null);
          }
        );
      } catch(e) { clearTimeout(timer); resolve(null); }
    });
  },

  // ========== 关键词检测 ==========
  _matchKeywords(title) {
    if (!title) return false;
    const lower = title.toLowerCase();
    return this._errorKeywords.some(kw => lower.includes(kw.toLowerCase()));
  },

  // ========== 判断是否为 JS 文件（.js 不跑骨架指纹，避免 Chrome 纯文本包装器误判）==========
  _isJSFile(url) {
    try {
      const path = new URL(url).pathname.toLowerCase();
      const ext = (path.split('/').pop() || '').split('?')[0];
      if (!ext.includes('.')) return false;
      return '.' + ext.split('.').pop() === '.js';
    } catch(e) { return false; }
  },

  // ========== 空壳检测 ==========
  _isEmptyShell(visibleTextLen, nodeCount) {
    return visibleTextLen < 50 && nodeCount > 0 && nodeCount < 15;
  },

  // ========== URL 偏移检测 ==========
  _checkUrlDeviation(requestedUrl, finalUrl) {
    if (!requestedUrl || !finalUrl) return null;
    try {
      const req = new URL(requestedUrl);
      const fin = new URL(finalUrl);
      // http→https 同域同路径不算偏移（正常的协议升级）
      if (req.hostname === fin.hostname && req.pathname === fin.pathname) return null;
      const reqKey = req.origin + req.pathname;
      const finKey = fin.origin + fin.pathname;
      if (reqKey !== finKey) {
        return reqKey + ' → ' + finKey;
      }
    } catch(e) {}
    return null;
  },

  // ========== 核心: 综合分类判定 ==========
  // 返回 { isError, reason, skeleton }
  // 按成本从低到高逐信号检测，命中即返回
  async classifyError(requestedUrl, finalUrl) {
    // --- Signal 1: HTTP 状态码 ≥ 400 ---
    const status = await this.getDocumentStatus(requestedUrl);
    if (status >= 400) {
      let skeleton = null;
      if (!this._isJSFile(requestedUrl)) {
        const info = await this.extractSkeleton();
        if (info && info.skeleton) { skeleton = info.skeleton; this.addFingerprint(skeleton, info.title || '', info.heading || ''); }
      }
      return { isError: true, reason: 'HTTP ' + status, skeleton };
    }

    // --- Signal 2: URL 偏移 ---
    const deviation = this._checkUrlDeviation(requestedUrl, finalUrl);
    if (deviation) {
      let skeleton = null;
      if (!this._isJSFile(requestedUrl)) {
        const info = await this.extractSkeleton();
        if (info && info.skeleton) { skeleton = info.skeleton; this.addFingerprint(skeleton, info.title || '', info.heading || ''); }
      }
      return { isError: true, reason: 'URL偏移: ' + deviation, skeleton };
    }

    // --- Signals 3-5 仅对非 JS 页面做 ---
    if (this._isJSFile(requestedUrl)) {
      return { isError: false, reason: null, skeleton: null };
    }

    // --- 提取页面信息 ---
    const info = await this.extractSkeleton();
    if (!info) {
      const titleOnly = await this._extractTitleOnly();
      if (titleOnly && this._matchKeywords(titleOnly)) {
        return { isError: true, reason: 'title: ' + titleOnly.substring(0, 50), skeleton: null };
      }
      return { isError: false, reason: null, skeleton: null };
    }

    const skeleton = info.skeleton || null;

    // --- Signal 3: 骨架命中指纹库 ---
    if (skeleton && this._fingerprints.has(skeleton)) {
      return { isError: true, reason: '指纹命中', skeleton };
    }

    // --- Signal 4: title 命中关键词 → 仅入候选池，不直接确认为指纹 ---
    if (this._matchKeywords(info.title)) {
      if (skeleton) this._addCandidate(skeleton, true);
      return { isError: true, reason: 'title: ' + (info.title || '').substring(0, 50), skeleton };
    }

    // --- Signal 5: 空壳页面 → 仅入候选池 ---
    if (this._isEmptyShell(info.visibleTextLen || 0, info.nodeCount || 0)) {
      if (skeleton) this._addCandidate(skeleton, true);
      return { isError: true, reason: '空壳(文字' + (info.visibleTextLen || 0) + '节点' + (info.nodeCount || 0) + ')', skeleton };
    }

    return { isError: false, reason: null, skeleton };
  },

  // ========== 指纹管理 ==========
  addFingerprint(skeleton, title, heading) {
    if (skeleton && skeleton.length > 5) {
      this._fingerprints.set(skeleton, { skeleton, title: title || '', heading: heading || '' });
      this._candidates.delete(skeleton);
    }
  },

  removeFingerprint(skeleton) {
    this._fingerprints.delete(skeleton);
  },

  getFingerprints() {
    return [...this._fingerprints.values()].map(fp => ({ skeleton: fp.skeleton, title: fp.title || '', heading: fp.heading || '', hash: this._hashSkeleton(fp.skeleton) }));
  },

  _hashSkeleton(s) {
    let h = 0;
    for (let i = 0; i < Math.min(s.length, 200); i++) {
      h = ((h << 5) - h) + s.charCodeAt(i);
      h |= 0;
    }
    return (h >>> 0).toString(16).padStart(8, '0').slice(-8);
  },

  // ========== 候选池 ==========
  _addCandidate(skeleton, hasSignal) {
    if (!skeleton || skeleton.length < 5) return;
    const c = this._candidates.get(skeleton) || { count: 0, signalCount: 0 };
    c.count++;
    if (hasSignal) c.signalCount++;
    this._candidates.set(skeleton, c);
  },

  // ========== 骨架历史记录（供聚类用） ==========
  recordSkeleton(skeleton, url, isError, reason) {
    if (!skeleton) return;
    this._skeletonHistory.push({ skeleton, url, isError, reason, ts: Date.now() });
    if (isError) {
      this._addCandidate(skeleton, true);
    }
  },

  // ========== Phase 3: 自动聚类晋升 ==========
  runClustering() {
    if (this._skeletonHistory.length < 10) return { promoted: 0, totalGroups: 0 };

    const groups = new Map();
    for (const item of this._skeletonHistory) {
      if (this._fingerprints.has(item.skeleton)) continue;
      const g = groups.get(item.skeleton) || { count: 0, errorCount: 0, sampleUrls: [] };
      g.count++;
      if (item.isError) g.errorCount++;
      if (g.sampleUrls.length < 2) g.sampleUrls.push(item.url);
      groups.set(item.skeleton, g);
    }

    let promoted = 0;
    for (const [skeleton, g] of groups) {
      // 晋升规则: 出现 ≥10 次 且 ≥3 次携带错误信号
      if (g.count >= 10 && g.errorCount >= 3) {
        this.addFingerprint(skeleton);
        promoted++;
      }
    }

    return { promoted, totalGroups: groups.size };
  },

  // ========== 跳过记录 ==========
  recordSkip(url, reason) {
    this._sessionSkips.set(url, reason);
    this._totalSkipped++;
  },

  getSkipCount() { return this._totalSkipped; },
  getSessionSkips() { return new Map(this._sessionSkips); },

  getFingerprintCount() { return this._fingerprints.size; },
  getCandidateCount() { return this._candidates.size; },
  getHistoryLength() { return this._skeletonHistory.length; },

  // ========== 重置 ==========
  // 软重置: 保留指纹库，清空会话数据
  softReset() {
    this._candidates.clear();
    this._skeletonHistory = [];
    this._sessionSkips.clear();
    this._totalSkipped = 0;
  },

  // 硬重置: 清空所有数据（含指纹）
  reset() {
    this._fingerprints.clear();
    this._candidates.clear();
    this._skeletonHistory = [];
    this._sessionSkips.clear();
    this._totalSkipped = 0;
  },
};
