/**
 * Dynamic manifest-backed transport for Shiru's real `cascadeSearch.js`.
 * Zero hardcoded feed domains: every endpoint origin/template comes from the active
 * `sources.json` manifest (or user settings) bound per search run.
 */
import {
  normalizeAllowedUrl,
  isValidSourceTemplate,
  expandFeedUrl,
  stripApiKey,
  parseFeedXml,
  parseNyaaHtml,
  parseAnimeToshoJson,
  dominantAid,
  cachedFetch
} from './feeds.js'

const defaultCtx = {
  fresh: false,
  enableUsenet: true,
  amenzbKey: '',
  onItems: null,
  hosts: {
    seadexTemplate: '',
    animetoshoOrigin: '',
    animetoshoEidTemplate: '',
    animetoshoAidTemplate: '',
    animetoshoQueryTemplate: '',
    nyaaOrigin: '',
    sukebeiOrigin: '',
    dmhyTemplate: '',
    mikanTemplate: '',
    amenzbOrigin: '',
    amenzbAnidbTemplate: '',
    amenzbQueryTemplate: ''
  }
}

let activeCtx = structuredClone(defaultCtx)
const itemsListeners = new Set()

export function addCascadeItemsListener (fn) {
  if (typeof fn === 'function') itemsListeners.add(fn)
}

export function removeCascadeItemsListener (fn) {
  if (typeof fn === 'function') itemsListeners.delete(fn)
}

function notifyTransportItems (host, items) {
  if (!Array.isArray(items) || !items.length) return
  if (typeof activeCtx.onItems === 'function') {
    try { activeCtx.onItems(host, items) } catch {}
  }
  for (const fn of itemsListeners) {
    try { fn(host, items) } catch {}
  }
}

function originOf (url) {
  try {
    const probe = String(url || '').replace(/\{[a-zA-Z0-9_]+\}/g, 'test')
    const u = new URL(probe)
    return u.origin
  } catch {
    return ''
  }
}

/**
 * Partition `sources` from `sources.json` + `feedUrls` into:
 * - `hosts`: native endpoints driven directly by Shiru's `cascadeSearch.js`
 * - `extraSources`: keyless Usenet crawlers (`binsearch`, `nzbking`, `nzbindex`) & custom user `feedUrls`
 */
export function resolveManifestHosts (sourcesOrTemplates = []) {
  const hosts = {
    seadexTemplate: '',
    animetoshoOrigin: '',
    animetoshoEidTemplate: '',
    animetoshoAidTemplate: '',
    animetoshoQueryTemplate: '',
    nyaaOrigin: '',
    sukebeiOrigin: '',
    dmhyTemplate: '',
    mikanTemplate: '',
    amenzbOrigin: '',
    amenzbAnidbTemplate: '',
    amenzbQueryTemplate: ''
  }
  const extraSources = []

  for (const entry of sourcesOrTemplates || []) {
    if (typeof entry === 'string') {
      if (isValidSourceTemplate(entry)) extraSources.push({ id: '', format: 'auto', scope: 'any', url: entry })
      continue
    }
    if (!entry || entry.enabled === false || !isValidSourceTemplate(entry.url)) continue
    const id = String(entry.id || '').toLowerCase()
    const format = String(entry.format || 'auto').toLowerCase()
    const scope = String(entry.scope || 'any').toLowerCase()
    const url = String(entry.url).trim()

    if (format === 'seadex' || id === 'seadex') {
      if (!hosts.seadexTemplate) hosts.seadexTemplate = url
      continue
    }
    if (format === 'animetosho-json' || id === 'animetosho' || id.startsWith('animetosho-')) {
      if (!hosts.animetoshoOrigin) hosts.animetoshoOrigin = originOf(url)
      if (/\{anidbEid\}/i.test(url) && !hosts.animetoshoEidTemplate) hosts.animetoshoEidTemplate = url
      else if (/\{anidbId\}/i.test(url) && !hosts.animetoshoAidTemplate) hosts.animetoshoAidTemplate = url
      else if (/\{query\}/i.test(url) && !hosts.animetoshoQueryTemplate) hosts.animetoshoQueryTemplate = url
      continue
    }
    if (id === 'nyaa' || id === 'nyaa-en' || id.startsWith('nyaa-')) {
      if (!hosts.nyaaOrigin) hosts.nyaaOrigin = originOf(url)
      continue
    }
    if (id === 'sukebei' || id.startsWith('sukebei-') || (scope === 'hentai' && format === 'rss')) {
      if (!hosts.sukebeiOrigin) hosts.sukebeiOrigin = originOf(url)
      continue
    }
    if (id === 'dmhy') {
      if (!hosts.dmhyTemplate) hosts.dmhyTemplate = url
      continue
    }
    if (id === 'mikan') {
      if (!hosts.mikanTemplate) hosts.mikanTemplate = url
      continue
    }
    if (id === 'amenzb' || id.startsWith('amenzb-') || format === 'newznab') {
      if (!hosts.amenzbOrigin) hosts.amenzbOrigin = originOf(url)
      if (/\{anidbId\}/i.test(url) && !hosts.amenzbAnidbTemplate) hosts.amenzbAnidbTemplate = url
      else if (/\{query\}/i.test(url) && !hosts.amenzbQueryTemplate) hosts.amenzbQueryTemplate = url
      continue
    }
    extraSources.push(entry)
  }

  return { hosts, extraSources }
}

