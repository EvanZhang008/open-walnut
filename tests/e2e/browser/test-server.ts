/**
 * Test server helper for Playwright browser tests.
 *
 * Sets WALNUT_HOME env var to a temp dir BEFORE importing any modules,
 * then starts the real Express server serving the pre-built SPA.
 *
 * Run: npx tsx tests/e2e/browser/test-server.ts
 */

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import zlib from 'node:zlib'

// Set WALNUT_HOME to temp dir BEFORE importing server modules
// WALNUT_EPHEMERAL=1 prevents the safety check from overriding back to ~/.open-walnut
const tmpBase = path.join(os.tmpdir(), `walnut-pw-${Date.now()}`)
process.env.OPEN_WALNUT_HOME = tmpBase
process.env.OPEN_WALNUT_EPHEMERAL = '1'

// Ensure directories exist
await fs.rm(tmpBase, { recursive: true, force: true })
const tasksDir = path.join(tmpBase, 'tasks')
await fs.mkdir(tasksDir, { recursive: true })

// Seed test data
await fs.writeFile(
  path.join(tasksDir, 'tasks.json'),
  JSON.stringify({
    version: 1,
    tasks: [
      {
        id: 'pw-task-001',
        title: 'Playwright test task',
        status: 'in_progress',
        phase: 'IN_PROGRESS',
        priority: 'immediate',
        category: 'Work',
        project: 'Walnut',
        source: 'ms-todo',
        session_ids: ['pw-mode-test-session'],
        active_session_ids: [],
        session_id: 'pw-mode-test-session',
        session_status: { process_status: 'stopped', mode: 'bypass' },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        description: '',
        summary: '',
        note: '',
        subtasks: [],
      },
      {
        id: 'pw-task-plugina-synced',
        title: 'PluginA synced task',
        status: 'todo',
        phase: 'TODO',
        priority: 'none',
        category: 'Work',
        project: 'Walnut',
        source: 'plugin-a',
        ext: { 'plugin-a': { id: 'PA-123', short_id: 'A-123' } },
        external_url: 'https://plugin-a.example.com/tasks/A-123',
        sprint: 'Feb 2 - Feb 13',
        session_ids: [],
        active_session_ids: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        description: '',
        summary: '',
        note: '',
        subtasks: [],
      },
      {
        id: 'pw-task-plugina-unsynced',
        title: 'PluginA unsynced task',
        status: 'todo',
        phase: 'TODO',
        priority: 'immediate',
        category: 'Work',
        project: 'Walnut',
        source: 'plugin-a',
        session_ids: [],
        active_session_ids: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        description: '',
        summary: '',
        note: '',
        subtasks: [],
      },
      {
        id: 'pw-task-pluginb-synced',
        title: 'PluginB synced task',
        status: 'in_progress',
        phase: 'IN_PROGRESS',
        priority: 'important',
        category: 'Engineering',
        project: 'Backend',
        source: 'plugin-b',
        ext: { 'plugin-b': { issue_id: '10042', issue_key: 'BE-42', project_key: 'BE' } },
        external_url: 'https://plugin-b.example.com/browse/BE-42',
        session_ids: [],
        active_session_ids: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        description: 'Task synced to PluginB for plugin browser tests',
        summary: '',
        note: '',
        subtasks: [],
      },
      {
        id: 'pw-task-local',
        title: 'Local only task',
        status: 'todo',
        phase: 'TODO',
        priority: 'none',
        category: 'Later',
        project: 'Ideas',
        source: 'local',
        session_ids: [],
        active_session_ids: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        description: '',
        summary: '',
        note: '',
        subtasks: [],
      },
      {
        id: 'pw-task-sync-error',
        title: 'Sync error task',
        status: 'todo',
        phase: 'TODO',
        priority: 'important',
        category: 'Work',
        project: 'Walnut',
        source: 'ms-todo',
        sync_error: 'Graph API 401: Token expired',
        session_ids: [],
        active_session_ids: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        description: '',
        summary: '',
        note: '',
        subtasks: [],
      },
      {
        id: 'pw-task-ms-synced',
        title: 'MS To-Do synced task',
        status: 'todo',
        phase: 'TODO',
        priority: 'none',
        category: 'Personal',
        project: 'Errands',
        source: 'ms-todo',
        ext: { 'ms-todo': { id: 'AAMkAGI2', list: 'list-1' } },
        external_url: 'https://to-do.microsoft.com',
        session_ids: [],
        active_session_ids: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        description: '',
        summary: '',
        note: '',
        subtasks: [],
      },
      {
        id: 'pw-task-in-progress',
        title: 'In progress phase task',
        status: 'in_progress',
        phase: 'IN_PROGRESS',
        priority: 'immediate',
        category: 'Work',
        project: 'Walnut',
        source: 'ms-todo',
        session_ids: [],
        active_session_ids: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        description: '',
        summary: '',
        note: '',
        subtasks: [],
      },
      {
        id: 'pw-task-agent-complete',
        title: 'Agent complete phase task',
        status: 'in_progress',
        phase: 'AGENT_COMPLETE',
        priority: 'none',
        category: 'Work',
        project: 'Walnut',
        source: 'ms-todo',
        session_ids: [],
        active_session_ids: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        description: '',
        summary: '',
        note: '',
        subtasks: [],
      },
      {
        // Used by model-switch.spec.ts — task with a RUNNING session
        id: 'pw-task-model-switch',
        title: 'Model switch test task',
        status: 'in_progress',
        phase: 'IN_PROGRESS',
        priority: 'immediate',
        category: 'Work',
        project: 'Walnut',
        source: 'ms-todo',
        session_id: 'pw-model-switch-session',
        session_status: { process_status: 'running', mode: 'bypass' },
        session_ids: ['pw-model-switch-session'],
        active_session_ids: ['pw-model-switch-session'],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        description: '',
        summary: '',
        note: '',
        subtasks: [],
      },
      {
        // Used by session-mode-pill.spec.ts exec-slot bug test.
        // Starts with NO session fields so that migration won't pre-set session_id.
        // The test injects a task:updated event (simulating the buggy server emit
        // from linkSessionSlot) that sets exec_session_id but NOT session_id.
        id: 'pw-task-exec-bug',
        title: 'Exec slot bug task',
        status: 'in_progress',
        phase: 'IN_PROGRESS',
        priority: 'immediate',
        category: 'Work',
        project: 'Walnut',
        source: 'ms-todo',
        session_ids: [],
        active_session_ids: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        description: '',
        summary: '',
        note: '',
        subtasks: [],
      },
    ],
  }),
)

