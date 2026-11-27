/**
 * On-device Shiru release matcher & ranker running directly inside the extension Web Worker.
 * Uses Shiru's real `buildModalTargetWith`, `cascadeSearch`, `judgeModalResults`, `parseSourceResults`,
 * `sortModalResults`, `modalCard`, `cardTerms`, and `sortEngine` — full parity with `anime-release-index`.
 */
import { DEFAULT_SEASONAL } from '../vendor/matcher/common/modules/seasonal/defaults.js'
import { buildModalTargetWith } from '../vendor/matcher/common/modules/seasonal/grab/modalTarget.js'
import { buildSearchQueries } from '../vendor/matcher/common/modules/seasonal/grab/searchQueries.js'
import { dmhyQueries } from '../vendor/matcher/common/modules/seasonal/grab/dmhyHost.js'
import { cascadeSearch, resetHostBreakers, mergeByHash, tagForeignReleases } from '../vendor/matcher/common/modules/seasonal/grab/cascadeSearch.js'
import { judgeModalResults } from '../vendor/matcher/common/modules/seasonal/grab/modalJudge.js'
import { sortModalResults, parseSourceResults } from '../vendor/matcher/common/modules/seasonal/grab/modalList.js'
import { releaseCardFacts, releaseCardLabels } from '../vendor/matcher/common/modules/seasonal/grab/modalCard.js'
import { simplifyFilename, sanitiseTerms, orderedTerms } from '../vendor/matcher/common/modules/seasonal/grab/cardTerms.js'
import { formatScoreBreakdown, sortEngineFromSettings } from '../vendor/matcher/common/modules/seasonal/grab/sortEngine.js'
import { displayCardType, viewRowKey, releaseCopyKey, modalPackSpan, releaseHostLabel } from '../vendor/matcher/common/modules/seasonal/grab/modalView.js'
import { possiblyInaccurateBadge, possiblyInaccurateWhy, possiblyInaccurateTone, STALE_REASON } from '../vendor/matcher/common/modules/seasonal/grab/possiblyInaccurate.js'
import { statedReleaseLanguage, LANGUAGE_LABELS } from '../vendor/matcher/common/modules/anime/releaseLanguage.js'
import { groupCategory } from '../vendor/matcher/common/modules/seasonal/grab/knownGroup.js'
import { isDubOnlyRelease } from '../vendor/matcher/common/modules/seasonal/grab/viewingFactors.js'
import { aliveRank } from '../vendor/matcher/common/modules/seasonal/grab/rankCandidates.js'
import { setWorkerViewerSettings } from './shims/seasonalSettings.js'
import {
  resolveManifestHosts,
  setCascadeTransportContext,
  addCascadeItemsListener,
  removeCascadeItemsListener
} from './cascade-transport.js'
import { fetchAnizipMappings, fetchFeedCandidates } from './feeds.js'

const HEX40 = /^[0-9a-f]{40}$/
const RANGE_RX = /(?<![0-9])(\d{1,4})\s*(?:~|-|–|to)\s*(\d{1,4})(?![0-9])/gi
const LONG_WORK_EPISODES = 100
const CANDIDATE_CACHE_TTL_MS = 2 * 60_000
const candidateCache = new Map()

function trustedByOf (row) {
  if (row?.trustedBy) return row.trustedBy
  if (!row?.trusted) return null
  return row.seadex ? 'seadex' : 'tracker'
}

function isAdultRow (r) {
  return String(r?.host || '').toLowerCase() === 'sukebei' ||
    /sukebei\.nyaa\.si/i.test(String(r?.link || r?.nyaaUrl || r?.guid || ''))
}

function statedRangeHolds (row, episode) {
  const ep = Number(episode)
  if (!Number.isFinite(ep)) return false
  const parsed = row?.parseObject?.episode_number
  if (Array.isArray(parsed) && parsed.length === 2) {
    const [lo, hi] = parsed.map(Number)
    if (Number.isFinite(lo) && Number.isFinite(hi) && lo < hi) return lo <= ep && ep <= hi
  }
  for (const m of String(row?.title || '').matchAll(RANGE_RX)) {
    const lo = Number(m[1])
    const hi = Number(m[2])
    if (lo < hi && hi - lo < 2000 && lo <= ep && ep <= hi) return true
  }
  return false
}

