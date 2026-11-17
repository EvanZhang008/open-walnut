/**
 * The changes a session makes are linked to its task (src/core/link-made-hook.ts, link-kinds.ts):
 * a Bash call a link kind reads is remembered at its tool use, and the URLs its output shows it made
 * are tagged on the task when the result arrives, never crowded out by the task's documents. Walnut
 * ships GitHub (`gh pr create`, a push to the main line); a plugin adds its own service through
 * `walnut.registry.linkKind`, both for its CLI's output and for its URLs in what people paste.
 * Other commands, other tools and a result whose tool use was never seen tag nothing. Real tasks
 * under a temp home.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-link-made-hook'))

import { _resetForTesting, addTask, getTask } from '../../src/core/task-manager.js'
import { closeDb } from '../../src/core/task-db.js'
import { WALNUT_HOME } from '../../src/constants.js'
import { _resetLinkMadeHookForTesting, linkMadeHook } from '../../src/core/link-made-hook.js'
import { _resetLinkKindsForTesting, commandMakesLinks, createdPrUrl, gitPushes, githubRepoOfRemote, registerLinkKind } from '../../src/core/link-kinds.js'
import { tagLinksFromReportField, tagLinksInText } from '../../src/core/link-tags-apply.js'
import { PluginContext, type PluginLogger } from '../../src/core/plugins/plugin-context.js'
import { createServerPluginApi } from '../../src/core/plugins/server-api.js'
import { IntegrationRegistry } from '../../src/core/integration-registry.js'
import { createTestPluginApi } from './plugin-test-utils.js'
import type { SessionHookContext } from '../../src/core/session-hooks/types.js'

async function freshHome(): Promise<void> {
  if (!WALNUT_HOME.includes('walnut-link-made-hook')) throw new Error(`refusing to run against ${WALNUT_HOME}`)
  closeDb()
  _resetForTesting()
  _resetLinkMadeHookForTesting()
  _resetLinkKindsForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
}

beforeEach(freshHome)
afterEach(freshHome)

const use = (taskId: string, toolUseId: string, command: string, toolName = 'Bash') =>
  linkMadeHook.handler!({ taskId, sessionId: 's1', toolName, toolUseId, input: { command } } as unknown as SessionHookContext)
const result = (taskId: string, toolUseId: string, text: string) =>
  linkMadeHook.handler!({ taskId, sessionId: 's1', toolUseId, result: text } as unknown as SessionHookContext)

/** Two documents: room for one more link under the cap of three. */
const DOCS = ['notes:/home/u/drafts/a-short.md', 'report:/home/u/eval/REPORT.md']
const fullTask = async (title: string) => (await addTask({ title, project: 'Local', source: 'local', tags: [...DOCS] } as never)).task

/** A neutral stand-in for a company's code review tool: `acme-review post` prints the review URL. */
const ACME_REVIEW = {
  id: 'reviews',
  key: 'cr',
  match: String.raw`https?://review\.acme\.dev/reviews/CR-\d+`,
  made: {
    command: String.raw`(?:^|[\s;&|(])acme-review\s+post\b`,
    links: (run: { output: string }) => run.output.match(/https:\/\/review\.acme\.dev\/reviews\/CR-\d+/g) ?? [],
  },
}

