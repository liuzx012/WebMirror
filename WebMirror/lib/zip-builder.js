// lib/zip-builder.js — ZIP文件构建器
// 浏览器端ZIP打包，支持deflate压缩，Blob下载

const ZipBuilder = {
  _entries: [],
  _totalSize: 0,

  // 初始化
  init() {
    this._entries = [];
    this._totalSize = 0;
  },

  // CRC32 查表计算
  _crc32Table: null,
  _initCRC32() {
    if (this._crc32Table) return;
    this._crc32Table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      this._crc32Table[i] = c;
    }
  },

  crc32(data) {
    this._initCRC32();
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc = this._crc32Table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  },

  // 添加文件
  async addFile(path, data, mimeType) {
    // 统一转为Uint8Array
    let raw;
    if (typeof data === 'string') {
      raw = new TextEncoder().encode(data);
    } else if (data instanceof ArrayBuffer) {
      raw = new Uint8Array(data);
    } else if (data instanceof Uint8Array) {
      raw = data;
    } else if (data && data.content) {
      // 来自DevTools API的content对象
      if (typeof data.content === 'string') {
        raw = new TextEncoder().encode(data.content);
      } else {
        raw = new Uint8Array(data.content);
      }
    } else {
      raw = new Uint8Array(0);
    }

    let compressed = raw;
    let method = 0; // store (不压缩)

    // 对文本类型尝试deflate压缩
    const textTypes = ['text/', 'application/javascript', 'application/json',
                       'application/xml', 'application/x-javascript', 'image/svg'];
    const isText = textTypes.some(t => (mimeType || '').startsWith(t));

    if (isText && raw.length > 256) {
      try {
        const cs = new CompressionStream('deflate-raw');
        const writer = cs.writable.getWriter();
        const reader = cs.readable.getReader();

        writer.write(raw);
        writer.close();

        const chunks = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }

        const totalLen = chunks.reduce((s, c) => s + c.length, 0);
        if (totalLen < raw.length) {
          compressed = new Uint8Array(totalLen);
          let offset = 0;
          for (const chunk of chunks) {
            compressed.set(chunk, offset);
            offset += chunk.length;
          }
          method = 8; // deflate
        }
      } catch (e) {
        // 压缩失败，使用原始数据
      }
    }

    this._entries.push({
      path,
      raw,
      compressed,
      method,
      crc: this.crc32(raw),
      date: new Date()
    });
    this._totalSize += raw.length;
  },

  // 生成ZIP文件
  async generate() {
    const encoder = new TextEncoder();
    const parts = [];
    const centralDir = [];
    let centralOffset = 0;

    for (const entry of this._entries) {
      const nameBytes = encoder.encode(entry.path);
      const compressed = entry.compressed;
      const uncompressed = entry.raw;

      // 日期转换 (DOS format)
      const d = entry.date;
      const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
      const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

      // Local file header
      const localHeader = new Uint8Array(30 + nameBytes.length);
      const lhView = new DataView(localHeader.buffer);

      lhView.setUint32(0, 0x04034b50, true);  // signature
      lhView.setUint16(4, 20, true);           // version needed (2.0)
      lhView.setUint16(6, 0x0800, true);       // flags (UTF-8)
      lhView.setUint16(8, entry.method, true); // compression method
      lhView.setUint16(10, dosTime, true);     // last mod time
      lhView.setUint16(12, dosDate, true);     // last mod date
      lhView.setUint32(14, entry.crc, true);   // CRC-32
      lhView.setUint32(18, compressed.length, true);  // compressed size
      lhView.setUint32(22, uncompressed.length, true); // uncompressed size
      lhView.setUint16(26, nameBytes.length, true);    // filename length
      lhView.setUint16(28, 0, true);           // extra field length

      localHeader.set(nameBytes, 30);
      parts.push(localHeader);
      parts.push(compressed);

      // Central directory entry
      const cdEntry = new Uint8Array(46 + nameBytes.length);
      const cdView = new DataView(cdEntry.buffer);

      cdView.setUint32(0, 0x02014b50, true);   // signature
      cdView.setUint16(4, 20, true);            // version made by
      cdView.setUint16(6, 20, true);            // version needed
      cdView.setUint16(8, 0x0800, true);        // flags (UTF-8)
      cdView.setUint16(10, entry.method, true); // compression method
      cdView.setUint16(12, dosTime, true);      // last mod time
      cdView.setUint16(14, dosDate, true);      // last mod date
      cdView.setUint32(16, entry.crc, true);    // CRC-32
      cdView.setUint32(20, compressed.length, true);  // compressed size
      cdView.setUint32(24, uncompressed.length, true); // uncompressed size
      cdView.setUint16(28, nameBytes.length, true);    // filename length
      cdView.setUint16(30, 0, true);            // extra field length
      cdView.setUint16(32, 0, true);            // file comment length
      cdView.setUint16(34, 0, true);            // disk number start
      cdView.setUint16(36, 0, true);            // internal file attributes
      cdView.setUint32(38, 0, true);            // external file attributes
      cdView.setUint32(42, centralOffset, true); // relative offset

      cdEntry.set(nameBytes, 46);
      centralDir.push(cdEntry);

      // 更新偏移
      centralOffset += 30 + nameBytes.length + compressed.length;
    }

    // 合并central directory
    const cdCombined = new Uint8Array(
      centralDir.reduce((s, c) => s + c.length, 0)
    );
    let cdPos = 0;
    for (const cd of centralDir) {
      cdCombined.set(cd, cdPos);
      cdPos += cd.length;
    }

    // End of central directory record
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    const cdOffset = centralOffset;
    const cdSize = cdCombined.length;
    const entryCount = this._entries.length;

    eocdView.setUint32(0, 0x06054b50, true);   // signature
    eocdView.setUint16(4, 0, true);             // disk number
    eocdView.setUint16(6, 0, true);             // disk with CD
    eocdView.setUint16(8, entryCount, true);    // entries on disk
    eocdView.setUint16(10, entryCount, true);    // total entries
    eocdView.setUint32(12, cdSize, true);       // CD size
    eocdView.setUint32(16, cdOffset, true);     // CD offset
    eocdView.setUint16(20, 0, true);            // comment length

    // 合并所有部分
    const totalSize = centralOffset + cdSize + 22;
    const zip = new Uint8Array(totalSize);
    let pos = 0;
    for (const part of parts) {
      zip.set(part, pos);
      pos += part.length;
    }
    zip.set(cdCombined, pos);
    pos += cdSize;
    zip.set(eocd, pos);

    return zip;
  },

  // 触发浏览器下载
  download(zipData, filename) {
    const blob = new Blob([zipData], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  // 获取总资源数
  entryCount() {
    return this._entries.length;
  },

  // 获取总原始大小
  totalSize() {
    return this._totalSize;
  }
};
