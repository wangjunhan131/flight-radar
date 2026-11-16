/* FlightRadar — 老式绿色荧光雷达界面
 *  · 量程以公里为单位，可选 5/10/30/70/120/200/400/500 km
 *  · 点击目标锁定：绿色方框 + 实时数据面板 + 雷达盘上的飞行轨迹
 */
'use strict'

const $ = (id) => document.getElementById(id)
const RANGES_KM = [5, 10, 30, 70, 120, 200, 400, 500, 700, 1000, 1500, 2000]
/** 每个档位向后端请求的半径（后端上限 1200nm），小档位也取宽一些以拿到更多目标 */
const FETCH_NM = (km) => Math.max(60, Math.min(1200, Math.ceil((km / 1.852) * 2.2)))

// Geolocation is best-effort; when every service fails we still need a center point.
// Edit this to your own city if you want the radar to start somewhere meaningful offline.
const DEFAULT_CENTER = { lat: 0, lon: 0 }

const state = {
  center: null,
  placeLabel: '',
  rangeKm: 120,
  /** 首次加载若当前量程内没有目标，自动放大一次，避免打开就是空盘 */
  autoExpanded: false,
  aircraft: [],
  allAircraft: [],
  selected: null,        // 锁定的飞机（每次刷新后替换为最新快照）
  selectedHex: null,
  filter: 'all',
  trails: new Map(),     // hex -> [{x,y,t}]  屏幕坐标
  sweep: 0,
  heading: null,          // 手机正对的方向（度，0=北），来自指南针
  hits: [],
  lastUpdate: 0,
  routeCache: new Map(),
  routePending: new Set(),
  loading: false,
}

const canvas = $('radar')
const ctx = canvas.getContext('2d')
let W = 0, H = 0, DPR = 1, CX = 0, CY = 0, R = 0

const DEG = Math.PI / 180
/** 当前配色 */
const cur = () => COLORS[theme.color] || COLORS.green
const NM_PER_DEG = 60.0405

// ------------------------------------------------------------------ 显示主题
/** 颜色主题：每条含主色、柔色（带 alpha 前缀）和背景基色 */
const COLORS = {
  green:  { label: '绿', fx: '#34ff8f', dim: 'rgba(52,255,143,',  bg: [0, 16, 9]  },
  amber:  { label: '琥珀', fx: '#ffb02e', dim: 'rgba(255,176,46,', bg: [18, 11, 0] },
  cyan:   { label: '青', fx: '#37e8ff', dim: 'rgba(55,232,255,',  bg: [0, 14, 18] },
  red:    { label: '红', fx: '#ff4b4b', dim: 'rgba(255,75,75,',   bg: [18, 3, 3]  },
  white:  { label: '冰白', fx: '#d8f2ff', dim: 'rgba(216,242,255,', bg: [8, 12, 16] },
}

/**
 * brightness: 0..100，0 = 纯黑背景；gridOpacity: 0..1 网格线浓度；
 * color: COLORS 的键；mapBg / mapGrid: 地图/卫星模式下背景色与网格是否生效；
 * sweep: 扫描线总开关（所有视图通用，全黑背景想彻底干净时关掉它）
 */
const theme = {
  brightness: 15,
  gridOpacity: 1,
  color: 'green',
  mapBg: false,
  mapGrid: true,
  sweep: true,
  scanlines: true,   // CRT 横条纹（整屏那层细横线）
  sweepTail: false,
  headingUp: false, // 朝向向上：雷达盘跟着手机/指南针方向转  // 扫掠尾迹（扇形那一片淡淡的底色）；默认只留一根线
}
const THEME_KEY = 'fr.theme'
// ★ 点星弹窗跳转的仓库（发版时改这里）
const GITHUB_REPO = 'https://github.com/wangjunhan131/flight-radar'
const STAR_KEY = 'fr.star'
const STAR_MIN_LAUNCH = 3          // 打开满 3 次之后才开始考虑弹
const STAR_AGAIN_MS = 7 * 24 * 3600 * 1000  // 点「我在用」后隔一周再问
function loadTheme() {
  try {
    const raw = JSON.parse(localStorage.getItem(THEME_KEY) || '{}')
    if (Number.isFinite(raw.brightness)) theme.brightness = Math.max(0, Math.min(100, raw.brightness))
    if (Number.isFinite(raw.gridOpacity)) theme.gridOpacity = Math.max(0, Math.min(1, raw.gridOpacity))
    if (COLORS[raw.color]) theme.color = raw.color
    if (typeof raw.mapBg === 'boolean') theme.mapBg = raw.mapBg
    if (typeof raw.mapGrid === 'boolean') theme.mapGrid = raw.mapGrid
    if (typeof raw.sweep === 'boolean') theme.sweep = raw.sweep
    if (typeof raw.scanlines === 'boolean') theme.scanlines = raw.scanlines
    if (typeof raw.sweepTail === 'boolean') theme.sweepTail = raw.sweepTail
    if (typeof raw.headingUp === 'boolean') theme.headingUp = raw.headingUp
  } catch { /* 忽略损坏的本地设置 */ }
}
function saveTheme() {
  try { localStorage.setItem(THEME_KEY, JSON.stringify(theme)) } catch {}
}
loadTheme()

/** 背景亮度 0→纯黑，100→偏亮。返回 0..1 的强度 */
const bright = () => theme.brightness / 100

// ------------------------------------------------------------------ map tiles
// view: 'radar' 纯雷达 / 'map' 街道图 / 'sat' 卫星图
const mapState = { view: 'radar', z: 9, tiles: new Map() }

function lonToTileXf(lon, z) { return ((lon + 180) / 360) * 2 ** z }
function latToTileYf(lat, z) {
  const r = (lat * DEG)
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z
}
/** 当前 view 下适合的量级：让一格瓦片大约对应盘面 1/4 大小 */
function pickZoom() {
  const centerLat = state.center.lat
  // 每个瓦片覆盖的经度跨度（度）
  const target = (state.rangeKm / 111.32) / Math.cos(centerLat * DEG) / 3
  let z = Math.round(Math.log2(360 / target))
  return Math.max(4, Math.min(17, z))
}

function getTile(style, z, x, y) {
  const key = `${style}/${z}/${x}/${y}`
  if (mapState.tiles.has(key)) return mapState.tiles.get(key)
  const img = new Image()
  img.decoding = 'async'
  img.onload = () => { img._ready = true }
  img.onerror = () => { img._failed = true }
  const upstream =
    style === 'sat'
      ? `https://webst01.is.autonavi.com/appmaptile?x=${x}&y=${y}&z=${z}&style=6`
      : `https://webrd01.is.autonavi.com/appmaptile?x=${x}&y=${y}&z=${z}&lang=zh_cn&size=1&scale=1&style=8`
  img.src = `/api/fetch?u=${encodeURIComponent(upstream)}`
  mapState.tiles.set(key, img)
  if (mapState.tiles.size > 400) {
    // 简单淘汰：删掉最旧的非可见项
    const first = mapState.tiles.keys().next().value
    if (first !== undefined) mapState.tiles.delete(first)
  }
  return img
}

