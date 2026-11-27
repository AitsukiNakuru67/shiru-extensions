/**
 * Sanitized Pixeldrain seed importer and O(1) byte-offset lookup store for `local-index.mjs`.
 * Pure Node.js 22+ (uses native `zlib.createZstdDecompress` and a streaming USTAR/PAX tar reader —
 * zero native binaries or extra npm dependencies required).
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'

export const DEFAULT_SEED_URL = 'https://pixeldrain.com/api/filesystem/qkW71xWE/seed.tar.zst'
export const DEFAULT_SEED_META_URL = 'https://pixeldrain.com/api/filesystem/qkW71xWE/seed.json'

const HEX40 = /^[0-9a-f]{40}$/i
const ANSWERS_REL = 'live/serve/live/episode-answers.jsonl'

/**
 * Minimal pure-JS streaming POSIX/USTAR/GNU/PAX tar extractor.
 * Extracts only paths matching `wanted` (Set of normalized relative paths) into `outDir`.
 */
export async function extractTarStream (stream, outDir, wanted = new Set([ANSWERS_REL])) {
  let buf = Buffer.alloc(0)
  let currentFile = null
  let remaining = 0
  let pad = 0
  let nextLongName = null
  let nextPaxPath = null
  const extracted = []

  const normalizeRel = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')

  const openTarget = (rel) => {
    const dest = path.join(outDir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const tmp = `${dest}.tmp.${process.pid}`
    return { rel, dest, tmp, ws: fs.createWriteStream(tmp) }
  }

  const closeTarget = async (target) => {
    if (!target) return
    await new Promise((resolve, reject) => {
      target.ws.on('error', reject)
      target.ws.end(resolve)
    })
    fs.renameSync(target.tmp, target.dest)
    extracted.push(target.rel)
  }

  for await (const chunk of stream) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk

    while (buf.length > 0) {
      if (remaining > 0) {
        const take = Math.min(remaining, buf.length)
        const slice = buf.subarray(0, take)
        buf = buf.subarray(take)
        remaining -= take
        if (currentFile?.kind === 'file') {
          if (!currentFile.ws.write(slice)) {
            await new Promise((r) => currentFile.ws.once('drain', r))
          }
        } else if (currentFile?.kind === 'meta') {
          currentFile.chunks.push(Buffer.from(slice))
        }
        if (remaining === 0) {
          if (currentFile?.kind === 'file') {
            await closeTarget(currentFile)
          } else if (currentFile?.kind === 'meta') {
            const raw = Buffer.concat(currentFile.chunks).toString('utf8')
            if (currentFile.type === 'L') {
              nextLongName = raw.replace(/\0+$/, '')
            } else if (currentFile.type === 'x') {
              const m = /\d+ path=([^\n]+)\n/.exec(raw)
              if (m) nextPaxPath = m[1]
            }
          }
          currentFile = null
        }
        continue
      }

      if (pad > 0) {
        if (buf.length < pad) break
        buf = buf.subarray(pad)
        pad = 0
        continue
      }

      if (buf.length < 512) break
      const header = buf.subarray(0, 512)
      buf = buf.subarray(512)

      // Two 512-byte zero blocks mark end-of-archive.
      let allZero = true
      for (let i = 0; i < 512; i++) {
        if (header[i] !== 0) { allZero = false; break }
      }
      if (allZero) continue

      const typeByte = header[156]
      const type = typeByte === 0 ? '0' : String.fromCharCode(typeByte)
      const sizeStr = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim()
      const size = sizeStr ? parseInt(sizeStr, 8) : 0
      const nameRaw = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
      const prefixRaw = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
      const defaultName = prefixRaw ? `${prefixRaw}/${nameRaw}` : nameRaw
      const rel = normalizeRel(nextPaxPath || nextLongName || defaultName)

      if (type === 'L' || type === 'x') {
        currentFile = { kind: 'meta', type, chunks: [] }
        remaining = size
        pad = (512 - (size % 512)) % 512
        continue
      }

      nextLongName = null
      nextPaxPath = null

      if ((type === '0' || type === '\0') && wanted.has(rel)) {
        const target = openTarget(rel)
        currentFile = { kind: 'file', ...target }
        if (size === 0) {
          await closeTarget(target)
          currentFile = null
        }
      } else {
        currentFile = null
      }
      remaining = size
      pad = (512 - (size % 512)) % 512
    }
  }

  return extracted
}

/**
 * Scan `episode-answers.jsonl` in one streaming pass and write an O(1) byte-offset index:
 * `{ "<anilistId>:<episode>": [offset, byteLength] }` (latest record with rows wins).
 */