function unprovenPack (row, span, episode, workEpisodes) {
  if (!(Number(span) > 1) && !(row?.batch && row?.episodesCovered == null)) return false
  const n = Number(workEpisodes)
  if (Number.isFinite(n) && n > 0 && n <= LONG_WORK_EPISODES) return false
  if (row?.proof) return false
  if (episode != null && statedRangeHolds(row, episode)) return false
  return true
}

function placeCrowns (results, isUnproven, isAlive) {
  const crowns = new Map()
  const list = Array.isArray(results) ? results : []
  const head = list.filter((r) => !isUnproven(r))
  const best = (r) => r?.type === 'best'
  for (const [crown, want] of [['lastUsed', (r) => r?.ladderSection === 'recent'], ['curatedBest', (r) => r?.seadex && r?.seadexBest], ['best', best]]) {
    const at = head.findIndex(want)
    if (at >= 0) crowns.set(head.splice(at, 1)[0], crown)
  }
  if (![...crowns.values()].includes('best') && list.some((r) => best(r) && isUnproven(r))) {
    const at = head.findIndex((r) => isAlive(r))
    if (at >= 0) crowns.set(head.splice(at, 1)[0], 'best')
  }
  return crowns
}

function toMediaObject (query) {
  if (query?.media && typeof query.media === 'object') return query.media
  const titles = Array.isArray(query?.titles) ? query.titles : []
  return {
    id: Number(query?.anilistId) || 0,
    idMal: Number(query?.mappingsA?.mal_id) || null,
    episodes: Number(query?.episodeCount) || null,
    format: 'TV',
    status: 'RELEASING',
    title: {
      romaji: titles[0] || '',
      english: titles[1] || titles[0] || '',
      native: '',
      userPreferred: titles[0] || ''
    },
    synonyms: titles.slice(2),
    relations: { edges: [] }
  }
}

function withTrackers (link, hash, title, trackers = []) {
  const base = String(link || (HEX40.test(hash) ? `magnet:?xt=urn:btih:${hash}${title ? `&dn=${encodeURIComponent(title)}` : ''}` : ''))
  if (!base || !base.startsWith('magnet:') || !Array.isArray(trackers) || !trackers.length) return base
  let out = base
  for (const t of trackers) {
    const enc = encodeURIComponent(t)
    if (!out.includes(enc) && !out.includes(t)) out += `&tr=${enc}`
  }
  return out
}

function emitProgress (cb, progress, stage, found) {
  if (typeof cb !== 'function') return
  try {
    const p = Math.max(0, Math.min(1, Number(progress) || 0))
    cb({
      progress: p,
      stage: String(stage || ''),
      ...(Number.isSafeInteger(found) && found >= 0 ? { found } : {})
    })
  } catch {}
}

function emitPartial (cb, payload) {
  if (typeof cb !== 'function' || !payload || typeof payload !== 'object') return
  try {
    cb(payload)
  } catch {}
}

/**
 * Format one judged + parsed modal row into the exact `Row` shape `anime-release-index/src/live/pipeline.mjs`
 * serves and `TorrentCard.svelte` / `rankedModal.js` render.
 */
