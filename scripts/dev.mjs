/**
 * Dev watch mode for shiru-extensions:
 * Watches `src/` and `vendor/matcher/` and rebuilds `sources/release-index.js` in ~150 ms on every save.
 * Pair with adding `D:\Projekty\shiru-extensions\index.json` as a local extension path in Shiru
 * (`Settings → Extensions`) to test changes locally without pushing to GitHub or waiting on esm.sh.
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { context } from 'esbuild'

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
    b.onResolve({ filter: /^anitomyscript$/ }, () => ({ path: path.join(SHIMS, 'anitomyscript.js') }))
    b.onResolve({ filter: /^debug$/ }, () => ({ path: path.join(SHIMS, 'debug.js') }))
    b.onResolve({ filter: /^(parse-torrent|bencode|uint8-util)$/ }, () => ({ path: path.join(SHIMS, 'noop.js') }))
    b.onResolve({ filter: /^@\/modules\/bridge\.js$/ }, () => ({ path: path.join(SHIMS, 'noop.js') }))
    b.onResolve({ filter: /^@\/modules\/util\.js$/ }, () => ({ path: path.join(SHIMS, 'util.js') }))
    b.onResolve({ filter: /^@\/modules\/settings\.js$/ }, () => ({ path: path.join(SHIMS, 'seasonalSettings.js') }))
    b.onResolve({ filter: /^@\// }, (args) => ({ path: path.join(VENDOR_COMMON, args.path.slice(2)) }))
    b.onResolve({ filter: /^\.\.\/settings\.js$/ }, (args) =>
      args.importer.replace(/\\/g, '/').includes('/vendor/matcher/common/modules/seasonal/grab/')
        ? { path: path.join(SHIMS, 'seasonalSettings.js') }
        : null
    )
    b.onResolve({ filter: /^\.\/releaseIndexClient\.js$/ }, (args) =>
      args.importer.replace(/\\/g, '/').includes('/vendor/matcher/common/modules/seasonal/grab/')
        ? { path: path.join(SHIMS, 'releaseIndexClient.js') }
        : null
    )
    b.onResolve({ filter: /^\.\/groupAffinity\.js$/ }, (args) =>
      args.importer.replace(/\\/g, '/').includes('/vendor/matcher/common/modules/seasonal/grab/')
        ? { path: path.join(SHIMS, 'groupAffinity.js') }
        : null
    )
    b.onEnd((res) => {
      const ts = new Date().toLocaleTimeString()
      if (res.errors?.length) console.error(`[dev ${ts}] build failed (${res.errors.length} errors)`)
      else console.log(`[dev ${ts}] rebuilt sources/release-index.js`)
    })
  }
}

const ctx = await context({
  entryPoints: [path.join(ROOT, 'src/extension.js')],
  outfile: path.join(ROOT, 'sources/release-index.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minifySyntax: true,
  minifyWhitespace: true,
  keepNames: true,
  plugins: [workerShimsPlugin]
})

await ctx.watch()
console.log('[dev] watching src/ and vendor/matcher/ -> sources/release-index.js')