export async function buildAnswersIndex (answersPath, indexPath) {
  const map = Object.create(null)
  const hasRows = new Set()
  let offset = 0
  let leftover = Buffer.alloc(0)
  let lines = 0

  const indexLine = (lineBuf, lineOffset) => {
    if (!lineBuf.length) return
    lines++
    // Fast header scan on the first 256 bytes avoids JSON.parse of 400 MB on startup/import.
    const head = lineBuf.subarray(0, Math.min(256, lineBuf.length)).toString('utf8')
    const idM = /"anilistId":(\d+)/.exec(head)
    const epM = /"episode":(\d+)/.exec(head)
    if (!idM || !epM) return
    const key = `${idM[1]}:${epM[1]}`
    const emptyRows = head.includes('"rows":[]')
    // Prefer a record with non-empty rows over an empty one; otherwise keep the newest line.
    if (!emptyRows || !hasRows.has(key)) {
      map[key] = [lineOffset, lineBuf.length]
      if (!emptyRows) hasRows.add(key)
    }
  }

  for await (const chunk of fs.createReadStream(answersPath, { highWaterMark: 1024 * 1024 })) {
    const combined = leftover.length ? Buffer.concat([leftover, chunk]) : chunk
    let start = 0
    while (true) {
      const nl = combined.indexOf(10, start)
      if (nl < 0) break
      let end = nl
      if (end > start && combined[end - 1] === 13) end--
      indexLine(combined.subarray(start, end), offset + start)
      start = nl + 1
    }
    offset += start
    leftover = start < combined.length ? Buffer.from(combined.subarray(start)) : Buffer.alloc(0)
  }
  if (leftover.length) indexLine(leftover, offset)

  const keys = Object.keys(map)
  const tmp = `${indexPath}.tmp.${process.pid}`
  fs.mkdirSync(path.dirname(indexPath), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(map))
  fs.renameSync(tmp, indexPath)
  return { lines, episodesIndexed: keys.length, withRows: hasRows.size }
}

/**
 * Download, verify, extract, and index the sanitized seed snapshot into `seedDir`.
 */
export async function importSeed ({
  seedUrl = DEFAULT_SEED_URL,
  seedMetaUrl = DEFAULT_SEED_META_URL,
  seedDir,
  force = false,
  fetchImpl = fetch,
  log = (...a) => console.log('[seed-import]', ...a)
} = {}) {
  const dir = path.resolve(seedDir)
  fs.mkdirSync(dir, { recursive: true })
  const metaFile = path.join(dir, 'seed-meta.json')
  const indexFile = path.join(dir, 'answers.idx.json')
  const answersFile = path.join(dir, ...ANSWERS_REL.split('/'))

  let remoteMeta = null
  if (seedMetaUrl) {
    try {
      const r = await fetchImpl(seedMetaUrl, { signal: AbortSignal.timeout(15000) })
      if (r.ok) remoteMeta = await r.json()
    } catch {}
  }

  if (!force && fs.existsSync(metaFile) && fs.existsSync(indexFile) && fs.existsSync(answersFile)) {
    try {
      const localMeta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
      if (!remoteMeta?.sha256 || localMeta?.sha256 === remoteMeta.sha256) {
        return { skipped: true, alreadyUpToDate: true, ...localMeta }
      }
    } catch {}
  }

  const t0 = Date.now()
  log(`downloading seed from ${seedUrl} ...`)
  const res = await fetchImpl(seedUrl, { signal: AbortSignal.timeout(1800_000) })
  if (!res.ok || !res.body) throw new Error(`Seed download failed: HTTP ${res.status}`)

  const hash = crypto.createHash('sha256')
  let bytes = 0
  const nodeStream = Readable.fromWeb(res.body)
  nodeStream.on('data', (chunk) => {
    bytes += chunk.length
    hash.update(chunk)
  })

  const zstd = zlib.createZstdDecompress()
  const extracted = await extractTarStream(nodeStream.pipe(zstd), dir, new Set([ANSWERS_REL]))
  const sha256 = hash.digest('hex')

  if (remoteMeta?.sha256 && remoteMeta.sha256 !== sha256) {
    throw new Error(`Seed SHA-256 mismatch: expected ${remoteMeta.sha256}, got ${sha256}`)
  }
  if (!extracted.includes(ANSWERS_REL) || !fs.existsSync(answersFile)) {
    throw new Error(`Seed archive did not contain ${ANSWERS_REL}`)
  }

  log(`extracted ${(bytes / (1024 * 1024)).toFixed(1)} MB (${sha256.slice(0, 12)}), indexing episodes ...`)
  const idx = await buildAnswersIndex(answersFile, indexFile)
  const meta = {
    seedUrl,
    sha256,
    bytes,
    generatedAt: remoteMeta?.generatedAt || null,
    importedAt: new Date().toISOString(),
    elapsedSec: Math.round((Date.now() - t0) / 1000),
    ...idx
  }
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n')
  log(`ready: ${idx.episodesIndexed} episodes indexed (${idx.withRows} with rows) in ${meta.elapsedSec}s`)
  return { skipped: false, ...meta }
}