async function formatRankRow (r, ctx) {
  const hash = String(r.hash || r.infoHash || '').toLowerCase()
  const validHash = HEX40.test(hash) ? hash : ''
  const key = viewRowKey(r)
  const cardType = displayCardType(r)
  const reason = r.possibleMatch
    ? {
        badge: possiblyInaccurateBadge(r.rejectReason),
        why: possiblyInaccurateWhy(r.rejectReason, r.uncertainties, r),
        cls: possiblyInaccurateTone(r.rejectReason)
      }
    : null
  const facts = releaseCardFacts(r, { media: ctx.media, episode: ctx.episode, type: cardType, preferredHit: false })
  const rawGroup = r.parseObject?.release_group && r.parseObject.release_group !== 'No Group' ? r.parseObject.release_group : ''
  const group = facts.groupName || rawGroup || ''
  const parse = r.parseObject ? { ...r.parseObject, file_name: r.parseObject.file_name ?? r.title ?? '' } : null
  const search = { media: ctx.media, episode: ctx.episode, isDubMedia: () => false }
  const displayName = parse ? await simplifyFilename(search, parse) : (r.title || '')
  const sanitised = parse ? await sanitiseTerms(search, parse) : []
  const terms = parse ? orderedTerms(sanitised, { drop: facts.dropTerm }) : []
  const labels = releaseCardLabels(r, facts, { type: cardType, reason, preferredHit: false })
  const scoreBreakdown = formatScoreBreakdown(
    { ...r, episodesCovered: modalPackSpan(r, ctx.media) },
    { sortEngine: ctx.engine, settings: ctx.scoreSettings }
  )
  const uploaded = !r.undated && r.date instanceof Date && Number.isFinite(r.date.getTime())
    ? r.date.toISOString()
    : (!r.undated && typeof r.pubDate === 'string' && Number.isFinite(Date.parse(r.pubDate)) ? new Date(Date.parse(r.pubDate)).toISOString() : null)

  return {
    key,
    copyKey: releaseCopyKey(r) || null,
    hash: validHash,
    kind: r.kind === 'nzb' ? 'nzb' : 'torrent',
    title: String(r.title || ''),
    displayName: displayName || String(r.title || ''),
    link: r.kind === 'nzb'
      ? String(r.nzbUrl || r.link || '')
      : withTrackers(r.link, validHash, String(r.title || ''), ctx.trackers),
    nzbUrl: String(r.nzbUrl || ''),
    pageUrl: String(r.pageUrl || facts.pageUrl || ''),
    toshoUrl: r.toshoUrl || null,
    host: String(r.host || ''),
    hostLabel: releaseHostLabel(r) || null,
    size: Number(r.size) > 0 ? Number(r.size) : null,
    sizeIsPerFile: !!r.sizeIsPerFile,
    episodesCovered: modalPackSpan(r, ctx.media),
    seeders: Number.isSafeInteger(r.seeders) ? r.seeders : null,
    seedersAt: r.seedersAt || null,
    downloads: Number.isSafeInteger(r.downloads) ? r.downloads : null,
    uploaded,
    group: group || null,
    groupName: facts.groupName || null,
    groupCategory: groupCategory(group),
    type: r.type ?? null,
    cardType,
    crown: ctx.crowns?.get(r) ?? (cardType === 'best' ? 'best' : (r.seadexBest ? 'curatedBest' : null)),
    ladderSection: r.ladderSection ?? null,
    ladderRole: r.ladderRole ?? null,
    sectionLabel: facts.sectionLabel || null,
    labels,
    terms,
    packSize: facts.packSize ?? null,
    seedTier: facts.seedInfo?.tier ?? null,
    showSeeders: !!facts.showSeeders,
    scoreBreakdown,
    seadex: r.seadex === true,
    seadexBest: r.seadexBest === true,
    trusted: r.trusted === true,
    trustedBy: trustedByOf(r),
    fansub: !!facts.isFansub,
    remake: r.remake === true,
    rawDisc: r.rawDisc === true,
    superseded: r.superseded === true,
    dub: isDubOnlyRelease(r.title),
    possibleReason: r.possibleMatch ? (r.rejectReason || null) : null,
    possible: reason,
    stale: !!(r.possibleMatch && r.rejectReason === STALE_REASON),
    lastSeenAt: r.lastSeenAt || null,
    staleReason: r.possibleMatch && r.rejectReason === STALE_REASON ? (r.staleReason || null) : null,
    proof: r.proof || null,
    verifiedUnmeasured: !!r.verifiedUnmeasured,
    usenetUnconfigured: !!r.usenetUnconfigured,
    language: { foreign: !!r.fallbackLanguage, label: r.languageLabel || null },
    adult: isAdultRow(r) || r.adult === true
  }
}

/**
 * Build Shiru's full match target (AniZip mappings, catalog aliases, season/running-number hints)
 * AND Shiru's real OR search query ladder (`buildSearchQueries` + `dmhyQueries`) BEFORE fetching feeds.
 *
 * @param {any} query Shiru `TorrentQuery`
 * @param {{ useAnizip?: boolean, fresh?: boolean }} [opts]
 */
