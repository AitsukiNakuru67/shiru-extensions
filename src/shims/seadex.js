/**
 * Dynamic manifest-backed SeaDex client shim for Shiru's real `cascadeSearch.js`.
 * Preserves Shiru's exact `seadexTorrentsFromResponse` + `seadexHdSource` logic
 * (upscale detection, per-file listing, best/dual-audio flags) while reading the
 * SeaDex API template from the active `sources.json` manifest (zero hardcoded domains).
 */
import { isVideoFilePath } from '../../vendor/matcher/common/modules/anime/videoFiles.js'
import { statedPicture, episodeHdSource } from '../../vendor/matcher/common/modules/seasonal/grab/hdSource.js'
import { expandFeedUrl, normalizeAllowedUrl } from '../feeds.js'
import { getCascadeTransportContext } from '../cascade-transport.js'

export { statedPicture, episodeHdSource }

const CACHE_TTL_MS = 60 * 60 * 1000
const cache = new Map()

export class SeaDexUnavailableError extends Error {
  constructor (message) {
    super(message)
    this.name = 'SeaDexUnavailableError'
  }
}

export function resetSeadexCacheForTest () {
  cache.clear()
}

const SEADEX_EXTRA_DIR = /(?:^|\/)(?:extras?|bonus|specials?|nc(?:op|ed)?s?|creditless|menus?|scans?|cds?|ost|bk|sp)\b[^/]*\//i
const NOTES_SD_SOURCE = /\b(?:DVD(?:s|-?R|rip)?|LD(?:s|\s*rip)?|Laserdiscs?|VHS)\b/i
const NOTES_NOT_VIDEO = /^\s*(?:subs?\b|subtitles?|audio|dub\b|signs|vobsubs?|menus?|extras?)/i
const NOTES_HD_SOURCE = /\b(?:BD|Blu-?ray|BDMV|UHD|WEB(?:-?DL|rip)?|AMZN|NF|CR|HIDIVE|iT|DSNP|B-?Global|HDTV)\b/i

function episodeFilesPicture (tr) {
  const names = (Array.isArray(tr?.files) ? tr.files : [])
    .map((file) => String(file?.name || ''))
    .filter((name) => isVideoFilePath(name) && !SEADEX_EXTRA_DIR.test(name))
  const said = names.map((name) => statedPicture(name.split('/').at(-1)))
  if (said.some((set) => set.has('hd'))) return 'hd'
  if (said.some((set) => set.has('mid'))) return 'mid'
  const sd = said.filter((set) => set.has('sd')).length
  return sd > 0 && sd * 2 >= names.length ? 'sd' : null
}

function notesVideoSource (entries) {
  const clauses = entries
    .flatMap((entry) => String(entry?.notes || '').split(/\s\/\s|\n/))
    .filter((clause) => /^\s*\S+(?:\s\S+)?\s+is\s/.test(clause))
    .map((clause) => clause.split('+')[0])
  let sd = false
  let hd = false
  for (const clause of clauses) {
    const m = NOTES_SD_SOURCE.exec(clause)
    if (m && !NOTES_NOT_VIDEO.test(clause.slice(m.index + m[0].length))) sd = true
    if (NOTES_HD_SOURCE.test(clause)) hd = true
  }
  return sd ? (hd ? 'upscale-part' : 'upscale') : null
}

export function seadexHdSource (entries, { titleOf } = {}) {
  const list = Array.isArray(entries) ? entries : []
  if (list.some((entry) => /upscal/i.test(String(entry?.notes || '')))) return 'upscale'
  const all = list.flatMap((entry) => entry?.expand?.trs || [])
  const curated = all.some((tr) => tr?.isBest) ? all.filter((tr) => tr?.isBest) : all
  const stated = new Set()
  for (const tr of curated) {
    const title = typeof titleOf === 'function' ? statedPicture(titleOf(String(tr?.infoHash || '').toLowerCase()) || '') : new Set()
    if (title.size) for (const kind of title) stated.add(kind)
    else {
      const files = episodeFilesPicture(tr)
      if (files) stated.add(files)
    }
  }
  if (stated.has('hd')) return stated.has('sd') ? 'upscale-part' : 'real'
  if (stated.has('sd')) return 'upscale'
  if (stated.size) return null
  return notesVideoSource(list)
}

