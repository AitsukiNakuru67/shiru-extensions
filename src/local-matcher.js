/**
 * On-device Shiru release matcher & ranker running directly inside the extension Web Worker.
 * Uses Shiru's real `buildModalTargetWith`, `judgeModalResults`, `sortModalResults`, `modalCard`,
 * `cardTerms`, and `sortEngine` — zero server required.
 */
import { DEFAULT_SEASONAL } from '../vendor/matcher/common/modules/seasonal/defaults.js'
import { buildModalTargetWith } from '../vendor/matcher/common/modules/seasonal/grab/modalTarget.js'
import { judgeModalResults } from '../vendor/matcher/common/modules/seasonal/grab/modalJudge.js'
import { sortModalResults } from '../vendor/matcher/common/modules/seasonal/grab/modalList.js'
import { releaseCardFacts, releaseCardLabels } from '../vendor/matcher/common/modules/seasonal/grab/modalCard.js'
import { simplifyFilename, sanitiseTerms, orderedTerms } from '../vendor/matcher/common/modules/seasonal/grab/cardTerms.js'
import { formatScoreBreakdown, sortEngineFromSettings } from '../vendor/matcher/common/modules/seasonal/grab/sortEngine.js'
import { displayCardType, viewRowKey, releaseCopyKey, modalPackSpan } from '../vendor/matcher/common/modules/seasonal/grab/modalView.js'
import { possiblyInaccurateBadge, possiblyInaccurateWhy, possiblyInaccurateTone } from '../vendor/matcher/common/modules/seasonal/grab/possiblyInaccurate.js'
import { statedReleaseLanguage, LANGUAGE_LABELS } from '../vendor/matcher/common/modules/anime/releaseLanguage.js'
import { fetchAnizipMappings } from './feeds.js'

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
 * Run Shiru's full on-device matcher, verifier, and ranker over raw candidate items and return a `RankResponse`.
 *
 * @param {any} query Shiru `TorrentQuery`
 * @param {any[]} candidates Parsed candidate items from `feeds.js`
 * @param {{ useAnizip?: boolean, fresh?: boolean, trackers?: string[] }} [opts]
 */
export async function matchCandidatesLocally (query, candidates, { useAnizip = true, fresh = false, trackers = [] } = {}) {
  const media = toMediaObject(query)
  const episode = Number(query?.episode) || 1
  const resolution = String(query?.resolution || DEFAULT_SEASONAL.resolution || '1080')
  const settings = { ...structuredClone(DEFAULT_SEASONAL), resolution }

  const aniMappings = async (id) => {
    if (Number(id) === Number(media.id) && query?.mappingsA && Object.keys(query.mappingsA).length && query?.mappingsE && Object.keys(query.mappingsE).length) {
      return { mappings: query.mappingsA, episodes: { [episode]: query.mappingsE } }
    }
    const fetched = await fetchAnizipMappings(Number(id), { enabled: useAnizip, fresh })
    if (fetched) return fetched
    if (Number(id) === Number(media.id) && query?.mappingsA) {
      return { mappings: query.mappingsA, episodes: query.mappingsE ? { [episode]: query.mappingsE } : {} }
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

  const annotated = (candidates || []).map((item) => {
    if (!item || item.fallbackLanguage) return item
    const code = statedReleaseLanguage(item.title, { category: item.category })
    if (!code) return item
    return { ...item, fallbackLanguage: true, languageLabel: LANGUAGE_LABELS[code] || LANGUAGE_LABELS.other }
  })

  const judged = await judgeModalResults(annotated, built.target, settings, {
    usenetOn: false,
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