/** 把地图平铺到雷达圆盘上（墨卡托），圆盘外裁掉 */
function drawMapTiles(style) {
  if (!state.center) return
  const z = mapState.z
  const cx = lonToTileXf(state.center.lon, z)
  const cy = latToTileYf(state.center.lat, z)
  // 盘面中心像素 → 瓦片像素比例
  // 每度经度在屏幕上的像素数
  const pxPerDegLon = R / ((state.rangeKm / 111.32) / Math.cos(state.center.lat * DEG))
  const tilePx = (360 / 2 ** z) * pxPerDegLon   // 每个瓦片在屏幕上的像素尺寸
  const tiles = Math.ceil(R / tilePx) + 1
  const x0 = Math.floor(cx)
  const y0 = Math.floor(cy)

  ctx.save()
  ctx.beginPath()
  ctx.arc(CX, CY, R, 0, Math.PI * 2)
  ctx.clip()

  for (let dx = -tiles; dx <= tiles; dx++) {
    for (let dy = -tiles; dy <= tiles; dy++) {
      const tx = x0 + dx, ty = y0 + dy
      const n = 2 ** z
      if (tx < 0 || tx >= n || ty < 0 || ty >= n) continue
      const img = getTile(style, z, tx, ty)
      if (!img._ready) continue
      const sx = CX + (tx - cx) * tilePx
      const sy = CY + (ty - cy) * tilePx
      ctx.drawImage(img, sx, sy, tilePx + 1, tilePx + 1)
    }
  }

  // 压暗底图，让荧光叠加层可读；亮度=100 时完全不压暗（地图最清楚）
  const dim = (style === 'sat' ? 0.30 : 0.42) * (1 - bright())
  ctx.fillStyle = `rgba(0,8,4,${dim.toFixed(3)})`
  ctx.fillRect(CX - R, CY - R, R * 2, R * 2)
  ctx.restore()
}

// ------------------------------------------------------------------ sizing
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2.5)
  W = canvas.clientWidth
  H = canvas.clientHeight
  canvas.width = Math.round(W * DPR)
  canvas.height = Math.round(H * DPR)
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
  CX = W / 2
  CY = H / 2
  R = Math.min(W, H) / 2 - 20
}

// ------------------------------------------------------------------ geo helpers
const rangeNm = () => state.rangeKm / 1.852

function project(lat, lon) {
  const lat0 = state.center.lat
  const dLat = lat - lat0
  const dLon = lon - state.center.lon
  const cosLat = Math.cos(lat0 * DEG)
  return { northNm: dLat * NM_PER_DEG, eastNm: dLon * NM_PER_DEG * cosLat }
}

/** 朝向向上时，整个画面绕中心旋转，让"手机正对的方向"朝上（地图模式下不转，否则瓦片会歪） */
function headingDeg() {
  if (!theme.headingUp || state.heading == null) return 0
  if (mapState.view !== 'radar') return 0
  return state.heading
}
function toScreen(northNm, eastNm) {
  const k = R / rangeNm()
  const rot = headingDeg()
  let n = northNm, e = eastNm
  if (rot) {
    const c = Math.cos(rot * DEG), s = Math.sin(rot * DEG)
    n = northNm * c + eastNm * s
    e = eastNm * c - northNm * s
  }
  return { x: CX + e * k, y: CY - n * k }
}

function bearingTo(lat, lon) {
  const lat1 = state.center.lat * DEG, lat2 = lat * DEG
  const dLon = (lon - state.center.lon) * DEG
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return ((Math.atan2(y, x) / DEG) + 360) % 360
}

const distanceM = (lat, lon) => {
  const R0 = 6371008.8
  const dLat = (lat - state.center.lat) * DEG
  const dLon = (lon - state.center.lon) * DEG
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(state.center.lat * DEG) * Math.cos(lat * DEG) * Math.sin(dLon / 2) ** 2
  return 2 * R0 * Math.asin(Math.sqrt(a))
}

// ------------------------------------------------------------------ filtering
function passesFilter(ac) {
  switch (state.filter) {
    case 'air': return ['jet', 'heavy'].includes(ac.kind)
    case 'small': return ac.kind === 'small' || ac.kind === 'low'
    case 'rotor': return ac.kind === 'rotor' || ac.kind === 'drone'
    case 'ground': return ac.kind === 'ground'
    default: return true
  }
}

// ------------------------------------------------------------------ drawing
/**
 * plain=true  → 纯雷达盘：背景恒铺，可为纯黑
 * plain=false → 地图/卫星：背景由 theme.mapBg 决定，网格由 theme.mapGrid 决定
 */
/**
 * 背景层。拆成独立函数，因为地图/卫星模式下瓦片必须垫在网格线之下：
 *   背景 → 地图瓦片 → 网格线 → 扫描 → 航迹 → 目标
 * 之前网格线先画、瓦片后画，瓦片把标尺线整块盖住，这就是"地图模式打不开标尺线"的根因。
 */
function drawGridBg(plain) {
  const b = bright()
  const c = cur()
  const onMap = !plain
  if (onMap) {
    // 地图/卫星：只有用户显式要求才铺一层底色，否则完全露出底图
    if (!theme.mapBg || b <= 0.01) return
    const bgA = 0.18 + b * 0.52
    ctx.fillStyle = `rgba(${c.bg[0]},${c.bg[1]},${c.bg[2]},${bgA.toFixed(3)})`
    ctx.fillRect(0, 0, W, H)
    return
  }
  if (b <= 0.01) {
    // 纯雷达 + 背景亮度 0 → 绝对纯黑，不叠任何渐变
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, W, H)
    return
  }
  ctx.fillStyle = `rgba(${c.bg[0]},${c.bg[1]},${c.bg[2]},${(0.15 + b * 0.85).toFixed(3)})`
  ctx.fillRect(0, 0, W, H)

  const bg = ctx.createRadialGradient(CX, CY, 0, CX, CY, R)
  const g0 = 0.5 + b * 0.42
  bg.addColorStop(0, `rgba(${c.bg[0] + 6},${c.bg[1] + 34},${c.bg[2] + 18},${g0.toFixed(3)})`)
  bg.addColorStop(0.7, `rgba(${c.bg[0] + 2},${c.bg[1] + 14},${c.bg[2] + 8},${(g0 * 0.72).toFixed(3)})`)
  bg.addColorStop(1, `rgba(0,0,0,${(0.55 + b * 0.35).toFixed(3)})`)
  ctx.fillStyle = bg
  ctx.beginPath()
  ctx.arc(CX, CY, R, 0, Math.PI * 2)
  ctx.fill()
}

