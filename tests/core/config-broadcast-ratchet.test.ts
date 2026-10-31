/**
 * Every `config:changed` that carries a config goes out in the client view.
 *
 * The `web-ui` subscriber sends `config:changed` to every connected web client
 * as it is, so a config it carries is an answer like `GET /api/config`. Two
 * hooks routes once emitted `getConfig()` raw, and every client received the
 * full push device tokens and the relayed rows' claims.
 *
 * Two halves, because either alone can be fooled:
 *  - the source: every `.emit(...)` and `broadcastEvent(...)` of
 *    `config:changed` in src is read with the TypeScript parser. One that
 *    carries anything but a `key` is allowed only in src/core/config-broadcast.ts,
 *    whose one emit wraps the config in `configForClients`;
 *  - the helper and the exit: `emitConfigChanged`, through the real bus, hands
 *    every subscriber the client view (the Mac's and a replica's), and
 *    `configChangedForClients`, which the WebSocket exit applies to every
 *    `config:changed` frame, turns a raw payload into that view.
 */
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { createMockConstants } from '../helpers/mock-constants.js'

const box = vi.hoisted(() => ({ cloud: false }))
vi.mock('../../src/constants.js', () => ({
  ...createMockConstants('config-broadcast-ratchet'),
  get CLOUD_MODE() { return box.cloud },
}))

import { bus, EventNames } from '../../src/core/event-bus.js'
import { configChangedForClients, configForClients, emitConfigChanged } from '../../src/core/config-broadcast.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const HELPER = 'src/core/config-broadcast.ts'
const eventValues = EventNames as unknown as Record<string, string>

interface Emit { file: string; line: number; kind: 'emit' | 'broadcastEvent'; payload: string; keyOnly: boolean; viaHelperView: boolean }

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') sourceFiles(p, out) }
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

function isConfigChanged(node: ts.Expression | undefined, sf: ts.SourceFile): boolean {
  if (!node) return false
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text === 'config:changed'
  if (ts.isPropertyAccessExpression(node) && node.expression.getText(sf) === 'EventNames') {
    return eventValues[node.name.text] === 'config:changed'
  }
  return false
}