export async function prepareMatchTarget (query, { useAnizip = true, fresh = false } = {}) {
  const media = toMediaObject(query)
  const episode = Number(query?.episode) || 1
  const resolution = query?.resolution === '' ? '' : String(query?.resolution || DEFAULT_SEASONAL.resolution || '1080')
  const settings = { ...structuredClone(DEFAULT_SEASONAL), resolution }

  let resolvedMappings = null
  const aniMappings = async (id) => {
    if (Number(id) === Number(media.id) && query?.mappingsA && Object.keys(query.mappingsA).length && query?.mappingsE && Object.keys(query.mappingsE).length) {
      resolvedMappings = { mappings: query.mappingsA, episodes: { [episode]: query.mappingsE } }
      return resolvedMappings
    }
    const fetched = await fetchAnizipMappings(Number(id), { enabled: useAnizip, fresh })
    if (fetched) {
      if (Number(id) === Number(media.id)) resolvedMappings = fetched
      return fetched
    }
    if (Number(id) === Number(media.id) && query?.mappingsA) {
      resolvedMappings = { mappings: query.mappingsA, episodes: query.mappingsE ? { [episode]: query.mappingsE } : {} }
      return resolvedMappings
    }
    return null
  }

  const built = await buildModalTargetWith(
    media,
    episode,
    { season: query?.season, absoluteEpisode: query?.absoluteEpisode, resolution },
    {
      settings,
      aniMappings,
      listLedger: async (fallback) => ({ media: fallback, aliasOwnership: null }),
      displayTitle: media?.title?.userPreferred || media?.title?.romaji || media?.title?.english || ''
    }
  )

  let orQueries = []
  try {
    const specs = buildSearchQueries(built.target, settings, { modal: true, wave: 'all', includeHybrid: true }) || []
    const seen = new Set()
    for (const s of specs) {
      const q = String(s?.q || '').trim()
      if (q && !seen.has(q)) {
        seen.add(q)
        orQueries.push(q)
      }
    }
  } catch {}

  let nativeQueries = []
  try {
    nativeQueries = dmhyQueries(built.target) || []
  } catch {}

  const epMap = resolvedMappings?.episodes?.[String(episode)] || resolvedMappings?.episodes?.[episode] || query?.mappingsE
  const anidbId = Number(built.target?.anidbAid || resolvedMappings?.mappings?.anidb_id || query?.anidbAid || query?.mappingsA?.anidb_id || 0)
  const anidbEid = Number(built.target?.anidbEid || epMap?.anidbEid || query?.anidbEid || 0)
  const malId = Number(media?.idMal || resolvedMappings?.mappings?.mal_id || query?.mappingsA?.mal_id || 0)
  if (anidbId > 0 && !built.target.anidbAid) built.target.anidbAid = anidbId
  if (anidbEid > 0 && !built.target.anidbEid) built.target.anidbEid = anidbEid
  if (malId > 0 && !built.target.idMal) built.target.idMal = malId

  return { media, episode, resolution, settings, built, orQueries, nativeQueries, anidbId, anidbEid, malId }
}

/**
 * Full-parity live candidate discovery using Shiru's real `cascadeSearch.js`
 * PLUS keyless Usenet crawlers (`binsearch`, `nzbking`, `nzbindex`) & custom user `feedUrls`.
 * Emits approximate progress (`onProgress`) and streaming candidate snapshots (`onCandidates`)
 * as fast hosts (SeaDex, AnimeTosho) land ahead of slower Nyaa/Usenet waves.
 */
