/**
 * Pure-JS Anitomy-compatible anime release filename parser for the standalone Node pre-builder server
 * (used when the Emscripten WASM `anitomyscript` binary is not loaded).
 */
export function parseTitlePure (input) {
  const s = String(input || '')
  const group = /^\[([^\]]+)\]/.exec(s)?.[1]?.trim() || ''
  const rest = group ? s.replace(/^\[[^\]]+\]\s*/, '') : s
  const extMatch = /\.([a-z0-9]{2,4})$/i.exec(rest)
  const file_extension = extMatch?.[1] || ''
  const stem = extMatch ? rest.slice(0, -extMatch[0].length) : rest

  const resMatch = /\b(2160p|1440p|1080p|720p|540p|480p|360p|4K|1920x1080|1280x720)\b/i.exec(stem)
  const video_resolution = resMatch ? (resMatch[1].toUpperCase() === '4K' ? '2160p' : resMatch[1].toLowerCase()) : undefined

  const videoTerms = []
  for (const m of stem.matchAll(/\b(HEVC|x265|H\.?265|AV1|AVC|H\.?264|x264|10-?bit|8-?bit|Hi10P?|HDR10?\+?|DV)\b/gi)) {
    videoTerms.push(m[1])
  }
  const audioTerms = []
  for (const m of stem.matchAll(/\b(FLAC|AAC|Opus|AC3|EAC3|DDP?(?:2\.0|5\.1)?|DTS(?:-HD)?(?:\s*MA)?|TrueHD|Dual[\s._-]?Audio|Multi[\s._-]?Audio)\b/gi)) {
    audioTerms.push(m[1])
  }
  const sourceTerms = []
  for (const m of stem.matchAll(/\b(BD(?:Rip|Remux|MV)?|Blu-?Ray|WEB-?DL|WEBRip|DVDRip|HDTV)\b/gi)) {
    sourceTerms.push(m[1])
  }

  let anime_season
  let episode_number
  let titleCut = stem.length

  const sxe = /\bS(\d{1,2})E(\d{1,4})(?:[-~]E?(\d{1,4}))?\b/i.exec(stem)
  if (sxe) {
    anime_season = String(Number(sxe[1]))
    episode_number = sxe[3] ? [sxe[2], sxe[3]] : sxe[2]
    titleCut = Math.min(titleCut, sxe.index)
  } else {
    const dashEp = /\s[-~–]\s*(\d{1,4})(?:v(\d))?(?:\s*[-~]\s*(\d{1,4}))?(?=$|[\s[(.])/i.exec(stem)
    if (dashEp) {
      episode_number = dashEp[3] ? [dashEp[1], dashEp[3]] : dashEp[1]
      titleCut = Math.min(titleCut, dashEp.index)
    } else {
      const epWord = /\b(?:Ep(?:isode)?\.?\s*|E)(\d{1,4})(?:[-~](\d{1,4}))?\b/i.exec(stem)
      if (epWord) {
        episode_number = epWord[2] ? [epWord[1], epWord[2]] : epWord[1]
        titleCut = Math.min(titleCut, epWord.index)
      }
    }
    const seasonWord = /\b(?:Season\s*|S)(\d{1,2})\b/i.exec(stem)
    if (seasonWord) anime_season = String(Number(seasonWord[1]))
  }

  const crc = /\[([0-9A-F]{8})\]/i.exec(stem)?.[1]
  const anime_title = stem
    .slice(0, titleCut)
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return {
    file_name: s,
    file_extension: file_extension || undefined,
    release_group: group || undefined,
    anime_title,
    ...(anime_season ? { anime_season } : {}),
    ...(episode_number ? { episode_number } : {}),
    ...(video_resolution ? { video_resolution } : {}),
    ...(videoTerms.length ? { video_term: videoTerms.length === 1 ? videoTerms[0] : videoTerms } : {}),
    ...(audioTerms.length ? { audio_term: audioTerms.length === 1 ? audioTerms[0] : audioTerms } : {}),
    ...(sourceTerms.length ? { source: sourceTerms.length === 1 ? sourceTerms[0] : sourceTerms } : {}),
    ...(crc ? { file_checksum: crc } : {})
  }
}

export async function anitomyPure (input) {
  return Array.isArray(input) ? input.map(parseTitlePure) : parseTitlePure(input)
}
