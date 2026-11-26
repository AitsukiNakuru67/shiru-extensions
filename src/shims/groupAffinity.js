export { foldGroup, foldGroupFamily, groupsMatch } from '../../vendor/matcher/common/modules/seasonal/grab/groupFold.js'
export function lastGroupFor () { return null }
export function lastLineFor () { return null }
export function effectivePreferredGroup () { return null }
export function rememberGroup () {}
export function clearGroup () { return false }
export const groupAffinityVersion = { value: 0, subscribe (fn) { fn(0); return () => {} } }