export async function searchCandidatesWithParity (query, sourcesOrTemplates, {
  useAnizip = true,
  fresh = false,
  enableUsenet = true,
  amenzbKey = '',
  prepared = null,
  onProgress = null,
  onCandidates = null
} = {}) {
  emitProgress(onProgress, 0.08, 'Preparing episode info…')
  const prep = prepared || await prepareMatchTarget(query, { useAnizip, fresh })
  const { hosts, extraSources } = resolveManifestHosts(sourcesOrTemplates)
  const hasCascadeHost = Object.values(hosts).some(Boolean)

  const cacheKey = `${prep.media.id || 0}:${prep.episode}:${enableUsenet ? 1 : 0}:${amenzbKey ? 1 : 0}:${(sourcesOrTemplates || []).length}`
  if (!fresh) {
    const hit = candidateCache.get(cacheKey)
    if (hit && Date.now() - hit.at < CANDIDATE_CACHE_TTL_MS) {
      emitProgress(onProgress, 0.9, 'Ranking releases…', hit.candidates.length)
      return { prepared: prep, candidates: hit.candidates }
    }
  }

  let cascadeItems = []
  let extraItems = []
  let streamedCascadeItems = []
  let transportHits = 0
  let lastStreamEmitAt = 0
  let streamEmitTimer = null
  let progressVal = 0.18
  const bumpProgress = (next, stage, found) => {
    progressVal = Math.max(progressVal, Math.min(0.95, next))
    emitProgress(onProgress, progressVal, stage, found)
  }

  bumpProgress(0.18, hasCascadeHost ? 'Searching fast sources…' : 'Searching feeds…')

  const notifySnapshot = async (stage, nextProgress) => {
    const mergedSoFar = tagForeignReleases(
      mergeByHash(cascadeItems.length ? cascadeItems : streamedCascadeItems, extraItems),
      { target: prep.built.target }
    )
    bumpProgress(nextProgress, stage, mergedSoFar.length)
    if (typeof onCandidates === 'function' && mergedSoFar.length) {
      lastStreamEmitAt = Date.now()
      try { await onCandidates(mergedSoFar, prep) } catch {}
    }
  }

  const scheduleTransportStream = (host, incoming) => {
    streamedCascadeItems = mergeByHash(streamedCascadeItems, incoming)
    transportHits++
    const hostLabel = host === 'animetosho' ? 'AnimeTosho' : host === 'nyaa' ? 'Nyaa' : host === 'sukebei' ? 'Sukebei' : 'sources'
    const approx = Math.min(0.84, 0.24 + transportHits * 0.08)
    bumpProgress(approx, `Checking ${hostLabel}…`, streamedCascadeItems.length + extraItems.length)
    if (typeof onCandidates !== 'function') return
    const elapsed = Date.now() - lastStreamEmitAt
    if (elapsed >= 700) {
      if (streamEmitTimer) { clearTimeout(streamEmitTimer); streamEmitTimer = null }
      notifySnapshot(`Checking ${hostLabel}…`, approx).catch(() => {})
    } else if (!streamEmitTimer) {
      streamEmitTimer = setTimeout(() => {
        streamEmitTimer = null
        notifySnapshot('Searching remaining sources…', progressVal).catch(() => {})
      }, 700 - elapsed)
      streamEmitTimer.unref?.()
    }
  }

  // Approximate progress heartbeat while slow Nyaa/Usenet queries are in flight so the bar feels alive.
  let heartbeat = null
  if (typeof onProgress === 'function') {
    const startedAt = Date.now()
    heartbeat = setInterval(() => {
      const elapsed = Date.now() - startedAt
      // Asymptotically approach 0.88 over ~10s while waiting on slow hosts
      const est = Math.min(0.88, 0.18 + 0.70 * (1 - Math.exp(-elapsed / 4500)))
      if (est > progressVal + 0.02) {
        progressVal = est
        emitProgress(
          onProgress,
          progressVal,
          streamedCascadeItems.length || extraItems.length
            ? 'Searching remaining sources…'
            : 'Searching sources…',
          Math.max(cascadeItems.length, streamedCascadeItems.length) + extraItems.length
        )
      }
    }, 550)
    heartbeat.unref?.()
  }

  const jobs = []
  if (hasCascadeHost) {
    jobs.push((async () => {
      if (fresh) resetHostBreakers()
      const cleanKey = String(amenzbKey || '').trim()
      const cascadeSettings = {
        ...prep.settings,
        usenet: {
          ...DEFAULT_SEASONAL.usenet,
          enabled: enableUsenet === true,
          amenzbApiKey: cleanKey
        }
      }
      setWorkerViewerSettings({
        adult: 'hentai',
        seasonal: cascadeSettings
      })
      setCascadeTransportContext({
        fresh,
        enableUsenet: enableUsenet === true,
        amenzbKey: cleanKey,
        hosts
      })
      const useTransportStream = typeof onCandidates === 'function' || typeof onProgress === 'function'
      if (useTransportStream) addCascadeItemsListener(scheduleTransportStream)
      let out
      try {
        out = await cascadeSearch(prep.built.target, cascadeSettings, {
          modal: true,
          hostTimeoutMs: 15000,
          ledger: { nativeTitleSearch: true },
          onPhase: async (phaseEvt) => {
            const phaseItems = Array.isArray(phaseEvt?.items) ? phaseEvt.items : []
            if (phaseItems.length) streamedCascadeItems = mergeByHash(streamedCascadeItems, phaseItems)
            await notifySnapshot('Searching more sources…', 0.45)
          }
        })
      } finally {
        if (useTransportStream) removeCascadeItemsListener(scheduleTransportStream)
      }
      cascadeItems = Array.isArray(out?.items) ? out.items : []
      await notifySnapshot(extraSources.length ? 'Finishing extra sources…' : 'Ranking releases…', extraSources.length ? 0.86 : 0.9)
    })())
  }

  if (extraSources.length) {
    jobs.push((async () => {
      extraItems = await fetchFeedCandidates(extraSources, query, {
        fresh,
        useAnizip,
        enableUsenet,
        amenzbKey,
        orQueries: prep.orQueries,
        nativeQueries: prep.nativeQueries,
        anidbId: prep.anidbId,
        anidbEid: prep.anidbEid,
        malId: prep.malId
      })
      await notifySnapshot(hasCascadeHost ? 'Searching more sources…' : 'Ranking releases…', hasCascadeHost ? 0.34 : 0.9)
    })())
  }

  try {
    await Promise.all(jobs)
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    if (streamEmitTimer) clearTimeout(streamEmitTimer)
  }

  const merged = tagForeignReleases(mergeByHash(cascadeItems, extraItems), { target: prep.built.target })
  candidateCache.set(cacheKey, { candidates: merged, at: Date.now() })
  if (candidateCache.size > 40) candidateCache.delete(candidateCache.keys().next().value)
  return { prepared: prep, candidates: merged }
}

