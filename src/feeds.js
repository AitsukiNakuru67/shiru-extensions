/**
 * Pure Worker-safe feed fetching, remote sources manifest loading, XML (RSS 2.0 / Torznab 1.3) &
 * JSON (AnimeTosho / SeaDex / generic) parsing, and local TTL caching.
 * Contains zero hardcoded feed domains — sources come from the configured `sourcesUrl` manifest or `feedUrls`.
 */

export const DEFAULT_SOURCES_URL = 'https://pixeldrain.com/api/filesystem/qkW71xWE/sources.json'

const HEX40 = /^[0-9a-f]{40}$/i
const BASE32_32 = /^[A-Z2-7]{32}$/i
const B32_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const BTIH_RX = /urn:btih:([0-9a-f]{40}|[a-z2-7]{32})/i
const MIKAN_HASH_RX = /(?:\/Home\/Episode\/|\/Download\/\d{8}\/)([0-9a-f]{40})(?:\.torrent)?/i
const CJK_RX = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/

export function normalizeInfoHash (raw) {
  const s = String(raw || '').trim()
  if (HEX40.test(s)) return s.toLowerCase()
  if (BASE32_32.test(s)) {
    let bits = ''
    for (const c of s.toUpperCase()) {
      const idx = B32_ALPHA.indexOf(c)
      if (idx < 0) return ''
      bits += idx.toString(2).padStart(5, '0')
    }
    let hex = ''
    for (let i = 0; i < 160; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
    return HEX40.test(hex) ? hex : ''
  }
  return ''
}

/** Validate HTTPS anywhere or HTTP on loopback only. */
export function normalizeAllowedUrl (raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  try {
    const u = new URL(s)
    if (u.protocol === 'https:') return u.toString()
    if (u.protocol === 'http:') {
      const h = u.hostname.toLowerCase()
      if (h === 'localhost' || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '[::1]' || h === '::1') {
        return u.toString()
      }
    }
  } catch {}
  return ''
}

export function normalizeBaseUrl (raw) {
  const s = normalizeAllowedUrl(raw)
  return s ? s.replace(/\/+$/, '') : ''
}

export function isValidSourceTemplate (tpl) {
  const s = String(tpl || '').trim()
  if (!s) return false
  const probe = s.replace(/\{[a-zA-Z0-9_]+\}/g, 'test')
  return !!normalizeAllowedUrl(probe)
}

export function parseFeedTemplates (raw) {
  return String(raw || '')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(isValidSourceTemplate)
}

function decodeXml (s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) || 32))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16) || 32))
    .trim()
}

function tagText (block, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i').exec(block)
  return m ? decodeXml(m[1]) : ''
}

function parseByteSize (val) {
  if (typeof val === 'number' && Number.isFinite(val) && val > 0) return Math.round(val)
  const s = String(val || '').trim()
  if (!s) return 0
  if (/^\d+$/.test(s)) return Number(s)
  const m = /^([\d.]+)\s*(Ki?B|Mi?B|Gi?B|Ti?B|B)$/i.exec(s)
  if (!m) return 0
  const n = Number(m[1])
  const u = m[2].toUpperCase()
  const mult = u.startsWith('T') ? 1024 ** 4 : u.startsWith('G') ? 1024 ** 3 : u.startsWith('M') ? 1024 ** 2 : u.startsWith('K') ? 1024 : 1
  return Number.isFinite(n) ? Math.round(n * mult) : 0
}

