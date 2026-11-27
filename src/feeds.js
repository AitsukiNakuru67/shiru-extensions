/**
 * Pure Worker-safe feed fetching, remote sources manifest loading, XML (RSS 2.0 / Torznab / Newznab),
 * JSON (AnimeTosho / SeaDex / NZBIndex / generic), HTML Usenet crawler parsing (Binsearch / NZBKing),
 * and local TTL caching.
 * Contains zero hardcoded feed domains — sources come from `sourcesUrl` or `feedUrls`.
 */

export const DEFAULT_SOURCES_URL = 'https://pixeldrain.com/api/filesystem/qkW71xWE/sources.json'

const HEX40 = /^[0-9a-f]{40}$/i
const BASE32_32 = /^[A-Z2-7]{32}$/i
const B32_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const BTIH_RX = /urn:btih:([0-9a-f]{40}|[a-z2-7]{32})/i
const MIKAN_HASH_RX = /(?:\/Home\/Episode\/|\/Download\/\d{8}\/)([0-9a-f]{40})(?:\.torrent)?/i
const CJK_RX = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/

export function stripApiKey (url) {
  const text = String(url || '')
  if (!/[?&]apikey=/i.test(text)) return text
  return text.replace(/([?&])apikey=[^&#]*(&?)/gi, (_, lead, tail) => (tail ? lead : '')).replace(/[?&]$/, '')
}

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
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
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
  const m = /([\d.]+)\s*(Ki?B|Mi?B|Gi?B|Ti?B|B)/i.exec(s)
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

function cleanUsenetSubject (subject) {
  let s = String(subject || '').trim()
  // Only unwrap outer [...] when it wraps the entire subject with no nested brackets (nzbindex style).
  if (/^\[[^\[\]]+\]$/.test(s)) s = s.slice(1, -1).trim()
  s = s.replace(/(\.[a-z0-9]{2,4})\.\d{3}(?=["\]\s]|$)/i, '$1')
  const lead = /^(.*?\S)\s*\[\d+\/\d+\]/.exec(s)
  if (lead && !/^\s*\[\d+\/\d+\]/.test(s)) return lead[1].replace(/\s*-\s*$/, '').trim()
  const quoted = /"([^"]+)"/.exec(s)
  const file = quoted ? quoted[1] : s
  return file
    .replace(/\.(vol\d+\+\d+\.)?par2$/i, '')
    .replace(/\.part\d+(\.rar)?$/i, '')
    .replace(/\.(mkv|mp4|avi|ogm|wmv|rar|7z|zip|nfo|sfv|nzb)$/i, '')
    .trim()
}

/**
 * Parse RSS 2.0 / Torznab 1.3 / Newznab XML (Nyaa, Sukebei, dmhy base32 magnets, Mikan hashes, ameNZB)
 * into candidate items compatible with Shiru's `judgeModalResults`.
 */
export function parseFeedXml (xml, sourceUrl = '', sourceId = '', { isNewznab = false } = {}) {
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
      const url = stripApiKey(decodeXml(/\burl="([^"]*)"/i.exec(tag)?.[1] || ''))
      const type = decodeXml(/\btype="([^"]*)"/i.exec(tag)?.[1] || '').toLowerCase()
      const len = Number(/\blength="(\d+)"/i.exec(tag)?.[1] || 0)
      if (len > 0 && !encLen) encLen = len
      if ((type === 'application/x-nzb' || isNewznab) && url && !nzbEnc) nzbEnc = url
      else if (url && !torrentEnc) torrentEnc = url
    }

    const linkTag = stripApiKey(tagText(block, 'link'))
    const guid = stripApiKey(tagText(block, 'guid'))
    const magnetAttr = attrs.get('magneturl') || ''
    const infoHash = isNewznab
      ? ''
      : normalizeInfoHash(
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
    const nzbUrl = stripApiKey(nzbEnc || (isNewznab && /^https?:\/\//i.test(linkTag) ? linkTag : ''))
    const kind = isNewznab || (!infoHash && nzbUrl) ? 'nzb' : 'torrent'
    const link = kind === 'nzb'
      ? nzbUrl
      : (magnetAttr || (infoHash ? `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}` : (torrentEnc || linkTag)))
    const size = parseByteSize(attrs.get('size') || tagText(block, 'size') || tagText(block, 'nyaa:size') || encLen)
    const seeders = kind === 'nzb' ? null : intOrNull(attrs.get('seeders') ?? tagText(block, 'nyaa:seeders'))
    const leechers = kind === 'nzb' ? null : intOrNull(attrs.get('leechers') ?? attrs.get('peers') ?? tagText(block, 'nyaa:leechers'))
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
      kind,
      ...(nzbUrl ? { nzbUrl } : {}),
      host: isNewznab && sourceId.startsWith('amenzb') ? 'amenzb' : host,
      source: host ? [isNewznab && sourceId.startsWith('amenzb') ? 'amenzb' : host] : []
    })
  }
  return items
}

/** Parse Binsearch HTML search page into grouped complete Usenet NZB candidates (keyless). */
export function parseBinsearchHtml (html, sourceUrl = '') {
  if (!html || typeof html !== 'string') return []
  let base = 'https://binsearch.info'
  try { base = new URL(sourceUrl).origin } catch {}
  const ROW = /href="\/details\/([^"]+)">([\s\S]*?)<\/a><div class="flex flex-row flex-wrap gap-1 items-center text-xs">([\s\S]*?)<\/div><\/div><\/td><td class="min-w-20">([\s\S]*?)<\/td>/g
  const posts = new Map()
  for (const [, id, subj, meta] of html.matchAll(ROW)) {
    const flat = meta.replace(/<!-- -->/g, ' ')
    const complete = / complete /.test(` ${flat.replace(/<[^>]+>/g, ' ')} `) && !/incomplete/.test(flat)
    if (!complete || !id) continue
    const subject = decodeXml(subj.replace(/<[^>]+>/g, '')).trim()
    const title = cleanUsenetSubject(subject)
    if (!title) continue
    const poster = decodeXml(/href="\/search\?poster=([^"]*)"/.exec(meta)?.[1] || '')
    const size = parseByteSize(/bg-white">([^<]*)<\/span>/.exec(meta)?.[1] || '')
    const k = `${poster}\u0000${title}`
    const p = posts.get(k) || { title, ids: [], size: 0 }
    if (!p.ids.includes(id)) {
      p.ids.push(id)
      p.size += size
    }
    posts.set(k, p)
  }
  const out = []
  for (const p of posts.values()) {
    const nzbUrl = `${base}/nzb?${p.ids.map((id) => `${encodeURIComponent(id)}=on`).join('&')}`
    out.push({
      title: p.title,
      link: nzbUrl,
      nzbUrl,
      infoHash: '',
      hash: '',
      size: p.size,
      seeders: null,
      leechers: null,
      downloads: null,
      pubDate: '',
      pageUrl: `${base}/details/${encodeURIComponent(p.ids[0])}`,
      trusted: false,
      remake: false,
      kind: 'nzb',
      host: 'binsearch',
      source: ['binsearch']
    })
  }
  return out
}

