const CLEAN_RX = /[^\p{L}\p{N}\s]+/gu

function levenshtein (a, b) {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  if (!m) return n
  if (!n) return m
  let prev = new Uint16Array(n + 1)
  let curr = new Uint16Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    const tmp = prev; prev = curr; curr = tmp
  }
  return prev[n]
}

export function matchPhrase (search, phrase, threshold = 2, strict = false) {
  if (!search || !phrase) return false
  const normalizedSearch = String(search).toLowerCase().replace(CLEAN_RX, '')
  const phrases = Array.isArray(phrase) ? phrase : [phrase]
  for (const p of phrases) {
    if (!p) continue
    const normalizedPhrase = String(p).toLowerCase().replace(CLEAN_RX, '')
    if (!normalizedPhrase) continue
    if (strict) {
      if (levenshtein(normalizedSearch, normalizedPhrase) <= threshold) return true
    } else {
      if (normalizedSearch.includes(normalizedPhrase)) return true
      for (const word of normalizedSearch.split(/\s+/)) {
        if (word && levenshtein(word, normalizedPhrase) <= threshold) return true
      }
    }
  }
  return false
}