/** 网格/标尺层。必须画在瓦片之上，且线浓度只由 gridOpacity 控制、不随背景亮度衰减。 */
function drawGrid(plain = true) {
  const b = bright()
  const onMap = !plain
  // 地图/卫星：由 mapGrid 独立开关；纯雷达：恒画
  const g = onMap ? (theme.mapGrid ? theme.gridOpacity : 0) : theme.gridOpacity
  if (g <= 0.001) return

  ctx.save()
  if (onMap) {
    // 线条压在白底瓦片上几乎不可见，加深色投影保证可读
    ctx.shadowColor = 'rgba(0,0,0,0.95)'
    ctx.shadowBlur = 2.5
  }

  const rings = 4
  for (let i = 1; i <= rings; i++) {
    const rr = (R * i) / rings
    if (onMap) {
      // 底图之上：先垫一层黑，再叠彩色线
      ctx.beginPath()
      ctx.arc(CX, CY, rr, 0, Math.PI * 2)
      ctx.lineWidth = 3.6
      ctx.strokeStyle = `rgba(0,0,0,${(0.55 * g).toFixed(3)})`
      ctx.stroke()
    }
    ctx.beginPath()
    ctx.arc(CX, CY, rr, 0, Math.PI * 2)
    ctx.lineWidth = onMap ? 1.6 : 1.2
    ctx.strokeStyle =
      i === rings
        ? `${cur().dim}${(1 * g).toFixed(3)})`
        : `${cur().dim}${((onMap ? 0.8 : 0.62) * g).toFixed(3)})`
    ctx.shadowColor = onMap ? 'rgba(0,0,0,0.95)' : i === rings ? cur().fx : 'transparent'
    ctx.shadowBlur = onMap ? 2.5 : i === rings ? 14 : 0
    ctx.stroke()
  }

  // 每 30° 径向线
  ctx.shadowBlur = onMap ? 2.5 : 0
  ctx.lineWidth = onMap ? 1.3 : 1.2
  ctx.strokeStyle = `${cur().dim}${((onMap ? 0.55 : 0.4) * g).toFixed(3)})`
  for (let d = 0; d < 360; d += 30) {
    const a = (d - headingDeg() - 90) * DEG
    ctx.beginPath()
    ctx.moveTo(CX, CY)
    ctx.lineTo(CX + Math.cos(a) * R, CY + Math.sin(a) * R)
    ctx.stroke()
  }

  // 外圈刻度
  ctx.strokeStyle = `${cur().dim}${(0.85 * g).toFixed(3)})`
  for (let d = 0; d < 360; d += 5) {
    const a = (d - headingDeg() - 90) * DEG
    const long = d % 30 === 0
    const inner = R - (long ? 10 : 4)
    ctx.beginPath()
    ctx.moveTo(CX + Math.cos(a) * inner, CY + Math.sin(a) * inner)
    ctx.lineTo(CX + Math.cos(a) * R, CY + Math.sin(a) * R)
    ctx.stroke()
  }

  // 方位字
  ctx.font = '600 11px ui-monospace, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = `${cur().dim}${(0.95 * (1 - b * 0.12)).toFixed(3)})`
  ctx.shadowColor = onMap ? 'rgba(0,0,0,1)' : cur().fx
  ctx.shadowBlur = onMap ? 4 : 6
  for (const [txt, deg] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
    const a = (deg - headingDeg() - 90) * DEG
    ctx.fillText(txt, CX + Math.cos(a) * (R - 17), CY + Math.sin(a) * (R - 17))
  }
  ctx.shadowBlur = 0

  // 距离标注（km）
  ctx.font = '9px ui-monospace, monospace'
  ctx.textAlign = 'left'
  ctx.fillStyle = `${cur().dim}${(0.9 * (1 - b * 0.15)).toFixed(3)})`
  for (let i = 1; i <= rings; i++) {
    ctx.fillText(`${Math.round((state.rangeKm * i) / rings)}`, CX + 5, CY - (R * i) / rings + 8)
  }

  // 中心点
  ctx.beginPath()
  ctx.arc(CX, CY, 3.5, 0, Math.PI * 2)
  ctx.fillStyle = cur().fx
  ctx.shadowColor = cur().fx
  ctx.shadowBlur = 12
  ctx.fill()
  ctx.shadowBlur = 0
  ctx.beginPath()
  ctx.arc(CX, CY, 9, 0, Math.PI * 2)
  ctx.strokeStyle = `${cur().dim}${(0.75 * (1 - b * 0.25)).toFixed(3)})`
  ctx.stroke()
  ctx.restore()
}

function drawSweep() {
  // 只画那一根线是最干净的；想要经典的"扫过一片"效果，可以在面板里开「扫掠尾迹」
  if (theme.sweepTail) {
    const tail = 1.15 // rad
    const steps = 30
    // 背景越亮，尾迹越淡，避免整盘发绿糊成一片
    const base = 0.18 * (1 - bright() * 0.55)
    for (let i = 0; i < steps; i++) {
      const a0 = state.sweep - (i / steps) * tail
      const a1 = state.sweep - ((i + 1) / steps) * tail
      const alpha = base * (1 - i / steps) ** 1.6
      ctx.beginPath()
      ctx.moveTo(CX, CY)
      ctx.arc(CX, CY, R, a0 - Math.PI / 2, a1 - Math.PI / 2)
      ctx.closePath()
      ctx.fillStyle = `${cur().dim}${alpha.toFixed(3)})`
      ctx.fill()
    }
  }

  // 扫描线本体：一根从圆心拉到外圈的细线，带一点光晕
  const a = state.sweep - Math.PI / 2
  ctx.beginPath()
  ctx.moveTo(CX, CY)
  ctx.lineTo(CX + Math.cos(a) * R, CY + Math.sin(a) * R)
  ctx.strokeStyle = `${cur().dim}${(0.85 * (1 - bright() * 0.2)).toFixed(3)})`
  ctx.lineWidth = 1.4
  ctx.shadowColor = cur().fx
  ctx.shadowBlur = 10
  ctx.stroke()
  ctx.shadowBlur = 0
}

function drawPlane(x, y, size, hdg) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate((hdg || 0) * DEG)
  ctx.beginPath()
  ctx.moveTo(0, -size)
  ctx.lineTo(size * 0.7, size * 0.75)
  ctx.lineTo(0, size * 0.4)
  ctx.lineTo(-size * 0.7, size * 0.75)
  ctx.closePath()
  ctx.fillStyle = cur().fx
  ctx.shadowColor = cur().fx
  ctx.shadowBlur = 8
  ctx.fill()
  ctx.restore()
  ctx.shadowBlur = 0
}

