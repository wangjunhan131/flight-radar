/**
 * FlightRadar — 本地航班雷达服务
 *
 * 数据来源（均为公开只读接口）:
 *   - https://api.adsb.lol/v2/point/{lat}/{lon}/{radius}  实时 ADS-B 位置/机型/高度/航向
 *   - https://api.adsbdb.com/v0/callsign/{callsign}        航班号 → 航空公司/起降机场
 *   - https://ipwho.is/                                    无定位时按出口 IP 估计所在城市
 *
 * 用法: node server.js [port]
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.argv[2] || process.env.PORT || 4173)
const ADSB_BASE = 'https://api.adsb.lol/v2'
const ADSBDB_BASE = 'https://api.adsbdb.com/v0'
const MAX_RADIUS_NM = 250
const AIRCRAFT_TTL = 4_000
const ROUTE_TTL = 6 * 60 * 60 * 1000
const GEOLOC_TTL = 60 * 60 * 1000
// Fallback center used when no geolocation provider answers (edit to your city).
const DEFAULT_LAT = Number(process.env.FR_DEFAULT_LAT || 0)
const DEFAULT_LON = Number(process.env.FR_DEFAULT_LON || 0)

// ---------------------------------------------------------------- caches
/** key -> { at, value } */
const routeCache = new Map()
let geolocCache = null
const acCache = new Map() // `${lat},${lon},${radius}` -> { at, value }

// ---------------------------------------------------------------- 持久化快照
/** 把最近一次成功的雷达数据写到磁盘，重启后先秒开旧数据再刷新 */
const SNAP_FILE = path.join(__dirname, '.snapshot.json')
function saveSnapshot(payload) {
  try {
    fs.writeFileSync(SNAP_FILE, JSON.stringify({ at: Date.now(), payload }))
  } catch { /* 磁盘满等异常不影响主流程 */ }
}
function loadSnapshot() {
  try {
    const raw = JSON.parse(fs.readFileSync(SNAP_FILE, 'utf8'))
    if (raw?.payload?.aircraft) {
      const ageSec = Math.round((Date.now() - raw.at) / 1000)
      const p = { ...raw.payload, dataAgeSec: ageSec, fromSnapshot: true }
      acCache.set(`${p.center.lat.toFixed(2)},${p.center.lon.toFixed(2)},${p.radiusNm}`, { at: raw.at, value: p })
      return p
    }
  } catch { /* 首次运行没有快照 */ }
  return null
}
const startupSnapshot = loadSnapshot()

function cached(map, key, ttl, now) {
  const hit = map.get(key)
  if (hit && now - hit.at < ttl) return hit.value
  return null
}