// Seed sessions.json with plan-mode session data for plan mode browser tests
const planPlanFile = path.join(tmpBase, '.claude', 'plans', 'test-plan.md')
await fs.mkdir(path.dirname(planPlanFile), { recursive: true })
await fs.writeFile(planPlanFile, '# Test Plan\n\nStep 1: Do the thing\nStep 2: Verify the thing\n')
await fs.writeFile(
  path.join(tmpBase, 'sessions.json'),
  JSON.stringify({
    version: 2,
    sessions: [
      {
        claudeSessionId: 'pw-plan-session-completed',
        taskId: 'pw-task-001',
        project: 'Walnut',
        process_status: 'stopped',

        mode: 'plan',
        last_status_change: new Date().toISOString(),
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        lastActiveAt: new Date().toISOString(),
        messageCount: 3,
        cwd: process.cwd(),
        title: 'Plan: investigate auth module',
        planFile: planPlanFile,
        planCompleted: true,
      },
      {
        claudeSessionId: 'pw-plan-session-incomplete',
        taskId: 'pw-task-001',
        project: 'Walnut',
        process_status: 'error',

        errorMessage: 'Process exited without result',
        mode: 'plan',
        last_status_change: new Date().toISOString(),
        startedAt: new Date(Date.now() - 120_000).toISOString(),
        lastActiveAt: new Date(Date.now() - 90_000).toISOString(),
        messageCount: 1,
        title: 'Plan: incomplete session',
        planCompleted: false,
      },
      {
        claudeSessionId: 'pw-normal-session',
        taskId: 'pw-task-001',
        project: 'Walnut',
        process_status: 'stopped',

        mode: 'bypass',
        last_status_change: new Date().toISOString(),
        startedAt: new Date(Date.now() - 180_000).toISOString(),
        lastActiveAt: new Date(Date.now() - 150_000).toISOString(),
        messageCount: 5,
        title: 'Normal: fix the bug',
      },
      {
        // Used by model-switch.spec.ts — RUNNING session for model picker tests
        claudeSessionId: 'pw-model-switch-session',
        taskId: 'pw-task-model-switch',
        project: 'Walnut',
        process_status: 'running',

        mode: 'bypass',
        last_status_change: new Date().toISOString(),
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        lastActiveAt: new Date().toISOString(),
        messageCount: 1,
        cwd: process.cwd(),
        title: 'Bypass: model switch test session',
      },
      {
        // Used by session-mode-pill.spec.ts — STOPPED so reconciler won't touch it
        claudeSessionId: 'pw-mode-test-session',
        taskId: 'pw-task-001',
        project: 'Walnut',
        process_status: 'stopped',

        mode: 'bypass',
        last_status_change: new Date().toISOString(),
        startedAt: new Date(Date.now() - 300_000).toISOString(),
        lastActiveAt: new Date(Date.now() - 240_000).toISOString(),
        messageCount: 2,
        title: 'Bypass: mode change test session',
      },
      {
        // Used by exec-slot bug test — task has exec_session_id but no session_id
        claudeSessionId: 'pw-exec-bug-session',
        taskId: 'pw-task-exec-bug',
        project: 'Walnut',
        process_status: 'stopped',

        mode: 'bypass',
        last_status_change: new Date().toISOString(),
        startedAt: new Date(Date.now() - 360_000).toISOString(),
        lastActiveAt: new Date(Date.now() - 300_000).toISOString(),
        messageCount: 1,
        title: 'Exec: slot bug test session',
      },
    ],
  }),
)