/** Only `{ key: ... }`: the narrow UI-state notices, which carry no config. */
function keyOnly(node: ts.Expression | undefined): boolean {
  if (!node || !ts.isObjectLiteralExpression(node)) return false
  return node.properties.every((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'key')
}

/** `{ config: configForClients(...) }` (a cast around the call is fine). */
function viaHelperView(node: ts.Expression | undefined, sf: ts.SourceFile): boolean {
  if (!node || !ts.isObjectLiteralExpression(node) || node.properties.length !== 1) return false
  const [p] = node.properties
  if (!ts.isPropertyAssignment(p) || p.name.getText(sf) !== 'config') return false
  let v: ts.Expression = p.initializer
  while (ts.isAsExpression(v) || ts.isParenthesizedExpression(v)) v = v.expression
  return ts.isCallExpression(v) && v.expression.getText(sf) === 'configForClients'
}

/** Every emit of `config:changed` in one source text. */
function scanText(file: string, text: string): Emit[] {
  const out: Emit[] = []
  if (!text.includes('config:changed') && !text.includes('CONFIG_CHANGED')) return out
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const c = n.expression
      const kind = ts.isPropertyAccessExpression(c) && c.name.text === 'emit' ? 'emit'
        : (ts.isIdentifier(c) && c.text === 'broadcastEvent') || (ts.isPropertyAccessExpression(c) && c.name.text === 'broadcastEvent') ? 'broadcastEvent'
          : null
      if (kind && isConfigChanged(n.arguments[0], sf)) {
        const payload = n.arguments[1]
        out.push({
          file, kind,
          line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
          payload: payload ? payload.getText(sf).replace(/\s+/g, ' ') : '',
          keyOnly: keyOnly(payload),
          viaHelperView: viaHelperView(payload, sf),
        })
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/** Emits that break the rule: a payload with more than a `key`, outside the helper or not in its view. */
function violations(emits: Emit[]): string[] {
  return emits
    .filter((e) => !e.keyOnly && !(e.file === HELPER && e.viaHelperView))
    .map((e) => `${e.file}:${e.line} ${e.kind}(config:changed, ${e.payload})`)
}

function scanSrc(): Emit[] {
  return sourceFiles(path.join(ROOT, 'src')).flatMap((f) => scanText(path.relative(ROOT, f), fs.readFileSync(f, 'utf8')))
}

describe('the source: config:changed carries a config only through the helper', () => {
  const emits = scanSrc()

  it('no emit outside src/core/config-broadcast.ts carries more than a key', () => {
    expect(violations(emits)).toEqual([])
  })

  it('the scan sees the emits it judges: the narrow notices, and the helper\'s one emit in the client view', () => {
    // A scanner that found nothing would pass the check above.
    expect(emits.filter((e) => e.keyOnly).length).toBeGreaterThan(20)
    expect(emits.filter((e) => e.file === HELPER).map((e) => e.viaHelperView)).toEqual([true])
    // The writers that carry a config call the helper.
    const callers = sourceFiles(path.join(ROOT, 'src'))
      .filter((f) => /\bemitConfigChanged\(/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f)).sort()
    expect(callers).toEqual([
      'src/core/config-broadcast.ts',
      'src/core/plugins/server-api.ts',
      'src/core/stt/auto-setup.ts',
      'src/web/routes/config.ts',
      'src/web/routes/expose.ts',
      'src/web/routes/hooks.ts',
      'src/web/routes/host-servers.ts',
      'src/web/routes/plugin-jobs-routes.ts',
      'src/web/routes/test-host-fixture.ts',
    ])
  })

  it('the rule bites: a raw config, a payload variable, a direct broadcast and a key beside a config are all caught', () => {
    const sample = [
      "bus.emit(EventNames.CONFIG_CHANGED, { config: await getConfig() }, ['web-ui'], { source: 'x' })",
      "bus.emit('config:changed', payload, ['web-ui'])",
      "broadcastEvent('config:changed', { config })",
      "bus.emit(EventNames.CONFIG_CHANGED, { key: 'hosts', config: fresh }, ['web-ui'])",
      "bus.emit(EventNames.CONFIG_CHANGED, { config: maskPushTokens(fresh) }, ['web-ui'])",
      "bus.emit(EventNames.CONFIG_CHANGED, { key: 'favorites' }, ['web-ui'])",
      "broadcastEvent('config:changed', { key: 'hosts' })",
      "bus.emit(EventNames.TASK_UPDATED, { config: raw }, ['web-ui'])",
    ].join('\n')
    const found = violations(scanText('src/web/routes/sample.ts', sample))
    expect(found).toHaveLength(5)
    // Even inside the helper file, only the client view passes.
    expect(violations(scanText(HELPER, "bus.emit(EventNames.CONFIG_CHANGED, { config }, d, o)"))).toHaveLength(1)
  })
})

describe('the helper and the WebSocket exit hand out the client view', () => {
  const TOKEN = 'ab'.repeat(32)
  const CLAIM = 'cd'.repeat(16)
  const SECRET = 'acme-provider-secret-value-1234'
  const raw = () => ({
    push_tokens: [{ token: TOKEN, key_name: 'acme-tablet', origin: 'relay', claims: [CLAIM] }],
    providers: { anthropic: { api_key: SECRET } },
  })

  async function heard(emit: () => void): Promise<string> {
    const seen: string[] = []
    bus.subscribe('config-broadcast-probe', (event) => {
      if (event.name === EventNames.CONFIG_CHANGED) seen.push(JSON.stringify(event.data))
    }, { global: true })
    try {
      emit()
      await new Promise((r) => setTimeout(r, 10))
    } finally {
      bus.unsubscribe('config-broadcast-probe')
    }
    expect(seen).toHaveLength(1)
    return seen[0]
  }

  it('on the Mac: every push token masked, its claims dropped, the rest as GET /api/config shows it', async () => {
    box.cloud = false
    const input = raw()
    const text = await heard(() => emitConfigChanged(input, ['web-ui'], { source: 'test' }))
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(CLAIM)
    expect(text).toContain(TOKEN.slice(-4))
    expect(text).toContain(SECRET)
    expect(JSON.parse(text)).toEqual({ config: configForClients(raw()) })
    // The caller's object is untouched: the registry and the next write still see the real rows.
    expect(input).toEqual(raw())
  })

  it('on a replica: every secret masked as well, the view its GET /api/config answers with', async () => {
    box.cloud = true
    try {
      const text = await heard(() => emitConfigChanged(raw(), ['web-ui']))
      expect(text).not.toContain(TOKEN)
      expect(text).not.toContain(CLAIM)
      expect(text).not.toContain(SECRET)
      expect(text).toContain(SECRET.slice(-4))
    } finally {
      box.cloud = false
    }
  })

  it('the exit view: a raw payload comes out masked, a key-only notice and a missing config as they were', () => {
    const out = JSON.stringify(configChangedForClients({ config: raw(), source: 'relay' }))
    expect(out).not.toContain(TOKEN)
    expect(out).not.toContain(CLAIM)
    expect(out).toContain('"source":"relay"')
    // Applying it twice changes nothing (the helper already did it once at the source).
    const once = configChangedForClients({ config: raw() })
    expect(configChangedForClients(once)).toEqual(once)
    const notice = { key: 'favorites' }
    expect(configChangedForClients(notice)).toBe(notice)
    expect(configChangedForClients(undefined)).toBeUndefined()
  })
})
