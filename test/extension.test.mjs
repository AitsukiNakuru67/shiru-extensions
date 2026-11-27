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
      sourcesUrl: '',
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
    ext.settings = { indexUrl: 'https://index.example.test', sourcesUrl: '', feedUrls: '', useAnizip: false }
    const got = await ext.list({ anilistId: 154587, episode: 1, resolution: '1080' }, { fresh: true })
    assert.deepEqual(got, listDoc)
  } finally {
    globalThis.fetch = origFetch
  }
})

test('remote sourcesUrl manifest: fetches SeaDex, AnimeTosho JSON, dmhy base32 magnet, Mikan hash, and filters hentai scope', async () => {
  const hSeadex = HEX('1')
  const hTosho = HEX('2')
  // Base32 of 20 bytes of 0x33 ('3'.repeat(40)) => GMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZT
  const hDmhyHex = HEX('3')
  const hDmhyB32 = 'GMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZT'
  const hMikan = HEX('4')

  const manifest = {
    schemaVersion: 1,
    indexUrl: '',
    trackers: ['udp://tracker.example:1337/announce'],
    sources: [
      { id: 'seadex', format: 'seadex', scope: 'sfw', enabled: true, url: 'https://seadex.example.test/records?alID={anilistId}' },
      { id: 'animetosho', format: 'animetosho-json', scope: 'sfw', enabled: true, url: 'https://tosho.example.test/json?eid={anidbEid}' },
      { id: 'dmhy', format: 'rss', scope: 'sfw', enabled: true, url: 'https://dmhy.example.test/rss?k={nativeQuery}' },
      { id: 'mikan', format: 'rss', scope: 'sfw', enabled: true, url: 'https://mikan.example.test/rss?s={nativeQuery}' },
      { id: 'sukebei', format: 'rss', scope: 'hentai', enabled: true, url: 'https://sukebei.example.test/rss?q={query}' }
    ]
  }

  const origFetch = globalThis.fetch
  const requested = []
  globalThis.fetch = async (url) => {
    const u = String(url)
    requested.push(u)
    if (u.startsWith('https://manifest.example.test/sources.json')) {
      return new Response(JSON.stringify(manifest), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.startsWith('https://seadex.example.test/')) {
      return new Response(JSON.stringify({
        items: [{
          expand: {
            trs: [{
              infoHash: hSeadex,
              isBest: true,
              dualAudio: false,
              releaseGroup: 'Vodes',
              tracker: 'Nyaa',
              url: 'https://nyaa.example.test/view/1',
              files: [{ name: '[Vodes] Sousou no Frieren - 01 (BD 1080p) [AAAA1111].mkv', length: 1600000000 }]
            }]
          }
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.startsWith('https://tosho.example.test/')) {
      return new Response(JSON.stringify([
        {
          title: '[SubsPlease] Sousou no Frieren - 01 (1080p) [11111111].mkv',
          info_hash: hTosho,
          total_size: 1450000000,
          seeders: 88,
          leechers: 4,
          timestamp: 1696000000,
          website_url: 'https://tosho.example.test/view/1'
        }
      ]), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.startsWith('https://dmhy.example.test/')) {
      return new Response(`<rss><channel><item><title>[LoliHouse] Sousou no Frieren - 01 [1080p][CHS].mkv</title><enclosure url="magnet:?xt=urn:btih:${hDmhyB32}" length="900000000" type="application/x-bittorrent" /></item></channel></rss>`, { status: 200, headers: { 'content-type': 'application/xml' } })
    }
    if (u.startsWith('https://mikan.example.test/')) {
      return new Response(`<rss><channel><item><title>[ANi] Sousou no Frieren - 01 [1080p][CHT].mp4</title><link>https://mikanani.me/Home/Episode/${hMikan}</link></item></channel></rss>`, { status: 200, headers: { 'content-type': 'application/xml' } })
    }
    return new Response('', { status: 404 })
  }
  try {
    ext.settings = { indexUrl: '', sourcesUrl: 'https://manifest.example.test/sources.json', feedUrls: '', useAnizip: false }
    const res = await ext.list({
      anilistId: 154587,
      episode: 1,
      episodeCount: 28,
      anidbEid: 283115,
      resolution: '1080',
      titles: ['Sousou no Frieren'],
      media: {
        id: 154587,
        episodes: 28,
        format: 'TV',
        status: 'FINISHED',
        genres: ['Adventure', 'Fantasy'],
        title: { romaji: 'Sousou no Frieren', english: "Frieren: Beyond Journey's End", native: '葬送のフリーレン', userPreferred: 'Sousou no Frieren' },
        synonyms: [],
        relations: { edges: [] }
      }
    }, { fresh: true })

    assert.ok(!requested.some((u) => u.startsWith('https://sukebei.example.test/')), 'hentai-scoped source is skipped for SFW shows')
    assert.ok(requested.some((u) => u.includes('eid=283115')), 'expanded {anidbEid} for AnimeTosho')
    assert.ok(requested.some((u) => u.startsWith('https://dmhy.example.test/')), 'queried dmhy with native CJK title')
    assert.ok(requested.some((u) => u.startsWith('https://mikan.example.test/')), 'queried mikan with native CJK title')

    const allHashes = res.sections.raw.map((r) => r.hash)
    assert.ok(allHashes.includes(hSeadex), 'SeaDex best release surfaced')
    assert.ok(allHashes.includes(hTosho), 'AnimeTosho JSON release surfaced')
    assert.ok(allHashes.includes(hDmhyHex), 'dmhy base32 BTIH decoded to hex')
    assert.ok(allHashes.includes(hMikan), 'Mikan episode URL hash extracted')
    const sdRow = res.sections.raw.find((r) => r.hash === hSeadex)
    assert.equal(sdRow.seadexBest, true, 'SeaDex best flag preserved')
    assert.ok(sdRow.link.includes(encodeURIComponent('udp://tracker.example:1337/announce')), 'manifest trackers appended to magnet link')
  } finally {
    globalThis.fetch = origFetch
  }
})

test('Usenet crawlers (Binsearch / NZBKing / NZBIndex), key-gated ameNZB with apikey stripping, and OR query ladder', async () => {
  const manifest = {
    schemaVersion: 1,
    indexUrl: '',
    trackers: [],
    sources: [
      { id: 'nyaa-en', format: 'rss', scope: 'sfw', enabled: true, url: 'https://nyaa.example.test/?page=rss&c=1_2&q={orQuery}' },
      { id: 'binsearch', format: 'binsearch-html', scope: 'usenet', enabled: true, url: 'https://binsearch.example.test/search?q={query}' },
      { id: 'nzbking', format: 'nzbking-html', scope: 'usenet', enabled: true, url: 'https://nzbking.example.test/search/?q={query}' },
      { id: 'nzbindex', format: 'nzbindex-json', scope: 'usenet', enabled: true, url: 'https://nzbindex.example.test/api/search?q={query}' },
      { id: 'amenzb-query', format: 'newznab', scope: 'usenet', enabled: true, url: 'https://amenzb.example.test/api?t=search&q={query}&apikey={amenzbKey}' }
    ]
  }

  const secretKey = 'SUPER_SECRET_AMENZB_KEY_999'
  const origFetch = globalThis.fetch
  const requested = []
  globalThis.fetch = async (url) => {
    const u = String(url)
    requested.push(u)
    if (u.startsWith('https://usenet-manifest.example.test/sources.json')) {
      return new Response(JSON.stringify(manifest), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.startsWith('https://nyaa.example.test/')) {
      return new Response('<rss><channel></channel></rss>', { status: 200, headers: { 'content-type': 'application/xml' } })
    }
    if (u.startsWith('https://binsearch.example.test/')) {
      const html = `<table><tr class="result-table"><td><div><a href="/details/bs123">[BinGroup] Sousou no Frieren - 01 (1080p) [01/10]</a><div class="flex flex-row flex-wrap gap-1 items-center text-xs"><a href="/search?poster=bot">bot</a><span class="bg-white">1.20GB</span><span> complete </span></div></div></td><td class="min-w-20">2d</td></tr></table>`
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
    }
    if (u.startsWith('https://nzbking.example.test/')) {
      const html = `<div class='search-result'><div class='search-subject'>[KingGroup] Sousou no Frieren - 01 (1080p).mkv<br></div><a href="/nzb:KING42/">dl</a> parts: 12/12 size: 1.35GB</div>`
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
    }
    if (u.startsWith('https://nzbindex.example.test/')) {
      return new Response(JSON.stringify({
        data: { content: [{ id: 'idx-77', name: '[IdxGroup] Sousou no Frieren - 01 (1080p).mkv', size: 1400000000, complete: true, posted: 1696000000 }] }
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.startsWith('https://amenzb.example.test/')) {
      const xml = `<rss><channel><item><title>[AmeGroup] Sousou no Frieren - 01 (1080p).mkv</title><link>https://amenzb.example.test/api?t=get&amp;id=55&amp;apikey=${secretKey}</link><enclosure url="https://amenzb.example.test/api?t=get&amp;id=55&amp;apikey=${secretKey}" length="1500000000" type="application/x-nzb" /></item></channel></rss>`
      return new Response(xml, { status: 200, headers: { 'content-type': 'application/xml' } })
    }
    return new Response('', { status: 404 })
  }

  const baseQuery = {
    anilistId: 154587,
    episode: 1,
    episodeCount: 28,
    resolution: '1080',
    titles: ['Sousou no Frieren'],
    media: {
      id: 154587,
      episodes: 28,
      format: 'TV',
      status: 'FINISHED',
      genres: ['Adventure', 'Fantasy'],
      title: { romaji: 'Sousou no Frieren', english: "Frieren: Beyond Journey's End", native: '葬送のフリーレン', userPreferred: 'Sousou no Frieren' },
      synonyms: [],
      relations: { edges: [] }
    }
  }

  try {
    // 1. Without ameNZB key: keyless crawlers run, ameNZB is skipped
    ext.settings = { indexUrl: '', sourcesUrl: 'https://usenet-manifest.example.test/sources.json', feedUrls: '', useAnizip: false, enableUsenet: true, amenzbApiKey: '' }
    const rNoKey = await ext.list(baseQuery, { fresh: true })
    assert.ok(!requested.some((u) => u.startsWith('https://amenzb.example.test/')), 'ameNZB is skipped when amenzbApiKey is blank')
    assert.ok(requested.some((u) => u.startsWith('https://nyaa.example.test/') && decodeURIComponent(u).includes('|')), 'Shiru OR query ladder sent to Nyaa')
    const hostsNoKey = new Set(rNoKey.sections.usenet.map((r) => r.host))
    assert.ok(hostsNoKey.has('binsearch'), 'Binsearch NZB surfaced in sections.usenet')
    assert.ok(hostsNoKey.has('nzbking'), 'NZBKing NZB surfaced in sections.usenet')
    assert.ok(hostsNoKey.has('nzbindex'), 'NZBIndex NZB surfaced in sections.usenet')

    // 2. With ameNZB key: ameNZB runs and strips apikey from all returned rows
    requested.length = 0
    ext.settings = { indexUrl: '', sourcesUrl: 'https://usenet-manifest.example.test/sources.json', feedUrls: '', useAnizip: false, enableUsenet: true, amenzbApiKey: secretKey }
    const rWithKey = await ext.list(baseQuery, { fresh: true })
    assert.ok(requested.some((u) => u.startsWith('https://amenzb.example.test/') && u.includes(secretKey)), 'ameNZB queried with user API key')
    const ameRow = rWithKey.sections.usenet.find((r) => r.host === 'amenzb')
    assert.ok(ameRow, 'ameNZB NZB surfaced in sections.usenet')
    assert.ok(!JSON.stringify(rWithKey).includes(secretKey), 'ameNZB API key is stripped from all returned rows')
  } finally {
    globalThis.fetch = origFetch
  }
})
