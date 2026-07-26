/**
 * Test server helper for Playwright browser tests.
 *
 * Sets WALNUT_HOME env var to a temp dir BEFORE importing any modules,
 * then starts the real Express server serving the pre-built SPA.
 *
 * Run: ./node_modules/.bin/tsx tests/e2e/browser/test-server.ts
 * (Local binary, not `npx tsx` — npx's resolution path costs tens of seconds on a
 * loaded machine and used to blow playwright.config.ts's webServer timeout.)
 */

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import zlib from 'node:zlib'

// Set WALNUT_HOME to temp dir BEFORE importing server modules.
// Ephemeral identity is argv-based (see IS_EPHEMERAL in src/constants.ts) — the
// env-var flag was removed after it leaked through the daemon into prod servers.
// Pushing the flag onto argv keeps the leaked-tmpdir safety check from overriding
// OPEN_WALNUT_HOME back to ~/.open-walnut, without anything for children to inherit.
const tmpBase = path.join(os.tmpdir(), `walnut-pw-${Date.now()}`)
process.env.OPEN_WALNUT_HOME = tmpBase
process.env.WALNUT_DAEMON_DIR = path.join(tmpBase, 'daemon')
process.env.WALNUT_STREAMS_DIR = path.join(tmpBase, 'daemon-streams')
process.env.WALNUT_DISABLE_SEARCH = '1'
// Keep host discovery, Claude history, credentials, and child processes inside
// the fixture. Inheriting the developer's HOME makes browser tests probe real
// SSH aliases and can even project unrelated ~/.claude journals.
process.env.HOME = tmpBase
process.env.USERPROFILE = tmpBase
process.argv.push('--_ephemeral-child')

// Ensure directories exist
await fs.rm(tmpBase, { recursive: true, force: true })
const tasksDir = path.join(tmpBase, 'tasks')
await fs.mkdir(tasksDir, { recursive: true })

