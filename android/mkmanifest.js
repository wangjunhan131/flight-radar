#!/usr/bin/env node
/**
 * 手写 Android 二进制 XML（AXML）清单生成器。
 *
 * 为什么手写：本机 tools/bt 里的 aapt/aapt2 是 x86-64 ELF，arm64 跑不了
 * （Exec format error），所以不能走 aapt 的标准打包流程。
 *
 * 编码严格按 AOSP libandroidfw/ResourceTypes.cpp 的格式：
 *   ResXMLTree_header
 *   -> ResStringPool   (UTF-8 池，属性名字符串排在最前面，与资源映射表对齐)
 *   -> ResXMLTree_resourceMap (索引 i 对应字符串池第 i 项)
 *   -> StartNamespace / StartElement / EndElement / EndNamespace
 * 属性按 resourceId 升序排列（与 aapt 一致）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ---------- 常量 ----------
const RES_XML_TYPE = 0x0003;
const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_RESOURCE_MAP_TYPE = 0x0180;
const RES_XML_START_NAMESPACE_TYPE = 0x0100;
const RES_XML_END_NAMESPACE_TYPE = 0x0101;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const RES_XML_END_ELEMENT_TYPE = 0x0103;

const TYPE_REFERENCE = 0x01;
const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_BOOLEAN = 0x12;

const UTF8_FLAG = 0x00000100;
const NO_ENTRY = 0xFFFFFFFF;

const ANDROID_NS = 'http://schemas.android.com/apk/res/android';

// 从 android.jar 的 android.R$attr 里核对过的资源 id
const ATTR = {
  versionCode: { name: 'versionCode', id: 0x0101021b },
  versionName: { name: 'versionName', id: 0x0101021c },
  minSdkVersion: { name: 'minSdkVersion', id: 0x0101020c },
  targetSdkVersion: { name: 'targetSdkVersion', id: 0x01010270 },
  name: { name: 'name', id: 0x01010003 },
  label: { name: 'label', id: 0x01010001 },
  exported: { name: 'exported', id: 0x01010010 },
  configChanges: { name: 'configChanges', id: 0x0101001f },
  allowBackup: { name: 'allowBackup', id: 0x01010280 },
  usesCleartextTraffic: { name: 'usesCleartextTraffic', id: 0x010104ec },
  // package 是 manifest 元素自己的属性，没有资源 id
  pkg: { name: 'package', id: 0 },
};

// ---------- 字符串池 ----------
function encodeUtf8Length(n) {
  // UTF-8 池的字符串长度前缀：>0x7F 用两字节（高 7 位打标记）
  if (n > 0x7f) return Buffer.from([((n >> 8) & 0x7f) | 0x80, n & 0xff]);
  return Buffer.from([n & 0xff]);
}

function stringPoolChunk(strings) {
  const encoded = strings.map((s) => {
    const bytes = Buffer.from(s, 'utf8');
    // 字符数按 UTF-16 码元算，与 aapt 一致
    const chars = [...s].reduce((n, ch) => n + (ch.codePointAt(0) > 0xffff ? 2 : 1), 0);
    return Buffer.concat([
      encodeUtf8Length(chars),
      encodeUtf8Length(bytes.length),
      bytes,
      Buffer.from([0]),
    ]);
  });

  const offsets = [];
  let cursor = 0;
  for (const e of encoded) {
    offsets.push(cursor);
    cursor += e.length;
  }
  let data = Buffer.concat(encoded);
  const pad = (4 - (data.length % 4)) % 4;
  if (pad) data = Buffer.concat([data, Buffer.alloc(pad)]);

  const headerSize = 28; // 8 header + 20 pool 头
  const stringsStart = headerSize + offsets.length * 4;
  const size = stringsStart + data.length;

  const buf = Buffer.alloc(size);
  buf.writeUInt16LE(RES_STRING_POOL_TYPE, 0);
  buf.writeUInt16LE(headerSize, 2);
  buf.writeUInt32LE(size, 4);
  buf.writeUInt32LE(strings.length, 8);
  buf.writeUInt32LE(0, 12); // styleCount
  buf.writeUInt32LE(UTF8_FLAG, 16);
  buf.writeUInt32LE(stringsStart, 20);
  buf.writeUInt32LE(0, 24); // stylesStart

  offsets.forEach((off, i) => buf.writeUInt32LE(off, headerSize + i * 4));
  data.copy(buf, stringsStart);
  return buf;
}

function resourceMapChunk(ids) {
  const size = 8 + ids.length * 4;
  const buf = Buffer.alloc(size);
  buf.writeUInt16LE(RES_XML_RESOURCE_MAP_TYPE, 0);
  buf.writeUInt16LE(8, 2);
  buf.writeUInt32LE(size, 4);
  ids.forEach((id, i) => buf.writeUInt32LE(id >>> 0, 8 + i * 4));
  return buf;
}

function chunk(type, headerSize, body) {
  const size = 8 + body.length;
  const head = Buffer.alloc(8);
  head.writeUInt16LE(type, 0);
  head.writeUInt16LE(headerSize, 2);
  head.writeUInt32LE(size, 4);
  return Buffer.concat([head, body]);
}

// 节点通用头：lineNumber + comment
function nodeHeader(line, comment) {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(line >>> 0, 0);
  b.writeUInt32LE((comment == null ? NO_ENTRY : comment) >>> 0, 4);
  return b;
}

function startNamespace(prefixIdx, uriIdx, line = 1) {
  const body = Buffer.alloc(16);
  nodeHeader(line).copy(body, 0);
  body.writeUInt32LE(prefixIdx >>> 0, 8);
  body.writeUInt32LE(uriIdx >>> 0, 12);
  return chunk(RES_XML_START_NAMESPACE_TYPE, 16, body);
}

function endNamespace(prefixIdx, uriIdx, line = 1) {
  const body = Buffer.alloc(16);
  nodeHeader(line).copy(body, 0);
  body.writeUInt32LE(prefixIdx >>> 0, 8);
  body.writeUInt32LE(uriIdx >>> 0, 12);
  return chunk(RES_XML_END_NAMESPACE_TYPE, 16, body);
}

function startElement(nameIdx, attrs, line) {
  // attrs: { ns, name, raw, type, data }
  const sorted = [...attrs].sort((a, b) => {
    const ra = ATTR_ID_BY_NAME.get(a.name) || 0;
    const rb = ATTR_ID_BY_NAME.get(b.name) || 0;
    return ra - rb;
  });
  const body = Buffer.alloc(28 + sorted.length * 20);
  nodeHeader(line).copy(body, 0);
  body.writeUInt32LE(NO_ENTRY >>> 0, 8); // 元素本身无命名空间（必须是 0xFFFFFFFF）
  body.writeUInt32LE(nameIdx >>> 0, 12);
  body.writeUInt16LE(20, 16); // attributeStart
  body.writeUInt16LE(20, 18); // attributeSize
  body.writeUInt16LE(sorted.length, 20);
  body.writeUInt16LE(0, 22); // idIndex
  body.writeUInt16LE(0, 24); // classIndex
  body.writeUInt16LE(0, 26); // styleIndex
  let off = 28;
  for (const a of sorted) {
    body.writeUInt32LE((a.ns == null ? NO_ENTRY : a.ns) >>> 0, off);
    body.writeUInt32LE(a.name >>> 0, off + 4);
    body.writeUInt32LE((a.raw == null ? NO_ENTRY : a.raw) >>> 0, off + 8);
    body.writeUInt16LE(8, off + 12); // typedValue.size
    body.writeUInt8(0, off + 14); // res0
    body.writeUInt8(a.type, off + 15);
    body.writeUInt32LE(a.data >>> 0, off + 16);
    off += 20;
  }
  return chunk(RES_XML_START_ELEMENT_TYPE, 16, body);
}

function endElement(nameIdx, line) {
  // 结束标签的 body = lineNumber/comment（属于 chunk 头部）+ ns + name
  const body = Buffer.alloc(16);
  nodeHeader(line).copy(body, 0);
  body.writeUInt32LE(NO_ENTRY >>> 0, 8); // ns
  body.writeUInt32LE(nameIdx >>> 0, 12);
  return chunk(RES_XML_END_ELEMENT_TYPE, 16, body);
}

// ---------- 文档构建 ----------
let ATTR_ID_BY_NAME = new Map();

function buildManifest(versionCode, versionName, label) {
  // 字符串池：属性名（与资源映射表逐项对齐）→ 命名空间 → 元素名 → 值
  const attrNames = [
    ATTR.versionCode, ATTR.versionName, ATTR.minSdkVersion, ATTR.targetSdkVersion,
    ATTR.name, ATTR.label, ATTR.exported, ATTR.configChanges,
    ATTR.allowBackup, ATTR.usesCleartextTraffic, ATTR.pkg,
  ];
  const strings = [];
  const idx = new Map();
  const add = (s) => {
    if (!idx.has(s)) {
      idx.set(s, strings.length);
      strings.push(s);
    }
    return idx.get(s);
  };
  const resIds = [];
  for (const a of attrNames) {
    add(a.name);
    resIds.push(a.id);
  }
  ATTR_ID_BY_NAME = new Map(attrNames.map((a) => [a.name, a.id]));

  const id = (s) => add(s);
  const nsPrefix = id('android');
  const nsUri = id(ANDROID_NS);

  const el = (n) => id(n);
  const strVal = (v) => id(v);

  const chunks = [];

  // <manifest package=... android:versionCode=... android:versionName=...>
  chunks.push(startNamespace(nsPrefix, nsUri, 1));
  const manifestAttrs = [
    { ns: null, name: id('package'), raw: strVal('com.example.flightradar'), type: TYPE_STRING, data: strVal('com.example.flightradar') },
    { ns: nsUri, name: id('versionCode'), raw: strVal('1'), type: TYPE_INT_DEC, data: 1 },
    { ns: nsUri, name: id('versionName'), raw: strVal(versionName), type: TYPE_STRING, data: strVal(versionName) },
  ];
  chunks.push(startElement(el('manifest'), manifestAttrs, 1));

  // <uses-sdk>
  {
    const mn = String(24), tg = String(33);
    chunks.push(startElement(el('uses-sdk'), [
      { ns: nsUri, name: id('minSdkVersion'), raw: strVal(mn), type: TYPE_INT_DEC, data: 24 },
      { ns: nsUri, name: id('targetSdkVersion'), raw: strVal(tg), type: TYPE_INT_DEC, data: 33 },
    ], 2));
    chunks.push(endElement(el('uses-sdk'), 2));
  }

  // <uses-permission>
  for (const perm of [
    'android.permission.INTERNET',
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
  ]) {
    chunks.push(startElement(el('uses-permission'), [
      { ns: nsUri, name: id('name'), raw: strVal(perm), type: TYPE_STRING, data: strVal(perm) },
    ], 3));
    chunks.push(endElement(el('uses-permission'), 3));
  }

  // <application>
  {
    const appAttrs = [
      { ns: nsUri, name: id('label'), raw: strVal(label), type: TYPE_STRING, data: strVal(label) },
      { ns: nsUri, name: id('allowBackup'), raw: strVal('false'), type: TYPE_INT_BOOLEAN, data: 0 },
      { ns: nsUri, name: id('usesCleartextTraffic'), raw: strVal('true'), type: TYPE_INT_BOOLEAN, data: 1 },
    ];
    chunks.push(startElement(el('application'), appAttrs, 4));

    // <activity>
    const activityName = '.MainActivity';
    const cfg = 0x06a0; // orientation|screenSize|keyboardHidden|uiMode
    const actAttrs = [
      { ns: nsUri, name: id('name'), raw: strVal(activityName), type: TYPE_STRING, data: strVal(activityName) },
      { ns: nsUri, name: id('label'), raw: strVal(label), type: TYPE_STRING, data: strVal(label) },
      { ns: nsUri, name: id('exported'), raw: strVal('true'), type: TYPE_INT_BOOLEAN, data: 1 },
      { ns: nsUri, name: id('configChanges'), raw: strVal(String(cfg)), type: TYPE_INT_DEC, data: cfg },
    ];
    chunks.push(startElement(el('activity'), actAttrs, 5));

    // <intent-filter>
    chunks.push(startElement(el('intent-filter'), [], 6));
    const main = 'android.intent.action.MAIN';
    chunks.push(startElement(el('action'), [
      { ns: nsUri, name: id('name'), raw: strVal(main), type: TYPE_STRING, data: strVal(main) },
    ], 7));
    chunks.push(endElement(el('action'), 7));
    const launcher = 'android.intent.category.LAUNCHER';
    chunks.push(startElement(el('category'), [
      { ns: nsUri, name: id('name'), raw: strVal(launcher), type: TYPE_STRING, data: strVal(launcher) },
    ], 8));
    chunks.push(endElement(el('category'), 8));
    chunks.push(endElement(el('intent-filter'), 9));

    chunks.push(endElement(el('activity'), 10));
    chunks.push(endElement(el('application'), 11));
  }

  chunks.push(endElement(el('manifest'), 12));
  chunks.push(endNamespace(nsPrefix, nsUri, 13));

  const pool = stringPoolChunk(strings);
  const resMap = resourceMapChunk(resIds);
  const body = Buffer.concat([pool, resMap, ...chunks]);

  const header = Buffer.alloc(8);
  header.writeUInt16LE(RES_XML_TYPE, 0);
  header.writeUInt16LE(8, 2);
  header.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([header, body]);
}

if (require.main === module) {
  const out = process.argv[2] || path.join(__dirname, 'AndroidManifest.xml');
  const buf = buildManifest(1, '1.0', 'Flight Radar');
  fs.writeFileSync(out, buf);
  console.log('wrote', out, buf.length, 'bytes');
}

module.exports = { buildManifest };
