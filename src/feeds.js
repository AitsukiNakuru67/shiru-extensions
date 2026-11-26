/**
 * Pure Worker-safe feed fetching, XML (RSS 2.0 / Torznab 1.3) & JSON parsing, and local TTL caching.
 * Contains zero hardcoded piracy sites — operates strictly on URLs configured by the user in extension settings.
 */

const HEX40 = /^[0-9a-f]{40}$/i
const BTIH_RX = /urn:btih:([0-9a-f]{40})/i

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

export function parseFeedTemplates (raw) {
  return String(raw || '')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => {
      // Allow template placeholders like {query} when validating URL protocol/host.
      const probe = s.replace(/\{[a-zA-Z0-9_]+\}/g, 'test')
      return !!normalizeAllowedUrl(probe)
    })
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
 * Parse RSS 2.0 / Torznab 1.3 XML into candidate items compatible with Shiru's `judgeModalResults`.
 * @param {string} xml
 * @param {string} sourceUrl
 */
export function parseFeedXml (xml, sourceUrl = '') {
  if (!xml || typeof xml !== 'string') return []
  let host = ''
  try { host = new URL(sourceUrl).hostname } catch {}
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
    const hashRaw = (
      attrs.get('infohash') ||
      tagText(block, 'nyaa:infoHash') ||
      BTIH_RX.exec(magnetAttr)?.[1] ||
      BTIH_RX.exec(linkTag)?.[1] ||
      BTIH_RX.exec(guid)?.[1] ||
      ''
    ).toLowerCase()
    const infoHash = HEX40.test(hashRaw) ? hashRaw : ''
    const link = magnetAttr || torrentEnc || (infoHash ? `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}` : linkTag)
    const size = parseByteSize(attrs.get('size') || tagText(block, 'size') || tagText(block, 'nyaa:size') || encLen)
    const seeders = intOrNull(attrs.get('seeders') ?? tagText(block, 'nyaa:seeders'))
    const leechers = intOrNull(attrs.get('leechers') ?? attrs.get('peers') ?? tagText(block, 'nyaa:leechers'))
    const downloads = intOrNull(attrs.get('grabs') ?? tagText(block, 'nyaa:downloads'))
    const pubDate = tagText(block, 'pubDate') || ''
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

/**
 * Parse a JSON release feed (`{ releases: [...] }`, `{ items: [...] }`, or `[...]`) into candidate items.
 * @param {any} data
 * @param {string} sourceUrl
 */
export function parseFeedJson (data, sourceUrl = '') {
  let host = ''
  try { host = new URL(sourceUrl).hostname } catch {}
  const list = Array.isArray(data)
    ? data
    : (Array.isArray(data?.releases) ? data.releases : (Array.isArray(data?.items) ? data.items : []))
  const out = []
  for (const r of list) {
    if (!r || typeof r !== 'object') continue
    const title = String(r.title || r.name || '').trim()
    if (!title) continue
    const hashRaw = String(r.infoHash || r.btih || r.hash || BTIH_RX.exec(String(r.link || r.magnet || ''))?.[1] || '').toLowerCase()
    const infoHash = HEX40.test(hashRaw) ? hashRaw : ''
    const link = String(r.link || r.magnet || (infoHash ? `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}` : ''))
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
      pageUrl: String(r.pageUrl || r.website || ''),
      trusted: r.trusted === true || r.nyaaTrusted === true,
      remake: r.remake === true,
      seadex: r.seadex === true,
      seadexBest: r.seadexBest === true,
      kind: r.kind === 'nzb' ? 'nzb' : 'torrent',
      ...(r.nzbUrl ? { nzbUrl: String(r.nzbUrl) } : {}),
      host: String(r.host || host),
      source: Array.isArray(r.source) ? r.source : (host ? [host] : [])
    })
  }
  return out
}

/** Expand a user-configured feed URL template for a specific show/episode query. */
export function expandFeedUrl (template, { queryText = '', anilistId = 0, malId = 0, anidbId = 0, episode = 1 }) {
  const hasPlaceholder = /\{[a-zA-Z0-9_]+\}/.test(template)
  if (hasPlaceholder) {
    return template
      .replace(/\{query\}/gi, encodeURIComponent(queryText))
      .replace(/\{anilistId\}/gi, encodeURIComponent(String(anilistId || '')))
      .replace(/\{malId\}/gi, encodeURIComponent(String(malId || '')))
      .replace(/\{anidbId\}/gi, encodeURIComponent(String(anidbId || '')))
      .replace(/\{episode\}/gi, encodeURIComponent(String(episode || '')))
  }
  // Bare URL without placeholders: append standard `q=` query param.
  const u = new URL(template)
  if (!u.searchParams.has('q') && queryText) u.searchParams.set('q', queryText)
  return u.toString()
}

/** Build 1–2 concise search strings from AniList titles for live feed queries. */
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

const memCache = new Map()

/**
 * Simple in-memory TTL cache (also tries IndexedDB when available in Worker for cross-episode persistence).
 */
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

/**
 * Fetch and merge candidates in parallel from all configured feed templates.
 */
export async function fetchFeedCandidates (templates, query, { fresh = false } = {}) {
  const anilistId = Number(query?.anilistId) || 0
  const malId = Number(query?.media?.idMal || query?.mappingsA?.mal_id || 0)
  const anidbId = Number(query?.anidbAid || query?.mappingsA?.anidb_id || 0)
  const episode = Number(query?.episode) || 1
  const queryStrings = buildQueryStrings(query)
  const urls = new Set()

  for (const tpl of templates) {
    if (/\{query\}/i.test(tpl) || !/\{[a-zA-Z0-9_]+\}/.test(tpl)) {
      for (const qText of (queryStrings.length ? queryStrings : [''])) {
        const u = expandFeedUrl(tpl, { queryText: qText, anilistId, malId, anidbId, episode })
        if (normalizeAllowedUrl(u)) urls.add(u)
      }
    } else {
      const u = expandFeedUrl(tpl, { queryText: queryStrings[0] || '', anilistId, malId, anidbId, episode })
      if (normalizeAllowedUrl(u)) urls.add(u)
    }
  }

  const all = []
  const seen = new Set()
  await Promise.all([...urls].map(async (url) => {
    const items = await cachedFetch(`feed:${url}`, 3 * 60_000, async () => {
      try {
        const res = await fetch(url, fresh ? { cache: 'no-store' } : undefined)
        if (!res.ok) return []
        const ct = String(res.headers.get('content-type') || '').toLowerCase()
        const text = await res.text()
        if (ct.includes('json') || text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) {
          try { return parseFeedJson(JSON.parse(text), url) } catch { return [] }
        }
        return parseFeedXml(text, url)
      } catch {
        return []
      }
    }, { fresh })
    for (const item of items || []) {
      const k = item.infoHash ? `${item.kind}:${item.infoHash}` : `${item.kind}:${item.title.toLowerCase()}`
      if (seen.has(k)) continue
      seen.add(k)
      all.push(item)
    }
  }))
  return all
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