export function seadexTorrentsFromResponse (data, anilistId) {
  const id = Number(anilistId)
  if (!Number.isSafeInteger(id) || id <= 0) return null
  const entries = Array.isArray(data?.items) ? data.items : null
  if (!entries || entries.some((entry) => entry?.alID != null && Number(entry.alID) !== id)) return null

  const listing = []
  for (const entry of entries) {
    for (const tr of entry?.expand?.trs || []) {
      const infoHash = String(tr?.infoHash || '').toLowerCase().trim()
      const files = (Array.isArray(tr?.files) ? tr.files : [])
        .map((f) => ({ name: String(f?.name || ''), length: Number(f?.length) || 0 }))
        .filter((f) => isVideoFilePath(f.name))
      if (files.length) listing.push({ source: 'seadex', infoHash: /^[a-f\d]{40}$/.test(infoHash) ? infoHash : null, files })
    }
  }
  const hdSource = seadexHdSource(entries)
  const torrents = []
  for (const entry of entries) {
    for (const tr of entry?.expand?.trs || []) {
      const infoHash = String(tr?.infoHash || '').toLowerCase().trim()
      if (!infoHash || infoHash.includes('<redacted>') || infoHash.includes('redacted') || !/^[a-f\d]{40}$/.test(infoHash)) continue
      const tracker = String(tr?.tracker || '').trim()
      const isPublic = !tracker || /^(?:nyaa|animetosho|sukebei|public|anidex|tosho)/i.test(tracker)
      if (!isPublic) continue
      torrents.push({
        infoHash,
        isBest: !!tr?.isBest,
        releaseGroup: String(tr?.releaseGroup || '').trim(),
        dualAudio: !!tr?.dualAudio,
        tracker,
        url: String(tr?.url || '').trim(),
        created: String(tr?.created || entry?.created || ''),
        sourceAnilistId: id,
        hdSource,
        files: Array.isArray(tr?.files)
          ? tr.files.map((f) => ({ name: String(f?.name || ''), length: Number(f?.length) || 0 }))
          : [],
        listing
      })
    }
  }
  return torrents
}

export async function fetchSeadexTorrents (anilistId, { reportFailure = false } = {}) {
  const id = Number(anilistId)
  if (!Number.isFinite(id) || id <= 0) return []
  const ctx = getCascadeTransportContext()
  const tpl = ctx?.hosts?.seadexTemplate
  if (!tpl) return []

  const url = normalizeAllowedUrl(expandFeedUrl(tpl, { anilistId: id }))
  if (!url) return []
  const cacheKey = `${url}`
  const cached = !ctx.fresh ? cache.get(cacheKey) : null
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.torrents

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      ...(ctx.fresh ? { cache: 'no-store' } : {}),
      signal: AbortSignal.timeout(6000)
    })
    if (!res?.ok) {
      if (cached) return cached.torrents
      if (reportFailure) throw new SeaDexUnavailableError(`seadex_http_${res?.status ?? 'none'}`)
      return []
    }
    const data = await res.json()
    const torrents = seadexTorrentsFromResponse(data, id)
    if (!torrents) {
      if (reportFailure) throw new SeaDexUnavailableError('seadex_identity_mismatch')
      return []
    }
    cache.set(cacheKey, { at: Date.now(), torrents })
    if (cache.size > 200) cache.delete(cache.keys().next().value)
    return torrents
  } catch (e) {
    if (e instanceof SeaDexUnavailableError) throw e
    if (cached) return cached.torrents
    if (reportFailure) throw new SeaDexUnavailableError(`seadex_fetch_failed: ${e?.message || e}`)
    return []
  }
}
