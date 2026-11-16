#!/usr/bin/env node
/**
 * 纯 Node 打 ZIP（APK），不依赖 zip/aapt。
 * 结构：AndroidManifest.xml + classes.dex + assets/www/*
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d = new Date()) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

function buildZip(entries) {
  const { time, date } = dosTime();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = Buffer.from(e.name, 'utf8');
    const raw = e.data;
    const comp = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBytes, comp);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + comp.length;
  }

  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

function walk(dir, prefix = '', out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = prefix ? prefix + '/' + name : name;
    if (fs.statSync(full).isDirectory()) walk(full, rel, out);
    else out.push({ name: rel, data: fs.readFileSync(full) });
  }
  return out;
}

if (require.main === module) {
  // usage: node pack.js <out.apk> [--root <dir>]
  // <dir> must contain AndroidManifest.xml, classes.dex and assets/www/
  const args = process.argv.slice(2);
  const ri = args.indexOf('--root');
  const root = ri >= 0 ? path.resolve(args[ri + 1]) : __dirname;
  const outApk = args[0] && args[0] !== '--root' ? args[0] : path.join(root, 'flightradar-unsigned.apk');

  const manifest = fs.readFileSync(path.join(root, 'AndroidManifest.xml'));
  const dexPath = path.join(root, 'classes.dex');
  if (!fs.existsSync(dexPath)) {
    console.error('缺少 classes.dex，先跑 d8');
    process.exit(1);
  }
  if (!fs.existsSync(dexPath)) {
    console.error('缺少 classes.dex，先跑 d8');
    process.exit(1);
  }
  const dex = fs.readFileSync(dexPath);
  const wwwDir = path.join(root, 'assets', 'www');
  const www = walk(wwwDir).map((e) => ({ name: 'assets/www/' + e.name, data: e.data }));

  const entries = [
    { name: 'AndroidManifest.xml', data: manifest },
    { name: 'classes.dex', data: dex },
    ...www,
  ];
  const zip = buildZip(entries);
  fs.writeFileSync(outApk, zip);
  console.log(`wrote ${outApk}  ${zip.length} bytes  (${entries.length} entries)`);
  for (const e of entries) console.log(`  ${e.name}  ${e.data.length}`);
}

module.exports = { buildZip, walk };
