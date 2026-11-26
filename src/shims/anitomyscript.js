/**
 * Worker shim for `anitomyscript`: delegates to the instance Shiru's `worker.js` injects onto `source.anitomyscript`
 * (bound to `globalThis.__shiruAnitomyscript` by `src/extension.js`), avoiding bundling a second copy of the WASM binary.
 */
export default async function anitomyscriptShim (...args) {
  const fn = globalThis.__shiruAnitomyscript
  if (typeof fn !== 'function') {
    throw new Error('anitomyscript is not available in this extension worker')
  }
  return fn(...args)
}