/**
 * Full-parity search + local judge + local rank pipeline (used by both the extension worker and local-index).
 * Supports streaming partial ranked results (`onPartial`) and approximate progress (`onProgress`).
 */
export async function searchAndMatchLocally (query, sourcesOrTemplates, {
  useAnizip = true,
  fresh = false,
  trackers = [],
  enableUsenet = true,
  amenzbKey = '',
  onProgress = null,
  onPartial = null
} = {}) {
  let partialRunning = false
  let pendingPartial = null
  let lastEmittedCount = -1

  const flushPartial = async (items, prep) => {
    if (typeof onPartial !== 'function' || !items?.length) return
    if (items.length === lastEmittedCount) return
    if (partialRunning) {
      pendingPartial = { items, prep }
      return
    }
    partialRunning = true
    try {
      lastEmittedCount = items.length
      const ranked = await matchCandidatesLocally(query, items, {
        useAnizip,
        fresh,
        trackers,
        usenetOn: enableUsenet === true,
        prepared: prep
      })
      if (ranked?.sections?.recommended?.length) {
        emitPartial(onPartial, ranked)
      }
    } catch {
      // Partial emission is best-effort; final pass still runs cleanly.
    } finally {
      partialRunning = false
      if (pendingPartial) {
        const next = pendingPartial
        pendingPartial = null
        await flushPartial(next.items, next.prep)
      }
    }
  }

  const { prepared, candidates } = await searchCandidatesWithParity(query, sourcesOrTemplates, {
    useAnizip,
    fresh,
    enableUsenet,
    amenzbKey,
    onProgress,
    onCandidates: typeof onPartial === 'function' ? flushPartial : null
  })

  emitProgress(onProgress, 0.94, 'Ranking releases…', candidates.length)
  const finalResult = await matchCandidatesLocally(query, candidates, {
    useAnizip,
    fresh,
    trackers,
    usenetOn: enableUsenet === true,
    prepared
  })
  emitProgress(onProgress, 1, 'Done', finalResult?.sections?.raw?.length || 0)
  return finalResult
}

