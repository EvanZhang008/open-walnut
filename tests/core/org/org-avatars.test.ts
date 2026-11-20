/**
 * The Org avatars (src/core/org/avatars/): every preset draws, the org's nodes never share one, a
 * newer node never moves an older one's, a chosen avatar wins, and a stored picture never holds
 * anything that runs or loads.
 */
import { describe, it, expect } from 'vitest'
import {
  AVATAR_CHARACTERS, AVATAR_COLORS, allPresets, assignAvatars, fittingCharacter, orgAvatarNodes, orgAvatars,
  parsePreset, presetId, presetSvg, type AvatarTask,
} from '../../../src/core/org/avatars/index.js'
import { avatarValue, checkAvatarSvg, svgsInReply } from '../../../src/core/org/avatars/avatar-store.js'

const human = { by: 'human' as const }

function org(extra: AvatarTask[] = []): AvatarTask[] {
  return [
    { id: 'main', title: 'Main', org_role: 'main', created_at: '2026-01-01' },
    { id: 'l-walnut', title: 'Walnut lead', project: 'Walnut', org_role: 'lead', created_at: '2026-01-02' },
    { id: 'l-ai', title: 'Robots lead', project: 'Robots', org_role: 'lead', org_name: 'TeamAI', created_at: '2026-01-03' },
    { id: 'l-inbox', title: 'Inbox lead', project: 'Inbox', org_role: 'lead', created_at: '2026-01-04' },
    { id: 'l-home', title: 'Personal lead', project: 'Personal', org_role: 'lead', created_at: '2026-01-05' },
    { id: 'r-mail', title: 'Personal mail router', org_role: 'router', created_at: '2026-01-06' },
    { id: 'r-cron', title: 'CRON - Monitor marina-dev', org_role: 'router', created_at: '2026-01-07' },
    { id: 'leader', title: 'Pipeline watch leader', created_at: '2026-01-08' },
    { id: 'worker', title: 'Fix the flaky test', parent_task_id: 'leader', created_at: '2026-01-09' },
    ...extra,
  ]
}

describe('presets', () => {
  it('every character in every colour draws one square SVG that passes the stored-picture checks', () => {
    const all = allPresets()
    expect(all).toHaveLength(AVATAR_CHARACTERS.length * AVATAR_COLORS.length)
    expect(new Set(all).size).toBe(all.length)
    for (const id of all) {
      const svg = presetSvg(id)
      expect(svg, id).toMatch(/^<svg [^>]*viewBox="0 0 100 100"/)
      expect(svg!.length, id).toBeLessThan(4000)
      expect(() => checkAvatarSvg(svg), id).not.toThrow()
    }
  })

  it('an unknown character or colour is no preset', () => {
    expect(parsePreset('owl:8')?.character.id).toBe('owl')
    for (const bad of ['owl:14', 'dragon:1', 'owl', ':1', 'owl:-1']) expect(parsePreset(bad), bad).toBeNull()
  })
})

