/**
 * Overwrites `/me/shiru-sources/sources.json` in place on Pixeldrain Filesystem so the permanent
 * public share URL (`https://pixeldrain.com/api/filesystem/qkW71xWE/sources.json`) updates live
 * without changing links or touching GitHub.
 *
 * Usage:
 *   PIXELDRAIN_API_KEY=... node scripts/publish-sources.mjs [sources.local.json]
 *   node scripts/publish-sources.mjs sources.local.json --key-file <path>
 */
import fs from 'node:fs'
import path from 'node:path'

const PUBLIC_FOLDER_ID = 'qkW71xWE'
const REMOTE_PATH = 'shiru-sources/sources.json'

const argv = process.argv.slice(2)
const argVal = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : '' }
const positional = argv.filter((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1].startsWith('--')))

const srcFile = path.resolve(positional[0] || 'sources.local.json')
const keyFile = argVal('--key-file')
const key = String(process.env.PIXELDRAIN_API_KEY || (keyFile && fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8') : '')).trim()

if (!key) {
  console.error('Missing Pixeldrain API key: set PIXELDRAIN_API_KEY or pass --key-file <path>')
  process.exit(1)
}
if (!fs.existsSync(srcFile)) {
  console.error(`Source manifest not found: ${srcFile}`)
  process.exit(1)
}

const parsed = JSON.parse(fs.readFileSync(srcFile, 'utf8'))
if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sources)) {
  console.error('Invalid manifest JSON: expected an object with a `sources` array')
  process.exit(1)
}

parsed.updatedAt = new Date().toISOString()
parsed.revision = (Number(parsed.revision) || 0) + 1
const body = JSON.stringify(parsed, null, 2) + '\n'
fs.writeFileSync(srcFile, body)

const auth = 'Basic ' + Buffer.from(':' + key).toString('base64')
const putRes = await fetch(`https://pixeldrain.com/api/filesystem/me/${REMOTE_PATH}?make_parents=true`, {
  method: 'PUT',
  headers: { authorization: auth, 'content-type': 'application/json' },
  body
})
if (!putRes.ok) {
  console.error(`Pixeldrain PUT failed: HTTP ${putRes.status} ${(await putRes.text()).slice(0, 200)}`)
  process.exit(1)
}

const publicUrl = `https://pixeldrain.com/api/filesystem/${PUBLIC_FOLDER_ID}/sources.json`
const checkRes = await fetch(publicUrl, { cache: 'no-store' })
if (!checkRes.ok) {
  console.error(`Public verification failed: HTTP ${checkRes.status}`)
  process.exit(1)
}
const verified = await checkRes.json()
console.log(JSON.stringify({
  published: true,
  publicUrl,
  revision: verified.revision,
  sources: verified.sources?.length || 0,
  updatedAt: verified.updatedAt
}, null, 2))