/**
 * Run Shiru's full on-device matcher, verifier, and ranker over raw candidate items and return a `RankResponse`.
 * Matches `anime-release-index/src/live/pipeline.mjs` (judgeModalResults -> parseSourceResults -> sortModalResults -> placeCrowns -> wireRow).
 *
 * @param {any} query Shiru `TorrentQuery`
 * @param {any[]} candidates Parsed candidate items from `cascadeSearch` / `feeds.js`
 * @param {{ useAnizip?: boolean, fresh?: boolean, trackers?: string[], usenetOn?: boolean, prepared?: any }} [opts]
 */
export async function matchCandidatesLocally (query, candidates, { useAnizip = true, fresh = false, trackers = [], usenetOn = true, prepared = null } = {}) {
  const prep = prepared || await prepareMatchTarget(query, { useAnizip, fresh })
  const { media, episode, resolution, settings, built } = prep

  const annotated = (candidates || []).map((item) => {
    if (!item || item.fallbackLanguage) return item
    const code = statedReleaseLanguage(item.title, { category: item.category })
    if (!code) return item
    return { ...item, fallbackLanguage: true, languageLabel: LANGUAGE_LABELS[code] || LANGUAGE_LABELS.other }
  })

  const judged = await judgeModalResults(annotated, built.target, settings, {
    usenetOn: usenetOn === true,
    logContext: { mediaId: media.id, episode }
  })

  // Preserve AnimeTosho indexer metadata (releaseGroup / videoResolution) that `applyIndexerMetadata` wrote onto `parsed.raw`.
  const indexerOverrides = new WeakMap()
  for (const r of judged) {
    const raw = r?.parseObject?.raw
    if (raw && (raw.release_group || raw.video_resolution)) {
      indexerOverrides.set(r, {
        release_group: raw.release_group || '',
        video_resolution: raw.video_resolution || ''
      })
    }
  }

  // Exact parity with `anime-release-index/src/live/pipeline.mjs:1945`:
  // `judgeModalResults` attaches `{ animeTitle, releaseGroup, ..., raw }` on `r.parseObject`;
  // `parseSourceResults` replaces it with the flat AnitomyResult (`release_group`, `video_resolution`, `video_term`, `audio_term`, `file_name`)
  // and applies unbracketed group inference (VARYG, NanDesuKa) before `sortModalResults` and card formatting.
  const rows = await parseSourceResults(judged)
  for (const r of rows) {
    const ov = indexerOverrides.get(r)
    if (ov && r.parseObject) {
      if (ov.release_group && !r.parseObject.release_group) r.parseObject.release_group = ov.release_group
      if (ov.video_resolution && !r.parseObject.video_resolution) r.parseObject.video_resolution = ov.video_resolution
    }
  }

  const sorted = sortModalResults(
    rows,
    '',
    settings.trustedFirst !== false,
    resolution,
    media,
    null,
    settings,
    built.target,
    { groups: {}, seederChecks: {}, now: Date.now() }
  )

  const workEpisodes = Number(media?.episodes) || null
  const isUnproven = (r) => unprovenPack(r, modalPackSpan(r, media), episode, workEpisodes)
  const crowns = placeCrowns(sorted.results, isUnproven, (r) => aliveRank(r) > 0)

  const engine = sortEngineFromSettings(settings)
  const ctx = {
    media,
    episode,
    crowns,
    engine,
    trackers,
    scoreSettings: { ...settings, resolution, dualAudioBonus: true, healthOverSize: true }
  }

  const formattedByKey = new Map()
  const mapList = async (arr) => {
    const out = []
    for (const r of arr || []) {
      const k = viewRowKey(r)
      if (formattedByKey.has(k)) {
        out.push(formattedByKey.get(k))
      } else {
        const row = await formatRankRow(r, ctx)
        formattedByKey.set(k, row)
        out.push(row)
      }
    }
    return out
  }

  const recommended = await mapList([...(sorted.results || []), ...(sorted.unmeasuredResults || [])])
  const usenet = await mapList(sorted.usenetResults)
  const foreign = await mapList(sorted.foreignResults)
  const possible = await mapList(sorted.possibleResults)
  const unconfirmed = await mapList(sorted.unconfirmedResults)
  const unseeded = await mapList(sorted.deadResults)

  const seenKeys = new Set()
  const raw = [...recommended, ...usenet, ...foreign, ...possible, ...unconfirmed, ...unseeded]
    .filter((r) => r.key && !seenKeys.has(r.key) && seenKeys.add(r.key))

  const autoplayCandidates = (sorted.results || []).filter((r) => !isUnproven(r) && r.kind !== 'nzb' && aliveRank(r) > 0)
  const autoplayHit = autoplayCandidates.find((r) => r.type === 'best' || r.type === 'alt') || autoplayCandidates[0] || null
  const autoplay = autoplayHit ? viewRowKey(autoplayHit) : (recommended.find((r) => r.kind !== 'nzb' && (r.seeders == null || r.seeders > 0))?.key || recommended[0]?.key || null)

  return {
    sections: {
      recommended,
      unconfirmed,
      usenet,
      private: [],
      foreign,
      possible,
      unseeded,
      raw
    },
    autoplay,
    hiddenRevisions: Number(sorted.hiddenRevisions) || 0,
    resolution: sorted.resolution || { relaxed: false, matched: recommended.length, wanted: resolution }
  }
}

