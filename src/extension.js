import AbstractSource from '../sources/abstract.js'
import {
  DEFAULT_SOURCES_URL,
  normalizeAllowedUrl,
  normalizeBaseUrl,
  parseFeedTemplates,
  fetchSourcesManifest
} from './feeds.js'
import { searchCandidatesWithParity, searchAndMatchLocally, formatSeededRankPayload } from './local-matcher.js'

const HEX40 = /^[0-9a-f]{40}$/i

function toTorrentResult (row, trackers = []) {
  const hash = String(row?.btih || row?.hash || '').toLowerCase()
  const title = String(row?.name || row?.title || '')
  const tr = trackers.map((t) => `&tr=${encodeURIComponent(t)}`).join('')
  const dn = title ? `&dn=${encodeURIComponent(title)}` : ''
  const link = row?.link || (HEX40.test(hash) ? `magnet:?xt=urn:btih:${hash}${dn}${tr}` : '')
  const uploaded = Date.parse(String(row?.uploaded || row?.pubDate || ''))
  return {
    title,
    link,
    hash: HEX40.test(hash) ? hash : '',
    size: Number(row?.size) > 0 ? Number(row.size) : 0,
    seeders: Number.isSafeInteger(row?.seeders) ? row.seeders : null,
    leechers: Number.isSafeInteger(row?.leechers) ? row.leechers : null,
    downloads: Number.isSafeInteger(row?.downloads) ? row.downloads : null,
    date: Number.isFinite(uploaded) ? new Date(uploaded) : new Date(0),
    accuracy: 'high',
    trusted: row?.nyaaTrusted === true || row?.trusted === true,
    remake: row?.remake === true,
    seadex: row?.seadex === true,
    seadexBest: row?.seadexBest === true,
    host: String(row?.host || (Array.isArray(row?.source) ? row.source[0] : '') || '')
  }
}

