// lib/utils.js — 通用工具函数

const Utils = {
  // 防抖
  debounce(fn, delay) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  },

  // 休眠
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  },

  // 格式化字节
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  },

  // MIME类型映射
  mimeToExtension(mime) {
    const map = {
      'text/html': '.html',
      'text/css': '.css',
      'text/javascript': '.js',
      'application/javascript': '.js',
      'application/x-javascript': '.js',
      'application/json': '.json',
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/gif': '.gif',
      'image/svg+xml': '.svg',
      'image/webp': '.webp',
      'image/x-icon': '.ico',
      'image/vnd.microsoft.icon': '.ico',
      'font/woff': '.woff',
      'font/woff2': '.woff2',
      'font/ttf': '.ttf',
      'font/otf': '.otf',
      'application/font-woff': '.woff',
      'application/font-woff2': '.woff2',
      'application/x-font-ttf': '.ttf',
      'application/x-font-opentype': '.otf',
      'application/octet-stream': '',
      'application/xml': '.xml',
      'text/xml': '.xml',
      'video/mp4': '.mp4',
      'video/webm': '.webm',
      'audio/mpeg': '.mp3',
      'audio/wav': '.wav',
    };
    return map[mime] || '';
  },

  // 根据内容魔数推断文件扩展名
  detectExtensionByMagic(bytes) {
    if (!bytes || bytes.length < 4) return '';
    const head = new Uint8Array(bytes.slice(0, 4));
    // PNG
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47) return '.png';
    // JPEG
    if (head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF) return '.jpg';
    // GIF
    if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) return '.gif';
    // WebP
    if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46) return '.webp';
    // SVG (text check)
    const str = String.fromCharCode.apply(null, Array.from(head));
    if (str.startsWith('<svg') || str.startsWith('<?xml')) return '.svg';
    // WOFF
    if (head[0] === 0x77 && head[1] === 0x4F && head[2] === 0x46 && head[3] === 0x46) return '.woff';
    // WOFF2
    if (head[0] === 0x77 && head[1] === 0x4F && head[2] === 0x46 && head[3] === 0x32) return '.woff2';
    return '';
  },

  // 生成唯一ID
  uid() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  },

  // 安全获取URL的host
  getHost(url) {
    try { return new URL(url).host; } catch (e) { return ''; }
  },

  // 是否为同域
  isSameDomain(url1, url2) {
    return Utils.getHost(url1) === Utils.getHost(url2);
  }
};