function intOrNull (v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

/**
 * Parse RSS 2.0 / Torznab 1.3 XML (including Nyaa, Sukebei, dmhy base32 magnets, and Mikan hashes)
 * into candidate items compatible with Shiru's `judgeModalResults`.
 */
export function parseFeedXml (xml, sourceUrl = '', sourceId = '') {
  if (!xml || typeof xml !== 'string') return []
  let host = sourceId || ''
  if (!host) {
    try { host = new URL(sourceUrl).hostname } catch {}
  }
  const items = []
  for (const match of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const block = match[1]
    const title = tagText(block, 'title')
    if (!title) continue

    const attrs = new Map()
    for (const am of block.matchAll(/<(?:torznab|newznab):attr\s+name="([^"]+)"\s+value="([^"]*)"\s*\/?>/gi)) {
      const k = am[1].toLowerCase()
      if (!attrs.has(k)) attrs.set(k, decodeXml(am[2]))
    }

    let torrentEnc = ''
    let nzbEnc = ''
    let encLen = 0
    for (const em of block.matchAll(/<enclosure\s([^>]*)\/?>/gi)) {
      const tag = em[1]
      const url = decodeXml(/\burl="([^"]*)"/i.exec(tag)?.[1] || '')
      const type = decodeXml(/\btype="([^"]*)"/i.exec(tag)?.[1] || '').toLowerCase()
      const len = Number(/\blength="(\d+)"/i.exec(tag)?.[1] || 0)
      if (len > 0 && !encLen) encLen = len
      if (type === 'application/x-nzb' && url && !nzbEnc) nzbEnc = url
      else if (url && !torrentEnc) torrentEnc = url
    }

    const linkTag = tagText(block, 'link')
    const guid = tagText(block, 'guid')
    const magnetAttr = attrs.get('magneturl') || ''
    const infoHash = normalizeInfoHash(
      attrs.get('infohash') ||
      tagText(block, 'nyaa:infoHash') ||
      BTIH_RX.exec(magnetAttr)?.[1] ||
      BTIH_RX.exec(torrentEnc)?.[1] ||
      BTIH_RX.exec(linkTag)?.[1] ||
      BTIH_RX.exec(guid)?.[1] ||
      MIKAN_HASH_RX.exec(linkTag)?.[1] ||
      MIKAN_HASH_RX.exec(torrentEnc)?.[1] ||
      MIKAN_HASH_RX.exec(guid)?.[1] ||
      ''
    )
    const link = magnetAttr || (infoHash ? `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}` : (torrentEnc || linkTag))
    const size = parseByteSize(attrs.get('size') || tagText(block, 'size') || tagText(block, 'nyaa:size') || encLen)
    const seeders = intOrNull(attrs.get('seeders') ?? tagText(block, 'nyaa:seeders'))
    const leechers = intOrNull(attrs.get('leechers') ?? attrs.get('peers') ?? tagText(block, 'nyaa:leechers'))
    const downloads = intOrNull(attrs.get('grabs') ?? tagText(block, 'nyaa:downloads'))
    const pubDate = tagText(block, 'pubDate') || tagText(block, 'torrent:pubDate') || ''
    const trustedRaw = (attrs.get('trusted') || tagText(block, 'nyaa:trusted') || '').toLowerCase()
    const remakeRaw = (attrs.get('remake') || tagText(block, 'nyaa:remake') || '').toLowerCase()

    items.push({
      title,
      link,
      infoHash,
      hash: infoHash,
      size,
      seeders,
      leechers,
      downloads,
      pubDate,
      pageUrl: /^https?:\/\//i.test(guid) ? guid : (/^https?:\/\//i.test(linkTag) ? linkTag : ''),
      trusted: trustedRaw === 'yes' || trustedRaw === 'true' || trustedRaw === '1',
      remake: remakeRaw === 'yes' || remakeRaw === 'true' || remakeRaw === '1',
      kind: !infoHash && nzbEnc ? 'nzb' : 'torrent',
      ...(nzbEnc ? { nzbUrl: nzbEnc } : {}),
      host,
      source: host ? [host] : []
    })
  }
  return items
}

/** Parse AnimeTosho JSON feed array (`feed.animetosho.net/json`) into candidate items. */
export function parseAnimeToshoJson (data, sourceUrl = '', sourceId = 'animetosho') {
  const list = Array.isArray(data) ? data : []
  let host = sourceId || 'animetosho'
  if (!host) {
    try { host = new URL(sourceUrl).hostname } catch {}
  }
  const out = []
  for (const r of list) {
    if (!r || typeof r !== 'object') continue
    const title = String(r.title || '').trim()
    if (!title) continue
    const infoHash = normalizeInfoHash(r.info_hash || r.infoHash || BTIH_RX.exec(String(r.magnet_uri || ''))?.[1] || '')
    const nzbUrl = typeof r.nzb_url === 'string' && /^https?:\/\//i.test(r.nzb_url) ? r.nzb_url : ''
    const link = String(r.magnet_uri || (infoHash ? `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}` : (r.torrent_url || '')))
    const ts = Number(r.timestamp)
    const pubDate = Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : ''
    out.push({
      title,
      link,
      infoHash,
      hash: infoHash,
      size: parseByteSize(r.total_size || r.size || 0),
      seeders: intOrNull(r.seeders),
      leechers: intOrNull(r.leechers),
      downloads: intOrNull(r.downloads),
      pubDate,
      pageUrl: String(r.website_url || r.link || ''),
      trusted: false,
      remake: false,
      kind: !infoHash && nzbUrl ? 'nzb' : 'torrent',
      ...(nzbUrl ? { nzbUrl } : {}),
      host,
      source: [host]
    })
  }
  return out
}

