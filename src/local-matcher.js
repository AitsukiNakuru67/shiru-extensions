/**
 * On-device Shiru release matcher & ranker running directly inside the extension Web Worker.
 * Uses Shiru's real `buildModalTargetWith`, `judgeModalResults`, `sortModalResults`, `modalCard`,
 * `cardTerms`, and `sortEngine` — zero server required.
 */
import { DEFAULT_SEASONAL } from '../vendor/matcher/common/modules/seasonal/defaults.js'
import { buildModalTargetWith } from '../vendor/matcher/common/modules/seasonal/grab/modalTarget.js'
import { buildSearchQueries } from '../vendor/matcher/common/modules/seasonal/grab/searchQueries.js'
import { dmhyQueries } from '../vendor/matcher/common/modules/seasonal/grab/dmhyHost.js'
import { cascadeSearch, resetHostBreakers, mergeByHash, tagForeignReleases } from '../vendor/matcher/common/modules/seasonal/grab/cascadeSearch.js'
import { judgeModalResults } from '../vendor/matcher/common/modules/seasonal/grab/modalJudge.js'
import { sortModalResults } from '../vendor/matcher/common/modules/seasonal/grab/modalList.js'
import { releaseCardFacts, releaseCardLabels } from '../vendor/matcher/common/modules/seasonal/grab/modalCard.js'
import { simplifyFilename, sanitiseTerms, orderedTerms } from '../vendor/matcher/common/modules/seasonal/grab/cardTerms.js'
import { formatScoreBreakdown, sortEngineFromSettings } from '../vendor/matcher/common/modules/seasonal/grab/sortEngine.js'
import { displayCardType, viewRowKey, releaseCopyKey, modalPackSpan } from '../vendor/matcher/common/modules/seasonal/grab/modalView.js'
import { possiblyInaccurateBadge, possiblyInaccurateWhy, possiblyInaccurateTone } from '../vendor/matcher/common/modules/seasonal/grab/possiblyInaccurate.js'
import { statedReleaseLanguage, LANGUAGE_LABELS } from '../vendor/matcher/common/modules/anime/releaseLanguage.js'
import { setWorkerViewerSettings } from './shims/seasonalSettings.js'
import { resolveManifestHosts, setCascadeTransportContext } from './cascade-transport.js'
import { fetchAnizipMappings, fetchFeedCandidates } from './feeds.js'

const HEX40 = /^[0-9a-f]{40}$/

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

