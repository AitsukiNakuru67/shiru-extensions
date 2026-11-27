/**
 * Lightweight self-hosted local pre-builder & HTTP server for Shiru / shiru-extensions.
 *
 * Pre-builds ranked episode files ahead of time onto local disk + in-memory LRU so Shiru
 * gets millisecond responses (< 5 ms) when configured with `http://127.0.0.1:8787`.
 *
 * Environment variables:
 *   HOST               Bind host (default: 127.0.0.1)
 *   PORT               Bind port (default: 8787)
 *   DATA_DIR           Disk cache directory (default: ./data/cache)
 *   FEED_URLS          Comma-separated RSS 2.0 / Torznab 1.3 / JSON feed templates
 *   ANILIST_USER       Optional AniList username whose CURRENT/PLANNING list to pre-build
 *   WATCH_ANILIST_IDS  Optional comma-separated AniList IDs to pre-build ahead of time
 *   PREBUILD_AIRING    Set "1" (default) to pre-build currently airing episodes from AniList
 *   PREBUILD_LIMIT     Max airing shows to pre-build per sweep (default: 25)
 *   REFRESH_MINUTES    Background pre-build interval in minutes (default: 15, 0 = off)
 *   SITE_NAME          Display brand in /site.json (default: Local Pre-Built Index)
 *   SITE_TRACKERS      Optional comma-separated tracker URLs advertised in /site.json
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import ext from '../sources/release-index.js'
import { anitomyPure } from '../src/parse-title.js'
import { openSeedStore, importSeed, DEFAULT_SEED_URL, DEFAULT_SEED_META_URL } from './seed-store.mjs'

const DEFAULT_SOURCES_URL = 'https://pixeldrain.com/api/filesystem/qkW71xWE/sources.json'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const ANILIST_ENDPOINT = 'https://graphql.anilist.co'
const ANILIST_MEDIA_QUERY = `query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id idMal episodes duration format status
    title { romaji english native userPreferred }
    synonyms
    nextAiringEpisode { episode airingAt }
    relations { edges { relationType node { id format episodes title { romaji english native userPreferred } } } }
  }
}`
const ANILIST_AIRING_QUERY = `query ($perPage: Int) {
  Page(page: 1, perPage: $perPage) {
    media(type: ANIME, status: RELEASING, sort: POPULARITY_DESC) {
      id idMal episodes duration format status
      title { romaji english native userPreferred }
      synonyms
      nextAiringEpisode { episode airingAt }
      relations { edges { relationType node { id format episodes title { romaji english native userPreferred } } } }
    }
  }
}`
const ANILIST_USER_LIST_QUERY = `query ($userName: String) {
  MediaListCollection(userName: $userName, type: ANIME, status_in: [CURRENT, REPEATING]) {
    lists {
      entries {
        progress
        media {
          id idMal episodes duration format status
          title { romaji english native userPreferred }
          synonyms
          nextAiringEpisode { episode airingAt }
          relations { edges { relationType node { id format episodes title { romaji english native userPreferred } } } }
        }
      }
    }
  }
}`
const ANILIST_AIRING_SCHEDULE_QUERY = `query ($page: Int, $perPage: Int, $from: Int, $to: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
      airingAt
      episode
      media {
        id idMal episodes duration format status genres
        title { romaji english native userPreferred }
        synonyms
        nextAiringEpisode { episode airingAt }
        relations { edges { relationType node { id format episodes title { romaji english native userPreferred } } } }
      }
    }
  }
}`

async function queryAniList (query, variables, fetchImpl = fetch) {
  const res = await fetchImpl(ANILIST_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, variables })
  })
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`)
  const body = await res.json()
  return body?.data || null
}

/**
 * Create a self-hostable local pre-builder HTTP server.
 * @param {object} [opts]
 */
