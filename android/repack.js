#!/usr/bin/env node
// repack.js — 重写 APK，让每个条目的数据都落在 4 字节边界上。
//
// 为什么需要它：Android 11（API 30）以后的安装器要求
//   · resources.arsc 必须以「不压缩」方式存储，且数据偏移 4 字节对齐
//   （targetSdkVersion >= 30 时强制检查，否则安装直接失败）
// 老版 aapt 会把 resources.arsc 存成 STORE，但不会补对齐；
// 而 zipalign 在部分环境里不可用（比如本机只有 arm64 的 aapt）。
// 于是这里用一个纯 Node 的 zip 重写器自己补 4 字节对齐：
// 通过在 local header 的 extra field 里插入 0xD935（Android 对齐扩展）记录，
// 把后续数据推到 4 字节边界上。重写之后再交给 apksigner 签名即可。
//
// 用法：node repack.js <in.apk> <out.apk>
const fs = require('fs')

const [, , inPath, outPath] = process.argv
if (!inPath || !outPath) {
  console.error('usage: node repack.js <in.apk> <out.apk>')
  process.exit(2)
}

const src = fs.readFileSync(inPath)

// ---- 读 EOCD
let eocd = -1
for (let i = src.length - 22; i >= 0; i--) {
  if (src.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
}
if (eocd < 0) throw new Error('not a zip: EOCD not found')
const count = src.readUInt16LE(eocd + 10)
const cdOff = src.readUInt32LE(eocd + 16)

// ---- 读中央目录
const entries = []
let p = cdOff
for (let i = 0; i < count; i++) {
  if (src.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory at ' + p)
  const e = {
    versionMade: src.readUInt16LE(p + 4),
    versionNeed: src.readUInt16LE(p + 6),
    flags: src.readUInt16LE(p + 8),
    method: src.readUInt16LE(p + 10),
    time: src.readUInt16LE(p + 12),
    date: src.readUInt16LE(p + 14),
    crc: src.readUInt32LE(p + 16),
    csize: src.readUInt32LE(p + 20),
    usize: src.readUInt32LE(p + 24),
    extAttr: src.readUInt32LE(p + 38),
  }
  const nl = src.readUInt16LE(p + 28)
  const el = src.readUInt16LE(p + 30)
  const cl = src.readUInt16LE(p + 32)
  e.name = src.subarray(p + 46, p + 46 + nl)
  const lho = src.readUInt32LE(p + 42)
  const lnameLen = src.readUInt16LE(lho + 26)
  const lextraLen = src.readUInt16LE(lho + 28)
  const dataStart = lho + 30 + lnameLen + lextraLen
  e.data = src.subarray(dataStart, dataStart + e.csize)
  entries.push(e)
  p += 46 + nl + el + cl
}

// ---- 重写：每条都补 extra 使其数据 4 字节对齐（extra 长度取 4..7，保证是合法 extra 记录）
const chunks = []
let offset = 0
const placed = []
for (const e of entries) {
  const base = offset + 30 + e.name.length
  const extraLen = ((4 - (base % 4)) % 4) + 4
  const extra = Buffer.alloc(extraLen)
  extra.writeUInt16LE(0xd935, 0)          // Android alignment extra field id
  extra.writeUInt16LE(extraLen - 4, 2)    // 内容长度（0..3 字节的 0 填充）

  const lh = Buffer.alloc(30)
  lh.writeUInt32LE(0x04034b50, 0)
  lh.writeUInt16LE(e.versionNeed, 4)
  lh.writeUInt16LE(e.flags, 6)
  lh.writeUInt16LE(e.method, 8)
  lh.writeUInt16LE(e.time, 10)
  lh.writeUInt16LE(e.date, 12)
  lh.writeUInt32LE(e.crc, 14)
  lh.writeUInt32LE(e.csize, 18)
  lh.writeUInt32LE(e.usize, 22)
  lh.writeUInt16LE(e.name.length, 26)
  lh.writeUInt16LE(extraLen, 28)

  chunks.push(lh, e.name, extra, e.data)
  placed.push({ e, extra, lho: offset, dataOff: base + extraLen })
  offset += 30 + e.name.length + extraLen + e.csize
}

const cdStart = offset
for (const { e, extra, lho } of placed) {
  const cd = Buffer.alloc(46)
  cd.writeUInt32LE(0x02014b50, 0)
  cd.writeUInt16LE(e.versionMade, 4)
  cd.writeUInt16LE(e.versionNeed, 6)
  cd.writeUInt16LE(e.flags, 8)
  cd.writeUInt16LE(e.method, 10)
  cd.writeUInt16LE(e.time, 12)
  cd.writeUInt16LE(e.date, 14)
  cd.writeUInt32LE(e.crc, 16)
  cd.writeUInt32LE(e.csize, 20)
  cd.writeUInt32LE(e.usize, 24)
  cd.writeUInt16LE(e.name.length, 28)
  cd.writeUInt16LE(extra.length, 30)
  cd.writeUInt16LE(0, 32)   // comment len
  cd.writeUInt16LE(0, 34)   // disk number
  cd.writeUInt16LE(0, 36)   // internal attrs
  cd.writeUInt32LE(e.extAttr, 38)
  cd.writeUInt32LE(lho, 42)
  chunks.push(cd, e.name, extra)
  offset += 46 + e.name.length + extra.length
}

const eocdNew = Buffer.alloc(22)
eocdNew.writeUInt32LE(0x06054b50, 0)
eocdNew.writeUInt16LE(count, 8)
eocdNew.writeUInt16LE(count, 10)
eocdNew.writeUInt32LE(offset - cdStart, 12)
eocdNew.writeUInt32LE(cdStart, 16)
chunks.push(eocdNew)

fs.writeFileSync(outPath, Buffer.concat(chunks))

const bad = placed.filter((x) => x.dataOff % 4 !== 0)
const arsc = placed.find((x) => x.e.name.toString() === 'resources.arsc')
console.log(
  `repack: ${count} entries -> ${outPath} (${fs.statSync(outPath).size} B)` +
    `; misaligned=${bad.length}` +
    (arsc ? `; resources.arsc method=${arsc.e.method === 0 ? 'STORE' : 'DEFLATE'} dataOff=${arsc.dataOff} mod4=${arsc.dataOff % 4}` : '')
)
if (bad.length) {
  console.error('repack: still misaligned: ' + bad.map((x) => x.e.name.toString()).join(', '))
  process.exit(1)
}
if (arsc && (arsc.e.method !== 0 || arsc.dataOff % 4 !== 0)) {
  console.error('repack: resources.arsc must be STORE + 4-byte aligned')
  process.exit(1)
}