function drawTrails(now) {
  for (const [hex, pts] of state.trails) {
    if (pts.length < 2) continue
    const sel = hex === state.selectedHex
    ctx.beginPath()
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
    ctx.strokeStyle = sel ? `${cur().dim}0.85)` : `${cur().dim}0.22)`
    ctx.lineWidth = sel ? 1.8 : 1
    if (sel) { ctx.shadowColor = cur().fx; ctx.shadowBlur = 6 }
    ctx.stroke()
    ctx.shadowBlur = 0
    // 轨迹终点小叉，表示历史位置
    if (sel && pts.length) {
      const f = pts[0]
      ctx.beginPath()
      ctx.arc(f.x, f.y, 2, 0, Math.PI * 2)
      ctx.fillStyle = `${cur().dim}0.8)`
      ctx.fill()
    }
  }
}

function drawAircraft(now) {
  state.hits = []
  const limited = rangeNm()
  for (const ac of state.aircraft) {
    if (!passesFilter(ac)) continue
    const pr = project(ac.lat, ac.lon)
    const dNm = Math.hypot(pr.northNm, pr.eastNm)
    const inRange = dNm <= limited * 1.0
    if (!inRange && ac.hex !== state.selectedHex) continue

    const { x, y } = toScreen(pr.northNm, pr.eastNm)
    const sel = ac.hex === state.selectedHex

    // 轨迹记录
    if (ac.hex !== state.selectedHex) {
      let tr = state.trails.get(ac.hex)
      if (!tr) { tr = []; state.trails.set(ac.hex, tr) }
      const last = tr[tr.length - 1]
      if (!last || Math.hypot(last.x - x, last.y - y) > 2.5) {
        tr.push({ x, y, t: now })
        if (tr.length > 80) tr.shift()
      }
    }

    // 速度矢量（2 分钟预计位置）
    if (!ac.onGround && ac.groundSpeedKt && ac.trackDeg != null) {
      const k = R / limited
      const nm = (ac.groundSpeedKt / 60) * 2
      const a = ac.trackDeg * DEG
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x + Math.sin(a) * nm * k, y - Math.cos(a) * nm * k)
      ctx.strokeStyle = sel ? `${cur().dim}0.9)` : `${cur().dim}0.32)`
      ctx.lineWidth = 1
      ctx.stroke()
    }

    if (sel) {
      // 锁定：绿色方框
      const b = 13
      ctx.strokeStyle = '#b9ffd8'
      ctx.lineWidth = 1.6
      ctx.shadowColor = cur().fx
      ctx.shadowBlur = 12
      // 四角括号
      const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]]
      for (const [sx, sy] of corners) {
        ctx.beginPath()
        ctx.moveTo(x + sx * b, y + sy * b - sy * 5)
        ctx.lineTo(x + sx * b, y + sy * b)
        ctx.lineTo(x + sx * b - sx * 5, y + sy * b)
        ctx.stroke()
      }
      ctx.shadowBlur = 0
      drawPlane(x, y, 7, ac.trackDeg || 0)
    } else {
      // 小飞机图标小一些，旋翼用圆点
      if (ac.kind === 'rotor' || ac.kind === 'drone') {
        ctx.beginPath()
        ctx.arc(x, y, 2.6, 0, Math.PI * 2)
        ctx.fillStyle = cur().fx
        ctx.globalAlpha = 0.85
        ctx.fill()
        ctx.globalAlpha = 1
      } else {
        ctx.globalAlpha = ac.kind === 'small' || ac.kind === 'low' ? 0.75 : 0.95
        drawPlane(x, y, ac.kind === 'heavy' ? 5.4 : 4.4, ac.trackDeg || 0)
        ctx.globalAlpha = 1
      }
    }

    // 标签：近处或锁定时显示
    const label = ac.iataFlight || ac.callsign
    if (label && (sel || dNm < limited * 0.5 || state.aircraft.length < 25)) {
      ctx.font = sel ? '600 10px ui-monospace, monospace' : '9px ui-monospace, monospace'
      ctx.fillStyle = sel ? '#e8fff2' : `${cur().dim}0.6)`
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, x + (sel ? 17 : 8), y - 8)
    }

    state.hits.push({ x, y, r: sel ? 26 : 16, ac })
  }
}


/** 指南针：指针指向手机正对的方向（朝向向上时固定指上方），旁边标出度数 */
function drawCompass() {
  const h = state.heading
  if (h == null) return
  const onMap = mapState.view !== 'radar'
  const a = (h - headingDeg() - 90) * DEG
  const ca = Math.cos(a), sa = Math.sin(a)
  const tip = R - 6, base = R - 19, wid = 5.5
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(CX + ca * tip, CY + sa * tip)
  ctx.lineTo(CX + Math.cos(a - Math.PI / 2) * wid + ca * base, CY + Math.sin(a - Math.PI / 2) * wid + sa * base)
  ctx.lineTo(CX + Math.cos(a + Math.PI / 2) * wid + ca * base, CY + Math.sin(a + Math.PI / 2) * wid + sa * base)
  ctx.closePath()
  ctx.fillStyle = cur().fx
  ctx.globalAlpha = 0.92
  ctx.shadowColor = cur().fx
  ctx.shadowBlur = onMap ? 0 : 8
  ctx.fill()
  ctx.restore()
  ctx.save()
  ctx.font = '600 10px ui-monospace, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const lr = R - 36
  ctx.fillStyle = `${cur().dim}${onMap ? 0.95 : 0.85})`
  ctx.fillText(`${Math.round(h)}°`, CX + ca * lr, CY + sa * lr)
  ctx.restore()
}

/** 手机方向：iOS 用 webkitCompassHeading，安卓用 alpha 换算 */
function onOrient(e) {
  let hd = null
  if (typeof e.webkitCompassHeading === 'number' && Number.isFinite(e.webkitCompassHeading)) {
    hd = e.webkitCompassHeading
  } else if (typeof e.alpha === 'number' && Number.isFinite(e.alpha)) {
    hd = (360 - e.alpha) % 360
  }
  if (hd != null) state.heading = hd
}

let compassOn = false
function startCompass() {
  if (compassOn) return true
  if (!window.DeviceOrientationEvent) return false
  const attach = () => {
    window.addEventListener('deviceorientationabsolute', onOrient, true)
    window.addEventListener('deviceorientation', onOrient, true)
    compassOn = true
  }
  const DOE = window.DeviceOrientationEvent
  if (typeof DOE.requestPermission === 'function') {
    DOE.requestPermission().then((r) => { if (r === 'granted') attach(); else showStatus('没有取得方向传感器权限') }).catch(() => {})
    return true
  }
  attach()
  return true
}

