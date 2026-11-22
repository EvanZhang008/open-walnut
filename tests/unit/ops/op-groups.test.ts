/**
 * Every Walnut op belongs to exactly one group (src/ops/op-groups.ts), and a role lists some groups.
 *
 * The guard: a core op that no group holds fails here, so a new op is placed when it is added
 * (2026-11-21, the user: "way too many tools in mcp, is there a way to organize them"). The ops are
 * enumerated from the registry itself, never from a list kept in this file.
 */
import { describe, it, expect } from 'vitest'
import { listOpEntries } from '../../../src/ops/index.js'
import {
  LISTING_ROLES, OP_GROUPS, OTHER_GROUP, ROLE_LISTINGS, compareGroups, coreGroupOf, groupOfOp, groupTitle,
  listedForRole, listingRoleOf, summarizeGroups,
} from '../../../src/ops/op-groups.js'
import { formatToolsTable, inGroup } from '../../../src/ops/op-help.js'

const coreOps = () => listOpEntries().filter((e) => e.owner === 'core').map((e) => e.op)
const listedNames = (role: (typeof LISTING_ROLES)[number]) => coreOps().filter((o) => !o.deprecated && listedForRole(role, o.name)).map((o) => o.name)

describe('op groups', () => {
  it('every core op, old names included, has a group: place a new op in src/ops/op-groups.ts', () => {
    const unplaced = coreOps().filter((o) => !coreGroupOf(o.name)).map((o) => o.name)
    expect(unplaced).toEqual([])
  })

  it('the table names only real ops, each once, and every prefix holds an op', () => {
    const names = new Set(listOpEntries().map((e) => e.op.name))
    const seen = new Map<string, string>()
    for (const g of OP_GROUPS) {
      for (const n of g.ops ?? []) {
        expect(names.has(n), `${g.id}: ${n} is no op`).toBe(true)
        expect(seen.get(n), `${n} is in ${seen.get(n)} and ${g.id}`).toBeUndefined()
        seen.set(n, g.id)
      }
      for (const p of g.prefixes ?? []) expect([...names].some((n) => n.startsWith(p)), `${g.id}: no op starts with ${p}`).toBe(true)
    }
    expect(new Set(OP_GROUPS.map((g) => g.id)).size).toBe(OP_GROUPS.length)
    for (const g of OP_GROUPS) expect(g.title.length, g.id).toBeGreaterThan(0)
  })

  it('an exact name wins over a prefix, and a longer prefix over a shorter one', () => {
    expect(coreGroupOf('project_list')).toBe('tasks')
    expect(coreGroupOf('project_create')).toBe('projects')
    expect(coreGroupOf('health_monitor')).toBe('alarms')
    expect(coreGroupOf('health_sleep')).toBe('health')
    expect(coreGroupOf('host_mcp_call')).toBe('hosts')
    expect(coreGroupOf('mcp_call')).toBe('mcp')
    expect(coreGroupOf('host_exec')).toBe('hosts')
  })

  it('a plugin op is in its plugin\'s group: the org lists every plugin, a worker only its task\'s; an unplaced core op is never hidden', () => {
    expect(groupOfOp('calendar_query', 'calendar')).toBe('plugin:calendar')
    expect(groupTitle('plugin:calendar')).toContain('calendar')
    expect(listedForRole('org', 'calendar_query', 'calendar')).toBe(true)
    expect(listedForRole('worker', 'calendar_query', 'calendar')).toBe(false)
    expect(listedForRole('thread_keeper', 'calendar_query', 'calendar')).toBe(false)
    expect(listedForRole({ role: 'worker', plugins: ['calendar'] }, 'calendar_query', 'calendar')).toBe(true)
    expect(listedForRole({ role: 'worker', plugins: ['calendar'] }, 'mail_read', 'mail')).toBe(false)
    // A plugin's name never lists a core op that is not the role's.
    expect(listedForRole({ role: 'worker', plugins: ['calendar'] }, 'org_get')).toBe(false)
    for (const role of LISTING_ROLES) expect(listedForRole(role, 'no_such_op_yet')).toBe(true)
    expect(groupOfOp('no_such_op_yet')).toBe(OTHER_GROUP)
  })

  it('a worker lists its own work; an org node lists that and the org; neither lists the rare admin ops', () => {
    const worker = listedNames('worker')
    const keeper = listedNames('thread_keeper')
    const org = listedNames('org')
    const all = coreOps().filter((o) => !o.deprecated).length
    // Counted from the table on 2026-11-22: 77, 83 and 118 of 192 core ops.
    expect(worker.length).toBeGreaterThanOrEqual(60)
    expect(worker.length).toBeLessThanOrEqual(85)
    expect(org.length).toBeLessThanOrEqual(125)
    expect(worker.length * 2).toBeLessThan(all)
    for (const n of ['task_get', 'task_send', 'task_create', 'search', 'api', 'host_exec', 'host_mcp_call', 'host_http', 'trigger_create', 'subagent_run', 'board_post', 'note_read', 'agent_memory_write', 'thread_list', 'human_inbox_send']) {
      expect(worker, n).toContain(n)
    }
    for (const n of ['thread_update', 'org_get', 'brief_write', 'human_inbox_reply', 'task_move', 'topic_post', 'approval_list', 'password_list', 'router_route', 'time_report']) {
      expect(worker, n).not.toContain(n)
    }
    // Each role lists what the one below it does.
    for (const n of worker) expect(keeper, n).toContain(n)
    for (const n of keeper) expect(org, n).toContain(n)
    for (const n of ['thread_update', 'thread_create', 'thread_move']) expect(keeper, n).toContain(n)
    expect(keeper).not.toContain('org_get')
    for (const n of ['org_get', 'org_send', 'org_report', 'brief_write', 'brief_read', 'human_inbox_reply', 'task_move', 'task_restart', 'memory_write', 'agent_skill_write', 'health_monitor', 'thread_update']) {
      expect(org, n).toContain(n)
    }
    for (const n of ['topic_post', 'approval_list', 'password_use', 'router_route', 'triage_rule_set', 'time_report', 'mcp_call', 'hint_set', 'folder_create']) {
      expect(org, n).not.toContain(n)
    }
    // Every role's own picks are real ops.
    for (const role of LISTING_ROLES) for (const n of ROLE_LISTINGS[role].ops) expect(coreGroupOf(n), n).toBeDefined()
  })

  it('reads a role from its env value, nothing else', () => {
    expect(listingRoleOf('org')).toBe('org')
    expect(listingRoleOf(' worker ')).toBe('worker')
    expect(listingRoleOf('router')).toBeUndefined()
    expect(listingRoleOf(undefined)).toBeUndefined()
  })
})