// ---------------------------------------------------------------- fetch helper
async function getJSON(url, { timeout = 12_000, headers = {} } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'flightradar-local/1.0', accept: 'application/json', ...headers },
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 160)}`)
    return JSON.parse(text)
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------- domain helpers
const AIRLINE_NAMES = {
  CCA: '中国国际航空', CSN: '中国南方航空', CES: '中国东方航空', CHH: '海南航空',
  CSZ: '深圳航空', CQH: '春秋航空', CSN_: '南方航空', CUA: '中国联合航空',
  CSC: '四川航空', CDG: '山东航空', CGO: '中原龙浩', XMN: '厦门航空',
  CPA: '国泰航空', CAL: '中华航空', EVA: '长荣航空', THA: '泰国国际航空',
  LAO: '老挝航空', VJC: '越捷航空', HVN: '越南航空', APJ: '乐桃航空',
  JAL: '日本航空', ANA: '全日空', KAL: '大韩航空', AAR: '韩亚航空',
  SIA: '新加坡航空', MAS: '马来西亚航空', GIA: '印尼鹰航', PAL: '菲律宾航空',
  AFR: '法国航空', BAW: '英国航空', DLH: '汉莎航空', KLM: '荷兰皇家航空',
  UAL: '美联航', DAL: '达美航空', AAL: '美国航空', QFA: '澳洲航空',
  UAE: '阿联酋航空', ETD: '阿提哈德航空', QTR: '卡塔尔航空', SVA: '沙特航空',
}
const AIRLINE_ZH_ICAO_PREFIX = {
  CA: 'CCA', MU: 'CES', CZ: 'CSN', HU: 'CHH', ZH: 'CSZ', '9C': 'CQH', '3U': 'CSC',
  SC: 'CDG', MF: 'CXM', 'KN': 'CUA', '3U_': 'CSC', CX: 'CPA', CI: 'CAL', BR: 'EVA',
  TG: 'THA', QV: 'LAO', VJ: 'VJC', VN: 'HVN', MM: 'APJ', JL: 'JAL', NH: 'ANA',
  KE: 'KAL', OZ: 'AAR', SQ: 'SIA', MH: 'MAS', GA: 'GIA', PR: 'PAL', AF: 'AFR',
  BA: 'BAW', LH: 'DLH', KL: 'KLM', UA: 'UAL', DL: 'DAL', AA: 'AAL', QF: 'QFA',
  EK: 'UAE', EY: 'ETD', QR: 'QTR', SV: 'SVA',
}

/** 呼号 -> ICAO 三字码（CCA8144 -> CCA），并生成 IATA 航班号（CA8144）。 */
function parseCallsign(raw) {
  const callsign = String(raw || '').trim().toUpperCase()
  if (!callsign) return { callsign: '', icaoAirline: '', iataFlight: '' }
  const m = /^([A-Z]{3})(\d+[A-Z]?)$/.exec(callsign)
  if (!m) return { callsign, icaoAirline: '', iataFlight: '' }
  const [, icaoAirline, num] = m
  return { callsign, icaoAirline, iataFlight: `${icaoAirline.slice(0, 2)}${num}` }
}

function airlineName(icaoAirline) {
  return AIRLINE_NAMES[icaoAirline] || ''
}

/** 计算 ro = 径向角（从中心指向目标的罗角），自北顺时针，0..360 */
function radialOut(centerLat, centerLon, lat, lon) {
  const toRad = Math.PI / 180
  const dLat = (lat - centerLat) * toRad
  const dLon = (lon - centerLon) * toRad
  const x = dLon * Math.cos(((centerLat + lat) / 2) * toRad)
  const y = dLat
  let deg = (Math.atan2(x, y) * 180) / Math.PI
  if (deg < 0) deg += 360
  return deg
}

function haversineM(centerLat, centerLon, lat, lon) {
  const R = 6371008.8
  const toRad = Math.PI / 180
  const dLat = (lat - centerLat) * toRad
  const dLon = (lon - centerLon) * toRad
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(centerLat * toRad) * Math.cos(lat * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

// ADS-B emitter category：A1/A2=轻型、A3/A4/A5=中/重型、A6=高性能、A7=旋翼机、
// B1/B2/B4=滑翔机/飞艇/气球、B6=无人机、B7=航天器、C*=越野/地面车辆。
const SMALL_CATEGORIES = new Set(['A1', 'A2', 'B1', 'B2', 'B3', 'B4', 'B6'])
const ROTOR_CATEGORIES = new Set(['A7', 'B5'])
/** 常见通航/训练/小型机型关键词 */
const SMALL_TYPE_RE = /^(C1[5-8]\d|C20\d|C21\d|PA-?\d|SR2\d|DA4\d|DA20|DA62|BE\d\d|B36|B58|M20|RV\d|TBM\d|PC12|PC24|KODI|C208|DHC\d|AN2|Y5|J3|J4|LSA|AT-?\d|EMB|VL3|WILGA|SUSA|A22|JABIRU)/i

function classifyAircraft(ac) {
  const cat = ac.category || ''
  const type = String(ac.t || '').toUpperCase()
  if (ac.alt_baro === 'ground') return 'ground'
  if (ROTOR_CATEGORIES.has(cat)) return 'rotor'
  if (SMALL_CATEGORIES.has(cat)) return 'small'
  if (SMALL_TYPE_RE.test(type)) return 'small'
  if (cat === 'B6' || type.startsWith('DJI')) return 'drone'
  if (['A3', 'A4', 'A5', 'A6'].includes(cat)) return cat === 'A5' ? 'heavy' : 'jet'
  const alt = typeof ac.alt_baro === 'number' ? ac.alt_baro : null
  if (alt != null && alt < 10000) return 'low'
  return 'jet'
}

// ---------------------------------------------------------------- normalize
/**
 * 把任意数据源的一条原始记录归一化成前端统一结构。
 * 其它 API 的数据如果字段不同，在 provider 里先映射成 adsb.lol 风格即可复用。
 */
function normalizeAircraft(ac, centerLat, centerLon) {
  const lat = Number(ac.lat)
  const lon = Number(ac.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  const { callsign, icaoAirline, iataFlight } = parseCallsign(ac.flight || ac.callsign)
  const alt = typeof ac.alt_baro === 'number' ? ac.alt_baro : typeof ac.altitude === 'number' ? ac.altitude : null
  return {
    hex: ac.hex || ac.icao24 || ac.id || '',
    callsign,
    iataFlight: iataFlight.replace(/^([A-Z]{2})/, '$1'),
    icaoAirline,
    airline: airlineName(icaoAirline),
    registration: ac.r || ac.registration || '',
    type: ac.t || ac.type || '',
    category: ac.category || '',
    kind: ac.ground === true || ac.on_ground === true ? 'ground' : classifyAircraft(ac),
    lat,
    lon,
    altitudeFt: alt,
    onGround: ac.alt_baro === 'ground' || ac.ground === true || ac.on_ground === true,
    groundSpeedKt: typeof ac.gs === 'number' ? ac.gs : typeof ac.velocity === 'number' ? ac.velocity * 1.94384 : null,
    trackDeg: typeof ac.track === 'number' ? ac.track : typeof ac.heading === 'number' ? ac.heading : null,
    verticalRateFpm: typeof ac.baro_rate === 'number' ? ac.baro_rate : typeof ac.vert_rate === 'number' ? ac.vert_rate * 196.85 : null,
    squawk: ac.squawk || '',
    emergency: ac.emergency || 'none',
    seenPos: typeof ac.seen_pos === 'number' ? ac.seen_pos : null,
    source: ac.__source || 'adsb.lol',
    distanceM: haversineM(centerLat, centerLon, lat, lon),
    bearing: radialOut(centerLat, centerLon, lat, lon),
  }
}

// ---------------------------------------------------------------- route lookup
async function lookupRoute(callsign) {
  if (!callsign) return null
  const now = Date.now()
  const hit = cached(routeCache, callsign, ROUTE_TTL, now)
  if (hit) return hit
  try {
    const data = await getJSON(`${ADSBDB_BASE}/callsign/${encodeURIComponent(callsign)}`, { timeout: 10_000 })
    const r = data?.response?.flightroute
    const value = r
      ? {
          callsign: r.callsign || callsign,
          iataFlight: r.callsign_iata || '',
          airlineName: r.airline?.name || '',
          airlineIata: r.airline?.iata || '',
          airlineIcao: r.airline?.icao || '',
          origin: r.origin
            ? {
                iata: r.origin.iata_code || '',
                icao: r.origin.icao_code || '',
                name: r.origin.name || '',
                city: r.origin.municipality || '',
                lat: r.origin.latitude,
                lon: r.origin.longitude,
              }
            : null,
          destination: r.destination
            ? {
                iata: r.destination.iata_code || '',
                icao: r.destination.icao_code || '',
                name: r.destination.name || '',
                city: r.destination.municipality || '',
                lat: r.destination.latitude,
                lon: r.destination.longitude,
              }
            : null,
        }
      : null
    routeCache.set(callsign, { at: now, value })
    return value
  } catch {
    routeCache.set(callsign, { at: now, value: null })
    return null
  }
}

// ---------------------------------------------------------------- geolocation
async function detectLocation() {
  const now = Date.now()
  if (geolocCache && now - geolocCache.at < GEOLOC_TTL) return geolocCache.value
  const providers = [
    async () => {
      const d = await getJSON('https://ipwho.is/', { timeout: 8_000 })
      if (!d?.success) throw new Error('ipwho failed')
      return { lat: d.latitude, lon: d.longitude, city: d.city, region: d.region, country: d.country, source: 'ipwho.is' }
    },
    async () => {
      const d = await getJSON('https://ipinfo.io/json', { timeout: 8_000 })
      const [lat, lon] = String(d.loc || '').split(',').map(Number)
      return { lat, lon, city: d.city, region: d.region, country: d.country, source: 'ipinfo.io' }
    },
  ]
  for (const p of providers) {
    try {
      const v = await p()
      if (Number.isFinite(v.lat) && Number.isFinite(v.lon)) {
        geolocCache = { at: now, value: v }
        return v
      }
    } catch { /* try next */ }
  }
  // Last resort when no geolocation service answers: DEFAULT_CENTER (edit it to your city).
  const fallback = { lat: DEFAULT_LAT, lon: DEFAULT_LON, city: 'Unknown', region: '', country: '', source: 'fallback' }
  geolocCache = { at: now, value: fallback }
  return fallback
}

// ---------------------------------------------------------------- aircraft feed
/**
 * api.adsb.lol 单次查询上限 250nm。为了尽量多装飞机（含低空通航、小飞机），
 * 在雷达盘内铺一张查询点网格，每个点按 250nm 查询后按 hex 去重合并。
 * 网格间距取 250nm 的 ~0.72，保证相邻覆盖圆有重叠、不漏区。
 */
function queryGrid(lat, lon, radiusNm) {
  const spacingNm = gridSpacingNm() // 由已注册数据源的最大半径推导（默认 215nm）
  const reachNm = radiusNm // 圆盘半径；外圈点用 250nm 半径即可覆盖盘内
  const latStep = spacingNm / 60.0405
  const offsetNm = Math.ceil(reachNm / spacingNm) * spacingNm
  const dLatMax = offsetNm / 60.0405
  const dLonMax = offsetNm / (60.0405 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)))
  const pts = []
  for (let dLat = -dLatMax; dLat <= dLatMax + 1e-9; dLat += latStep) {
    const latRow = lat + dLat
    if (latRow > 84 || latRow < -84) continue
    const lonCount = Math.floor(dLonMax / (latStep / Math.max(0.2, Math.cos((latRow * Math.PI) / 180))))
    const dLon = latStep / Math.max(0.2, Math.cos((latRow * Math.PI) / 180))
    for (let i = -lonCount; i <= lonCount; i++) {
      pts.push([latRow, lon + i * dLon])
    }
  }
  return pts
}

/**
 * 每个查询点单独缓存（POINT_TTL），限流时不会整体失败：
 * 有缓存就回退到旧数据，并把失败点计入"部分失败"，前端可继续使用。
 */
const pointCache = new Map()
/** 各数据源独立的点缓存：key = `${srcName}|${lat},${lon}` —— 让慢速源（OpenSky）用更长 TTL */
const srcCache = new Map()
/** 各数据源独立的点缓存：key = `${srcName}|${lat},${lon}` —— 让慢速源（OpenSky）用更长 TTL */

const POINT_TTL = 20_000        // 命中缓存就不再请求（前端 3~5 秒轮询时不会打爆接口）
const POINT_SOFT_TTL = 600_000  // 过期后仍可回退显示
const CONCURRENCY = 4
const MAX_INFLIGHT_REQUESTS = 3  // 同时对 adsb.lol 的请求上限（并发而非串行）
const REQUEST_GAP_MS = 220       // 发起新请求的最小间隔（滑动窗口）
let lastRequestAt = 0
let cooldownUntil = 0            // 命中 429 后全局冷却
let activeRequests = 0
const waiters = []

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function slotRelease() {
  activeRequests--
  const next = waiters.shift()
  if (next) next()
}

/** 并发窗口 + 发起间隔节流：慢请求不再阻塞后续请求 */
function acquireSlot() {
  return new Promise((resolve) => {
    const tryAcquire = async () => {
      while (activeRequests >= MAX_INFLIGHT_REQUESTS) {
        await new Promise((r) => waiters.push(r))
      }
      // 冷却期（被限流后）统一等待
      const cd = cooldownUntil - Date.now()
      if (cd > 0) await sleep(cd)
      const gap = lastRequestAt + REQUEST_GAP_MS - Date.now()
      if (gap > 0) await sleep(gap)
      activeRequests++
      lastRequestAt = Date.now()
      resolve()
    }
    tryAcquire()
  })
}

async function throttled(url, timeout) {
  await acquireSlot()
  try {
    return await getJSON(url, { timeout })
  } finally {
    slotRelease()
  }
}

function roundPoint(lat, lon) {
  return [Number(lat.toFixed(4)), Number(lon.toFixed(4))]
}

async function fetchPoint(lat, lon, { force = false } = {}) {
  const key = `${lat},${lon}`
  const now = Date.now()
  const hit = pointCache.get(key)
  if (hit && !force && now - hit.at < POINT_TTL) return { ok: true, ac: hit.ac, stale: false, at: hit.at }
  if (hit && now - hit.at < POINT_SOFT_TTL) {
    // 软过期：先返回旧数据，并在后台刷新
    refreshPoint(key, lat, lon).catch(() => {})
    return { ok: true, ac: hit.ac, stale: true, at: hit.at }
  }
  return refreshPoint(key, lat, lon)
}

const inflight = new Map()
// ---------------------------------------------------------------- 数据源插件层
/**
 * 可插拔数据源。每个 provider:
 *   name        唯一标识
 *   enabled     是否启用
 *   maxRadiusNm 单次查询最大半径（决定网格间距）
 *   fetchPoint({lat, lon, radiusNm}) -> Promise<Array<原始记录>>   // 原始记录需含 lat/lon
 *   normalize(ac, centerLat, centerLon) -> 归一化对象（默认用 normalizeAircraft）
 *
 * 接入新 API：写一个 provider 丢进 DATA_SOURCES 即可；若字段不同，实现 normalize 或在
 * fetchPoint 里先映射成 adsb.lol 风格（lat/lon/hex/flight/alt_baro/gs/track/t/category/r）。
 * 另外支持从环境变量/配置文件覆盖 adsb.lol 地址：ADSB_API_BASE=https://your.api/v2
 */
const adsbLolProvider = {
  name: 'adsb.lol',
  enabled: true,
  maxRadiusNm: MAX_RADIUS_NM,
  async fetchPoint({ lat, lon }) {
    const data = await throttled(`${ADSB_BASE}/point/${lat}/${lon}/${MAX_RADIUS_NM}`, 12_000)
    return Array.isArray(data?.ac) ? data.ac : []
  },
  normalize: normalizeAircraft,
}

/** adsb.fi 的开放数据端点：字段与 adsb.lol 基本一致，直接用同一套归一化 */
const adsbFiProvider = {
  name: 'adsb.fi',
  enabled: true,
  maxRadiusNm: MAX_RADIUS_NM,
  async fetchPoint({ lat, lon, radiusNm }) {
    const r = Math.min(MAX_RADIUS_NM, Math.round(radiusNm || MAX_RADIUS_NM))
    const data = await throttled(`https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${r}`, 14_000)
    return Array.isArray(data?.aircraft) ? data.aircraft : []
  },
  normalize: normalizeAircraft,
}

/**
 * OpenSky Network：一次请求返回一个矩形区域内的全部目标（states 数组）。
 * 匿名访问有频率限制（约 400 次/天），故缓存时间拉长到 30s，且失败不阻塞其它源。
 */
const openskyProvider = {
  name: 'opensky',
  enabled: true,
  maxRadiusNm: MAX_RADIUS_NM,
  ttlMs: 30_000,
  // states 元组下标
  // 0 icao24, 1 callsign, 2 origin_country, 3 time_position, 4 last_contact,
  // 5 lon, 6 lat, 7 baro_alt_m, 8 on_ground, 9 velocity(m/s), 10 true_track,
  // 11 vertical_rate(m/s), 12 sensors, 13 geo_alt_m, 14 squawk, 15 spi, 16 position_source
  async fetchPoint({ lat, lon, radiusNm }) {
    const km = Math.min(MAX_RADIUS_NM, radiusNm || MAX_RADIUS_NM) * 1.852
    const dLat = km / 111.32
    const dLon = km / (111.32 * Math.max(0.15, Math.cos((lat * Math.PI) / 180)))
    const url =
      'https://opensky-network.org/api/states/all' +
      `?lamin=${(lat - dLat).toFixed(3)}&lamax=${(lat + dLat).toFixed(3)}` +
      `&lomin=${(lon - dLon).toFixed(3)}&lomax=${(lon + dLon).toFixed(3)}`
    const data = await throttled(url, 16_000)
    const rows = Array.isArray(data?.states) ? data.states : []
    return rows
      .map((s) => {
        if (!Array.isArray(s) || s[5] == null || s[6] == null) return null
        const altM = typeof s[13] === 'number' ? s[13] : typeof s[7] === 'number' ? s[7] : null
        return {
          hex: String(s[0] || '').toLowerCase(),
          flight: String(s[1] || '').trim(),
          lat: s[6],
          lon: s[5],
          on_ground: s[8] === true,
          ground: s[8] === true,
          altitude: altM == null ? null : Math.round(altM * 3.28084),
          velocity: typeof s[9] === 'number' ? s[9] : null,
          heading: typeof s[10] === 'number' ? s[10] : null,
          vert_rate: typeof s[11] === 'number' ? s[11] : null,
          squawk: s[14] || '',
          category: '',
          t: '',
          r: '',
        }
      })
      .filter((ac) => ac && ac.hex)
  },
  normalize: normalizeAircraft,
}

/** @type {Array<typeof adsbLolProvider>} */
const DATA_SOURCES = [adsbLolProvider, adsbFiProvider, openskyProvider]

const activeSources = () => DATA_SOURCES.filter((s) => s.enabled)

/** 由已注册数据源推导出的网格间距（各源最大半径的最小值，留 15% 余量防空洞） */
function gridSpacingNm() {
  const srcs = activeSources()
  if (!srcs.length) return 215
  const minMax = Math.min(...srcs.map((s) => s.maxRadiusNm || MAX_RADIUS_NM))
  return Math.floor(minMax * 0.86)
}

/** 单条记录的信息完整度打分：用于多源合并时挑更好的那条 */
function recordScore(a) {
  let n = 0
  if (a.callsign) n += 4
  if (a.type) n += 3
  if (a.registration) n += 3
  if (a.category) n += 2
  if (a.airline) n += 1
  if (a.trackDeg != null) n += 2
  if (a.groundSpeedKt != null) n += 1
  if (a.altitudeFt != null) n += 2
  if (a.squawk) n += 1
  if (typeof a.seenPos === 'number') n += Math.max(0, 4 - a.seenPos)
  return n
}

/**
 * 合并同一架飞机（同一 hex）来自不同数据源的记录。
 * 以信息更全的一条为基准，用另一条补齐它缺失的字段，并记录所有来源。
 */
function mergeRecord(a, b) {
  const [hi, lo] = recordScore(a) >= recordScore(b) ? [a, b] : [b, a]
  const out = { ...hi }
  const fillKeys = [
    'callsign', 'type', 'registration', 'category', 'airline', 'squawk',
    'trackDeg', 'groundSpeedKt', 'altitudeFt', 'verticalRateFpm',
  ]
  for (const k of fillKeys) {
    if ((out[k] == null || out[k] === '') && lo[k] != null && lo[k] !== '') out[k] = lo[k]
  }
  if (!out.iataFlight && lo.iataFlight) out.iataFlight = lo.iataFlight
  // 来源去重：同一架飞机可能被多个网格点从同一源重复命中
  const split = (v) => String(v || '').split('+').filter(Boolean)
  const srcs = [...new Set([...split(hi.source), ...split(lo.source)])]
  out.source = srcs.join('+')
  return out
}

function refreshPoint(key, lat, lon) {
  if (inflight.has(key)) return inflight.get(key)
  const p = (async () => {
    let attempt = 0
    let lastErr = null
    while (attempt < 2) {
      try {
        // 并发向所有启用的数据源取该点；单源失败不影响其它源
        const srcs = activeSources()
        const results = await Promise.allSettled(
          srcs.map(async (src) => {
            const cacheKey = `${src.name}|${key}`
            const hit = srcCache.get(cacheKey)
            const ttl = src.ttlMs || POINT_TTL
            if (hit && Date.now() - hit.at < ttl) return hit.ac
            const list = await src.fetchPoint({ lat, lon, radiusNm: src.maxRadiusNm })
            const tagged = list.map((ac) => ({ ...ac, __source: src.name }))
            srcCache.set(cacheKey, { at: Date.now(), ac: tagged })
            return tagged
          }),
        )
        const ac = []
        let okAny = false
        for (const r of results) {
          if (r.status === 'fulfilled') { okAny = true; ac.push(...r.value) }
          else lastErr = r.reason
        }
        if (okAny) {
          pointCache.set(key, { at: Date.now(), ac })
          return { ok: true, ac, stale: false, at: Date.now() }
        }
        throw lastErr || new Error('所有数据源均失败')
      } catch (err) {
        lastErr = err
        attempt++
        if (/429|rate limit/i.test(String(err?.message))) {
          // 限流：进入较短全局冷却，本次放弃该点（用旧缓存兜底），不拖慢整体
          cooldownUntil = Date.now() + 3_000
          break
        }
        if (attempt < 2) await sleep(300 * attempt)
      }
    }
    // 失败：如有旧缓存则回退
    const old = pointCache.get(key)
    if (old) return { ok: false, error: String(lastErr?.message || lastErr), ac: old.ac, stale: true, at: old.at }
    return { ok: false, error: String(lastErr?.message || lastErr), ac: [], stale: true, at: 0 }
  })().finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

// 注意：这里只限制了查询点数量上限，避免超大半径把接口打爆。
const MAX_QUERY_POINTS = 25

/** /api/fetch 允许访问的主机白名单（前端数据层会用到这些域名） */
const ALLOWED_HOSTS = [
  'adsb.lol',
  'adsb.fi',
  'opensky-network.org',
  'adsbdb.com',
  'ipwho.is',
  'ipinfo.io',
  'autonavi.com',
]
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36'

async function aircraftNear(lat, lon, radius) {
  const r = Math.max(10, Math.min(1200, Math.round(radius)))
  const now = Date.now()

  let pts = queryGrid(lat, lon, r)
  if (pts.length > MAX_QUERY_POINTS) {
    // 过大半径时稀疏采样，避免请求风暴
    const step = Math.ceil(pts.length / MAX_QUERY_POINTS)
    pts = pts.filter((_, i) => i % step === 0)
  }

  const merged = new Map()
  let okCount = 0
  let staleCount = 0
  let failedCount = 0
  let oldest = Infinity

  // 按“离中心远近”排序查询：小半径时最近的点先请求，尽早出图
  pts.sort((a, b) => {
    const da = (a[0] - lat) ** 2 + ((a[1] - lon) * Math.cos(lat * (Math.PI / 180))) ** 2
    const db = (b[0] - lat) ** 2 + ((b[1] - lon) * Math.cos(lat * (Math.PI / 180))) ** 2
    return da - db
  })

  for (let i = 0; i < pts.length; i += CONCURRENCY) {
    const batch = pts.slice(i, i + CONCURRENCY)
    const results = await Promise.all(batch.map(([plat, plon]) => fetchPoint(plat, plon)))
    for (const res of results) {
      if (res.ok) okCount++
      else failedCount++
      if (res.stale) staleCount++
      if (res.at && res.at < oldest) oldest = res.at
      for (const item of res.ac) {
        const ac = item.__normalized ? item : normalizeAircraft(item, lat, lon)
        if (!ac || !ac.hex) continue
        const prev = merged.get(ac.hex)
        if (!prev) { merged.set(ac.hex, ac); continue }
        // 同一架飞机被多个源报告时，保留信息量更大的一条（有呼号/机型/航向者优先）
        merged.set(ac.hex, mergeRecord(prev, ac))
      }
    }
    // 所有点都在限流中且毫无收获——提前结束，用上一次成功结果兜底
    if (!okCount && failedCount === i + batch.length && cooldownUntil > Date.now()) break
  }

  const cacheKey = `${lat.toFixed(2)},${lon.toFixed(2)},${r}`
  const prev = acCache.get(cacheKey)?.value

  if (!okCount) {
    // 全部失败：回退到上一次成功的数据，并显式标记
    if (prev) {
      const ageSec = Math.max(0, Math.round((now - prev.generatedAt * 1000) / 1000))
      return { ...prev, dataAgeSec: ageSec, pointsOk: 0, pointsFailed: failedCount, pointsStale: pts.length, degraded: true }
    }
    throw new Error(`ADS-B 查询失败（${failedCount} 个点均失败，可能是限流，请稍后再试）`)
  }

  const list = [...merged.values()]
    .filter(Boolean)
    .filter((ac) => ac.distanceM <= r * 1852)
    .sort((a, b) => a.distanceM - b.distanceM)

  const payload = {
    center: { lat, lon },
    radiusNm: r,
    generatedAt: Math.floor(now / 1000),
    dataAgeSec: Number.isFinite(oldest) ? Math.max(0, Math.round((now - oldest) / 1000)) : 0,
    count: list.length,
    queryPoints: pts.length,
    pointsOk: okCount,
    pointsStale: staleCount,
    pointsFailed: failedCount,
    aircraft: list,
  }
  acCache.set(cacheKey, { at: now, value: payload })
  if (okCount >= pts.length * 0.6) saveSnapshot(payload) // 只在数据较完整时落盘
  return payload
}

// ---------------------------------------------------------------- http server
const tileCache = new Map()
const TILE_TTL = 7 * 24 * 60 * 60 * 1000

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }

function sendJSON(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store' })
  res.end(buf)
}

function parseQuery(url) {
  return Object.fromEntries(url.searchParams.entries())
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  try {
    if (url.pathname === '/api/location') {
      const loc = await detectLocation()
      return sendJSON(res, 200, loc)
    }

    if (url.pathname === '/api/aircraft') {
      const q = parseQuery(url)
      let lat = Number(q.lat)
      let lon = Number(q.lon)
      const radius = Number(q.radius || 150)
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        const loc = await detectLocation()
        lat = loc.lat
        lon = loc.lon
      }
      try {
        const data = await aircraftNear(lat, lon, radius)
        return sendJSON(res, 200, data)
      } catch (err) {
        // 抓取失败（限流/断网）时，用启动快照先顶上，前端会标注数据陈旧
        if (startupSnapshot) {
          const ageSec = Math.round((Date.now() - startupSnapshot.generatedAt * 1000) / 1000)
          return sendJSON(res, 200, { ...startupSnapshot, dataAgeSec: ageSec, degraded: true })
        }
        return sendJSON(res, 503, { error: String(err?.message || err) })
      }
    }

    if (url.pathname === '/api/route') {
      const q = parseQuery(url)
      const route = await lookupRoute(String(q.callsign || '').trim().toUpperCase())
      return sendJSON(res, 200, { route })
    }

    if (url.pathname === '/api/providers') {
      return sendJSON(res, 200, {
        providers: DATA_SOURCES.map((s) => ({ name: s.name, enabled: s.enabled, maxRadiusNm: s.maxRadiusNm })),
        gridSpacingNm: gridSpacingNm(),
        note: '在 server.js 的 DATA_SOURCES 数组中追加 provider 即可接入其它航班 API；字段不同时实现 normalize 或先映射为 adsb.lol 风格。',
      })
    }

    // 通用代理：浏览器无法直连 adsb.lol / adsb.fi / opensky（都没有 CORS 头）。
    // 前端数据层统一走这里，安卓内嵌服务器提供同名接口，两端逻辑完全一致。
    // 只允许白名单主机，避免这个端点变成任意 SSRF 跳板。
    if (url.pathname === '/api/fetch') {
      const target = String(parseQuery(url).u || '')
      let tu
      try { tu = new URL(target) } catch { return sendJSON(res, 400, { error: 'bad url' }) }
      if (tu.protocol !== 'https:' || !ALLOWED_HOSTS.some((h) => tu.hostname === h || tu.hostname.endsWith('.' + h))) {
        return sendJSON(res, 403, { error: 'host not allowed' })
      }
      try {
        const r = await fetch(tu.href, {
          headers: { 'User-Agent': UA, Accept: '*/*' },
          signal: AbortSignal.timeout(15_000),
        })
        const buf = Buffer.from(await r.arrayBuffer())
        res.writeHead(r.status, {
          'Content-Type': r.headers.get('content-type') || 'application/octet-stream',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
          'X-Upstream-Status': String(r.status),
        })
        return res.end(buf)
      } catch (err) {
        return sendJSON(res, 502, { error: String(err?.message || err) })
      }
    }

    if (url.pathname === '/api/health') {
      return sendJSON(res, 200, { ok: true, uptime: Math.round(process.uptime()), routes: routeCache.size })
    }

    // 地图瓦片代理：浏览器直连高德会被 CORS/防盗链拦，这里转发并缓存。
    if (url.pathname === '/api/tile') {
      const q = parseQuery(url)
      const z = Number(q.z)
      const x = Number(q.x)
      const y = Number(q.y)
      const style = q.style === 'sat' ? 'sat' : 'street'
      if (![z, x, y].every(Number.isInteger) || z < 0 || z > 18 || x < 0 || y < 0) {
        return sendJSON(res, 400, { error: 'bad tile params' })
      }
      const key = `${style}/${z}/${x}/${y}`
      const hit = tileCache.get(key)
      if (hit && Date.now() - hit.at < TILE_TTL) {
        res.writeHead(200, { 'content-type': hit.mime, 'cache-control': 'public, max-age=86400', 'content-length': hit.buf.length })
        return res.end(hit.buf)
      }
      const host = style === 'sat' ? 'webst01' : 'webrd01'
      const src =
        style === 'sat'
          ? `https://${host}.is.autonavi.com/appmaptile?x=${x}&y=${y}&z=${z}&style=6`
          : `https://${host}.is.autonavi.com/appmaptile?x=${x}&y=${y}&z=${z}&lang=zh_cn&size=1&scale=1&style=8`
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 12_000)
      try {
        const r = await fetch(src, { signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.amap.com/' } })
        if (!r.ok) throw new Error(`tile HTTP ${r.status}`)
        const buf = Buffer.from(await r.arrayBuffer())
        const mime = r.headers.get('content-type') || 'image/png'
        if (tileCache.size > 1500) tileCache.clear()
        tileCache.set(key, { at: Date.now(), buf, mime })
        res.writeHead(200, { 'content-type': mime, 'cache-control': 'public, max-age=86400', 'content-length': buf.length })
        return res.end(buf)
      } finally {
        clearTimeout(timer)
      }
    }

    // static
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '')
    const file = path.join(__dirname, 'public', path.normalize(rel).replace(/^(\.\.[/\\])+/, ''))
    if (!file.startsWith(path.join(__dirname, 'public'))) {
      return sendJSON(res, 403, { error: 'forbidden' })
    }
    const body = fs.readFileSync(file)
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' })
    res.end(body)
  } catch (err) {
    sendJSON(res, 502, { error: String(err?.message || err) })
  }
})

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用——可能已经有一个 FlightRadar 在运行，本次退出以避免重复抓取。`)
    process.exit(1)
  }
  console.error(err)
  process.exit(1)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`FlightRadar listening on http://127.0.0.1:${PORT}`)
})
