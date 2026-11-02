/**
 * Settings → Sessions → Pi → "Import from Claude Code".
 *
 * The routes are stubbed here (page.route): the fixture server's host has no
 * Claude Code setup to read, and what the import reads and writes is pinned
 * server-side (tests/core/claude-code-import.test.ts). This spec pins what the
 * user sees and does: Review shows what comes over (secrets by name only), what
 * is left out and what cannot carry over; Import writes and says what it wrote;
 * Check again reads up to date; an error shows the server's own sentence and a
 * retry recovers; a host with no Claude Code says so and offers no Import.
 * Runs in both projects (chromium, and webkit with PW_WEBKIT=1).
 */
import { test, expect, type Page, type Route } from '@playwright/test'
import { openSessionsSection } from './engine-settings-helpers'

test.setTimeout(90_000)

const IMPORT_PATH = '**/api/engines/pi/claude-code-import**'

function preview(over: Record<string, unknown> = {}) {
  return {
    host: '__local__',
    pi: { installed: true, version: '1.4.0', needsUpdateForMcp: false },
    claudeCode: { found: true, settingsPath: '~/.claude/settings.json' },
    agentDir: '~/.pi/agent',
    extension: { path: '~/.pi/agent/extensions/walnut-claude-code.ts', state: 'absent', version: 1 },
    settings: {
      path: '~/.pi/agent/settings.json',
      changes: [
        { key: 'defaultProvider', to: 'amazon-bedrock' },
        { key: 'defaultModel', from: 'some-old-model', to: 'global.anthropic.claude-opus-5-5' },
      ],
    },
    credentials: {
      kind: 'bedrock',
      vars: [{ name: 'AWS_REGION', value: 'us-west-2' }, { name: 'AWS_SECRET_ACCESS_KEY' }],
      note: 'pi reaches Amazon Bedrock with the credentials in Claude Code\'s settings.',
    },
    mcpServers: [{ name: 'notes', detail: 'node notes-server.js', source: 'user' }],
    skippedMcpServers: [{ name: 'events', detail: 'uses the SSE transport, which pi does not support', source: 'user' }],
    skills: [{ name: '~/.claude/skills', detail: '12 skills', source: 'user' }],
    commands: [],
    instructions: [{ name: '~/.claude/CLAUDE.md', detail: 'your instructions for every project', source: 'user' }],
    cannotCarry: [{ what: 'Hooks', why: 'pi does not run Claude Code hook commands.', nearest: 'A pi extension.' }],
    upToDate: false,
    ...over,
  }
}

async function piGroup(page: Page) {
  const section = await openSessionsSection(page)
  const group = section.getByTestId('cc-import-group-pi')
  await expect(group).toBeVisible()
  await group.scrollIntoViewIfNeeded()
  return group
}

test('review, import, check again', async ({ page }) => {
  let applied = false
  const posts: string[] = []
  await page.route(IMPORT_PATH, async (route: Route) => {
    const req = route.request()
    if (req.method() === 'POST') {
      posts.push(req.url())
      applied = true
      await route.fulfill({ json: { written: ['~/.pi/agent/extensions/walnut-claude-code.ts', '~/.pi/agent/settings.json'], preview: preview({ upToDate: true, extension: { path: '~/.pi/agent/extensions/walnut-claude-code.ts', state: 'current', version: 1 }, settings: { path: '~/.pi/agent/settings.json', changes: [] } }) } })
      return
    }
    await route.fulfill({ json: applied ? preview({ upToDate: true, settings: { path: '~/.pi/agent/settings.json', changes: [] } }) : preview() })
  })
  const group = await piGroup(page)
  await page.getByTestId('cc-import-review-pi').click()
  await expect(page.getByTestId('cc-import-summary-pi')).toContainText('Amazon Bedrock credentials, 1 MCP server, 12 skills and commands, 1 instruction source')
  const credentials = page.getByTestId('cc-import-credentials-pi')
  await expect(credentials).toContainText('AWS_REGION = us-west-2')
  await expect(credentials).toContainText('AWS_SECRET_ACCESS_KEY (secret, read in place)')
  await expect(page.getByTestId('cc-import-changes-pi')).toContainText('defaultModel some-old-model → global.anthropic.claude-opus-5-5')
  await expect(page.getByTestId('cc-import-changes-pi')).toContainText('defaultProvider not set → amazon-bedrock')
  await expect(page.getByTestId('cc-import-mcp-pi')).toContainText('notes')
  await expect(page.getByTestId('cc-import-mcp-skipped-pi')).toContainText('SSE transport')
  await expect(page.getByTestId('cc-import-cannot-pi')).toContainText('Hooks: pi does not run Claude Code hook commands. Nearest: A pi extension.')

  await page.getByTestId('cc-import-apply-pi').click()
  const applyRow = page.getByTestId('cc-import-apply-row-pi')
  await expect(applyRow).toContainText('Imported')
  await expect(applyRow).toContainText('Wrote ~/.pi/agent/extensions/walnut-claude-code.ts, ~/.pi/agent/settings.json')
  await expect(page.getByTestId('cc-import-apply-pi')).toHaveCount(0)
  expect(posts).toHaveLength(1)
  expect(posts[0]).toContain('host=__local__')

  await page.getByTestId('cc-import-review-pi').click()
  await expect(applyRow).toContainText('Up to date')
  await expect(page.getByTestId('cc-import-apply-pi')).toHaveCount(0)
  await expect(group).toBeVisible()
})

test('an error shows the server sentence, and Check again recovers', async ({ page }) => {
  let calls = 0
  await page.route(IMPORT_PATH, async (route: Route) => {
    calls += 1
    if (calls === 1) {
      await route.fulfill({ status: 504, json: { error: 'The daemon on this host did not answer in time.', code: 'host_unreachable' } })
      return
    }
    await route.fulfill({ json: preview() })
  })
  await piGroup(page)
  await page.getByTestId('cc-import-review-pi').click()
  await expect(page.getByTestId('cc-import-error-pi')).toContainText('The daemon on this host did not answer in time.')
  await page.getByTestId('cc-import-review-pi').click()
  await expect(page.getByTestId('cc-import-error-pi')).toHaveCount(0)
  await expect(page.getByTestId('cc-import-apply-pi')).toBeEnabled()
})

test('a host with no Claude Code says so and offers no Import; an old pi warns about MCP', async ({ page }) => {
  let found = false
  await page.route(IMPORT_PATH, async (route: Route) => {
    await route.fulfill({ json: found
      ? preview({ pi: { installed: true, version: '0.85.1', needsUpdateForMcp: true } })
      : preview({ claudeCode: { found: false, settingsPath: '~/.claude/settings.json' } }) })
  })
  await piGroup(page)
  await page.getByTestId('cc-import-review-pi').click()
  await expect(page.getByTestId('cc-import-none-pi')).toContainText('nothing to import')
  await expect(page.getByTestId('cc-import-apply-pi')).toHaveCount(0)
  found = true
  await page.getByTestId('cc-import-review-pi').click()
  await expect(page.getByTestId('cc-import-update-pi')).toContainText('npm install -g @earendil-works/pi-coding-agent@latest')
  await expect(page.getByTestId('cc-import-apply-pi')).toBeEnabled()
})
