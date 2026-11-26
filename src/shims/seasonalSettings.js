import { DEFAULT_SEASONAL } from '../../vendor/matcher/common/modules/seasonal/defaults.js'

const state = {
  subtitleLanguage: 'eng',
  audioLanguage: 'jpn',
  adult: 'none',
  seasonal: structuredClone(DEFAULT_SEASONAL)
}

export const settings = {
  get value () { return state },
  set value (next) { Object.assign(state, next || {}) }
}

export function setWorkerViewerSettings (patch = {}) {
  if (patch.subtitleLanguage) state.subtitleLanguage = String(patch.subtitleLanguage)
  if (patch.audioLanguage) state.audioLanguage = String(patch.audioLanguage)
  if (patch.adult) state.adult = String(patch.adult)
  if (patch.seasonal) state.seasonal = { ...DEFAULT_SEASONAL, ...patch.seasonal }
}

export function viewerLanguages () {
  return {
    subtitleLanguage: String(state.subtitleLanguage || 'eng'),
    audioLanguage: String(state.audioLanguage || 'jpn')
  }
}

export function getSeasonalSettings () {
  return {
    ...DEFAULT_SEASONAL,
    ...(state.seasonal || {}),
    usenet: { ...DEFAULT_SEASONAL.usenet, ...(state.seasonal?.usenet || {}) },
    sortEngine: {
      ...DEFAULT_SEASONAL.sortEngine,
      ...(state.seasonal?.sortEngine || {}),
      weights: { ...DEFAULT_SEASONAL.sortEngine.weights, ...(state.seasonal?.sortEngine?.weights || {}) }
    }
  }
}

export function ensureSeasonalSettings () { return getSeasonalSettings() }
export function updateSeasonalSettings (patch) { state.seasonal = { ...getSeasonalSettings(), ...(patch || {}) } }
export const seasonalSettings = { get value () { return getSeasonalSettings() }, subscribe (fn) { fn(getSeasonalSettings()); return () => {} } }
