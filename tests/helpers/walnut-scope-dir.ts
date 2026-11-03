/**
 * Where a daemon keeps one Walnut's copy of a setting (walnut-scope-core.ts dirFor),
 * with the daemon twins' own key: '' is the legacy place, a named home is
 * base/walnuts/<sha1(home)[:16]>.
 */
import crypto from 'node:crypto'
import path from 'node:path'
import { createWalnutScope } from '../../src/providers/walnut-scope-core.js'

const scope = createWalnutScope({
  path,
  keyOf: (value) => crypto.createHash('sha1').update(value).digest('hex').slice(0, 16),
})

export function walnutScopeDir(base: string, home: string): string {
  return scope.dirFor(base, home)
}