async function formatRankRow (r, ctx) {
  const hash = String(r.hash || r.infoHash || '').toLowerCase()
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
  const uploaded = r.date instanceof Date && Number.isFinite(r.date.getTime())
    ? r.date.toISOString()
    : (typeof r.pubDate === 'string' && Number.isFinite(Date.parse(r.pubDate)) ? new Date(Date.parse(r.pubDate)).toISOString() : null)

  return {
    key,
    copyKey: releaseCopyKey(r) || null,
    hash: HEX40.test(hash) ? hash : '',
    kind: r.kind === 'nzb' ? 'nzb' : 'torrent',
    title: String(r.title || ''),
    displayName: displayName || String(r.title || ''),
    link: withTrackers(r.link, HEX40.test(hash) ? hash : '', String(r.title || ''), ctx.trackers),
    nzbUrl: String(r.nzbUrl || ''),
    pageUrl: String(r.pageUrl || facts.pageUrl || ''),
    host: String(r.host || ''),
    size: Number(r.size) > 0 ? Number(r.size) : null,
    episodesCovered: modalPackSpan(r, ctx.media),
    seeders: Number.isSafeInteger(r.seeders) ? r.seeders : null,
    downloads: Number.isSafeInteger(r.downloads) ? r.downloads : null,
    uploaded,
    group: String(r.parseObject?.release_group || ''),
    groupName: facts.groupName || '',
    type: r.type ?? null,
    cardType,
    crown: cardType === 'best' ? 'best' : (r.seadexBest ? 'curatedBest' : null),
    ladderSection: r.ladderSection ?? null,
    sectionLabel: facts.sectionLabel || null,
    labels,
    terms,
    packSize: facts.packSize || null,
    seedTier: facts.seedInfo?.tier ?? null,
    showSeeders: !!facts.showSeeders,
    scoreBreakdown,
    seadex: r.seadex === true,
    seadexBest: r.seadexBest === true,
    trusted: r.trusted === true,
    trustedBy: r.trustedBy ?? null,
    remake: r.remake === true,
    rawDisc: r.rawDisc === true,
    possibleReason: r.rejectReason ?? null,
    language: r.fallbackLanguage ? { foreign: true, label: r.languageLabel || 'Other language' } : null,
    adult: r.adult === true
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
  const resolution = String(query?.resolution || DEFAULT_SEASONAL.resolution || '1080')
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
  // Ensure target carries externally supplied AniDB/MAL IDs even when AniZip is disabled or incomplete.
  if (anidbId > 0 && !built.target.anidbAid) built.target.anidbAid = anidbId
  if (anidbEid > 0 && !built.target.anidbEid) built.target.anidbEid = anidbEid
  if (malId > 0 && !built.target.idMal) built.target.idMal = malId

  return { media, episode, resolution, settings, built, orQueries, nativeQueries, anidbId, anidbEid, malId }
}

/**
 * Full-parity live candidate discovery using Shiru's real `cascadeSearch.js`
 * (OR wave, 75-row saturated Nyaa HTML top-seeded escalation, Wave F fansub follow-up,
 * hybrid stems, language `1_0` fallback, parent-stem, sequel-run fallback, SFW↔Sukebei
 * escalation, native-title search, Raw `1_4` fallback, AnimeTosho Torznab/eid/aid/parentAid/title
 * AniDB learning, SeaDex episode file picking + upscale detection, dmhy/Mikan, ameNZB)
 * PLUS keyless Usenet crawlers (`binsearch`, `nzbking`, `nzbindex`) & custom user `feedUrls`.
 */
export async function searchCandidatesWithParity (query, sourcesOrTemplates, {
  useAnizip = true,
  fresh = false,
  enableUsenet = true,
  amenzbKey = '',
  prepared = null
} = {}) {
  const prep = prepared || await prepareMatchTarget(query, { useAnizip, fresh })
  const { hosts, extraSources } = resolveManifestHosts(sourcesOrTemplates)
  const hasCascadeHost = Object.values(hosts).some(Boolean)

  let cascadeItems = []
  let extraItems = []

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
      const out = await cascadeSearch(prep.built.target, cascadeSettings, {
        modal: true,
        hostTimeoutMs: 15000,
        ledger: { nativeTitleSearch: true }
      })
      cascadeItems = Array.isArray(out?.items) ? out.items : []
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
    })())
  }

  await Promise.all(jobs)

  const merged = tagForeignReleases(mergeByHash(cascadeItems, extraItems), { target: prep.built.target })
  return { prepared: prep, candidates: merged }
}

/**
 * Full-parity search + local judge + local rank pipeline (used by both the extension worker and local-index).
 */
export async function searchAndMatchLocally (query, sourcesOrTemplates, {
  useAnizip = true,
  fresh = false,
  trackers = [],
  enableUsenet = true,
  amenzbKey = ''
} = {}) {
  const { prepared, candidates } = await searchCandidatesWithParity(query, sourcesOrTemplates, {
    useAnizip,
    fresh,
    enableUsenet,
    amenzbKey
  })
  return matchCandidatesLocally(query, candidates, {
    useAnizip,
    fresh,
    trackers,
    usenetOn: enableUsenet === true,
    prepared
  })
}

/**
 * Run Shiru's full on-device matcher, verifier, and ranker over raw candidate items and return a `RankResponse`.
 *
 * @param {any} query Shiru `TorrentQuery`
 * @param {any[]} candidates Parsed candidate items from `feeds.js`
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

  const sorted = sortModalResults(
    judged,
    'best',
    true,
    resolution,
    media,
    null,
    settings,
    built.target,
    { groups: {}, seederChecks: {}, now: Date.now() }
  )

  const engine = sortEngineFromSettings(settings)
  const ctx = {
    media,
    episode,
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
  const unseeded = await mapList(sorted.deadResults)
  const raw = Array.from(formattedByKey.values())

  const autoplayRow = recommended.find((r) => r.kind !== 'nzb' && (r.seeders == null || r.seeders > 0)) || recommended[0] || null

  return {
    sections: {
      recommended,
      unconfirmed: [],
      usenet,
      private: [],
      foreign,
      possible,
      unseeded,
      raw
    },
    autoplay: autoplayRow?.key || null,
    hiddenRevisions: Number(sorted.hiddenRevisions) || 0,
    resolution: sorted.resolution || { relaxed: false, matched: recommended.length, wanted: resolution }
  }
}
