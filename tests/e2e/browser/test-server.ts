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
// No unprompted model calls (auto-organize, project summaries) from the
// fixture — the host's real ~/.aws would make quick-start POSTs hit live
// Bedrock and move tasks mid-assertion. See backgroundAiDisabled().
process.env.WALNUT_DISABLE_BACKGROUND_AI = '1'
// Keep host discovery, Claude history, credentials, and child processes inside
// the fixture. Inheriting the developer's HOME makes browser tests probe real
// SSH aliases and can even project unrelated ~/.claude journals.
process.env.HOME = tmpBase
process.env.USERPROFILE = tmpBase
// Register the fixture-only cloud-setup provisioning driver so the Cloud
// Companion wizard spec can start a REAL job (real state machine, real SSE) that
// parks at `provision` instead of deploying anything. See providers/fake.ts.
process.env.WALNUT_CLOUD_SETUP_FAKE = '1'
process.argv.push('--_ephemeral-child')

/** Local `YYYY-MM-DD` N days from now — for fixtures that must stay in the future. */
function futureDay(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ── Deterministic clock for the composable-query fixtures ──
//
// ONE captured seed time, so every task-query timestamp below is a fixed offset
// from the same instant. A relative window ("updated in the last 6 hours") is
// only assertable if the fixture's age can't drift between rows — writing
// `new Date().toISOString()` per row (what every older fixture does) would put
// two rows on either side of a boundary on a slow, loaded machine.
const SEED_NOW = Date.now()
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
/** ISO timestamp `msAgo` before the seed instant. */
const agoIso = (msAgo: number): string => new Date(SEED_NOW - msAgo).toISOString()

// Ensure directories exist
await fs.rm(tmpBase, { recursive: true, force: true })
const tasksDir = path.join(tmpBase, 'tasks')
await fs.mkdir(tasksDir, { recursive: true })

// The main agent still gets messages from other flows (chat, notifications).
// Keep that process local and deterministic; session/ACP processes are mocked
// separately below.
const mockMainAgent = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../providers/mock-main-agent.mjs',
)
await fs.writeFile(
  path.join(tmpBase, 'config.yaml'),
  JSON.stringify({
    version: 1,
    defaults: { priority: 'none', platform: 'local' },
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
      // Deferred task: start_date is in the FUTURE, so the Date filter's default
      // ("Now") hides it from the plain list. Search must still find it — see
      // tests/e2e/browser/todo-search-ignores-filters.spec.ts.
      {
        id: 'pw-task-deferred',
        title: 'Deferred marmalade task',
        status: 'todo',
        phase: 'TODO',
        priority: 'none',
        project: 'Ideas',
        source: 'local',
        start_date: futureDay(30),
        session_ids: [],
        active_session_ids: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        description: '',
        summary: '',
        note: '',
        subtasks: [],
      },
      // Completed twin of the deferred task. Search ignores "Show completed" too,
      // so this one is findable — but must rank BEHIND the open hit.
      {
        id: 'pw-task-done-marmalade',
        title: 'Finished marmalade task',
        status: 'done',
        phase: 'COMPLETE',
        priority: 'none',
        project: 'Ideas',
        source: 'local',
        session_ids: [],
        active_session_ids: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
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

      // ── Composable task-query fixtures (task-filters.spec.ts) ──
      //
      // Every row here carries a FIXED age (offset from SEED_NOW) so relative
      // windows are assertable, and lives in its OWN project (Lantern / Meadow)
      // so a project condition selects an exact set no other spec's data can
      // join. Titles carry the `tq-` marker for the same reason.
      //
      // `pinned: true` + `phase: 'COMPLETE'` on ONE row is deliberate and is the
      // combination the whole feature exists for: the tier area hides completed
      // pins (splitTiers / useFocusBar both drop them), so before the query model
      // this task was unreachable in the UI. It is safe for the existing pinned
      // specs precisely BECAUSE it is completed — it never enters a tier list,
      // never appears in /api/focus/tasks, and so can't shift any tier ordering,
      // count, or drag geometry they assert.
      {
        id: 'pw-tq-pinned-done-recent',
        title: 'tq pinned done recent',
        status: 'done',
        phase: 'COMPLETE',
        priority: 'important',
        project: 'Lantern',
        source: 'local',
        pinned: true,
        pin_order: 0,
        focus_tier: 'focus',
        session_ids: [],
        active_session_ids: [],
        created_at: agoIso(3 * DAY_MS),
        updated_at: agoIso(HOUR_MS),
        completed_at: agoIso(HOUR_MS),
        description: '',
        summary: '',
        note: '',
        subtasks: [],
      },
      {
        // Same project + same 6h window, but NOT pinned — proves the pinned leg
        // of the composed query is doing work (drop it and this row joins).
        id: 'pw-tq-open-recent',
        title: 'tq open recent unpinned',
        status: 'in_progress',
        phase: 'IN_PROGRESS',
        priority: 'immediate',
        project: 'Lantern',
        source: 'local',
        session_ids: [],
        active_session_ids: [],
        created_at: agoIso(3 * DAY_MS),
        updated_at: agoIso(2 * HOUR_MS),
        description: '',
        summary: '',
        note: '',
        subtasks: [],
      },
      {
        // Completed like the pinned row, in the same project, but OUTSIDE the
        // 6h/24h windows — proves the time leg is doing work.
        id: 'pw-tq-done-stale',
        title: 'tq done stale',
        status: 'done',
        phase: 'COMPLETE',
        priority: 'none',
        project: 'Lantern',
        source: 'local',
        session_ids: [],
        active_session_ids: [],
        created_at: agoIso(9 * DAY_MS),
        updated_at: agoIso(3 * DAY_MS),
        completed_at: agoIso(3 * DAY_MS),
        description: '',
        summary: '',
        note: '',
        subtasks: [],
      },
      {
        // A second project so a project condition can be shown to EXCLUDE, not
        // just include. Recent enough to pass the 24h "recently updated" preset.
        id: 'pw-tq-other-project-recent',
        title: 'tq other project recent',
        status: 'todo',
        phase: 'TODO',
        priority: 'important',
        project: 'Meadow',
        source: 'local',
        session_ids: [],
        active_session_ids: [],
        created_at: agoIso(4 * DAY_MS),
        updated_at: agoIso(2 * HOUR_MS),
        description: '',
        summary: '',
        note: '',
        subtasks: [],
      },
      {
        // Meadow's stale twin: same project, outside every relative window, so
        // "project Meadow + recently updated" has something real to drop.
        id: 'pw-tq-other-project-stale',
        title: 'tq other project stale',
        status: 'todo',
        phase: 'AWAIT_HUMAN_ACTION',
        priority: 'backlog',
        project: 'Meadow',
        source: 'local',
        session_ids: [],
        active_session_ids: [],
        created_at: agoIso(20 * DAY_MS),
        updated_at: agoIso(8 * DAY_MS),
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
// Same content as .mdx: plain .md now opens in the WYSIWYG editor (which never
// runs the linkifier), so the read-only render path — where the nested-fence
// regression lives — is only reachable through an extension canWysiwyg excludes.
await fs.copyFile(
  path.join(vscodeFixtureRoot, 'nested-fence.md'),
  path.join(vscodeFixtureRoot, 'nested-fence.mdx'),
)
// Files-panel resume fixture (file-view-resume.spec.ts). Two jobs in one file:
//  1. `~N` approximations in prose — marked's default del tokenizer paired the
//     lone tildes and struck out everything between them (the 2026-07-28 report).
//  2. long enough to scroll, so the spec can verify the reading position and the
//     selected file are restored when the panel is reopened.
await fs.writeFile(
  path.join(vscodeFixtureRoot, 'incident-report.md'),
  [
    '# Controller restart loop',
    '',
    'The controller (watching ~550K objects, largest in the fleet) has been',
    '**silently losing its lease and restarting** — recently ~694 times per two',
    'weeks, roughly every 30 minutes. Each restart wipes the cache (~20 min cold',
    'rebuild) and loses DELETE events during the window.',
    '',
    'A genuine ~~retracted claim~~ still renders struck through.',
    '',
    ...Array.from({ length: 160 }, (_, i) => `- timeline entry ${i + 1}: steady-state drift observed`),
    '',
    '## Tail marker',
    '',
    'BOTTOM_OF_REPORT',
    '',
  ].join('\n'),
)
// A second scrollable file, so the spec can prove offsets are per-FILE (switching
// away and back must not carry file A's position onto file B).
await fs.writeFile(
  path.join(vscodeFixtureRoot, 'second-doc.md'),
  ['# Second doc', '', ...Array.from({ length: 160 }, (_, i) => `- second entry ${i + 1}`), '', 'SECOND_TAIL', ''].join('\n'),
)
// Drag fixture (panel-resize-drag.spec.ts): an HTML file, because FileContentView
// previews HTML in an <iframe>. That iframe sits directly right of the tree
// divider and used to swallow the drag's mousemove/mouseup — the stuck-drag bug.
await fs.writeFile(
  path.join(vscodeFixtureRoot, 'drag-fixture.html'),
  [
    '<!doctype html>',
    '<html><head><title>Drag fixture</title></head>',
    // Tall + opaque so it definitely covers the area the cursor crosses.
    '<body style="margin:0;background:#eef;height:3000px">',
    '<h1>Drag fixture preview</h1>',
    '<p>This page is previewed in an iframe next to the resize divider.</p>',
    '</body></html>',
    '',
  ].join('\n'),
)
// PDF fixture (file-preview-kinds.spec.ts): a minimal but STRUCTURALLY VALID
// one-page PDF, so the browser's built-in viewer actually renders it instead of
// showing its "failed to load" chrome. Byte offsets in the xref are hand-checked.
{
  const objs = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n',
    '4 0 obj<</Length 46>>stream\nBT /F1 18 Tf 20 100 Td (WALNUT PDF) Tj ET\nendstream endobj\n',
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n',
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const o of objs) { offsets.push(body.length); body += o }
  const xrefStart = body.length
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`
  body += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`
  await fs.writeFile(path.join(vscodeFixtureRoot, 'contract.pdf'), body, 'latin1')
}
// Image fixture in the SAME dir as the other explorer fixtures, so one spec can
// walk file → doc → image without changing roots.
await fs.writeFile(path.join(vscodeFixtureRoot, 'diagram.png'), makePng(34, 139, 34))
// Vault note fixture: a real note inside NOTES_DIR. Clicking it must open the
// file preview IN PLACE (the old behavior navigated the whole app to /notes);
// the jump is now the explicit "Open in Notes" button.
const notesFixtureDir = path.join(tmpBase, 'notes')
await fs.mkdir(notesFixtureDir, { recursive: true })
await fs.writeFile(
  path.join(notesFixtureDir, 'vault-note.md'),
  '# Vault note\n\nThis note lives in the notes vault. VAULT_NOTE_MARKER\n',
)
// A nested subdir + file, reached ONLY by a file-path click in the chat (below).
// That entry point roots the explorer at this dir while the Files chip roots at
// the session cwd — the two roots whose split localStorage keys were the
// 2026-08-09 "it doesn't remember the last file I opened" bug.
const vscodeNestedDir = path.join(vscodeFixtureRoot, 'deep', 'nested')
await fs.mkdir(vscodeNestedDir, { recursive: true })
await fs.writeFile(
  path.join(vscodeNestedDir, 'linked-from-chat.md'),
  '# Linked from chat\n\nThis file is only reachable by clicking its path in the session chat. LINKED_FROM_CHAT_MARKER\n',
)
// Real Claude Code JSONL for pw-vscode-session, so its chat renders an assistant
// message containing that absolute path — the clickable `a.file-link` the
// file-view-history spec needs. HOME is the fixture tmpBase (set at the top), so
// this lands where session-history.ts looks.
{
  const encodedCwd = vscodeFixtureRoot.replace(/[^a-zA-Z0-9]/g, '-')
  const jsonlDir = path.join(tmpBase, '.claude', 'projects', encodedCwd)
  await fs.mkdir(jsonlDir, { recursive: true })
  const linkedPath = path.join(vscodeNestedDir, 'linked-from-chat.md')
  await fs.writeFile(
    path.join(jsonlDir, 'pw-vscode-session.jsonl'),
    [
      JSON.stringify({
        type: 'user',
        sessionId: 'pw-vscode-session',
        timestamp: new Date(sessionFixtureNow - 40_000).toISOString(),
        message: { role: 'user', content: 'Where did you put the notes?' },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'pw-vscode-session',
        timestamp: new Date(sessionFixtureNow - 35_000).toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `Wrote them to ${linkedPath} — take a look.` }],
        },
      }),
      // Filler turns AFTER the file-link message, so the timeline actually
      // overflows its scroller. ask-about-this-focus.spec.ts needs a scrollable
      // history to prove the "jump to the bottom" contract; specs that want the
      // file link still find it (they match by text and take .first()).
      ...Array.from({ length: 30 }, (_, i) => [
        JSON.stringify({
          type: 'user',
          sessionId: 'pw-vscode-session',
          timestamp: new Date(sessionFixtureNow - 34_000 + i * 400).toISOString(),
          message: { role: 'user', content: `filler question ${i + 1}` },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'pw-vscode-session',
          timestamp: new Date(sessionFixtureNow - 33_800 + i * 400).toISOString(),
          message: { role: 'assistant', content: [{ type: 'text', text: `filler answer ${i + 1}` }] },
        }),
      ]).flat(),
      '',
    ].join('\n'),
  )
}
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

// Global MEMORY.md — legacy location; init.ts migrates it into memory/ only when
// memory/MEMORY.md is absent, and the realistic-shape fixture below claims that
// path first, so this one exists purely as the pre-migration shape.
await fs.writeFile(
  path.join(tmpBase, 'MEMORY.md'),
  '---\nname: Global Memory\n---\n\n# Global Memory\n\n## Preferences\n- Theme: dark mode\n- Language: English\n',
)

// The bounded stores in their REAL on-disk shape, at their real paths, for
// memory-frontmatter.spec.ts. What matters is the frontmatter: a `description: >`
// YAML block scalar behind a closing `---` fence. markdown-it reads that closing
// fence as a setext-H2 underline, so handing these bytes straight to the WYSIWYG
// editor collapses the whole block into one `## name: … description: &gt; …`
// heading — a FAKE entry in a store injected into the Personal AI's prompt every turn.
// The body also carries the two prose shapes the serializer used to mangle: a
// tag-shaped `<id>` placeholder (deleted outright) and a bare `>` (→ `&gt;`).
const BOUNDED_STORE_BODY = [
  '',
  '## Release Checklist',
  '',
  'Build, then verify in a real browser before claiming done.',
  '',
  '## Naming Rule',
  '',
  'When importing a record, never use a generic "Import <id>" title — read the source first. Budget: a > b.',
  '',
].join('\n')
await fs.writeFile(
  path.join(memoryDir, 'MEMORY.md'),
  [
    '---',
    'name: Global Memory',
    'description: >',
    '  Bounded behavior rules. Updated by the agent via the memory tool.',
    '  Hard budget: 8000 chars.',
    '---',
    '',
    '# Global Memory',
    BOUNDED_STORE_BODY,
  ].join('\n'),
)
await fs.writeFile(
  path.join(memoryDir, 'USER.md'),
  [
    '---',
    'name: User Profile',
    'description: >',
    '  Who the user is — identity, work, durable preferences.',
    '  Hard budget: 4000 chars.',
    '---',
    '',
    '# User Profile',
    '',
    '## Identity',
    '',
    'A software engineer working on a personal assistant project.',
    '',
  ].join('\n'),
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
  '# Walnut Project\n\nPersonal AI with task management and knowledge base.\nUses React frontend with Node.js backend.\n',
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
        projectVotes: { Passion: 25 },
      },
      {
        cwd: path.join(psFixtureRoot, 'projects', 'wallets'),
        host: null, count: 24,
        lastUsed: new Date(Date.now() - 3700_000).toISOString(),
        projectVotes: { Passion: 24 },
      },
      {
        cwd: '/home/playwright/a/very/long/remote/path/with/many/segments/remote-project',
        host: 'fixture-remote', count: 3,
        lastUsed: new Date(Date.now() - 3900_000).toISOString(),
        projectVotes: { Work: 3 },
      },
      {
        cwd: path.join(psFixtureRoot, 'other'),
        host: null, count: 2,
        lastUsed: new Date(Date.now() - 20 * 86400_000).toISOString(),
        projectVotes: { Inbox: 2 },
      },
      {
        // Fat session count (only a SUBSEQUENCE match for 'mcp') — must lose to the
        // 'mcps' leaf-prefix hit despite far higher frecency. Kept BELOW walnut's
        // count (25) so it never overtakes walnut as the browse-mode #1 (which
        // other specs assert); this row only matters under the 'mcp' needle.
        cwd: path.join(psFixtureRoot, 'projects', 'monorepo-context-proj'),
        host: null, count: 20,
        lastUsed: new Date(Date.now() - 2 * 3600_000).toISOString(),
        projectVotes: { Passion: 20 },
      },
    ],
  }, null, 2),
)