function appendTrackers (link, trackers = []) {
  if (!link || !link.startsWith('magnet:') || !Array.isArray(trackers) || !trackers.length) return link
  let out = link
  for (const t of trackers) {
    const enc = encodeURIComponent(t)
    if (!out.includes(enc) && !out.includes(t)) out += `&tr=${enc}`
  }
  return out
}

function seedRowToRankRow (row, idx, winnerHash, trackers = []) {
  const hash = String(row?.btih || row?.hash || '').toLowerCase()
  const validHash = HEX40.test(hash) ? hash : ''
  const title = String(row?.name || row?.title || '')
  const kind = row?.kind === 'nzb' || (!validHash && row?.nzbUrl) ? 'nzb' : 'torrent'
  const isWinner = (winnerHash && validHash && validHash === winnerHash) || (!winnerHash && idx === 0 && kind !== 'nzb')
  const isSeadex = row?.seadex === true
  const isSeadexBest = row?.seadexBest === true
  const cardType = isWinner && !isSeadex ? 'best' : 'default'
  const key = validHash ? `${kind}:${validHash}` : `${kind}:${title.toLowerCase().slice(0, 80)}`
  const rawLink = row?.link || (validHash ? `magnet:?xt=urn:btih:${validHash}&dn=${encodeURIComponent(title)}` : '')
  const link = appendTrackers(rawLink, trackers)
  const group = String(row?.group || /^\[([^\]]+)\]/.exec(title)?.[1] || '')
  const seeders = Number.isSafeInteger(row?.seeders) ? row.seeders : null
  const downloads = Number.isSafeInteger(row?.downloads) ? row.downloads : null
  const size = Number(row?.size) > 0 ? Number(row.size) : null
  const uploaded = typeof row?.uploaded === 'string' && row.uploaded ? row.uploaded : null
  const pageUrl = row?.pageUrl || (Number.isSafeInteger(row?.nyaa) && row.nyaa > 0 ? `https://nyaa.si/view/${row.nyaa}` : '')

  return {
    key,
    copyKey: null,
    hash: validHash,
    kind,
    title,
    displayName: title,
    link,
    nzbUrl: String(row?.nzbUrl || ''),
    pageUrl,
    host: String(row?.host || (row?.nyaa ? 'nyaa' : 'seed')),
    size,
    episodesCovered: 1,
    seeders,
    downloads,
    uploaded,
    group,
    groupName: group,
    type: isWinner && !isSeadex ? 'best' : 'alt',
    cardType,
    crown: isSeadexBest ? 'curatedBest' : (isWinner && !isSeadex ? 'best' : null),
    ladderSection: null,
    sectionLabel: null,
    labels: [],
    terms: [],
    packSize: null,
    seedTier: null,
    showSeeders: seeders != null,
    scoreBreakdown: null,
    seadex: row?.seadex === true,
    seadexBest: row?.seadexBest === true,
    trusted: row?.trusted === true || row?.nyaaTrusted === true,
    trustedBy: null,
    remake: row?.remake === true,
    rawDisc: false,
    possibleReason: null,
    language: null,
    adult: false
  }
}

/**
 * Open an indexed seed directory for sub-millisecond `(anilistId, episode)` lookups.
 */
