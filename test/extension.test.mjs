import { test } from 'node:test'
import assert from 'node:assert/strict'

// Import the actual built single-file Worker bundle.
const ext = (await import('../sources/release-index.js')).default

/**
 * Lightweight Anitomy-compatible parser for standalone Node tests (in Shiru's runtime,
 * `common/modules/extensions/worker.js` injects the real WASM `anitomyscript` onto `source.anitomyscript`).
 */
function parseOne (input) {
  const s = String(input || '')
  const group = /^\[([^\]]+)\]/.exec(s)?.[1] || ''
  const rest = s.replace(/^\[[^\]]+\]\s*/, '')
  const extMatch = /\.([a-z0-9]{2,4})$/i.exec(rest)
  const file_extension = extMatch?.[1] || ''
  const stem = extMatch ? rest.slice(0, -extMatch[0].length) : rest
  const res = /\b(2160p|1080p|720p|480p)\b/i.exec(stem)?.[1] || ''
  const epMatch = /\s-\s*(\d{1,4})(?!\d)/.exec(stem)
  const episode_number = epMatch?.[1] || undefined
  const titlePart = (epMatch ? stem.slice(0, epMatch.index) : stem).replace(/\[[^\]]*\]|\([^)]*\)/g, '').trim()
  const video_term = /\b(HEVC|x265|AV1|H\.?264|AVC|x264)\b/i.exec(stem)?.[1]
  return {
    file_name: s,
    file_extension,
    release_group: group || undefined,
    anime_title: titlePart,
    episode_number,
    video_resolution: res || undefined,
    video_term: video_term || undefined
  }
}

ext.anitomyscript = async (input) => (Array.isArray(input) ? input.map(parseOne) : parseOne(input))

const HEX = (c) => c.repeat(40)

test('on-device local matcher: parses RSS/Torznab feed, rejects wrong episode, crowns Best, separates foreign and unseeded', async () => {
  const hBest = HEX('a')
  const hSmall = HEX('b')
  const hWrongEp = HEX('c')
  const hForeign = HEX('d')
  const hDead = HEX('e')

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <item>
      <title>[SubsPlease] Sousou no Frieren - 01 (1080p) [11111111].mkv</title>
      <pubDate>Fri, 29 Sep 2023 14:00:00 +0000</pubDate>
      <torznab:attr name="infohash" value="${hBest}" />
      <torznab:attr name="size" value="1450000000" />
      <torznab:attr name="seeders" value="120" />
      <torznab:attr name="grabs" value="5000" />
      <torznab:attr name="trusted" value="yes" />
    </item>
    <item>
      <title>[ASW] Sousou no Frieren - 01 [1080p HEVC][22222222].mkv</title>
      <pubDate>Fri, 29 Sep 2023 15:00:00 +0000</pubDate>
      <torznab:attr name="infohash" value="${hSmall}" />
      <torznab:attr name="size" value="320000000" />
      <torznab:attr name="seeders" value="40" />
    </item>
    <item>
      <title>[SubsPlease] Sousou no Frieren - 02 (1080p) [33333333].mkv</title>
      <pubDate>Fri, 06 Oct 2023 14:00:00 +0000</pubDate>
      <torznab:attr name="infohash" value="${hWrongEp}" />
      <torznab:attr name="size" value="1400000000" />
      <torznab:attr name="seeders" value="90" />
      <torznab:attr name="trusted" value="yes" />
    </item>
    <item>
      <title>[FrenchSub] Sousou no Frieren - 01 (1080p) [VOSTFR][44444444].mkv</title>
      <pubDate>Fri, 29 Sep 2023 16:00:00 +0000</pubDate>
      <torznab:attr name="infohash" value="${hForeign}" />
      <torznab:attr name="size" value="1100000000" />
      <torznab:attr name="seeders" value="25" />
    </item>
    <item>
      <title>[DeadGroup] Sousou no Frieren - 01 (1080p) [55555555].mkv</title>
      <pubDate>Fri, 29 Sep 2023 17:00:00 +0000</pubDate>
      <torznab:attr name="infohash" value="${hDead}" />
      <torznab:attr name="size" value="1200000000" />
      <torznab:attr name="seeders" value="0" />
    </item>
  </channel>
</rss>`

  const origFetch = globalThis.fetch
  const requested = []
  globalThis.fetch = async (url) => {
    requested.push(String(url))
    return new Response(xml, { status: 200, headers: { 'content-type': 'application/rss+xml' } })
  }
  try {
    ext.settings = {
      indexUrl: '',
      feedUrls: 'https://feed.example.test/api?t=tvsearch&q={query}',
      useAnizip: false
    }
    const res = await ext.list({
      anilistId: 154587,
      episode: 1,
      episodeCount: 28,
      resolution: '1080',
      titles: ['Sousou no Frieren', "Frieren: Beyond Journey's End"],
      media: {
        id: 154587,
        idMal: 52991,
        episodes: 28,
        format: 'TV',
        status: 'FINISHED',
        title: { romaji: 'Sousou no Frieren', english: "Frieren: Beyond Journey's End", native: '葬送のフリーレン', userPreferred: 'Sousou no Frieren' },
        synonyms: [],
        relations: { edges: [] }
      }
    }, { fresh: true })

    assert.ok(res && res.sections, 'returns structured RankResponse')
    assert.ok(requested.some((u) => u.startsWith('https://feed.example.test/api?t=tvsearch&q=')), 'queried configured feed template')
    const recHashes = res.sections.recommended.map((r) => r.hash)
    assert.ok(recHashes.includes(hBest), 'ep 1 SubsPlease is in recommended')
    assert.ok(recHashes.includes(hSmall), 'ep 1 ASW is in recommended')
    assert.ok(!recHashes.includes(hWrongEp), 'wrong episode (ep 2) is excluded from recommended')
    assert.equal(res.sections.recommended[0].hash, hBest, 'SubsPlease 1080p leads recommended')
    assert.equal(res.sections.recommended[0].cardType, 'best', 'top row is crowned Best')
    assert.equal(res.autoplay, res.sections.recommended[0].key, 'autoplay points to Best row')
    assert.ok(res.sections.foreign.some((r) => r.hash === hForeign), 'Spanish-subbed release is placed in foreign')
    assert.ok(res.sections.unseeded.some((r) => r.hash === hDead), '0-seeder release is placed in unseeded')
    assert.ok(res.sections.recommended[0].terms.length > 0, 'card terms populated')
    assert.ok(res.sections.recommended[0].scoreBreakdown.rows.length > 0, 'scoreBreakdown populated')
  } finally {
    globalThis.fetch = origFetch
  }
})

test('remote indexUrl mode: passes .list.json v2 directly through for Shiru local ordering', async () => {
  const listDoc = { v: 2, anilistId: 154587, episode: 1, releases: [{ key: `torrent:${HEX('1')}`, hash: HEX('1'), title: '[G] Show - 01 (1080p)' }] }
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/anime/anilist/154587/1.list.json')) {
      return new Response(JSON.stringify(listDoc), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { status: 404 })
  }
  try {
    ext.settings = { indexUrl: 'https://index.example.test', feedUrls: '', useAnizip: false }
    const got = await ext.list({ anilistId: 154587, episode: 1, resolution: '1080' }, { fresh: true })
    assert.deepEqual(got, listDoc)
  } finally {
    globalThis.fetch = origFetch
  }
})