describe('gh pr create in a session', () => {
  it('knows the command wherever it sits in a line', () => {
    expect(commandMakesLinks('gh pr create --fill')).toBe(true)
    expect(commandMakesLinks('cd repo; GH_PROMPT_DISABLED=1 gh  pr create -f')).toBe(true)
    expect(commandMakesLinks('gh pr view 12')).toBe(false)
    expect(commandMakesLinks('gh -R acme/app pr create --fill')).toBe(true)
    expect(commandMakesLinks('git -C "/w/my app" -c core.x=1 --no-pager push origin main')).toBe(true)
    expect(commandMakesLinks('git log --format=%s | grep push')).toBe(false)
    expect(commandMakesLinks('echo "use gh-pr-create-helper"')).toBe(false)
  })

  it('tags the pull request it printed', async () => {
    const task = await fullTask('Fix the parser')
    await use(task.id, 'tu-1', 'git push -u origin fix && gh pr create --fill')
    await result(task.id, 'tu-1', 'To github.com:acme/app.git\n * [new branch]      fix -> fix\nCreating pull request for fix into main in acme/app\n\nhttps://github.com/acme/app/pull/58\n')
    // The pull request, and no commit: a push to a feature branch is not a change of its own.
    expect((await getTask(task.id)).tags).toEqual([...DOCS, 'pr:https://github.com/acme/app/pull/58'])
  })

  it('tags the one that already existed for the branch', async () => {
    const { task } = await addTask({ title: 'Fix', project: 'Local', source: 'local' } as never)
    await use(task.id, 'tu-2', 'gh pr create --fill')
    await result(task.id, 'tu-2', 'a pull request for branch "fix" into branch "main" already exists:\nhttps://github.com/acme/app/pull/57')
    expect((await getTask(task.id)).tags).toEqual(['pr:https://github.com/acme/app/pull/57'])
  })

  it('tags nothing for another command, another tool, or a result it never saw start', async () => {
    const { task } = await addTask({ title: 'Read', project: 'Local', source: 'local' } as never)
    await use(task.id, 'tu-3', 'gh pr view 12 --web')
    await result(task.id, 'tu-3', 'https://github.com/acme/app/pull/12')
    await use(task.id, 'tu-4', 'gh pr create', 'Read')
    await result(task.id, 'tu-4', 'https://github.com/acme/app/pull/13')
    await result(task.id, 'tu-5', 'https://github.com/acme/app/pull/14')
    expect((await getTask(task.id)).tags ?? []).toEqual([])
  })
})

describe('a push straight to the main line', () => {
  it('tags the commit it put on main', async () => {
    const task = await fullTask('Hotfix')
    await use(task.id, 'tu-6', 'git -C /w/app push origin HEAD:main')
    await result(task.id, 'tu-6', 'To github.com:acme/app.git\n   1a2b3c4..5d6e7f8  HEAD -> main\n')
    expect((await getTask(task.id)).tags).toEqual([...DOCS, 'commit:https://github.com/acme/app/commit/5d6e7f8'])
  })

  it('reads every ref git printed, refused ones and other forges aside', () => {
    const out = [
      'Enumerating objects: 5, done.',
      'To https://github.com/acme/app.git',
      '   1a2b3c4..5d6e7f8  main -> main',
      ' + 9a9a9a9...8b8b8b8 topic -> topic (forced update)',
      ' ! [rejected]        dev -> dev (fetch first)',
      'To ssh://git.example.com/pkg/Widget',
      '   aaaaaaa..bbbbbbb  mainline -> mainline',
    ].join('\n')
    expect(gitPushes(out)).toEqual([
      { remote: 'https://github.com/acme/app.git', branch: 'main', from: '1a2b3c4', to: '5d6e7f8', main: true },
      { remote: 'https://github.com/acme/app.git', branch: 'topic', from: '9a9a9a9', to: '8b8b8b8', main: false },
      { remote: 'ssh://git.example.com/pkg/Widget', branch: 'mainline', from: 'aaaaaaa', to: 'bbbbbbb', main: true },
    ])
    expect(githubRepoOfRemote('git@github.com:acme/app.git')).toBe('acme/app')
    expect(githubRepoOfRemote('ssh://git.example.com/pkg/Widget')).toBeUndefined()
  })
})