export function setCascadeTransportContext (ctx) {
  activeCtx = {
    fresh: ctx?.fresh === true,
    enableUsenet: ctx?.enableUsenet !== false,
    amenzbKey: String(ctx?.amenzbKey || '').trim(),
    onItems: typeof ctx?.onItems === 'function' ? ctx.onItems : null,
    hosts: { ...defaultCtx.hosts, ...(ctx?.hosts || {}) }
  }
}

export function getCascadeTransportContext () {
  return activeCtx
}

function timeoutMsFor (deadlineAt, fallbackMs = 8000) {
  if (!Number.isFinite(deadlineAt)) return fallbackMs
  const left = Math.floor(deadlineAt - Date.now())
  if (left <= 50) return 0
  return Math.min(fallbackMs, left)
}

async function fetchText (url, { deadlineAt, fallbackMs = 8000, cacheKey = '', ttlMs = 3 * 60_000, fresh = false } = {}) {
  const ms = timeoutMsFor(deadlineAt, fallbackMs)
  if (ms <= 0) return { ok: false, error: 'host_deadline_aborted', text: '' }
  const cleanUrl = normalizeAllowedUrl(url)
  if (!cleanUrl) return { ok: false, error: 'invalid_url', text: '' }
  const load = async () => {
    try {
      const res = await fetch(cleanUrl, { ...(fresh ? { cache: 'no-store' } : {}), signal: AbortSignal.timeout(ms) })
      if (!res.ok) return { ok: false, status: res.status, error: `http_${res.status}`, text: '' }
      return { ok: true, status: res.status, text: await res.text() }
    } catch (e) {
      return { ok: false, error: String(e?.message || e || 'fetch_failed'), text: '' }
    }
  }
  if (!cacheKey) return load()
  return cachedFetch(cacheKey, ttlMs, load, { fresh })
}

/**
 * Worker-safe `SEASONAL` object consumed by Shiru's real `cascadeSearch.js` and `dmhyHost.js`.
 */
