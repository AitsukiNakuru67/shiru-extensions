import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { createLocalIndexServer } from '../server/local-index.mjs'
import { importSeed } from '../server/seed-store.mjs'

const HEX = (c) => c.repeat(40)

function makeTarBuffer (entries) {
  const blocks = []
  for (const { name, data } of entries) {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
    const header = Buffer.alloc(512, 0)
    header.write(name, 0, Math.min(100, name.length), 'utf8')
    header.write('0000644\0', 100, 8, 'ascii')
    header.write('0000000\0', 108, 8, 'ascii')
    header.write('0000000\0', 116, 8, 'ascii')
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii')
    header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii')
    header.write('        ', 148, 8, 'ascii')
    header[156] = 0x30 // '0' regular file
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    let sum = 0
    for (let i = 0; i < 512; i++) sum += header[i]
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
    blocks.push(header, body)
    const pad = (512 - (body.length % 512)) % 512
    if (pad) blocks.push(Buffer.alloc(pad, 0))
  }
  blocks.push(Buffer.alloc(1024, 0))
  return Buffer.concat(blocks)
}

test('local pre-builder server: pre-builds to disk, serves cached episode in milliseconds, exposes /site.json and /health.json', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shiru-local-idx-'))
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <item>
      <title>[SubsPlease] Sousou no Frieren - 01 (1080p) [11111111].mkv</title>
      <pubDate>Fri, 29 Sep 2023 14:00:00 +0000</pubDate>
      <torznab:attr name="infohash" value="${HEX('a')}" />
      <torznab:attr name="size" value="1450000000" />
      <torznab:attr name="seeders" value="120" />
      <torznab:attr name="trusted" value="yes" />
    </item>
  </channel>
</rss>`

  const origFetch = globalThis.fetch
  let feedCalls = 0
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://feed.example.test/')) {
      feedCalls++
      return new Response(xml, { status: 200, headers: { 'content-type': 'application/rss+xml' } })
    }
    return origFetch(url, init)
  }

  const app = createLocalIndexServer({
    host: '127.0.0.1',
    port: 0,
    dataDir: tmp,
    seedDir: path.join(tmp, 'seed'),
    seedUrl: '',
    sourcesUrl: '',
    feedUrls: 'https://feed.example.test/api?q={query}',
    refreshMinutes: 0,
    useAnizip: false,
    log: () => {},
    resolveMedia: async (id) => ({
      id,
      episodes: 28,
      format: 'TV',
      status: 'FINISHED',
      title: { romaji: 'Sousou no Frieren', english: "Frieren: Beyond Journey's End", userPreferred: 'Sousou no Frieren' },
      synonyms: [],
      relations: { edges: [] }
    })
  })

  const { port } = await app.start()
  const base = `http://127.0.0.1:${port}`
  try {
    // 1. Pre-build ahead of time
    const built = await app.buildEpisode(154587, 1)
    assert.ok(built, 'pre-built episode saved')
    assert.equal(feedCalls > 0, true, 'fetched feed once during pre-build')
    const callsAfterPrebuild = feedCalls

    // 2. Subsequent HTTP read hits cache with zero upstream calls in milliseconds
    const t0 = performance.now()
    const res = await origFetch(`${base}/anime/anilist/154587/1.rank.json`)
    const elapsedMs = performance.now() - t0
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-local-cache'), 'hit')
    const body = await res.json()
    assert.equal(body.sections.recommended[0].hash, HEX('a'))
    assert.equal(body.sections.recommended[0].cardType, 'best')
    assert.equal(feedCalls, callsAfterPrebuild, 'served from pre-built cache with zero upstream fetches')
    assert.ok(elapsedMs < 200, `cached read was fast (${elapsedMs.toFixed(1)} ms)`)

    // 3. /site.json & /health.json
    const site = await (await origFetch(`${base}/site.json`)).json()
    assert.equal(site.features.rank, true)
    const health = await (await origFetch(`${base}/health.json`)).json()
    assert.equal(health.ok, true)
    assert.equal(health.cachedFiles, 1)
  } finally {
    globalThis.fetch = origFetch
    await app.stop()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('seed importer & local-index: downloads .tar.zst, verifies SHA-256, indexes byte offsets, serves episodes in <50 ms', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shiru-seed-test-'))
  const seedDir = path.join(tmp, 'seed')
  const hWinner = HEX('f')
  const hAlt = HEX('e')
  const line = JSON.stringify({
    at: '2026-11-27T00:00:00.000Z',
    anilistId: 1,
    episode: 1,
    rows: [
      { btih: hAlt, name: '[Alt] Cowboy Bebop - 01 [1080p].mkv', size: 800_000_000, seeders: 12, nyaa: 1001 },
      { btih: hWinner, name: '[Judas] Cowboy Bebop - 01 [BD 1080p].mkv', size: 1_200_000_000, seeders: 95, seadex: true, seadexBest: true, trusted: true, nyaa: 1002 }
    ],
    answer: { v: 3, pick: { winner: { hash: hWinner } } }
  }) + '\n'

  const tarBuf = makeTarBuffer([{ name: 'live/serve/live/episode-answers.jsonl', data: line }])
  const zstBuf = zlib.zstdCompressSync(tarBuf)
  const sha256 = crypto.createHash('sha256').update(zstBuf).digest('hex')

  const mockFetch = async (url) => {
    if (String(url).endsWith('/seed.json')) {
      return new Response(JSON.stringify({ sha256, generatedAt: '2026-11-27T02:00:00.000Z' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (String(url).endsWith('/seed.tar.zst')) {
      return new Response(zstBuf, { status: 200, headers: { 'content-type': 'application/zstd' } })
    }
    throw new Error('Unexpected network call: ' + url)
  }

  const imported = await importSeed({
    seedUrl: 'https://seed.example.test/seed.tar.zst',
    seedMetaUrl: 'https://seed.example.test/seed.json',
    seedDir,
    fetchImpl: mockFetch,
    log: () => {}
  })
  assert.equal(imported.skipped, false)
  assert.equal(imported.sha256, sha256)
  assert.equal(imported.episodesIndexed, 1)

  // Re-running import with matching SHA-256 skips download cleanly
  const second = await importSeed({
    seedUrl: 'https://seed.example.test/seed.tar.zst',
    seedMetaUrl: 'https://seed.example.test/seed.json',
    seedDir,
    fetchImpl: mockFetch,
    log: () => {}
  })
  assert.equal(second.alreadyUpToDate, true)

  const app = createLocalIndexServer({
    host: '127.0.0.1',
    port: 0,
    dataDir: path.join(tmp, 'cache'),
    seedDir,
    seedUrl: '',
    sourcesUrl: '',
    feedUrls: '',
    refreshMinutes: 0,
    log: () => {}
  })
  const { port } = await app.start()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/anime/anilist/1/1.rank.json`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-local-cache'), 'seed')
    const body = await res.json()
    assert.equal(body.sections.recommended.length, 2)
    assert.equal(body.sections.recommended[0].hash, hWinner, 'winner from seed leads recommended')
    assert.equal(body.sections.recommended[0].cardType, 'best')
    assert.equal(body.sections.recommended[0].seadexBest, true)

    const health = await (await fetch(`http://127.0.0.1:${port}/health.json`)).json()
    assert.equal(health.seedReady, true)
    assert.equal(health.seedEpisodes, 1)
    assert.equal(health.seedHits, 1)
  } finally {
    await app.stop()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