export function openSeedStore (seedDir) {
  const dir = path.resolve(seedDir)
  const indexFile = path.join(dir, 'answers.idx.json')
  const answersFile = path.join(dir, ...ANSWERS_REL.split('/'))
  const metaFile = path.join(dir, 'seed-meta.json')

  let index = null
  let fd = null
  let meta = null

  function load () {
    close()
    if (!fs.existsSync(indexFile) || !fs.existsSync(answersFile)) return false
    try {
      const parsed = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
      index = new Map(Object.entries(parsed))
      fd = fs.openSync(answersFile, 'r')
      if (fs.existsSync(metaFile)) meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
      return true
    } catch {
      close()
      return false
    }
  }

  function close () {
    if (fd != null) {
      try { fs.closeSync(fd) } catch {}
      fd = null
    }
    index = null
  }

  function readRawRecord (anilistId, episode) {
    if (!index || fd == null) return null
    const loc = index.get(`${anilistId}:${episode}`)
    if (!loc) return null
    const [offset, length] = loc
    if (!(length > 0)) return null
    const buf = Buffer.allocUnsafe(length)
    const n = fs.readSync(fd, buf, 0, length, offset)
    if (n !== length) return null
    try {
      return JSON.parse(buf.toString('utf8'))
    } catch {
      return null
    }
  }

  function getRankPayload (anilistId, episode, { trackers = [] } = {}) {
    const rec = readRawRecord(anilistId, episode)
    if (!rec) return null
    const baseRows = Array.isArray(rec.rows) ? rec.rows : []
    const pickRanked = Array.isArray(rec.answer?.pick?.ranked) ? rec.answer.pick.ranked : []
    if (!baseRows.length && !pickRanked.length) return null

    // Merge verified delivered rows (`rec.rows`: size, nyaa id, uploaded, seadexBest) with
    // the full ranked pool (`rec.answer.pick.ranked`: seeders, trusted, seadex, group, ladderSection).
    const byHash = new Map()
    const merged = []
    for (const r of baseRows) {
      if (!r) continue
      const h = String(r.btih || r.hash || '').toLowerCase()
      const copy = { ...r }
      if (HEX40.test(h)) byHash.set(h, copy)
      merged.push(copy)
    }
    for (const r of pickRanked) {
      if (!r) continue
      const h = String(r.hash || r.btih || '').toLowerCase()
      const existing = HEX40.test(h) ? byHash.get(h) : null
      if (existing) {
        if (existing.seeders == null && Number.isSafeInteger(r.seeders)) existing.seeders = r.seeders
        if (r.trusted === true) existing.trusted = true
        if (r.seadex === true) existing.seadex = true
        if (r.group && !existing.group) existing.group = r.group
        if (r.ladderSection && !existing.ladderSection) existing.ladderSection = r.ladderSection
        if (!existing.name && r.title) existing.name = r.title
      } else {
        const entry = {
          btih: HEX40.test(h) ? h : '',
          name: String(r.title || r.name || ''),
          group: String(r.group || ''),
          seeders: Number.isSafeInteger(r.seeders) ? r.seeders : null,
          trusted: r.trusted === true,
          seadex: r.seadex === true,
          seadexBest: r.seadexBest === true,
          kind: r.kind === 'nzb' ? 'nzb' : 'torrent',
          ladderSection: r.ladderSection || null,
          size: Number(r.size) > 0 ? Number(r.size) : null
        }
        if (HEX40.test(h)) byHash.set(h, entry)
        merged.push(entry)
      }
    }

    const winnerHash = String(rec.answer?.pick?.winner?.hash || '').toLowerCase()
    const mapped = merged.map((r, i) => seedRowToRankRow(r, i, winnerHash, trackers))
    const torrents = mapped.filter((r) => r.kind !== 'nzb')
    const usenet = mapped.filter((r) => r.kind === 'nzb')
    // Ensure winner / Curated Best leads recommended, and crown top non-curated alive torrent as Best (R259)
    const leadScore = (r) => (r.hash === winnerHash ? 3 : r.seadexBest ? 2 : r.cardType === 'best' ? 1 : 0)
    torrents.sort((a, b) => leadScore(b) - leadScore(a))
    const unseeded = torrents.filter((r) => r.seeders === 0)
    const recommended = torrents.filter((r) => r.seeders !== 0)
    if (!recommended.some((r) => r.type === 'best')) {
      const topNonCurated = recommended.find((r) => !r.seadex)
      if (topNonCurated) {
        topNonCurated.type = 'best'
        topNonCurated.cardType = 'best'
        topNonCurated.crown = 'best'
      }
    }
    const autoplayRow = recommended[0] || torrents[0] || null

    return {
      source: 'seed',
      anilistId,
      episode,
      seededAt: rec.at || meta?.generatedAt || null,
      sections: {
        recommended,
        unconfirmed: [],
        usenet,
        private: [],
        foreign: [],
        possible: [],
        unseeded,
        raw: mapped
      },
      autoplay: autoplayRow?.key || null,
      hiddenRevisions: 0,
      resolution: { relaxed: false, matched: recommended.length, wanted: '1080' }
    }
  }

  load()

  return {
    get ready () { return !!(index && fd != null) },
    get count () { return index ? index.size : 0 },
    get meta () { return meta },
    reload: load,
    close,
    readRawRecord,
    getRankPayload
  }
}
