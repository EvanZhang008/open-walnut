/**
 * The shipped Apple Health recipes: three skills and two routine templates.
 * Templates must parse, stay OFF by default, pass the real routine normalizer,
 * and wake on the event the server actually emits. Every skill carries the privacy
 * rule, names only ops that exist, and uses no em or en dash.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { normalizeCronJobCreate } from '../../../src/core/cron/normalize.js'
import { EventNames } from '../../../src/core/event-bus.js'
import { getOp } from '../../../src/ops/index.js'

const ROOT = path.resolve(__dirname, '../../../src/data')
const SKILLS = ['health-sleep-report', 'morning-brief', 'weekly-health-trend']
const TEMPLATES = ['morning-brief', 'weekly-health-trend']
const DASHES = /[–—]/
const opsNamed = (text: string): string[] => [...text.matchAll(/tools call ([a-z_]+)/g)].map((m) => m[1])

describe('Apple Health routine templates', () => {
  for (const id of TEMPLATES) {
    it(`${id}: parses, is off by default, and normalizes as a routine`, () => {
      const raw = fs.readFileSync(path.join(ROOT, 'routine-templates', `${id}.json`), 'utf-8')
      const tpl = JSON.parse(raw)
      expect(tpl.id).toBe(id)
      expect(tpl.enabledByDefault).toBe(false)
      expect(tpl.routine.enabled).toBe(false)
      const job = normalizeCronJobCreate(tpl.routine)
      expect(job, id).not.toBeNull()
      expect(job!.enabled).toBe(false)
      expect(job!.executor).toMatchObject({ type: 'walnut-agent' })
      expect(DASHES.test(raw)).toBe(false)
      for (const op of opsNamed(raw)) expect(getOp(op), `${id} names ${op}`).toBeTruthy()
      expect(raw).not.toMatch(/tools call api\b/)
      expect(raw).toMatch(/[Nn]ever write health numbers into MEMORY\.md or USER\.md/)
      // Honest privacy wording: the samples stay on the Mac, the letter does not.
      expect(tpl.about).toMatch(/off until the user turns it on/)
      expect(tpl.about).toMatch(/serves the samples only to sessions on this Mac and never syncs them/)
      expect(tpl.about).toMatch(/syncs like any other letter/)
      expect(raw).toMatch(/Summarize, never paste raw series/)
    })
  }

  it('morning-brief wakes once per wake date on health:sleep-ready, weekly runs Sunday 19:00', () => {
    const brief = normalizeCronJobCreate(JSON.parse(fs.readFileSync(path.join(ROOT, 'routine-templates', 'morning-brief.json'), 'utf-8')).routine)!
    expect(brief.wake).toEqual({ events: [EventNames.HEALTH_SLEEP_READY], threshold: 1, skipWhenIdle: true })
    expect(EventNames.HEALTH_SLEEP_READY).toBe('health:sleep-ready')
    const weekly = normalizeCronJobCreate(JSON.parse(fs.readFileSync(path.join(ROOT, 'routine-templates', 'weekly-health-trend.json'), 'utf-8')).routine)!
    expect(weekly.schedule).toMatchObject({ kind: 'cron', expr: '0 19 * * 0' })
    expect(weekly.wake).toBeUndefined()
  })
})

describe('Apple Health skills', () => {
  for (const dir of SKILLS) {
    it(`${dir}: frontmatter, privacy rule, real ops, no dashes`, () => {
      const text = fs.readFileSync(path.join(ROOT, 'skills', dir, 'SKILL.md'), 'utf-8')
      expect(text.startsWith('---\n')).toBe(true)
      expect(text).toMatch(new RegExp(`^name: ${dir}$`, 'm'))
      expect(text).toMatch(/^description: /m)
      expect(text).toMatch(/Never write health numbers into MEMORY\.md or USER\.md/)
      expect(DASHES.test(text), `${dir} has an em or en dash`).toBe(false)
      const ops = opsNamed(text)
      expect(ops.length).toBeGreaterThan(0)
      for (const op of ops) expect(getOp(op), `${dir} names ${op}`).toBeTruthy()
      // What the agent writes syncs like any letter; only the raw data stays home.
      const flat = text.replace(/\s+/g, ' ')
      expect(flat).toMatch(/Walnut serves health data only to sessions on this Mac and never syncs or relays the samples/)
      // No recipe teaches the passthrough: it is the way around a named op's rules.
      expect(text).not.toMatch(/tools call api\b/)
      expect(flat).toMatch(/is ordinary Walnut content and syncs like any other letter/)
      expect(flat).toMatch(/never paste raw series/)
    })
  }

  it('every sleep skill handles a night with only time in bed, and a date with only naps', () => {
    for (const dir of ['health-sleep-report', 'morning-brief']) {
      const flat = fs.readFileSync(path.join(ROOT, 'skills', dir, 'SKILL.md'), 'utf-8').replace(/\s+/g, ' ')
      expect(flat, dir).toMatch(/`in_bed_only`/)
      expect(flat, dir).toMatch(/[Oo]nly time in bed was recorded/)
      expect(flat, dir).toMatch(/`no_main_night`/)
    }
    const brief = fs.readFileSync(path.join(ROOT, 'skills', 'morning-brief', 'SKILL.md'), 'utf-8').replace(/\s+/g, ' ')
    expect(brief).toMatch(/No main night was recorded, only naps/)
    const weekly = fs.readFileSync(path.join(ROOT, 'skills', 'weekly-health-trend', 'SKILL.md'), 'utf-8').replace(/\s+/g, ' ')
    expect(weekly).toMatch(/only time in bed/)
  })

  it('every sleep skill handles a night with a recording gap and never states its wake time', () => {
    for (const dir of SKILLS) {
      const flat = fs.readFileSync(path.join(ROOT, 'skills', dir, 'SKILL.md'), 'utf-8').replace(/\s+/g, ' ')
      expect(flat, dir).toMatch(/`unrecordedGaps`/)
    }
    for (const dir of ['health-sleep-report', 'morning-brief']) {
      const flat = fs.readFileSync(path.join(ROOT, 'skills', dir, 'SKILL.md'), 'utf-8').replace(/\s+/g, ' ')
      expect(flat, dir).toMatch(/recording has a gap/)
      expect(flat, dir).toMatch(/wake time/)
    }
  })
})
