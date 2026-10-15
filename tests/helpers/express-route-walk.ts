/**
 * Every route an express 5 app serves, as `{method, path}`, for ratchets that
 * must see the whole surface (tests/replica/route-table-coverage.test.ts).
 *
 * express 5 (router 2.x) keeps a route's path on `layer.route.path`, but a
 * mounted router's path only as a compiled matcher. So `installMountRecorder()`
 * must run BEFORE the app is built: it wraps `Router.prototype.use` to note the
 * mount path on each layer it adds. `walkRoutes(app)` then reads the stack
 * recursively.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const MOUNT = Symbol.for('walnut.test.mountPath')

interface LayerLike {
  route?: { path: unknown; methods?: Record<string, boolean> }
  handle?: { stack?: LayerLike[] }
  [MOUNT]?: string[]
}

let installed = false

/** Note each `use()` mount path on its layer (idempotent). */
export function installMountRecorder(): void {
  if (installed) return
  installed = true
  // express resolves `router` from its own dir; take that exact module instance.
  const expressDir = require.resolve('express')
  const Router = createRequire(expressDir)('router') as { prototype: { use: (...args: unknown[]) => unknown; stack?: LayerLike[] } }
  const original = Router.prototype.use
  Router.prototype.use = function patchedUse(this: { stack: LayerLike[] }, ...args: unknown[]) {
    const before = this.stack.length
    const out = original.apply(this, args)
    const first = args[0]
    const paths = typeof first === 'string' ? [first]
      : Array.isArray(first) && first.every((p) => typeof p === 'string') ? first as string[]
        : first instanceof RegExp ? [`<regexp ${first.source}>`] : ['/']
    for (let i = before; i < this.stack.length; i++) this.stack[i]![MOUNT] = paths
    return out
  }
}

export interface WalkedRoute { method: string; path: string }

function join(a: string, b: string): string {
  const s = `${a.replace(/\/+$/, '')}/${b.replace(/^\/+/, '')}`
  return s.length > 1 ? s.replace(/\/+$/, '') : s
}

/** Every route of `app` (methods upper-case; `ALL` for app.all / router.all). */
export function walkRoutes(app: { router?: { stack?: LayerLike[] } }): WalkedRoute[] {
  const out: WalkedRoute[] = []
  const visit = (stack: LayerLike[], prefixes: string[]) => {
    for (const layer of stack) {
      if (layer.route) {
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path]
        const methods = Object.keys(layer.route.methods ?? {}).filter((m) => layer.route!.methods![m])
        for (const prefix of prefixes) {
          for (const p of paths) {
            const full = join(prefix, typeof p === 'string' ? p : `<regexp ${String(p)}>`)
            for (const m of methods) out.push({ method: m === '_all' ? 'ALL' : m.toUpperCase(), path: full })
          }
        }
        continue
      }
      const inner = layer.handle?.stack
      if (Array.isArray(inner)) {
        const mounts = layer[MOUNT] ?? ['/']
        visit(inner, prefixes.flatMap((p) => mounts.map((m) => join(p, m))))
      }
    }
  }
  visit(app.router?.stack ?? [], ['/'])
  return out
}