/** Parse NZBKing HTML search page into complete, unprotected Usenet NZB candidates (keyless). */
export function parseNzbkingHtml (html, sourceUrl = '') {
  if (!html || typeof html !== 'string') return []
  let base = 'https://www.nzbking.com'
  try { base = new URL(sourceUrl).origin } catch {}
  const KING_ROW = /<div class='search-result'>([\s\S]*?)(?=<div class='search-result'>|<\/form>|$)/g
  const seen = new Set()
  const out = []
  for (const [, blk] of html.matchAll(KING_ROW)) {
    const id = /href="\/nzb:([A-Za-z0-9]{1,64})\//.exec(blk)?.[1]
    const subj = /<div class='search-subject'>([\s\S]*?)<br>/.exec(blk)
    if (!id || !subj || seen.has(id)) continue
    if (/PASSWORD PROTECTED/i.test(blk)) continue
    const parts = /parts:\s*(?:<span[^>]*>)?\s*(\d+)\/(\d+)/.exec(blk)
    if (!parts || parts[1] !== parts[2]) continue
    const subject = decodeXml(subj[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
    const title = cleanUsenetSubject(subject)
    if (!title) continue
    seen.add(id)
    const size = parseByteSize(/size:\s*([\d.]+\s*[KMGT]?B)/i.exec(blk)?.[1] || '')
    const nzbUrl = `${base}/nzb:${id}/`
    out.push({
      title,
      link: nzbUrl,
      nzbUrl,
      infoHash: '',
      hash: '',
      size,
      seeders: null,
      leechers: null,
      downloads: null,
      pubDate: '',
      pageUrl: nzbUrl,
      trusted: false,
      remake: false,
      kind: 'nzb',
      host: 'nzbking',
      source: ['nzbking']
    })
  }
  return out
}

/** Parse NZBIndex JSON API response (`data.content[]`) into complete Usenet NZB candidates (keyless). */
export function parseNzbindexJson (data, sourceUrl = '') {
  let base = 'https://nzbindex.com'
  try { base = new URL(sourceUrl).origin } catch {}
  const list = Array.isArray(data?.data?.content) ? data.data.content : []
  const seen = new Set()
  const out = []
  for (const r of list) {
    const id = typeof r?.id === 'string' || typeof r?.id === 'number' ? String(r.id).trim() : ''
    if (!id || !/^[A-Za-z0-9-]{1,64}$/.test(id) || seen.has(id)) continue
    if (r.complete !== true) continue
    const title = cleanUsenetSubject(r.name || '')
    if (!title) continue
    seen.add(id)
    const nzbUrl = `${base}/api/download/${id}.nzb`
    const posted = Number(r.posted)
    const pubDate = Number.isFinite(posted) && posted > 0 ? new Date(posted * 1000).toISOString() : ''
    out.push({
      title,
      link: nzbUrl,
      nzbUrl,
      infoHash: '',
      hash: '',
      size: parseByteSize(r.size || 0),
      seeders: null,
      leechers: null,
      downloads: null,
      pubDate,
      pageUrl: `${base}/collection/${id}`,
      trusted: false,
      remake: false,
      kind: 'nzb',
      host: 'nzbindex',
      source: ['nzbindex']
    })
  }
  return out
}

/** Parse AnimeTosho JSON feed array (`feed.animetosho.net/json`) into candidate items. */
export function parseAnimeToshoJson (data, sourceUrl = '', sourceId = 'animetosho', { enableUsenet = true } = {}) {
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
    const seeders = intOrNull(r.seeders)
    const size = parseByteSize(r.total_size || r.size || 0)
    const pageUrl = String(r.website_url || r.link || '')

    if (infoHash) {
      out.push({
        title,
        link,
        infoHash,
        hash: infoHash,
        size,
        seeders,
        leechers: intOrNull(r.leechers),
        downloads: intOrNull(r.downloads),
        pubDate,
        pageUrl,
        trusted: false,
        remake: false,
        kind: 'torrent',
        ...(nzbUrl ? { nzbUrl } : {}),
        host,
        source: [host]
      })
    }
    // Also surface AnimeTosho's keyless NZB when Usenet is enabled and the torrent has no/dead seeders (or is NZB-only).
    if (enableUsenet && nzbUrl && (!infoHash || seeders === 0)) {
      out.push({
        title,
        link: nzbUrl,
        nzbUrl,
        infoHash: '',
        hash: '',
        size,
        seeders: null,
        leechers: null,
        downloads: null,
        pubDate,
        pageUrl,
        trusted: false,
        remake: false,
        kind: 'nzb',
        host: 'animetosho',
        source: ['animetosho']
      })
    }
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
    const link = stripApiKey(String(r.link || r.magnet || r.magnet_uri || (infoHash ? `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}` : '')))
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
      pageUrl: stripApiKey(String(r.pageUrl || r.website_url || r.website || '')),
      trusted: r.trusted === true || r.nyaaTrusted === true,
      remake: r.remake === true,
      seadex: r.seadex === true,
      seadexBest: r.seadexBest === true,
      kind: r.kind === 'nzb' ? 'nzb' : 'torrent',
      ...(r.nzbUrl || r.nzb_url ? { nzbUrl: stripApiKey(String(r.nzbUrl || r.nzb_url)) } : {}),
      host: String(r.host || host),
      source: Array.isArray(r.source) ? r.source : (host ? [host] : [])
    })
  }
  return out
}

