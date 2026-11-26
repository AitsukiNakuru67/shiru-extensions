import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLocalIndexServer } from '../server/local-index.mjs'

const HEX = (c) => c.repeat(40)

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