function drawFrame(now) {
  const t = now / 1000
  state.sweep = (t * 0.9) % (Math.PI * 2)
  const onMap = mapState.view !== 'radar'
  if (onMap) mapState.z = pickZoom()

  // 顺序很关键：背景 → 底图 → 网格 → 扫描 → 航迹 → 目标
  ctx.clearRect(0, 0, W, H)
  drawGridBg(!onMap)
  if (onMap) drawMapTiles(mapState.view === 'sat' ? 'sat' : 'street')
  drawGrid(!onMap)
  if (theme.sweep) drawSweep()
  drawCompass()
  drawTrails(now)
  drawAircraft(now)
  requestAnimationFrame(drawFrame)
}

// ------------------------------------------------------------------ data
async function api(path) {
  const res = await fetch(path, { cache: 'no-store' })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
  return body
}

function showStatus(msg) {
  const el = $('status')
  if (!msg) { el.classList.add('hidden'); return }
  el.textContent = msg
  el.classList.remove('hidden')
}

const LOC_KEY = 'fr.lastloc'

async function loadLocation() {
  const loc = await FRData.detectLocation()
  if (!loc) throw new Error('定位失败，请检查网络')
  state.center = { lat: loc.lat, lon: loc.lon }
  state.placeLabel = [loc.city, loc.region].filter(Boolean).join(' · ') || loc.country || ''
  $('where').textContent = state.placeLabel || '—'
  try {
    localStorage.setItem(LOC_KEY, JSON.stringify({ lat: loc.lat, lon: loc.lon, label: state.placeLabel }))
  } catch {}
}

/** Fallback when geolocation fails: last known position → otherwise DEFAULT_CENTER, so the screen never goes blank. */
function fallbackLocation(reason) {
  let last = null
  try {
    last = JSON.parse(localStorage.getItem(LOC_KEY) || 'null')
  } catch {}
  if (last && last.lat != null && last.lon != null) {
    state.center = { lat: last.lat, lon: last.lon }
    state.placeLabel = last.label || '上次位置'
  } else {
    state.center = { ...DEFAULT_CENTER }
    state.placeLabel = '默认位置'
  }
  $('where').textContent = state.placeLabel
  showStatus(`定位失败（${reason}），先用${state.placeLabel}继续`)
}

let loadSeq = 0

// ------------------------------------------------------------------ 冷启动缓存
// 手机上一开 App 就要看到东西，不能干等网络。每次拿到有效数据就存一份到
// localStorage，下次启动先把这份填进雷达盘，网络结果回来再覆盖。
const SNAP_KEY = 'fr.snapshot'

function saveSnapshot() {
  if (!state.center) return
  try {
    localStorage.setItem(
      SNAP_KEY,
      JSON.stringify({
        at: Date.now(),
        lat: state.center.lat,
        lon: state.center.lon,
        rangeKm: state.rangeKm,
        aircraft: state.allAircraft,
      }),
    )
  } catch {}
}

function restoreSnapshot() {
  try {
    const raw = localStorage.getItem(SNAP_KEY)
    if (!raw) return false
    const s = JSON.parse(raw)
    if (!s || !Array.isArray(s.aircraft) || !s.aircraft.length) return false
    if (!s.lat || !s.lon) return false
    // 太久以前的、或者定位已经跑远的，都不用
    if (Date.now() - s.at > 6 * 3600 * 1000) return false
    if (!state.center) return false
    if (FRData.haversineM(s.lat, s.lon, state.center.lat, state.center.lon) > 500 * 1000) return false

    for (const a of s.aircraft) {
      a.distanceM = FRData.haversineM(state.center.lat, state.center.lon, a.lat, a.lon)
      a.bearing = FRData.bearingDeg(state.center.lat, state.center.lon, a.lat, a.lon)
    }
    s.aircraft.sort((x, y) => x.distanceM - y.distanceM)
    state.allAircraft = s.aircraft
    const rangeM = state.rangeKm * 1000
    state.aircraft = s.aircraft.filter((a) => a.distanceM == null || a.distanceM <= rangeM)
    $('roCount').textContent = String(state.aircraft.length)
    $('roTime').textContent = new Date(s.at).toLocaleTimeString('zh-CN', { hour12: false })
    const mins = Math.round((Date.now() - s.at) / 60000)
    showStatus(`正在刷新…（先显示 ${mins < 1 ? '刚刚' : mins + ' 分钟前'} 的缓存）`)
    return true
  } catch {
    return false
  }
}

/** 把一次查询结果应用到界面（首屏的部分结果也走这里） */
function applyAircraftData(data, seq) {
  if (seq !== loadSeq) return
  state.allAircraft = data.aircraft || []
  // 只保留落在当前量程圆内的目标
  const rangeM = state.rangeKm * 1000
  state.aircraft = state.allAircraft.filter((a) => a.distanceM == null || a.distanceM <= rangeM)
  state.lastUpdate = Date.now()
  $('roCount').textContent = String(state.aircraft.length)
  $('roTime').textContent = new Date(state.lastUpdate).toLocaleTimeString('zh-CN', { hour12: false })
  if (!data.degraded && state.allAircraft.length) saveSnapshot()

  // 空盘且外面有目标：自动放大到能看见最近一架的档位（只做一次）
  if (!state.aircraft.length && !state.autoExpanded && state.allAircraft.length) {
    state.autoExpanded = true
    const nearestKm = (state.allAircraft[0].distanceM || 0) / 1000
    const next = RANGES_KM.find((r) => r >= nearestKm + 30)
    if (next && next > state.rangeKm) {
      setRange(next)
      return
    }
  }

  if (data.degraded) {
    showStatus('数据源暂时不可用，稍后自动重试')
  } else if (!state.aircraft.length) {
    const nearest = state.allAircraft[0]
    if (nearest && nearest.distanceM) {
      showStatus(
        `当前 ${state.rangeKm}km 内暂无航班信号；最近一架在 ${Math.round(nearest.distanceM / 1000)}km 外，可试试更大的量程`,
      )
    } else {
      showStatus(`当前 ${state.rangeKm}km 范围内暂无航班信号${state.rangeKm < 200 ? '，可试试更大的量程' : ''}`)
    }
  } else {
    showStatus('')
  }

  // 锁定目标跟随刷新
  if (state.selectedHex) {
    const fresh = state.allAircraft.find((a) => a.hex === state.selectedHex)
    if (fresh) {
      state.selected = fresh
      renderSheet(fresh)
      recordSelectedTrail(fresh)
    } else {
      $('fAltState').textContent = '信号丢失'
    }
  }

  // 清理已经消失目标的历史轨迹
  const alive = new Set(state.allAircraft.map((a) => a.hex))
  for (const hex of state.trails.keys()) {
    if (hex === state.selectedHex) continue
    if (!alive.has(hex)) state.trails.delete(hex)
  }
}

