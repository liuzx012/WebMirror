// lib/sensitive-scanner.js — 敏感信息扫描引擎
// 移植自 HaE (Hack and Extractor) 规则集，用于分析捕获的JS/HTML/JSON资源
// 匹配 API密钥、令牌、密码、内网IP、数据库连接串等敏感信息

const SensitiveScanner = {

  // ========== 默认规则定义 ==========
  // 每组规则: { name, regex, severity, group, description }
  // severity: critical > high > medium > low
  _defaultRules: [
    // ---- Critical ----
    { name: 'Aliyun AK',       regex: /LTAI[a-z0-9]{12,20}/gi,               severity: 'critical', group: 'Sensitive', desc: '阿里云 AccessKey ID' },
    { name: 'JDBC Connection', regex: /jdbc:[a-z]+:\/\/[^\s"'<>){}\]]+/gi,   severity: 'critical', group: 'Sensitive', desc: 'JDBC数据库连接串' },
    { name: 'Auth Basic',      regex: /basic [a-z0-9=:_\+\/\-]{10,100}/gi,    severity: 'critical', group: 'Sensitive', desc: 'HTTP Basic认证令牌' },
    { name: 'Auth Bearer',     regex: /bearer [a-z0-9\-._~+\/]+=*/gi,         severity: 'critical', group: 'Sensitive', desc: 'Bearer Token' },
    { name: 'Generic Secret',  regex: /(?:secret|token|api[_-]?key)\s*[:=]\s*['"]([^'"]{8,})['"]/gi, severity: 'critical', group: 'Sensitive', desc: '通用密钥/Token赋值' },

    // ---- High ----
    { name: 'Password Field',  regex: /(?:pass|pwd|passwd|password)\s*[:=]\s*['"]([^'"]{1,})['"]/gi, severity: 'high', group: 'Sensitive', desc: '密码字段赋值' },
    { name: 'JWT Token',       regex: /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{0,}/g, severity: 'high', group: 'Fingerprint', desc: 'JWT令牌' },
    { name: 'Chinese ID Card', regex: /[^0-9](\d{17}[\dXx])[^0-9]/g,         severity: 'high', group: 'Basic', desc: '中国身份证号' },
    { name: 'Config Secret',   regex: /(?:secret|token|password|passwd)\s*(?:=|:)\s*[^,\s}]{6,}/gi, severity: 'high', group: 'Sensitive', desc: '配置中的机密信息' },

    // ---- Medium ----
    { name: 'Internal IP',     regex: /(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})/g, severity: 'medium', group: 'Basic', desc: '内网IP地址' },
    { name: 'Email Address',   regex: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g, severity: 'medium', group: 'Basic', desc: '电子邮箱' },
    { name: 'Windows Path',    regex: /[a-zA-Z]:\\(?:[^<>:"/\\|?*\r\n]+\\)*[^<>:"/\\|?*\r\n]*/g, severity: 'medium', group: 'Sensitive', desc: 'Windows文件路径' },
    { name: 'Chinese Mobile',  regex: /1[3-9]\d{9}/g,                         severity: 'medium', group: 'Basic', desc: '中国手机号' },
    { name: 'MAC Address',     regex: /(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}/g, severity: 'medium', group: 'Basic', desc: 'MAC地址' },

    // ---- Low ----
    { name: 'Source Map',      regex: /\/\/#\s*sourceMappingURL\s*=\s*(\S+)/gi, severity: 'low', group: 'Other', desc: 'Source Map引用' },
    { name: 'Swagger UI',      regex: /swagger-ui\.html|\"swagger\"\s*:|Swagger UI|swaggerUi/gi, severity: 'low', group: 'Fingerprint', desc: 'Swagger API文档' },
    { name: 'Druid Monitor',   regex: /Druid Stat Index/gi,                   severity: 'low', group: 'Fingerprint', desc: 'Druid监控面板' },
    { name: 'Vite Dev',        regex: /\/@vite\/client/gi,                    severity: 'low', group: 'Fingerprint', desc: 'Vite开发模式' },
    { name: 'All URL',         regex: /https?:\/\/[^\s"'<>){}\]\u4e00-\u9fff]{8,}/gi, severity: 'low', group: 'Other', desc: '外部URL引用' },
  ],

  // ========== 活跃规则 ==========
  rules: [],

  // ========== 扫描目标MIME类型 ==========
  _textMimePrefixes: ['text/', 'application/javascript', 'application/json',
                      'application/xml', 'application/x-javascript', 'image/svg'],

  // ========== 初始化 ==========

  // 深拷贝规则数组（保留RegExp对象）
  _cloneRules(sourceRules) {
    return sourceRules.map(r => ({
      name: r.name,
      regex: (r.regex instanceof RegExp) ? new RegExp(r.regex.source, r.regex.flags) : new RegExp(r.regex, 'gi'),
      severity: r.severity,
      group: r.group,
      desc: r.desc || '',
    }));
  },

  // 将序列化规则还原（从storage加载时regex是字符串）
  _deserializeRules(serialized) {
    if (!Array.isArray(serialized)) return this._cloneRules(this._defaultRules);
    return serialized.map(r => ({
      name: r.name,
      regex: new RegExp(r.regex || '^$', 'gi'),
      severity: r.severity || 'low',
      group: r.group || 'Custom',
      desc: r.desc || '',
    }));
  },

  init() {
    // 尝试从storage加载自定义规则，失败则用默认
    return new Promise((resolve) => {
      const useDefaults = () => {
        this.rules = this._cloneRules(this._defaultRules);
        resolve(this.rules);
      };
      try {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
          useDefaults();
          return;
        }
        chrome.storage.local.get(['webmirror_scan_rules'], (result) => {
          if (chrome.runtime.lastError || !result || !result.webmirror_scan_rules) {
            useDefaults();
            return;
          }
          try {
            this.rules = this._deserializeRules(result.webmirror_scan_rules);
            resolve(this.rules);
          } catch (e) {
            useDefaults();
          }
        });
      } catch (e) {
        useDefaults();
      }
    });
  },

  // 同步初始化（面板环境可用）
  initSync() {
    this.rules = this._cloneRules(this._defaultRules);
  },

  // ========== 判断是否应扫描此资源 ==========
  _shouldScan(mimeType) {
    if (!mimeType) return false;
    const mime = mimeType.toLowerCase();
    if (mime === 'text/plain') return true;
    return this._textMimePrefixes.some(p => mime.startsWith(p));
  },

  // ========== 扫描单个资源内容 ==========
  // content: string 或 Uint8Array
  // mimeType: MIME类型
  // filePath: 资源在ZIP中的路径
  // 返回: Hit[] [{ rule, match, filePath, severity, group }]
  scanContent(content, mimeType, filePath) {
    if (!content || !this._shouldScan(mimeType)) return [];

    let text;
    if (typeof content === 'string') {
      text = content;
    } else if (content instanceof Uint8Array || content instanceof ArrayBuffer) {
      try {
        const arr = content instanceof Uint8Array ? content : new Uint8Array(content);
        text = new TextDecoder('utf-8', { fatal: true }).decode(arr);
      } catch (e) {
        return []; // 不是有效UTF-8文本，跳过
      }
    } else {
      return [];
    }

    const hits = [];
    const activeRules = this.rules.length > 0 ? this.rules : this._defaultRules;

    for (const rule of activeRules) {
      // 获取有效的正则对象
      let regex;
      if (rule.regex instanceof RegExp) {
        regex = new RegExp(rule.regex.source, rule.regex.flags || 'gi');
      } else if (typeof rule.regex === 'string') {
        regex = new RegExp(rule.regex, 'gi');
      } else {
        continue; // 无效规则，跳过
      }
      regex.lastIndex = 0;

      let match;
      let ruleHitCount = 0;
      while ((match = regex.exec(text)) !== null) {
        // 防止无限循环（零宽匹配）
        if (match[0].length === 0) {
          if (regex.lastIndex >= text.length) break;
          regex.lastIndex++;
          continue;
        }
        hits.push({
          rule: rule.name,
          severity: rule.severity,
          group: rule.group,
          desc: rule.desc || '',
          match: match[0].length > 120 ? match[0].substring(0, 120) + '...' : match[0],
          filePath: filePath,
        });
        ruleHitCount++;
        // 限制每条规则最多返回100个匹配，防止性能问题
        if (ruleHitCount >= 100) break;
      }
    }

    return hits;
  },

  // ========== 批量扫描资源 ==========
  // resources: Map<path, {content, mimeType}>  或 普通对象
  // htmlSources: Map<path, htmlString>
  // 返回: { hits: Hit[], hitPaths: Map<path, count> }
  scanBatch(resources, htmlSources) {
    const hits = [];
    const hitPaths = new Map();

    // 扫描资源
    if (resources) {
      const entries = resources instanceof Map ? [...resources.entries()] : Object.entries(resources);
      for (const [path, res] of entries) {
        if (!res) continue;
        const content = res.content || res;
        const mimeType = res.mimeType || 'text/plain';
        const fileHits = this.scanContent(content, mimeType, path);
        if (fileHits.length > 0) {
          hits.push(...fileHits);
          hitPaths.set(path, (hitPaths.get(path) || 0) + fileHits.length);
        }
      }
    }

    // 扫描HTML源码
    if (htmlSources) {
      const htmlEntries = htmlSources instanceof Map ? [...htmlSources.entries()] : Object.entries(htmlSources);
      for (const [path, html] of htmlEntries) {
        if (!html) continue;
        const fileHits = this.scanContent(html, 'text/html', path);
        if (fileHits.length > 0) {
          hits.push(...fileHits);
          hitPaths.set(path, (hitPaths.get(path) || 0) + fileHits.length);
        }
      }
    }

    return { hits, hitPaths };
  },

  // ========== 生成 HaE 格式报告文本 ==========
  generateReport(hits, domain) {
    const now = new Date().toLocaleString('zh-CN');
    const bySeverity = { critical: [], high: [], medium: [], low: [] };
    const fileSet = new Set();

    for (const hit of hits) {
      (bySeverity[hit.severity] || (bySeverity[hit.severity] = [])).push(hit);
      fileSet.add(hit.filePath);
    }

    const lines = [];
    lines.push('========================================');
    lines.push('WebMirror HaE 敏感信息扫描报告');
    lines.push('目标域名: ' + (domain || '未知'));
    lines.push('扫描时间: ' + now);
    lines.push('匹配规则: ' + this.rules.length + '条 | 命中: ' + hits.length + '处');
    lines.push('========================================');
    lines.push('');

    const sevLabels = { critical: 'CRITICAL', high: 'HIGH', medium: 'MEDIUM', low: 'LOW' };
    const ordered = ['critical', 'high', 'medium', 'low'];

    for (const sev of ordered) {
      const arr = bySeverity[sev];
      if (!arr || arr.length === 0) continue;
      for (const hit of arr) {
        lines.push('[' + sevLabels[sev] + '] ' + hit.rule + ' — ' + hit.filePath);
        lines.push('  匹配: ' + hit.match);
        lines.push('');
      }
    }

    lines.push('========================================');
    const counts = ordered.map(s => sevLabels[s] + ' ' + (bySeverity[s] || []).length).join(' | ');
    lines.push('统计: ' + counts + ' | 总计 ' + hits.length);
    lines.push('覆盖文件: ' + fileSet.size + '个');
    lines.push('========================================');

    return lines.join('\n');
  },

  // ========== 规则管理 ==========

  // 导出当前规则为JSON字符串
  exportRules() {
    const active = this.rules.length > 0 ? this.rules : this._defaultRules;
    return JSON.stringify({
      name: 'WebMirror HaE Rules',
      version: '2.0',
      exported: new Date().toISOString(),
      rules: active.map(r => ({
        name: r.name,
        regex: typeof r.regex === 'string' ? r.regex : r.regex.source,
        severity: r.severity,
        group: r.group,
        desc: r.desc || '',
      })),
    }, null, 2);
  },

  // 导入规则JSON
  // jsonStr: JSON字符串
  // replace: true=替换现有规则, false=合并
  // 返回: { success: boolean, count: number, message: string }
  importRules(jsonStr, replace) {
    try {
      const data = JSON.parse(jsonStr);
      if (!data.rules || !Array.isArray(data.rules)) {
        return { success: false, count: 0, message: '格式无效：缺少 rules 数组' };
      }

      const imported = data.rules.map(r => ({
        name: r.name || 'Unknown',
        regex: new RegExp(r.regex || '^$', 'gi'),
        severity: r.severity || 'low',
        group: r.group || 'Custom',
        desc: r.desc || '',
      }));

      if (imported.length === 0) {
        return { success: false, count: 0, message: '没有有效的规则' };
      }

      if (replace) {
        this.rules = imported;
      } else {
        this.rules = [...this.rules, ...imported];
      }

      // 持久化到 chrome.storage
      this._persistRules();

      return { success: true, count: imported.length, message: '成功导入 ' + imported.length + ' 条规则' };
    } catch (e) {
      return { success: false, count: 0, message: '解析失败: ' + e.message };
    }
  },

  // 恢复默认规则
  resetRules() {
    this.rules = this._cloneRules(this._defaultRules);
    this._persistRules();
    return { success: true, count: this._defaultRules.length, message: '已恢复默认 ' + this._defaultRules.length + ' 条规则' };
  },

  // 持久化规则到 chrome.storage.local
  _persistRules() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const serializable = this.rules.map(r => ({
          name: r.name,
          regex: typeof r.regex === 'string' ? r.regex : r.regex.source,
          severity: r.severity,
          group: r.group,
          desc: r.desc || '',
        }));
        chrome.storage.local.set({ webmirror_scan_rules: serializable }, () => {
          if (chrome.runtime.lastError) {
            console.warn('SensitiveScanner: 规则持久化失败', chrome.runtime.lastError);
          }
        });
      }
    } catch (e) {
      console.warn('SensitiveScanner: storage 不可用', e);
    }
  },

  // 获取严重级别对应的CSS类
  severityClass(severity) {
    const map = { critical: 'critical', high: 'high', medium: 'medium', low: 'low' };
    return map[severity] || 'low';
  },
};

// 初始化默认规则
SensitiveScanner.initSync();