describe('the catalog by group', () => {
  const rows = [
    { name: 'topic_post', title: 'Post', readonly: false, remote: 'allow', signature: 'id', group: 'topics' },
    { name: 'task_get', title: 'Get a task', readonly: true, remote: 'allow', signature: 'id', group: 'tasks' },
    { name: 'calendar_query', title: 'Events', readonly: true, remote: 'allow', signature: '(none)', group: 'plugin:calendar' },
  ]

  it('sections follow the table, plugins after it, and each says what it is for', () => {
    expect(['plugin:calendar', 'topics', 'tasks'].sort(compareGroups)).toEqual(['tasks', 'topics', 'plugin:calendar'])
    const groups = summarizeGroups(rows)
    expect(groups.map((g) => g.id)).toEqual(['tasks', 'topics', 'plugin:calendar'])
    const text = formatToolsTable(rows, groups)
    expect(text.indexOf('tasks (1): Find, start')).toBeGreaterThan(0)
    expect(text.indexOf('tasks (1)')).toBeLessThan(text.indexOf('topics (1)'))
    expect(text.indexOf('topics (1)')).toBeLessThan(text.indexOf('plugin:calendar (1)'))
    expect(text).toContain('--group <group>')
  })

  it('rows from an older hub (no group) stay one flat list, as before', () => {
    const text = formatToolsTable(rows.map(({ group: _g, ...r }) => r))
    expect(text.startsWith('Available operations:\n\n  ')).toBe(true)
    expect(text).not.toContain('(1)')
  })

  it('--group names one group, or every plugin\'s with "plugin"', () => {
    expect(rows.filter((r) => inGroup(r.group, 'Tasks')).map((r) => r.name)).toEqual(['task_get'])
    expect(rows.filter((r) => inGroup(r.group, 'plugin')).map((r) => r.name)).toEqual(['calendar_query'])
    expect(inGroup(undefined, 'tasks')).toBe(false)
  })
})
