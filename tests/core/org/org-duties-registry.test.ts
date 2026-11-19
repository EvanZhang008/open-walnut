/**
 * Every org duty is wired into the one generic switch (2026-11-19, the user: "each VP can turn on
 * some capability, we need to make it generic"; the lead: a test that fails when a new duty is not
 * wired in). A duty is a manifest `src/core/org/duties/<id>.duty.ts`; this fails when one is not in
 * the registry, when its id or text is off, or when a switch surface stops reading the registry and
 * names a duty of its own (the route, the op, the settings panel, the boot start).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { DUTY_ID_RE, ORG_DUTIES, dutyList } from '../../../src/core/org/duties/registry.js'

const ROOT = path.resolve(__dirname, '../../..')
const DIR = path.join(ROOT, 'src/core/org/duties')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

describe('org duties registry', () => {
  it('lists every duty manifest in the folder, and nothing else', async () => {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.duty.ts'))
    expect(files.length).toBeGreaterThan(0)
    const manifests: unknown[] = []
    for (const f of files) {
      const mod = await import(path.join(DIR, f)) as Record<string, unknown>
      const exported = Object.values(mod).filter((v) => !!v && typeof v === 'object' && 'id' in (v as object))
      expect(exported, `${f} exports one duty manifest`).toHaveLength(1)
      const duty = exported[0] as { id: string }
      expect(f, 'a manifest file is named after its id').toBe(`${duty.id}.duty.ts`)
      manifests.push(duty)
    }
    for (const m of manifests) expect(ORG_DUTIES, `${(m as { id: string }).id} is not in ORG_DUTIES (src/core/org/duties/registry.ts)`).toContain(m)
    expect(ORG_DUTIES).toHaveLength(manifests.length)
  })

  it('gives each duty a valid unique id, a name, a description and its roles', () => {
    const ids = ORG_DUTIES.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const d of ORG_DUTIES) {
      expect(d.id).toMatch(DUTY_ID_RE)
      expect(d.name.trim().length).toBeGreaterThan(3)
      expect(d.description.trim().length).toBeGreaterThan(20)
      expect(d.roles.length).toBeGreaterThan(0)
      for (const r of d.roles) expect(['main', 'lead']).toContain(r)
    }
    expect(dutyList().map((d) => d.id)).toEqual(ids)
  })

  it('keeps every switch surface on the registry, naming no duty of its own', () => {
    const surfaces = ['web/src/components/org/NodeDuties.tsx', 'web/src/api/org.ts', 'src/core/org/duties/node-duties.ts']
    for (const file of surfaces) {
      const text = read(file)
      for (const d of ORG_DUTIES) expect(text, `${file} names the "${d.id}" duty: read it from the registry instead`).not.toMatch(new RegExp(`['"\`]${d.id}['"\`]`))
    }
    expect(read('web/src/components/org/NodeDuties.tsx')).toContain('fetchOrgDuties')
    expect(read('src/web/routes/org-v1.ts')).toContain('dutyList()')
    expect(read('src/web/server.ts')).toMatch(/duties\/registry\.js'\)\.then\(\(m\) => m\.startOrgDuties\(/)
    expect(read('web/src/components/org/AgentMemoryPanel.tsx')).toContain('<NodeDuties')
    // The op lists every duty for the agents that switch them.
    const op = read('src/ops/org.ts')
    for (const d of ORG_DUTIES) expect(op, `org_duty_set's description names "${d.id}"`).toContain(`"${d.id}"`)
  })
})