/**
 * Enrich an already-verified seeded `RankResponse` (from `seed-store.mjs`) using the exact same
 * `parseSourceResults`, `releaseCardFacts`, `releaseCardLabels`, `simplifyFilename`, `sanitiseTerms`,
 * and `orderedTerms` card pipeline so seeded episodes render identically to live/server episodes.
 */
export async function formatSeededRankPayload (payload, { media = null, episode = 1, trackers = [] } = {}) {
  if (!payload?.sections) return payload
  const effectiveMedia = media || {
    id: Number(payload.anilistId) || 0,
    episodes: null,
    format: 'TV',
    title: { romaji: '', english: '', native: '', userPreferred: '' }
  }
  const settings = structuredClone(DEFAULT_SEASONAL)
  const engine = sortEngineFromSettings(settings)
  const ctx = {
    media: effectiveMedia,
    episode: Number(episode) || 1,
    crowns: new Map(),
    engine,
    trackers,
    scoreSettings: { ...settings, resolution: '1080', dualAudioBonus: true, healthOverSize: true }
  }

  const enrichSection = async (rows) => {
    if (!Array.isArray(rows) || !rows.length) return []
    const prepared = rows.map((r) => ({
      ...r,
      date: r.uploaded ? new Date(r.uploaded) : null,
      undated: !r.uploaded,
      infoHash: r.hash || ''
    }))
    const parsed = await parseSourceResults(prepared)
    for (const r of parsed) {
      if (r.group && r.parseObject && !r.parseObject.release_group) {
        r.parseObject.release_group = r.group
      }
      if (r.crown) ctx.crowns.set(r, r.crown)
    }
    return Promise.all(parsed.map((r) => formatRankRow(r, ctx)))
  }

  const recommended = await enrichSection(payload.sections.recommended)
  const usenet = await enrichSection(payload.sections.usenet)
  const unseeded = await enrichSection(payload.sections.unseeded)
  const foreign = await enrichSection(payload.sections.foreign)
  const possible = await enrichSection(payload.sections.possible)
  const unconfirmed = await enrichSection(payload.sections.unconfirmed)
  const seenKeys = new Set()
  const raw = [...recommended, ...usenet, ...foreign, ...possible, ...unconfirmed, ...unseeded]
    .filter((r) => r.key && !seenKeys.has(r.key) && seenKeys.add(r.key))

  return {
    ...payload,
    sections: {
      recommended,
      unconfirmed,
      usenet,
      private: payload.sections.private || [],
      foreign,
      possible,
      unseeded,
      raw
    },
    autoplay: payload.autoplay || recommended[0]?.key || null
  }
}
