/**
 * Bundle `src/extension.js` + Shiru's pure-JS matcher core into a single self-contained
 * Web Worker ES module at `sources/release-index.js`.
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR_COMMON = path.join(ROOT, 'vendor/matcher/common')
const SHIMS = path.join(ROOT, 'src/shims')

if (!fs.existsSync(path.join(VENDOR_COMMON, 'modules/seasonal/grab/modalJudge.js'))) {
  console.error('vendor/matcher missing — run `node scripts/sync-matcher.mjs` first.')
  process.exit(1)
}

const workerShimsPlugin = {
  name: 'shiru-worker-shims',
  setup (b) {
    // Package shims (Worker-native / zero external npm runtime deps)
    b.onResolve({ filter: /^anitomyscript$/ }, () => ({ path: path.join(SHIMS, 'anitomyscript.js') }))
    b.onResolve({ filter: /^debug$/ }, () => ({ path: path.join(SHIMS, 'debug.js') }))
    b.onResolve({ filter: /^(parse-torrent|bencode|uint8-util)$/ }, () => ({ path: path.join(SHIMS, 'noop.js') }))

    // `@/` alias -> synced vendor/matcher/common/ (with thin shims for renderer-only files)
    b.onResolve({ filter: /^@\/modules\/bridge\.js$/ }, () => ({ path: path.join(SHIMS, 'noop.js') }))
    b.onResolve({ filter: /^@\/modules\/util\.js$/ }, () => ({ path: path.join(SHIMS, 'util.js') }))
    b.onResolve({ filter: /^@\/modules\/settings\.js$/ }, () => ({ path: path.join(SHIMS, 'seasonalSettings.js') }))
    b.onResolve({ filter: /^@\// }, (args) => {
      const rel = args.path.slice(2)
      return { path: path.join(VENDOR_COMMON, rel) }
    })

    // Relative shims inside vendor/matcher/common/modules/seasonal/grab/
    b.onResolve({ filter: /^\.\.\/settings\.js$/ }, (args) => {
      if (args.importer.replace(/\\/g, '/').includes('/vendor/matcher/common/modules/seasonal/grab/')) {
        return { path: path.join(SHIMS, 'seasonalSettings.js') }
      }
      return null
    })
    b.onResolve({ filter: /^\.\/releaseIndexClient\.js$/ }, (args) => {
      if (args.importer.replace(/\\/g, '/').includes('/vendor/matcher/common/modules/seasonal/grab/')) {
        return { path: path.join(SHIMS, 'releaseIndexClient.js') }
      }
      return null
    })
    b.onResolve({ filter: /^\.\/groupAffinity\.js$/ }, (args) => {
      if (args.importer.replace(/\\/g, '/').includes('/vendor/matcher/common/modules/seasonal/grab/')) {
        return { path: path.join(SHIMS, 'groupAffinity.js') }
      }
      return null
    })
  }
}

const outFile = path.join(ROOT, 'sources/release-index.js')
const result = await build({
  entryPoints: [path.join(ROOT, 'src/extension.js')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  define: {
    'process.env': '{}',
    process: 'undefined'
  },
  minifySyntax: true,
  minifyWhitespace: true,
  keepNames: true,
  metafile: true,
  plugins: [workerShimsPlugin]
})

const bytes = fs.statSync(outFile).size
const inputs = Object.keys(result.metafile.inputs).length
console.log(`Built ${path.relative(ROOT, outFile)} (${(bytes / 1024).toFixed(1)} KB, ${inputs} modules bundled)`)
