/**
 * Downloads, verifies (SHA-256), extracts, and indexes the sanitized Pixeldrain seed archive
 * into `./data/seed` so `server/local-index.mjs` serves ~63,000+ verified episodes in < 5 ms.
 *
 * Usage:
 *   node scripts/import-seed.mjs [--url <seedUrl>] [--meta-url <seedMetaUrl>] [--dir ./data/seed] [--force]
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { importSeed, DEFAULT_SEED_URL, DEFAULT_SEED_META_URL } from '../server/seed-store.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }

const seedUrl = arg('--url', process.env.SEED_URL || DEFAULT_SEED_URL)
const seedMetaUrl = arg('--meta-url', process.env.SEED_META_URL || DEFAULT_SEED_META_URL)
const seedDir = path.resolve(arg('--dir', process.env.SEED_DIR || path.join(ROOT, 'data/seed')))
const force = argv.includes('--force')

importSeed({ seedUrl, seedMetaUrl, seedDir, force })
  .then((res) => {
    console.log(JSON.stringify(res, null, 2))
  })
  .catch((err) => {
    console.error('[import-seed] failed:', err?.message || err)
    process.exit(1)
  })