describe('who wears which', () => {
  it('the CEO, VPs, routers and leaders all differ, and names pick fitting characters', () => {
    const a = orgAvatars(org())
    const picks = orgAvatarNodes(org()).map((n) => a.of(org().find((t) => t.id === n.id)!).preset)
    expect(orgAvatarNodes(org()).map((n) => n.id)).toEqual(['main', 'l-walnut', 'l-ai', 'l-inbox', 'l-home', 'r-mail', 'r-cron', 'leader'])
    expect(new Set(picks).size).toBe(picks.length)
    const char = (id: string) => a.of(org().find((t) => t.id === id)!).preset!.split(':')[0]
    expect(char('main')).toBe('ceo')
    expect(char('l-walnut')).toBe('walnut')
    expect(char('l-ai')).toBe('robot')
    expect(char('l-inbox')).toBe('mailbox')
    expect(char('l-home')).toBe('house')
    expect(char('r-mail')).toBe('pigeon')
    expect(char('r-cron')).toBe('clock')
    expect(char('leader')).toBe('owl')
  })

  it('a newer node never changes the avatar of one that was there before', () => {
    const before = assignAvatars(orgAvatarNodes(org()))
    const after = assignAvatars(orgAvatarNodes(org([{ id: 'l-late', title: 'Walnut two lead', project: 'Walnut two', org_role: 'lead', created_at: '2026-02-01' }])))
    for (const [id, pick] of before) expect(after.get(id)?.preset, id).toBe(pick.preset)
    // It wants the walnut too, which is taken: same character, another colour.
    expect(after.get('l-late')?.preset).toMatch(/^walnut:/)
    expect(after.get('l-late')?.preset).not.toBe(before.get('l-walnut')?.preset)
  })

  it('a leader that appears or ends never moves a VP, a router or the CEO', () => {
    const lasting = ['main', 'l-walnut', 'l-ai', 'l-inbox', 'l-home', 'r-mail', 'r-cron']
    const picks = (tasks: AvatarTask[]) => { const a = orgAvatars(tasks); return lasting.map((id) => a.of(tasks.find((t) => t.id === id)!).preset) }
    const before = picks(org())
    // An old task (older than every node) gains an open child: it becomes a leader.
    const gained = picks(org([{ id: 'old', title: 'Watch the backups', created_at: '2025-12-01' }, { id: 'old-kid', title: 'Check', parent_task_id: 'old', created_at: '2026-03-01' }]))
    expect(gained).toEqual(before)
    // The leader's only child ends: it is a leader no more.
    const ended = picks(org().map((t) => (t.id === 'worker' ? { ...t, phase: 'COMPLETE' } : t)))
    expect(ended).toEqual(before)
  })

  it('a chosen avatar wins, and no default takes the pair someone picked', () => {
    const tasks = org().map((t) => (t.id === 'leader' ? { ...t, org_avatar: { preset: 'walnut:11', at: 'x' } } : t))
    const a = orgAvatars(tasks)
    expect(a.of(tasks.find((t) => t.id === 'leader')!)).toMatchObject({ preset: 'walnut:11', custom: true })
    expect(a.of(tasks.find((t) => t.id === 'l-walnut')!).preset).not.toBe('walnut:11')
  })

  it('a task outside the org nodes gets one too, never a pair an org node wears', () => {
    const a = orgAvatars(org())
    const worn = new Set(orgAvatarNodes(org()).map((n) => a.of(org().find((t) => t.id === n.id)!).preset))
    const w = a.of(org().find((t) => t.id === 'worker')!)
    expect(w.preset).toBeTruthy()
    expect(worn.has(w.preset)).toBe(false)
  })

  it('even past every pair, each node still gets an avatar', () => {
    const many: AvatarTask[] = Array.from({ length: AVATAR_CHARACTERS.length * AVATAR_COLORS.length + 10 }, (_, i) => ({
      id: `l${i}`, title: `Team ${i} lead`, project: `Team ${i}`, org_role: 'lead', created_at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}`,
    }))
    const picks = assignAvatars(orgAvatarNodes(many))
    expect(picks.size).toBe(many.length)
    expect(new Set([...picks.values()].map((p) => p.preset)).size).toBe(AVATAR_CHARACTERS.length * AVATAR_COLORS.length)
  })

  it('fitting words', () => {
    expect(fittingCharacter('CRON - Monitor dev')).toBe('clock')
    expect(fittingCharacter('Ticket triage')).toBe('detective')
    expect(fittingCharacter('Virtual teammate session import')).toBe('headset')
    expect(fittingCharacter('Others')).toBe('party')
    expect(fittingCharacter('Maintain the garden')).toBe('walnut')
    expect(fittingCharacter('Something')).toBeUndefined()
    expect(fittingCharacter('OpsAI')).toBe('robot')
    expect(fittingCharacter('Trip to Shanghai')).toBeUndefined()
    expect(fittingCharacter('Thai cooking')).toBe('chef')
    expect(fittingCharacter('Health check-in')).toBe('house')
  })
})

describe('stored pictures', () => {
  const ok = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#fb923c"/></svg>'

  it('a plain SVG, a preset and a small image data URL are kept, each stamped', () => {
    expect(avatarValue({ svg: ok }, human)).toMatchObject({ svg: ok, by: 'human' })
    expect(avatarValue({ preset: presetId('owl', 8) }, { by: 'task:x', byName: 'the Garden VP' })).toMatchObject({ preset: 'owl:8', by: 'the Garden VP' })
    expect(avatarValue({ image: 'data:image/png;base64,iVBORw0KGgo=' }, human)).toMatchObject({ image: 'data:image/png;base64,iVBORw0KGgo=' })
    expect(avatarValue({ reset: true }, human)).toBeNull()
  })

  it('anything that could run or load is refused', () => {
    const bad = [
      '<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>',
      '<svg viewBox="0 0 1 1" onload="alert(1)"></svg>',
      '<svg viewBox="0 0 1 1"><foreignObject><div/></foreignObject></svg>',
      '<svg viewBox="0 0 1 1"><image href="https://example.com/x.png"/></svg>',
      '<svg viewBox="0 0 1 1"><a href="javascript:alert(1)"><rect/></a></svg>',
      '<svg viewBox="0 0 1 1"><use href="//example.com/s.svg#a"/></svg>',
      '<svg viewBox="0 0 1 1"><style>@import url(https://example.com/a.css)</style></svg>',
      '<svg><rect/></svg>',
      'not svg',
      `<svg viewBox="0 0 1 1">${'<rect/>'.repeat(5000)}</svg>`,
      // A renderer that turns it into a PNG must never read a file or include one.
      '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg viewBox="0 0 1 1"><text>&x;</text></svg>',
      '<svg viewBox="0 0 1 1" xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include href="/etc/passwd" parse="text"/></svg>',
      '<svg viewBox="0 0 1 1"><filter id="f"><feImage href="file:///etc/hosts"/></filter></svg>',
      '<svg viewBox="0 0 1 1"><rect fill="url(file:///x.svg#p)"/></svg>',
      '<svg viewBox="0 0 1 1"><pattern id="p" xlink:href="../other.svg#q"/></svg>',
      '<svg viewBox="0 0 1 1"><?xml-stylesheet href="x.css"?><rect/></svg>',
    ]
    for (const svg of bad) expect(() => checkAvatarSvg(svg), svg.slice(0, 60)).toThrow()
    // References inside the picture itself stay allowed.
    expect(() => checkAvatarSvg('<svg viewBox="0 0 1 1"><!-- a nut --><defs><clipPath id="c"><rect/></clipPath><linearGradient id="g"/></defs><rect clip-path="url(#c)" fill="url( \'#g\')"/><pattern href="#c"/></svg>')).not.toThrow()
    expect(() => avatarValue({ image: 'data:image/svg+xml;base64,PHN2Zz4=' }, human)).toThrow()
    // A data URL's label is not its bytes: an SVG (or anything else) called a PNG is refused.
    const svgAsPng = `data:image/png;base64,${Buffer.from('<!DOCTYPE svg><svg viewBox="0 0 1 1"/>').toString('base64')}`
    expect(() => avatarValue({ image: svgAsPng }, human)).toThrow(/not a PNG/)
    expect(() => avatarValue({ image: 'data:image/webp;base64,iVBORw0KGgo=' }, human)).toThrow(/not a WEBP/)
    expect(() => checkAvatarSvg('<svg viewBox="0 0 1 1"><style>rect{fill:u\\72l(file:///x)}</style><rect/></svg>')).toThrow()
    expect(() => avatarValue({ preset: 'owl:8', svg: ok }, human)).toThrow()
    expect(() => avatarValue({}, human)).toThrow()
    expect(() => avatarValue({ preset: 'dragon:1' }, human)).toThrow(/Unknown preset/)
  })

  it('a model answer gives up to three of its usable SVGs', () => {
    const reply = `Here:\n${ok}\n<svg viewBox="0 0 1 1"><script/></svg>\n${ok}\n${ok}\n${ok}`
    expect(svgsInReply(reply)).toEqual([ok, ok, ok])
    expect(svgsInReply('no pictures')).toEqual([])
  })
})
