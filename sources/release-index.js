import AbstractSource from './abstract.js'

const HEX40 = /^[0-9a-f]{40}$/i

/**
 * Normalize and validate an index base URL (HTTPS anywhere, or plain HTTP on loopback only).
 * @param {string} raw
 * @returns {string}
 */
function normalizeIndexBase (raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '')
  if (!s) return ''
  try {
    const u = new URL(s)
    if (u.protocol === 'https:') return u.origin + u.pathname.replace(/\/+$/, '')
    if (u.protocol === 'http:') {
      const h = u.hostname.toLowerCase()
      if (h === 'localhost' || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '[::1]' || h === '::1') {
        return u.origin + u.pathname.replace(/\/+$/, '')
      }
    }
  } catch {}
  return ''
}

/**
 * Convert an index episode JSON row into a standard Shiru `TorrentResult` for legacy `single`/`batch`/`movie` callers.
 * @param {any} row
 * @param {string[]} trackers
 */
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

export default new class ReleaseIndexExtension extends AbstractSource {
  #trackers = []
  #trackersBase = ''

  /** @returns {string} */
  #base () {
    return normalizeIndexBase(this.settings?.indexUrl || '')
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

  /**
   * Validate configured server (if a URL is set, check `/health.json` or `/site.json`;
   * if unset, stay loadable so the user can configure `indexUrl` in Extension Settings).
   */
  async validate () {
    const base = this.#base()
    if (!base) return true
    try {
      const res = await fetch(`${base}/site.json`)
      if (res.ok) return true
      const h = await fetch(`${base}/health.json`)
      return h.ok
    } catch {
      return false
    }
  }

  /**
   * Primary Shiru structured-list entry point: returns `.list.json` v2 (preferred) or `.rank.json` / `POST /rank`
   * so Shiru performs full local ordering, sectioning, crowns, resolution re-ordering, and AutoGrab picking.
   * @param {import('../index.d.ts').TorrentQuery} query
   * @param {{ fresh?: boolean }} [opts]
   */
  async list (query, opts = {}) {
    const base = this.#base()
    if (!base) throw new Error('Set your Release Index URL in Extension Settings to load releases.')
    const anilistId = Number(query?.anilistId)
    const episode = Number(query?.episode) || 1
    if (!Number.isSafeInteger(anilistId) || anilistId <= 0) return null
    const fetchOpts = opts?.fresh ? { cache: 'no-store' } : undefined

    // 1. Primary: complete `.list.json` v2 for 100% local ranking & instant quality re-ordering.
    try {
      const res = await fetch(`${base}/anime/anilist/${anilistId}/${episode}.list.json`, fetchOpts)
      if (res.ok) {
        const body = await res.json()
        if (body && body.v === 2 && Array.isArray(body.releases)) return body
      }
    } catch {}

    // 2. Fallback: prebuilt `.rank.json`.
    try {
      const res = await fetch(`${base}/anime/anilist/${anilistId}/${episode}.rank.json`, fetchOpts)
      if (res.ok) {
        const body = await res.json()
        if (body && body.sections && typeof body.sections === 'object') return body
      }
    } catch {}

    // 3. Fallback: POST /rank (and queue POST /requests if the episode is not judged yet).
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

  /** Legacy flat-search fallback (`single` / `batch` / `movie`). */
  async #flatQuery (query) {
    const base = this.#base()
    if (!base) throw new Error('Set your Release Index URL in Extension Settings to load releases.')
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

  single (query) { return this.#flatQuery(query) }
  batch () { return Promise.resolve([]) }
  movie (query) { return this.#flatQuery(query) }
}()