export default new class ReleaseMatcherExtension extends AbstractSource {
  #trackers = []
  #trackersBase = ''

  #indexBase () {
    return normalizeBaseUrl(this.settings?.indexUrl || '')
  }

  #sourcesUrl () {
    // Respect explicit empty string (disables remote manifest); default to permanent Pixeldrain manifest when unset.
    if (this.settings && Object.prototype.hasOwnProperty.call(this.settings, 'sourcesUrl')) {
      return normalizeAllowedUrl(this.settings.sourcesUrl || '')
    }
    return normalizeAllowedUrl(DEFAULT_SOURCES_URL)
  }

  #feedTemplates () {
    return parseFeedTemplates(this.settings?.feedUrls || '')
  }

  #bindAnitomy () {
    if (typeof this.anitomyscript === 'function') {
      globalThis.__shiruAnitomyscript = this.anitomyscript
    }
  }

  /** Helper used by `server/local-index.mjs` to format seeded payloads with full Shiru card parity. */
  async formatSeedPayload (payload, opts = {}) {
    this.#bindAnitomy()
    return formatSeededRankPayload(payload, opts)
  }

  async #loadTrackers (base) {
    if (!base) return []
    if (this.#trackersBase === base) return this.#trackers
    this.#trackersBase = base
    this.#trackers = []
    try {
      const res = await fetch(`${base}/site.json`)
      if (res.ok) {
        const body = await res.json()
        if (Array.isArray(body?.trackers)) {
          this.#trackers = body.trackers
            .map((t) => String(t || '').trim())
            .filter((t) => /^(?:udp|https?|wss?):\/\/[^\s]{3,240}$/i.test(t))
        }
      }
    } catch {}
    return this.#trackers
  }

  async #resolveActiveConfig ({ fresh = false } = {}) {
    const directBase = this.#indexBase()
    if (directBase) return { indexUrl: directBase, sources: [], trackers: [] }

    const sUrl = this.#sourcesUrl()
    const manifest = sUrl ? await fetchSourcesManifest(sUrl, { fresh }) : null
    if (manifest?.indexUrl) {
      return { indexUrl: manifest.indexUrl, sources: [], trackers: manifest.trackers || [] }
    }

    const sources = [
      ...(manifest?.sources || []),
      ...this.#feedTemplates()
    ]
    return { indexUrl: '', sources, trackers: manifest?.trackers || [] }
  }

  async validate () {
    const base = this.#indexBase()
    if (base) {
      try {
        const res = await fetch(`${base}/site.json`)
        if (res.ok) return true
        const h = await fetch(`${base}/health.json`)
        return h.ok
      } catch {
        return false
      }
    }
    return true
  }

  async #streamRemoteRank (base, anilistId, episode, query, opts) {
    const onProgress = typeof opts?.onProgress === 'function' ? opts.onProgress : null
    const onPartial = typeof opts?.onPartial === 'function' ? opts.onPartial : null
    try {
      const res = await fetch(`${base}/rank/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson, application/json' },
        body: JSON.stringify({
          anilistId,
          episode,
          fresh: opts?.fresh === true,
          prefs: { resolution: query?.resolution ?? '1080' }
        })
      })
      if (!res.ok) return null
      const ct = String(res.headers?.get?.('content-type') || '').toLowerCase()
      if (!ct.includes('ndjson') || !res.body || typeof res.body.getReader !== 'function') {
        const body = await res.json().catch(() => null)
        return body && body.sections && typeof body.sections === 'object' ? body : null
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let finalBody = null
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          try {
            const msg = JSON.parse(line)
            if (msg?.type === 'progress') {
              onProgress?.({ progress: msg.progress, stage: msg.stage, found: msg.found })
            } else if (msg?.type === 'partial' && msg.list?.sections) {
              onPartial?.(msg.list)
            } else if (msg?.type === 'done' && msg.list?.sections) {
              finalBody = msg.list
            }
          } catch {}
        }
      }
      const tail = buf.trim()
      if (tail) {
        try {
          const msg = JSON.parse(tail)
          if (msg?.type === 'done' && msg.list?.sections) finalBody = msg.list
        } catch {}
      }
      return finalBody
    } catch {
      return null
    }
  }

  async #remoteList (base, query, opts) {
    const anilistId = Number(query?.anilistId)
    const episode = Number(query?.episode) || 1
    if (!Number.isSafeInteger(anilistId) || anilistId <= 0) return null
    const fresh = opts?.fresh === true
    const fetchOpts = fresh ? { cache: 'no-store' } : undefined
    const wantsStream = typeof opts?.onProgress === 'function' || typeof opts?.onPartial === 'function'

    try {
      const res = await fetch(`${base}/anime/anilist/${anilistId}/${episode}.list.json`, fetchOpts)
      if (res.ok) {
        const body = await res.json()
        if (body && body.v === 2 && Array.isArray(body.releases)) return body
      }
    } catch {}

    // On a non-fresh request, check pre-built / seeded cache first for <5 ms instant responses.
    if (!fresh) {
      try {
        const qs = wantsStream ? '?cachedOnly=1' : ''
        const res = await fetch(`${base}/anime/anilist/${anilistId}/${episode}.rank.json${qs}`, fetchOpts)
        if (res.ok) {
          const body = await res.json()
          if (body && body.sections && typeof body.sections === 'object') return body
        }
      } catch {}
    }

    // Cache miss or fresh refresh: prefer streaming progress + partial results when the server supports /rank/stream.
    if (wantsStream) {
      try { opts.onProgress?.({ progress: 0.12, stage: 'Searching on your server…' }) } catch {}
      const streamed = await this.#streamRemoteRank(base, anilistId, episode, query, opts)
      if (streamed) return streamed
    }

    try {
      const res = await fetch(`${base}/anime/anilist/${anilistId}/${episode}.rank.json`, fetchOpts)
      if (res.ok) {
        const body = await res.json()
        if (body && body.sections && typeof body.sections === 'object') return body
      }
    } catch {}

    try {
      const res = await fetch(`${base}/rank`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ anilistId, episode, prefs: { resolution: query?.resolution || '1080' } })
      })
      if (res.ok) {
        const body = await res.json()
        if (body && body.sections && typeof body.sections === 'object') return body
      }
      if (res.status === 404 || res.status === 503) {
        fetch(`${base}/requests`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ anilistId, episode })
        }).catch(() => {})
      }
    } catch {}

    return null
  }

  /**
   * Primary Shiru structured-list entry point.
   * - If `indexUrl` is set (or provided by `sourcesUrl`): fetches `.list.json` / `.rank.json` / `POST /rank/stream` / `POST /rank`.
   * - Otherwise fetches live sources from `sourcesUrl` + `feedUrls` and runs Shiru's full matcher,
   *   verifier, and ranker directly inside this Web Worker, streaming progress & partial results via `opts`.
   * @param {import('../index.d.ts').TorrentQuery} query
   * @param {{ fresh?: boolean, onProgress?: Function, onPartial?: Function }} [opts]
   */
  async list (query, opts = {}) {
    this.#bindAnitomy()
    const fresh = opts?.fresh === true
    const cfg = await this.#resolveActiveConfig({ fresh })
    if (cfg.indexUrl) return this.#remoteList(cfg.indexUrl, query, opts)

    if (!cfg.sources.length) {
      throw new Error('Configure a Sources Manifest URL, Release Index URL, or Feed URLs in Extension Settings to search.')
    }
    const useAnizip = this.settings?.useAnizip !== false
    const enableUsenet = this.settings?.enableUsenet !== false
    const amenzbKey = String(this.settings?.amenzbApiKey || '').trim()
    return searchAndMatchLocally(query, cfg.sources, {
      useAnizip,
      fresh,
      trackers: cfg.trackers,
      enableUsenet,
      amenzbKey,
      onProgress: opts?.onProgress,
      onPartial: opts?.onPartial
    })
  }

  async #flatQuery (query) {
    this.#bindAnitomy()
    const cfg = await this.#resolveActiveConfig()
    if (cfg.indexUrl) {
      const anilistId = Number(query?.anilistId)
      const episode = Number(query?.episode) || 1
      if (!Number.isSafeInteger(anilistId) || anilistId <= 0) return []
      const trackers = await this.#loadTrackers(cfg.indexUrl)
      const res = await fetch(`${cfg.indexUrl}/anime/anilist/${anilistId}/${episode}.json`)
      if (!res.ok) return []
      const body = await res.json()
      const rows = Array.isArray(body?.releases) ? body.releases : []
      return rows.filter((r) => r && !r.stale && r.kind !== 'nzb').map((r) => toTorrentResult(r, trackers))
    }

    if (!cfg.sources.length) return []
    const useAnizip = this.settings?.useAnizip !== false
    const enableUsenet = this.settings?.enableUsenet !== false
    const amenzbKey = String(this.settings?.amenzbApiKey || '').trim()
    const { candidates } = await searchCandidatesWithParity(query, cfg.sources, {
      useAnizip,
      enableUsenet,
      amenzbKey
    })
    return candidates.filter((r) => r.kind !== 'nzb').map((r) => toTorrentResult(r, cfg.trackers))
  }

  single (query) { return this.#flatQuery(query) }
  batch () { return Promise.resolve([]) }
  movie (query) { return this.#flatQuery(query) }
}()