/**
 * Parse SeaDex PocketBase response (`items[].expand.trs[]`) into:
 * - `metaByHash`: map of infoHash -> `{ isBest, dualAudio, releaseGroup, tracker, url, files }`
 * - `items`: candidate rows for public SeaDex torrents carrying valid hashes
 */
export function parseSeaDexJson (data, query = null) {
  const metaByHash = new Map()
  const items = []
  const entries = Array.isArray(data?.items) ? data.items : []
  const fallbackShow = query?.media?.title?.romaji || query?.media?.title?.english || query?.titles?.[0] || ''

  for (const entry of entries) {
    const trs = Array.isArray(entry?.expand?.trs) ? entry.expand.trs : []
    for (const tr of trs) {
      if (!tr || typeof tr !== 'object') continue
      const infoHash = normalizeInfoHash(tr.infoHash || tr.hash || '')
      if (!infoHash) continue
      const files = Array.isArray(tr.files)
        ? tr.files.map((f) => ({ name: String(f?.name || ''), length: Number(f?.length) || 0 })).filter((f) => f.name)
        : []
      const isBest = tr.isBest === true
      const dualAudio = tr.dualAudio === true
      const releaseGroup = String(tr.releaseGroup || '').trim()
      const tracker = String(tr.tracker || '').trim()
      const url = String(tr.url || '').trim()

      const prev = metaByHash.get(infoHash)
      if (!prev || isBest) {
        metaByHash.set(infoHash, { isBest: isBest || !!prev?.isBest, dualAudio: dualAudio || !!prev?.dualAudio, releaseGroup, tracker, url, files })
      }

      // Only materialize direct candidates for public-tracker hashes (not redacted private trackers).
      const isPublic = !tracker || /^(?:nyaa|animetosho|sukebei|public|anidex|tosho)/i.test(tracker)
      if (!isPublic) continue

      const totalSize = files.reduce((sum, f) => sum + (f.length > 0 ? f.length : 0), 0)
      const videoFile = files.find((f) => /\.(?:mkv|mp4|avi|webm)$/i.test(f.name))
      const topDir = videoFile?.name?.includes('/') ? videoFile.name.split('/')[0] : (videoFile?.name || '')
      const title = topDir || (releaseGroup && fallbackShow ? `[${releaseGroup}] ${fallbackShow}` : fallbackShow)
      if (!title) continue

      items.push({
        title,
        link: `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}`,
        infoHash,
        hash: infoHash,
        size: totalSize,
        seeders: null,
        leechers: null,
        downloads: null,
        pubDate: String(tr.created || entry.created || ''),
        pageUrl: url,
        trusted: true,
        remake: false,
        seadex: true,
        seadexBest: isBest,
        dualAudio,
        files,
        kind: 'torrent',
        host: 'seadex',
        source: ['seadex']
      })
    }
  }
  return { metaByHash, items }
}

/**
 * Parse a generic JSON release feed (`{ releases: [...] }`, `{ items: [...] }`, or `[...]`) into candidate items.
 */
export function parseFeedJson (data, sourceUrl = '', sourceId = '') {
  let host = sourceId || ''
  if (!host) {
    try { host = new URL(sourceUrl).hostname } catch {}
  }
  const list = Array.isArray(data)
    ? data
    : (Array.isArray(data?.releases) ? data.releases : (Array.isArray(data?.items) ? data.items : []))
  const out = []
  for (const r of list) {
    if (!r || typeof r !== 'object') continue
    const title = String(r.title || r.name || '').trim()
    if (!title) continue
    const infoHash = normalizeInfoHash(r.infoHash || r.info_hash || r.btih || r.hash || BTIH_RX.exec(String(r.link || r.magnet || r.magnet_uri || ''))?.[1] || '')
    const link = String(r.link || r.magnet || r.magnet_uri || (infoHash ? `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}` : ''))
    out.push({
      title,
      link,
      infoHash,
      hash: infoHash,
      size: parseByteSize(r.size || r.total_size || 0),
      seeders: intOrNull(r.seeders),
      leechers: intOrNull(r.leechers),
      downloads: intOrNull(r.downloads),
      pubDate: String(r.pubDate || r.uploaded || r.date || ''),
      pageUrl: String(r.pageUrl || r.website_url || r.website || ''),
      trusted: r.trusted === true || r.nyaaTrusted === true,
      remake: r.remake === true,
      seadex: r.seadex === true,
      seadexBest: r.seadexBest === true,
      kind: r.kind === 'nzb' ? 'nzb' : 'torrent',
      ...(r.nzbUrl || r.nzb_url ? { nzbUrl: String(r.nzbUrl || r.nzb_url) } : {}),
      host: String(r.host || host),
      source: Array.isArray(r.source) ? r.source : (host ? [host] : [])
    })
  }
  return out
}