async function loadAircraft() {
  if (!state.center || state.loading) return
  const seq = ++loadSeq
  state.loading = true
  const { lat, lon } = state.center
  try {
    // 中心点先返回一次 → 界面立刻出图；外围网格随后补齐
    const data = await FRData.queryAircraft(lat, lon, state.rangeKm, (partial) => {
      applyAircraftData(partial, seq)
    })
    applyAircraftData(data, seq)
  } finally {
    state.loading = false
  }
}

let timer = null
function schedulePoll(delay = 5000) {
  clearTimeout(timer)
  timer = setTimeout(async () => {
    try { await loadAircraft() } catch (e) { showStatus(`刷新失败：${e.message}`) }
    schedulePoll(state.selectedHex ? 3000 : state.rangeKm >= 700 ? 12000 : 5000)
  }, delay)
}

// ------------------------------------------------------------------ 锁定目标的轨迹
const SEL_TRAIL_MAX = 400
function recordSelectedTrail(ac) {
  if (!state.center) return
  const pr = project(ac.lat, ac.lon)
  const { x, y } = toScreen(pr.northNm, pr.eastNm)
  let tr = state.trails.get(ac.hex)
  if (!tr) { tr = []; state.trails.set(ac.hex, tr) }
  const last = tr[tr.length - 1]
  // 坐标变化才记录，避免静止重复
  if (!last || Math.hypot(last.x - x, last.y - y) > 0.8 || Math.abs((last.t || 0) - Date.now()) > 15000) {
    tr.push({ x, y, t: Date.now(), lat: ac.lat, lon: ac.lon })
    if (tr.length > SEL_TRAIL_MAX) tr.shift()
  }
}

// ------------------------------------------------------------------ sheet
const sheet = $('sheet')

