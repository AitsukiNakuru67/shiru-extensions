/**
 * Sync the pure-JS matcher core + data tables from `anime-release-index/src/shiru/common/modules`
 * into `vendor/matcher/common/modules` so `scripts/build.mjs` can bundle them into one Worker ESM file.
 *
 * Usage:
 *   node scripts/sync-matcher.mjs [--from D:/Projekty/anime-release-index/src/shiru]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fromArgIdx = process.argv.indexOf('--from')
const SRC_SHIRU = fromArgIdx >= 0 && process.argv[fromArgIdx + 1]
  ? path.resolve(process.argv[fromArgIdx + 1])
  : path.resolve(ROOT, '../anime-release-index/src/shiru')

const DEST = path.join(ROOT, 'vendor/matcher')

const SKIP_DIRS = new Set(['node_modules', '.git'])
const COPY_SUBDIRS = [
  'common/modules/seasonal/grab',
  'common/modules/seasonal/defaults.js',
  'common/modules/anime/anitomyParse.js',
  'common/modules/anime/anitomyGroup.js',
  'common/modules/anime/anidbEid.js',
  'common/modules/anime/cleanFileName.js',
  'common/modules/anime/episodeFromName.js',
  'common/modules/anime/releaseLanguage.js',
  'common/modules/anime/releaseTitleClean.js',
  'common/modules/anime/titleOwnedTokens.js',
  'common/modules/anime/videoFiles.js',
  'common/modules/episodeCompanions.js',
  'common/modules/torrentSafety.js',
  'common/modules/scopedState.js',
  'common/modules/extensions/resultDedupe.js'
]

function copyFiltered (src, dst) {
  const st = fs.statSync(src)
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true })
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue
      if (/\.(selftest|test)\.(m?js)$/.test(e.name) || e.name === 'selftest.mjs') continue
      copyFiltered(path.join(src, e.name), path.join(dst, e.name))
    }
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
  }
}

if (!fs.existsSync(path.join(SRC_SHIRU, 'common/modules/seasonal/grab/modalJudge.js'))) {
  console.error(`Matcher source not found under: ${SRC_SHIRU}`)
  process.exit(1)
}

fs.rmSync(DEST, { recursive: true, force: true })
fs.mkdirSync(DEST, { recursive: true })

let count = 0
for (const rel of COPY_SUBDIRS) {
  const from = path.join(SRC_SHIRU, rel)
  const to = path.join(DEST, rel)
  if (!fs.existsSync(from)) {
    console.warn(`skip missing: ${rel}`)
    continue
  }
  copyFiltered(from, to)
  count++
}

console.log(`Synced ${count} matcher trees/files from ${SRC_SHIRU} -> ${DEST}`)