export const CASCADE_SEASONAL = {
  async searchNyaa (q, opts = {}) {
    const query = String(q || '').trim()
    if (!query) return { ok: true, items: [] }
    const isSukebei = String(opts?.domain || '').includes('sukebei')
    const origin = isSukebei ? activeCtx.hosts.sukebeiOrigin : activeCtx.hosts.nyaaOrigin
    if (!origin) return { ok: true, items: [] }
    const cat = String(opts?.category || (isSukebei ? '1_1' : '1_2'))
    const url = `${origin}/?page=rss&c=${encodeURIComponent(cat)}&f=0&q=${encodeURIComponent(query)}`
    const res = await fetchText(url, {
      deadlineAt: opts?.deadlineAt,
      fallbackMs: 7000,
      cacheKey: `cascade:nyaa-rss:${url}`,
      fresh: activeCtx.fresh
    })
    if (!res.ok) return { ok: false, error: res.error, items: [] }
    const host = isSukebei ? 'sukebei' : 'nyaa'
    const items = parseFeedXml(res.text, url, host)
    notifyTransportItems(host, items)
    return { ok: true, items }
  },

  async searchNyaaTop (q, opts = {}) {
    const query = String(q || '').trim()
    if (!query) return { ok: true, items: [] }
    const isSukebei = String(opts?.domain || '').includes('sukebei')
    const origin = isSukebei ? activeCtx.hosts.sukebeiOrigin : activeCtx.hosts.nyaaOrigin
    if (!origin) return { ok: true, items: [] }
    const cat = String(opts?.category || (isSukebei ? '1_1' : '1_2'))
    const page = Math.max(1, Math.floor(Number(opts?.page) || 1))
    const params = [
      'f=0',
      `c=${encodeURIComponent(cat)}`,
      `q=${encodeURIComponent(query)}`,
      ...(opts?.newest ? [] : ['s=seeders', 'o=desc']),
      ...(page > 1 ? [`p=${page}`] : [])
    ]
    const url = `${origin}/?${params.join('&')}`
    const res = await fetchText(url, {
      deadlineAt: opts?.deadlineAt,
      fallbackMs: 9000,
      cacheKey: `cascade:nyaa-html:${url}`,
      fresh: activeCtx.fresh
    })
    if (!res.ok) return { ok: false, error: res.error, items: [] }
    const host = isSukebei ? 'sukebei' : 'nyaa'
    const items = parseNyaaHtml(res.text, { host, origin })
    notifyTransportItems(host, items)
    return { ok: true, items }
  },

  async searchAnimetosho (opts = {}) {
    const origin = activeCtx.hosts.animetoshoOrigin
    if (!origin) return { ok: true, items: [] }
    const { fresh, enableUsenet, hosts } = activeCtx

    if (opts?.torznab) {
      const malId = Number(opts.malId)
      if (!Number.isSafeInteger(malId) || malId <= 0) return { ok: true, items: [] }
      const url = opts.movie
        ? `${origin}/api?t=movie&malid=${malId}`
        : `${origin}/api?t=tvsearch&malid=${malId}${Number.isFinite(Number(opts.episode)) && Number(opts.episode) > 0 ? `&ep=${Number(opts.episode)}` : ''}`
      const res = await fetchText(url, {
        deadlineAt: opts.deadlineAt,
        fallbackMs: 5000,
        cacheKey: `cascade:at-torznab:${url}`,
        fresh
      })
      if (!res.ok) return { ok: false, error: res.error, items: [] }
      const items = parseFeedXml(res.text, url, 'animetosho').map((it) => ({ ...it, animetoshoListed: true }))
      notifyTransportItems('animetosho', items)
      return { ok: true, items }
    }

    let url = ''
    if (Number(opts?.eid) > 0) {
      url = hosts.animetoshoEidTemplate
        ? expandFeedUrl(hosts.animetoshoEidTemplate, { anidbEid: Number(opts.eid) })
        : `${origin}/json?eid=${Number(opts.eid)}`
    } else if (Number(opts?.aid) > 0) {
      const limit = Number(opts.limit) > 0 ? `&limit=${Number(opts.limit)}` : ''
      url = hosts.animetoshoAidTemplate
        ? expandFeedUrl(hosts.animetoshoAidTemplate, { anidbId: Number(opts.aid) })
        : `${origin}/json?aid=${Number(opts.aid)}${limit}`
    } else if (opts?.title) {
      const epStr = Number.isFinite(Number(opts.episode)) && Number(opts.episode) > 0
        ? ` ${String(Number(opts.episode)).padStart(2, '0')}`
        : ''
      const q = `${String(opts.title).trim()}${epStr}`.trim()
      url = hosts.animetoshoQueryTemplate
        ? expandFeedUrl(hosts.animetoshoQueryTemplate, { queryText: q })
        : `${origin}/json?q=${encodeURIComponent(q)}`
    }
    if (!url) return { ok: true, items: [] }

    const res = await fetchText(url, {
      deadlineAt: opts?.deadlineAt,
      fallbackMs: 6500,
      cacheKey: `cascade:at-json:${url}`,
      fresh
    })
    if (!res.ok) return { ok: false, error: res.error, items: [] }
    let parsed
    try { parsed = JSON.parse(res.text) } catch { return { ok: false, error: 'invalid_json', items: [] } }
    const items = parseAnimeToshoJson(parsed, url, 'animetosho', {
      enableUsenet,
      nyaaOrigin: hosts.nyaaOrigin,
      sukebeiOrigin: hosts.sukebeiOrigin
    })
    notifyTransportItems('animetosho', items)
    const learnedAid = opts?.title ? dominantAid(items) : null
    return { ok: true, items, ...(learnedAid ? { anidbAid: learnedAid } : {}) }
  },

  async searchDmhy (q, opts = {}) {
    const tpl = activeCtx.hosts.dmhyTemplate
    if (!tpl || !q) return { ok: true, items: [] }
    const url = expandFeedUrl(tpl, { nativeQuery: String(q).trim() })
    if (!url) return { ok: true, items: [] }
    const res = await fetchText(url, {
      deadlineAt: opts?.deadlineAt,
      fallbackMs: 6500,
      cacheKey: `cascade:dmhy:${url}`,
      fresh: activeCtx.fresh
    })
    if (!res.ok) return { ok: false, error: res.error, items: [] }
    return { ok: true, items: parseFeedXml(res.text, url, 'dmhy') }
  },

  async searchMikan (q, opts = {}) {
    const tpl = activeCtx.hosts.mikanTemplate
    if (!tpl || !q) return { ok: true, items: [] }
    const url = expandFeedUrl(tpl, { nativeQuery: String(q).trim() })
    if (!url) return { ok: true, items: [] }
    const res = await fetchText(url, {
      deadlineAt: opts?.deadlineAt,
      fallbackMs: 6500,
      cacheKey: `cascade:mikan:${url}`,
      fresh: activeCtx.fresh
    })
    if (!res.ok) return { ok: false, error: res.error, items: [] }
    return { ok: true, items: parseFeedXml(res.text, url, 'mikan') }
  },

  async searchNewznab (opts = {}) {
    const origin = activeCtx.hosts.amenzbOrigin
    const apikey = String(opts?.apikey || activeCtx.amenzbKey || '').trim()
    if (!origin || !apikey) return { ok: true, items: [] }

    const params = new URLSearchParams({
      t: opts?.t === 'tvsearch' || opts?.t === 'movie' ? opts.t : 'search',
      o: 'xml',
      apikey
    })
    if (opts?.infoHash) {
      params.set('info_hash', String(opts.infoHash))
    } else if (Number(opts?.animeId) > 0) {
      params.set('anime_id', String(Number(opts.animeId)))
      if (opts?.q) params.set('q', String(opts.q).trim())
    } else if (opts?.q) {
      params.set('q', String(opts.q).trim())
    } else {
      return { ok: true, items: [] }
    }
    if (opts?.cat) params.set('cat', String(opts.cat))
    if (Number(opts?.limit) > 0) params.set('limit', String(Math.floor(Number(opts.limit))))
    const url = `${origin}/api?${params}`

    const safeUrl = stripApiKey(url)
    const res = await fetchText(url, {
      deadlineAt: opts?.deadlineAt,
      fallbackMs: 7000,
      cacheKey: `cascade:newznab:${safeUrl}`,
      fresh: activeCtx.fresh
    })
    if (!res.ok) return { ok: false, error: res.error, items: [] }
    const errMatch = /<error\s+code="(\d+)"[^>]*description="([^"]*)"/i.exec(res.text)
    if (errMatch) return { ok: false, code: Number(errMatch[1]), error: errMatch[2] || `error ${errMatch[1]}`, items: [] }
    return { ok: true, items: parseFeedXml(res.text, safeUrl, opts?.indexer || 'amenzb', { isNewznab: true }) }
  }
}