const fmtAlt = (ft) => (ft == null ? '—' : `${Math.round(ft).toLocaleString('en-US')} ft`)
const fmtGs = (kt) => (kt == null ? '—' : `${Math.round(kt)} kt`)
const fmtVs = (fpm) => {
  if (fpm == null) return '—'
  if (Math.abs(fpm) < 50) return '— 平飞'
  return `${fpm > 0 ? '↑' : '↓'} ${Math.abs(Math.round(fpm)).toLocaleString('en-US')}`
}
const fmtDist = (m) => (m == null ? '—' : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`)
const compassZh = (deg) => ['北', '东北', '东', '东南', '南', '西南', '西', '西北'][Math.round((deg % 360) / 45) % 8]
const compassEn = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((deg % 360) / 45) % 8]

function renderSheet(ac) {
  $('fCallsign').textContent = ac.callsign || ac.hex.toUpperCase()
  $('fIata').textContent = ac.iataFlight || '—'
  $('fSub').textContent = [ac.airline, ac.type, ac.registration].filter(Boolean).join(' · ') || '未知机型'

  let altState = '—'
  if (ac.onGround) altState = '地面'
  else if (ac.altitudeFt != null) {
    altState = ac.altitudeFt >= 25000 ? '巡航' : ac.verticalRateFpm > 200 ? '爬升中' : ac.verticalRateFpm < -200 ? '下降中' : '平飞'
  }
  $('fAltState').textContent = altState

  $('sAlt').textContent = ac.onGround ? '地面' : fmtAlt(ac.altitudeFt)
  $('sGs').textContent = fmtGs(ac.groundSpeedKt)
  $('sHdg').textContent = ac.trackDeg == null ? '—' : `${Math.round(ac.trackDeg)}° ${compassEn(ac.trackDeg)}`
  $('sVs').textContent = fmtVs(ac.verticalRateFpm)
  $('sDist').textContent = fmtDist(distanceM(ac.lat, ac.lon))
  $('sBrg').textContent = `${Math.round(bearingTo(ac.lat, ac.lon))}° ${compassZh(bearingTo(ac.lat, ac.lon))}`

  $('mType').textContent = ac.type || '—'
  $('mReg').textContent = ac.registration || '—'
  $('mSqk').textContent = ac.squawk || '—'
  $('mHex').textContent = (ac.hex || '—').toUpperCase()
  $('mSrc').textContent = (ac.source || '—').split('+').join(' + ')

  const route = state.routeCache.get(ac.callsign)
  const routeEl = $('fRoute')
  if (route && route.origin && route.destination) {
    routeEl.classList.remove('missing')
    $('fOrig').textContent = route.origin.iata || route.origin.icao || '—'
    $('fOrigName').textContent = route.origin.city || ''
    $('fDest').textContent = route.destination.iata || route.destination.icao || '—'
    $('fDestName').textContent = route.destination.city || ''
    if (route.iataFlight) $('fIata').textContent = route.iataFlight
    if (route.airlineName && !ac.airline) $('fSub').textContent = [route.airlineName, ac.type].filter(Boolean).join(' · ')
    const p = greatCircleProgress(route.origin, route.destination, ac)
    $('rlProgress').style.width = `${Math.max(2, Math.min(98, p * 100))}%`
  } else {
    routeEl.classList.add('missing')
    $('fOrig').textContent = '—'; $('fOrigName').textContent = ''
    $('fDest').textContent = '—'; $('fDestName').textContent = ''
    $('rlProgress').style.width = '0%'
    if (state.routePending.has(ac.callsign)) $('fOrigName').textContent = '查询航线…'
    else if (ac.callsign) {
      $('fOrigName').textContent = '无航线数据'
      $('fOrig').textContent = '??'
    }
  }
}

function greatCircleProgress(o, d, ac) {
  if (!o || !d || o.lat == null || d.lat == null) return 0
  const R0 = 6371
  const dist = (a, b) => {
    const dLat = (b.lat - a.lat) * DEG
    const dLon = (b.lon - a.lon) * DEG
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2
    return 2 * R0 * Math.asin(Math.sqrt(h))
  }
  const total = dist(o, d)
  if (!total) return 0
  return Math.min(1, Math.max(0, dist(o, ac) / total))
}

async function ensureRoute(ac) {
  if (!ac.callsign || state.routeCache.has(ac.callsign) || state.routePending.has(ac.callsign)) return
  state.routePending.add(ac.callsign)
  renderSheet(ac)
  try {
    const route = await FRData.lookupRoute(ac.callsign)
    state.routeCache.set(ac.callsign, route || null)
  } catch {
    state.routeCache.set(ac.callsign, null)
  } finally {
    state.routePending.delete(ac.callsign)
    if (state.selected && state.selected.callsign === ac.callsign) renderSheet(state.selected)
  }
}

// ------------------------------------------------------------------ lock / unlock
function lockAircraft(ac) {
  if (state.selectedHex && state.selectedHex !== ac.hex) {
    state.trails.delete(state.selectedHex) // 切换目标时清掉旧轨迹
  }
  state.selectedHex = ac.hex
  state.selected = ac
  sheet.classList.remove('hidden')
  $('hint').style.opacity = '0'
  state.trails.set(ac.hex, [])
  recordSelectedTrail(ac)
  renderSheet(ac)
  ensureRoute(ac)
  schedulePoll(2500)
}

function unlock() {
  if (state.selectedHex) state.trails.delete(state.selectedHex)
  state.selectedHex = null
  state.selected = null
  sheet.classList.add('hidden')
  $('hint').style.opacity = '0.8'
  schedulePoll(5000)
}

$('sheetClose').addEventListener('click', unlock)

function pickAt(px, py) {
  let best = null, bestD = Infinity
  for (const h of state.hits) {
    const d = Math.hypot(h.x - px, h.y - py)
    if (d < h.r && d < bestD) { best = h.ac; bestD = d }
  }
  return best
}

let downAt = null
canvas.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY, t: Date.now() } })
canvas.addEventListener('pointerup', (e) => {
  if (!downAt) return
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y)
  const dt = Date.now() - downAt.t
  downAt = null
  if (moved > 12 || dt > 700) return
  const rect = canvas.getBoundingClientRect()
  const ac = pickAt(e.clientX - rect.left, e.clientY - rect.top)
  if (ac) lockAircraft(ac)
  else unlock()
})

// ------------------------------------------------------------------ controls
function setRange(km) {
  state.rangeKm = km
  state.trails.clear()
  if (state.selected) recordSelectedTrail(state.selected)
  $('roRange').textContent = `${km}km`
  for (const b of $('rangebar').querySelectorAll('button')) {
    b.classList.toggle('on', Number(b.dataset.km) === km)
  }
  loadAircraft().catch((e) => showStatus(`刷新失败：${e.message}`))
}
for (const b of $('rangebar').querySelectorAll('button')) {
  b.addEventListener('click', () => setRange(Number(b.dataset.km)))
}

function setView(v) {
  mapState.view = v
  for (const x of $('viewbar').querySelectorAll('button')) x.classList.toggle('on', x.dataset.v === v)
  if (v !== 'radar' && state.center) mapState.z = pickZoom()
}
for (const b of $('viewbar').querySelectorAll('button')) {
  b.addEventListener('click', () => setView(b.dataset.v))
}

// ------------------------------------------------------------------ 显示设置
const PRESETS = {
  black: { brightness: 0, gridOpacity: 1 },
  dark: { brightness: 12, gridOpacity: 1 },
  mid: { brightness: 40, gridOpacity: 0.9 },
  light: { brightness: 78, gridOpacity: 0.7 },
  map: { brightness: 100, gridOpacity: 0.55, mapBg: false, mapGrid: true },
}

function syncThemeUI() {
  $('brightness').value = String(theme.brightness)
  $('brightVal').textContent = String(theme.brightness)
  $('gridOpacity').value = String(Math.round(theme.gridOpacity * 100))
  $('gridVal').textContent = String(Math.round(theme.gridOpacity * 100))
  for (const b of $('colorRow').querySelectorAll('[data-color]')) {
    b.classList.toggle('on', b.dataset.color === theme.color)
  }
  $('tgMapBg').classList.toggle('on', theme.mapBg)
  $('tgMapGrid').classList.toggle('on', theme.mapGrid)
  $('tgSweep').classList.toggle('on', theme.sweep)
  $('tgScan').classList.toggle('on', theme.scanlines)
  $('tgTail').classList.toggle('on', theme.sweepTail)
  $('tgHeading').classList.toggle('on', theme.headingUp)
  // 关掉时直接把整屏横条纹那层去掉，纯靠画布出画面
  document.body.classList.toggle('no-scan', !theme.scanlines)
}

function applyTheme(patch) {
  Object.assign(theme, patch)
  saveTheme()
  syncThemeUI()
}

$('themebtn').addEventListener('click', () => {
  const p = $('themepanel')
  p.classList.toggle('hidden')
  $('themebtn').classList.toggle('on', !p.classList.contains('hidden'))
})

$('brightness').addEventListener('input', (e) => {
  applyTheme({ brightness: Number(e.target.value) })
})
$('gridOpacity').addEventListener('input', (e) => {
  applyTheme({ gridOpacity: Number(e.target.value) / 100 })
})

for (const b of $('themepanel').querySelectorAll('[data-preset]')) {
  b.addEventListener('click', () => {
    const cfg = PRESETS[b.dataset.preset]
    if (cfg) applyTheme(cfg)
  })
}

for (const b of $('colorRow').querySelectorAll('[data-color]')) {
  b.addEventListener('click', () => applyTheme({ color: b.dataset.color }))
}

$('tgMapBg').addEventListener('click', () => applyTheme({ mapBg: !theme.mapBg }))
$('tgMapGrid').addEventListener('click', () => applyTheme({ mapGrid: !theme.mapGrid }))
$('tgSweep').addEventListener('click', () => applyTheme({ sweep: !theme.sweep }))
$('tgScan').addEventListener('click', () => applyTheme({ scanlines: !theme.scanlines }))
$('tgTail').addEventListener('click', () => applyTheme({ sweepTail: !theme.sweepTail }))

syncThemeUI()

for (const b of $('filterbar').querySelectorAll('button')) {
  b.addEventListener('click', () => {
    state.filter = b.dataset.f
    for (const x of $('filterbar').querySelectorAll('button')) x.classList.toggle('on', x === b)
  })
}

$('cleanbtn').addEventListener('click', () => {
  document.body.classList.toggle('clean')
  $('cleanbtn').blur()
})

$('refreshLoc').addEventListener('click', () => refreshLocation())

$('srcbtn').addEventListener('click', () => toggleSources())
$('srcClose').addEventListener('click', () => toggleSources(false))
$('csAdd').addEventListener('click', () => {
  const name = $('csName').value.trim()
  const url = $('csUrl').value.trim()
  try {
    FRData.addCustomProvider({ name, url })
    $('csName').value = ''
    $('csUrl').value = ''
    renderSources()
    showStatus('已添加数据源：' + name + '（记得把域名加进代理白名单）')
  } catch (e) {
    showStatus('添加失败：' + e.message)
  }
})

// 点星弹窗：去点星星 → 以后不再出现；我在用 → 一周后再问
$('starGo').addEventListener('click', () => {
  const st = starState()
  st.state = 'starred'
  st.lastShown = Date.now()
  saveStar(st)
  hideStar()
})
$('starLater').addEventListener('click', () => {
  const st = starState()
  st.state = 'later'
  st.lastShown = Date.now()
  saveStar(st)
  hideStar()
})
$('tgHeading').addEventListener('click', () => {
  startCompass()
  applyTheme({ headingUp: !theme.headingUp })
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') unlock()
})


/** 重新定位：清缓存 → 重新探测 IP 位置 → 换城市就切到卫星图，直接看到自己在哪 */
async function refreshLocation() {
  const btn = $('refreshLoc')
  if (btn) btn.disabled = true
  showStatus('正在重新定位…')
  try {
    FRData.clearCache()
    try { localStorage.removeItem(SNAP_KEY) } catch {}
    const loc = await FRData.detectLocation()
    if (!loc) throw new Error('定位失败，请检查网络')
    const moved = !state.center || FRData.haversineM(state.center.lat, state.center.lon, loc.lat, loc.lon) > 20_000
    state.center = { lat: loc.lat, lon: loc.lon }
    state.placeLabel = [loc.city, loc.region].filter(Boolean).join(' · ') || loc.country || ''
    $('where').textContent = state.placeLabel || '—'
    try {
      localStorage.setItem(LOC_KEY, JSON.stringify({ lat: loc.lat, lon: loc.lon, label: state.placeLabel }))
    } catch {}
    if (moved) {
      state.trails.clear()
      state.autoExpanded = false
      unlock()
      mapState.tiles.clear()
      setView('sat')   // 换城市了：先切卫星图确认位置
    }
    await loadAircraft()
    const via = loc.source === 'gps' ? 'GPS' : '网络'
    showStatus(moved ? `已定位到 ${state.placeLabel}（${via}），切到卫星图` : `位置已刷新：${state.placeLabel}（${via}）`)
  } catch (e) {
    showStatus(`定位失败：${e.message}`)
  } finally {
    if (btn) btn.disabled = false
  }
}

// ------------------------------------------------------------------ 数据源面板
let srcTimer = 0

function fmtAgo(ts) {
  if (!ts) return '从未'
  const d = Math.round((Date.now() - ts) / 1000)
  if (d < 5) return '刚刚'
  if (d < 60) return d + ' 秒前'
  if (d < 3600) return Math.round(d / 60) + ' 分钟前'
  return Math.round(d / 3600) + ' 小时前'
}

function renderSources() {
  const box = $('srcList')
  if (!box || !window.FRData) return
  const list = FRData.providerStatus()
  box.innerHTML = ''
  for (const p of list) {
    const row = document.createElement('div')
    row.className = 'sp-item'
    const dot = document.createElement('i')
    const cooling = p.cooldownMs > 0
    dot.className = 'dot ' + (!p.enabled ? 'off' : cooling || p.fail > p.ok ? 'warn' : 'on')
    const nm = document.createElement('div')
    nm.className = 'nm'
    const b = document.createElement('b')
    b.textContent = p.name + (p.kind === 'custom' ? '（自定义）' : '')
    const sub = document.createElement('span')
    sub.textContent = cooling
      ? '限流冷却 ' + Math.ceil(p.cooldownMs / 1000) + 's'
      : !p.enabled
        ? '已停用'
        : '请求 ' + p.requests + ' · 成功 ' + p.ok + ' · 失败 ' + p.fail + ' · 最近 ' + fmtAgo(p.lastOkAt) +
          (p.lastErr ? ' · ' + p.lastErr : '')
    nm.appendChild(b)
    nm.appendChild(sub)
    const tg = document.createElement('button')
    tg.className = 'sp-tg' + (p.enabled ? ' on' : '')
    tg.textContent = p.enabled ? '开' : '关'
    tg.addEventListener('click', () => {
      FRData.setProviderEnabled(p.name, !p.enabled)
      renderSources()
    })
    row.appendChild(dot)
    row.appendChild(nm)
    row.appendChild(tg)
    if (p.kind === 'custom') {
      const del = document.createElement('button')
      del.className = 'sp-tg del'
      del.textContent = '删'
      del.addEventListener('click', () => {
        FRData.removeCustomProvider(p.name)
        renderSources()
      })
      row.appendChild(del)
    }
    box.appendChild(row)
  }
}

function toggleSources(force) {
  const panel = $('srcpanel')
  if (!panel) return
  const show = force != null ? force : panel.classList.contains('hidden')
  panel.classList.toggle('hidden', !show)
  if (show) {
    renderSources()
    clearInterval(srcTimer)
    srcTimer = setInterval(renderSources, 1000)
  } else {
    clearInterval(srcTimer)
    srcTimer = 0
  }
}

// ------------------------------------------------------------------ 点星提示
function starState() {
  let st = null
  try { st = JSON.parse(localStorage.getItem(STAR_KEY) || 'null') } catch {}
  if (!st) st = { first: Date.now(), launches: 0, state: 'none', lastShown: 0 }
  return st
}

function saveStar(st) {
  try { localStorage.setItem(STAR_KEY, JSON.stringify(st)) } catch {}
}

/** 打开一次就记一次；满足条件才弹，弹过就等下次 */
function maybeAskStar() {
  const st = starState()
  st.launches = (st.launches || 0) + 1
  saveStar(st)
  if (st.state === 'starred') return
  if (st.launches < STAR_MIN_LAUNCH) return
  if (st.state === 'later' && Date.now() - (st.lastShown || 0) < STAR_AGAIN_MS) return
  setTimeout(showStar, 2500)
}

function showStar() {
  const modal = $('starmodal')
  if (!modal) return
  const go = $('starGo')
  if (go) go.href = GITHUB_REPO
  modal.classList.remove('hidden')
}

function hideStar() {
  const modal = $('starmodal')
  if (modal) modal.classList.add('hidden')
}

// ------------------------------------------------------------------ boot
async function boot() {
  resize()
  window.addEventListener('resize', resize)
  window.addEventListener('orientationchange', () => setTimeout(resize, 220))
  $('roRange').textContent = `${state.rangeKm}km`
  startCompass()
  requestAnimationFrame(drawFrame)
  try {
    await loadLocation()
  } catch (e) {
    // 定位失败不挡刷新：用上次位置或默认点，至少还能看到界面
    fallbackLocation(e.message)
  }
  // 先把上次的数据铺上，网络结果回来再覆盖
  restoreSnapshot()
  try {
    await loadAircraft()
  } catch (e) {
    showStatus(`刷新失败：${e.message}`)
  }
  // 无论首屏成功与否都要开始轮询，否则一次失败就再也不刷新了
  schedulePoll()
  maybeAskStar()
}

boot()