// Create test PNG images for lightbox.spec.ts
// Minimal valid PNG: 2x2 pixels, solid color
function makePng(r: number, g: number, b: number): Buffer {
  const raw = Buffer.alloc(2 * (1 + 2 * 3)) // 2 rows, each with filter byte + 2 pixels * 3 bytes
  let offset = 0
  for (let y = 0; y < 2; y++) {
    raw[offset++] = 0 // filter: none
    for (let x = 0; x < 2; x++) {
      raw[offset++] = r; raw[offset++] = g; raw[offset++] = b
    }
  }
  const compressed = zlib.deflateSync(raw)

  function chunk(name: string, data: Buffer): Buffer {
    const nameData = Buffer.concat([Buffer.from(name, 'ascii'), data])
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(nameData))
    return Buffer.concat([len, nameData, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(2, 0) // width
  ihdr.writeUInt32BE(2, 4) // height
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: RGB

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG signature
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const testImgDir = path.join(tmpBase, 'test-images')
await fs.mkdir(testImgDir, { recursive: true })
await fs.writeFile(path.join(testImgDir, 'blue.png'), makePng(51, 102, 204))
await fs.writeFile(path.join(testImgDir, 'red.png'), makePng(204, 51, 51))

// Create a test MP4 for video-preview.spec.ts. Content is a stub 'ftyp' box +
// deterministic filler — enough for byte-exact Range assertions; the spec
// asserts the <video> element + Download button, not actual decode.
const testVideoDir = path.join(tmpBase, 'test-videos')
await fs.mkdir(testVideoDir, { recursive: true })
{
  const ftyp = Buffer.from([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
  const filler = Buffer.alloc(2048)
  for (let i = 0; i < filler.length; i++) filler[i] = i % 251
  await fs.writeFile(path.join(testVideoDir, 'walkthrough.mp4'), Buffer.concat([ftyp, filler]))
}

// Seed chat-history.json with entity reference content for entity-refs.spec.ts
// and image paths for lightbox.spec.ts
await fs.writeFile(
  path.join(tmpBase, 'chat-history.json'),
  JSON.stringify({
    version: 2,
    lastUpdated: new Date().toISOString(),
    compactionCount: 0,
    compactionSummary: null,
    entries: [
      {
        tag: 'ai',
        role: 'user',
        content: 'Show me my tasks and sessions',
        timestamp: new Date(Date.now() - 30_000).toISOString(),
        displayText: 'Show me my tasks and sessions',
      },
      {
        tag: 'ai',
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'I found your task <task-ref id="pw-task-001" label="Walnut / Playwright test task"/>. I also checked session <session-ref id="pw-plan-session-completed" label="Plan: investigate auth module"/>. Here is another ref without label: <task-ref id="pw-task-in-progress"/>.',
          },
        ],
        timestamp: new Date(Date.now() - 25_000).toISOString(),
      },
      {
        tag: 'ai',
        role: 'user',
        content: 'Show me the test images',
        timestamp: new Date(Date.now() - 20_000).toISOString(),
        displayText: 'Show me the test images',
      },
      {
        tag: 'ai',
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: `Here are two test images:\n\n${path.join(testImgDir, 'blue.png')}\n\n${path.join(testImgDir, 'red.png')}`,
          },
        ],
        timestamp: new Date(Date.now() - 15_000).toISOString(),
      },
      {
        tag: 'ai',
        role: 'user',
        content: 'Record the walkthrough video',
        timestamp: new Date(Date.now() - 10_000).toISOString(),
        displayText: 'Record the walkthrough video',
      },
      {
        tag: 'ai',
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: `Video recorded and delivered: ${path.join(testVideoDir, 'walkthrough.mp4')}`,
          },
        ],
        timestamp: new Date(Date.now() - 5_000).toISOString(),
      },
    ],
  }),
)

