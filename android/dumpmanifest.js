#!/usr/bin/env node
/**
 * AXML 校验器：把二进制清单解回可读的树，用来核对编码是否正确
 * （chunk 类型、大小、字符串池、资源映射表、属性 typedValue 全部验一遍）。
 */
'use strict';
const fs = require('fs');

const T = {
  0x0001: 'STRING_POOL', 0x0180: 'RESOURCE_MAP', 0x0100: 'START_NS',
  0x0101: 'END_NS', 0x0102: 'START_EL', 0x0103: 'END_EL',
};
const TYPE_NAMES = {
  0x00: 'null', 0x01: 'ref', 0x02: 'attr', 0x03: 'string', 0x04: 'float',
  0x05: 'dimension', 0x06: 'fraction', 0x10: 'int', 0x11: 'hex', 0x12: 'bool',
};

function parsePool(buf, start) {
  const headerSize = buf.readUInt16LE(start + 2);
  const size = buf.readUInt32LE(start + 4);
  const count = buf.readUInt32LE(start + 8);
  const flags = buf.readUInt32LE(start + 16);
  const stringsStart = buf.readUInt32LE(start + 20);
  const utf8 = (flags & 0x100) !== 0;
  const strings = [];
  for (let i = 0; i < count; i++) {
    let off = start + stringsStart + buf.readUInt32LE(start + headerSize + i * 4);
    let chars = 0, bytes = 0;
    if (utf8) {
      let b = buf[off++];
      if (b & 0x80) { chars = ((b & 0x7f) << 8) | buf[off++]; } else chars = b;
      b = buf[off++];
      if (b & 0x80) { bytes = ((b & 0x7f) << 8) | buf[off++]; } else bytes = b;
      strings.push(buf.slice(off, off + bytes).toString('utf8'));
    } else {
      let n = buf.readUInt16LE(off); off += 2;
      if (n & 0x8000) { n = ((n & 0x7fff) << 16) | buf.readUInt16LE(off); off += 2; }
      strings.push(buf.slice(off, off + n * 2).toString('utf16le'));
    }
  }
  return { size, strings };
}

function dump(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt16LE(0) !== 0x0003) throw new Error('不是 AXML（type != 0x0003）');
  const declared = buf.readUInt32LE(4);
  if (declared !== buf.length) throw new Error(`头部声明大小 ${declared} != 实际 ${buf.length}`);

  let off = 8;
  let strings = null;
  let resIds = [];
  const lines = [];
  let depth = 0;

  while (off < buf.length) {
    const type = buf.readUInt16LE(off);
    const headerSize = buf.readUInt16LE(off + 2);
    const size = buf.readUInt32LE(off + 4);
    if (size <= 0 || off + size > buf.length) throw new Error(`chunk @${off} 尺寸非法: ${size}`);
    if (headerSize < 8 || headerSize > size) throw new Error(`chunk @${off} headerSize 非法: ${headerSize}`);

    if (type === 0x0001) {
      const pool = parsePool(buf, off);
      strings = pool.strings;
      lines.push(`[STRING_POOL] count=${pool.strings.length} size=${size}`);
    } else if (type === 0x0180) {
      const n = (size - 8) / 4;
      for (let i = 0; i < n; i++) resIds.push(buf.readUInt32LE(off + 8 + i * 4));
      lines.push(`[RESOURCE_MAP] ids=${n} -> ${resIds.map((x) => '0x' + x.toString(16)).join(',')}`);
    } else if (type === 0x0100 || type === 0x0101) {
      const prefix = strings[buf.readUInt32LE(off + headerSize)];
      const uri = strings[buf.readUInt32LE(off + headerSize + 4)];
      lines.push(`${type === 0x0100 ? '[START_NS]' : '[END_NS]'} ${prefix}=${uri}`);
    } else if (type === 0x0102) {
      const ns = buf.readUInt32LE(off + headerSize);
      const name = strings[buf.readUInt32LE(off + headerSize + 4)];
      const attrStart = buf.readUInt16LE(off + headerSize + 8);
      const attrSize = buf.readUInt16LE(off + headerSize + 10);
      const attrCount = buf.readUInt16LE(off + headerSize + 12);
      const attrs = [];
      for (let i = 0; i < attrCount; i++) {
        const a = off + headerSize + attrStart + i * attrSize;
        const aNs = buf.readUInt32LE(a);
        const aNameIdx = buf.readUInt32LE(a + 4);
        const aRaw = buf.readUInt32LE(a + 8);
        const aType = buf.readUInt8(a + 15);
        const aData = buf.readUInt32LE(a + 16);
        const nameStr = strings[aNameIdx];
        const resId = aNameIdx < resIds.length ? resIds[aNameIdx] : 0;
        let val;
        if (aType === 0x03) val = JSON.stringify(strings[aData]);
        else if (aType === 0x12) val = aData ? 'true' : 'false';
        else if (aType === 0x10) val = String(aData);
        else val = `type=0x${aType.toString(16)} data=0x${aData.toString(16)}`;
        attrs.push(`${aNs !== 0xffffffff ? 'android:' : ''}${nameStr}(0x${resId.toString(16)})=${val}`);
      }
      lines.push(`${'  '.repeat(depth)}<${name}` + (attrs.length ? ' ' + attrs.join(' ') : '') + '>');
      depth++;
    } else if (type === 0x0103) {
      depth--;
      const name = strings[buf.readUInt32LE(off + headerSize + 4)];
      lines.push(`${'  '.repeat(Math.max(depth, 0))}</${name}>`);
    } else {
      lines.push(`[UNKNOWN type=0x${type.toString(16)} size=${size}]`);
    }
    off += size;
  }
  if (off !== buf.length) throw new Error(`chunk 链未对齐: 结束于 ${off}, 文件 ${buf.length}`);
  return lines.join('\n');
}

if (require.main === module) {
  const file = process.argv[2] || 'AndroidManifest.xml';
  try {
    console.log(dump(file));
    process.exit(0);
  } catch (e) {
    console.error('DECODE FAILED:', e.message);
    process.exit(1);
  }
}

module.exports = { dump };
