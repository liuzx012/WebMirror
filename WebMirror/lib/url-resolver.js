// lib/url-resolver.js — URL → 文件系统路径转换
// 保留远程目录结构，处理特殊协议和Data URI

const UrlResolver = {

  // 将URL解析为本地文件路径
  // 返回 { path, filename, isDataURI }
  resolve(url, mimeType, content) {
    if (!url) return { path: '_unknown/no-url', filename: 'unknown.bin', isDataURI: false };

    // Data URI 处理
    if (url.startsWith('data:')) {
      return this._resolveDataURI(url, mimeType);
    }

    // 非标准协议处理
    if (!url.includes('://')) {
      return this._resolvePathLike(url, mimeType);
    }

    try {
      const parsed = new URL(url);
      let host = parsed.host;
      let pathname = decodeURIComponent(parsed.pathname || '');

      // 移除前导斜杠
      if (pathname.startsWith('/')) pathname = pathname.substring(1);

      // 处理空路径（首页）
      if (!pathname || pathname.endsWith('/')) {
        pathname = pathname + 'index.html';
      }

      // 处理无扩展名的路径段
      const segments = pathname.split('/');
      const lastSegment = segments[segments.length - 1];
      if (lastSegment && !lastSegment.includes('.')) {
        pathname = pathname + '.html';
      }

      // 清理路径中的非法字符
      pathname = this._sanitizePath(pathname);

      const dir = host;
      const fullPath = dir + '/' + pathname;

      return {
        path: fullPath,
        filename: lastSegment || 'index.html',
        isDataURI: false,
        host: host,
        originalUrl: url
      };
    } catch (e) {
      return this._resolvePathLike(url, mimeType);
    }
  },

  // Data URI 解析
  _resolveDataURI(url, mimeType) {
    const match = url.match(/^data:([^;]*)(;base64)?,(.*)$/);
    let mime = mimeType || (match && match[1]) || 'application/octet-stream';
    const isBase64 = match && match[2];
    let ext = Utils.mimeToExtension(mime) || '.bin';

    const hash = Utils.uid();
    return {
      path: '_DataURI/' + hash + ext,
      filename: hash + ext,
      isDataURI: true,
      mimeType: mime,
      isBase64: !!isBase64
    };
  },

  // 类路径的URL（webpack://, chrome-extension:// 等）
  _resolvePathLike(url, mimeType) {
    let clean = url.replace(/^(webpack|ng|chrome-extension|moz-extension|resource):\/\//, '$1---');
    clean = this._sanitizePath(clean);

    if (!clean || clean === '/') clean = 'index.html';
    if (!clean.includes('.') && mimeType) {
      const ext = Utils.mimeToExtension(mimeType);
      if (ext) clean += ext;
    }

    return {
      path: '_Special/' + clean,
      filename: clean.split('/').pop(),
      isDataURI: false
    };
  },

  // 清理路径中的非法字符
  _sanitizePath(path) {
    return path
      .replace(/[<>:"|?*\\]/g, '_')
      .replace(/\/+/g, '/')
      .replace(/^\/+/, '')
      .replace(/\0/g, '');
  }
};
