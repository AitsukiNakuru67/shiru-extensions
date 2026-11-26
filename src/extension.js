import AbstractSource from '../sources/abstract.js'
import { normalizeBaseUrl, parseFeedTemplates, fetchFeedCandidates } from './feeds.js'
import { matchCandidatesLocally } from './local-matcher.js'

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

  #feedTemplates () {
    return parseFeedTemplates(this.settings?.feedUrls || '')
  }

  #bindAnitomy () {
    if (typeof this.anitomyscript === 'function') {
      globalThis.__shiruAnitomyscript = this.anitomyscript
    }
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
    // Keep loadable when unconfigured or using feed URLs so the user can edit settings freely.
    return true
  }

  async #remoteList (base, query, opts) {
    const anilistId = Number(query?.anilistId)
    const episode = Number(query?.episode) || 1
    if (!Number.isSafeInteger(anilistId) || anilistId <= 0) return null
    const fetchOpts = opts?.fresh ? { cache: 'no-store' } : undefined

    try {
      const res = await fetch(`${base}/anime/anilist/${anilistId}/${episode}.list.json`, fetchOpts)
      if (res.ok) {
        const body = await res.json()
        if (body && body.v === 2 && Array.isArray(body.releases)) return body
      }
    } catch {}

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
   * - If `indexUrl` is set: fetches `.list.json` / `.rank.json` / `POST /rank` from the configured server.
   * - Else if `feedUrls` is set: fetches configured RSS/Torznab/JSON feeds live and runs Shiru's full
   *   matcher, verifier, and ranker directly inside this Web Worker.
   * @param {import('../index.d.ts').TorrentQuery} query
   * @param {{ fresh?: boolean }} [opts]
   */
  async list (query, opts = {}) {
    this.#bindAnitomy()
    const base = this.#indexBase()
    if (base) return this.#remoteList(base, query, opts)

    const templates = this.#feedTemplates()
    if (!templates.length) {
      throw new Error('Configure a Release Index URL or Feed URLs in Extension Settings to search.')
    }
    const candidates = await fetchFeedCandidates(templates, query, { fresh: opts?.fresh === true })
    return matchCandidatesLocally(query, candidates, {
      useAnizip: this.settings?.useAnizip !== false,
      fresh: opts?.fresh === true
    })
  }

  async #flatQuery (query) {
    this.#bindAnitomy()
    const base = this.#indexBase()
    if (base) {
      const anilistId = Number(query?.anilistId)
      const episode = Number(query?.episode) || 1
      if (!Number.isSafeInteger(anilistId) || anilistId <= 0) return []
      const trackers = await this.#loadTrackers(base)
      const res = await fetch(`${base}/anime/anilist/${anilistId}/${episode}.json`)
      if (!res.ok) return []
      const body = await res.json()
      const rows = Array.isArray(body?.releases) ? body.releases : []
      return rows.filter((r) => r && !r.stale && r.kind !== 'nzb').map((r) => toTorrentResult(r, trackers))
    }

    const templates = this.#feedTemplates()
    if (!templates.length) return []
    const candidates = await fetchFeedCandidates(templates, query)
    return candidates.filter((r) => r.kind !== 'nzb').map((r) => toTorrentResult(r))
  }

  single (query) { return this.#flatQuery(query) }
  batch () { return Promise.resolve([]) }
  movie (query) { return this.#flatQuery(query) }
}()