// Quick Start asks the main agent to reorganize the newly-created task after
// the real session route returns. Keep that process local and deterministic;
// session/ACP processes are mocked separately below.
const mockMainAgent = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../providers/mock-main-agent.mjs',
)
await fs.writeFile(
  path.join(tmpBase, 'config.yaml'),
  JSON.stringify({
    version: 1,
    defaults: { priority: 'none', category: 'Inbox', platform: 'local' },
    hosts: {
      'fixture-remote': {
        hostname: 'fixture.example.test',
        label: 'Big remote host',
        enabled: false,
      },
    },
    provider: { type: 'claude-code' },
    agent: {
      main_provider: 'playwright-cli',
      main_model: 'playwright-mock',
      triage: { debounce_minutes: 0 },
    },
    providers: {
      'playwright-cli': {
        api: 'claude-cli',
        claude_cli_command: mockMainAgent,
      },
    },
  }, null, 2),
)

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
        session_ids: [
          'pw-mode-test-session',
          // Synthetic UUID used by the delayed semantic-search regression spec.
          '12345678-1234-4abc-8def-1234567890ab',
        ],
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
        id: 'pw-task-vscode',
        title: 'Editor fixture task',
        status: 'in_progress',
        phase: 'IN_PROGRESS',
        priority: 'none',
        category: 'Work',
        project: 'Walnut',
        source: 'local',
        session_ids: ['pw-vscode-session'],
        active_session_ids: [],
        session_id: 'pw-vscode-session',
        session_status: { process_status: 'stopped', mode: 'bypass' },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        description: '',
        summary: '',
        note: '',
        subtasks: [],
      },
      {
        id: 'pw-task-codex-customer',
        title: 'Playwright Codex customer task',
        status: 'in_progress',
        phase: 'IN_PROGRESS',
        priority: 'immediate',
        category: 'Work',
        project: 'Walnut',
        source: 'local',
        session_ids: ['pw-codex-customer-session'],
        active_session_ids: [],
        session_id: 'pw-codex-customer-session',
        session_status: { process_status: 'stopped', mode: 'bypass' },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        description: '',
        summary: '',
        note: '',
        subtasks: [],
      },
      {
        id: 'pw-task-codex-order',
        title: 'Playwright Codex order task',
        status: 'in_progress',
        phase: 'IN_PROGRESS',
        priority: 'immediate',
        category: 'Work',
        project: 'Walnut',
        source: 'local',
        session_ids: ['pw-codex-order-session'],
        active_session_ids: [],
        session_id: 'pw-codex-order-session',
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
const codexModeRuntimeId = 'pw-mode-runtime'
const codexCustomerRuntimeId = 'pw-customer-runtime'
const codexOrderRuntimeId = 'pw-order-runtime'
const codexModeJournalPath = path.join(tmpBase, 'daemon-streams', `${codexModeRuntimeId}.acp.jsonl`)
const codexCustomerJournalPath = path.join(tmpBase, 'daemon-streams', `${codexCustomerRuntimeId}.acp.jsonl`)
const codexOrderJournalPath = path.join(tmpBase, 'daemon-streams', `${codexOrderRuntimeId}.acp.jsonl`)
await fs.mkdir(path.dirname(codexModeJournalPath), { recursive: true })
const codexJournal = [
  {
    kind: 'meta',
    ts: Date.parse('2026-07-19T12:00:00.000Z'),
    event: {
      type: 'prompt-accepted',
      commandId: 'acp-prompt:qm-pw-parity',
      walnutMessageId: 'qm-pw-parity',
      text: 'CODEX-PARITY-USER-UNIQUE',
    },
  },
  {
    kind: 'acp',
    ts: Date.parse('2026-07-19T12:00:01.000Z'),
    source: 'live',
    frame: {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'CODEX-PARITY-ASSISTANT-UNIQUE' },
        },
      },
    },
  },
  {
    kind: 'meta',
    ts: Date.parse('2026-07-19T12:00:02.000Z'),
    event: {
      type: 'turn-ended',
      commandId: 'acp-prompt:qm-pw-parity',
      stopReason: 'end_turn',
    },
  },
  {
    kind: 'meta',
    ts: Date.parse('2026-07-19T12:01:00.000Z'),
    event: {
      type: 'prompt-accepted',
      commandId: 'acp-prompt:qm-pw-mobile',
      walnutMessageId: 'qm-pw-mobile',
      text: 'CODEX-MOBILE-USER-UNIQUE',
    },
  },
  {
    kind: 'acp',
    ts: Date.parse('2026-07-19T12:01:01.000Z'),
    source: 'live',
    frame: {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'CODEX-MOBILE-ASSISTANT-UNIQUE' },
        },
      },
    },
  },
  {
    kind: 'meta',
    ts: Date.parse('2026-07-19T12:01:02.000Z'),
    event: {
      type: 'turn-ended',
      commandId: 'acp-prompt:qm-pw-mobile',
      stopReason: 'end_turn',
    },
  },
]
const seededCodexJournal = codexJournal.map((record) => JSON.stringify(record)).join('\n') + '\n'
await Promise.all([
  fs.writeFile(codexModeJournalPath, seededCodexJournal),
  fs.writeFile(codexCustomerJournalPath, seededCodexJournal),
  fs.writeFile(codexOrderJournalPath, ''),
])
const sessionFixtureNow = Date.now()
const vscodeFixtureRoot = path.join(tmpBase, 'projects', 'editor-fixture')
await fs.mkdir(vscodeFixtureRoot, { recursive: true })
// Files-panel Refresh fixture (file-explorer-refresh.spec.ts): a file whose
// content the spec rewrites on disk, plus a dir it creates a new file inside —
// Refresh must surface both without a page reload.
await fs.writeFile(path.join(vscodeFixtureRoot, 'refresh-target.txt'), 'ORIGINAL_CONTENT\n')
// Markdown preview fixture (file-explorer-refresh.spec.ts): a FOUR-backtick
// fence wrapping inner ``` fences — the shape that used to make path
// linkification inject <a> inside a code region, which marked then escaped into
// a visible `<a class="file-link" …>` tag.
await fs.writeFile(
  path.join(vscodeFixtureRoot, 'nested-fence.md'),
  [
    '# Prompt doc',
    '',
    'Copy this prompt verbatim:',
    '',
    '````',
    '**1. READ the docs**',
    '```',
    'tool.py get --path acme/docs/README',
    '```',
    '',
    '- `references/routing.md` (in this skill): find the owner',
    '- then read pkg/sub/module.ts for the impl',
    '````',
    '',
  ].join('\n'),
)
const oldExactTargetAt = new Date(sessionFixtureNow - 30 * 24 * 60 * 60 * 1_000).toISOString()
const scaleSessions = Array.from({ length: 501 }, (_, index) => ({
  claudeSessionId: `pw-scale-session-${String(index).padStart(3, '0')}`,
  taskId: 'pw-task-001',
  project: 'Walnut',
  process_status: 'stopped',
  mode: 'bypass',
  last_status_change: new Date(sessionFixtureNow - index * 1_000).toISOString(),
  startedAt: new Date(sessionFixtureNow - index * 1_000).toISOString(),
  lastActiveAt: new Date(sessionFixtureNow - index * 1_000).toISOString(),
  messageCount: 1,
  cwd: process.cwd(),
  title: `Scale session ${String(index).padStart(3, '0')}`,
}))
await fs.writeFile(
  path.join(tmpBase, 'sessions.json'),
  JSON.stringify({
    version: 2,
    sessions: [
      {
        claudeSessionId: 'pw-vscode-session',
        taskId: 'pw-task-vscode',
        project: 'Walnut',
        process_status: 'stopped',
        mode: 'bypass',
        last_status_change: new Date().toISOString(),
        startedAt: new Date(Date.now() - 30_000).toISOString(),
        lastActiveAt: new Date().toISOString(),
        messageCount: 1,
        cwd: vscodeFixtureRoot,
        title: 'Editor fixture session',
      },
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
        claudeSessionId: '2532066a-e210-4702-be34-ed01008adbde',
        project: 'URL Restoration',
        process_status: 'stopped',

        mode: 'bypass',
        last_status_change: new Date().toISOString(),
        startedAt: new Date(Date.now() - 210_000).toISOString(),
        lastActiveAt: new Date(Date.now() - 180_000).toISOString(),
        messageCount: 0,
        cwd: process.cwd(),
        title: 'Deep link primary session',
      },
      {
        claudeSessionId: 'c520a153-6fb8-489d-b18f-c9e0d7ab9f48',
        project: 'URL Restoration',
        process_status: 'stopped',

        mode: 'bypass',
        last_status_change: new Date().toISOString(),
        startedAt: new Date(Date.now() - 180_000).toISOString(),
        lastActiveAt: new Date(Date.now() - 150_000).toISOString(),
        messageCount: 0,
        cwd: process.cwd(),
        title: 'Deep link secondary session',
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
        last_status_change: oldExactTargetAt,
        startedAt: oldExactTargetAt,
        lastActiveAt: oldExactTargetAt,
        messageCount: 2,
        title: 'Codex parity session',
        engine: 'codex',
        acpRuntimeId: codexModeRuntimeId,
        acpJournalPath: codexModeJournalPath,
        acpCapabilities: {
          loadSession: true,
          listSessions: true,
          closeSession: true,
          forkSession: false,
          promptImages: true,
        },
      },
      {
        // Isolated local-source target for the serial Codex customer matrix.
        claudeSessionId: 'pw-codex-customer-session',
        taskId: 'pw-task-codex-customer',
        project: 'Walnut',
        process_status: 'stopped',
        mode: 'bypass',
        last_status_change: oldExactTargetAt,
        startedAt: oldExactTargetAt,
        lastActiveAt: oldExactTargetAt,
        messageCount: 2,
        title: 'Codex customer parity session',
        engine: 'codex',
        acpRuntimeId: codexCustomerRuntimeId,
        acpJournalPath: codexCustomerJournalPath,
        acpCapabilities: {
          loadSession: true,
          listSessions: true,
          closeSession: true,
          forkSession: false,
          promptImages: true,
        },
      },
      {
        // Mutated by codex-order-parity.spec; intentionally isolated from the
        // stopped two-turn customer fixture asserted by parity/discovery specs.
        claudeSessionId: 'pw-codex-order-session',
        taskId: 'pw-task-codex-order',
        project: 'Walnut',
        process_status: 'stopped',
        mode: 'bypass',
        last_status_change: oldExactTargetAt,
        startedAt: oldExactTargetAt,
        lastActiveAt: oldExactTargetAt,
        messageCount: 0,
        title: 'Codex order parity session',
        engine: 'codex',
        acpRuntimeId: codexOrderRuntimeId,
        acpJournalPath: codexOrderJournalPath,
        acpCapabilities: {
          loadSession: true,
          listSessions: true,
          closeSession: true,
          forkSession: false,
          promptImages: true,
        },
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
      ...scaleSessions,
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

// ── Path-selector fixtures (session-path-selector.spec.ts) ──
// Real on-disk tree the list-dirs route lists for real, + seeded
// frequent-directories.json so the picker has history/frecency data.
const psFixtureRoot = path.join(tmpBase, 'ps-fixture')
await fs.mkdir(path.join(psFixtureRoot, 'projects', 'walnut', 'web'), { recursive: true })
await fs.mkdir(path.join(psFixtureRoot, 'projects', 'wallets'), { recursive: true })
await fs.mkdir(path.join(psFixtureRoot, 'projects', 'zmarinax'), { recursive: true })
await fs.mkdir(path.join(psFixtureRoot, 'projects', '.hiddenproj'), { recursive: true })
// mcp bug fixture: 'mcps' leaf-prefix-matches 'mcp'; 'monorepo-context-proj' only
// subsequence-matches it (m…c…p). A high-frecency history entry on the latter must
// NOT outrank the exact leaf-prefix hit — relevance beats frecency.
await fs.mkdir(path.join(psFixtureRoot, 'projects', 'mcps'), { recursive: true })
await fs.mkdir(path.join(psFixtureRoot, 'projects', 'monorepo-context-proj'), { recursive: true })
// Case-correction fixture: typing lowercase 'acmec' must complete to the REAL
// casing 'AcmeCapsDev/' (fish/zsh-style), never fabricate 'acmecCapsDev'.
await fs.mkdir(path.join(psFixtureRoot, 'projects', 'AcmeCapsDev', 'src'), { recursive: true })
await fs.mkdir(path.join(psFixtureRoot, 'other'), { recursive: true })
await fs.writeFile(
  path.join(tmpBase, 'frequent-directories.json'),
  JSON.stringify({
    version: 1,
    compiledAt: new Date().toISOString(),
    directories: [
      {
        cwd: path.join(psFixtureRoot, 'projects', 'walnut'),
        host: null, count: 25,
        lastUsed: new Date(Date.now() - 3600_000).toISOString(),
        categoryVotes: { Passion: 25 },
      },
      {
        cwd: path.join(psFixtureRoot, 'projects', 'wallets'),
        host: null, count: 24,
        lastUsed: new Date(Date.now() - 3700_000).toISOString(),
        categoryVotes: { Passion: 24 },
      },
      {
        cwd: '/home/playwright/a/very/long/remote/path/with/many/segments/remote-project',
        host: 'fixture-remote', count: 3,
        lastUsed: new Date(Date.now() - 3900_000).toISOString(),
        categoryVotes: { Work: 3 },
      },
      {
        cwd: path.join(psFixtureRoot, 'other'),
        host: null, count: 2,
        lastUsed: new Date(Date.now() - 20 * 86400_000).toISOString(),
        categoryVotes: { Inbox: 2 },
      },
      {
        // Fat session count (only a SUBSEQUENCE match for 'mcp') — must lose to the
        // 'mcps' leaf-prefix hit despite far higher frecency. Kept BELOW walnut's
        // count (25) so it never overtakes walnut as the browse-mode #1 (which
        // other specs assert); this row only matters under the 'mcp' needle.
        cwd: path.join(psFixtureRoot, 'projects', 'monorepo-context-proj'),
        host: null, count: 20,
        lastUsed: new Date(Date.now() - 2 * 3600_000).toISOString(),
        categoryVotes: { Passion: 20 },
      },
    ],
  }, null, 2),
)

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
const mockDaemon = WIRE_MOCK_DAEMON
  ? await createMockDaemon({
      streamsDir: path.join(process.env.WALNUT_DAEMON_DIR!, 'streams'),
      acpStreamsDir: process.env.WALNUT_STREAMS_DIR,
    })
  : null
if (mockDaemon) {
  const MOCK_CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../providers/mock-claude.mjs')
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${mockDaemon.port}`)
  // Codex (ACP) sessions: real acp-worker bundle + the scripted mock ACP agent.
  // MockDaemon embeds the real createAcpDaemon module, so quick-start with
  // engine='codex' exercises the full worker/journal path in Playwright specs.
  const WORKER_BUNDLE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../dist/daemon-binaries/acp-worker.js')
  const MOCK_ACP_AGENT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../providers/mock-acp-agent.mjs')
  sessionRunner.setTestAcpArtifacts({
    workerCmd: [process.execPath, WORKER_BUNDLE],
    adapterCmd: [process.execPath, MOCK_ACP_AGENT],
  })
}

// Exercise the same real dev-server contract as route E2E tests: the API binds
// an OS-assigned port, while Vite serves current React source and proxies REST
// and WebSocket traffic to that real Express server. No Playwright route mocks.
const testPort = Number(process.env.PW_TEST_PORT ?? 3457)
const apiServer = await startServer({ port: 0, dev: true })
const apiAddress = apiServer.address()
if (!apiAddress || typeof apiAddress === 'string') {
  throw new Error('Playwright API server did not bind a TCP port')
}
const apiTarget = `http://127.0.0.1:${apiAddress.port}`
const { createServer: createViteServer } = await import('vite')
const viteServer = await createViteServer({
  root: path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../web'),
  server: {
    host: '127.0.0.1',
    port: testPort,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/ws': { target: apiTarget.replace(/^http/, 'ws'), ws: true },
    },
  },
  logLevel: 'warn',
})
await viteServer.listen()
console.log(`Playwright test server ready on http://localhost:${testPort}`)

// Graceful shutdown
const shutdown = async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await viteServer.close().catch(() => {})
  await stopServer()
  if (mockDaemon) await mockDaemon.stop().catch(() => {})
  // startServer() also warmed the REAL local daemon (singleton) into this
  // run's isolated WALNUT_DAEMON_DIR — reap it or it outlives the fixture.
  // (SIGKILLed runs skip this; the daemon's parent-pid watchdog covers those.)
  try {
    const { localDaemon } = await import('../../../src/providers/local-daemon.js')
    await localDaemon.stopIfIsolated()
  } catch { /* best-effort */ }
  await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