// Seed memory files for memory-v2.spec.ts
const memoryDir = path.join(tmpBase, 'memory')
const dailyDir = path.join(memoryDir, 'daily')
const topicsDir = path.join(memoryDir, 'topics')
const projectsDir = path.join(memoryDir, 'projects', 'work', 'walnut')
const knowledgeDir = path.join(memoryDir, 'knowledge')
await fs.mkdir(dailyDir, { recursive: true })
await fs.mkdir(topicsDir, { recursive: true })
await fs.mkdir(projectsDir, { recursive: true })
await fs.mkdir(knowledgeDir, { recursive: true })

// Global MEMORY.md
await fs.writeFile(
  path.join(tmpBase, 'MEMORY.md'),
  '---\nname: Global Memory\n---\n\n# Global Memory\n\n## Preferences\n- Theme: dark mode\n- Language: English\n',
)

// Daily log
const todayKey = new Date().toISOString().slice(0, 10)
await fs.writeFile(
  path.join(dailyDir, `${todayKey}.md`),
  `# Daily Log ${todayKey}\n\n## Morning\n- Reviewed memory v2 search integration\n- Tested playwright browser automation\n`,
)

// Topic file
await fs.writeFile(
  path.join(topicsDir, 'search-architecture.md'),
  '# Search Architecture\n\nThe search system uses BM25 for keyword scoring and QMD for semantic search.\nMemory results are merged with task results using normalized weighted scoring.\n',
)

// Project memory
await fs.writeFile(
  path.join(projectsDir, 'MEMORY.md'),
  '# Walnut Project\n\nPersonal AI butler with task management and knowledge base.\nUses React frontend with Node.js backend.\n',
)

// Knowledge file
await fs.writeFile(
  path.join(knowledgeDir, 'testing-guide.md'),
  '# Testing Guide\n\nE2E tests use Playwright with a real ephemeral server.\nUnit tests use vitest.\n',
)

// Working memory
await fs.writeFile(
  path.join(memoryDir, 'working-memory.md'),
  '# Working Memory\n\nCurrent focus: implementing memory v2 search integration.\nActive tasks: playwright test automation, search UI improvements.\n',
)

// Index file
await fs.writeFile(
  path.join(memoryDir, 'index.md'),
  '# Memory Index\n\n- daily/: Daily logs\n- topics/: Topic files\n- projects/: Project memories\n- knowledge/: Knowledge base\n- working-memory.md: Active context\n',
)

// Ensure src/web/static symlink exists → dist/web/static
// When running via `npx tsx`, import.meta.url resolves to src/web/server.ts,
// so the server looks for static files at src/web/static/ which doesn't exist.
// This symlink makes it find the Vite-built SPA.
const srcWebStatic = path.join(path.dirname(new URL(import.meta.url).pathname), '../../../src/web/static')
const distWebStatic = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../dist/web/static')
try {
  await fs.unlink(srcWebStatic).catch(() => {})
  await fs.symlink(distWebStatic, srcWebStatic)
} catch { /* already exists or permission issue — server will try dist/static fallback */ }

// Now import server (it reads WALNUT_HOME from constants.ts which checks env var)
const { startServer, stopServer } = await import('../../../src/web/server.js')

// Wire local sessions through a MockDaemon spawning the mock Claude CLI, so
// real-pipeline specs can create LIVE sessions (session:start RPC → mock CLI →
// real WS stream events → real JSONL history). Additive: existing route-mocked
// specs never start sessions, so this wiring is inert for them.
// PW_NO_MOCK_DAEMON=1 disables the wiring entirely — a bisect lever: re-running
// a failing suite with it proves whether failures come from this daemon wiring
// or exist on HEAD (used to attribute the 2026-07 full-suite failures to a
// parallel sidebar redesign, not this server change).
const WIRE_MOCK_DAEMON = process.env.PW_NO_MOCK_DAEMON !== '1'
const { createMockDaemon } = await import('../../helpers/mock-daemon.js')
const { sessionRunner } = await import('../../../src/providers/claude-code-session.js')
const mockDaemon = WIRE_MOCK_DAEMON ? await createMockDaemon() : null
if (mockDaemon) {
  const MOCK_CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../providers/mock-claude.mjs')
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${mockDaemon.port}`)
}

// Start server in production mode (serves static SPA files)
await startServer({ port: 3457, dev: false })
console.log('Playwright test server ready on http://localhost:3457')

// Graceful shutdown
const shutdown = async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  if (mockDaemon) await mockDaemon.stop().catch(() => {})
  await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