describe('a plugin\'s own service', () => {
  it('links the code review its CLI posted', async () => {
    registerLinkKind('acme', { ...ACME_REVIEW, id: 'acme:reviews' })
    const task = await fullTask('Parser change')
    await use(task.id, 'tu-7', 'cd ~/ws/src/Widget && acme-review post --parent mainline')
    await result(task.id, 'tu-7', 'Posted revision 1\nCode review: https://review.acme.dev/reviews/CR-1001\n')
    expect((await getTask(task.id)).tags).toEqual([...DOCS, 'cr:https://review.acme.dev/reviews/CR-1001'])
  })

  it('maps a main-line push to its own commit page from the pushes Walnut read', async () => {
    registerLinkKind('acme', {
      id: 'acme:commits',
      key: 'commit',
      made: {
        command: String.raw`\bgit\b.*\bpush\b`,
        links: (run) => run.pushes.filter((p) => p.main && /git\.example\.com\/pkg\//.test(p.remote))
          .map((p) => `https://code.example.com/packages/${p.remote.split('/').pop()}/commits/${p.to}`),
      },
    })
    const task = await fullTask('Skill fix')
    await use(task.id, 'tu-8', 'git push')
    await result(task.id, 'tu-8', 'To ssh://git.example.com/pkg/Widget\n   aaaaaaa..bbbbbbb  mainline -> mainline\n')
    expect((await getTask(task.id)).tags).toEqual([...DOCS, 'commit:https://code.example.com/packages/Widget/commits/bbbbbbb'])
  })

  it('recognises its URLs in a person\'s message and in a self-report, under its own key', async () => {
    registerLinkKind('acme', { ...ACME_REVIEW, id: 'acme:reviews' })
    const { task } = await addTask({ title: 'Rollout', project: 'Local', source: 'local' } as never)
    await tagLinksInText(task.id, 'see https://review.acme.dev/reviews/CR-1002/revisions/2 please', 'send:ui')
    await tagLinksFromReportField(task.id, '- review: https://review.acme.dev/reviews/CR-1003 (Cache trim)\n- cr: https://review.acme.dev/reviews/CR-1002')
    expect((await getTask(task.id)).tags).toEqual(['cr:https://review.acme.dev/reviews/CR-1002', 'cr:https://review.acme.dev/reviews/CR-1003'])
  })

  it('a full task takes no more: three links is the cap, whatever made them', async () => {
    registerLinkKind('acme', { ...ACME_REVIEW, id: 'acme:reviews' })
    const { task } = await addTask({ title: 'Full', project: 'Local', source: 'local', tags: [...DOCS, 'doc:https://docs.example.com/d/1'] } as never)
    await use(task.id, 'tu-10', 'acme-review post')
    await result(task.id, 'tu-10', 'https://review.acme.dev/reviews/CR-5')
    expect((await getTask(task.id)).tags).toEqual([...DOCS, 'doc:https://docs.example.com/d/1'])
  })

  it('a kind that throws costs only its own links', async () => {
    registerLinkKind('acme', { id: 'acme:bad', key: 'cr', made: { command: 'gh\\s+pr\\s+create', links: () => { throw new Error('boom') } } })
    const { task } = await addTask({ title: 'Fix', project: 'Local', source: 'local' } as never)
    await use(task.id, 'tu-9', 'gh pr create --fill')
    await result(task.id, 'tu-9', 'https://github.com/acme/app/pull/60')
    expect((await getTask(task.id)).tags).toEqual(['pr:https://github.com/acme/app/pull/60'])
  })

  it('refuses a bad spec, and the plugin API namespaces it and withdraws it with the plugin', async () => {
    expect(() => registerLinkKind('acme', { id: 'x', key: 'Not A Key' })).toThrow(/tag key/)
    expect(() => registerLinkKind('acme', { id: 'x', key: 'cr', match: '(' })).toThrow(/not a regex/)
    expect(() => registerLinkKind('acme', { id: 'x', key: 'cr', made: { command: 'x', links: 1 as never } })).toThrow(/links function/)

    const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn() } as unknown as PluginLogger
    const context = new PluginContext({ id: 'acme', dataDir: path.join(WALNUT_HOME, 'plugin-data', 'acme'), logger })
    const { api: legacyApi, collected } = createTestPluginApi({ id: 'acme', name: 'acme' })
    const api = createServerPluginApi({ context, pluginName: 'acme', legacyApi, contributions: collected, integrationRegistry: new IntegrationRegistry() })
    api.registry.linkKind!(ACME_REVIEW)
    expect(commandMakesLinks('acme-review post')).toBe(true)
    await context.dispose()
    expect(commandMakesLinks('acme-review post')).toBe(false)
  })
})

describe('which URL gh printed for the pull request', () => {
  it('takes the last line that is only a pull request URL, nothing else the command printed', () => {
    expect(createdPrUrl('Creating pull request for csv into main in acme/app\n\nhttps://github.com/acme/app/pull/58\n')).toBe('https://github.com/acme/app/pull/58')
    expect(createdPrUrl('a pull request for branch "csv" into branch "main" already exists:\nhttps://github.com/acme/app/pull/41')).toBe('https://github.com/acme/app/pull/41')
    // `gh pr create && gh pr list`: the list's rows carry more than the URL, and an issue link is not one.
    expect(createdPrUrl('https://github.com/acme/app/pull/58\n#57  Fix login  https://github.com/acme/app/pull/57\nsee https://github.com/acme/app/issues/9')).toBe('https://github.com/acme/app/pull/58')
    expect(createdPrUrl('no pull request here: https://github.com/acme/app/pull/3 was mentioned')).toBeNull()
    expect(createdPrUrl('')).toBeNull()
  })
})