export function createLocalIndexServer (opts = {}) {
  const host = opts.host ?? process.env.HOST ?? '127.0.0.1'
  const port = Number(opts.port ?? process.env.PORT ?? 8787)
  const dataDir = path.resolve(opts.dataDir ?? process.env.DATA_DIR ?? path.join(ROOT, 'data/cache'))
  const seedDir = path.resolve(opts.seedDir ?? process.env.SEED_DIR ?? path.join(ROOT, 'data/seed'))
  const rawSeedUrl = opts.seedUrl !== undefined ? opts.seedUrl : (process.env.SEED_URL ?? DEFAULT_SEED_URL)
  const seedUrl = /^(?:off|none|false|0)$/i.test(String(rawSeedUrl || '').trim()) ? '' : String(rawSeedUrl || '').trim()
  const seedMetaUrl = opts.seedMetaUrl !== undefined ? opts.seedMetaUrl : (process.env.SEED_META_URL ?? (seedUrl === DEFAULT_SEED_URL ? DEFAULT_SEED_META_URL : ''))
  const feedUrls = String(opts.feedUrls ?? process.env.FEED_URLS ?? '').trim()
  const rawSourcesUrl = opts.sourcesUrl !== undefined ? opts.sourcesUrl : (process.env.SOURCES_URL ?? DEFAULT_SOURCES_URL)
  const sourcesUrl = /^(?:off|none|false|0)$/i.test(String(rawSourcesUrl || '').trim()) ? '' : String(rawSourcesUrl || '').trim()
  const hasSources = !!(feedUrls || sourcesUrl)
  const siteName = String(opts.siteName ?? process.env.SITE_NAME ?? 'Local Pre-Built Index').trim()
  const staticTrackers = String(opts.trackers ?? process.env.SITE_TRACKERS ?? '')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => /^(?:udp|https?|wss?):\/\/[^\s]{3,240}$/i.test(s))
  let manifestTrackers = []
  let manifestTrackersAt = 0

  async function refreshManifestTrackers () {
    if (!sourcesUrl) return manifestTrackers
    if (Date.now() - manifestTrackersAt < 15 * 60_000 && manifestTrackers.length) return manifestTrackers
    try {
      const res = await fetchImpl(sourcesUrl, { signal: AbortSignal.timeout(8000) })
      if (res.ok) {
        const body = await res.json()
        if (Array.isArray(body?.trackers)) {
          manifestTrackers = body.trackers
            .map((s) => String(s || '').trim())
            .filter((s) => /^(?:udp|https?|wss?):\/\/[^\s]{3,240}$/i.test(s))
          manifestTrackersAt = Date.now()
        }
      }
    } catch {}
    return manifestTrackers
  }

  function effectiveTrackers () {
    const seen = new Set(staticTrackers)
    return [...staticTrackers, ...manifestTrackers.filter((t) => !seen.has(t))]
  }
  const anilistUser = String(opts.anilistUser ?? process.env.ANILIST_USER ?? '').trim()
  const watchIds = String(opts.watchIds ?? process.env.WATCH_ANILIST_IDS ?? '')
    .split(/[\s,]+/)
    .map((n) => Number(n))
    .filter((n) => Number.isSafeInteger(n) && n > 0)
  const prebuildAiring = (opts.prebuildAiring ?? process.env.PREBUILD_AIRING ?? '1') !== '0'
  const prebuildLimit = Math.max(1, Math.min(100, Number(opts.prebuildLimit ?? process.env.PREBUILD_LIMIT ?? 25) || 25))
  const refreshMinutes = Math.max(0, Number(opts.refreshMinutes ?? process.env.REFRESH_MINUTES ?? 15) || 0)
  const catchupEnabled = (opts.catchupEnabled ?? process.env.CATCHUP_ENABLED ?? '1') !== '0'
  const catchupMaxDays = Math.max(1, Math.min(90, Number(opts.catchupMaxDays ?? process.env.CATCHUP_MAX_DAYS ?? 30) || 30))
  const recheckWindowHours = Math.max(0, Math.min(168, Number(opts.recheckWindowHours ?? process.env.RECHECK_WINDOW_HOURS ?? 48) || 48))
  const recheckMinAgeHours = Math.max(1, Math.min(48, Number(opts.recheckMinAgeHours ?? process.env.RECHECK_MIN_AGE_HOURS ?? 6) || 6))
  const catchupMaxPages = Math.max(1, Math.min(100, Number(opts.catchupMaxPages ?? process.env.CATCHUP_MAX_PAGES ?? 40) || 40))
  const yieldMs = opts.yieldMs !== undefined ? Math.max(0, Number(opts.yieldMs) || 0) : 200
  const nowFn = typeof opts.now === 'function' ? opts.now : Date.now
  const useAnizip = (opts.useAnizip ?? process.env.USE_ANIZIP ?? '1') !== '0'
  const enableUsenet = (opts.enableUsenet ?? process.env.ENABLE_USENET ?? '1') !== '0'
  const amenzbApiKey = String(opts.amenzbApiKey ?? process.env.AMENZB_API_KEY ?? '').trim()
  const fetchImpl = opts.fetch || fetch
  const log = opts.log || ((...a) => console.log(`[local-index ${new Date().toISOString()}]`, ...a))

  ext.anitomyscript = opts.anitomyscript || anitomyPure
  ext.settings = { indexUrl: '', sourcesUrl, feedUrls, useAnizip, enableUsenet, amenzbApiKey }

  fs.mkdirSync(path.join(dataDir, 'anilist'), { recursive: true })
  const seedStore = openSeedStore(seedDir)
  let seedImporting = false

  const catchupStatePath = path.join(dataDir, 'catchup-state.json')
  function loadCatchupState () {
    try {
      if (fs.existsSync(catchupStatePath)) {
        const parsed = JSON.parse(fs.readFileSync(catchupStatePath, 'utf8'))
        if (parsed && typeof parsed === 'object') {
          return {
            lastCatchupAt: Number(parsed.lastCatchupAt) || 0,
            lastCatchupRunAt: parsed.lastCatchupRunAt || null,
            caughtUpTotal: Number(parsed.caughtUpTotal) || 0
          }
        }
      }
    } catch {}
    return { lastCatchupAt: 0, lastCatchupRunAt: null, caughtUpTotal: 0 }
  }
  function saveCatchupState (state) {
    try {
      const tmp = `${catchupStatePath}.tmp.${process.pid}`
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
      fs.renameSync(tmp, catchupStatePath)
    } catch {}
  }
  const catchupState = loadCatchupState()
  let catchupRunning = false
  let catchupPending = 0

  /** Hot in-memory cache of serialized gzipped + plain JSON responses for sub-millisecond reads. */
  const mem = new Map()
  const mediaCache = new Map()
  const inflight = new Map()
  const queue = []
  let queueRunning = false
  let prebuildTimer = null
  const stats = {
    startedAt: new Date().toISOString(),
    cachedFiles: 0,
    seedEpisodes: seedStore.count,
    builtCount: 0,
    memHits: 0,
    diskHits: 0,
    seedHits: 0,
    misses: 0,
    lastPrebuildAt: null,
    lastPrebuildBuilt: 0,
    lastError: null
  }

  function rankFilePath (id, ep) {
    return path.join(dataDir, 'anilist', String(id), `${ep}.rank.json.gz`)
  }

  function readCached (id, ep) {
    const key = `${id}:${ep}`
    const hit = mem.get(key)
    if (hit) {
      stats.memHits++
      return hit
    }
    const file = rankFilePath(id, ep)
    if (fs.existsSync(file)) {
      try {
        const gz = fs.readFileSync(file)
        const json = zlib.gunzipSync(gz).toString('utf8')
        const entry = { json, gz, builtAt: fs.statSync(file).mtime.toISOString(), cacheSource: 'hit' }
        mem.set(key, entry)
        if (mem.size > 500) mem.delete(mem.keys().next().value)
        stats.diskHits++
        return entry
      } catch {}
    }
    if (seedStore.ready) {
      const payload = seedStore.getRankPayload(id, ep, { trackers: effectiveTrackers() })
      if (payload) {
        const wrapped = { ...payload, anilistId: id, episode: ep, builtAt: payload.seededAt || new Date().toISOString() }
        const json = JSON.stringify(wrapped)
        const gz = zlib.gzipSync(Buffer.from(json, 'utf8'))
        const entry = { json, gz, builtAt: wrapped.builtAt, cacheSource: 'seed' }
        mem.set(key, entry)
        if (mem.size > 500) mem.delete(mem.keys().next().value)
        stats.seedHits++
        return entry
      }
    }
    stats.misses++
    return null
  }

  function writeCached (id, ep, payload) {
    const wrapped = {
      ...payload,
      anilistId: id,
      episode: ep,
      builtAt: new Date().toISOString()
    }
    const json = JSON.stringify(wrapped)
    const gz = zlib.gzipSync(Buffer.from(json, 'utf8'))
    const file = rankFilePath(id, ep)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp.${process.pid}`
    fs.writeFileSync(tmp, gz)
    fs.renameSync(tmp, file)
    const entry = { json, gz, builtAt: wrapped.builtAt }
    mem.set(`${id}:${ep}`, entry)
    if (mem.size > 500) mem.delete(mem.keys().next().value)
    stats.builtCount++
    writeLatestSnapshot(id, ep, wrapped)
    return entry
  }

  const recentEvents = []
  function writeLatestSnapshot (id, ep, body) {
    const top = body?.sections?.recommended?.[0] || null
    recentEvents.unshift({
      anilistId: id,
      episode: ep,
      at: body.builtAt,
      count: body?.sections?.raw?.length || 0,
      topTitle: top?.displayName || top?.title || null
    })
    if (recentEvents.length > 100) recentEvents.length = 100
  }

  function countDiskFiles () {
    let n = 0
    const root = path.join(dataDir, 'anilist')
    if (!fs.existsSync(root)) return 0
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      for (const f of fs.readdirSync(path.join(root, d.name))) {
        if (f.endsWith('.rank.json.gz')) n++
      }
    }
    return n
  }
  stats.cachedFiles = countDiskFiles()

  async function resolveMedia (id) {
    const hit = mediaCache.get(id)
    if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.media
    if (typeof opts.resolveMedia === 'function') {
      const m = await opts.resolveMedia(id)
      if (m) mediaCache.set(id, { media: m, at: Date.now() })
      return m
    }
    const data = await queryAniList(ANILIST_MEDIA_QUERY, { id }, fetchImpl)
    const m = data?.Media || null
    if (m) mediaCache.set(id, { media: m, at: Date.now() })
    return m
  }

  async function buildEpisode (id, ep, { media = null, resolution = '1080', fresh = false } = {}) {
    const key = `${id}:${ep}`
    if (!fresh) {
      const existing = readCached(id, ep)
      if (existing) return existing
    }
    if (inflight.has(key)) return inflight.get(key)
    const job = (async () => {
      if (!hasSources) return null
      const m = media || await resolveMedia(id)
      if (!m) return null
      const titles = [m.title?.romaji, m.title?.english, ...(m.synonyms || [])].filter(Boolean)
      const payload = await ext.list({
        anilistId: id,
        episode: ep,
        episodeCount: m.episodes || undefined,
        resolution,
        titles,
        media: m
      }, { fresh })
      if (!payload || !payload.sections) return null
      const saved = writeCached(id, ep, payload)
      stats.cachedFiles = countDiskFiles()
      return saved
    })().finally(() => inflight.delete(key))
    inflight.set(key, job)
    return job
  }

  function enqueue (id, ep, media = null) {
    if (queue.some((q) => q.id === id && q.ep === ep) || inflight.has(`${id}:${ep}`)) return false
    queue.push({ id, ep, media })
    drainQueue()
    return true
  }

  async function drainQueue () {
    if (queueRunning) return
    queueRunning = true
    try {
      while (queue.length) {
        const item = queue.shift()
        try {
          await buildEpisode(item.id, item.ep, { media: item.media })
        } catch (err) {
          stats.lastError = String(err?.message || err)
        }
      }
    } finally {
      queueRunning = false
    }
  }

  /**
   * Lossless offline catch-up via AniList's paginated AiringSchedule API.
   * Resumes from `catchup-state.json` (or `seed.json`'s `generatedAt` on first boot), builds every
   * missed episode chronologically, checkpoints per episode so mid-catchup shutdowns never lose
   * progress, and re-checks episodes from the last `RECHECK_WINDOW_HOURS` (default 48h) to catch
   * delayed fansubs/v2s once their cached file is older than `RECHECK_MIN_AGE_HOURS` (default 6h).
   */
  async function catchupSweep () {
    if (!hasSources) return { built: 0, discovered: 0, skipped: 'no SOURCES_URL or FEED_URLS configured' }
    if (!catchupEnabled) return { built: 0, discovered: 0, skipped: 'catchup disabled' }
    if (catchupRunning) return { built: 0, discovered: 0, skipped: 'already running' }

    catchupRunning = true
    catchupPending = 0
    let built = 0
    let discovered = 0
    let discoveryOk = true

    try {
      const nowMs = nowFn()
      const nowSec = Math.floor(nowMs / 1000)
      const floorSec = nowSec - catchupMaxDays * 86400

      // Determine starting cursor: saved cursor -> seed timestamp -> 48h default
      let cursorSec = Number(catchupState.lastCatchupAt) || 0
      if (!cursorSec) {
        const seedTs = seedStore.meta?.generatedAt ? Math.floor(Date.parse(seedStore.meta.generatedAt) / 1000) : 0
        cursorSec = seedTs > 0 ? Math.max(floorSec, Math.min(seedTs, nowSec)) : (nowSec - 48 * 3600)
      } else if (cursorSec < floorSec) {
        cursorSec = floorSec
      }

      const overlapSec = 6 * 3600
      const recheckFromSec = recheckWindowHours > 0 ? (nowSec - recheckWindowHours * 3600) : nowSec
      const fromSec = Math.max(floorSec, Math.min(cursorSec - overlapSec, recheckFromSec))

      /** @type {Array<{ id: number, ep: number, airingAt: number, media: any }>} */
      const scheduled = []
      const seen = new Set()

      for (let page = 1; page <= catchupMaxPages; page++) {
        try {
          const data = await queryAniList(
            ANILIST_AIRING_SCHEDULE_QUERY,
            { page, perPage: 50, from: fromSec, to: nowSec },
            fetchImpl
          )
          const pageObj = data?.Page
          const rows = Array.isArray(pageObj?.airingSchedules) ? pageObj.airingSchedules : []
          for (const row of rows) {
            const m = row?.media
            const id = Number(m?.id)
            const ep = Number(row?.episode)
            const airingAt = Number(row?.airingAt) || 0
            if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(ep) || ep <= 0) continue
            const k = `${id}:${ep}`
            if (seen.has(k)) continue
            seen.add(k)
            scheduled.push({ id, ep, airingAt, media: m })
          }
          if (!pageObj?.pageInfo?.hasNextPage || rows.length === 0) break
          if (yieldMs > 0) await new Promise((r) => setTimeout(r, Math.max(yieldMs, 350)))
        } catch (err) {
          discoveryOk = false
          stats.lastError = `catchup discovery: ${String(err?.message || err)}`
          log(stats.lastError)
          break
        }
      }

      discovered = scheduled.length
      catchupPending = scheduled.length
      const minFreshMs = Math.max(15, refreshMinutes || 15) * 60_000
      const recheckMinAgeMs = recheckMinAgeHours * 3600_000

      for (const item of scheduled) {
        catchupPending = Math.max(0, catchupPending - 1)
        const file = rankFilePath(item.id, item.ep)
        const exists = fs.existsSync(file)
        const ageMs = exists ? (nowFn() - fs.statSync(file).mtimeMs) : Infinity
        const isNewSinceCursor = item.airingAt > cursorSec
        const inRecheckWindow = item.airingAt >= recheckFromSec

        let shouldBuild = false
        if (!exists) {
          shouldBuild = true
        } else if (isNewSinceCursor && ageMs >= minFreshMs) {
          shouldBuild = true
        } else if (inRecheckWindow && ageMs >= recheckMinAgeMs) {
          shouldBuild = true
        }

        if (shouldBuild) {
          try {
            const res = await buildEpisode(item.id, item.ep, { media: item.media, fresh: true })
            if (res) {
              built++
              catchupState.caughtUpTotal++
            }
          } catch (err) {
            stats.lastError = `catchup ${item.id}:${item.ep}: ${String(err?.message || err)}`
          }
          if (yieldMs > 0) await new Promise((r) => setTimeout(r, yieldMs))
        }

        // Advance and checkpoint cursor per episode so mid-catchup shutdowns resume losslessly.
        if (item.airingAt > catchupState.lastCatchupAt) {
          catchupState.lastCatchupAt = item.airingAt
          saveCatchupState(catchupState)
        }
      }

      if (discoveryOk && nowSec > catchupState.lastCatchupAt) {
        catchupState.lastCatchupAt = nowSec
      }
      catchupState.lastCatchupRunAt = new Date(nowFn()).toISOString()
      saveCatchupState(catchupState)
      stats.cachedFiles = countDiskFiles()
      if (built) log(`lossless catch-up complete: ${built}/${discovered} episode(s) built (cursor: ${new Date(catchupState.lastCatchupAt * 1000).toISOString()})`)
      return { built, discovered, lastCatchupAt: catchupState.lastCatchupAt }
    } finally {
      catchupRunning = false
      catchupPending = 0
    }
  }

  /** Pre-build currently airing episodes (with lossless offline catch-up) and watched AniList shows. */
  async function prebuildSweep () {
    if (!hasSources) return { built: 0, skipped: 'no SOURCES_URL or FEED_URLS configured' }
    let built = 0
    if (prebuildAiring && catchupEnabled) {
      const cu = await catchupSweep()
      built += Number(cu?.built) || 0
    }
    const targets = new Map()
    const addTarget = (media, ep) => {
      const id = Number(media?.id)
      const n = Number(ep)
      if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(n) || n <= 0) return
      if (!targets.has(`${id}:${n}`)) targets.set(`${id}:${n}`, { id, ep: n, media })
    }

    try {
      if (anilistUser) {
        const data = await queryAniList(ANILIST_USER_LIST_QUERY, { userName: anilistUser }, fetchImpl)
        for (const list of data?.MediaListCollection?.lists || []) {
          for (const entry of list?.entries || []) {
            const m = entry?.media
            if (!m) continue
            const nextEp = (Number(entry.progress) || 0) + 1
            addTarget(m, nextEp)
          }
        }
      }
      if (prebuildAiring) {
        const data = await queryAniList(ANILIST_AIRING_QUERY, { perPage: prebuildLimit }, fetchImpl)
        for (const m of data?.Page?.media || []) {
          const latestAired = m?.nextAiringEpisode?.episode ? Math.max(1, m.nextAiringEpisode.episode - 1) : 1
          addTarget(m, latestAired)
        }
      }
      for (const id of watchIds) {
        const m = await resolveMedia(id).catch(() => null)
        if (!m) continue
        const latestAired = m?.nextAiringEpisode?.episode ? Math.max(1, m.nextAiringEpisode.episode - 1) : 1
        addTarget(m, latestAired)
      }
    } catch (err) {
      stats.lastError = String(err?.message || err)
      log('prebuild discovery error:', stats.lastError)
    }

    for (const t of targets.values()) {
      try {
        // Skip episodes already freshly cached on disk so restarts don't block the event loop unnecessarily.
        const file = rankFilePath(t.id, t.ep)
        const minRefreshMs = Math.max(15, refreshMinutes || 15) * 60_000
        if (fs.existsSync(file)) {
          const ageMs = Date.now() - fs.statSync(file).mtimeMs
          if (ageMs < minRefreshMs) continue
        }
        const res = await buildEpisode(t.id, t.ep, { media: t.media, fresh: true })
        if (res) built++
        await new Promise((r) => setTimeout(r, 200))
      } catch (err) {
        stats.lastError = String(err?.message || err)
      }
    }
    stats.lastPrebuildAt = new Date().toISOString()
    stats.lastPrebuildBuilt = built
    stats.cachedFiles = countDiskFiles()
    if (built) log(`prebuild sweep complete: ${built} episode(s) ready on disk`)
    return { built }
  }

  function sendJson (req, res, status, obj, extraHeaders = {}) {
    const body = typeof obj === 'string' ? obj : JSON.stringify(obj)
    const wantsGz = /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'x-content-type-options': 'nosniff',
      ...extraHeaders
    }
    if (wantsGz && body.length > 512) {
      headers['content-encoding'] = 'gzip'
      res.writeHead(status, headers)
      return res.end(zlib.gzipSync(Buffer.from(body, 'utf8')))
    }
    res.writeHead(status, headers)
    return res.end(body)
  }

  function sendCached (req, res, entry) {
    const wantsGz = /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=60',
      'x-content-type-options': 'nosniff',
      'x-local-cache': entry.cacheSource || 'hit'
    }
    if (wantsGz) {
      headers['content-encoding'] = 'gzip'
      res.writeHead(200, headers)
      return res.end(entry.gz)
    }
    res.writeHead(200, headers)
    return res.end(entry.json)
  }

  async function readBody (req) {
    const chunks = []
    let bytes = 0
    for await (const chunk of req) {
      bytes += chunk.length
      if (bytes > 65536) throw new Error('body too large')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
      const parts = url.pathname.split('/').filter(Boolean)

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type'
        })
        return res.end()
      }

      if (req.method === 'GET' && parts.length === 1 && (parts[0] === 'health.json' || parts[0] === 'healthz')) {
        return sendJson(req, res, 200, {
          ok: true,
          mode: 'local-prebuilder',
          feedConfigured: hasSources,
          sourcesUrl: sourcesUrl || null,
          seedReady: seedStore.ready,
          seedImporting,
          catchup: {
            enabled: catchupEnabled,
            running: catchupRunning,
            pending: catchupPending,
            lastCatchupAt: catchupState.lastCatchupAt ? new Date(catchupState.lastCatchupAt * 1000).toISOString() : null,
            lastCatchupRunAt: catchupState.lastCatchupRunAt,
            caughtUpTotal: catchupState.caughtUpTotal
          },
          ...stats,
          seedEpisodes: seedStore.count
        })
      }

      if (req.method === 'GET' && parts.length === 1 && parts[0] === 'site.json') {
        await refreshManifestTrackers()
        const origin = `http://${req.headers.host || `${host}:${port}`}`
        return sendJson(req, res, 200, {
          brand: { name: siteName, origin },
          features: {
            releases: true,
            listFiles: false,
            rank: true,
            requests: true,
            recent: true,
            stats: false,
            openapi: false,
            rss: false,
            torznab: false,
            mirrors: false,
            seeders: false,
            existence: false,
            nzb: false,
            delays: false,
            syoboi: false
          },
          endpoints: {
            rank: '/rank',
            requests: '/requests',
            latest: '/latest.json',
            health: '/health.json',
            episode: '/anime/anilist/{id}/{ep}.json'
          },
          trackers: effectiveTrackers(),
          copy: {}
        })
      }

      if (req.method === 'GET' && parts.length === 1 && parts[0] === 'latest.json') {
        return sendJson(req, res, 200, { updatedAt: stats.lastPrebuildAt || stats.startedAt, events: recentEvents })
      }

      // Fast pre-built episode read: GET /anime/anilist/{id}/{ep}.rank.json or .json
      if (req.method === 'GET' && parts[0] === 'anime' && parts[1] === 'anilist' && parts.length === 4) {
        const id = Number(parts[2])
        const m = /^(\d+)\.(rank\.json|json)$/.exec(parts[3])
        if (Number.isSafeInteger(id) && id > 0 && m) {
          const ep = Number(m[1])
          const cached = readCached(id, ep)
          if (cached) return sendCached(req, res, cached)
          if (!hasSources) return sendJson(req, res, 404, { error: 'no cached file yet and no sources configured' })
          const built = await buildEpisode(id, ep)
          if (built) return sendCached(req, res, built)
          return sendJson(req, res, 404, { error: 'not found' })
        }
      }

      // On-demand ranked response (serves from cache in <5 ms when pre-built)
      if (req.method === 'POST' && parts.length === 1 && parts[0] === 'rank') {
        const body = await readBody(req)
        const id = Number(body?.anilistId)
        const ep = Number(body?.episode) || 1
        const resolution = String(body?.prefs?.resolution || '1080')
        if (!Number.isSafeInteger(id) || id <= 0) return sendJson(req, res, 400, { error: 'anilistId required' })
        const cached = readCached(id, ep)
        if (cached) return sendCached(req, res, cached)
        if (!hasSources) return sendJson(req, res, 404, { error: 'no sources configured on local server' })
        const built = await buildEpisode(id, ep, { resolution })
        if (built) return sendCached(req, res, built)
        return sendJson(req, res, 404, { error: 'no results' })
      }

      // Queue pre-build ahead of time
      if (req.method === 'POST' && parts.length === 1 && parts[0] === 'requests') {
        const body = await readBody(req)
        const id = Number(body?.anilistId)
        const ep = Number(body?.episode) || 1
        if (!Number.isSafeInteger(id) || id <= 0) return sendJson(req, res, 400, { error: 'anilistId required' })
        const cached = readCached(id, ep)
        if (cached) return sendJson(req, res, 200, { cached: true, episode: JSON.parse(cached.json) })
        enqueue(id, ep)
        return sendJson(req, res, 202, { queued: true, retryAfterSeconds: 5, poll: `/anime/anilist/${id}/${ep}.rank.json`, queue: { position: queue.length, estimatedWaitSeconds: queue.length * 3 } })
      }

      return sendJson(req, res, 404, {
        error: 'not found',
        mode: 'local-prebuilder',
        routes: ['GET /health.json', 'GET /site.json', 'GET /latest.json', 'GET /anime/anilist/{id}/{ep}.rank.json', 'POST /rank', 'POST /requests']
      })
    } catch (err) {
      return sendJson(req, res, 500, { error: String(err?.message || err) })
    }
  })

  return {
    server,
    buildEpisode,
    catchupSweep,
    prebuildSweep,
    readCached,
    writeCached,
    stats,
    async start () {
      await new Promise((resolve) => server.listen(port, host, resolve))
      const addr = server.address()
      const boundPort = typeof addr === 'object' && addr ? addr.port : port
      log(`listening on http://${host}:${boundPort} (cache: ${dataDir}, seed: ${seedStore.count} eps, sources: ${hasSources ? (sourcesUrl || 'FEED_URLS') : 'not set'})`)
      if (sourcesUrl) refreshManifestTrackers().catch(() => {})
      if (seedUrl && !seedStore.ready && !seedImporting) {
        seedImporting = true
        importSeed({ seedUrl, seedMetaUrl, seedDir, fetchImpl, log })
          .then(() => {
            seedStore.reload()
            stats.seedEpisodes = seedStore.count
            log(`seed hot-loaded: ${seedStore.count} episodes ready for millisecond lookups`)
          })
          .catch((err) => {
            stats.lastError = `seed import: ${String(err?.message || err)}`
            log(stats.lastError)
          })
          .finally(() => { seedImporting = false })
      }
      if (refreshMinutes > 0 && hasSources) {
        setTimeout(() => prebuildSweep().catch(() => {}), 30_000).unref()
        prebuildTimer = setInterval(() => prebuildSweep().catch(() => {}), refreshMinutes * 60_000)
        prebuildTimer.unref()
      }
      return { host, port: boundPort }
    },
    async stop () {
      if (prebuildTimer) clearInterval(prebuildTimer)
      seedStore.close()
      await new Promise((resolve) => server.close(resolve))
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createLocalIndexServer()
  app.start().catch((err) => {
    console.error('[local-index] failed to start:', err)
    process.exit(1)
  })
}
