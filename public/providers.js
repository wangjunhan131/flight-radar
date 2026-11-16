/* ------------------------------------------------------------------------
 * providers.js —— 航班数据层（前端）
 *
 * 为什么在前端：adsb.lol / adsb.fi / opensky 都没有 CORS 头，浏览器不能直连。
 * 于是所有网络请求统一走 /api/fetch（网页版由 node 提供，安卓 APP 由内嵌
 * 服务器提供，接口同名）。数据解析、多源合并、去重、排序全部在这里做，
 * 网页版和 APP 因此共享同一套逻辑。
 *
 * 想接入别的航班 API？在 PROVIDERS 里追加一项，或调用：
 *   FRData.registerProvider({ name, maxRadiusNm, ttlMs, buildUrl, parse })
 *   buildUrl({lat, lon, radiusNm}) -> string
 *   parse(text) -> 原始目标数组（实现 normalize 前的字段映射）
 * 字段命名以 adsb.lol 为基准（hex/flight/lat/lon/alt_baro/gs/track/category...），
 * 其它源只需在 parse 里映射成这套名字。
 * --------------------------------------------------------------------- */
(function () {
  'use strict'

  const DEG = Math.PI / 180
  const NM_PER_KM = 1 / 1.852

  /* ------------------------------------------------ 数据源适配器 */

  const adsbLolProvider = {
    name: 'adsb.lol',
    maxRadiusNm: 250,
    ttlMs: 10_000,
    gapMs: 900,
    buildUrl: ({ lat, lon, radiusNm }) =>
      `https://api.adsb.lol/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/${Math.min(250, Math.round(radiusNm))}`,
    parse: (text) => {
      const j = JSON.parse(text)
      return Array.isArray(j.ac) ? j.ac : []
    },
  }

  const adsbFiProvider = {
    name: 'adsb.fi',
    maxRadiusNm: 250,
    ttlMs: 10_000,
    gapMs: 850,
    buildUrl: ({ lat, lon, radiusNm }) =>
      `https://opendata.adsb.fi/api/v2/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${Math.min(250, Math.round(radiusNm))}`,
    parse: (text) => {
      const j = JSON.parse(text)
      return Array.isArray(j.aircraft) ? j.aircraft : []
    },
  }

  // OpenSky 返回的是矩形区域的状态元组，这里映射成 adsb.lol 风格字段
  const openskyProvider = {
    name: 'opensky',
    maxRadiusNm: 250,
    ttlMs: 25_000,
    gapMs: 300,
    buildUrl: ({ lat, lon, radiusNm }) => {
      const km = Math.min(250, radiusNm) * 1.852
      const dLat = km / 111.32
      const dLon = km / (111.32 * Math.max(0.15, Math.cos(lat * DEG)))
      return (
        'https://opensky-network.org/api/states/all' +
        `?lamin=${(lat - dLat).toFixed(3)}&lamax=${(lat + dLat).toFixed(3)}` +
        `&lomin=${(lon - dLon).toFixed(3)}&lomax=${(lon + dLon).toFixed(3)}`
      )
    },
    parse: (text) => {
      const j = JSON.parse(text)
      const rows = Array.isArray(j.states) ? j.states : []
      const out = []
      for (const s of rows) {
        if (!Array.isArray(s) || s[5] == null || s[6] == null) continue
        const altM = typeof s[13] === 'number' ? s[13] : typeof s[7] === 'number' ? s[7] : null
        out.push({
          hex: String(s[0] || ''),
          flight: String(s[1] || '').trim(),
          lat: s[6],
          lon: s[5],
          ground: s[8] === true,
          altitude: altM == null ? null : Math.round(altM * 3.28084),
          velocity: typeof s[9] === 'number' ? s[9] : null,
          heading: typeof s[10] === 'number' ? s[10] : null,
          vert_rate: typeof s[11] === 'number' ? s[11] : null,
          squawk: s[14] || '',
        })
      }
      return out
    },
  }

  const PROVIDERS = [adsbLolProvider, adsbFiProvider, openskyProvider]

  /* ------------------------------------------------ 源开关 / 状态 / 自定义源 */

  const CUSTOM_KEY = 'fr.customsrc'
  /** name -> { requests, ok, fail, lastAt, lastOkAt, lastErr, lastCount } */
  const providerStats = new Map()
  const isOn = (p) => p && p.enabled !== false
  const stat = (name) => {
    let v = providerStats.get(name)
    if (!v) { v = { requests: 0, ok: 0, fail: 0, lastAt: 0, lastOkAt: 0, lastErr: '', lastCount: 0 }; providerStats.set(name, v) }
    return v
  }

  function setProviderEnabled(name, on) {
    const p = PROVIDERS.find((x) => x.name === name)
    if (!p) return false
    p.enabled = !!on
    if (!on) cache.forEach((v, k) => { if (k.startsWith(name + '|')) cache.delete(k) })
    return true
  }

  /** 面板用：每个源的开关、冷却剩余、成功率、最近错误 */
  function providerStatus() {
    return PROVIDERS.map((p) => {
      const st = stat(p.name)
      return {
        name: p.name,
        kind: p.kind || 'builtin',
        enabled: isOn(p),
        maxRadiusNm: p.maxRadiusNm || 250,
        cooldownMs: cooldownLeft(p),
        requests: st.requests,
        ok: st.ok,
        fail: st.fail,
        lastOkAt: st.lastOkAt,
        lastCount: st.lastCount,
        lastErr: st.lastErr,
      }
    })
  }

  /** 把 adsb.lol / adsb.fi / 自家后端这几种常见返回都解成目标数组 */
  function parseLoose(text) {
    const j = JSON.parse(text)
    const arr = j.ac || j.aircraft || j.data || j.results || j.planes || (Array.isArray(j) ? j : [])
    return Array.isArray(arr) ? arr : []
  }

  function addCustomProvider({ name, url, gapMs, ttlMs, maxRadiusNm }) {
    const nm = String(name || '').trim()
    if (!nm || !/^https:\/\//.test(String(url || ''))) throw new Error('需要名称和 https 地址')
    if (PROVIDERS.some((p) => p.name === nm)) throw new Error('同名源已存在')
    const tpl = String(url)
    registerProvider({
      name: nm,
      kind: 'custom',
      maxRadiusNm: Number(maxRadiusNm) || 250,
      gapMs: Number(gapMs) || 1000,
      ttlMs: Number(ttlMs) || 15_000,
      buildUrl: ({ lat, lon, radiusNm }) =>
        tpl.replace(/\{lat\}|\{lon\}|\{radius\}|\{radiusKm\}/g, (m) =>
          m === '{radiusKm}' ? String(Math.round(radiusNm * 1.852)) : String(m === '{lat}' ? lat : m === '{lon}' ? lon : radiusNm)),
      parse: parseLoose,
    })
    saveCustom()
    return nm
  }

  function removeCustomProvider(name) {
    const i = PROVIDERS.findIndex((p) => p.name === name && p.kind === 'custom')
    if (i < 0) return false
    PROVIDERS.splice(i, 1)
    providerStats.delete(name)
    saveCustom()
    return true
  }

  function saveCustom() {
    try {
      const list = PROVIDERS.filter((p) => p.kind === 'custom').map((p) => ({
        name: p.name, url: p.url, gapMs: p.gapMs, ttlMs: p.ttlMs, maxRadiusNm: p.maxRadiusNm, enabled: p.enabled !== false,
      }))
      localStorage.setItem(CUSTOM_KEY, JSON.stringify(list))
    } catch { /* 无 localStorage 时忽略 */ }
  }

  function loadCustom() {
    try {
      const list = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]')
      for (const c of list) {
        if (!c || !c.name || !c.url) continue
        const tpl = String(c.url)
        PROVIDERS.push({
          name: c.name, kind: 'custom', url: tpl,
          maxRadiusNm: Number(c.maxRadiusNm) || 250,
          gapMs: Number(c.gapMs) || 1000, ttlMs: Number(c.ttlMs) || 15_000,
          enabled: c.enabled !== false,
          buildUrl: ({ lat, lon, radiusNm }) =>
            tpl.replace(/\{lat\}|\{lon\}|\{radius\}|\{radiusKm\}/g, (m) =>
              m === '{radiusKm}' ? String(Math.round(radiusNm * 1.852)) : String(m === '{lat}' ? lat : m === '{lon}' ? lon : radiusNm)),
          parse: parseLoose,
        })
      }
    } catch { /* ignore */ }
  }

  function registerProvider(p) {
    if (!p || !p.name || typeof p.buildUrl !== 'function' || typeof p.parse !== 'function') {
      throw new Error('provider 需要 name / buildUrl / parse')
    }
    PROVIDERS.push({ maxRadiusNm: 250, ttlMs: 20_000, enabled: true, ...p })
  }

  /* ------------------------------------------------ 机型分类（与旧版 server 一致） */

  const SMALL_CATEGORIES = new Set(['A1', 'A2', 'B1', 'B2', 'B3', 'B4', 'B6'])
  const ROTOR_CATEGORIES = new Set(['A7', 'B5'])
  const SMALL_TYPE_RE =
    /^(C15[0-9]|C16[0-9]|C17[0-9]|C18[0-9]|PA-?2[0-9]|PA-?3[0-9]|SR2[0-9]|SR22|DA[24]0|DA42|M20|BE[0-9]{2}|C20[0-9]|C210|TBM|PC12|KODI|RV[0-9]|WT9|VL3|AT-?[0-9]|P200|P2010|JABIRU|TECNAM|P92|P2008|CH7[0-9]|STOL|SAVANNAH|X-AIR|Ikarus|ZL[0-9]|MTO)/i

  function classifyAircraft(ac) {
    const cat = String(ac.category || '').toUpperCase()
    if (ac.ground === true || ac.alt_baro === 'ground') return 'ground'
    if (ROTOR_CATEGORIES.has(cat)) return 'rotor'
    if (SMALL_CATEGORIES.has(cat)) return 'small'
    const type = String(ac.t || '').toUpperCase()
    if (type && SMALL_TYPE_RE.test(type)) return 'small'
    const alt = typeof ac.alt_baro === 'number' ? ac.alt_baro : null
    if (alt != null && alt < 3000) return 'low'
    if (cat === 'A5') return 'heavy'
    return 'jet'
  }

  /* ------------------------------------------------ 归一化 */

  function normalizeAircraft(ac, center, source) {
    const hex = String(ac.hex || ac.icao24 || ac.id || '').trim().toLowerCase()
    if (!hex) return null
    const lat = Number(ac.lat)
    const lon = Number(ac.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null

    let altitudeFt = null
    if (typeof ac.alt_baro === 'number') altitudeFt = ac.alt_baro
    else if (typeof ac.altitude === 'number') altitudeFt = ac.altitude
    else if (ac.alt_baro === 'ground') altitudeFt = 0

    let groundSpeedKt = null
    if (typeof ac.gs === 'number') groundSpeedKt = ac.gs
    else if (typeof ac.velocity === 'number') groundSpeedKt = ac.velocity * 1.94384

    let verticalRateFpm = null
    if (typeof ac.baro_rate === 'number') verticalRateFpm = ac.baro_rate
    else if (typeof ac.vert_rate === 'number') verticalRateFpm = ac.vert_rate * 196.85

    const callsign = String(ac.flight || ac.callsign || '').trim().replace(/\s+/g, '')
    const onGround = ac.ground === true || ac.on_ground === true || ac.alt_baro === 'ground'

    const kind = classifyAircraft(ac)
    const out = {
      hex,
      callsign,
      iataFlight: '',
      icaoAirline: '',
      airline: '',
      registration: String(ac.r || ''),
      type: String(ac.t || ''),
      category: String(ac.category || ''),
      kind,
      lat,
      lon,
      altitudeFt,
      onGround,
      groundSpeedKt,
      trackDeg: typeof ac.track === 'number' ? ac.track : typeof ac.heading === 'number' ? ac.heading : null,
      verticalRateFpm,
      squawk: String(ac.squawk || ''),
      emergency: String(ac.emergency || 'none'),
      seenPos: typeof ac.seen_pos === 'number' ? ac.seen_pos : null,
      distanceM: null,
      bearing: null,
      source: source || '',
    }
    if (center) {
      out.distanceM = haversineM(center.lat, center.lon, lat, lon)
      out.bearing = bearingDeg(center.lat, center.lon, lat, lon)
    }
    return out
  }

  /* ------------------------------------------------ 合并去重 */

  function recordScore(a) {
    let s = 0
    if (a.callsign) s += 4
    if (a.type) s += 3
    if (a.registration) s += 3
    if (a.category) s += 2
    if (a.airline) s += 1
    if (a.trackDeg != null) s += 2
    if (a.groundSpeedKt != null) s += 1
    if (a.altitudeFt != null) s += 2
    if (a.squawk) s += 1
    if (a.seenPos != null) s += Math.max(0, 4 - a.seenPos)
    return s
  }

  const FILL_KEYS = [
    'callsign', 'type', 'registration', 'category', 'airline', 'squawk',
    'trackDeg', 'groundSpeedKt', 'altitudeFt', 'verticalRateFpm',
  ]

  function mergeRecord(a, b) {
    const [hi, lo] = recordScore(a) >= recordScore(b) ? [a, b] : [b, a]
    const out = { ...hi }
    for (const k of FILL_KEYS) {
      if ((out[k] == null || out[k] === '') && lo[k] != null && lo[k] !== '') out[k] = lo[k]
    }
    if (!out.iataFlight && lo.iataFlight) out.iataFlight = lo.iataFlight
    const split = (v) => String(v || '').split('+').filter(Boolean)
    out.source = [...new Set([...split(hi.source), ...split(lo.source)])].join('+')
    return out
  }

  /* ------------------------------------------------ 几何 */

  function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371008.8
    const dLat = (lat2 - lat1) * DEG
    const dLon = (lon2 - lon1) * DEG
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
  }

  function bearingDeg(lat1, lon1, lat2, lon2) {
    const φ1 = lat1 * DEG
    const φ2 = lat2 * DEG
    const Δλ = (lon2 - lon1) * DEG
    const y = Math.sin(Δλ) * Math.cos(φ2)
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
  }

  /**
   * 网格查询点。每个点按 spacingNm（由各源最大半径推导，默认 215nm）查询，
   * 相邻点间距等于查询半径 —— 既保证无缝覆盖整个圆盘，又不会像之前那样
   * 把 5km 量程也拆成 9 个 250nm 的大请求（那是首屏慢的主因）。
   */
  const SPACING_NM = 250
  const INNER_KM = 500        // 这个半径以内走三源细网格；更大范围只细查内圈，外围另铺
  const OUTER_BUDGET = 8      // 每轮外围最多发几个请求（多点轮转，几轮铺满整盘）
  const OUTER_TTL_MS = 240_000
  function queryGrid(lat, lon, radiusNm) {
    const step = SPACING_NM
    // 每个查询点覆盖半径 step，最外一圈在 n*step 处，并集覆盖 (n+1)*step
    // 所以只需 n >= r/step - 1，再取整
    const n = Math.min(9, Math.max(0, Math.ceil(radiusNm / step - 1)))
    const offs = []
    for (let i = -n; i <= n; i++) offs.push(i * step)
    const pts = []
    for (const dyNm of offs) {
      const latRow = lat + dyNm / 60.0405
      if (latRow > 84 || latRow < -84) continue
      const cos = Math.max(0.2, Math.cos(latRow * DEG))
      for (const dxNm of offs) {
        pts.push([latRow, lon + dxNm / (60.0405 * cos)])
      }
    }
    return pts
  }

  /* ------------------------------------------ 大范围：外围粗网格（渐进铺满） */

  const outerCache = new Map() // hex -> { ac, at }
  const outerCursor = { key: '', i: 0 }

  /** 整盘粗网格：间距恰好等于单点查询半径，相邻圆相切、无缝覆盖 */
  function coarseGrid(lat, lon, radiusNm) {
    const step = SPACING_NM
    const n = Math.min(9, Math.max(0, Math.ceil(radiusNm / step - 1)))
    const pts = []
    for (let iy = -n; iy <= n; iy++) {
      for (let ix = -n; ix <= n; ix++) {
        const latRow = lat + (iy * step) / 60.0405
        if (latRow > 84 || latRow < -84) continue
        const cos = Math.max(0.2, Math.cos(latRow * DEG))
        pts.push({ d: Math.hypot(iy, ix) * step, p: [latRow, lon + (ix * step) / (60.0405 * cos)] })
      }
    }
    return pts.sort((a, b) => a.d - b.d).map((x) => x.p)
  }

  /**
   * 渐进扫描：每次只发 budget 个请求，游标一路往前推 —— 第一轮只有零星目标，
   * 几轮之后整个圆盘就铺满了。大范围只用一个源，三源同时打外圈必然被限流。
   */
  async function scanOuter(lat, lon, radiusKm, budget, stats) {
    const radiusNm = radiusKm * NM_PER_KM
    const key = `${lat.toFixed(2)},${lon.toFixed(2)},${Math.round(radiusKm)}`
    if (outerCursor.key !== key) { outerCursor.key = key; outerCursor.i = 0 }
    const pts = coarseGrid(lat, lon, radiusNm)
    for (let k = 0; k < budget && pts.length; k++) {
      const p = pts[outerCursor.i % pts.length]
      outerCursor.i++
      stats.issued++
      const outerSrc = [adsbFiProvider, adsbLolProvider].find(isOn)
      if (!outerSrc) return cachedOuter()
      try {
        const ac = await fetchProviderPoint(outerSrc, p[0], p[1], SPACING_NM, { bySource: stats.bySource })
        for (const a of ac) outerCache.set(a.hex, { ac: a, at: Date.now() })
        stats.pointsOk++
      } catch (e) {
        stats.pointsFailed++
        if (stats.errors.length < 5) stats.errors.push(String(e.message || e))
      }
    }
    return cachedOuter()
  }

  /** 外环缓存（按时效过滤） */
  function cachedOuter() {
    const now = Date.now()
    const out = []
    for (const [hex, v] of outerCache) {
      if (now - v.at > OUTER_TTL_MS) { outerCache.delete(hex); continue }
      out.push(v.ac)
    }
    return out
  }

  /** 大范围时用 OpenSky 的矩形接口一次性拿一大片（1 个请求），4 分钟内复用 */
  let skyWide = { at: 0, ac: [] }
  async function openskyWide(lat, lon, radiusKm) {
    if (!isOn(openskyProvider)) return []
    if (Date.now() - skyWide.at < 240_000) return skyWide.ac
    const dLat = radiusKm / 111.32
    const dLon = radiusKm / (111.32 * Math.max(0.15, Math.cos(lat * DEG)))
    const url =
      'https://opensky-network.org/api/states/all' +
      `?lamin=${(lat - dLat).toFixed(3)}&lamax=${(lat + dLat).toFixed(3)}` +
      `&lomin=${(lon - dLon).toFixed(3)}&lomax=${(lon + dLon).toFixed(3)}`
    try {
      const text = await fetchText(url, openskyProvider.gapMs)
      const ac = []
      for (const it of openskyProvider.parse(text)) {
        const n = normalizeAircraft(it, null, 'opensky')
        if (n) ac.push(n)
      }
      skyWide = { at: Date.now(), ac }
    } catch {
      skyWide = { at: Date.now(), ac: skyWide.ac } // 失败也等一个周期，别每轮都打
    }
    return skyWide.ac
  }

  /* ------------------------------------------------ 传输层：并发 + 每主机限速 */

  const MAX_PARALLEL = 6
  const HOST_GAP_MS = 180
  const hostState = new Map()
  const hostsDown = new Map() // 主机 -> 冷却到期时间（429 熔断）
  let active = 0
  const waiting = []

  function takeSlot() {
    return new Promise((resolve) => {
      const run = () => {
        if (active < MAX_PARALLEL) {
          active++
          resolve()
        } else waiting.push(run)
      }
      run()
    })
  }
  function releaseSlot() {
    active--
    const next = waiting.shift()
    if (next) next()
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  async function hostGate(host, gapMs) {
    let st = hostState.get(host)
    if (!st) { st = { lastAt: 0, chain: Promise.resolve() }; hostState.set(host, st) }
    const prev = st.chain
    let done
    st.chain = new Promise((r) => (done = r))
    await prev
    const wait = st.lastAt + (gapMs || HOST_GAP_MS) - Date.now()
    if (wait > 0) await sleep(wait)
    st.lastAt = Date.now()
    done()
  }

  const proxyOk = { value: null }
  async function hasProxy() {
    if (proxyOk.value != null) return proxyOk.value
    try {
      const r = await fetch('/api/health', { cache: 'no-store' })
      proxyOk.value = r.ok
    } catch {
      proxyOk.value = false
    }
    return proxyOk.value
  }

  /** 统一出口：优先走本地代理（无 CORS 限制），没有代理就直连（仅对允许 CORS 的源有效） */
  /** 统一出口：优先走本地代理（无 CORS 限制），没有代理就直连（仅对允许 CORS 的源有效） */
  async function fetchText(url, gapMs) {
    const u = new URL(url)
    // 该主机刚被限流：立刻失败，避免排队中的几十个请求逐个重试（那是首屏几十秒的元凶）
    const downUntil = hostsDown.get(u.hostname) || 0
    if (downUntil > Date.now()) {
      const e = new Error(`${u.hostname} 限流冷却中`)
      e.status = 429
      throw e
    }
    const viaProxy = await hasProxy()
    const target = viaProxy ? `/api/fetch?u=${encodeURIComponent(url)}` : url
    let lastErr = null
    for (let attempt = 0; attempt < 2; attempt++) {
      await takeSlot()
      try {
        await hostGate(u.hostname, gapMs)
        const r = await fetch(target, { cache: 'no-store' })
        const text = await r.text()
        if (r.ok) return text
        const err = new Error(`${u.hostname} HTTP ${r.status}: ${text.slice(0, 60)}`)
        err.status = r.status
        if (r.status === 429) hostsDown.set(u.hostname, Date.now() + 45_000)
        lastErr = err
        throw err
      } catch (e) {
        lastErr = e
        // HTTP 错误不重试；只有网络层抖动才重试一次
        if (e && e.status) break
      } finally {
        releaseSlot()
      }
      await sleep(1000 + attempt * 800)
    }
    throw lastErr || new Error('fetch failed')
  }

  /* ------------------------------------------------ 缓存 */

  const cache = new Map() // `${provider}|lat,lon` -> { at, ac }
  /** 某个源被限流后进入冷却，冷却期内直接跳过，不再浪费请求 */
  const providerCooldown = new Map()
  const cooldownLeft = (p) => Math.max(0, (providerCooldown.get(p.name) || 0) - Date.now())

  async function fetchProviderPoint(p, lat, lon, radiusNm, stats) {
    if (!isOn(p)) return []
    const key = `${p.name}|${lat.toFixed(3)},${lon.toFixed(3)}`
    const hit = cache.get(key)
    const ttl = p.ttlMs || 20_000
    if (hit && Date.now() - hit.at < ttl) return hit.ac
    // 该源刚被限流：跳过本轮，等冷却结束
    if (cooldownLeft(p) > 0) return []
    const url = p.buildUrl({ lat, lon, radiusNm })
    const st = stat(p.name)
    st.requests++
    st.lastAt = Date.now()
    let text
    try {
      text = await fetchText(url, p.gapMs)
    } catch (err) {
      st.fail++
      st.lastErr = String((err && err.message) || err).slice(0, 80)
      if (/429|rate limit/i.test(String(err && err.message))) {
        providerCooldown.set(p.name, Date.now() + 45_000)
        return []
      }
      throw err
    }
    const raw = p.parse(text)
    st.ok++
    st.lastOkAt = Date.now()
    st.lastCount = raw.length
    const ac = []
    for (const item of raw) {
      const n = normalizeAircraft(item, null, p.name)
      if (n) ac.push(n)
    }
    cache.set(key, { at: Date.now(), ac })
    stats.bySource[p.name] = (stats.bySource[p.name] || 0) + ac.length
    return ac
  }

  /**
   * 取指定圆心、指定公里半径内的全部航班。
   * 分两阶段：先查中心点（1 个请求/源）立刻回调一次，让界面先出图；
   * 再补齐外围网格点。这样首屏从 8s 降到 1s 左右。
   */
  async function queryAircraft(lat, lon, radiusKm, onPartial) {
    const big = radiusKm > INNER_KM
    const center = { lat, lon }
    const stats = { bySource: {}, pointsOk: 0, pointsFailed: 0, issued: 0, errors: [] }
    const merged = new Map()

    const absorb = (list) => {
      for (const a of list) {
        const withDist = { ...a, ...geo(center, a) }
        if (withDist.distanceM > radiusKm * 1000) continue
        const prev = merged.get(a.hex)
        merged.set(a.hex, prev ? mergeRecord(prev, withDist) : withDist)
      }
    }

    const payload = (degraded) => ({
      aircraft: [...merged.values()].sort((a, b) => (a.distanceM ?? 1e12) - (b.distanceM ?? 1e12)),
      queryPoints: stats.issued,
      pointsOk: stats.pointsOk,
      pointsFailed: stats.pointsFailed,
      bySource: stats.bySource,
      degraded: degraded || (stats.pointsOk === 0 && merged.size === 0),
      errors: stats.errors,
      at: Date.now(),
    })

    /* 大范围：整盘粗网格 + 渐进扫描。先铺缓存 → 再拿一次 OpenSky 大矩形 → 本轮补几个点。
       每轮请求只有个位数，所以刷新很快；圆盘会一轮一轮自己长满。 */
    if (big) {
      absorb(cachedOuter())
      if (merged.size) onPartial && onPartial(payload(false))
      try { absorb(await openskyWide(lat, lon, radiusKm)) } catch (e) { /* 忽略 */ }
      onPartial && onPartial(payload(false))
      try { absorb(await scanOuter(lat, lon, radiusKm, OUTER_BUDGET, stats)) } catch (e) { /* 忽略 */ }
      return payload(false)
    }

    /* 小范围（≤500km）：三源细网格，字段最全 */
    const radiusNm = Math.max(10, radiusKm * NM_PER_KM)
    const pts = queryGrid(lat, lon, radiusNm)

    const runPoint = ([plat, plon]) => {
      const jobs = PROVIDERS.filter(isOn).map((p) => {
        stats.issued++
        return fetchProviderPoint(p, plat, plon, SPACING_NM, stats).then(
          (ac) => { stats.pointsOk++; absorb(ac) },
          (err) => {
            stats.pointsFailed++
            if (stats.errors.length < 5) stats.errors.push(String(err.message || err))
          },
        )
      })
      return Promise.all(jobs)
    }

    // 阶段一：中心点先出结果，界面立刻能画出目标
    await runPoint([lat, lon])
    onPartial && onPartial(payload(false))

    // 阶段二：剩下的网格点并发补齐
    const rest = pts.filter(([a, b]) => !(Math.abs(a - lat) < 1e-6 && Math.abs(b - lon) < 1e-6))
    await Promise.all(rest.map(runPoint))
    return payload(false)
  }

  function geo(center, a) {
    return {
      distanceM: haversineM(center.lat, center.lon, a.lat, a.lon),
      bearing: bearingDeg(center.lat, center.lon, a.lat, a.lon),
    }
  }

  /* ------------------------------------------------ 航线 / 定位 */

  async function lookupRoute(callsign) {
    const cs = String(callsign || '').trim().toUpperCase()
    if (!cs) return null
    try {
      const text = await fetchText(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cs)}`)
      const j = JSON.parse(text)
      const fr = j.response && j.response.flightroute
      if (!fr) return null
      return {
        callsign: fr.callsign,
        airline: fr.airline ? fr.airline.name : '',
        origin: fr.origin ? {
          iata: fr.origin.iata_code, icao: fr.origin.icao_code,
          name: fr.origin.name, country: fr.origin.country_iso_name,
          lat: fr.origin.latitude, lon: fr.origin.longitude,
        } : null,
        destination: fr.destination ? {
          iata: fr.destination.iata_code, icao: fr.destination.icao_code,
          name: fr.destination.name, country: fr.destination.country_iso_name,
          lat: fr.destination.latitude, lon: fr.destination.longitude,
        } : null,
      }
    } catch {
      return null
    }
  }

  /** 设备定位：浏览器/WebView 允许时优先用 GPS（同意后精度到米级，换城市立刻反映） */
  function gpsPosition(timeoutMs) {
    return new Promise((resolve) => {
      const nav = typeof navigator !== 'undefined' ? navigator : null
      if (!nav || !nav.geolocation) return resolve(null)
      let done = false
      const finish = (v) => { if (!done) { done = true; resolve(v) } }
      const timer = setTimeout(() => finish(null), timeoutMs + 500)
      try {
        nav.geolocation.getCurrentPosition(
          (pos) => {
            clearTimeout(timer)
            finish({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy })
          },
          () => { clearTimeout(timer); finish(null) },
          { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 60_000 },
        )
      } catch (e) { clearTimeout(timer); finish(null) }
    })
  }

  async function detectLocation() {
    const gps = await gpsPosition(4000)
    const providers = [
      { url: 'https://ipwho.is/', pick: (j) => (j.success !== false ? { lat: j.latitude, lon: j.longitude, city: j.city, region: j.region } : null) },
      { url: 'https://ipinfo.io/json', pick: (j) => (j.loc ? { lat: Number(j.loc.split(',')[0]), lon: Number(j.loc.split(',')[1]), city: j.city, region: j.region } : null) },
    ]
    let ip = null
    for (const pr of providers) {
      try {
        const picked = pr.pick(JSON.parse(await fetchText(pr.url)))
        if (picked && Number.isFinite(picked.lat)) { ip = picked; break }
      } catch { /* 换下一个 */ }
    }
    if (gps) {
      // GPS 给坐标，城市名借用 IP 结果；IP 也失败就留空
      return { lat: gps.lat, lon: gps.lon, city: ip ? ip.city : '', region: ip ? ip.region : '', source: 'gps' }
    }
    return ip ? { ...ip, source: 'ip' } : null
  }

  /* ------------------------------------------------ 对外 */

  loadCustom()

  window.FRData = {
    PROVIDERS,
    registerProvider,
    setProviderEnabled,
    providerStatus,
    addCustomProvider,
    removeCustomProvider,
    parseLoose,
    queryAircraft,
    lookupRoute,
    detectLocation,
    normalizeAircraft,
    classifyAircraft,
    mergeRecord,
    haversineM,
    bearingDeg,
    clearCache: () => { cache.clear(); outerCache.clear(); skyWide = { at: 0, ac: [] } },
  }
})()