/** Expand a feed URL template for a specific show/episode query. Returns `''` if a required ID placeholder is empty. */
export function expandFeedUrl (template, vars) {
  const { queryText = '', nativeQuery = '', anilistId = 0, malId = 0, anidbId = 0, anidbEid = 0, episode = 1 } = vars || {}
  if (/\{anilistId\}/i.test(template) && !anilistId) return ''
  if (/\{malId\}/i.test(template) && !malId) return ''
  if (/\{anidbId\}/i.test(template) && !anidbId) return ''
  if (/\{anidbEid\}/i.test(template) && !anidbEid) return ''
  if (/\{nativeQuery\}/i.test(template) && !nativeQuery) return ''
  if (/\{query\}/i.test(template) && !queryText) return ''

  const hasPlaceholder = /\{[a-zA-Z0-9_]+\}/.test(template)
  if (hasPlaceholder) {
    return template
      .replace(/\{query\}/gi, encodeURIComponent(queryText))
      .replace(/\{nativeQuery\}/gi, encodeURIComponent(nativeQuery))
      .replace(/\{anilistId\}/gi, encodeURIComponent(String(anilistId || '')))
      .replace(/\{malId\}/gi, encodeURIComponent(String(malId || '')))
      .replace(/\{anidbId\}/gi, encodeURIComponent(String(anidbId || '')))
      .replace(/\{anidbEid\}/gi, encodeURIComponent(String(anidbEid || '')))
      .replace(/\{episode\}/gi, encodeURIComponent(String(episode || '')))
  }
  const u = new URL(template)
  if (!u.searchParams.has('q') && queryText) u.searchParams.set('q', queryText)
  return u.toString()
}

/** Build 1–2 concise Latin/Romanized search strings from AniList titles for live feed queries. */
export function buildQueryStrings (query) {
  const titles = []
  const push = (t) => {
    const s = String(t || '').trim()
    if (s && !titles.some((x) => x.toLowerCase() === s.toLowerCase())) titles.push(s)
  }
  push(query?.media?.title?.romaji)
  push(query?.media?.title?.english)
  for (const t of query?.titles || []) push(t)
  return titles.slice(0, 2)
}

/** Build 1–2 concise CJK/native search keywords for dmhy / Mikan style sources. */
export function buildNativeQueryStrings (query) {
  const out = []
  const push = (t) => {
    const s = String(t || '').replace(/\s+/g, ' ').trim()
    if (s.length >= 2 && CJK_RX.test(s) && !out.includes(s)) out.push(s)
  }
  const native = query?.media?.title?.native
  push(native)
  if (native) push(String(native).split(/\s+/)[0])
  for (const s of query?.media?.synonyms || []) push(s)
  return out.slice(0, 2)
}

function isHentaiMedia (query) {
  const genres = (query?.media?.genres || []).map((g) => String(g || '').toLowerCase())
  return genres.includes('hentai')
}

const memCache = new Map()

/** Simple in-memory TTL cache. */
export async function cachedFetch (key, ttlMs, loader, { fresh = false } = {}) {
  const now = Date.now()
  if (!fresh) {
    const hit = memCache.get(key)
    if (hit && now - hit.at < ttlMs) return hit.value
  }
  const value = await loader()
  if (value != null) {
    memCache.set(key, { value, at: now })
    if (memCache.size > 200) memCache.delete(memCache.keys().next().value)
  }
  return value
}

