// lib/vue-analyzer.js — VueCrack Vue 路由分析移植（路线1：inspectedWindow.eval）
// 移植自 VueCrack detector.js 的只读分析逻辑，通过 chrome.devtools.inspectedWindow.eval
// 在页面上下文执行，提取 Vue Router 内存路由表（含隐藏路由）。
//
// 按需求移除了 VueCrack 的侵入式操作：
//   - patchRouterGuards（清除路由守卫）—— 不保留
//   - patchAllRouteAuth / isAuthTrue（修改 meta.auth 字段）—— 不保留
// 仅保留只读检测与路由提取，不修改目标页面任何状态。
//
// 移植自: VueCrack detector.js
//   findVueRoot:       detector.js:16
//   findVueRouter:     detector.js:65
//   listAllRoutes:     detector.js:263
//   extractRouterBase: detector.js:116
//   analyzePageLinks:  detector.js:136
//   walkRoutes/joinPath: 辅助函数
//
// eval 字符串构造采用与 webpack-extractor._enumerateChunksFromRuntime 一致的反引号模板模式。

const VueAnalyzer = {

  // ========== 在页面上下文执行完整分析 ==========
  // 返回 Promise<{ detected, vueVersion, routes:[{path,name}], routerBase, pageAnalysis, currentPath }>
  analyze() {
    return new Promise((resolve) => {
      // 超时保护（参考 webpack-extractor._introspect 模式，Vue 分析设较短）
      const timer = setTimeout(() => resolve({ detected: false, error: 'timeout' }), 15000);

      try {
        chrome.devtools.inspectedWindow.eval(
          this._evalScript,
          (result, isException) => {
            clearTimeout(timer);
            if (isException || !result) {
              resolve({ detected: false, error: isException ? String(isException) : 'no result' });
              return;
            }
            try {
              const parsed = (typeof result === 'string') ? JSON.parse(result) : result;
              resolve(parsed);
            } catch (e) {
              resolve({ detected: false, error: 'parse: ' + e.message });
            }
          }
        );
      } catch (e) {
        clearTimeout(timer);
        resolve({ detected: false, error: e.message });
      }
    });
  },

  // ========== 注入 PassiveMonitor 缓存池（type='vue'）==========
  // routes: [{path, name, ...}]  sourceUrl: 触发分析的页面 URL
  // 返回 { added, skipped }
  injectToMonitor(routes, sourceUrl) {
    if (!routes || !Array.isArray(routes) || routes.length === 0) {
      return { added: 0, skipped: 0 };
    }
    let added = 0, skipped = 0;
    for (const r of routes) {
      const path = r && r.path;
      if (!path || typeof path !== 'string') { skipped++; continue; }
      // 跳过不含 / 的非路径
      if (path.indexOf('/') < 0) { skipped++; continue; }
      // 跳过外链（http(s):// 开头，这类由 monitor 的 url 类负责）
      if (/^https?:\/\//i.test(path)) { skipped++; continue; }

      const norm = this._normalizePath(path);
      // 去重：同一 path 只入一次（PassiveMonitor._paths 已有的跳过）
      if (PassiveMonitor._paths.has(norm)) { skipped++; continue; }

      PassiveMonitor._paths.set(norm, {
        raw: path,
        type: 'vue',
        norm: norm,
        source: sourceUrl || 'vue-router',
        ts: Date.now(),
        meta: r.name ? { name: r.name } : null,
      });
      PassiveMonitor._counts.vue = (PassiveMonitor._counts.vue || 0) + 1;
      added++;
    }
    return { added, skipped };
  },

  // 归一化路由 path（去 query/hash），与 PassiveMonitor._normalize 对齐
  _normalizePath(path) {
    let s = (path || '').trim();
    const hashIdx = s.indexOf('#');
    if (hashIdx >= 0) s = s.substring(0, hashIdx);
    const qIdx = s.indexOf('?');
    if (qIdx >= 0) s = s.substring(0, qIdx);
    return s;
  },

  // ========== eval 执行脚本（反引号模板，在页面 MAIN world 执行）==========
  // 移植 VueCrack detector.js 核心函数，移除 patchRouterGuards / patchAllRouteAuth。
  // 注意：此字符串在页面上下文执行，内部不能引用外部变量/闭包。
  // 反斜杠需双写（\\d），因模板字符串中 \ 是转义符。
  _evalScript: `(function() {
    // ======== 工具函数（移植自 VueCrack detector.js）========

    // 广度优先查找 Vue 根实例（Vue2/3）
    function findVueRoot(root, maxDepth) {
      maxDepth = maxDepth || 1000;
      var commonRoots = [
        document.getElementById('app'),
        document.getElementById('__nuxt'),
        document.getElementById('__layout'),
        document.getElementById('q-app')
      ].filter(Boolean);
      for (var i = 0; i < commonRoots.length; i++) {
        var node = commonRoots[i];
        if (node.__vue_app__ || node.__vue__ || node._vnode) return node;
      }
      var dataVElements = document.querySelectorAll('[data-v]');
      for (var j = 0; j < dataVElements.length; j++) {
        if (dataVElements[j].__vue__ || dataVElements[j].__vue_app__) return dataVElements[j];
      }
      var queue = [{ node: root, depth: 0 }];
      var visited = [];
      while (queue.length && queue.length < 1000) {
        var item = queue.shift();
        var n = item.node, depth = item.depth;
        if (depth > maxDepth) break;
        var visitedHit = false;
        for (var vi = 0; vi < visited.length; vi++) { if (visited[vi] === n) { visitedHit = true; break; } }
        if (visitedHit) continue;
        visited.push(n);
        if (n.__vue_app__ || n.__vue__ || n._vnode) return n;
        if (n.nodeType === 1 && n.childNodes && depth < 3) {
          for (var k = 0; k < n.childNodes.length; k++) {
            queue.push({ node: n.childNodes[k], depth: depth + 1 });
          }
        }
      }
      return null;
    }

    // 快速定位 Vue Router 实例
    function findVueRouter(vueRoot) {
      try {
        if (window.$nuxt && window.$nuxt.$router) return window.$nuxt.$router;
        if (vueRoot.__vue_app__) {
          var app = vueRoot.__vue_app__;
          if (app.config && app.config.globalProperties && app.config.globalProperties.$router) {
            return app.config.globalProperties.$router;
          }
          var instance = app._instance;
          if (instance && instance.appContext && instance.appContext.config.globalProperties.$router) {
            return instance.appContext.config.globalProperties.$router;
          }
        }
        if (vueRoot.__vue__) {
          var vue = vueRoot.__vue__;
          return vue.$router || (vue.$root && vue.$root.$router) ||
                 (vue.$root && vue.$root.$options && vue.$root.$options.router) || vue._router;
        }
      } catch (e) {}
      return null;
    }

    // 从 Router 实例提取基础路径
    function extractRouterBase(router) {
      try {
        if (router.options && router.options.base) return router.options.base;
        if (router.history && router.history.base) return router.history.base;
        return '';
      } catch (e) { return ''; }
    }

    // 分析页面链接，推断基础路径
    function analyzePageLinks() {
      var result = { detectedBasePath: '', commonPrefixes: [] };
      try {
        var links = Array.prototype.slice.call(document.querySelectorAll('a[href]'))
          .map(function (a) { return a.getAttribute('href'); })
          .filter(function (href) {
            return href && href.charAt(0) === '/' && href.charAt(1) !== '/' && href.indexOf('.') < 0;
          });
        if (links.length < 3) return result;
        var firstSegments = {};
        links.forEach(function (link) {
          var segs = link.split('/').filter(Boolean);
          if (segs.length > 0) {
            firstSegments[segs[0]] = (firstSegments[segs[0]] || 0) + 1;
          }
        });
        var sorted = Object.keys(firstSegments).map(function (k) {
          return { prefix: k, count: firstSegments[k] };
        }).sort(function (a, b) { return b.count - a.count; });
        result.commonPrefixes = sorted;
        if (sorted.length > 0 && sorted[0].count / links.length > 0.5) {
          result.detectedBasePath = '/' + sorted[0].prefix;
        }
      } catch (e) {}
      return result;
    }

    // 列出所有路由（完整路径）—— 四级回退（移植自 VueCrack listAllRoutes）
    function listAllRoutes(router) {
      var list = [];
      function joinPath(base, path) {
        if (!path) return base || '/';
        if (path.charAt(0) === '/') return path;
        if (!base || base === '/') return '/' + path;
        return (base.charAt(base.length - 1) === '/' ? base.slice(0, -1) : base) + '/' + path;
      }

      // 优先 Vue Router 4 getRoutes()
      if (typeof router.getRoutes === 'function') {
        try {
          router.getRoutes().forEach(function (r) {
            list.push({ name: r.name, path: r.path });
          });
          return list;
        } catch (e) {}
      }
      // options.routes 递归
      if (router.options && Array.isArray(router.options.routes)) {
        (function traverse(routes, basePath) {
          routes.forEach(function (r) {
            var fullPath = joinPath(basePath, r.path);
            list.push({ name: r.name, path: fullPath });
            if (Array.isArray(r.children) && r.children.length) traverse(r.children, fullPath);
          });
        })(router.options.routes, '');
        return list;
      }
      // matcher.getRoutes()
      if (router.matcher && typeof router.matcher.getRoutes === 'function') {
        router.matcher.getRoutes().forEach(function (r) {
          list.push({ name: r.name, path: r.path });
        });
        return list;
      }
      // history.current.matched（当前路由匹配项）
      if (router.history && router.history.current) {
        var cur = router.history.current;
        if (cur.matched && Array.isArray(cur.matched)) {
          cur.matched.forEach(function (r) {
            list.push({ name: r.name, path: r.path });
          });
          return list;
        }
      }
      return list;
    }

    // 快速检测 Vue
    function quickVueDetection() {
      if (window.Vue || window.$nuxt || window.__VUE_DEVTOOLS_GLOBAL_HOOK__) return true;
      var mountPoints = ['#app', '#__nuxt', '#__layout', '#q-app'];
      for (var i = 0; i < mountPoints.length; i++) {
        var el = document.getElementById(mountPoints[i].substring(1));
        if (el && (el.__vue__ || el.__vue_app__)) return true;
      }
      var hit = document.querySelector('[v-cloak], [v-show], [v-if], [data-v-]');
      return !!hit;
    }

    // ======== 主流程 ========
    var result = {
      detected: false,
      vueVersion: null,
      routes: [],
      routerBase: '',
      pageAnalysis: { detectedBasePath: '', commonPrefixes: [] },
      currentPath: window.location.pathname
    };

    try {
      if (!quickVueDetection()) return JSON.stringify(result);

      var vueRoot = findVueRoot(document.body);
      if (!vueRoot) return JSON.stringify(result);

      result.detected = true;

      try {
        if (vueRoot.__vue_app__) {
          result.vueVersion = vueRoot.__vue_app__.version || 'Vue 3.x';
        } else if (vueRoot.__vue__) {
          result.vueVersion = (vueRoot.__vue__.$root && vueRoot.__vue__.$root.$options &&
            vueRoot.__vue__.$root.$options._base && vueRoot.__vue__.$root.$options._base.version) || 'Vue 2.x';
        } else if (window.Vue) {
          result.vueVersion = window.Vue.version || 'unknown';
        } else {
          result.vueVersion = 'unknown';
        }
      } catch (e) { result.vueVersion = 'unknown'; }

      var router = findVueRouter(vueRoot);
      if (!router) return JSON.stringify(result); // 检测到 Vue 但无 Router

      result.routerBase = extractRouterBase(router);
      result.pageAnalysis = analyzePageLinks();
      result.routes = listAllRoutes(router);

      return JSON.stringify(result);
    } catch (e) {
      result.error = e && e.message ? e.message : String(e);
      return JSON.stringify(result);
    }
  })()`,
};