/** Expand a feed URL template for a specific show/episode query. Returns `''` if any required placeholder is empty. */
export function expandFeedUrl (template, vars) {
  const { queryText = '', orQuery = '', nativeQuery = '', anilistId = 0, malId = 0, anidbId = 0, anidbEid = 0, episode = 1, amenzbKey = '' } = vars || {}
  if (/\{anilistId\}/i.test(template) && !anilistId) return ''
  if (/\{malId\}/i.test(template) && !malId) return ''
  if (/\{anidbId\}/i.test(template) && !anidbId) return ''
  if (/\{anidbEid\}/i.test(template) && !anidbEid) return ''
  if (/\{amenzbKey\}/i.test(template) && !amenzbKey) return ''
  if (/\{nativeQuery\}/i.test(template) && !nativeQuery) return ''
  if (/\{orQuery\}/i.test(template) && !(orQuery || queryText)) return ''
  if (/\{query\}/i.test(template) && !queryText) return ''

  const hasPlaceholder = /\{[a-zA-Z0-9_]+\}/.test(template)
  if (hasPlaceholder) {
    return template
      .replace(/\{orQuery\}/gi, encodeURIComponent(orQuery || queryText))
      .replace(/\{query\}/gi, encodeURIComponent(queryText))
      .replace(/\{nativeQuery\}/gi, encodeURIComponent(nativeQuery))
      .replace(/\{anilistId\}/gi, encodeURIComponent(String(anilistId || '')))
      .replace(/\{malId\}/gi, encodeURIComponent(String(malId || '')))
      .replace(/\{anidbId\}/gi, encodeURIComponent(String(anidbId || '')))
      .replace(/\{anidbEid\}/gi, encodeURIComponent(String(anidbEid || '')))
      .replace(/\{episode\}/gi, encodeURIComponent(String(episode || '')))
      .replace(/\{amenzbKey\}/gi, encodeURIComponent(String(amenzbKey || '')))
  }
  const u = new URL(template)
  if (!u.searchParams.has('q') && queryText) u.searchParams.set('q', queryText)
  return u.toString()
}