/** Fetch and normalize a remote sources manifest JSON (`{ indexUrl, trackers, sources }`). */
export async function fetchSourcesManifest (sourcesUrl, { fresh = false } = {}) {
  const url = normalizeAllowedUrl(sourcesUrl)
  if (!url) return null
  return cachedFetch(`manifest:${url}`, 15 * 60_000, async () => {
    try {
      const res = await fetch(url, { ...(fresh ? { cache: 'no-store' } : {}), signal: AbortSignal.timeout(8000) })
      if (!res.ok) return null
      const body = await res.json()
      if (!body || typeof body !== 'object') return null
      const sources = (Array.isArray(body.sources) ? body.sources : [])
        .filter((s) => s && typeof s === 'object' && s.enabled !== false && isValidSourceTemplate(s.url))
        .map((s) => ({
          id: String(s.id || '').trim().slice(0, 64),
          name: String(s.name || s.id || '').trim().slice(0, 120),
          format: String(s.format || 'auto').toLowerCase(),
          scope: String(s.scope || 'any').toLowerCase(),
          url: String(s.url).trim()
        }))
      const trackers = (Array.isArray(body.trackers) ? body.trackers : [])
        .map((t) => String(t || '').trim())
        .filter((t) => /^(?:udp|https?|wss?):\/\/[^\s]{3,240}$/i.test(t))
      const indexUrl = normalizeBaseUrl(body.indexUrl || '')
      return { indexUrl, trackers, sources, updatedAt: body.updatedAt || null }
    } catch {
      return null
    }
  }, { fresh })
}

/** Optional cached AniZip mapping lookup (ani.zip public API). */
export async function fetchAnizipMappings (anilistId, { enabled = true, fresh = false } = {}) {
  if (!enabled || !Number.isSafeInteger(anilistId) || anilistId <= 0) return null
  return cachedFetch(`anizip:${anilistId}`, 6 * 3600_000, async () => {
    try {
      const res = await fetch(`https://api.ani.zip/mappings?anilist_id=${anilistId}`)
      if (!res.ok) return null
      return await res.json()
    } catch {
      return null
    }
  }, { fresh })
}

function mergeCandidate (existing, incoming) {
  if (incoming.seadex) existing.seadex = true
  if (incoming.seadexBest) existing.seadexBest = true
  if (incoming.trusted) existing.trusted = true
  if (incoming.dualAudio) existing.dualAudio = true
  if (incoming.seeders != null && (existing.seeders == null || incoming.seeders > existing.seeders)) existing.seeders = incoming.seeders
  if (incoming.leechers != null && (existing.leechers == null || incoming.leechers > existing.leechers)) existing.leechers = incoming.leechers
  if (incoming.downloads != null && (existing.downloads == null || incoming.downloads > existing.downloads)) existing.downloads = incoming.downloads
  if (incoming.size > 0 && (!existing.size || existing.size <= 0)) existing.size = incoming.size
  if (incoming.nzbUrl && !existing.nzbUrl) existing.nzbUrl = incoming.nzbUrl
  if (incoming.pageUrl && !existing.pageUrl) existing.pageUrl = incoming.pageUrl
  if (incoming.files?.length && !existing.files?.length) existing.files = incoming.files
  for (const s of incoming.source || []) {
    if (s && !existing.source.includes(s)) existing.source.push(s)
  }
}

/**
 * Fetch and merge candidates in parallel from structured source definitions and/or plain URL templates.
 */