// Now import server (it reads WALNUT_HOME from constants.ts which checks env var)
const { startServer, stopServer } = await import('../../../src/web/server.js')

// Swap the calendar service onto a mock source BEFORE startServer runs
// getCalendarService().init(). Not just test convenience: on this Mac the real
// EventKit source is `available`, so the first /api/calendar/events request
// from a spec would compile the Swift helper and read the user's REAL
// calendars (TCC prompt on the node process). Fixture events are stable and
// writable, so event-chip specs can drag/resize/create against them.
{
  const { CalendarService, _setCalendarServiceForTest } = await import('../../../src/core/calendar/index.js')
  const { createMockCalendarSource, fixtureCalendars } = await import('../../helpers/mock-calendar-source.js')
  // Events anchor to TODAY (specs navigate by local date, not a fixed one).
  const pad2 = (n: number) => String(n).padStart(2, '0')
  const now = new Date()
  const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
  _setCalendarServiceForTest(new CalendarService(createMockCalendarSource({
    events: [
      {
        id: 'ev-e2e-brief',
        source: 'eventkit',
        calendarId: 'cal-work',
        calendarName: 'Work',
        accountName: 'Google',
        title: 'Morning brief',
        start: `${today}T06:00:00`,
        end: `${today}T06:30:00`,
        allDay: false,
        color: '#4285f4',
      },
      {
        // Separate event for the resize spec — fullyParallel would race the
        // move spec if both touched ev-e2e-brief.
        id: 'ev-e2e-review',
        source: 'eventkit',
        calendarId: 'cal-work',
        calendarName: 'Work',
        accountName: 'Google',
        title: 'Design review',
        start: `${today}T03:00:00`,
        end: `${today}T03:30:00`,
        allDay: false,
        color: '#4285f4',
      },
      {
        id: 'ev-e2e-holiday',
        source: 'eventkit',
        calendarId: 'cal-holidays',
        calendarName: 'Holidays',
        accountName: 'iCloud',
        title: 'Fixture Holiday',
        start: today,
        end: today,
        allDay: true,
        color: '#ff9500',
        readonly: true,
      },
      {
        // Dedicated to the visibility-toggle spec: hiding cal-personal must
        // not disturb the other specs' cal-work/cal-holidays assertions
        // (fullyParallel runs them concurrently against this shared server).
        id: 'ev-e2e-errand',
        source: 'eventkit',
        calendarId: 'cal-personal',
        calendarName: 'Personal',
        accountName: 'iCloud',
        title: 'Errand',
        start: `${today}T01:00:00`,
        end: `${today}T01:30:00`,
        allDay: false,
        color: '#af52de',
      },
    ],
    calendars: [
      ...fixtureCalendars(),
      { id: 'cal-personal', title: 'Personal', account: 'iCloud', color: '#af52de', readonly: false, hidden: false },
    ],
  }).source))
}

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
