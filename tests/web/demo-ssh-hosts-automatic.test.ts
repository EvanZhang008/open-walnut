/**
 * Walnut Demo lists the person's own SSH hosts by itself (src/commands/demo-real-ssh.ts
 * startDemoRealSsh): no page offers a "Use my SSH hosts" click, and no host list says the Demo
 * lists only its own hosts (2026-11-12, the user: "the detection is automatic, no need a click").
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(__dirname, '../../web/src')

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return sources(p)
    return /\.(tsx?|css)$/.test(e.name) ? [p] : []
  })
}

describe('the Demo host lists need no click to show the person\'s SSH hosts', () => {
  it('no web source offers "Use my SSH hosts" or says the Demo lists only its own hosts', () => {
    const hits = sources(root).filter((f) => /Use my SSH hosts|lists only its own SSH hosts|demo-ssh-hosts-use|DemoSshHostsOptIn/.test(fs.readFileSync(f, 'utf8')))
    expect(hits.map((f) => path.relative(root, f))).toEqual([])
  })
})