export async function fetchFeedCandidates (sourcesOrTemplates, query, { fresh = false, useAnizip = true } = {}) {
  const normalized = (sourcesOrTemplates || [])
    .map((entry) => (typeof entry === 'string' ? { id: '', format: 'auto', scope: 'any', url: entry } : entry))
    .filter((s) => s && isValidSourceTemplate(s.url))

  const hentai = isHentaiMedia(query)
  const active = normalized.filter((s) => {
    if (s.scope === 'hentai') return hentai
    if (s.scope === 'sfw') return !hentai
    return true
  })

  const anilistId = Number(query?.anilistId) || 0
  const episode = Number(query?.episode) || 1
  let malId = Number(query?.media?.idMal || query?.mappingsA?.mal_id || 0)
  let anidbId = Number(query?.anidbAid || query?.mappingsA?.anidb_id || 0)
  let anidbEid = Number(query?.anidbEid || query?.mappingsE?.anidbEid || 0)

  const needsMapping = active.some((s) => /\{(?:anidbId|anidbEid|malId)\}/i.test(s.url))
  if (needsMapping && useAnizip && anilistId > 0 && (!anidbId || !anidbEid)) {
    const mapped = await fetchAnizipMappings(anilistId, { enabled: true, fresh })
    if (mapped) {
      if (!anidbId && Number(mapped?.mappings?.anidb_id) > 0) anidbId = Number(mapped.mappings.anidb_id)
      if (!malId && Number(mapped?.mappings?.mal_id) > 0) malId = Number(mapped.mappings.mal_id)
      const epEntry = mapped?.episodes?.[String(episode)] || mapped?.episodes?.[episode]
      if (!anidbEid && Number(epEntry?.anidbEid) > 0) anidbEid = Number(epEntry.anidbEid)
    }
  }

  const queryStrings = buildQueryStrings(query)
  const nativeStrings = buildNativeQueryStrings(query)
  const jobs = new Map()

  const addJob = (src, url) => {
    if (!url || !normalizeAllowedUrl(url)) return
    const key = `${src.format}:${url}`
    if (!jobs.has(key)) jobs.set(key, { src, url })
  }

  for (const src of active) {
    if (/\{nativeQuery\}/i.test(src.url)) {
      for (const nq of nativeStrings) {
        addJob(src, expandFeedUrl(src.url, { queryText: queryStrings[0] || '', nativeQuery: nq, anilistId, malId, anidbId, anidbEid, episode }))
      }
    } else if (/\{query\}/i.test(src.url) || !/\{[a-zA-Z0-9_]+\}/.test(src.url)) {
      for (const qText of (queryStrings.length ? queryStrings : [''])) {
        addJob(src, expandFeedUrl(src.url, { queryText: qText, nativeQuery: nativeStrings[0] || '', anilistId, malId, anidbId, anidbEid, episode }))
      }
    } else {
      addJob(src, expandFeedUrl(src.url, { queryText: queryStrings[0] || '', nativeQuery: nativeStrings[0] || '', anilistId, malId, anidbId, anidbEid, episode }))
    }
  }

  const byKey = new Map()
  const seadexMeta = new Map()

  await Promise.all([...jobs.values()].map(async ({ src, url }) => {
    const fetched = await cachedFetch(`feed:${src.format}:${url}`, 3 * 60_000, async () => {
      try {
        const res = await fetch(url, { ...(fresh ? { cache: 'no-store' } : {}), signal: AbortSignal.timeout(6000) })
        if (!res.ok) return { items: [], meta: null }
        const ct = String(res.headers.get('content-type') || '').toLowerCase()
        const text = await res.text()
        const looksJson = src.format === 'seadex' || src.format === 'animetosho-json' || src.format === 'json' || ct.includes('json') || text.trimStart().startsWith('{') || text.trimStart().startsWith('[')
        if (looksJson) {
          let parsed
          try { parsed = JSON.parse(text) } catch { return { items: [], meta: null } }
          if (src.format === 'seadex') {
            const sd = parseSeaDexJson(parsed, query)
            return { items: sd.items, meta: [...sd.metaByHash.entries()] }
          }
          if (src.format === 'animetosho-json') {
            return { items: parseAnimeToshoJson(parsed, url, src.id || 'animetosho'), meta: null }
          }
          return { items: parseFeedJson(parsed, url, src.id), meta: null }
        }
        return { items: parseFeedXml(text, url, src.id), meta: null }
      } catch {
        return { items: [], meta: null }
      }
    }, { fresh })

    if (Array.isArray(fetched?.meta)) {
      for (const [h, m] of fetched.meta) {
        const prev = seadexMeta.get(h)
        if (!prev || m.isBest) seadexMeta.set(h, m)
      }
    }
    for (const item of fetched?.items || []) {
      const k = item.infoHash ? `${item.kind}:${item.infoHash}` : `${item.kind}:${item.title.toLowerCase()}`
      const existing = byKey.get(k)
      if (existing) {
        mergeCandidate(existing, item)
      } else {
        byKey.set(k, { ...item, source: [...(item.source || [])] })
      }
    }
  }))

  // Apply SeaDex curation flags onto every candidate whose infoHash appears in SeaDex.
  for (const item of byKey.values()) {
    if (item.infoHash && seadexMeta.has(item.infoHash)) {
      const m = seadexMeta.get(item.infoHash)
      item.seadex = true
      if (m.isBest) item.seadexBest = true
      if (m.dualAudio) item.dualAudio = true
      if (m.files?.length && !item.files?.length) item.files = m.files
      if (!item.source.includes('seadex')) item.source.push('seadex')
    }
  }

  return [...byKey.values()]
}