/** Build 1–2 concise Latin/Romanized search strings from AniList titles for plain-text queries. */
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
      const res = await fetch(`https://api.ani.zip/mappings?anilist_id=${anilistId}`, { signal: AbortSignal.timeout(8000) })
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
export async function fetchFeedCandidates (sourcesOrTemplates, query, {
  fresh = false,
  useAnizip = true,
  enableUsenet = true,
  amenzbKey = '',
  orQueries = null,
  nativeQueries = null,
  anidbId: presetAnidbId = 0,
  anidbEid: presetAnidbEid = 0,
  malId: presetMalId = 0
} = {}) {
  const normalized = (sourcesOrTemplates || [])
    .map((entry) => (typeof entry === 'string' ? { id: '', format: 'auto', scope: 'any', url: entry } : entry))
    .filter((s) => s && isValidSourceTemplate(s.url))

  const hentai = isHentaiMedia(query)
  const cleanAmenzbKey = String(amenzbKey || '').trim()
  const active = normalized.filter((s) => {
    if (s.scope === 'usenet') return enableUsenet
    if (s.scope === 'hentai') return hentai
    if (s.scope === 'sfw') return !hentai
    return true
  })

  const anilistId = Number(query?.anilistId) || 0
  const episode = Number(query?.episode) || 1
  let malId = Number(presetMalId || query?.media?.idMal || query?.mappingsA?.mal_id || 0)
  let anidbId = Number(presetAnidbId || query?.anidbAid || query?.mappingsA?.anidb_id || 0)
  let anidbEid = Number(presetAnidbEid || query?.anidbEid || query?.mappingsE?.anidbEid || 0)

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
  const orList = Array.isArray(orQueries) && orQueries.length ? orQueries.slice(0, 5) : queryStrings
  const nativeStrings = Array.isArray(nativeQueries) && nativeQueries.length ? nativeQueries.slice(0, 2) : buildNativeQueryStrings(query)
  const jobs = new Map()

  const addJob = (src, url) => {
    if (!url || !normalizeAllowedUrl(url)) return
    // Strip apikey from cache/dedupe key so keys never linger in memory map keys.
    const safeKey = `${src.format}:${stripApiKey(url)}`
    if (!jobs.has(safeKey)) jobs.set(safeKey, { src, url, safeKey })
  }

  for (const src of active) {
    const baseVars = {
      queryText: queryStrings[0] || '',
      orQuery: orList[0] || queryStrings[0] || '',
      nativeQuery: nativeStrings[0] || '',
      anilistId,
      malId,
      anidbId,
      anidbEid,
      episode,
      amenzbKey: cleanAmenzbKey
    }
    if (/\{orQuery\}/i.test(src.url)) {
      for (const oq of (orList.length ? orList : [''])) {
        addJob(src, expandFeedUrl(src.url, { ...baseVars, orQuery: oq }))
      }
    } else if (/\{nativeQuery\}/i.test(src.url)) {
      for (const nq of nativeStrings) {
        addJob(src, expandFeedUrl(src.url, { ...baseVars, nativeQuery: nq }))
      }
    } else if (/\{query\}/i.test(src.url) || !/\{[a-zA-Z0-9_]+\}/.test(src.url)) {
      for (const qText of (queryStrings.length ? queryStrings : [''])) {
        addJob(src, expandFeedUrl(src.url, { ...baseVars, queryText: qText }))
      }
    } else {
      addJob(src, expandFeedUrl(src.url, baseVars))
    }
  }

  const byKey = new Map()
  const seadexMeta = new Map()

  await Promise.all([...jobs.values()].map(async ({ src, url, safeKey }) => {
    const fetched = await cachedFetch(`feed:${safeKey}`, 3 * 60_000, async () => {
      try {
        const res = await fetch(url, { ...(fresh ? { cache: 'no-store' } : {}), signal: AbortSignal.timeout(6000) })
        if (!res.ok) return { items: [], meta: null }
        const ct = String(res.headers.get('content-type') || '').toLowerCase()
        const text = await res.text()

        if (src.format === 'binsearch-html') {
          return { items: parseBinsearchHtml(text, url), meta: null }
        }
        if (src.format === 'nzbking-html') {
          return { items: parseNzbkingHtml(text, url), meta: null }
        }
        if (src.format === 'newznab') {
          return { items: parseFeedXml(text, stripApiKey(url), src.id, { isNewznab: true }), meta: null }
        }

        const looksJson = src.format === 'seadex' || src.format === 'animetosho-json' || src.format === 'nzbindex-json' || src.format === 'json' || ct.includes('json') || text.trimStart().startsWith('{') || text.trimStart().startsWith('[')
        if (looksJson) {
          let parsed
          try { parsed = JSON.parse(text) } catch { return { items: [], meta: null } }
          if (src.format === 'seadex') {
            const sd = parseSeaDexJson(parsed, query)
            return { items: sd.items, meta: [...sd.metaByHash.entries()] }
          }
          if (src.format === 'animetosho-json') {
            return { items: parseAnimeToshoJson(parsed, url, src.id || 'animetosho', { enableUsenet }), meta: null }
          }
          if (src.format === 'nzbindex-json') {
            return { items: parseNzbindexJson(parsed, url), meta: null }
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
      const k = item.infoHash
        ? `${item.kind}:${item.infoHash}`
        : (item.nzbUrl ? `nzb:${item.nzbUrl}` : `${item.kind}:${item.title.toLowerCase()}`)
      const existing = byKey.get(k)
      if (existing) {
        mergeCandidate(existing, item)
      } else {
        byKey.set(k, { ...item, source: [...(item.source || [])] })
      }
    }
  }))

  // Apply SeaDex curation flags onto every torrent candidate whose infoHash appears in SeaDex.
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
